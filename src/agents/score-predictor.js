/**
 * ScorePredictor — Ariel
 *
 * Especialidade: Placar Exato · Vitória com Margem · Dupla Chance Calibrada
 *
 * ADJETIVOS DO AGENTE:
 * ─ Cirúrgica       : mapeia 49 placares possíveis (matriz 7x7 Poisson + Dixon-Coles)
 * ─ Conservadora    : CS tem odds altas (4x–25x) → Kelly fracional 0.3–0.7%
 * ─ Contextual      : integra forma, H2H e pressão tática ao ajuste de probabilidade
 * ─ Calibrada (PIE) : registra acurácia histórica de CS separadamente no PIE
 * ─ Anti-correlação : nunca combina CS + Over/Under do mesmo jogo em parlay
 * ─ Composta        : detecta quando "Vitória × CS" bate aposta simples em retorno esperado
 * ─ Transparente    : exibe top-8 placares com probabilidade real vs implícita
 *
 * MERCADOS COBERTOS:
 *   1. Placar Exato (Correct Score) — top-8 por probabilidade com EV calculado
 *   2. Vitória com Margem           — diferença de gols provável (1, 2, 3+)
 *   3. Dupla Chance Calibrada       — 1X / X2 / 12 com filtro tático e PIE
 *
 * ENTRADA  → { matchData, quantAnalysis }
 * SAÍDA    → { exact_scores, victory_depth, double_chance_bets, summary }
 */

import { loadDB } from '../pie/pie-storage.js';

// ── Constantes ────────────────────────────────────────────────────────────────
const MAX_GOALS    = 7;     // Dimensão máxima da matriz de placar
const TOP_SCORES   = 8;     // Quantos placares exatos listar
const MIN_EV_CS    = 0.08;  // EV mínimo para CS ser considerado value bet (8%)
const MIN_EV_DC    = 0.04;  // EV mínimo para Dupla Chance (4%)
const MIN_PROB_DC  = 0.55;  // Probabilidade mínima 55% para Dupla Chance qualificar

// Placares "comuns" — mercado tende a subprecificar estes vs placares exóticos
const COMMON_SCORES = new Set(['1-0','0-1','1-1','2-0','0-2','2-1','1-2','2-2','3-1','1-3','3-0','0-3']);

// ── Exportação Principal ─────────────────────────────────────────────────────
export function analyzeScorePredictions({ matchData, quantAnalysis }) {
  console.log(`🎯 [ScorePredictor/Ariel] Analisando placares, vitórias e dupla chance...`);

  const { lambda_home, lambda_away } = quantAnalysis;

  if (!lambda_home || !lambda_away) {
    console.log(`  ⚠️  [Ariel] Lambdas indisponíveis — skip`);
    return _emptyResult(matchData);
  }

  // Reconstruir matriz corrigida (Dixon-Coles) a partir dos lambdas
  const matrix = _buildCorrectedMatrix(lambda_home, lambda_away);

  // 1. Placar Exato
  const exactScores   = _analyzeExactScores(matrix, matchData);

  // 2. Vitória com Margem
  const victoryDepth  = _analyzeVictoryDepth(matrix, matchData, quantAnalysis);

  // 3. Dupla Chance Calibrada
  const doubleChance  = _analyzeDoubleChance(quantAnalysis, matchData);

  // 4. PIE factor para CS
  const pieFactor     = _getPIEFactor('Correct Score');

  // 5. Resumo executivo
  const summary       = _buildSummary(exactScores, victoryDepth, doubleChance, pieFactor);

  return {
    match:             matchData.match,
    exact_scores:      exactScores,
    victory_depth:     victoryDepth,
    double_chance_bets: doubleChance,
    pie_factor_cs:     pieFactor,
    summary,
  };
}

// ── Placar Exato ──────────────────────────────────────────────────────────────
function _analyzeExactScores(matrix, matchData) {
  const odds = matchData.odds || {};

  // Achatar matriz em array de { score, prob, homeGoals, awayGoals }
  const flat = [];
  for (let h = 0; h < MAX_GOALS; h++) {
    for (let a = 0; a < MAX_GOALS; a++) {
      flat.push({
        label:     `${h}-${a}`,
        home_goals: h,
        away_goals: a,
        prob:      matrix[h][a],
        is_common: COMMON_SCORES.has(`${h}-${a}`),
      });
    }
  }

  // Ordenar por probabilidade decrescente, pegar top N
  flat.sort((a, b) => b.prob - a.prob);
  const top = flat.slice(0, TOP_SCORES);

  // Calcular EV para cada placar se as odds estiverem disponíveis
  const withEV = top.map(item => {
    const ev    = _calcCSEV(item.label, item.prob, odds);
    const tier  = item.prob >= 0.12 ? 'ALTA' : item.prob >= 0.07 ? 'MÉDIA' : 'BAIXA';
    return {
      ...item,
      prob_pct:     `${(item.prob * 100).toFixed(1)}%`,
      ev,
      ev_pct:       ev != null ? `${(ev * 100).toFixed(1)}%` : null,
      is_value:     ev != null ? ev >= MIN_EV_CS : false,
      prob_tier:    tier,
      // Ratio: quanto a probabilidade real supera a implied (>1 = value)
      value_ratio:  ev != null && odds ? _calcValueRatio(item.prob, item.label, odds) : null,
    };
  });

  const valueBets = withEV.filter(s => s.is_value);

  return {
    top_scores:   withEV,
    value_bets:   valueBets,
    best_bet:     valueBets[0] || null,
    total_common_prob: round(flat.filter(s => COMMON_SCORES.has(s.label)).reduce((s, i) => s + i.prob, 0)),
  };
}

// ── Vitória com Margem ────────────────────────────────────────────────────────
function _analyzeVictoryDepth(matrix, matchData, quantAnalysis) {
  const probs = quantAnalysis.probabilities || {};
  const odds  = matchData.odds || {};

  // Distribuição de margem para vitórias da casa
  const homeMargins = { by1: 0, by2: 0, byMore: 0 };
  const awayMargins = { by1: 0, by2: 0, byMore: 0 };

  for (let h = 0; h < MAX_GOALS; h++) {
    for (let a = 0; a < MAX_GOALS; a++) {
      const diff = h - a;
      if (diff === 1) homeMargins.by1   += matrix[h][a];
      if (diff === 2) homeMargins.by2   += matrix[h][a];
      if (diff >= 3)  homeMargins.byMore += matrix[h][a];
      if (diff === -1) awayMargins.by1   += matrix[h][a];
      if (diff === -2) awayMargins.by2   += matrix[h][a];
      if (diff <= -3)  awayMargins.byMore += matrix[h][a];
    }
  }

  // Probabilidade de vitória "confortável" (2+ gols de diferença)
  const homeComfort  = round(homeMargins.by2 + homeMargins.byMore);
  const awayComfort  = round(awayMargins.by2 + awayMargins.byMore);

  // Tendência dominante
  const homeProb = probs.home_win || 0;
  const awayProb = probs.away_win || 0;
  const drawProb = probs.draw     || 0;

  const dominant = homeProb > awayProb + 0.10 ? 'home'
    : awayProb > homeProb + 0.10 ? 'away'
    : 'equilibrio';

  // Identificar o placar mais provável para o vencedor dominante
  let mostLikelyScore = null;
  if (dominant === 'home') {
    const winScores = [];
    for (let h = 1; h < MAX_GOALS; h++) {
      for (let a = 0; a < h; a++) winScores.push({ label: `${h}-${a}`, prob: matrix[h][a] });
    }
    winScores.sort((x, y) => y.prob - x.prob);
    mostLikelyScore = winScores[0]?.label;
  } else if (dominant === 'away') {
    const winScores = [];
    for (let a = 1; a < MAX_GOALS; a++) {
      for (let h = 0; h < a; h++) winScores.push({ label: `${h}-${a}`, prob: matrix[h][a] });
    }
    winScores.sort((x, y) => y.prob - x.prob);
    mostLikelyScore = winScores[0]?.label;
  } else {
    // Em equilíbrio, o placar mais provável geralmente é empate
    const draws = [];
    for (let i = 0; i < MAX_GOALS; i++) draws.push({ label: `${i}-${i}`, prob: matrix[i][i] });
    draws.sort((x, y) => y.prob - x.prob);
    mostLikelyScore = draws[0]?.label;
  }

  return {
    home_win_prob:    round(homeProb),
    draw_prob:        round(drawProb),
    away_win_prob:    round(awayProb),
    dominant,
    most_likely_score: mostLikelyScore,
    home_margins: {
      by_1:    round(homeMargins.by1),
      by_2:    round(homeMargins.by2),
      by_3plus: round(homeMargins.byMore),
      comfort:  homeComfort,
    },
    away_margins: {
      by_1:    round(awayMargins.by1),
      by_2:    round(awayMargins.by2),
      by_3plus: round(awayMargins.byMore),
      comfort:  awayComfort,
    },
    // Nível de confiança: quão "segura" é a previsão de vitória dominante
    win_confidence: dominant !== 'equilibrio'
      ? (dominant === 'home' ? _winConfidence(homeProb, homeComfort) : _winConfidence(awayProb, awayComfort))
      : 'INCERTO',
  };
}

// ── Dupla Chance Calibrada ────────────────────────────────────────────────────
function _analyzeDoubleChance(quantAnalysis, matchData) {
  const probs = quantAnalysis.probabilities || {};
  const odds  = matchData.odds || {};

  const markets = [
    { key: '1X',  label: '1X (Casa ou Empate)', prob: probs.chance_1x || 0 },
    { key: 'X2',  label: 'X2 (Empate ou Fora)', prob: probs.chance_x2 || 0 },
    { key: '12',  label: '12 (Vitória sem Empate)', prob: probs.chance_12 || 0 },
  ];

  const analyzed = markets.map(m => {
    const oddsKey  = _dcOddsKey(m.key);
    const bestOdds = _getBestOdds(odds, oddsKey);
    const ev       = bestOdds != null ? round((m.prob * bestOdds) - 1) : null;
    const qualifies = m.prob >= MIN_PROB_DC && (ev == null || ev >= MIN_EV_DC);

    return {
      market:     m.key,
      label:      m.label,
      prob:       round(m.prob),
      prob_pct:   `${(m.prob * 100).toFixed(1)}%`,
      best_odds:  bestOdds,
      ev,
      ev_pct:     ev != null ? `${(ev * 100).toFixed(1)}%` : null,
      is_value:   ev != null && ev >= MIN_EV_DC,
      qualifies,
      rating:     _dcRating(m.prob, ev),
    };
  });

  const valueBets = analyzed.filter(m => m.is_value);
  const best      = analyzed.sort((a, b) => (b.ev ?? -99) - (a.ev ?? -99))[0];

  return {
    markets:    analyzed,
    value_bets: valueBets,
    best_market: best?.ev != null && best.ev >= MIN_EV_DC ? best : null,
  };
}

// ── Resumo Executivo ──────────────────────────────────────────────────────────
function _buildSummary(exactScores, victoryDepth, doubleChance, pieFactor) {
  const bestCS  = exactScores.best_bet;
  const bestDC  = doubleChance.best_market;
  const dom     = victoryDepth.dominant;
  const topScore = victoryDepth.most_likely_score;

  const lines = [];

  if (bestCS) {
    lines.push(`🎯 CS Value: ${bestCS.label} (${bestCS.prob_pct} real | EV ${bestCS.ev_pct})`);
  } else {
    lines.push(`🎯 CS: ${exactScores.top_scores[0]?.label} mais provável (${exactScores.top_scores[0]?.prob_pct}) — sem EV detectado`);
  }

  if (bestDC) {
    lines.push(`🔀 Dupla Chance: ${bestDC.market} @ ${bestDC.best_odds} (${bestDC.prob_pct} | EV ${bestDC.ev_pct})`);
  }

  lines.push(`⚽ Placar mais provável: ${topScore} | Tendência: ${dom.toUpperCase()}`);

  if (pieFactor !== 0) {
    lines.push(`📊 PIE CS: ${pieFactor > 0 ? '+' : ''}${pieFactor} pts (histórico de acurácia em Placar Exato)`);
  }

  return lines.join('\n');
}

// ── Helpers Matemáticos ───────────────────────────────────────────────────────
function _buildCorrectedMatrix(lh, la) {
  // Poisson base
  const matrix = [];
  for (let h = 0; h < MAX_GOALS; h++) {
    matrix[h] = [];
    for (let a = 0; a < MAX_GOALS; a++) {
      matrix[h][a] = _poisson(h, lh) * _poisson(a, la);
    }
  }

  // Dixon-Coles correction para placares baixos (correlação negativa)
  const lambdaSum = lh + la;
  const rho = lambdaSum < 2.0 ? -0.18 : lambdaSum < 3.0 ? -0.13 : -0.09;

  const corr = (h, a) => {
    if (h === 0 && a === 0) return 1 - lh * la * rho;
    if (h === 0 && a === 1) return 1 + lh * rho;
    if (h === 1 && a === 0) return 1 + la * rho;
    if (h === 1 && a === 1) return 1 - rho;
    return 1;
  };

  for (let h = 0; h <= 1; h++) {
    for (let a = 0; a <= 1; a++) {
      matrix[h][a] = Math.max(0, matrix[h][a] * corr(h, a));
    }
  }

  return matrix;
}

function _poisson(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / _factorial(k);
}

function _factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function round(n) { return Math.round(n * 1000) / 1000; }

// ── Helpers de Odds ───────────────────────────────────────────────────────────
function _getBestOdds(odds, key) {
  if (!odds || !key) return null;
  let best = null;
  for (const [, houseOdds] of Object.entries(odds)) {
    const val = houseOdds?.[key];
    if (val && (best == null || val > best)) best = val;
  }
  return best;
}

function _calcCSEV(scoreLabel, prob, odds) {
  if (!odds) return null;
  // Tentar chaves: "cs_1_0", "cs_2_1" etc. (formato SofaScore/Superbet)
  const normalized = scoreLabel.replace('-', '_');
  const key = `cs_${normalized}`;
  const best = _getBestOdds(odds, key);
  if (!best) return null;
  return round((prob * best) - 1);
}

function _calcValueRatio(prob, scoreLabel, odds) {
  const normalized = scoreLabel.replace('-', '_');
  const key = `cs_${normalized}`;
  const best = _getBestOdds(odds, key);
  if (!best) return null;
  const impliedProb = 1 / best;
  return round(prob / impliedProb);
}

function _dcOddsKey(dcKey) {
  const map = { '1X': 'chance_1x', 'X2': 'chance_x2', '12': 'chance_12' };
  return map[dcKey] || null;
}

function _winConfidence(winProb, comfortProb) {
  if (winProb >= 0.60 && comfortProb >= 0.25) return 'FORTE';
  if (winProb >= 0.50) return 'MODERADA';
  if (winProb >= 0.40) return 'FRACA';
  return 'INCERTO';
}

function _dcRating(prob, ev) {
  if (prob >= 0.75 && ev >= 0.06) return '⭐ PREMIUM';
  if (prob >= 0.65 && ev >= 0.04) return '✅ BOM VALOR';
  if (prob >= 0.55)               return '⚡ CONSIDERAR';
  return '⚠️  ARRISCADO';
}

// ── PIE Factor para Placar Exato ──────────────────────────────────────────────
function _getPIEFactor(marketKey) {
  try {
    const db  = loadDB();
    const cal = db.calibration?.[marketKey];
    if (!cal || cal.total < 10) return 0;
    const accuracy = (cal.hits / cal.total) * 100;
    return Math.max(-8, Math.min(8, Math.round((accuracy - 55) * 0.5)));
  } catch {
    return 0;
  }
}

// ── Resultado vazio (fallback) ────────────────────────────────────────────────
function _emptyResult(matchData) {
  return {
    match:              matchData?.match || 'N/A',
    exact_scores:       { top_scores: [], value_bets: [], best_bet: null, total_common_prob: 0 },
    victory_depth:      { dominant: 'equilibrio', most_likely_score: null, win_confidence: 'INCERTO' },
    double_chance_bets: { markets: [], value_bets: [], best_market: null },
    pie_factor_cs:      0,
    summary:            'Dados insuficientes para análise de placar exato.',
  };
}
