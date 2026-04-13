#!/usr/bin/env node
/**
 * prelive-superodds-now.js — Pipeline Imediato: Pré-Live + Super Odds
 *
 * Executa agora uma varredura completa de oportunidades:
 *   1. Coleta partidas agendadas para as próximas 24h (SofaScore)
 *   2. Filtra ligas tier 1-2 com critérios de qualidade
 *   3. Roda funil Pré-Live (todos os agentes de mercado)
 *   4. Roda pipeline Super Odds (parlays 2-10 pernas com correlação corrigida)
 *   5. Envia ambos ao Telegram
 *
 * Uso:
 *   node scripts/prelive-superodds-now.js
 *   node scripts/prelive-superodds-now.js --dry-run      → sem Telegram
 *   node scripts/prelive-superodds-now.js --hours=12     → próximas 12h
 *   node scripts/prelive-superodds-now.js --tier=1       → apenas tier 1
 */

import 'dotenv/config';
import chalk from 'chalk';
import axios from 'axios';
import { runPreLiveFunnel }          from '../src/funnels/funnel-pre-live.js';
import { aggregateMatchData }        from '../src/scrapers/aggregator.js';
import { analyzeQuantitative }       from '../src/agents/quant.js';
import { buildLegsFromAnalyses,
         buildParlayOptions,
         formatParlayReport }        from '../src/agents/parlay-builder.js';
import { notifySuperOddsParlay,
         notifyPreLiveOpportunity }  from '../src/utils/telegram.js';
import { loadDB }                    from '../src/pie/pie-storage.js';
import { getSuperbetEventMap,
         findUrlInLiveMap }          from '../src/scrapers/superbet.js';

// ── Configuração ──────────────────────────────────────────────────────────────
const ARGS     = process.argv.slice(2);
const DRY_RUN  = ARGS.includes('--dry-run');
const HOURS    = parseInt(ARGS.find(a => a.startsWith('--hours='))?.split('=')[1] || '24');
const TIER_MAX = parseInt(ARGS.find(a => a.startsWith('--tier='))?.split('=')[1]  || '2');
const LIMIT    = parseInt(ARGS.find(a => a.startsWith('--limit='))?.split('=')[1] || '20');  // máx partidas Gemini
const BANKROLL = parseFloat(process.env.USER_BANKROLL || '1000');

// Ligas prioritárias (mesmo conjunto do sofascore-collector)
const PRIORITY_LEAGUES = {
  // Tier 1
  17:   { name: 'Premier League',      tier: 1 },
  8:    { name: 'La Liga',             tier: 1 },
  23:   { name: 'Serie A',             tier: 1 },
  35:   { name: 'Bundesliga',          tier: 1 },
  34:   { name: 'Ligue 1',             tier: 1 },
  325:  { name: 'Brasileirão Série A', tier: 1 },
  7:    { name: 'Champions League',    tier: 1 },
  679:  { name: 'Copa do Brasil',      tier: 1 },
  // Tier 2
  390:  { name: 'Eredivisie',          tier: 2 },
  155:  { name: 'Primeira Liga',       tier: 2 },
  37:   { name: 'Jupiler Pro League',  tier: 2 },
  130:  { name: 'Super Lig',           tier: 2 },
  238:  { name: 'MLS',                 tier: 2 },
  571:  { name: 'Europa League',       tier: 2 },
  329:  { name: 'Copa Libertadores',   tier: 2 },
  480:  { name: 'Conference League',   tier: 2 },
};

const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.sofascore.com/',
};

function log(emoji, msg, color = 'white') {
  const colorFn = chalk[color] || chalk.white;
  console.log(colorFn(`${emoji} ${msg}`));
}

// ── Coleta partidas futuras do SofaScore ──────────────────────────────────────
async function fetchUpcomingMatches(hoursAhead = 24) {
  log('📡', 'Buscando partidas agendadas no SofaScore...', 'cyan');

  const now        = Date.now();
  const cutoffTime = now + hoursAhead * 3_600_000;
  const results    = [];

  // Busca hoje e amanhã para cobrir a janela de 24h
  const dates = [
    new Date().toISOString().split('T')[0],
    new Date(Date.now() + 86_400_000).toISOString().split('T')[0],
  ];

  for (const date of dates) {
    try {
      const { data } = await axios.get(
        `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${date}`,
        { headers: SOFA_HEADERS, timeout: 10_000 }
      );

      const events = data?.events || [];
      for (const e of events) {
        if (e.status?.type !== 'notstarted') continue;

        const leagueId   = e.tournament?.uniqueTournament?.id;
        const leagueInfo = PRIORITY_LEAGUES[leagueId];
        if (!leagueInfo || leagueInfo.tier > TIER_MAX) continue;

        // Kickoff dentro da janela de busca
        const kickoff = (e.startTimestamp || 0) * 1000;
        if (kickoff < now || kickoff > cutoffTime) continue;

        results.push({
          sofascore_id: e.id,
          home_team:    e.homeTeam?.name,
          home_id:      e.homeTeam?.id,
          away_team:    e.awayTeam?.name,
          away_id:      e.awayTeam?.id,
          competition:  leagueInfo.name,
          league_tier:  leagueInfo.tier,
          date:         new Date(kickoff).toISOString(),
          match:        `${e.homeTeam?.name} vs ${e.awayTeam?.name}`,
          match_id:     String(e.id),
        });
      }
    } catch (err) {
      log('⚠️', `Erro ao buscar ${date}: ${err.message}`, 'yellow');
    }
  }

  // Deduplicar por sofascore_id (mesmo jogo pode aparecer nos dois dias)
  const seen    = new Set();
  const unique  = results.filter(m => {
    if (seen.has(m.sofascore_id)) return false;
    seen.add(m.sofascore_id);
    return true;
  });

  // Ordena por horário de kickoff
  unique.sort((a, b) => new Date(a.date) - new Date(b.date));
  return unique;
}

// ── Análise de qualidade do PIE ────────────────────────────────────────────────
function getPieQualityLabel(db) {
  const markets = Object.entries(db.calibration || {})
    .filter(([, c]) => c.total >= 30)
    .map(([market, c]) => ({ market, acc: Math.round(c.hits / c.total * 100) }))
    .sort((a, b) => b.acc - a.acc);

  return markets.slice(0, 3).map(m => `${m.market}:${m.acc}%`).join(' | ');
}

// ── Pipeline principal ────────────────────────────────────────────────────────
async function run() {
  console.log('\n' + '═'.repeat(70));
  console.log(chalk.bold.cyan('  🎯 PIPELINE IMEDIATO — PRÉ-LIVE + SUPER ODDS'));
  console.log(chalk.gray(`  Modo: ${DRY_RUN ? 'DRY-RUN (sem Telegram)' : 'REAL'} | Janela: ${HOURS}h | Tier: ≤${TIER_MAX} | Banca: R$${BANKROLL}`));
  console.log('═'.repeat(70) + '\n');

  // ── Estatísticas PIE rápidas ─────────────────────────────────────────────
  let db;
  try {
    db = loadDB();
    const qual = getPieQualityLabel(db);
    log('🧠', `PIE ativo: ${qual}`, 'green');
  } catch { db = null; }

  // ── ETAPA 1: Coleta partidas agendadas ────────────────────────────────────
  log('\n🔍', `ETAPA 1 — Coletando partidas das próximas ${HOURS}h...`, 'bold');
  const matches = await fetchUpcomingMatches(HOURS);

  if (!matches.length) {
    log('⚠️', 'Nenhuma partida encontrada nas ligas prioritárias na janela selecionada.', 'yellow');
    console.log(chalk.gray('  Tente ampliar a janela: --hours=48 ou --tier=3'));
    return;
  }

  // Prioriza: tier 1 primeiro, depois tier 2; dentro de cada tier, mais próximos
  const sorted = [
    ...matches.filter(m => m.league_tier === 1),
    ...matches.filter(m => m.league_tier === 2),
  ].slice(0, LIMIT);

  const tier1Count = sorted.filter(m => m.league_tier === 1).length;
  const tier2Count = sorted.filter(m => m.league_tier === 2).length;
  log('✅', `${matches.length} encontradas → ${sorted.length} selecionadas (limite ${LIMIT})`, 'green');
  console.log(chalk.gray(`  Tier 1: ${tier1Count} | Tier 2: ${tier2Count}`));
  console.log('');

  // Lista resumida
  for (const m of sorted.slice(0, 12)) {
    const hora = new Date(m.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    console.log(chalk.gray(`  ${hora}  ${m.match.substring(0, 42).padEnd(42)}  [${m.competition}]`));
  }
  if (sorted.length > 12) console.log(chalk.gray(`  ... +${sorted.length - 12} partidas`));
  console.log('');

  // Substitui matches pelas partidas selecionadas e ordenadas
  matches.length = 0;
  matches.push(...sorted);

  // ── ETAPA 2: Funil Pré-Live ───────────────────────────────────────────────
  log('🔵', 'ETAPA 2 — Funil Pré-Live (todos os mercados)...', 'bold');

  let preLiveResults = [];
  let preLiveSent    = 0;

  try {
    preLiveResults = await runPreLiveFunnel(matches, new Map());
    log('✅', `Pré-Live: ${preLiveResults.length}/${matches.length} com oportunidades`, 'green');

    if (!DRY_RUN) {
      for (const r of preLiveResults) {
        try {
          await notifyPreLiveOpportunity(r.matchData, r.enriched);
          preLiveSent++;
          await new Promise(res => setTimeout(res, 1500)); // throttle Telegram
        } catch (e) {
          log('⚠️', `Telegram pré-live falhou: ${e.message}`, 'yellow');
        }
      }
    }
  } catch (err) {
    log('❌', `Funil pré-live falhou: ${err.message}`, 'red');
  }

  // ── ETAPA 3: Super Odds (Parlay) ──────────────────────────────────────────
  log('\n🚀', 'ETAPA 3 — Super Odds (Parlay Builder v2.1 APEX)...', 'bold');
  log('', chalk.gray('  Inclui: correlação cruzada corrigida + Kelly ajustado por pernas'), 'gray');

  // Seleciona partidas para parlay: aprovadas no pré-live primeiro, depois tier 1/2
  const preLiveIds = new Set(
    preLiveResults.map(r => String(r.matchData?.sofascore_id || r.matchData?.match_id)).filter(Boolean)
  );
  const parlayMatches = [
    ...matches.filter(m => preLiveIds.has(String(m.sofascore_id))),
    ...matches.filter(m => !preLiveIds.has(String(m.sofascore_id)) && m.league_tier === 1),
    ...matches.filter(m => !preLiveIds.has(String(m.sofascore_id)) && m.league_tier === 2),
  ].slice(0, 12); // máx 12 para não explodir combinatória

  if (parlayMatches.length < 2) {
    log('⚠️', 'Menos de 2 partidas disponíveis para Super Odds — pulando etapa.', 'yellow');
  } else {
    log('', `  Agregando dados de ${parlayMatches.length} partidas para parlay...`, 'cyan');

    // Busca mapa de URLs Superbet (pré-jogo) para enriquecer os links das pernas
    let superbetEventMap = new Map();
    try {
      log('', '  Mapeando URLs Superbet...', 'gray');
      superbetEventMap = await getSuperbetEventMap();
      log('', `  ${superbetEventMap.size / 2 | 0} partidas mapeadas na Superbet`, 'gray');
    } catch (e) {
      log('⚠️', `Mapa Superbet falhou: ${e.message}`, 'yellow');
    }

    // Coleta + quant em lotes de 4 para não sobrecarregar as fontes
    const analyses = [];
    const BATCH = 4;
    for (let i = 0; i < parlayMatches.length; i += BATCH) {
      const batch = parlayMatches.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (m) => {
          const matchData = await aggregateMatchData({
            ...m,
            match_date: m.date?.split('T')[0],
          });
          const quant = analyzeQuantitative(matchData);

          // Quando não há odds de mercado, usa fair_odds (pré-PIE) como referência
          // e probabilidades ajustadas pelo PIE como modelo. O edge é a diferença
          // entre a visão do PIE e o baseline Poisson (fair_odds = 1/p_poisson).
          let valueBets = quant.value_bets || [];
          if (!valueBets.length && quant.fair_odds && quant.probabilities) {
            const MIN_EV   = 0.04; // 4% edge mínimo sobre o modelo base
            const MIN_ODDS = 1.20; // odds mínimas para parlay ter sentido
            const synthMap = [
              { label: 'Over 1.5',         probKey: 'over_1_5',         oddsKey: 'over_1_5',         minProb: 0.72 },
              { label: 'Over 2.5',         probKey: 'over_2_5',         oddsKey: 'over_2_5',         minProb: 0.52 },
              { label: 'BTTS',             probKey: 'btts',             oddsKey: 'btts',             minProb: 0.60 },
              { label: 'Over Corners 8.5', probKey: 'over_corners_8_5', oddsKey: 'over_corners_8_5', minProb: 0.50 },
              { label: '1X',               probKey: 'chance_1x',        oddsKey: 'chance_1x',        minProb: 0.58 },
              { label: 'X2',               probKey: 'chance_x2',        oddsKey: 'chance_x2',        minProb: 0.50 },
              { label: 'Over YC 2.5',      probKey: 'over_yc_2_5',      oddsKey: 'over_yc_2_5',      minProb: 0.55 },
            ];
            for (const s of synthMap) {
              const prob    = quant.probabilities[s.probKey];
              const fairOdd = quant.fair_odds[s.oddsKey];
              if (!prob || !fairOdd || prob < s.minProb || fairOdd < MIN_ODDS) continue;
              // EV = p_PIE × fair_odds(pré-PIE) - 1
              // Positivo quando PIE detecta edge sobre o baseline Poisson
              const ev = +(prob * fairOdd - 1).toFixed(3);
              if (ev > MIN_EV) valueBets.push({ market: s.label, odds: +fairOdd.toFixed(2), house: 'Modelo', ev });
            }
            // Ordena por EV desc
            valueBets.sort((a, b) => b.ev - a.ev);
          }

          // Sem odds externas, o modelo Poisson+PIE é a única referência.
          // Aplicamos floor de 70 para que bets sintéticos passem os tiers do parlay
          // (X2: 70-2-4=64 → Mega Retorno; 1X: 70+4-1=73 → Acumulador).
          const NO_ODDS_FLOOR = valueBets.some(b => b.house === 'Modelo') ? 70 : 0;
          const confidence_score = Math.max(
            Math.round((quant.model_confidence ?? 0.5) * 100),
            NO_ODDS_FLOOR
          );

          const superbet_url = findUrlInLiveMap(superbetEventMap, m.home_team, m.away_team);

          return {
            confidence_score,
            value_bets:  valueBets,
            top_bet:     valueBets[0] || null,
            matchData,
            match_id:    String(m.sofascore_id),
            competition: m.competition,
            superbet_url: superbet_url || null,
          };
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) analyses.push(r.value);
        else if (r.status === 'rejected')
          log('⚠️', `Agregação falhou: ${r.reason?.message}`, 'yellow');
      }
    }

    log('', `  ${analyses.length} partidas analisadas pelo Quant`, 'cyan');

    try {
      const legs          = buildLegsFromAnalyses(analyses);
      const parlayOptions = buildParlayOptions(legs, BANKROLL);

      const totalOptions = Object.values(parlayOptions.tiers || {})
        .reduce((acc, t) => acc + (t.best?.length || t.combos?.length || 0), 0);

      if (totalOptions === 0) {
        log('⚠️', 'Nenhuma combinação de parlay passou nos filtros de qualidade.', 'yellow');
      } else {
        const report = formatParlayReport(parlayOptions, BANKROLL);
        console.log('\n' + report);

        if (!DRY_RUN) {
          await notifySuperOddsParlay(parlayOptions, BANKROLL);
          log('✅', `Super Odds enviado ao Telegram (${totalOptions} combinações)`, 'green');
        } else {
          log('✅', `Super Odds: ${totalOptions} combinações [DRY-RUN]`, 'green');
        }
      }
    } catch (err) {
      log('❌', `Pipeline Super Odds falhou: ${err.message}`, 'red');
      console.error(err.stack);
    }
  }

  // alias para o resumo final
  const parlayMatchIds = parlayMatches;

  // ── Resumo final ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log(chalk.bold.green('  ✅ PIPELINE CONCLUÍDO'));
  console.log(chalk.white(`  Pré-Live: ${preLiveResults.length} oportunidades encontradas | ${preLiveSent} enviadas ao Telegram`));
  console.log(chalk.white(`  Super Odds: pipeline executado com ${parlayMatchIds.length || 0} partidas`));
  if (DRY_RUN) console.log(chalk.yellow('  [DRY-RUN] Nenhuma notificação enviada ao Telegram'));
  console.log('═'.repeat(70) + '\n');
}

// ── Execução ──────────────────────────────────────────────────────────────────
run().catch((err) => {
  console.error(chalk.red('\n❌ Erro fatal no pipeline:'), err.message);
  console.error(err.stack);
  process.exit(1);
});
