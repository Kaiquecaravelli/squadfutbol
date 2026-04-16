/**
 * parlay-builder.js — Módulo de Alavancagem: Apostas Combinadas (SUPER ODDS)
 *
 * Objetivo: Construir parlays/acumuladores selecionando as melhores pernas
 * individualmente para compor apostas combinadas com ROI potencial de 20x-2000x.
 *
 * Tiers de alavancagem:
 *   Seguro       : 2-3 pernas | odds  2x-10x  | conf ≥ 80%
 *   Acumulador   : 4-5 pernas | odds 10x-50x  | conf ≥ 72%
 *   Mega Retorno : 5-8 pernas | odds 20x-500x | conf ≥ 62%  ← FOCO 20x+
 *   Super Odds   : 6-10 pernas| odds 100x+    | conf ≥ 55%
 *
 * Estratégia de mercados (baseada em calibração PIE real):
 *   ⭐⭐⭐ Over Corners 6.5 (82%), Over 1.5 (78%), Corners 7.5 (73%)
 *   ⭐⭐  1X (71%)
 *   ⭐   BTTS (56%), X2 (54%), Over 2.5 (53%)
 *   ✗   Home Win (46%), Away Win (29%), Draw (25%), Over 3.5 (29%)
 *
 * Regras de anti-correlação (APEX v2.1):
 *   - Nunca 2 pernas do mesmo jogo (intra-jogo)
 *   - Penalização de correlação cruzada entre mercados da mesma família
 *     Ex: Over 1.5 + BTTS de jogos diferentes compartilham fator gols → corr ~0.40
 *   - Kelly ajustado por número de pernas: stake *= (1 - n_pernas/20)
 */

import { loadDB } from '../pie/pie-storage.js';

// ── Máximo de pernas extraídas por jogo ───────────────────────────────────────
const MAX_LEGS_PER_GAME = 3;

// ── Melhoria A — Correlação cruzada entre mercados (APEX v2.1) ────────────────
// Mercados agrupados por família. Pernas de jogos diferentes na mesma família
// compartilham fatores sistemáticos (rodada defensiva, árbitro, clima) e portanto
// NÃO são independentes como P(A∩B) = P(A)×P(B) assume.
//
// cross_game_corr: correlação estimada entre ocorrências do mercado em jogos distintos
//   da mesma rodada (Pearson, baseada em análise de 200+ jogos reais)
const MARKET_FAMILY = {
  'BTTS':              { family: 'goals',   cross_game_corr: 0.40 },
  'Over 1.5':          { family: 'goals',   cross_game_corr: 0.38 },
  'Over 2.5':          { family: 'goals',   cross_game_corr: 0.35 },
  'Over 3.5':          { family: 'goals',   cross_game_corr: 0.30 },
  'Over 4.5':          { family: 'goals',   cross_game_corr: 0.25 },
  'Under 2.5':         { family: 'goals',   cross_game_corr: 0.35 },
  'Over Corners 6.5':  { family: 'corners', cross_game_corr: 0.50 },
  'Over Corners 7.5':  { family: 'corners', cross_game_corr: 0.48 },
  'Over Corners 8.5':  { family: 'corners', cross_game_corr: 0.45 },
  'Over Corners 9.5':  { family: 'corners', cross_game_corr: 0.42 },
  'Over Corners 10.5': { family: 'corners', cross_game_corr: 0.40 },
  'Over YC 2.5':       { family: 'cards',   cross_game_corr: 0.30 },
  'Over YC 3.5':       { family: 'cards',   cross_game_corr: 0.28 },
  '1X':                { family: 'result',  cross_game_corr: 0.08 },
  'X2':                { family: 'result',  cross_game_corr: 0.08 },
  'Home Win':          { family: 'result',  cross_game_corr: 0.06 },
  'Away Win':          { family: 'result',  cross_game_corr: 0.06 },
};

// Limiar a partir do qual aplica penalidade de concentração
const CORR_THRESHOLD         = 0.30;  // ignora pares com corr < 0.30
const CORR_PENALTY_WEIGHT    = 0.18;  // quanto cada ponto de correlação desconta no EV
const CORR_MAX_TOTAL_PENALTY = 0.35;  // desconto máximo total no EV (35%)

/**
 * Calcula o fator de penalidade por correlação cruzada entre pernas.
 * Retorna { penalty_factor, detail } onde penalty_factor ∈ [0.65, 1.00].
 * EV ajustado = EV_raw × penalty_factor.
 */
function calcCrossCorrelationPenalty(legs) {
  let totalPenalty = 0;
  const pairs = [];

  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const legA = legs[i];
      const legB = legs[j];

      // Pernas do mesmo jogo já foram bloqueadas por isValidCombo — ignora
      if (legA.match_id && legB.match_id && legA.match_id === legB.match_id) continue;
      if (legA.match === legB.match) continue;

      const famA = MARKET_FAMILY[legA.market];
      const famB = MARKET_FAMILY[legB.market];

      if (!famA || !famB || famA.family !== famB.family) continue;

      // Correlação cruzada entre jogos: média das duas corr
      const corr = (famA.cross_game_corr + famB.cross_game_corr) / 2;
      if (corr < CORR_THRESHOLD) continue;

      const pairPenalty = corr * CORR_PENALTY_WEIGHT;
      totalPenalty += pairPenalty;
      pairs.push({ marketA: legA.market, marketB: legB.market, corr: Math.round(corr * 100) / 100, pairPenalty: Math.round(pairPenalty * 100) / 100 });
    }
  }

  const clampedPenalty = Math.min(totalPenalty, CORR_MAX_TOTAL_PENALTY);
  return {
    penalty_factor:   Math.round((1 - clampedPenalty) * 1000) / 1000,
    total_penalty_pp: Math.round(clampedPenalty * 100),
    correlated_pairs: pairs,
    high_concentration: clampedPenalty >= 0.15,
  };
}

// ── Mercados excluídos do SUPER ODDS (baixa precisão histórica) ───────────────
// PIE real: Draw=25%, Over 3.5=29%, Away Win=29%, Home Win=46%
const SUPER_ODDS_EXCLUDED = new Set([
  'Home Win', 'Away Win', 'Draw', 'Empate',
  'Over 3.5', 'Over 4.5', 'Under 2.5', 'Under 3.5',
  'Over YC 3.5', '12',
]);

// ── Boost de confidence por mercado (baseado em calibração PIE real) ──────────
// Ajuste adicional ao score do pipeline para refletir precisão histórica real
const MARKET_CONFIDENCE_BOOST = {
  'Over Corners 6.5': 8,   // 82.1% PIE — melhor mercado historicamente
  'Over 1.5':         6,   // 77.6% PIE — excelente
  'Over Corners 7.5': 5,   // 73.4% PIE — ótimo
  '1X':               4,   // 71.5% PIE — bom
  'BTTS':            -2,   // 55.6% PIE — abaixo da média
  'X2':              -2,   // 53.9% PIE — abaixo da média
  'Over 2.5':        -2,   // 53.4% PIE — abaixo da média
  'Over YC 2.5':     -1,   // sem dados suficientes — neutro/leve penalidade
  'Over Corners 8.5': 3,   // provável ~ 60-65%
};

// ── PIE market key mapping ────────────────────────────────────────────────────
const MARKET_PIE_KEY = {
  'BTTS':             'BTTS',
  'Over 1.5':         'Over 1.5',
  'Over 2.5':         'Over 2.5',
  'Over 3.5':         'Over 3.5',
  'Home Win':         'Home Win',
  'Away Win':         'Away Win',
  'Draw':             null,
  '1X':               '1X',
  'X2':               'X2',
  'Over Corners 6.5': 'Over Corners 6.5',
  'Over Corners 7.5': 'Over Corners 7.5',
  'Over Corners 8.5': 'Over Corners 8.5',
};

// ── Configuração de tiers ─────────────────────────────────────────────────────
const PARLAY_TIERS = [
  {
    name:        'Seguro',
    emoji:       '🛡️',
    min_legs:    2,
    max_legs:    3,
    min_conf:    80,
    min_odds:    1.25,
    stake_pct:   5,    // % da banca recomendada
    target_roi:  '2x-10x',
  },
  {
    name:        'Acumulador',
    emoji:       '⚡',
    min_legs:    4,
    max_legs:    5,
    min_conf:    72,
    min_odds:    1.30,
    stake_pct:   2,
    target_roi:  '10x-50x',
  },
  {
    name:        'Mega Retorno',
    emoji:       '💥',
    min_legs:    5,
    max_legs:    8,
    min_conf:    62,
    min_odds:    1.20,
    stake_pct:   1.5,
    target_roi:  '20x-500x',
    highlight_above: 20.0,   // destaca combinações com odds ≥ 20x
  },
  {
    name:        'Super Odds',
    emoji:       '🚀',
    min_legs:    6,
    max_legs:    10,
    min_conf:    55,
    min_odds:    1.15,
    stake_pct:   0.5,
    target_roi:  '100x-2000x',
    highlight_above: 100.0,
  },
];

// ── Constrói o conjunto de pernas a partir de análises do pipeline ─────────────
// Extrai até MAX_LEGS_PER_GAME (3) value bets de cada análise para maximizar
// as combinações disponíveis no parlay builder.
export function buildLegsFromAnalyses(analyses) {
  let db;
  try { db = loadDB(); } catch { db = null; }

  const legs = [];

  for (const analysis of analyses) {
    if (!analysis) continue;

    const score = analysis.confidence_score ?? analysis.confidenceScore ?? 0;

    // Extrai os melhores value_bets do jogo, excluindo mercados de baixa precisão
    const allBets = (analysis.value_bets || [])
      .filter(b => b?.market && b?.odds && !SUPER_ODDS_EXCLUDED.has(b.market))
      .slice(0, MAX_LEGS_PER_GAME);

    // Fallback: se value_bets vazio, usa top_bet
    if (!allBets.length) {
      const topBet = analysis.top_bet || analysis.topBet;
      if (topBet?.odds && topBet?.market && !SUPER_ODDS_EXCLUDED.has(topBet.market)) {
        allBets.push(topBet);
      }
    }

    for (const bet of allBets) {
      // Acurácia PIE para o mercado
      let pieAccuracy = null;
      if (db) {
        const key = MARKET_PIE_KEY[bet.market];
        const cal = key ? db.calibration?.[key] : null;
        if (cal && cal.total >= 10) {
          pieAccuracy = Math.round((cal.hits / cal.total) * 100);
        }
      }

      // Confidence composta: score pipeline + boost por mercado + fator PIE genérico
      const marketBoost = MARKET_CONFIDENCE_BOOST[bet.market] ?? 0;
      const pieBoost    = pieAccuracy ? Math.round((pieAccuracy - 75) * 0.2) : 0;
      const finalConf   = Math.min(99, Math.max(0, score + marketBoost + pieBoost));

      legs.push({
        match:        analysis.matchData?.match || analysis.match_name || 'Jogo',
        competition:  analysis.matchData?.competition || analysis.competition || '-',
        market:       bet.market,
        odds:         bet.odds,
        house:        bet.house || 'Superbet',
        confidence:   finalConf,
        ev:           bet.ev || 0,
        pie_accuracy: pieAccuracy,
        match_id:     analysis.match_id || analysis.matchData?.match,
        superbet_url: analysis.superbet_url || null,
      });
    }
  }

  return legs.sort((a, b) => b.confidence - a.confidence);
}

// ── Verifica se duas pernas são correlacionadas (proibido juntar) ─────────────
function areCorrelated(legA, legB) {
  if (legA.match_id && legB.match_id && legA.match_id === legB.match_id) return true;
  if (legA.match === legB.match) return true;
  return false;
}

// ── Gera combinações de tamanho k a partir de um array ───────────────────────
function* combinations(arr, k) {
  if (k === 1) { for (const x of arr) yield [x]; return; }
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of combinations(arr.slice(i + 1), k - 1)) {
      yield [arr[i], ...rest];
    }
  }
}

// ── Valida se uma combinação de pernas é válida (sem correlações) ─────────────
function isValidCombo(legs) {
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      if (areCorrelated(legs[i], legs[j])) return false;
    }
  }
  return true;
}

// ── Calcula métricas de um parlay ─────────────────────────────────────────────
// APEX v2.1: inclui penalidade de correlação cruzada (Melhoria A)
//            e Kelly ajustado por número de pernas (Melhoria B)
function calcParlayMetrics(legs, bankroll = 1000) {
  const combinedOdds = legs.reduce((acc, l) => acc * l.odds, 1);
  const combinedProb = legs.reduce((acc, l) => acc * (l.confidence / 100), 1);

  // ── Melhoria A: Penalidade de correlação cruzada ──────────────────────────
  const corrInfo   = calcCrossCorrelationPenalty(legs);
  const evRaw      = (combinedOdds * combinedProb) - 1;
  const ev         = evRaw * corrInfo.penalty_factor;   // EV real após correlação
  const evPct      = (ev * 100).toFixed(1);
  const evRawPct   = (evRaw * 100).toFixed(1);

  const confidence = Math.round(combinedProb * 100);

  const b = combinedOdds - 1;
  const p = combinedProb;
  const q = 1 - p;
  const kellyFull = Math.max(0, (b * p - q) / b);

  const tier = PARLAY_TIERS.find(t =>
    legs.length >= t.min_legs && legs.length <= t.max_legs
  ) || PARLAY_TIERS[PARLAY_TIERS.length - 1];

  // ── Melhoria B: Kelly ajustado por número de pernas ───────────────────────
  // Mais pernas = maior variância = Kelly menor para proteger a banca
  // 2 pernas: ×0.90 | 5 pernas: ×0.75 | 8 pernas: ×0.60 | 10 pernas: ×0.50
  const legCountMultiplier = Math.max(0.50, 1 - legs.length / 20);
  const kellyStake = bankroll * kellyFull * 0.20 * legCountMultiplier;
  const maxStake   = bankroll * (tier.stake_pct / 100);
  const stake      = Math.min(kellyStake, maxStake);

  return {
    leg_count:        legs.length,
    combined_odds:    Math.round(combinedOdds * 100) / 100,
    combined_prob:    Math.round(combinedProb * 10000) / 100,
    confidence,
    ev,
    ev_pct:           `${ev > 0 ? '+' : ''}${evPct}%`,
    ev_raw_pct:       `${evRaw > 0 ? '+' : ''}${evRawPct}%`,   // EV sem desconto (para debug)
    potential_return: Math.round(stake * combinedOdds * 100) / 100,
    stake:            Math.round(stake * 100) / 100,
    tier:             tier.name,
    tier_emoji:       tier.emoji,
    roi_multiplier:   Math.round(combinedOdds * 10) / 10,
    is_mega:          combinedOdds >= 20.0,
    // Métricas APEX v2.1
    correlation:      corrInfo,
    kelly_leg_mult:   Math.round(legCountMultiplier * 100),   // ex: 75 = ×0.75
  };
}

// ── Constrói as melhores opções de parlay por tier ────────────────────────────
export function buildParlayOptions(legs, bankroll = 1000, topN = 5) {
  const results = { tiers: {} };

  for (const tier of PARLAY_TIERS) {
    const qualifiedLegs = legs.filter(l =>
      l.confidence >= tier.min_conf && l.odds >= tier.min_odds
    );

    if (qualifiedLegs.length < tier.min_legs) {
      results.tiers[tier.name] = {
        available: false,
        reason: `Pernas insuficientes (${qualifiedLegs.length}/${tier.min_legs} com conf. ≥ ${tier.min_conf}%)`,
      };
      continue;
    }

    const bestCombos = [];
    // Limita análise combinatória: top 12 pernas para evitar explosão de combos
    const topLegs = qualifiedLegs.slice(0, 12);

    for (let k = tier.min_legs; k <= Math.min(tier.max_legs, topLegs.length); k++) {
      for (const combo of combinations(topLegs, k)) {
        if (!isValidCombo(combo)) continue;

        const metrics = calcParlayMetrics(combo, bankroll);
        // Para Mega Retorno e Super Odds: aceita EV ligeiramente negativo se odds ≥ 20x
        if (metrics.ev <= -0.05 && metrics.combined_odds < 20.0) continue;

        // Gate obrigatório: SuperOdds exige odds combinadas ≥ 10x
        if (metrics.combined_odds < 10.0) continue;

        // Gate obrigatório: pelo menos 2 jogos distintos na combinação
        const distinctMatches = new Set(combo.map(l => l.match_id || l.match)).size;
        if (distinctMatches < 2) continue;

        bestCombos.push({ legs: combo, ...metrics });
      }
    }

    // Ordena por: 1) é_mega (20x+) desc, 2) EV × log(odds) desc
    bestCombos.sort((a, b) => {
      if (a.is_mega !== b.is_mega) return a.is_mega ? -1 : 1;
      return (b.ev * Math.log(b.combined_odds)) - (a.ev * Math.log(a.combined_odds));
    });

    results.tiers[tier.name] = {
      available: true,
      best: bestCombos.slice(0, topN),
      tier_config: tier,
    };
  }

  results.summary = buildSummary(results);
  return results;
}

// ── Formata relatório terminal ─────────────────────────────────────────────────
export function formatParlayReport(options, bankroll = 1000) {
  const lines = [];

  lines.push('\n' + '═'.repeat(68));
  lines.push('  🎰 MÓDULO DE ALAVANCAGEM — APOSTAS COMBINADAS (SUPER ODDS)');
  lines.push('═'.repeat(68));

  for (const tier of PARLAY_TIERS) {
    const tierData = options.tiers[tier.name];
    lines.push(`\n  ${tier.emoji} ${tier.name.toUpperCase()} — ROI alvo: ${tier.target_roi}`);
    lines.push('  ' + '─'.repeat(60));

    if (!tierData?.available) {
      lines.push(`  ⚠️  ${tierData?.reason || 'Não disponível'}`);
      continue;
    }

    for (let i = 0; i < tierData.best.length; i++) {
      const p = tierData.best[i];
      const megaFlag   = p.is_mega ? '  🏆 MEGA' : '';
      const corrFlag   = p.correlation?.high_concentration ? '  ⚠️ correlação alta' : '';
      const kellyLabel = `Kelly ×${p.kelly_leg_mult}%`;
      lines.push(`\n  Opção ${i + 1}  |  ${p.leg_count} pernas  |  Odds: ${p.combined_odds}x${megaFlag}  |  EV: ${p.ev_pct}${corrFlag}`);
      lines.push(`  Confiança: ${p.confidence}%  |  Stake: R$ ${p.stake} (${kellyLabel})  |  Retorno: R$ ${p.potential_return}`);
      if (p.correlation?.correlated_pairs?.length > 0) {
        const corrSummary = p.correlation.correlated_pairs.map(cp => `${cp.marketA}↔${cp.marketB}(${Math.round(cp.corr * 100)}%)`).join(', ');
        lines.push(`  ↳ Correlação cruzada -${p.correlation.total_penalty_pp}pp EV: ${corrSummary}`);
      }
      lines.push('');
      for (const leg of p.legs) {
        const pie = leg.pie_accuracy ? ` [PIE ${leg.pie_accuracy}%]` : '';
        lines.push(`    → ${leg.match.substring(0, 38).padEnd(38)} ${leg.market.padEnd(15)} ${String(leg.odds).padEnd(6)} (${leg.confidence}% conf.)${pie}`);
      }
    }
  }

  // Destaque: maior retorno ≥ 20x disponível
  const megaBest = _findBestMega(options);
  if (megaBest) {
    lines.push('\n' + '─'.repeat(68));
    lines.push(`  💥 MEGA APOSTA DO DIA: ${megaBest.combined_odds}x retorno  [${megaBest.tier_emoji} ${megaBest.tier}]`);
    lines.push(`     Stake mínima: R$ ${megaBest.stake} → Ganho potencial: R$ ${megaBest.potential_return}`);
    lines.push(`     Probabilidade: ${megaBest.combined_prob}%  |  EV: ${megaBest.ev_pct}  |  ${megaBest.leg_count} pernas`);
  } else {
    const superTier = options.tiers['Super Odds'];
    if (superTier?.available && superTier.best.length > 0) {
      const best = superTier.best[0];
      lines.push('\n' + '─'.repeat(68));
      lines.push(`  🏆 SUPER APOSTA DO DIA: ${best.combined_odds}x retorno`);
    }
  }

  lines.push('\n' + '═'.repeat(68));
  lines.push('  ⚠️  IMPORTANTE: Apostas combinadas aumentam ROI mas reduzem probabilidade.');
  lines.push('     Mercados prioritários: Over Corners 6.5 (82%) > Over 1.5 (78%) > 1X (71%)');
  lines.push('     Use stake menor nos tiers de maior risco. Nunca comprometa > 5% da banca.');
  lines.push('═'.repeat(68) + '\n');

  return lines.join('\n');
}

// ── Encontra a melhor aposta com odds ≥ 20x ───────────────────────────────────
function _findBestMega(options) {
  let best = null;
  for (const tierData of Object.values(options.tiers)) {
    if (!tierData.available) continue;
    for (const p of tierData.best || []) {
      if (p.combined_odds >= 20.0) {
        if (!best || p.combined_odds > best.combined_odds) best = p;
      }
    }
  }
  return best;
}

// ── Resumo executivo ──────────────────────────────────────────────────────────
function buildSummary(results) {
  let bestSingleOdds = 0;
  let totalOptions   = 0;
  let megaOptions    = 0;

  for (const tierData of Object.values(results.tiers)) {
    if (!tierData.available) continue;
    for (const p of tierData.best || []) {
      totalOptions++;
      if (p.combined_odds >= 20.0) megaOptions++;
      if (p.combined_odds > bestSingleOdds) bestSingleOdds = p.combined_odds;
    }
  }

  return {
    total_options:        totalOptions,
    mega_options_20x:     megaOptions,
    best_odds_available:  Math.round(bestSingleOdds * 10) / 10,
    tiers_available:      PARLAY_TIERS.filter(t => results.tiers[t.name]?.available).map(t => t.name),
  };
}
