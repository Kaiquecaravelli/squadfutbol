/**
 * live-2nd-half.js — Modelo de Análise Ao Vivo (2° Tempo)
 *
 * Janela: a partir do minuto 46 de cada partida em andamento
 * Odds alvo: 2x – 20x (ao vivo, odds dinâmicas)
 * Foco: placar atual, xG, momentum, tempo restante, pressão, escanteios
 *
 * Uso:
 *   import { runLive2ndHalfAnalysis } from './live-2nd-half.js';
 *   await runLive2ndHalfAnalysis({ bankroll: 1000, loop: true });
 *
 * CLI:
 *   node src/workflows/live-2nd-half.js
 *   node src/workflows/live-2nd-half.js --loop --interval=10
 *   node src/workflows/live-2nd-half.js --bankroll=2000
 */

import chalk from 'chalk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLiveMatches, collectLiveMatchData } from '../scrapers/sofascore.js';
import { GoalsAgent } from '../../squads/betting-analysis/market-agents/GoalsAgent.js';
import { BTTSAgent }  from '../../squads/betting-analysis/market-agents/BTTSAgent.js';
import { notifyLiveSecondHalf } from '../utils/telegram.js';
import { calcRiscoDisplay } from './prelive-analysis.js';
import { getSuperbetLiveEventMap, findUrlInLiveMap } from '../scrapers/superbet.js';
import { bttsKillSwitch, bttsMinProbability, trackBttsDecision, BTTS_MIN_CONFIDENCE } from '../utils/btts-sniper.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PIE_PATH = join(__dir, '../../data/pie.json');

// ── Configuração ──────────────────────────────────────────────────────────────
const MIN_MINUTE       = 46;   // só 2° tempo
const MAX_MINUTE       = 87;   // sem acréscimos tardios (menos liquidez)

// IDs de torneios disponíveis no Superbet BR (SofaScore uniqueTournament.id)
// Mesmo conjunto validado no historical-backfill.js + ligas AO VIVO adicionais
const SUPERBET_LIVE_TOURNAMENT_IDS = new Set([
  17,   // Premier League
  8,    // La Liga
  23,   // Serie A (ITA)
  35,   // Bundesliga
  34,   // Ligue 1
  325,  // Brasileirão Série A
  390,  // Brasileirão Série A (season alt)
  242,  // Brasileirão Série A (alt)
  7,    // UEFA Champions League
  679,  // Copa do Brasil
  699,  // Eredivisie
  155,  // Primeira Liga (POR)
  37,   // Jupiler Pro League
  130,  // Süper Lig
  238,  // MLS
  329,  // UEFA Europa League
  480,  // UEFA Conference League
  13,   // Liga Profesional Argentina
  384,  // Copa Libertadores
  480,  // Copa Sudamericana (nota: ID pode variar)
  73,   // Brasileirão Série B
]);
const MIN_PROBABILITY  = parseInt(process.env.LIVE_MIN_PROBABILITY  || '80');
const MIN_CONFIDENCE   = parseInt(process.env.LIVE_MIN_CONFIDENCE   || '80');
const ODDS_MIN         = 1.30;  // regra: AO VIVO só envia se odd ≥ 1.30
const ODDS_MAX         = 20.0;
const MAX_MATCHES      = parseInt(process.env.LIVE_MAX_MATCHES       || '5');
const DELAY_BETWEEN_MS = 10_000;  // 10s entre análises
const DEFAULT_BANKROLL = parseFloat(process.env.USER_BANKROLL || '1000');

// Usa GoalsAgent + BTTSAgent como agentes principais para análise 2T (Live2TAgent removido)
const agents2T = [new GoalsAgent(), new BTTSAgent()];

// ── Stake sugerida ao vivo (mais conservadora que pré-live) ───────────────────
const LIVE_STAKE_PCT = {
  'Baixo':  2.0,
  'Médio':  1.5,
  'Alto':   0.8,
};

// ── Gate PIE ao vivo ──────────────────────────────────────────────────────────
// Mercados bloqueados independente do que o agente retornar.
// Baseado em calibração histórica PIE: Over 3.5=27%, Over 4.5~0%, Away Win=29%
const LIVE_BLOCKED_MARKETS = new Set([
  'Over 3.5', 'Over 3.5 Gols', 'Over 4.5', 'Over 4.5 Gols',
  'Away Win',  'Draw',          'Home Win',
]);

// Mínimo de acurácia PIE exigido por mercado ao vivo (amostras >= 30)
// BTTS: Sniper v3 usa Kill Switches próprios — PIE gate é camada adicional
const PIE_MIN_ACC_BY_MARKET = {
  'Over 1.5':    70,
  'Over 2.5':    65,   // PIE real=51% — exige 65% de confiança calibrada
  'BTTS':        62,   // Sniper v3 aplica Kill Switches antes deste gate (62% = calibração real)
  'BTTS Sim':    62,   // mesma calibração que BTTS
  'Over 2.5 Gols': 65,
  '1X':          65,   // PIE real=71.5% — permite com 65%
  'X2':          65,   // PIE real=53.9% — exige calibração
};

// Normaliza o nome do mercado para lookup no PIE
function _normMarket(m) {
  const s = (m || '').toLowerCase();
  if (s.includes('btts') || s.includes('ambas'))       return 'BTTS';
  if (s.includes('over 1.5'))  return 'Over 1.5';
  if (s.includes('over 2.5'))  return 'Over 2.5';
  if (s.includes('over 3.5'))  return 'Over 3.5';
  if (s.includes('over 4.5'))  return 'Over 4.5';
  if (s.includes('1x'))        return '1X';
  if (s.includes('x2'))        return 'X2';
  if (s.includes('home win') || s === '1') return 'Home Win';
  if (s.includes('away win') || s === '2') return 'Away Win';
  if (s.includes('draw')     || s === 'x') return 'Draw';
  return m;
}

// Carrega calibração PIE (cache de 10 min — invalida quando result-checker salva novos dados)
let _pieCalibCache = null;
let _pieCacheTs    = 0;
const PIE_CACHE_TTL = 10 * 60_000; // 10 min

function _loadPieCalib() {
  if (_pieCalibCache && Date.now() - _pieCacheTs < PIE_CACHE_TTL) return _pieCalibCache;
  try {
    const db = JSON.parse(readFileSync(PIE_PATH, 'utf8'));
    _pieCalibCache = db.calibration || {};
    _pieCacheTs    = Date.now();
  } catch { _pieCalibCache = {}; }
  return _pieCalibCache;
}

/**
 * Filtra oportunidades com gate PIE + regras de negócio ao vivo.
 * Retorna { passed, blocked } para log.
 */
function applyPieGate(opportunities, rawMatch) {
  const calib    = _loadPieCalib();
  const scoreH   = rawMatch.score_home ?? 0;
  const scoreA   = rawMatch.score_away ?? 0;
  const min      = rawMatch.minute ?? 50;

  const passed  = [];
  const blocked = [];

  for (const o of opportunities) {
    const mkt     = o.mercado || '';
    const normMkt = _normMarket(mkt);

    // BTTS Sniper v3 — Kill Switches (executa ANTES de qualquer outra regra)
    if (normMkt === 'BTTS' || mkt === 'Ambas Marcam') {
      const killReason = bttsKillSwitch(o, rawMatch);
      if (killReason) {
        blocked.push({ ...o, bloqueio: killReason });
        trackBttsDecision('blocked', o, rawMatch, killReason, 'live-2h');
        continue;
      }
      const minProb = bttsMinProbability(rawMatch.competition);
      const prob    = o.probabilidade ?? 0;
      const conf    = o.confianca     ?? 0;
      if (prob < minProb) {
        const reason = `Threshold Sniper — prob ${prob}% < ${minProb}%`;
        blocked.push({ ...o, bloqueio: reason });
        trackBttsDecision('blocked', o, rawMatch, reason, 'live-2h');
        continue;
      }
      if (conf < BTTS_MIN_CONFIDENCE) {
        const reason = `Threshold Sniper — confiança ${conf}% < ${BTTS_MIN_CONFIDENCE}%`;
        blocked.push({ ...o, bloqueio: reason });
        trackBttsDecision('blocked', o, rawMatch, reason, 'live-2h');
        continue;
      }
      // Aprovado pelo Sniper — registra disparo
      trackBttsDecision('fired', o, rawMatch, null, 'live-2h');
    }

    // Regra 1 — mercados estruturalmente bloqueados ao vivo
    if (LIVE_BLOCKED_MARKETS.has(mkt) || LIVE_BLOCKED_MARKETS.has(normMkt)) {
      blocked.push({ ...o, bloqueio: `mercado bloqueado ao vivo (baixa acc histórica)` });
      continue;
    }

    // Regra 2 — "Resultado Final {time}" no 2T: placar empatado ou adverso = bloquear
    if (mkt.toLowerCase().includes('resultado final')) {
      const teamInMkt = mkt.replace(/resultado final/i, '').trim().toLowerCase();
      const isHome    = (rawMatch.home_team || '').toLowerCase().includes(teamInMkt.slice(0, 5));
      const isAway    = (rawMatch.away_team || '').toLowerCase().includes(teamInMkt.slice(0, 5));
      const empatado  = scoreH === scoreA;
      const perdendo  = (isHome && scoreH < scoreA) || (isAway && scoreA < scoreH);
      if (empatado || perdendo) {
        blocked.push({ ...o, bloqueio: `Resultado Final bloqueado (placar ${scoreH}-${scoreA} desfavorável no ${min}')` });
        continue;
      }
    }

    // Regra 3 — gate PIE por mercado (acurácia histórica mínima)
    const pieKey  = normMkt;
    const pieData = calib[pieKey];
    const minAcc  = PIE_MIN_ACC_BY_MARKET[pieKey] ?? PIE_MIN_ACC_BY_MARKET[mkt] ?? 0;

    if (pieData && pieData.total >= 30 && minAcc > 0) {
      const pieAcc = (pieData.hits / pieData.total) * 100;
      if (pieAcc < minAcc) {
        blocked.push({ ...o, bloqueio: `PIE ${pieKey} = ${pieAcc.toFixed(1)}% < min ${minAcc}%` });
        continue;
      }
    }

    passed.push(o);
  }

  return { passed, blocked };
}

// ── Análise de um jogo ao vivo no 2T ─────────────────────────────────────────
async function analyzeSecondHalf(rawMatch, bankroll, notifiedKeys) {
  const label = `${rawMatch.home_team} vs ${rawMatch.away_team}`;
  const min   = rawMatch.minute ?? 50;
  const score = `${rawMatch.score_home}-${rawMatch.score_away}`;

  // Coleta dados completos (xG, stats, forma, H2H)
  const liveData = await collectLiveMatchData(rawMatch);

  // Gate de qualidade: precisa de stats ao vivo mínimas
  const temStats = !!(liveData.live_stats?.chutes_alvo_casa != null || liveData.xg_home != null);
  if (!temStats) {
    console.log(chalk.gray(`    ⏭  ${label} — sem stats ao vivo suficientes`));
    return [];
  }

  // Analisa com agentes Groq (GoalsAgent + BTTSAgent) — Live2TAgent removido
  const rawResults = await Promise.all(agents2T.map((a) => a.analyze(liveData).catch(() => null)));
  const opportunities = rawResults.filter(Boolean).flat();

  if (!opportunities.length) {
    console.log(chalk.gray(`    ⏭  ${label} [${min}'] ${score} — sem oportunidades no 2T`));
    return [];
  }

  // Gate PIE: filtra mercados com baixa precisão histórica ou situação adversa
  const { passed: pieOk, blocked: pieBlocked } = applyPieGate(opportunities, rawMatch);
  for (const b of pieBlocked) {
    console.log(chalk.yellow(`    🚫 [PIE Gate] ${b.mercado} bloqueado — ${b.bloqueio}`));
  }
  if (!pieOk.length) {
    console.log(chalk.yellow(`    ⛔  ${label} — todas oportunidades bloqueadas pelo PIE gate`));
    return [];
  }

  // Filtra por odds target — AO VIVO exige odds ≥ 1.30 (regra de qualidade)
  const qualified = pieOk.filter(o => {
    const odds = o.odds_minima ?? 1.5;
    const ok   = odds >= ODDS_MIN && odds <= ODDS_MAX;
    if (!ok) {
      console.log(chalk.gray(`    🚫 [Odds Gate] ${o.mercado} bloqueado — odds ${odds} < ${ODDS_MIN} (mínimo AO VIVO)`));
    }
    return ok;
  });

  if (!qualified.length) return [];

  // Dedup — evita reenviar a mesma oportunidade do mesmo jogo
  const dedupeKey = `${label}_${score}_${qualified.map(o => o.mercado).join('|')}`;
  if (notifiedKeys?.has(dedupeKey)) {
    console.log(chalk.gray(`    ⏭  ${label} — já notificado (dedup)`));
    return [];
  }
  notifiedKeys?.set(dedupeKey, Date.now());

  // Prepara retorno potencial por oportunidade
  const opportunitiesWithReturn = qualified.map(o => {
    const odds       = o.odds_minima ?? 1.5;
    const risco      = calcRiscoDisplay(o.confianca, odds, 'live');
    const stakePct   = LIVE_STAKE_PCT[risco.label] ?? 1.5;
    const stake      = Math.round(bankroll * (stakePct / 100) * 100) / 100;
    const ganho      = Math.round(stake * odds * 100) / 100;
    const roi        = Math.round((odds - 1) * 100);
    const roiStr     = `+${roi}%`;

    return {
      ...o,
      odds,
      risco,
      stakeInfo: { stake, ganho, roi, roiStr, stakePct },
    };
  });

  // Log no terminal
  console.log(chalk.bold.green(`    ✅ ${qualified.length} oportunidade(s) — ${label} [${min}'] ${score}`));
  for (const o of opportunitiesWithReturn) {
    console.log(chalk.green(`       • ${o.mercado} → ${o.recomendacao}  Prob:${o.probabilidade}%  Conf:${o.confianca}%  Odds:${o.odds}`));
    console.log(chalk.green(`         Stake R$ ${o.stakeInfo.stake} → 🏆 R$ ${o.stakeInfo.ganho} (${o.stakeInfo.roiStr})  ${o.risco.icon} ${o.risco.label}`));
  }

  return { liveData, opportunities: opportunitiesWithReturn };
}

// ── Scan completo de jogos no 2° tempo ────────────────────────────────────────
async function runScan(bankroll, notifiedKeys) {
  const ts    = new Date().toLocaleTimeString('pt-BR');
  const start = Date.now();

  console.log(chalk.bold.red(`\n[${ts}] 🔴 Scan Ao Vivo — 2° Tempo`));

  // Busca todos os jogos ao vivo
  const allLive = await getLiveMatches().catch(() => []);

  // Padrões de nome de liga — usados como fallback quando tournament_id não está disponível
  // Suficientemente específicos para evitar falsos positivos (e.g. "ligapro serie a" != "serie a")
  const LEAGUE_NAME_FALLBACK = [
    /^premier league$/i,
    /^la liga$/i,
    /^bundesliga$/i,
    /^ligue 1$/i,
    /^serie a$/i,                     // Itália (SofaScore usa exatamente "Serie A")
    /^brasileiro.*série a/i,
    /^brasileiro.*betano/i,
    /^brasileiro.*série b/i,
    /^mls$/i,
    /^eredivisie$/i,
    /^s[üu]per lig$/i,
    /^primeira liga$/i,
    /^jupiler/i,
    /^champions league/i,
    /^europa league/i,
    /^conference league/i,
    /^liga profesional/i,             // Argentina
    /^copa libertadores/i,
    /^copa sudamericana/i,
    /^copa do brasil/i,
  ];

  // Filtra: 2° tempo (min 46-87) E liga disponível no Superbet
  const secondHalf = allLive.filter(m => {
    const min    = m.minute ?? 0;
    const inTime = min >= MIN_MINUTE && min <= MAX_MINUTE;

    // Prioridade 1: verificação por ID (mais precisa)
    if (m.tournament_id != null) {
      return inTime && SUPERBET_LIVE_TOURNAMENT_IDS.has(m.tournament_id);
    }
    // Fallback: verificação por nome exato (apenas padrões seguros)
    const comp = m.competition || '';
    return inTime && LEAGUE_NAME_FALLBACK.some(rx => rx.test(comp));
  });

  if (!secondHalf.length) {
    console.log(chalk.yellow(`  ⚠️  Nenhum jogo em 2° tempo (${allLive.length} ao vivo total)`));
    return 0;
  }

  const limited = secondHalf.slice(0, MAX_MATCHES);
  console.log(chalk.white(`  📡 ${allLive.length} ao vivo  |  ${secondHalf.length} em 2T  |  analisando ${limited.length}`));

  for (const m of limited) {
    const min = m.minute ?? '?';
    const tid = m.tournament_id ? ` (ID:${m.tournament_id})` : '';
    console.log(chalk.gray(`    [${min}'] ${m.home_team} vs ${m.away_team} — ${m.score_home}-${m.score_away} — ${m.competition || '?'}${tid}`));
  }

  // Resolve URLs diretas das partidas no Superbet (uma chamada Playwright para todo o scan)
  console.log(chalk.gray('  🔗 Resolvendo links diretos no Superbet...'));
  const liveMap = await getSuperbetLiveEventMap().catch(() => new Map());
  if (liveMap.size > 0) {
    console.log(chalk.gray(`  🔗 ${liveMap.size} partidas mapeadas no Superbet`));
  }

  let totalOpp = 0;

  for (let i = 0; i < limited.length; i++) {
    const match = limited[i];
    const min   = match.minute ?? '?';
    const label = `${match.home_team} vs ${match.away_team}`;

    console.log(chalk.bold.white(`\n  🔴 [${i + 1}/${limited.length}] ${label}  [${min}']`));

    try {
      const result = await analyzeSecondHalf(match, bankroll, notifiedKeys);
      if (result && result.opportunities?.length) {
        totalOpp += result.opportunities.length;
        // Resolve URL direta da partida no Superbet
        const directUrl = findUrlInLiveMap(liveMap, match.home_team, match.away_team) || null;
        if (directUrl) console.log(chalk.gray(`     🔗 Link direto: ${directUrl}`));
        // Notifica no Telegram com link direto da partida
        await notifyLiveSecondHalf(result.liveData, result.opportunities, { bankroll, directUrl }).catch(() => {});
      }
    } catch (err) {
      console.error(chalk.red(`    ❌ Erro: ${err.message}`));
      if (err.isQuotaError) {
        console.log(chalk.yellow('  ⏸  Cota Gemini esgotada — pausando 20 min'));
        await new Promise(r => setTimeout(r, 20 * 60_000));
        break;
      }
    }

    if (i < limited.length - 1) await new Promise(r => setTimeout(r, DELAY_BETWEEN_MS));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(chalk.bold.red(`\n  ✅ Scan 2T concluído — ${totalOpp} oportunidade(s) — ${elapsed}s`));
  return totalOpp;
}

// ── Entrada pública ───────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {number}  opts.bankroll     - Banca total
 * @param {boolean} opts.loop         - Loop contínuo
 * @param {number}  opts.intervalMin  - Intervalo em minutos (padrão: 10)
 */
export async function runLive2ndHalfAnalysis(opts = {}) {
  const bankroll    = opts.bankroll || DEFAULT_BANKROLL;
  const loop        = opts.loop || false;
  const intervalMin = opts.intervalMin || 10;
  const notifiedKeys = new Map(); // dedup entre ciclos

  console.log('\n' + '═'.repeat(64));
  console.log(`  🔴 AO VIVO — Modelo 2° Tempo`);
  console.log(`  Janela: min ${MIN_MINUTE}-${MAX_MINUTE} | Odds: ${ODDS_MIN}x-${ODDS_MAX}x | Banca: R$ ${bankroll}`);
  if (loop) console.log(`  Loop ativo: scan a cada ${intervalMin} min`);
  console.log('═'.repeat(64) + '\n');

  await runScan(bankroll, notifiedKeys);

  if (!loop) return;

  // Limpa dedup a cada hora (evita crescimento indefinido)
  setInterval(() => {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [k, ts] of notifiedKeys.entries()) {
      if (ts < cutoff) notifiedKeys.delete(k);
    }
  }, 60 * 60_000);

  console.log(chalk.gray(`\n⏰ Próximo scan 2T em ${intervalMin} minuto(s)...\n`));
  setInterval(async () => {
    await runScan(bankroll, notifiedKeys).catch(e =>
      console.error(chalk.red(`[Live 2T] Erro no loop: ${e.message}`))
    );
    console.log(chalk.gray(`\n⏰ Próximo scan 2T em ${intervalMin} minuto(s)...\n`));
  }, intervalMin * 60_000);

  await new Promise(() => {}); // mantém processo vivo
}

// ── CLI direto ────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('live-2nd-half.js')) {
  import('dotenv/config').catch(() => {});

  const args        = process.argv.slice(2);
  const loop        = args.includes('--loop');
  const bankArg     = args.find(a => a.startsWith('--bankroll='));
  const intervalArg = args.find(a => a.startsWith('--interval='));

  await runLive2ndHalfAnalysis({
    bankroll:    bankArg    ? parseFloat(bankArg.split('=')[1])    : undefined,
    intervalMin: intervalArg ? parseInt(intervalArg.split('=')[1]) : 10,
    loop,
  });
}
