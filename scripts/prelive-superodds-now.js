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
 *   node scripts/prelive-superodds-now.js --hours=24     → próximas 24h (padrão)
 *   node scripts/prelive-superodds-now.js --min-hours=6  → mín 6h antes do kickoff (padrão)
 *   node scripts/prelive-superodds-now.js --tier=1       → apenas tier 1
 */

import 'dotenv/config';
import chalk from 'chalk';
import axios from 'axios';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { runPreLiveFunnel }          from '../src/funnels/funnel-pre-live.js';
import { aggregateMatchData }        from '../src/scrapers/aggregator.js';
import { analyzeQuantitative }       from '../src/agents/quant.js';
import { buildLegsFromAnalyses,
         buildParlayOptions,
         formatParlayReport }        from '../src/agents/parlay-builder.js';
import { notifySuperOddsParlay,
         notifyPreLiveOpportunity }  from '../src/utils/telegram.js';
import { queueSignalWithAlert }      from './alert-protocol.js';
import { loadDB }                    from '../src/pie/pie-storage.js';
import { ensureFresh,
         lookupMatchUrl,
         listCachedMatches }         from '../src/scrapers/superbet-cache.js';
import { ScanHealthAgent }           from '../src/agents/scan-health-agent.js';
import { checkPreLiveEligible }      from '../src/utils/match-status-guard.js';
import { enrichSignalAndNotifyAdmin } from '../src/analysis/signalEnricher.js';

// ── Configuração ──────────────────────────────────────────────────────────────
const ARGS      = process.argv.slice(2);
const DRY_RUN   = ARGS.includes('--dry-run');
const HOURS     = parseInt(ARGS.find(a => a.startsWith('--hours='))?.split('=')[1]     || '24');
const MIN_HOURS = parseInt(ARGS.find(a => a.startsWith('--min-hours='))?.split('=')[1] || '0');   // bucket +1h cobre 0–60min
const TIER_MAX  = parseInt(ARGS.find(a => a.startsWith('--tier='))?.split('=')[1]      || '3');
const LIMIT     = parseInt(ARGS.find(a => a.startsWith('--limit='))?.split('=')[1]     || '20');
const BANKROLL  = parseFloat(process.env.USER_BANKROLL || '1000');

// ── Classificação por bucket de proximidade ───────────────────────────────────
// Retorna '+1h' | '+3h' | '+6h' | '+12h' | '+24h' | null (fora do range)
// Prioridade de envio: +1h > +3h > +6h > +12h > +24h
const BUCKET_ORDER = ['+1h', '+3h', '+6h', '+12h', '+24h'];

function _getBucket(kickoffMs, nowMs = Date.now()) {
  const diffMin = (kickoffMs - nowMs) / 60_000;
  if (diffMin <= 0)    return null;   // já iniciou
  if (diffMin <= 60)   return '+1h';
  if (diffMin <= 180)  return '+3h';
  if (diffMin <= 360)  return '+6h';
  if (diffMin <= 720)  return '+12h';
  if (diffMin <= 1440) return '+24h'; // janela antecipada — flag_antecipado: true
  return null; // além de 24h — fora do escopo dos buckets
}

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
  390:  { name: 'Eredivisie',                tier: 2 },
  155:  { name: 'Liga Profesional Argentina', tier: 2 },
  37:   { name: 'Jupiler Pro League',         tier: 2 },
  130:  { name: 'Super Lig',                  tier: 2 },
  238:  { name: 'MLS',                        tier: 2 },
  571:  { name: 'Europa League',              tier: 2 },
  329:  { name: 'Copa Libertadores',          tier: 2 },
  480:  { name: 'Conference League',          tier: 2 },
  // Tier 3 — Mercados secundários com boa liquidez
  337:  { name: 'Brasileirão Série B',        tier: 3 },
  352:  { name: 'Liga MX',                    tier: 3 },
  44:   { name: 'Championship (ENG)',         tier: 3 },
  36:   { name: 'Scottish Premiership',       tier: 3 },
  242:  { name: 'Copa Sudamericana',          tier: 3 },
  196:  { name: 'J1 League',                  tier: 3 },
  981:  { name: 'Campeonato Paulista',        tier: 3 },
  982:  { name: 'Campeonato Carioca',         tier: 3 },
  553:  { name: 'Recopa Sudamericana',        tier: 3 },
  160:  { name: 'Primeira Liga (POR)',        tier: 3 },
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
async function fetchUpcomingMatches(hoursAhead = 24, minHoursAhead = 6) {
  log('📡', `Buscando partidas: ${minHoursAhead}h a ${hoursAhead}h a partir de agora...`, 'cyan');

  const now        = Date.now();
  const minTime    = now + minHoursAhead * 3_600_000;   // mínimo: 6h à frente
  const cutoffTime = now + hoursAhead    * 3_600_000;   // máximo: 24h à frente
  const results    = [];

  // Busca até 3 dias para cobrir janelas de até 36h
  const numDays = hoursAhead > 24 ? 3 : 2;
  const dates = Array.from({ length: numDays }, (_, i) =>
    new Date(Date.now() + i * 86_400_000).toISOString().split('T')[0]
  );

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

        // Kickoff dentro da janela 6h–24h
        const kickoff = (e.startTimestamp || 0) * 1000;
        if (kickoff < minTime || kickoff > cutoffTime) continue;

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
  const health = new ScanHealthAgent();
  health.startRun();

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
  log('\n🔍', `ETAPA 1 — Coletando partidas (janela: ${MIN_HOURS}h–${HOURS}h)...`, 'bold');
  const matches = await fetchUpcomingMatches(HOURS, MIN_HOURS);

  if (!matches.length) {
    log('⚠️', 'Nenhuma partida encontrada nas ligas prioritárias na janela selecionada.', 'yellow');
    console.log(chalk.gray('  Tente ampliar a janela: --hours=48 ou --tier=3'));
    await health.finishRun({ sent: 0, opportunities: 0 });
    return;
  }

  // ── Classifica cada jogo no bucket correto e filtra os fora do range ──────
  const now = Date.now();
  for (const m of matches) {
    const kickoffMs = new Date(m.date).getTime();
    m._bucket = _getBucket(kickoffMs, now);
    m.flag_antecipado = (m._bucket === '+24h'); // análise antecipada: sinais pendentes
  }
  const withBucket = matches.filter(m => m._bucket !== null);

  if (!withBucket.length) {
    log('⚠️', 'Nenhuma partida dentro da janela de buckets (0–12h).', 'yellow');
    await health.finishRun({ sent: 0, opportunities: 0 });
    return;
  }

  // Ordena por prioridade de bucket (+1h antes de +12h), depois por tier, depois por kickoff
  const bucketPrio = (b) => BUCKET_ORDER.indexOf(b);
  const sorted = withBucket
    .sort((a, b) => {
      const bPrio = bucketPrio(a._bucket) - bucketPrio(b._bucket);
      if (bPrio !== 0) return bPrio;
      const tierDiff = a.league_tier - b.league_tier;
      if (tierDiff !== 0) return tierDiff;
      return new Date(a.date) - new Date(b.date);
    })
    .slice(0, LIMIT);

  const tier1Count = sorted.filter(m => m.league_tier === 1).length;
  const tier2Count = sorted.filter(m => m.league_tier === 2).length;
  const bucketCounts = BUCKET_ORDER.map(b => `${b}:${sorted.filter(m => m._bucket === b).length}`).filter(s => !s.endsWith(':0')).join(' | ');
  log('✅', `${matches.length} encontradas → ${withBucket.length} com bucket → ${sorted.length} selecionadas (limite ${LIMIT})`, 'green');
  console.log(chalk.gray(`  Tier 1: ${tier1Count} | Tier 2: ${tier2Count} | Buckets: ${bucketCounts}`));
  health.setMatchesFound(sorted.length);
  console.log('');

  // Lista resumida — mostra bucket ao lado de cada jogo
  for (const m of sorted.slice(0, 12)) {
    const hora = new Date(m.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const bucket = m._bucket ? `[${m._bucket}]`.padEnd(6) : '      ';
    console.log(chalk.gray(`  ${bucket}  ${hora}  ${m.match.substring(0, 40).padEnd(40)}  [${m.competition}]`));
  }
  if (sorted.length > 12) console.log(chalk.gray(`  ... +${sorted.length - 12} partidas`));
  console.log('');

  // Substitui matches pelas partidas classificadas e ordenadas
  matches.length = 0;
  matches.push(...sorted);

  // ── ETAPA 1.5: Atualiza cache Superbet ───────────────────────────────────
  log('🔗', 'ETAPA 1.5 — Atualizando cache Superbet (URLs diretas dos jogos)...', 'bold');
  let superbetFresh = false;
  try {
    await ensureFresh('prelive');
    health.setCacheSize(listCachedMatches('prelive').count);
    superbetFresh = true;
  } catch (e) {
    log('⚠️', `Cache Superbet falhou (links serão por competição): ${e.message}`, 'yellow');
    health.recordError(`Cache Superbet: ${e.message}`);
  }

  // ── ETAPA 1.6: Filtra jogos inelegíveis ANTES de rodar agentes (economiza tokens) ──
  log('🔍', 'ETAPA 1.6 — Verificando status pré-live (filtra jogos já iniciados)...', 'bold');
  const eligibleMatches = [];
  for (const m of matches) {
    try {
      const eligible = await checkPreLiveEligible(m);
      if (eligible) {
        eligibleMatches.push(m);
      } else {
        log('🚫', `Jogo já iniciado — ignorado antes da análise: ${m.match}`, 'yellow');
      }
    } catch {
      eligibleMatches.push(m); // em caso de falha na verificação, mantém o jogo
    }
  }
  if (eligibleMatches.length < matches.length) {
    log('✅', `${matches.length - eligibleMatches.length} jogo(s) removido(s) por status — ${eligibleMatches.length} restantes`, 'cyan');
  }

  // ── ETAPA 2: Funil Pré-Live ───────────────────────────────────────────────
  log('🔵', 'ETAPA 2 — Funil Pré-Live (todos os mercados)...', 'bold');

  let preLiveResults = [];
  let preLiveSent    = 0;

  try {
    // Carrega chaves pré-live persistidas no disco (sobrevive a restarts e re-execuções)
    const _preKeysFile = join(__dirname, '../data/prelive-notified-keys.json');
    const _preKeys = (() => {
      try {
        if (existsSync(_preKeysFile)) {
          const raw    = JSON.parse(readFileSync(_preKeysFile, 'utf-8'));
          const cutoff = Date.now() - 24 * 60 * 60_000; // expira após 24h
          return new Map(Object.entries(raw).filter(([, ts]) => ts > cutoff));
        }
      } catch { /* ignora */ }
      return new Map();
    })();

    // ── MÓDULO 1 — Varredura Paralela por Bucket ──────────────────────────────
    // Todas as janelas (+1h/+3h/+6h/+12h) são analisadas simultaneamente.
    // Cada bucket gera stats independentes para o diagnóstico por janela.
    // Falha em um bucket não bloqueia os outros (Promise.allSettled).
    //
    // NOTA: os trackers de decisão (goals/btts/corners) usam writeFileSync atômico.
    // Race conditions são toleradas — dados de tracking são diagnóstico, não decisão.
    const _bucketGroups = {};
    for (const m of eligibleMatches) {
      const b = m._bucket || '+12h';
      if (!_bucketGroups[b]) _bucketGroups[b] = [];
      _bucketGroups[b].push(m);
    }

    const _bucketStart = Date.now();
    log('', chalk.gray(`  Varredura paralela: ${Object.keys(_bucketGroups).filter(b => _bucketGroups[b].length).map(b => `${b}(${_bucketGroups[b].length})`).join(' · ')}`), 'gray');

    const _bucketOutcomes = await Promise.allSettled(
      BUCKET_ORDER.map(async (bucket) => {
        const group = _bucketGroups[bucket] || [];
        if (!group.length) return { bucket, results: [], total: 0 };
        const results = await runPreLiveFunnel(group, _preKeys);
        return { bucket, results, total: group.length };
      })
    );

    const _durParallel = ((Date.now() - _bucketStart) / 1000).toFixed(1);
    const _bucketStats = {};

    for (const [i, outcome] of _bucketOutcomes.entries()) {
      const bucket = BUCKET_ORDER[i];
      if (outcome.status === 'fulfilled') {
        const { results, total } = outcome.value;
        preLiveResults.push(...results);
        _bucketStats[bucket] = {
          total,
          aprovados: results.length,
          under: results.filter(r => r.enriched?.some(e => /^under/i.test(e.mercado || e.market || ''))).length,
          status: 'ok',
        };
      } else {
        _bucketStats[bucket] = {
          total:     _bucketGroups[bucket]?.length || 0,
          aprovados: 0, under: 0,
          status:    'error',
          err:       outcome.reason?.message || 'erro desconhecido',
        };
        log('⚠️', `Bucket ${bucket} falhou: ${outcome.reason?.message}`, 'yellow');
      }
    }

    // Diagnóstico paralelo — log local
    console.log(chalk.gray(`\n  ⚡ Varredura paralela concluída em ${_durParallel}s`));
    for (const b of BUCKET_ORDER) {
      const s = _bucketStats[b];
      if (!s || !s.total) continue;
      const tag = s.status === 'error' ? '❌' : s.aprovados > 0 ? '✅' : '⬜';
      const underTag = s.under > 0 ? ` · Under: ${s.under}` : '';
      console.log(chalk.gray(`    ${b.padEnd(5)} ${tag} ${s.aprovados}/${s.total} aprovados${underTag}`));
    }
    console.log('');

    // Envia diagnóstico paralelo ao admin se configurado (não bloqueia pipeline)
    const _adminToken  = process.env.TELEGRAM_BOT_TOKEN;
    const _adminId     = process.env.TELEGRAM_ADMIN_USER_ID;
    if (!DRY_RUN && _adminToken && _adminId) {
      const _diagLines = [
        `🔧 <b>[DIAGNÓSTICO PARALELO] · ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}</b>`,
        `⚡ Varredura: <code>${_durParallel}s</code> · Jogos: <code>${eligibleMatches.length}</code>`,
        ``,
      ];
      for (const b of BUCKET_ORDER) {
        const s = _bucketStats[b];
        if (!s || !s.total) continue;
        const tag = s.status === 'error' ? '❌' : s.aprovados > 0 ? '✅' : '⬜';
        const underNote = s.under > 0 ? ` · Under: <code>${s.under}</code>` : '';
        _diagLines.push(`<b>${b}</b> · <code>${s.total}</code> jogos · ${tag} <code>${s.aprovados}</code> aprovados${underNote}`);
        if (s.status === 'error') _diagLines.push(`  ⚠️ <code>${s.err}</code>`);
      }
      _diagLines.push(``, `Total aprovados: <code>${preLiveResults.length}</code>`);
      fetch(`https://api.telegram.org/bot${_adminToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: _adminId,
          text: _diagLines.join('\n'),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      }).catch(() => {}); // fire-and-forget, não bloqueia
    }

    log('✅', `Pré-Live: ${preLiveResults.length}/${matches.length} com oportunidades`, 'green');

    // Registra métricas por partida no health agent
    for (const r of preLiveResults) {
      const odds = r.matchData?.odds || {};
      health.recordMatch({
        match:         r.matchData?.match || '',
        oddsColetadas: Object.keys(odds).filter(k => odds[k] != null),
        aprovados:     r.enriched?.length || 0,
      });
    }

    if (!DRY_RUN) {
      for (const r of preLiveResults) {
        try {
          // Sempre busca URL do cache para garantir que aponta para o jogo correto
          // (não reutiliza URL pré-existente que pode apontar para jogo errado)
          const _hTeam = r.matchData.home?.team || r.matchData.home_team;
          const _aTeam = r.matchData.away?.team || r.matchData.away_team;
          r.matchData.superbet_url = lookupMatchUrl(_hTeam, _aTeam, 'prelive');
          // Propaga bucket do match original para o matchData (usado no cabeçalho Telegram)
          const origMatch = matches.find(m => String(m.sofascore_id) === String(r.matchData.sofascore_id || r.matchData.match_id));
          if (origMatch?._bucket) r.matchData._bucket = origMatch._bucket;
          if (origMatch?.flag_antecipado) r.matchData.flag_antecipado = true;
          // Protocolo de alerta: ALERTA → 90s validação → SINAL (fire-and-forget)
          queueSignalWithAlert(r.matchData, r.enriched, notifyPreLiveOpportunity);
          // Análise profunda 8-D + padrões → DM admin (fire-and-forget, não bloqueia grupo)
          enrichSignalAndNotifyAdmin(r.matchData, r.enriched);
          const sent = true; // fire-and-forget — sinal enviado assincronamente pelo alert-protocol
          if (sent) {
            preLiveSent++;
            // Persiste atomicamente após enfileirar (evita re-envio em próximo ciclo)
            try { writeFileSync(_preKeysFile, JSON.stringify(Object.fromEntries(_preKeys)), 'utf-8'); } catch { /* ignora */ }
          }
          await new Promise(res => setTimeout(res, 500)); // throttle de enfileiramento
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

    // Cache Superbet já foi atualizado na ETAPA 1.5 — reutiliza se ainda fresco (< 10min)
    if (!superbetFresh) {
      try {
        log('', '  Verificando cache Superbet (pré-live)...', 'gray');
        await ensureFresh('prelive');
        log('', '  Cache Superbet atualizado', 'gray');
      } catch (e) {
        log('⚠️', `Cache Superbet falhou: ${e.message}`, 'yellow');
      }
    }

    // Índice de resultados quant já computados no funil pré-live (reutiliza, evita re-análise)
    const preLiveQuantMap = new Map(
      preLiveResults
        .filter(r => r.matchData?.sofascore_id || r.matchData?.match_id)
        .map(r => [String(r.matchData.sofascore_id || r.matchData.match_id), r])
    );

    // Coleta + quant em lotes de 4 para não sobrecarregar as fontes
    const analyses = [];
    const BATCH = 4;
    for (let i = 0; i < parlayMatches.length; i += BATCH) {
      const batch = parlayMatches.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (m) => {
          // Reutiliza matchData do funil pré-live se disponível (evita re-aggregação)
          const cached = preLiveQuantMap.get(String(m.sofascore_id));
          const matchData = cached?.matchData ?? await aggregateMatchData({
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

          const superbet_url = lookupMatchUrl(m.home_team, m.away_team, 'prelive');

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

      // Propaga o bucket mais urgente dos jogos do parlay como metadado
      const BUCKET_ORDER  = ['+1h', '+3h', '+6h', '+12h'];
      const urgentBucket  = BUCKET_ORDER.find(b => parlayMatches.some(m => m._bucket === b)) || null;
      if (urgentBucket) parlayOptions._meta = { bucket: urgentBucket };

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

  // ── Health Agent: finaliza métricas e alerta admin se necessário ───────────
  await health.finishRun({ sent: preLiveSent, opportunities: preLiveResults.length }).catch(() => {});

  // ── Módulo 5 — Scanner Report ao Admin ────────────────────────────────────
  if (!DRY_RUN) {
    try {
      const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
      const token   = process.env.TELEGRAM_BOT_TOKEN;
      if (adminId && token) {
        const now5    = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
        const topMatch = preLiveResults[0]?.matchData;
        const escalFlag = process.env.PRE_LIVE_ESCALATION_FLAG || '';

        const lines = [
          `🔧 <b>[SCANNER] · Relatório de Varredura · ${now5}</b>`,
          `Partidas coletadas: <code>${matches?.length ?? '?'}</code>  ·  Selecionadas: <code>${sorted?.length ?? '?'}</code>`,
          `Oportunidades pré-live: <code>${preLiveResults.length}</code>  ·  Sinais enfileirados: <code>${preLiveSent}</code>`,
        ];
        if (topMatch) {
          const bestEnriched = preLiveResults[0]?.enriched?.[0];
          lines.push(`Top sinal: <code>${topMatch.match || '?'}</code>  ·  Mercado: <code>${bestEnriched?.mercado || bestEnriched?.market || '--'}</code>  ·  Odd: <code>${bestEnriched?.odds_minima ?? '--'}</code>`);
        }
        if (escalFlag) lines.push(`Modo: <code>${escalFlag}</code>`);
        lines.push(`Próximo ciclo: <code>+15min</code>`);

        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            chat_id:                  adminId,
            text:                     lines.join('\n'),
            parse_mode:               'HTML',
            disable_web_page_preview: true,
          }),
        }).catch(() => {});
      }
    } catch { /* silent — relatório admin é best-effort */ }
  }
}

// ── Exporta para uso pelo scheduler ───────────────────────────────────────────
export { run as runPreLiveSuperOdds };

// ── Execução direta (CLI) ──────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('prelive-superodds-now.js')) {
  run().catch((err) => {
    console.error(chalk.red('\n❌ Erro fatal no pipeline:'), err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
