import { collectMatchData } from '../agents/scout.js';
import { fetchNewsForMatch } from '../agents/news-analyst.js';
import { analyzeTactical } from '../agents/tactician.js';
import { analyzeQuantitative } from '../agents/quant.js';
import { analyzeScorePredictions } from '../agents/score-predictor.js';
import { trackOdds } from '../agents/odds-tracker.js';
import { assessRisk } from '../agents/risk-manager.js';
import { generateReport, calcConfidenceScore } from '../agents/reporter.js';
import { saveAnalysis } from '../utils/storage.js';
import { notifyBetRecommendation, notifyScorePredictions } from '../utils/telegram.js';
import { getMockMatch, getMockNews } from '../utils/mock-data.js';
import { BloomAgent }     from '../../squads/betting-analysis/sharp-agents/BloomAgent.js';
import { BenhamAgent }    from '../../squads/betting-analysis/sharp-agents/BenhamAgent.js';
import { WaltersAgent }   from '../../squads/betting-analysis/sharp-agents/WaltersAgent.js';
import { VoulgarisAgent } from '../../squads/betting-analysis/sharp-agents/VoulgarisAgent.js';
import { RebeloAgent }    from '../../squads/betting-analysis/sharp-agents/RebeloAgent.js';

/**
 * Matriz de roteamento de Sharp Agents por mercado.
 *
 * COMPARATIVO DE AGENTES:
 * ┌──────────────┬─────────────────────────────────────────────┬───────────────────────────────────────────┐
 * │ Agente       │ Melhor para                                 │ Especialidade                             │
 * ├──────────────┼─────────────────────────────────────────────┼───────────────────────────────────────────┤
 * │ Bloom        │ Over/Under gols, BTTS, Asian Handicap       │ Poisson puro, volume, confiança estatística│
 * │ Benham       │ BTTS, Over 2.5+, times subestimados (xG)   │ Performance subjacente, reversão à média  │
 * │ Walters      │ 1X2, steam moves, timing de mercado         │ Line movement, sharp vs. public           │
 * │ Rebelo       │ Asian Handicap, exchange, arbitragem        │ Fair price vs. market, stop loss, liquidez│
 * │ Voulgaris    │ Escanteios, cartões, decisões de treinador  │ Modelagem comportamental, CLV, padrões    │
 * │ Webb         │ In-play, scalping, microestrutura           │ WOM, ticks, greening, volatilidade        │
 * │ Ranogajec    │ Arbitragem entre casas, mercados globais    │ Volume, spread global, liquidez máxima    │
 * └──────────────┴─────────────────────────────────────────────┴───────────────────────────────────────────┘
 *
 * Regra de seleção: 2 agentes primários por mercado na zona borderline (score 55-75).
 */
const SHARP_ROUTING = {
  // Mercados de gols — Bloom (Poisson) + Benham (xG subjacente)
  'BTTS':        ['BloomAgent',     'BenhamAgent'],
  'Over 1.5':    ['BloomAgent',     'BenhamAgent'],
  'Over 2.5':    ['BloomAgent',     'BenhamAgent'],
  'Over 3.5':    ['BenhamAgent',    'VoulgarisAgent'],

  // Mercados 1X2 — Walters (timing/steam) + Rebelo (fair price/exchange)
  'Home Win':    ['WaltersAgent',   'RebeloAgent'],
  'Away Win':    ['WaltersAgent',   'RebeloAgent'],
  'Draw':        ['VoulgarisAgent', 'RebeloAgent'],

  // Dupla Chance — Walters (line movement) + Rebelo (fair price)
  '1X':          ['WaltersAgent',   'RebeloAgent'],
  'X2':          ['WaltersAgent',   'RebeloAgent'],
  '12':          ['RebeloAgent',    'BloomAgent'],
  // Placar Exato — Voulgaris (padrões comportamentais) + Bloom (Poisson puro)
  'Correct Score': ['VoulgarisAgent', 'BloomAgent'],

  // Mercados de escanteios/cartões — Voulgaris (padrões) + Benham (contexto)
  'Escanteios':  ['VoulgarisAgent', 'BenhamAgent'],
  'Cartões':     ['VoulgarisAgent', 'WaltersAgent'],

  // Handicap Asiático — Rebelo (exchange) + Bloom (Poisson)
  'Asian Handicap': ['RebeloAgent', 'BloomAgent'],
};
const SHARP_DEFAULT = ['WaltersAgent', 'BloomAgent'];
const SHARP_AGENT_MAP = { BloomAgent, BenhamAgent, WaltersAgent, VoulgarisAgent, RebeloAgent };

// Decisões positivas conforme definido em test-squad.js
const POSITIVE_DECISIONS = new Set([
  'EXECUTE', 'EXECUTE_VOLUME', 'BUY_VALUE', 'SCALP_ENTRY',
  'HIGH_VOLUME_EXECUTE', 'ALGO_BEAT_THE_LINE', 'SHARP_MOVE_ENTRY',
]);
const NEGATIVE_DECISIONS = new Set([
  'NO_CONTEXTUAL_EDGE', 'NEUTRAL', 'PASS', 'REJECT', 'STAY_OUT', 'NO_PLAY',
]);

async function runSharpGate(matchData, topBet) {
  const agentNames = SHARP_ROUTING[topBet?.market] || SHARP_DEFAULT;
  const agents = agentNames.map(name => new SHARP_AGENT_MAP[name]());
  const results = await Promise.all(agents.map(a => a.analyze(matchData)));
  const positives = results.filter(r => POSITIVE_DECISIONS.has(r.decision)).length;
  const negatives = results.filter(r => NEGATIVE_DECISIONS.has(r.decision)).length;
  const names = results.map(r => `${r.agent}:${r.decision}`).join(' | ');
  console.log(`  🔬 Sharp Gate: ${names}`);
  // Ambos aprovam → +6, ambos rejeitam → -4, divergência → +2
  if (positives === 2) return 6;
  if (negatives === 2) return -4;
  return 2;
}

/**
 * Pipeline completo de análise de uma partida.
 * Fase 1: Coleta (scout) — blocking
 * Fase 2: Análise paralela (news + tactical + quant + odds)
 * Fase 3: Gestão de risco
 * Fase 4: Relatório final
 */
export async function runFullMatchAnalysis(matchId, options = {}) {
  const isDemo = process.env.DEMO_MODE === 'true' || options.demo === true;

  console.log(`\n🎯 [Betting Master] Iniciando análise completa — Match ID: ${matchId}${isDemo ? ' [MODO DEMO]' : ''}\n`);

  // FASE 1 — Coleta
  const matchData = isDemo
    ? getMockMatch(matchId)
    : await collectMatchData(matchId);
  console.log(`✅ Dados coletados: ${matchData.match}\n`);

  // FASE 2 — Análise paralela
  console.log('🔄 Executando análise paralela...\n');

  const demoNews = isDemo
    ? { home: getMockNews(matchData.home.team), away: getMockNews(matchData.away.team) }
    : null;

  const [newsAnalysis, , quantAnalysis, oddsAnalysis] = await Promise.all([
    demoNews
      ? Promise.resolve(demoNews)
      : fetchNewsForMatch(matchData).catch((e) => ({ home: fallbackNews(matchData.home.team, e), away: fallbackNews(matchData.away.team, e) })),
    Promise.resolve(null),  // placeholder: tactician executado após quant abaixo
    Promise.resolve(analyzeQuantitative(matchData)),
    isDemo
      ? Promise.resolve({ match: matchData.match, current_odds: matchData.odds, movement: {}, best_odds: buildBestOdds(matchData.odds), alerts: [], market_sentiment: 'neutral' })
      : trackOdds(matchData).catch(() => ({ match: matchData.match, current_odds: matchData.odds, movement: {}, best_odds: {}, alerts: [], market_sentiment: 'neutral' })),
  ]);

  // FASE 2a — Tactician com xG do quant + lesões das notícias
  const tacticalAnalysis = analyzeTactical(matchData, { quantAnalysis, newsAnalysis });

  // FASE 2b — Ariel: Placar Exato, Vitória com Margem, Dupla Chance
  let scorePrediction = null;
  try {
    scorePrediction = analyzeScorePredictions({ matchData, quantAnalysis });
  } catch (e) {
    console.log(`  ⚠️  [Ariel] Falha: ${e.message}`);
  }

  // FASE 3 — Gestão de risco (Kelly dinâmico via PIE)
  const riskAssessment = assessRisk({
    quantAnalysis,
    oddsAnalysis,
    bankroll: options.bankroll,
    dailyExposure: options.dailyExposure || 0,
  });

  // FASE 3b — Sharp Gate (zona borderline: 55-75 pts)
  let sharpBonus = 0;
  const topBetForGate = quantAnalysis.value_bets?.[0];
  const prelimScore = calcConfidenceScore({ tacticalAnalysis, quantAnalysis, newsAnalysis, oddsAnalysis, riskAssessment, topBet: topBetForGate });
  if (prelimScore >= 55 && prelimScore <= 75) {
    console.log(`\n⚡ [Sharp Gate] Score preliminar: ${prelimScore} — zona borderline. Consultando agentes especializados...\n`);
    try {
      sharpBonus = await runSharpGate(matchData, topBetForGate);
      console.log(`  ${sharpBonus > 0 ? '✅' : sharpBonus < 0 ? '⚠️' : '➡️'} Sharp Bonus: ${sharpBonus > 0 ? '+' : ''}${sharpBonus} pts → Score ajustado: ${Math.min(100, Math.max(0, prelimScore + sharpBonus))}\n`);
    } catch (e) {
      console.log(`  ⚠️  Sharp Gate falhou: ${e.message} — prosseguindo sem ajuste\n`);
    }
  }

  // Enriquece matchData com xG do modelo (lambda Poisson) para persistência e Telegram
  if (quantAnalysis?.lambda_home != null) matchData.xg_home = quantAnalysis.lambda_home;
  if (quantAnalysis?.lambda_away != null) matchData.xg_away = quantAnalysis.lambda_away;

  // FASE 4 — Relatório (com dados do Ariel)
  const report = generateReport({
    matchData,
    newsAnalysis,
    tacticalAnalysis,
    quantAnalysis,
    oddsAnalysis,
    riskAssessment,
    sharpBonus,
    scorePrediction,
  });

  // Persistir análise
  try {
    const topBet = quantAnalysis.value_bets?.[0];
    const analysisId = await saveAnalysis({
      match_id: String(matchId),
      match_name: matchData.match,
      competition: matchData.competition,
      match_date: matchData.date,
      confidence_score: report.confidence_score,
      recommendation: report.recommendation?.action,
      market: topBet?.market || null,
      odds: topBet?.odds || null,
      house: topBet?.house || null,
      ev: topBet?.ev || null,
    });
    report.analysis_id = analysisId;
  } catch {
    // storage opcional
  }

  // Notificar via Telegram se score alto
  if (report.recommendation?.action === 'BET' || report.recommendation?.action === 'CONSIDER') {
    await notifyBetRecommendation(report, matchData).catch(() => {});

    // Ariel: enviar análise de placar exato / dupla chance junto quando há value
    if (scorePrediction) {
      const hasCSValue  = scorePrediction.exact_scores?.value_bets?.length > 0;
      const hasDCValue  = scorePrediction.double_chance_bets?.value_bets?.length > 0;
      if (hasCSValue || hasDCValue) {
        await notifyScorePredictions(scorePrediction, matchData).catch(() => {});
      }
    }
  }

  return {
    ...report,
    score_prediction: scorePrediction,
  };
}

function buildBestOdds(odds) {
  if (!odds) return {};
  const best = {};
  const markets = ['home_win', 'draw', 'away_win', 'over_2_5'];
  for (const market of markets) {
    let bestHouse = null, bestOdd = 0;
    for (const [house, houseOdds] of Object.entries(odds)) {
      const val = houseOdds?.[market];
      if (val && val > bestOdd) { bestOdd = val; bestHouse = house; }
    }
    if (bestHouse) best[market] = { house: bestHouse, odds: bestOdd };
  }
  return best;
}

function fallbackNews(team, err) {
  return {
    team,
    news_count: 0,
    impact_score: 0,
    sentiment: 'neutral',
    key_headlines: [],
    summary: `Notícias indisponíveis (${err?.message || 'erro desconhecido'})`,
  };
}
