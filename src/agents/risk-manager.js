/**
 * Risk Manager — Gestão de Risco v2.1 APEX
 * Upgrade: stop-loss por sequência de perdas, Kelly adaptativo por streak
 * APEX v2.1: Kelly ajustado por número de pernas de parlay (Melhoria B)
 */

import { loadDB } from '../pie/pie-storage.js';

export function assessRisk({ quantAnalysis, oddsAnalysis, bankroll, dailyExposure = 0, parlay_legs = 1 }) {
  console.log(`🛡️  [Risk Manager] Avaliando risco e calculando stake...`);

  const topBet = quantAnalysis.value_bets?.[0];
  const currentBankroll = parseFloat(bankroll || process.env.USER_BANKROLL || 1000);
  const maxStakePct = parseFloat(process.env.MAX_STAKE_PCT || 5) / 100;
  const method = process.env.STAKING_METHOD || 'kelly';

  // ── Stop-Loss: analisa sequência de resultados recentes no PIE ───────────
  const streakInfo = getLosingStreak();
  const stopLossActive = streakInfo.consecutive_losses >= parseInt(process.env.STOP_LOSS_THRESHOLD || 5);

  if (stopLossActive) {
    return {
      recommendation: 'STOP_LOSS',
      reason: `Stop-Loss ativado: ${streakInfo.consecutive_losses} perdas consecutivas (limite: ${process.env.STOP_LOSS_THRESHOLD || 5})`,
      stake: 0,
      risk_level: 'CRITICAL',
      warnings: [`⛔ STOP-LOSS: ${streakInfo.consecutive_losses} apostas seguidas perdidas — pausa recomendada`],
      streak: streakInfo,
    };
  }

  // ── Kelly dinâmico: acurácia PIE do mercado ───────────────────────────────
  let kellyFraction = parseFloat(process.env.KELLY_FRACTION || 0.25);
  let kellySource   = 'env';

  try {
    const db = loadDB();
    const cal = db.calibration?.[topBet?.market];
    if (cal && cal.total >= 20) {
      const accuracy = (cal.hits / cal.total) * 100;
      if      (accuracy >= 85) { kellyFraction = 0.30; kellySource = `PIE ${accuracy.toFixed(1)}%`; }
      else if (accuracy >= 75) { kellyFraction = 0.25; kellySource = `PIE ${accuracy.toFixed(1)}%`; }
      else if (accuracy <  70) { kellyFraction = 0.20; kellySource = `PIE ${accuracy.toFixed(1)}%`; }
    }
  } catch { /* usa env fallback */ }

  // ── Ajuste por sequência de perdas (streak penalty) ───────────────────────
  // 3+ perdas seguidas: -20% no Kelly; 4+: -40%
  let streakPenalty = 0;
  if (streakInfo.consecutive_losses >= 4) {
    kellyFraction = Math.max(0.10, kellyFraction * 0.60);
    streakPenalty = 40;
    kellySource += ` | streak-4 (-40%)`;
  } else if (streakInfo.consecutive_losses >= 3) {
    kellyFraction = Math.max(0.12, kellyFraction * 0.80);
    streakPenalty = 20;
    kellySource += ` | streak-3 (-20%)`;
  }

  if (!topBet) {
    return {
      recommendation: 'NO_BET',
      reason: 'Nenhum value bet identificado (EV insuficiente)',
      stake:      0,
      risk_level: 'NONE',
      warnings:   [],
      streak:     streakInfo,
    };
  }

  const { ev, odds, market, house } = topBet;
  const prob = topBet.true_prob;

  // ── Kelly Criterion ───────────────────────────────────────────────────────
  const b = odds - 1;
  const kellyFull  = Math.max(0, (b * prob - (1 - prob)) / b);

  // ── Melhoria B: Kelly ajustado por número de pernas (APEX v2.1) ──────────
  // Parlay com mais pernas tem variância exponencialmente maior, exigindo
  // stake menor para preservar a banca em sequências adversas.
  // 1 perna: ×1.00 | 2: ×0.90 | 5: ×0.75 | 8: ×0.60 | 10: ×0.50
  const legCountMultiplier = parlay_legs > 1
    ? Math.max(0.50, 1 - parlay_legs / 20)
    : 1.00;
  const kellyStake = currentBankroll * kellyFull * kellyFraction * legCountMultiplier;

  // ── Flat staking ──────────────────────────────────────────────────────────
  const flatStake = currentBankroll * 0.02;

  let recommendedStake;
  if (method === 'flat' || ev < 0.07) {
    recommendedStake = flatStake;
  } else {
    recommendedStake = Math.min(kellyStake, currentBankroll * maxStakePct);
  }

  // Redução adicional por streak se ainda não aplicada no Kelly
  if (streakPenalty > 0) {
    recommendedStake = Math.max(flatStake * 0.5, recommendedStake * (1 - streakPenalty / 100));
  }

  recommendedStake = Math.round(recommendedStake * 100) / 100;

  // ── Warnings ──────────────────────────────────────────────────────────────
  const warnings = [];
  const maxDailyExposure = currentBankroll * 0.10;

  if (dailyExposure + recommendedStake > maxDailyExposure)
    warnings.push(`Exposição diária próxima do limite (${pct(dailyExposure + recommendedStake, currentBankroll)}% da banca)`);

  if (ev < 0.05)
    warnings.push('EV abaixo do threshold mínimo (5%)');

  if (streakInfo.consecutive_losses >= 3)
    warnings.push(`Sequência de ${streakInfo.consecutive_losses} perdas consecutivas — stake reduzida ${streakPenalty}%`);

  const riskLevel = ev >= 0.12 ? 'LOW' : ev >= 0.07 ? 'MEDIUM' : 'HIGH';
  const proceed   = warnings.filter((w) => !w.includes('Sequência')).length === 0
                    && ev >= parseFloat(process.env.MIN_EV_THRESHOLD || 0.05);

  return {
    recommendation:        proceed ? 'PROCEED' : 'CAUTION',
    market,
    house,
    odds,
    ev,
    bankroll:              currentBankroll,
    stake:                 recommendedStake,
    stake_pct:             pct(recommendedStake, currentBankroll),
    kelly_full:            Math.round(kellyFull * 1000) / 1000,
    kelly_fractional:      Math.round(kellyFull * kellyFraction * legCountMultiplier * 1000) / 1000,
    kelly_source:          kellySource,
    kelly_leg_multiplier:  Math.round(legCountMultiplier * 100),   // ex: 75 = ×0.75
    parlay_legs,
    max_exposure_today:    Math.round(maxDailyExposure * 100) / 100,
    current_exposure_today: dailyExposure,
    risk_level:            riskLevel,
    warnings,
    method_used:           method,
    streak:                streakInfo,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lê sequência de perdas recentes do PIE
// Retorna { consecutive_losses, recent_results, total_recent }
// ─────────────────────────────────────────────────────────────────────────────
function getLosingStreak() {
  try {
    const db = loadDB();
    // results contém entradas { prediction_id, result, market, timestamp }
    const results = (db.results || [])
      .filter((r) => r.result === 'hit' || r.result === 'miss')
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
      .slice(0, 20);  // últimas 20 apostas resolvidas

    let consecutive = 0;
    for (const r of results) {
      if (r.result === 'miss') consecutive++;
      else break;  // primeira vitória interrompe a sequência
    }

    const recentResults = results.slice(0, 10).map((r) => r.result === 'hit' ? 'W' : 'L');

    return {
      consecutive_losses: consecutive,
      recent_results:     recentResults.join(''),
      total_recent:       results.length,
    };
  } catch {
    return { consecutive_losses: 0, recent_results: '', total_recent: 0 };
  }
}

function pct(value, total) {
  return Math.round((value / total) * 1000) / 10;
}
