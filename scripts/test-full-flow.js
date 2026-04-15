/**
 * test-full-flow.js — Teste completo do fluxo de automação
 *
 * Pipeline 100% SofaScore (sem dependência de API-Football):
 *   1. Limpa o grupo Telegram
 *   2. Pré-live: jogos agendados → SofaScore details + GoalsAgent → Telegram
 *   3. SUPERODDS 2T: jogos ao vivo em 2T → GoalsAgent + BTTSAgent → Telegram
 *   4. Super ODD: múltiplos jogos agendados → pernas → parlay → Telegram
 *
 * Uso:
 *   node scripts/test-full-flow.js
 */

import 'dotenv/config';
import chalk from 'chalk';
import axios from 'axios';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SENT_DB_PATH = join(__dirname, '../data/telegram-sent.json');

import {
  deleteGroupMessages,
  notifyPreLiveAnalysis,
  notifyLiveSecondHalf,
  notifySuperOddsParlay,
} from '../src/utils/telegram.js';

import { getSofascoreMatches, getSofascoreMatchDetails } from '../src/scrapers/sofascore.js';
import { getLiveMatches, collectLiveMatchData }         from '../src/scrapers/sofascore.js';

import { GoalsAgent }    from '../squads/betting-analysis/market-agents/GoalsAgent.js';
import { BTTSAgent }     from '../squads/betting-analysis/market-agents/BTTSAgent.js';
import { CornersAgent }  from '../squads/betting-analysis/market-agents/CornersAgent.js';

import { buildParlayOptions } from '../src/agents/parlay-builder.js';
import { calcRiscoDisplay, calcRetornoPotencial } from '../src/workflows/prelive-analysis.js';
import { loadDB } from '../src/pie/pie-storage.js';
import { getSuperbetMatchDirectUrl, getSuperbetEventMap, findUrlInEventMap, getSuperbetLiveEventMap, findUrlInLiveMap } from '../src/scrapers/superbet.js';

const BANKROLL = parseFloat(process.env.USER_BANKROLL || '1000');
const SEP = '═'.repeat(60);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const log = {
  step: (n, t) => console.log(chalk.bold.cyan(`\n${SEP}\n  ETAPA ${n}: ${t}\n${SEP}`)),
  ok:   (t)    => console.log(chalk.green(`  ✅ ${t}`)),
  info: (t)    => console.log(chalk.white(`  ℹ  ${t}`)),
  warn: (t)    => console.log(chalk.yellow(`  ⚠  ${t}`)),
  err:  (t)    => console.log(chalk.red(`  ✖  ${t}`)),
};

// ── Monta matchData compatível com BaseMarketAgent a partir do SofaScore ──────
function buildMatchData(scheduledMatch, details) {
  const home = details?.home || {};
  const away = details?.away || {};
  const h2h  = details?.h2h  || [];

  // Calcula %BTTS e %Over2.5 a partir do H2H disponível
  const h2hLast5 = h2h.slice(0, 5);
  let btts = null, over25 = null, cs_home = null, cs_away = null;
  if (h2hLast5.length >= 3) {
    const bttsCount  = h2hLast5.filter(m => (m.home_goals || 0) > 0 && (m.away_goals || 0) > 0).length;
    const over25Count = h2hLast5.filter(m => (m.home_goals || 0) + (m.away_goals || 0) > 2).length;
    btts  = Math.round((bttsCount  / h2hLast5.length) * 100);
    over25 = Math.round((over25Count / h2hLast5.length) * 100);
  }

  // Clean sheet % a partir dos jogos recentes (clean_sheets é count em 8 jogos)
  if (home.clean_sheets != null) cs_home = Math.round((home.clean_sheets / 8) * 100);
  if (away.clean_sheets != null) cs_away = Math.round((away.clean_sheets / 8) * 100);

  return {
    match:       `${scheduledMatch.home_team} vs ${scheduledMatch.away_team}`,
    match_id:     String(scheduledMatch.sofascore_id || ''),
    competition:  scheduledMatch.competition,
    match_time:   scheduledMatch.match_time,
    date:         scheduledMatch.match_date,
    home: {
      team:               scheduledMatch.home_team,
      form:               home.form,
      goals_scored_avg:   home.goals_scored_avg,
      goals_conceded_avg: home.goals_conceded_avg,
      xg_avg:             home.xg_avg,
      btts_pct:           btts,
      over_25_pct:        over25,
      clean_sheet_pct:    cs_home,
    },
    away: {
      team:               scheduledMatch.away_team,
      form:               away.form,
      goals_scored_avg:   away.goals_scored_avg,
      goals_conceded_avg: away.goals_conceded_avg,
      xg_avg:             away.xg_avg,
      btts_pct:           btts,
      over_25_pct:        over25,
      clean_sheet_pct:    cs_away,
    },
    h2h,
    odds: {},
  };
}

// ── Coleta detalhes do SofaScore e constrói matchData ─────────────────────────
async function fetchMatchDataFromSofa(scheduledMatch) {
  try {
    const details = await getSofascoreMatchDetails(
      scheduledMatch.sofascore_id,
      scheduledMatch.home_id,
      scheduledMatch.away_id
    );
    return buildMatchData(scheduledMatch, details);
  } catch (e) {
    // Retorna matchData mínimo sem detalhes
    return buildMatchData(scheduledMatch, null);
  }
}

// ── Roda agentes de mercado em um matchData e retorna a melhor oportunidade ───
async function runMarketAgents(matchData) {
  const agents = [
    { agent: new GoalsAgent(),   market: 'Total de Gols'  },
    { agent: new BTTSAgent(),    market: 'BTTS'           },
    { agent: new CornersAgent(), market: 'Escanteios'     },
  ];

  const results = [];
  for (const { agent, market } of agents) {
    try {
      const r = await agent.analyze(matchData);
      if (r && typeof r.probabilidade === 'number' && typeof r.confianca === 'number') {
        results.push({ ...r, market_label: market });
      }
    } catch { /* ignora falhas de agente individual */ }
    await sleep(800); // respeita rate limit Gemini
  }

  if (!results.length) return null;

  // Retorna o resultado com maior confidence
  return results.sort((a, b) => b.confianca - a.confianca)[0];
}

// ── Monta objeto `analysis` compatível com notifyPreLiveAnalysis ──────────────
function buildAnalysisForTelegram(matchData, agentResult) {
  const market = agentResult.mercado || agentResult.market_label || 'Over 2.5';
  const odds   = agentResult.odds_minima_recomendada || 1.80;
  const score  = Math.round((agentResult.probabilidade * 0.6) + (agentResult.confianca * 0.4));

  const recAction = score >= 80 ? 'BET' : score >= 70 ? 'CONSIDER' : 'SKIP';
  const recLabel  = recAction === 'BET' ? '🔥 APOSTAR' : '⚡ CONSIDERAR';

  return {
    match_id:   matchData.match,
    match_name: matchData.match,
    matchData:  { ...matchData },
    confidence_score: score,
    recommendation: { action: recAction, label: recLabel },
    top_bet: {
      market,
      odds,
      house: 'Superbet',
      ev_pct: agentResult.ev_pct || null,
    },
    risk: { stake_pct: 3 },
    quant: { probabilities: {} },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ETAPA 1: Limpar grupo Telegram
// ═════════════════════════════════════════════════════════════════════════════
async function stepClearTelegram() {
  log.step(1, 'LIMPANDO GRUPO TELEGRAM');

  // Apaga o histórico de dedup para garantir reenvio das mesmas análises
  try {
    writeFileSync(SENT_DB_PATH, '{}', 'utf8');
    log.ok('Histórico de dedup limpo (telegram-sent.json)');
  } catch (e) {
    log.warn(`Falha ao limpar dedup: ${e.message}`);
  }

  try {
    await deleteGroupMessages();
    log.ok('Grupo limpo com sucesso');
  } catch (e) {
    log.warn(`Falha ao limpar: ${e.message}`);
  }
  await sleep(2000);
}

// ═════════════════════════════════════════════════════════════════════════════
// ETAPA 2: Análise Pré-live (SofaScore + Market Agents)
// ═════════════════════════════════════════════════════════════════════════════
async function stepPreLive() {
  log.step(2, 'ANÁLISE PRÉ-LIVE (SofaScore + GoalsAgent/BTTSAgent)');

  const today    = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0];

  log.info(`Buscando partidas de hoje (${today}) e amanhã (${tomorrow})...`);

  const [todayMatches, tomorrowMatches] = await Promise.all([
    getSofascoreMatches(today).catch(() => []),
    getSofascoreMatches(tomorrow).catch(() => []),
  ]);

  const allMatches = [...todayMatches, ...tomorrowMatches];
  log.info(`${allMatches.length} partidas encontradas`);

  if (!allMatches.length) { log.warn('Sem partidas disponíveis'); return null; }

  // Prioriza ligas com mais dados (SofaScore cobre melhor top ligas)
  const TOP_LEAGUE_TERMS = [
    'premier', 'la liga', 'bundesliga', 'serie a', 'ligue 1',
    'champions', 'europa', 'brasileir', 'libertadores', 'eredivisie',
    'primeira liga', 'scottish', 'turkish', 'mls', 'major',
  ];

  const sorted = allMatches.sort((a, b) => {
    const aTop = TOP_LEAGUE_TERMS.some(t => (a.competition || '').toLowerCase().includes(t)) ? 0 : 1;
    const bTop = TOP_LEAGUE_TERMS.some(t => (b.competition || '').toLowerCase().includes(t)) ? 0 : 1;
    return aTop - bTop;
  });

  // Tenta até 12 jogos para encontrar 1 com oportunidade válida
  const candidates = sorted.slice(0, 12);
  log.info(`Analisando até ${candidates.length} jogos...`);

  let db;
  try { db = loadDB(); } catch { db = null; }

  for (const scheduledMatch of candidates) {
    log.info(`→ ${scheduledMatch.home_team} vs ${scheduledMatch.away_team} | ${scheduledMatch.competition}`);

    // Coleta detalhes do SofaScore
    const matchData = await fetchMatchDataFromSofa(scheduledMatch);
    await sleep(500);

    // Roda agentes de mercado
    const bestResult = await runMarketAgents(matchData);
    if (!bestResult) { log.info(`  Sem resultado dos agentes`); continue; }

    const score = Math.round((bestResult.probabilidade * 0.6) + (bestResult.confianca * 0.4));
    log.info(`  → ${bestResult.mercado || bestResult.market_label}  prob:${bestResult.probabilidade}%  conf:${bestResult.confianca}%  score:${score}`);

    // Gate de qualidade: score >= 70 e confiança >= 70
    if (score < 70 || bestResult.confianca < 70) {
      log.info(`  Fora dos critérios (score=${score}, conf=${bestResult.confianca})`);
      continue;
    }

    const analysis = buildAnalysisForTelegram(matchData, bestResult);
    const risco    = calcRiscoDisplay(bestResult.confianca, analysis.top_bet.odds, 'prelive');
    const stakeInfo = calcRetornoPotencial(analysis.top_bet.odds, BANKROLL, 3);

    const pieKey = bestResult.mercado;
    const pieCal = db?.calibration?.[pieKey];
    const pieAccuracy = pieCal?.total >= 10 ? Math.round((pieCal.hits / pieCal.total) * 100) : null;
    const matchDate = scheduledMatch.match_date;
    const horasAte  = matchDate ? Math.max(0, Math.round((new Date(matchDate) - Date.now()) / 3_600_000)) : null;

    log.ok(`OPORTUNIDADE ENCONTRADA: ${matchData.match}`);
    log.ok(`  Mercado: ${analysis.top_bet.market} @ ${analysis.top_bet.odds}`);
    log.ok(`  Score: ${score}/100 | Risco: ${risco.icon} ${risco.label}`);
    log.ok(`  Stake R$ ${stakeInfo.stake} → Ganho R$ ${stakeInfo.ganho}`);

    // Busca URL direta da partida no Superbet via Playwright
    log.info(`Buscando link direto no Superbet para ${matchData.match}...`);
    const directUrl = await getSuperbetMatchDirectUrl(
      scheduledMatch.home_team,
      scheduledMatch.away_team
    ).catch(() => null);

    if (directUrl) {
      log.ok(`  Link direto encontrado: ${directUrl}`);
    } else {
      log.warn(`  Link direto não encontrado — usando página da liga`);
    }

    await notifyPreLiveAnalysis(analysis, { stakeInfo, risco, pieAccuracy, horasAte, bankroll: BANKROLL, directUrl });
    log.ok('✓ Pré-live enviado ao Telegram');
    return { analysis, bestResult };
  }

  log.warn('Nenhuma oportunidade pré-live nos critérios após análise de todos os candidatos');
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// ETAPA 3: Análise SUPERODDS 2T (SofaScore Live + GoalsAgent + BTTSAgent)
// ═════════════════════════════════════════════════════════════════════════════
async function stepLive2T() {
  log.step(3, 'ANÁLISE AO VIVO — 2° TEMPO (SofaScore Live + GoalsAgent + BTTSAgent)');

  log.info('Buscando jogos em andamento...');
  const allLive = await getLiveMatches().catch(() => []);
  log.info(`${allLive.length} jogos ao vivo detectados`);

  // Prioriza: min 55-87 (intervalo ideal para SUPERODDS 2T — gate >= 55)
  const sorted = allLive
    .filter(m => (m.minute ?? 0) >= 55 && (m.minute ?? 0) <= 87)
    .sort((a, b) => {
      const aMid = Math.abs((a.minute ?? 65) - 65);
      const bMid = Math.abs((b.minute ?? 65) - 65);
      return aMid - bMid;
    });

  log.info(`${sorted.length} jogos em 2° tempo (min 55-87)`);

  const candidates = sorted.length ? sorted : allLive.filter(m => (m.minute ?? 0) >= 1).slice(0, 12);
  if (!candidates.length) { log.warn('Nenhum jogo ao vivo adequado'); return null; }

  // ── REGRA: carrega mapa AO VIVO da Superbet (apostas/ao-vivo) ───────────────
  // Nenhum jogo será analisado nem enviado sem link confirmado.
  // Fonte 1: página ao vivo (apostas/ao-vivo) — jogos atualmente em andamento
  // Fonte 2: página prematch (apostas/futebol) — fallback para jogos recém iniciados
  log.info('Carregando mapa ao vivo do Superbet (apostas/ao-vivo)...');
  const liveMap = await getSuperbetLiveEventMap().catch(() => new Map());
  log.info(`Superbet Live: ${Math.round(liveMap.size / 2)} partidas ao vivo indexadas`);

  log.info('Carregando mapa prematch como fallback...');
  const prematchMap = await getSuperbetEventMap().catch(() => new Map());
  log.info(`Superbet Prematch: ${Math.round(prematchMap.size / 2)} partidas indexadas`);

  const agent = new GoalsAgent();
  const notifiedKeys = new Map();
  const SUPERODDS_STAKE_PCT = { 'Baixo': 2.0, 'Médio': 1.5, 'Alto': 0.8 };

  for (const rawMatch of candidates.slice(0, 12)) {
    const label = `${rawMatch.home_team} vs ${rawMatch.away_team}`;
    const min   = rawMatch.minute ?? '?';
    const score = `${rawMatch.score_home ?? 0}-${rawMatch.score_away ?? 0}`;

    log.info(`→ [${min}'] ${label} | ${score} | ${rawMatch.competition || '?'}`);

    try {
      // ── PASSO 1: Verificar link ANTES de qualquer análise ─────────────────────
      // Prioridade 1: mapa ao vivo (apostas/ao-vivo) — URL específica do jogo live
      let directUrl = findUrlInLiveMap(liveMap, rawMatch.home_team, rawMatch.away_team) || null;

      // Prioridade 2: mapa prematch — jogo pode ter iniciado mas ainda estar indexado
      if (!directUrl) {
        directUrl = findUrlInEventMap(prematchMap, rawMatch.home_team, rawMatch.away_team) || null;
        if (directUrl) log.info('  Link encontrado no mapa prematch');
      }

      // ── BLOQUEIO ABSOLUTO: sem link → jogo ignorado, nunca enviado ────────────
      if (!directUrl) {
        log.warn(`  ⛔ BLOQUEADO — ${label} não está na grade do Superbet. Jogo ignorado.`);
        continue;
      }

      log.ok(`  ✓ Link confirmado: ${directUrl}`);

      // ── PASSO 2: Coleta dados e verifica stats ────────────────────────────────
      const liveData = await collectLiveMatchData(rawMatch).catch(() => null);
      if (!liveData) { log.info('  Sem dados de live'); continue; }

      const temStats = !!(liveData.live_stats?.chutes_alvo_casa != null || liveData.xg_home != null);
      if (!temStats) { log.info('  Stats insuficientes'); continue; }

      log.info(`  Stats: xG ${liveData.xg_home ?? 'n/a'}×${liveData.xg_away ?? 'n/a'} | chutes ${liveData.live_stats?.chutes_alvo_casa ?? 'n/a'}×${liveData.live_stats?.chutes_alvo_fora ?? 'n/a'}`);

      // ── PASSO 3: Análise do agente ────────────────────────────────────────────
      const opportunities = await agent.analyze(liveData).catch(() => []);
      log.info(`  Agente retornou ${opportunities.length} oportunidade(s)`);
      if (!opportunities.length) continue;

      const qualified = opportunities.filter(o => {
        const o_odds = o.odds_minima ?? 1.5;
        return o_odds >= 1.25 && o_odds <= 20.0;
      });
      if (!qualified.length) { log.info('  Sem oportunidades dentro do range de odds'); continue; }

      const dedupeKey = `${label}_${score}_${qualified.map(o => o.mercado).join('|')}`;
      if (notifiedKeys.has(dedupeKey)) { log.info('  Já notificado (dedup)'); continue; }
      notifiedKeys.set(dedupeKey, Date.now());

      const opportunitiesWithReturn = qualified.map(o => {
        const o_odds   = o.odds_minima ?? 1.5;
        const risco    = calcRiscoDisplay(o.confianca, o_odds, 'live');
        const stakePct = SUPERODDS_STAKE_PCT[risco.label] ?? 1.5;
        const stake    = Math.round(BANKROLL * (stakePct / 100) * 100) / 100;
        const ganho    = Math.round(stake * o_odds * 100) / 100;
        return {
          ...o,
          odds: o_odds,
          risco,
          stakeInfo: { stake, ganho, roi: Math.round((o_odds - 1) * 100), roiStr: `+${Math.round((o_odds - 1) * 100)}%`, stakePct },
        };
      });

      log.ok(`OPORTUNIDADE AO VIVO: ${label} [${min}'] ${score}`);
      for (const o of opportunitiesWithReturn) {
        log.ok(`  ${o.mercado} → ${o.recomendacao}  prob:${o.probabilidade}%  conf:${o.confianca}%  odds:${o.odds}`);
      }

      // ── PASSO 4: Envia — link já confirmado no PASSO 1 ───────────────────────
      await notifyLiveSecondHalf(liveData, opportunitiesWithReturn, {
        bankroll:    BANKROLL,
        competition: rawMatch.competition,
        directUrl,   // sempre presente — garantido pelo BLOQUEIO acima
      });
      log.ok('✓ Live 2T enviado ao Telegram');
      return { liveData, opportunities: opportunitiesWithReturn };

    } catch (e) {
      log.warn(`  Erro: ${e.message}`);
    }

    await sleep(1500);
  }

  log.warn('Nenhuma oportunidade live com link Superbet confirmado');
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// ETAPA 4: Super ODD — Apostas Combinadas (Parlay)
// ═════════════════════════════════════════════════════════════════════════════
async function stepSuperOdds() {
  log.step(4, 'SUPER ODD — APOSTAS COMBINADAS (Parlay)');

  const today    = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0];

  const [todayM, tomorrowM] = await Promise.all([
    getSofascoreMatches(today).catch(() => []),
    getSofascoreMatches(tomorrow).catch(() => []),
  ]);

  // Pool amplo: 8 hoje + 6 amanhã para compensar filtragem por link
  const pool = [...todayM.slice(0, 8), ...tomorrowM.slice(0, 6)];
  log.info(`Pool: ${pool.length} partidas disponíveis`);
  if (pool.length < 3) { log.warn('Pool insuficiente'); return null; }

  // ── 1. Busca mapa de eventos Superbet ANTES de analisar ────────────────────
  log.info('Buscando mapa de eventos no Superbet (pré-verificação de links)...');
  const eventMap = await getSuperbetEventMap().catch(() => new Map());
  log.info(`Superbet: ${Math.floor(eventMap.size / 2)} partidas com link disponível`);

  // Filtra pool: mantém só partidas que existem no Superbet
  const poolComLink = pool.filter(m => {
    const url = findUrlInEventMap(eventMap, m.home_team, m.away_team);
    return !!url;
  });
  log.info(`${poolComLink.length}/${pool.length} partidas com link confirmado no Superbet`);

  if (poolComLink.length < 2) {
    log.warn('Partidas com link insuficientes para montar parlay');
    return null;
  }

  let db;
  try { db = loadDB(); } catch { db = null; }

  const legs = [];
  const goalsAgent = new GoalsAgent();
  const bttsAgent  = new BTTSAgent();

  // Analisa até 12 partidas com link para montar as pernas
  for (const scheduledMatch of poolComLink.slice(0, 12)) {
    log.info(`→ ${scheduledMatch.home_team} vs ${scheduledMatch.away_team}`);
    try {
      const matchData = await fetchMatchDataFromSofa(scheduledMatch);
      await sleep(400);

      let result = null;
      for (const agent of [goalsAgent, bttsAgent]) {
        try {
          const r = await agent.analyze(matchData);
          if (r && typeof r.probabilidade === 'number' && r.probabilidade >= 70
              && typeof r.confianca === 'number' && r.confianca >= 68) {
            result = r; break;
          }
        } catch {}
        await sleep(600);
      }
      if (!result) { log.info(`  Sem resultado qualificado`); continue; }

      const market = result.mercado || 'Over 2.5';
      const odds   = result.odds_minima_recomendada || 1.75;
      const score  = Math.round((result.probabilidade * 0.6) + (result.confianca * 0.4));
      const pieCal = db?.calibration?.[market];
      const pieAcc = pieCal?.total >= 10 ? Math.round((pieCal.hits / pieCal.total) * 100) : null;

      // Link já confirmado — atribui direto
      const superbetUrl = findUrlInEventMap(eventMap, scheduledMatch.home_team, scheduledMatch.away_team);

      legs.push({
        match:         matchData.match,
        match_id:      `${scheduledMatch.sofascore_id}`,
        competition:   scheduledMatch.competition || '?',
        match_date:    scheduledMatch.match_date   || null,
        match_time:    scheduledMatch.match_time   || null,
        market,                                         // seleção específica (ex: "Over 1.5", "BTTS")
        market_type:   result.market  || market,        // tipo do agente (ex: "Total de Gols", "Escanteios")
        recomendacao:  result.recomendacao || 'APOSTAR',
        probabilidade: result.probabilidade ?? score,
        confianca:     result.confianca     ?? score,
        odds:          typeof odds === 'number' ? odds : parseFloat(odds) || 1.75,
        house:         'Superbet',
        confidence:    score,
        ev:            result.ev || 0,
        pie_accuracy:  pieAcc,
        superbet_url:  superbetUrl,
      });

      log.ok(`  Perna: ${market} @ ${odds} | prob:${result.probabilidade}% conf:${result.confianca}% | link: ✓`);
    } catch (e) {
      log.warn(`  Erro: ${e.message}`);
    }
  }

  log.info(`${legs.length} pernas qualificadas (todas com link)`);

  const parlayOptions = buildParlayOptions(legs, BANKROLL);

  // Verifica se tem pelo menos 1 tier disponível
  const tiersAvailable = Object.values(parlayOptions.tiers || {}).filter(t => t.available);
  if (!tiersAvailable.length) {
    log.warn('Nenhum tier de parlay viável com os dados disponíveis');
    return null;
  }

  log.ok(`Parlay construído: ${tiersAvailable.length} tier(s) disponível(is)`);
  for (const [name, t] of Object.entries(parlayOptions.tiers)) {
    if (t.available && t.best?.[0]) {
      const top = t.best[0];
      log.ok(`  ${name}: ${top.combined_odds}x | conf ${top.confidence}% | EV ${top.ev_pct}`);
    }
  }

  await notifySuperOddsParlay(parlayOptions, BANKROLL, { maxTiers: 1 }).catch(e =>
    log.warn(`Telegram falhou: ${e.message}`)
  );
  log.ok('✓ Super ODD enviado ao Telegram');
  return parlayOptions;
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(chalk.bold.white(`
╔══════════════════════════════════════════════════════════════╗
║       🧪 TESTE COMPLETO — FLUXO DE AUTOMAÇÃO               ║
║       Banca: R$ ${String(BANKROLL).padEnd(6)} | ${new Date().toLocaleString('pt-BR').padEnd(22)}      ║
╚══════════════════════════════════════════════════════════════╝
  `));

  const results = { preLive: null, live2T: null, superOdds: null };

  await stepClearTelegram();
  results.preLive   = await stepPreLive();
  results.live2T    = await stepLive2T();
  results.superOdds = await stepSuperOdds();

  // Resumo
  console.log(chalk.bold.white(`\n${SEP}\n  RESUMO DO TESTE\n${SEP}`));
  console.log(`  ${results.preLive   ? chalk.green('✅') : chalk.red('✖')}  Pré-Live:  ${results.preLive   ? 'ENVIADO ✓' : 'sem oportunidade'}`);
  console.log(`  ${results.live2T    ? chalk.green('✅') : chalk.red('✖')}  Live 2T:   ${results.live2T    ? 'ENVIADO ✓' : 'sem oportunidade'}`);
  console.log(`  ${results.superOdds ? chalk.green('✅') : chalk.red('✖')}  Super ODD: ${results.superOdds ? 'ENVIADO ✓' : 'sem pernas suficientes'}`);

  const total = Object.values(results).filter(Boolean).length;
  console.log(`\n  🏆  ${total}/3 análises enviadas  |  ${new Date().toLocaleTimeString('pt-BR')}\n`);

  if (total < 3) {
    console.log(chalk.yellow(`  ℹ  Dica: execute novamente às 20h-22h para mais jogos ao vivo.`));
  }
}

main().catch(e => {
  console.error(chalk.red(`\n  ERRO FATAL: ${e.message}`));
  console.error(e.stack);
  process.exit(1);
});
