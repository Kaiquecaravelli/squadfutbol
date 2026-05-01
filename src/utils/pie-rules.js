/**
 * pie-rules.js — Motor de Regras do PIE
 *
 * Aplica as regras treinadas pelo deep-training.js às probabilidades
 * calculadas pelo quant.js (Poisson + Dixon-Coles) para aumentar a precisão.
 *
 * ARQUITETURA:
 *   quant.js calcula probabilidades base (Poisson)
 *   pie-rules.js lê as regras do pie.json e aplica ajustes condicionais
 *   O resultado é um objeto "adjusted_probabilities" com melhor calibração
 *
 * SINAIS DISPONÍVEIS NO MOMENTO PRÉ-JOGO:
 *   - league_premium    : competição de alto nível
 *   - league_high_goals : Premier League / Bundesliga
 *   - league_btts_low   : Brasileirão / Serie A (defesas sólidas)
 *   - home_high_form    : mandante com ≥4 vitórias nos últimos 5
 *   - away_high_form    : visitante com ≥4 vitórias nos últimos 5
 *   - home_low_form     : mandante com ≥3 derrotas nos últimos 5
 *   - away_low_form     : visitante com ≥3 derrotas nos últimos 5
 *   - both_high_scoring : lambdas combinados > 3.0
 *   - low_combined_lambda : lambdas combinados < 2.0 (jogo fechado)
 *   - strong_favorite   : lambda_home > lambda_away * 1.8
 *   - away_strong_favorite : lambda_away > lambda_home * 1.5
 *   - h2h_high_scoring  : média H2H > 2.5 gols/jogo
 */

import { loadDB } from '../pie/pie-storage.js';

const PREMIUM_LEAGUES = new Set([
  'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1',
  'Champions League', 'Europa League', 'Brasileirão Betano',
]);
const HIGH_GOALS_LEAGUES = new Set(['Premier League', 'Bundesliga']);
const BTTS_LOW_LEAGUES   = new Set(['Brasileirão Betano', 'Brasileirão Série B']);

// Competições com precisão BTTS historicamente < 20% — BTTS bloqueado nestas ligas
const BTTS_BLOCKED_LEAGUES = new Set([
  'Conference League',
  'UEFA Conference League',
  'UEFA Europa Conference League',
]);

// Peso máximo de ajuste por regra (evita superajuste)
const MAX_SINGLE_ADJUSTMENT = 0.12;
const MAX_TOTAL_ADJUSTMENT  = 0.20;

/**
 * Gera sinais pré-jogo a partir de matchData + quantAnalysis.
 * Estes sinais são os mesmos que o deep-training.js usa para calcular lifts.
 */
export function extractPreMatchSignals(matchData, quantAnalysis) {
  const signals = new Set();
  const comp    = matchData.competition || '';
  const home    = matchData.home || {};
  const away    = matchData.away || {};
  const h2h     = matchData.h2h || [];
  const lh      = quantAnalysis?.lambda_home || 1.3;
  const la      = quantAnalysis?.lambda_away || 1.1;

  // Liga
  if (PREMIUM_LEAGUES.has(comp))       signals.add('league_premium');
  if (HIGH_GOALS_LEAGUES.has(comp))    signals.add('league_high_goals');
  if (BTTS_LOW_LEAGUES.has(comp))      signals.add('league_btts_low');
  if (BTTS_BLOCKED_LEAGUES.has(comp))  signals.add('btts_competition_blocked');

  // Forma do mandante
  const homeForm = (home.form || '').slice(-5);
  const awayForm = (away.form || '').slice(-5);
  const homeWins = homeForm.split('').filter(c => c === 'W').length;
  const awayWins = awayForm.split('').filter(c => c === 'W').length;
  const homeLoss = homeForm.split('').filter(c => c === 'L').length;
  const awayLoss = awayForm.split('').filter(c => c === 'L').length;

  if (homeWins >= 4)  signals.add('home_high_form');
  if (awayWins >= 4)  signals.add('away_high_form');
  if (homeLoss >= 3)  signals.add('home_low_form');
  if (awayLoss >= 3)  signals.add('away_low_form');

  // Lambdas (xG esperado pelo Poisson)
  const combinedLambda = lh + la;
  if (combinedLambda >= 3.2)  signals.add('both_high_scoring');
  if (combinedLambda <= 1.9)  signals.add('low_combined_lambda');
  if (lh > la * 1.8)          signals.add('strong_favorite');
  if (la > lh * 1.5)          signals.add('away_strong_favorite');

  // H2H
  if (h2h.length >= 3) {
    const avgGoals = h2h.slice(0, 5).reduce((sum, m) => {
      return sum + ((m.home_goals ?? 0) + (m.away_goals ?? 0));
    }, 0) / Math.min(h2h.length, 5);
    if (avgGoals > 2.8) signals.add('h2h_high_scoring');
    if (avgGoals < 1.8) signals.add('h2h_low_scoring');
  }

  // Defesas (goals conceded)
  const homeConceded = home.goals_conceded_avg || 1.2;
  const awayConceded = away.goals_conceded_avg || 1.2;
  if (homeConceded < 0.8 && awayConceded < 0.8) signals.add('both_solid_defense');
  if (homeConceded > 1.8 || awayConceded > 1.8) signals.add('porous_defense');

  // Capacidade ofensiva individual (novos sinais para BTTS)
  const homeScored = home.goals_scored_avg || 1.0;
  const awayScored = away.goals_scored_avg || 0.9;
  if (awayScored < 0.8)          signals.add('away_low_scorer');
  if (homeScored < 0.8)          signals.add('home_low_scorer');
  if (awayScored < 0.8 && homeScored < 0.8) signals.add('both_weak_attack');
  // extreme_dominance: só quando AMBOS: ratio alto E time fraco tem ataque baixo
  // Threshold 3.0 (era 2.5) evita falsos positivos tipo "Toluca vs LA Galaxy"
  // onde o visitante (LA Galaxy 1.4 gols/jogo) ainda pode marcar
  if ((lh > la * 3.0 && awayScored < 1.1) || (la > lh * 2.5 && homeScored < 1.1))
    signals.add('extreme_dominance');

  // Forma ofensiva recente (quantas vezes marcou nos últimos 5)
  const homeGoalsForm  = (home.form || '').slice(-5);
  const awayGoalsForm  = (away.form || '').slice(-5);
  const homeRecentWins = homeGoalsForm.split('').filter(c => c === 'W').length;
  const awayRecentLoss = awayGoalsForm.split('').filter(c => c === 'L').length;
  // Visitante perdendo muito → provavelmente não marca
  if (awayRecentLoss >= 4 && awayScored < 1.0) signals.add('away_poor_form_scorer');

  // ── Sinais estruturais derivados de faixas do PIE (2026-04-30) ─────────────
  // Over 3.5: faixa 70-80 = 37.7%, faixa 60-70 = 1.7% → penalidade quando sem contexto
  // Contexto necessário: both_high_scoring (λ ≥ 3.2) E h2h alto
  const over35ContextOk = signals.has('both_high_scoring') && signals.has('h2h_high_scoring');
  if (!over35ContextOk) signals.add('over35_low_context');

  // YC 4.5: máx histórico 50.9% em qualquer faixa/liga → penalidade sempre que não UCL+ambos atacam
  const yc45ContextOk = signals.has('both_high_scoring') &&
    (comp.includes('Champions League') || comp.includes('Europa League'));
  if (!yc45ContextOk) signals.add('yc45_structural_block');

  // X2 (Dupla Chance fora): sem dominância clara do visitante → impreciso
  if (!signals.has('away_strong_favorite') && !signals.has('away_high_form')) {
    signals.add('x2_away_not_dominant');
  }

  return signals;
}

/**
 * Aplica as regras treinadas às probabilidades do Poisson.
 * Retorna probabilidades ajustadas com informação de quais regras foram aplicadas.
 *
 * @param {object} probabilities  — output de analyzeQuantitative().probabilities
 * @param {Set}    preMatchSignals — output de extractPreMatchSignals()
 * @returns {{ adjusted: object, applied_rules: object[], adjustment_log: string[] }}
 */
export function applyPIERules(probabilities, preMatchSignals) {
  let db;
  try { db = loadDB(); } catch { return { adjusted: probabilities, applied_rules: [], adjustment_log: [] }; }

  const rules     = db.rules || [];
  if (!rules.length) return { adjusted: { ...probabilities }, applied_rules: [], adjustment_log: [] };

  // Mapeamento de chave de probabilidade interna → nome de mercado nas regras
  const PROB_TO_MARKET = {
    home_win:          'Home Win',
    draw:              'Draw',
    away_win:          'Away Win',
    chance_1x:         '1X',
    chance_x2:         'X2',
    chance_12:         '12',
    over_1_5:          'Over 1.5',
    over_2_5:          'Over 2.5',
    over_3_5:          'Over 3.5',
    over_4_5:          'Over 4.5',
    btts:              'BTTS',
    over_corners_6_5:  'Over Corners 6.5',
    over_corners_7_5:  'Over Corners 7.5',
    over_corners_8_5:  'Over Corners 8.5',
    over_corners_9_5:  'Over Corners 9.5',
    over_yc_2_5:       'YC 2.5',
    over_yc_3_5:       'YC 3.5',
    over_yc_4_5:       'YC 4.5',
  };

  const adjusted       = { ...probabilities };
  const appliedRules   = [];
  const adjustmentLog  = [];
  // Acumula ajuste total por mercado para não ultrapassar MAX_TOTAL
  const totalAdj       = {};

  for (const rule of rules) {
    // Verificar se sinal está presente nos sinais pré-jogo
    const signalPresent = rule.type === 'pair'
      ? (rule.signals || []).every(s => preMatchSignals.has(s))
      : preMatchSignals.has(rule.signal);

    if (!signalPresent) continue;

    // Mapear mercado → chave de probabilidade
    const probKey = Object.entries(PROB_TO_MARKET)
      .find(([, mkt]) => mkt === rule.market)?.[0];
    if (!probKey || adjusted[probKey] == null) continue;

    // Aplicar ajuste com teto por regra e total por mercado
    const rawAdj   = rule.lift * 0.65; // aplica 65% do lift treinado (regularização)
    const capAdj   = Math.sign(rawAdj) * Math.min(Math.abs(rawAdj), MAX_SINGLE_ADJUSTMENT);
    const alreadyAdj = totalAdj[probKey] || 0;

    // Teto: se já ajustamos o máximo total neste mercado, pular
    if (Math.abs(alreadyAdj) >= MAX_TOTAL_ADJUSTMENT) continue;
    const remaining = MAX_TOTAL_ADJUSTMENT - Math.abs(alreadyAdj);
    const finalAdj  = Math.sign(capAdj) * Math.min(Math.abs(capAdj), remaining);

    if (Math.abs(finalAdj) < 0.01) continue;

    const prevProb = adjusted[probKey];
    adjusted[probKey] = Math.min(0.97, Math.max(0.03, adjusted[probKey] + finalAdj));
    totalAdj[probKey] = (totalAdj[probKey] || 0) + finalAdj;

    appliedRules.push({
      rule_id:   rule.id,
      signal:    rule.signal,
      market:    rule.market,
      prob_key:  probKey,
      lift:      rule.lift,
      adjustment: +finalAdj.toFixed(3),
      before:    +prevProb.toFixed(3),
      after:     +adjusted[probKey].toFixed(3),
    });

    adjustmentLog.push(
      `  ${rule.market}: ${(prevProb*100).toFixed(1)}% → ${(adjusted[probKey]*100).toFixed(1)}%` +
      ` (${rule.signal}, Δ${finalAdj>=0?'+':''}${(finalAdj*100).toFixed(1)}pp)`
    );
  }

  return { adjusted, applied_rules: appliedRules, adjustment_log: adjustmentLog };
}

/**
 * Aplica a correção de calibração Poisson com blending ponderado por amostras.
 *
 * O peso do histórico cresce gradualmente à medida que há mais amostras:
 *   n ≤  5 amostras → w = 0.00 (100% Poisson — dados insuficientes)
 *   n = 27 amostras → w = 0.50 (blend equilibrado)
 *   n = 50+          → w = 0.80 (histórico dominante)
 *
 * Isso evita superajuste com poucos dados e garante que o Poisson nunca seja
 * completamente ignorado (floor 0.20 para o modelo base).
 */
export function applyPoissonCalibration(probabilities, quantAnalysis) {
  let db;
  try { db = loadDB(); } catch { return probabilities; }

  const corrections = db.poisson_corrections || {};
  const adjusted    = { ...probabilities };

  const MARKET_TO_PROB = {
    'Over 1.5': 'over_1_5',
    'Over 2.5': 'over_2_5',
    'Over 3.5': 'over_3_5',
    'BTTS':     'btts',
  };

  for (const [market, probKey] of Object.entries(MARKET_TO_PROB)) {
    const buckets = corrections[market];
    if (!buckets?.length) continue;
    const prob = probabilities[probKey];
    if (prob == null) continue;

    // Encontrar bucket mais próximo
    const closest = buckets.reduce((best, b) =>
      Math.abs(b.predicted_mid - prob) < Math.abs(best.predicted_mid - prob) ? b : best
    , buckets[0]);

    if (!closest || closest.n < 5) continue;

    // Peso dinâmico: cresce de 0 (n=5) até 0.80 (n≥50), nunca ultrapassando 0.80
    // Floor de 0.20 garante que o Poisson sempre contribui para a estimativa final
    const w = Math.min((closest.n - 5) / 45, 0.80);
    const calibrated = prob * (1 - w) + closest.actual_rate * w;
    adjusted[probKey] = Math.min(0.97, Math.max(0.03, +calibrated.toFixed(3)));
  }

  return adjusted;
}

/**
 * Retorna ajustes específicos por liga para exibição no relatório.
 */
export function getLeagueAdjustments(competition) {
  try {
    const db   = loadDB();
    const adj  = db.league_adjustments?.[competition];
    return adj || null;
  } catch {
    return null;
  }
}

/**
 * Função de conveniência: aplica todas as correções em uma única chamada.
 * Integração com quant.js / full-match-analysis.js
 *
 * @param {object} quantResult   — resultado completo de analyzeQuantitative()
 * @param {object} matchData     — dados da partida
 * @returns {{ probabilities: object, rules_applied: number, adjustment_log: string[] }}
 */
export function applyAllPIECorrections(quantResult, matchData) {
  const signals = extractPreMatchSignals(matchData, quantResult);

  // 1. Calibração Poisson (curva de correção)
  const calibratedProbs = applyPoissonCalibration(quantResult.probabilities, quantResult);

  // 2. Regras hardcoded APEX: penalidades/boosters baseados em evidência empírica
  //    (complementam as regras treinadas, garantem cobertura mesmo sem amostras)
  const hardcoded = applyHardcodedRules(calibratedProbs, signals);

  // 3. Regras de sinal treinadas (padrões aprendidos do deep-training)
  const { adjusted, applied_rules, adjustment_log } = applyPIERules(hardcoded.probs, signals);

  return {
    probabilities:  adjusted,
    rules_applied:  applied_rules.length + hardcoded.count,
    adjustment_log: [...hardcoded.log, ...adjustment_log],
    applied_rules,
    pre_match_signals: [...signals],
  };
}

/**
 * Regras hardcoded baseadas em evidência empírica do sistema APEX.
 * São aplicadas ANTES das regras treinadas para garantir calibração base.
 */
function applyHardcodedRules(probabilities, signals) {
  const probs = { ...probabilities };
  const log   = [];
  let count   = 0;

  // ── BTTS: competição com precisão histórica < 20% — bloqueio total ───────────
  // Conference League: apenas 13% de accuracy real → probabilidade rebaixada ao floor
  if (signals.has('btts_competition_blocked')) {
    const before = probs.btts;
    probs.btts = 0.03; // rebaixa ao mínimo absoluto — gate de 55%+ nunca será atingido
    log.push(`  BTTS: ${pctFmt(before)} → ${pctFmt(probs.btts)} (btts_competition_blocked — precisão histórica < 20%)`);
    count++;
    // Retorna imediatamente para esta série — sem empilhar outras penalidades em cima
    return { probs, count, log };
  }

  // ── BTTS: penalidade para atacantes fracos ────────────────────────────────
  if (signals.has('both_weak_attack')) {
    const before = probs.btts;
    probs.btts = Math.max(0.03, probs.btts - 0.18);
    log.push(`  BTTS: ${pctFmt(before)} → ${pctFmt(probs.btts)} (both_weak_attack -18pp)`);
    count++;
  } else if (signals.has('away_low_scorer')) {
    const before = probs.btts;
    probs.btts = Math.max(0.03, probs.btts - 0.12);
    log.push(`  BTTS: ${pctFmt(before)} → ${pctFmt(probs.btts)} (away_low_scorer -12pp)`);
    count++;
  } else if (signals.has('home_low_scorer')) {
    const before = probs.btts;
    probs.btts = Math.max(0.03, probs.btts - 0.10);
    log.push(`  BTTS: ${pctFmt(before)} → ${pctFmt(probs.btts)} (home_low_scorer -10pp)`);
    count++;
  }

  // ── BTTS: dominância extrema → time fraco dificilmente marca ─────────────
  if (signals.has('extreme_dominance')) {
    const before = probs.btts;
    probs.btts = Math.max(0.03, probs.btts - 0.10);
    if (!signals.has('away_low_scorer') && !signals.has('both_weak_attack')) {
      log.push(`  BTTS: ${pctFmt(before)} → ${pctFmt(probs.btts)} (extreme_dominance -10pp)`);
      count++;
    }
  }

  // ── BTTS: visitante em má forma E fraco ataque → muito difícil marcar ─────
  if (signals.has('away_poor_form_scorer')) {
    const before = probs.btts;
    probs.btts = Math.max(0.03, probs.btts - 0.08);
    log.push(`  BTTS: ${pctFmt(before)} → ${pctFmt(probs.btts)} (away_poor_form_scorer -8pp)`);
    count++;
  }

  // ── Over 1.5: jogo fechado + mandante fraco ────────────────────────────────
  if (signals.has('low_combined_lambda') && signals.has('home_low_form')) {
    const before = probs.over_1_5;
    probs.over_1_5 = Math.max(0.03, probs.over_1_5 - 0.10);
    log.push(`  Over1.5: ${pctFmt(before)} → ${pctFmt(probs.over_1_5)} (low_lambda+home_low_form -10pp)`);
    count++;
  }

  // ── H2H low scoring: reduz Over 1.5 ──────────────────────────────────────
  if (signals.has('h2h_low_scoring')) {
    const before = probs.over_1_5;
    probs.over_1_5 = Math.max(0.03, probs.over_1_5 - 0.08);
    log.push(`  Over1.5: ${pctFmt(before)} → ${pctFmt(probs.over_1_5)} (h2h_low_scoring -8pp)`);
    count++;
  }

  // ── Over 3.5: penalidade estrutural quando sem contexto de alta pontuação ──
  // Dados PIE: faixa 70-80 = 37.7%, faixa 60-70 = 1.7% → nunca operar sem contexto forte
  if (signals.has('over35_low_context') && probs.over_3_5 != null) {
    const before = probs.over_3_5;
    probs.over_3_5 = Math.max(0.03, probs.over_3_5 - 0.22);
    log.push(`  Over3.5: ${pctFmt(before)} → ${pctFmt(probs.over_3_5)} (over35_low_context -22pp)`);
    count++;
  }

  // ── YC 4.5: penalidade estrutural — máx 50.9% em qualquer cenário ──────────
  // Exceção: UCL/EL com both_high_scoring (já tratada pelo sinal)
  if (signals.has('yc45_structural_block') && probs.over_yc_4_5 != null) {
    const before = probs.over_yc_4_5;
    probs.over_yc_4_5 = Math.max(0.03, probs.over_yc_4_5 - 0.22);
    log.push(`  YC4.5: ${pctFmt(before)} → ${pctFmt(probs.over_yc_4_5)} (yc45_structural_block -22pp)`);
    count++;
  }

  // ── X2: penalidade quando visitante não demonstra dominância ──────────────
  // Dados PIE: X2 máx 53.1% em qualquer faixa — só é válido com visitante claramente superior
  if (signals.has('x2_away_not_dominant') && probs.chance_x2 != null) {
    const before = probs.chance_x2;
    probs.chance_x2 = Math.max(0.03, probs.chance_x2 - 0.18);
    log.push(`  X2: ${pctFmt(before)} → ${pctFmt(probs.chance_x2)} (x2_away_not_dominant -18pp)`);
    count++;
  }

  // ── Home Win / Away Win / Draw: penalidades estruturais permanentes ────────
  // Precisão histórica: HomeWin=45%, AwayWin=29%, Draw=26% — abaixo do limite operacional
  if (probs.home_win != null) {
    const before = probs.home_win;
    probs.home_win = Math.max(0.03, probs.home_win - 0.20);
    if (before !== probs.home_win) {
      log.push(`  HomeWin: ${pctFmt(before)} → ${pctFmt(probs.home_win)} (home_win_structural -20pp)`);
      count++;
    }
  }
  if (probs.away_win != null) {
    const before = probs.away_win;
    probs.away_win = Math.max(0.03, probs.away_win - 0.30);
    if (before !== probs.away_win) {
      log.push(`  AwayWin: ${pctFmt(before)} → ${pctFmt(probs.away_win)} (away_win_structural -30pp)`);
      count++;
    }
  }
  if (probs.draw != null) {
    const before = probs.draw;
    probs.draw = Math.max(0.03, probs.draw - 0.30);
    if (before !== probs.draw) {
      log.push(`  Draw: ${pctFmt(before)} → ${pctFmt(probs.draw)} (draw_structural -30pp)`);
      count++;
    }
  }

  return { probs, count, log };
}

function pctFmt(val) {
  return val != null ? `${(val * 100).toFixed(1)}%` : '?';
}
