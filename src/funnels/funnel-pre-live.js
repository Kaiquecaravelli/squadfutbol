/**
 * Funil PRÉ-LIVE — Análise de jogos pré-jogo (próximas 24h)
 *
 * Mercados: BTTS · Gols · Escanteios · Cartões · Dupla Chance · Placar Exato
 * Gate: Prob ≥ 80% E Confiança ≥ 75% E recomendação APOSTAR/CONSIDERAR
 *
 * Este funil encapsula toda a lógica de análise pré-jogo anteriormente
 * inline em auto-monitor.js, expondo uma interface uniforme:
 *   run(matches) → Array de { matchData, enriched, sentResults, matchId, idx, kickoffTime }
 */

import chalk from 'chalk';

import { BTTSAgent }         from '../../squads/betting-analysis/market-agents/BTTSAgent.js';
import { GoalsAgent }        from '../../squads/betting-analysis/market-agents/GoalsAgent.js';
import { CornersAgent }      from '../../squads/betting-analysis/market-agents/CornersAgent.js';
import { DoubleChanceAgent } from '../../squads/betting-analysis/market-agents/DoubleChanceAgent.js';
import { aggregateMatchData } from '../scrapers/aggregator.js';
import { saveMatchScan } from '../utils/obsidian.js';
import { getAgentCalibration } from '../pie/pie-storage.js';
import { bttsKillSwitch, bttsMinProbability, trackBttsDecision, BTTS_MIN_CONFIDENCE } from '../utils/btts-sniper.js';
import { goalsKillSwitch, goalsMinProbability, trackGoalsDecision, GOALS_MIN_CONFIDENCE } from '../utils/goals-sniper.js';

const MIN_PROBABILITY = parseInt(process.env.PRE_LIVE_MIN_PROBABILITY || '80');
const MIN_CONFIDENCE  = parseInt(process.env.PRE_LIVE_MIN_CONFIDENCE  || '75');
const MIN_ODDS        = parseFloat(process.env.PRE_LIVE_MIN_ODDS      || '1.50');

// ── Gate dinâmico de odds baseado na calibração PIE ──────────────────────────
// Quanto maior a precisão histórica do mercado, menor a odd mínima exigida.
// Níveis: PIE ≥ 90% → aceita 1.25 | PIE ≥ 82% → 1.35 | PIE ≥ 74% → 1.45 | default → 1.50
const PIE_ODDS_TIERS = [
  { minAccuracy: 90, minProb: 85, minSamples: 50, minOdds: 1.25 },
  { minAccuracy: 82, minProb: 82, minSamples: 30, minOdds: 1.35 },
  { minAccuracy: 74, minProb: 80, minSamples: 20, minOdds: 1.45 },
];

// Cache de calibração PIE em memória por mercado — atualizado 1x por execução do funil
// FIX: cache era por objeto único (não por mercado) e a função era atribuída sem ser chamada
let _calibCache = null; // Map<market, calib>
let _calibCacheTs = 0;
const CALIB_CACHE_TTL = 5 * 60_000; // 5 min

function _getCalibCached(market) {
  if (!_calibCache || Date.now() - _calibCacheTs >= CALIB_CACHE_TTL) {
    _calibCache = new Map();
    _calibCacheTs = Date.now();
  }
  if (!_calibCache.has(market)) {
    try { _calibCache.set(market, getAgentCalibration(market)); }
    catch { _calibCache.set(market, null); }
  }
  return _calibCache.get(market) ?? null;
}

function _getDynamicMinOdds(market, probability) {
  try {
    const calib = _getCalibCached(market);
    if (!calib) return MIN_ODDS;

    const accuracy = parseFloat(calib.overall);
    const samples  = calib.samples ?? 0;

    for (const tier of PIE_ODDS_TIERS) {
      if (accuracy >= tier.minAccuracy && probability >= tier.minProb && samples >= tier.minSamples) {
        return tier.minOdds;
      }
    }
  } catch { /* PIE indisponível → usa padrão */ }
  return MIN_ODDS;
}
const MATCH_DELAY_MS  = 10_000; // 10s entre jogos — respeita 20k TPM/min por chave Groq

const AGENTS = [
  new BTTSAgent(),
  new GoalsAgent(),
  new CornersAgent(),
  new DoubleChanceAgent(),
];


/**
 * Analisa uma lista de partidas pré-jogo.
 * @param {Array}  matches     — lista bruta da grade (aggregateUpcomingMatches)
 * @param {Map}    notifiedKeys — Map de chaves já notificadas (key → timestamp)
 * @returns {Array} — apenas jogos com oportunidades aprovadas
 */
export async function runPreLiveFunnel(matches, notifiedKeys = new Map()) {
  if (!matches.length) return [];

  const approved = [];
  let consecutiveErrors = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];

    try {
      const result = await _analyzeMatch(match, i, notifiedKeys);
      consecutiveErrors = 0;
      if (result) approved.push(result);
    } catch (err) {
      consecutiveErrors++;
      console.error(chalk.red(`  [PRÉ-LIVE] ❌ ${match.match || match.home_team}: ${err.message}`));

      // 3 erros consecutivos = para o ciclo, tentará no próximo agendamento
      if (consecutiveErrors >= 3) {
        console.log(chalk.yellow(`  [PRÉ-LIVE] ⏸ 3 erros consecutivos — aguardando próximo ciclo`));
        break;
      }
    }

    if (i < matches.length - 1) await sleep(MATCH_DELAY_MS);
  }

  return approved;
}

// ── Análise individual ─────────────────────────────────────────────────────────
async function _analyzeMatch(match, idx, notifiedKeys) {
  const matchData = await aggregateMatchData(match);
  // Propaga campos de orquestração que aggregateMatchData não copia automaticamente
  if (match._bucket) matchData._bucket = match._bucket;

  // Pool Groq com 6 chaves: todos os 7 agentes em paralelo com round-robin automático
  const rawResults = await Promise.allSettled(
    AGENTS.map((agent) => agent.analyze(matchData))
  );

  const allResults = rawResults
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);

  if (!allResults.length) return null;

  // Enriquece com metadados — filtro + dedup
  const matchKey = `${match.home_team || matchData.home?.team}_${match.away_team || matchData.away?.team}`;

  // Salva TODOS os resultados no Obsidian (antes do filtro de gate)
  const approvedForObsidian = allResults.filter((r) =>
    (r?.probabilidade ?? 0) >= MIN_PROBABILITY && (r?.confianca ?? 0) >= MIN_CONFIDENCE
  );
  saveMatchScan(matchData, allResults, approvedForObsidian);

  // Whitelist de mercados válidos na Superbet — qualquer mercado fora dessa lista
  // é bloqueado imediatamente (previne hallucinations do LLM como "Under 8.5 Gols")
  const VALID_MARKETS = new Set([
    // Gols
    'Over 1.5', 'Over 2.5', 'Over 3.5', 'Over 4.5',
    'Under 1.5', 'Under 2.5', 'Under 3.5',
    // Escanteios — sempre com "Corners" no nome
    'Over Corners 6.5', 'Over Corners 7.5', 'Over Corners 8.5', 'Over Corners 9.5',
    'Under Corners 7.5', 'Under Corners 8.5', 'Under Corners 9.5',
    // Cartões amarelos
    'YC 2.5', 'YC 3.5', 'YC 4.5', 'Over YC 2.5', 'Over YC 3.5', 'Over YC 4.5',
    // BTTS
    'BTTS', 'Ambas Marcam',
    // Dupla chance
    '1X', 'X2', '12',
    // Resultado final
    '1', '2', 'X', 'Home Win', 'Away Win', 'Draw',
    // Placar exato — aceita qualquer formato "N-N" ou "Placar"
  ]);

  const enriched = allResults
    .filter((r) => {
      if (!r || typeof r.probabilidade !== 'number') return false;
      if (r.probabilidade < MIN_PROBABILITY) return false;
      if ((r.confianca ?? 0) < MIN_CONFIDENCE) return false;
      // Normaliza campo de mercado: alguns agentes retornam 'market', outros 'mercado'
      if (!r.mercado && r.market) r.mercado = r.market;
      if (!r.market && r.mercado) r.market  = r.mercado;
      // Corrige hallucination do LLM: CornersAgent retornou "Under 8.5" sem "Corners"
      // → normaliza para "Under Corners 8.5" usando r.market (campo autoritativo do agente)
      if (r.mercado && r.market && /escanteio|corner/i.test(r.market)) {
        if (/^(over|under)\s*[\d.]+$/i.test(r.mercado.trim())) {
          const dir = /^under/i.test(r.mercado) ? 'Under' : 'Over';
          const num = r.mercado.match(/[\d.]+/)?.[0] || '';
          r.mercado = `${dir} Corners ${num}`;
        }
      }
      if (r.recomendacao === 'AGUARDAR' || r.recomendacao === 'NÃO') return false;
      if (r.recommendation === 'AGUARDAR' || r.recommendation === 'NÃO') return false;
      // BTTS Sniper Gate — Kill Switches v3 (módulo btts-sniper.js compartilhado)
      const mktForBtts = (r.mercado || r.market || '').trim();
      if (mktForBtts === 'BTTS' || mktForBtts === 'Ambas Marcam') {
        const bttsBlock = bttsKillSwitch(r, matchData);
        if (bttsBlock) {
          console.log(chalk.gray(`    🚫 [BTTS Sniper] ${bttsBlock}`));
          trackBttsDecision('blocked', r, matchData, bttsBlock, 'prelive');
          return false;
        }
        const minProb = bttsMinProbability(matchData.competition);
        if (r.probabilidade < minProb) {
          const reason = `Threshold — prob ${r.probabilidade}% < ${minProb}%`;
          console.log(chalk.gray(`    🚫 [BTTS Sniper] ${reason}`));
          trackBttsDecision('blocked', r, matchData, reason, 'prelive');
          return false;
        }
        if ((r.confianca ?? 0) < BTTS_MIN_CONFIDENCE) {
          const reason = `Threshold — confiança ${r.confianca}% < ${BTTS_MIN_CONFIDENCE}%`;
          console.log(chalk.gray(`    🚫 [BTTS Sniper] ${reason}`));
          trackBttsDecision('blocked', r, matchData, reason, 'prelive');
          return false;
        }
        trackBttsDecision('fired', r, matchData, null, 'prelive');
        console.log(chalk.cyan(`    🎯 [BTTS Sniper] DISPARO aprovado — ${r.probabilidade}%/conf ${r.confianca}% (${matchData.competition || ''})`));
      }
      // Goals Sniper Gate — Kill Switches v1 (mercados Over/Under de gols)
      const mktForGoals = (r.mercado || r.market || '').trim();
      const isGoalsMarket = /^(over|under)\s*[\d.]+$/.test(mktForGoals) &&
                            !/corner|escanteio/i.test(mktForGoals) &&
                            !/yc/i.test(mktForGoals);
      if (isGoalsMarket) {
        const goalsBlock = goalsKillSwitch(r, matchData);
        if (goalsBlock) {
          console.log(chalk.gray(`    🚫 [Goals Sniper] ${goalsBlock}`));
          trackGoalsDecision('blocked', r, matchData, goalsBlock, 'prelive');
          return false;
        }
        const minProbGoals = goalsMinProbability(mktForGoals, matchData.competition);
        if ((r.probabilidade ?? 0) < minProbGoals) {
          const reason = `Threshold — prob ${r.probabilidade}% < ${minProbGoals}%`;
          console.log(chalk.gray(`    🚫 [Goals Sniper] ${reason}`));
          trackGoalsDecision('blocked', r, matchData, reason, 'prelive');
          return false;
        }
        if ((r.confianca ?? 0) < GOALS_MIN_CONFIDENCE) {
          const reason = `Threshold — confiança ${r.confianca}% < ${GOALS_MIN_CONFIDENCE}%`;
          console.log(chalk.gray(`    🚫 [Goals Sniper] ${reason}`));
          trackGoalsDecision('blocked', r, matchData, reason, 'prelive');
          return false;
        }
        trackGoalsDecision('fired', r, matchData, null, 'prelive');
        console.log(chalk.cyan(`    🎯 [Goals Sniper] DISPARO aprovado — ${mktForGoals} ${r.probabilidade}%/conf ${r.confianca}%`));
      }
      // Whitelist gate — bloqueia mercados inventados pelo LLM
      const mkt = (r.mercado || r.market || '').trim();
      const isExactScore = /^\d+-\d+$/.test(mkt) || /placar/i.test(mkt);
      const isDupla = /^(dupla|double)/i.test(mkt);
      const isResult = /^(resultado|result)/i.test(mkt);
      if (!isExactScore && !isDupla && !isResult && !VALID_MARKETS.has(mkt)) {
        console.log(chalk.gray(`    🚫 [Market Gate] ${mkt} bloqueado — mercado não disponível na Superbet`));
        return false;
      }
      // Gate de odds dinâmico — limiar reduzido para mercados com alta precisão PIE
      const realOdd  = _realOddForMarket(r.mercado || r.market, matchData.odds);
      const modelOdd = r.odds_minima_recomendada ?? r.odds_minima ?? null;
      const odds     = realOdd ?? modelOdd ?? 0;
      // Bloqueia análise sem nenhuma validação de odds — previne EV negativo silencioso
      if (realOdd === null && modelOdd === null) {
        console.log(chalk.gray(`    🚫 [Odds Gate] ${r.mercado || r.market} bloqueado — sem odds (real ou modelo)`));
        return false;
      }
      const minOdds  = _getDynamicMinOdds(r.mercado || r.market, r.probabilidade ?? 0);
      if (odds > 0 && odds < minOdds) {
        const pieTag = minOdds < MIN_ODDS ? ` [PIE gate: ${minOdds}]` : '';
        console.log(chalk.gray(`    🚫 [Odds Gate] ${r.mercado || r.market} bloqueado — odd ${odds} < ${minOdds}${pieTag}`));
        return false;
      }
      // Gate de sanidade para mercados de alta variância (Over 3.5 / Over 4.5)
      // Base rates históricas: Over 3.5 = 24.5% | Over 4.5 = 13.4%
      const mercadoNorm = (r.mercado || r.market || '').toLowerCase();
      if (mercadoNorm.includes('over 3.5') || mercadoNorm.includes('over_3.5')) {
        if (!realOdd) {
          console.log(chalk.gray(`    🚫 [Sanity Gate] Over 3.5 bloqueado — sem odd real da Superbet (base rate 24.5%)`));
          return false;
        }
        // Se odd real disponível, valida EV: só passa se prob_modelo > 1/real_odd × 100
        const impliedProb = (1 / realOdd) * 100;
        if ((r.probabilidade ?? 0) < impliedProb) {
          console.log(chalk.gray(`    🚫 [Sanity Gate] Over 3.5 bloqueado — prob modelo (${r.probabilidade}%) < implied (${impliedProb.toFixed(1)}%) com odd ${realOdd}`));
          return false;
        }
      }
      if (mercadoNorm.includes('over 4.5') || mercadoNorm.includes('over_4.5')) {
        if (!realOdd) {
          console.log(chalk.gray(`    🚫 [Sanity Gate] Over 4.5 bloqueado — sem odd real da Superbet (base rate 13.4%)`));
          return false;
        }
      }
      return true;
    })
    .map((r) => {
      const realOdd = _realOddForMarket(r.mercado || r.market, matchData.odds);
      const modelOdd = r.odds_minima_recomendada ?? r.odds_minima ?? null;
      // Prefere odd real da Superbet; cai para estimativa do modelo se não disponível
      const oddsMinima = realOdd ?? modelOdd;
      if (realOdd && modelOdd && realOdd !== modelOdd) {
        console.log(chalk.gray(`    📊 [Odds] ${r.mercado} — real Superbet: ${realOdd} | estimativa modelo: ${modelOdd}`));
      }
      return {
        ...r,
        probabilidade: r.probabilidade ?? r.confidence_score,
        confianca:     r.confianca     ?? r.confidence,
        odds_minima:   oddsMinima,
      };
    });

  if (!enriched.length) return null;

  // Dedup por jogo + bucket (não por mercado) — um envio por jogo por bucket
  // Quando o jogo transita para o próximo bucket (ex: +6h → +3h), nova análise disparada.
  // Chave retroativa sem bucket: pre_{id} (compatibilidade com execuções anteriores)
  const sfId    = matchData.sofascore_id || matchData.match_id || matchKey;
  const bucket  = matchData._bucket || '';
  const gameKey = bucket ? `dedup:${sfId}:${bucket}` : `pre_${sfId}`;

  if (notifiedKeys.has(gameKey)) return null;

  // Todos os mercados aprovados neste ciclo compõem a notificação única do jogo+bucket
  const novos = enriched;
  if (!novos.length) return null;

  // Marca o jogo como enviado neste bucket — bloqueia reenvio em varreduras futuras
  notifiedKeys.set(gameKey, Date.now());

  return {
    idx,
    matchData,
    enriched: novos,
    sentResults: novos,
    matchId:     matchKey,
    kickoffTime: matchData.date ? new Date(matchData.date).getTime() : null,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Mapeia o nome do mercado para a chave de odds real coletada da Superbet.
 * Retorna a odd real ou null se não disponível.
 */
function _realOddForMarket(mercado, oddsObj) {
  if (!oddsObj || !mercado) return null;

  // Mapeamento explícito para escanteios — "Over/Under Corners X.X" → chave Superbet
  const mktLow = mercado.toLowerCase();
  if (mktLow.includes('corner') || mktLow.includes('escanteio')) {
    const linha = mercado.match(/[\d.]+/)?.[0] || '';
    const linhaKey = linha.replace('.', '_');
    if (/over/i.test(mercado)) {
      // over_corners_6_5, over_corners_7_5, over_corners_8_5, over_corners_9_5
      const key = `over_corners_${linhaKey}`;
      return oddsObj[key] ?? null;
    } else if (/under/i.test(mercado)) {
      // under_corners_8_5 etc — se a Superbet não tiver, retorna null (sem fallback)
      const key = `under_corners_${linhaKey}`;
      return oddsObj[key] ?? null;
    }
  }

  // YC (cartões amarelos): "YC 2.5" | "Over YC 2.5" → over_yc_2_5
  if (mktLow.includes('yc') || mktLow.includes('card') || mktLow.includes('cartao') || mktLow.includes('cartão')) {
    const linha = mercado.match(/[\d.]+/)?.[0] || '';
    const linhaKey = linha.replace('.', '_');
    const key = `over_yc_${linhaKey}`;
    return oddsObj[key] ?? null;
  }

  // Normaliza duas variantes: com ponto ("over_3.5") e sem ponto ("over_35")
  const base    = mercado.toLowerCase().replace(/\s+/g, '_');
  const withDot = base;
  const noDot   = base.replace(/\./g, '');
  for (const key of [withDot, noDot]) {
    if (oddsObj[key] != null) return oddsObj[key];
  }
  // Variantes BTTS
  if (noDot.includes('btts') || noDot.includes('ambas')) return oddsObj.btts_yes ?? null;
  // 1X2
  if (noDot === '1' || noDot.includes('home_win') || noDot.includes('vitoria_mandante') || noDot.includes('vitoria_casa') || noDot.includes('casa')) return oddsObj.home_win ?? null;
  if (noDot === '2' || noDot.includes('away_win') || noDot.includes('vitoria_visitante') || noDot.includes('vitoria_fora') || noDot.includes('fora')) return oddsObj.away_win ?? null;
  if (noDot === 'x' || noDot.includes('empate')) return oddsObj.draw ?? null;
  return null;
}
