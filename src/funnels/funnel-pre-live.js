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
import { YellowCardsAgent }  from '../../squads/betting-analysis/market-agents/YellowCardsAgent.js';
import { DoubleChanceAgent } from '../../squads/betting-analysis/market-agents/DoubleChanceAgent.js';
import { ExactScoreAgent }   from '../../squads/betting-analysis/market-agents/ExactScoreAgent.js';
import { ResultAgent }       from '../../squads/betting-analysis/market-agents/ResultAgent.js';
import { aggregateMatchData } from '../scrapers/aggregator.js';
import { saveMatchScan } from '../utils/obsidian.js';
import { getAgentCalibration } from '../pie/pie-storage.js';

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

// Cache de calibração PIE em memória — atualizado 1x por execução do funil (não por match)
let _calibCache = null;
let _calibCacheTs = 0;
const CALIB_CACHE_TTL = 5 * 60_000; // 5 min

function _getCalibCache() {
  if (_calibCache && Date.now() - _calibCacheTs < CALIB_CACHE_TTL) return _calibCache;
  try { _calibCache = getAgentCalibration; _calibCacheTs = Date.now(); } catch {}
  return null;
}

function _getDynamicMinOdds(market, probability) {
  try {
    const calib = getAgentCalibration(market);
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
  new YellowCardsAgent(),
  new DoubleChanceAgent(),
  new ExactScoreAgent(),
  new ResultAgent(),
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

  const enriched = allResults
    .filter((r) => {
      if (!r || typeof r.probabilidade !== 'number') return false;
      if (r.probabilidade < MIN_PROBABILITY) return false;
      if ((r.confianca ?? 0) < MIN_CONFIDENCE) return false;
      // Normaliza campo de mercado: alguns agentes retornam 'market', outros 'mercado'
      if (!r.mercado && r.market) r.mercado = r.market;
      if (!r.market && r.mercado) r.market  = r.mercado;
      if (r.recomendacao === 'AGUARDAR' || r.recomendacao === 'NÃO') return false;
      if (r.recommendation === 'AGUARDAR' || r.recommendation === 'NÃO') return false;
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

  // Dedup por sofascore_id (imutável) + mercado — evita falso dedup por mudança de data ISO
  const sfId = matchData.sofascore_id || matchData.match_id || matchKey;
  const novos = enriched.filter((r) => {
    const mkt = r.mercado || r.market || '';
    const key = `pre_${sfId}_${mkt}`;
    if (notifiedKeys.has(key)) return false;
    notifiedKeys.set(key, Date.now());
    return true;
  });

  if (!novos.length) return null;

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
  // Normaliza duas variantes: com ponto ("over_3.5") e sem ponto ("over_35")
  const base    = mercado.toLowerCase().replace(/\s+/g, '_');
  const withDot = base;                          // "over_3.5"
  const noDot   = base.replace(/\./g, '');       // "over_35"
  // Tenta as duas formas
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
