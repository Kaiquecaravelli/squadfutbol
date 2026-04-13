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
import { aggregateMatchData } from '../scrapers/aggregator.js';
import { saveMatchScan } from '../utils/obsidian.js';

const MIN_PROBABILITY = parseInt(process.env.PRE_LIVE_MIN_PROBABILITY || '80');
const MIN_CONFIDENCE  = parseInt(process.env.PRE_LIVE_MIN_CONFIDENCE  || '75');
const MIN_ODDS        = parseFloat(process.env.PRE_LIVE_MIN_ODDS      || '1.50');
const MATCH_DELAY_MS  = 6_000;

const AGENTS = [
  new BTTSAgent(),
  new GoalsAgent(),
  new CornersAgent(),
  new YellowCardsAgent(),
  new DoubleChanceAgent(),
  new ExactScoreAgent(),
];

// Flag de quota esgotada — compartilhada entre ciclos
let _quotaExhaustedUntil = 0;

/**
 * Analisa uma lista de partidas pré-jogo.
 * @param {Array}  matches     — lista bruta da grade (aggregateUpcomingMatches)
 * @param {Map}    notifiedKeys — Map de chaves já notificadas (key → timestamp)
 * @returns {Array} — apenas jogos com oportunidades aprovadas
 */
export async function runPreLiveFunnel(matches, notifiedKeys = new Map()) {
  if (!matches.length) return [];

  // Verifica quota antes de iniciar
  if (Date.now() < _quotaExhaustedUntil) {
    const min = Math.ceil((_quotaExhaustedUntil - Date.now()) / 60_000);
    console.log(chalk.yellow(`  [PRÉ-LIVE] ⏸ Quota Gemini esgotada (~${min}min restantes)`));
    return [];
  }

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

      if (err.isQuotaError || consecutiveErrors >= 3) {
        _quotaExhaustedUntil = Date.now() + 20 * 60_000;
        const retoma = new Date(_quotaExhaustedUntil).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        console.log(chalk.yellow(`  [PRÉ-LIVE] ⏸ Quota esgotada — pausado até ${retoma}`));
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

  // Executa todos os agentes em paralelo (cada um tem seu próprio retry)
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
      if (r.recommendation === 'AGUARDAR' || r.recommendation === 'NÃO') return false;
      // Gate de odds mínima — análise só passa se odd ≥ 1.50
      const odds = r.odds_minima_recomendada ?? r.odds_minima ?? 0;
      if (odds > 0 && odds < MIN_ODDS) {
        console.log(chalk.gray(`    🚫 [Odds Gate] ${r.mercado || r.market} bloqueado — odd ${odds} < ${MIN_ODDS}`));
        return false;
      }
      return true;
    })
    .map((r) => ({
      ...r,
      probabilidade: r.probabilidade ?? r.confidence_score,
      confianca:     r.confianca     ?? r.confidence,
      // Normaliza nome do campo para uso consistente no Telegram
      odds_minima:   r.odds_minima_recomendada ?? r.odds_minima ?? null,
    }));

  if (!enriched.length) return null;

  // Dedup por chave matchKey + mercado + data
  const matchDate = matchData.date ? new Date(matchData.date).toISOString().slice(0, 10) : '';
  const novos = enriched.filter((r) => {
    const key = `pre_${matchKey}_${r.market}_${matchDate}`;
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
