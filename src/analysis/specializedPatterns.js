/**
 * specializedPatterns.js — 5 Padrões Especializados de Identificação
 *
 * Cada padrão recebe (matchData, deepResult) e retorna:
 *   { nome, ativo, confianca, descricao } | null
 *
 * P1 Brace Pattern    — time em sequência de 2+ gols por jogo (4 últimas partidas)
 * P2 Under Lock       — total λ < 1.8 + sequência Under nas últimas 4 partidas
 * P3 Corner Pressure  — xG alto + histórico de escanteios ≥ 9 por jogo
 * P4 Dual Streak      — ambos os times em sequência positiva simultânea
 * P5 Fade the Public  — odds artificialmente baixas → EV invertido (value no Under)
 */

// ── P1 — Brace Pattern ────────────────────────────────────────────────────────
function _bracePattern(matchData, deepResult) {
  const home = matchData?.home;
  const away = matchData?.away;

  const hGoals = home?.goals_scored_avg ?? null;
  const aGoals = away?.goals_scored_avg ?? null;

  if (hGoals === null && aGoals === null) return null;

  // Time marca 2+ gols/jogo em média
  const hBrace = hGoals != null && hGoals >= 2.0;
  const aBrace = aGoals != null && aGoals >= 2.0;

  if (!hBrace && !aBrace) return null;

  const times = [hBrace && home?.team, aBrace && away?.team].filter(Boolean);
  const confianca = Math.round(Math.min(
    ((hBrace ? hGoals : 0) + (aBrace ? aGoals : 0)) / 4 * 100, 95
  ));

  return {
    nome:      'Brace Pattern',
    ativo:     true,
    confianca,
    descricao: `${times.join(' e ')} marcam 2+ gols/jogo (média recente)`,
  };
}

// ── P2 — Under Lock ───────────────────────────────────────────────────────────
function _underLock(matchData, deepResult) {
  const d6 = deepResult?.dimensoes?.d6_pressao_xg;
  if (!d6 || d6.flag === 'SEM_DADO') return null;

  const lambda = d6.lambda ?? null;
  if (lambda === null || lambda >= 1.8) return null;

  const d7 = deepResult?.dimensoes?.d7_sequencia_gols;
  const streak = d7?.streak ?? null;

  // Precisa de λ baixo E streak Under (negativo)
  if (streak !== null && streak >= 0) return null;

  const confianca = Math.round(Math.min(80 + (1.8 - lambda) * 20, 95));
  return {
    nome:      'Under Lock',
    ativo:     true,
    confianca,
    descricao: `λ total ${lambda} (< 1.8) ${streak != null ? `· streak Under ${streak}` : ''}`,
  };
}

// ── P3 — Corner Pressure ──────────────────────────────────────────────────────
function _cornerPressure(matchData, _deepResult) {
  const home = matchData?.home;
  const away = matchData?.away;

  const hXg   = home?.xg_avg             ?? null;
  const aXg   = away?.xg_avg             ?? null;
  const hCorn = home?.corners_avg        ?? null;
  const aCorn = away?.corners_avg        ?? null;

  const lambdaXg = (hXg ?? 0) + (aXg ?? 0);
  const cornAvg  = ((hCorn ?? 0) + (aCorn ?? 0));

  // xG alto (≥ 2.2) OU média escanteios ≥ 9
  if (lambdaXg < 2.2 && cornAvg < 9) return null;

  const confianca = Math.round(Math.min(
    60 + (lambdaXg - 2.0) * 10 + Math.max(0, cornAvg - 9) * 5, 92
  ));

  return {
    nome:      'Corner Pressure',
    ativo:     true,
    confianca,
    descricao: `λ xG ${lambdaXg.toFixed(1)} · Avg escanteios ${cornAvg.toFixed(1)}/jogo`,
  };
}

// ── P4 — Dual Streak ─────────────────────────────────────────────────────────
function _dualStreak(matchData, _deepResult) {
  const home = matchData?.home;
  const away = matchData?.away;

  // Proxy para "sequência positiva": goals_scored_avg > goals_conceded_avg
  const hAtk  = home?.goals_scored_avg    ?? null;
  const hConc = home?.goals_conceded_avg  ?? null;
  const aAtk  = away?.goals_scored_avg    ?? null;
  const aConc = away?.goals_conceded_avg  ?? null;

  if (hAtk === null || aAtk === null) return null;

  const hPos = hConc != null ? hAtk > hConc : hAtk >= 1.5;
  const aPos = aConc != null ? aAtk > aConc : aAtk >= 1.2;

  if (!hPos || !aPos) return null;

  const confianca = Math.round(Math.min(65 + (hAtk + aAtk) * 5, 90));
  return {
    nome:      'Dual Streak',
    ativo:     true,
    confianca,
    descricao: `Ambos em forma atacante: ${home?.team} ${hAtk?.toFixed(1)}g/j · ${away?.team} ${aAtk?.toFixed(1)}g/j`,
  };
}

// ── P5 — Fade the Public ──────────────────────────────────────────────────────
function _fadeThePublic(matchData, deepResult) {
  const d8 = deepResult?.dimensoes?.d8_movimento_odds;
  if (!d8 || d8.flag === 'SEM_DADO') return null;

  const ev = d8.ev ?? null;
  if (ev === null) return null;

  // Odds artificialmente baixas no Over → EV negativo → value no Under
  // Detectado quando EV < -8% (book comprimiu odds demais para mercado popular)
  if (ev > -8) return null;

  const confianca = Math.round(Math.min(55 + Math.abs(ev) * 2, 88));
  return {
    nome:      'Fade the Public',
    ativo:     true,
    confianca,
    descricao: `EV ${ev}% detectado — odds do mercado popular comprimidas → value invertido`,
  };
}

// ── Executor principal ────────────────────────────────────────────────────────

/**
 * detectPatterns — roda os 5 padrões e retorna apenas os ativos.
 *
 * @param {object} matchData   — matchData completo (com home/away/quant)
 * @param {object} deepResult  — resultado do runDeepAnalysis()
 * @returns {Array<object>}    — lista de padrões ativos com confianca e descricao
 */
export function detectPatterns(matchData, deepResult) {
  const runners = [
    _bracePattern,
    _underLock,
    _cornerPressure,
    _dualStreak,
    _fadeThePublic,
  ];

  return runners
    .map(fn => {
      try { return fn(matchData, deepResult); }
      catch { return null; }
    })
    .filter(p => p?.ativo);
}

/**
 * formatPatternsAdmin — texto HTML para DM do admin.
 */
export function formatPatternsAdmin(patterns) {
  if (!patterns?.length) return '📊 Nenhum padrão especializado detectado.';

  const linhas = [`🧩 <b>Padrões Especializados (${patterns.length})</b>`, ``];
  for (const p of patterns) {
    linhas.push(`• <b>${p.nome}</b> · <code>${p.confianca}%</code>`);
    linhas.push(`  <i>${p.descricao}</i>`);
  }
  return linhas.join('\n');
}
