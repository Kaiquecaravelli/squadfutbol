/**
 * Tactician — Agente de Análise Tática v2.0 APEX
 * Upgrade: xG integrado do quant, sinais de lesões via newsAnalysis, H2H profundo
 */

export function analyzeTactical(matchData, { quantAnalysis = null, newsAnalysis = null } = {}) {
  console.log(`♟️  [Tactician] Analisando aspectos táticos...`);

  const { home, away, h2h } = matchData;

  // xG reais do modelo Poisson (lambdas calibrados pelo PIE)
  const xgHome = quantAnalysis?.lambda_home ?? home?.xg_avg ?? 1.3;
  const xgAway = quantAnalysis?.lambda_away ?? away?.xg_avg ?? 1.0;

  const injurySignals = detectInjurySignals(newsAnalysis, home?.team, away?.team);

  const homeScore = calcTeamScore(home, true,  xgHome, injurySignals.home_penalty);
  const awayScore = calcTeamScore(away, false, xgAway, injurySignals.away_penalty);

  const h2hAnalysis = analyzeH2H(h2h, home?.team, away?.team);
  const keyFactors  = buildKeyFactors(home, away, h2hAnalysis, xgHome, xgAway);
  const riskFlags   = detectRiskFlags(home, away, matchData, injurySignals);

  const tacticalEdge = homeScore > awayScore + 10
    ? 'home'
    : awayScore > homeScore + 10
    ? 'away'
    : 'neutral';

  return {
    match:          matchData.match,
    tactical_edge:  tacticalEdge,
    home_score:     homeScore,
    away_score:     awayScore,
    xg_home:        Math.round(xgHome * 100) / 100,
    xg_away:        Math.round(xgAway * 100) / 100,
    h2h:            h2hAnalysis,
    key_factors:    keyFactors,
    risk_flags:     riskFlags,
    injury_signals: injurySignals,
    predicted_style: predictStyle(home, away, xgHome, xgAway),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Score tático por time — xG do quant tem peso 40%
// ─────────────────────────────────────────────────────────────────────────────
function calcTeamScore(team, isHome, xg, injuryPenalty = 0) {
  let score = 50;

  // Forma recente (últimos 5)
  const form = team?.form || 'N/A';
  for (const ch of form.slice(-5)) {
    if (ch === 'W') score += 8;
    else if (ch === 'D') score += 2;
    else if (ch === 'L') score -= 6;
  }

  // xG do modelo Poisson (calibrado PIE) — peso 40%
  // xg = 1.3 é média global; >1.5 = ataque forte, <0.9 = fraco
  if (xg >= 2.0)       score += 18;
  else if (xg >= 1.5)  score += 12;
  else if (xg >= 1.2)  score += 5;
  else if (xg < 0.9)   score -= 8;
  else if (xg < 0.7)   score -= 14;

  // Média de gols sofridos (fragilidade defensiva)
  const conceded = team?.goals_conceded_avg || 1.2;
  if (conceded > 2.0)  score -= 10;
  else if (conceded > 1.5) score -= 4;
  else if (conceded < 0.8) score += 6;

  // Vantagem de casa
  if (isHome) score += 8;

  // Penalidade por lesões/suspensões detectadas
  score -= injuryPenalty;

  return Math.min(100, Math.max(0, Math.round(score)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Detecção de sinais de lesões via headlines de newsAnalysis
// ─────────────────────────────────────────────────────────────────────────────
function detectInjurySignals(newsAnalysis, homeTeam, awayTeam) {
  const INJURY_KEYWORDS = ['lesão', 'lesionado', 'contundido', 'desfalque', 'suspens', 'injury', 'injured', 'doubt', 'absent'];
  const CRITICAL_ROLES  = ['goleiro', 'atacante', 'artilheiro', 'capitão', 'goalkeeper', 'striker', 'captain'];

  const signals = {
    home_penalty:   0,
    away_penalty:   0,
    home_injuries:  [],
    away_injuries:  [],
  };

  if (!newsAnalysis) return signals;

  for (const side of ['home', 'away']) {
    const news = newsAnalysis[side];
    if (!news) continue;

    const headlines = [...(news.key_headlines || []), ...(news.injuries || [])];
    let penalty = 0;
    const found = [];

    for (const item of headlines) {
      const text = (item?.title || item?.text || item || '').toLowerCase();
      const hasInjury = INJURY_KEYWORDS.some((kw) => text.includes(kw));
      if (!hasInjury) continue;

      const isCritical = CRITICAL_ROLES.some((r) => text.includes(r));
      penalty += isCritical ? 6 : 3;
      found.push(text.slice(0, 70));
    }

    signals[`${side}_penalty`]   = Math.min(penalty, 15);
    signals[`${side}_injuries`]  = found.slice(0, 3);
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// H2H profundo: média de gols, tendência de BTTS, últimos 5 confrontos
// ─────────────────────────────────────────────────────────────────────────────
function analyzeH2H(matches, homeTeam, awayTeam) {
  if (!matches?.length) {
    return { home_wins: 0, draws: 0, away_wins: 0, total: 0, recent_winner: 'N/A', avg_goals: null, btts_pct: null };
  }

  const stats = { home_wins: 0, draws: 0, away_wins: 0 };
  let totalGoals = 0;
  let bttsCount  = 0;
  const recent   = matches.slice(0, 5);

  for (const m of matches) {
    if (m.winner === homeTeam) stats.home_wins++;
    else if (m.winner === 'Draw') stats.draws++;
    else stats.away_wins++;

    if (m.home_goals != null && m.away_goals != null) {
      totalGoals += m.home_goals + m.away_goals;
      if (m.home_goals > 0 && m.away_goals > 0) bttsCount++;
    }
  }

  const avgGoals = totalGoals > 0 ? Math.round((totalGoals / matches.length) * 10) / 10 : null;
  const bttsPct  = matches.length > 0 ? Math.round((bttsCount / matches.length) * 100) : null;

  // Sequência recente (ex: "HWWDH")
  const recentSequence = recent.map((m) => {
    if (m.winner === homeTeam) return 'H';
    if (m.winner === 'Draw')   return 'D';
    return 'A';
  }).join('');

  return {
    ...stats,
    total:           matches.length,
    recent_winner:   matches[0]?.winner || 'N/A',
    recent_score:    matches[0]?.score  || 'N/A',
    avg_goals:       avgGoals,
    btts_pct:        bttsPct,
    recent_sequence: recentSequence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fatores táticos chave — inclui xG e H2H profundo
// ─────────────────────────────────────────────────────────────────────────────
function buildKeyFactors(home, away, h2h, xgHome, xgAway) {
  const factors = [];

  // xG do modelo como principal fator
  if (xgHome > 1.8)
    factors.push(`xG esperado alto para ${home?.team}: ${xgHome.toFixed(2)} gols (modelo Poisson/PIE)`);
  if (xgAway < 0.8)
    factors.push(`${away?.team} com capacidade ofensiva limitada (xG ${xgAway.toFixed(2)})`);

  // Diferencial gols marcados × sofridos
  if ((home?.goals_scored_avg || 0) > (away?.goals_conceded_avg || 1.2) + 0.5)
    factors.push(`${home?.team} cria mais do que ${away?.team} sofre (${home.goals_scored_avg} vs ${away.goals_conceded_avg} gols/jogo)`);

  if ((away?.goals_scored_avg || 0) < 0.8)
    factors.push(`${away?.team} com ataque fraco (${(away?.goals_scored_avg || 0)} gols/jogo)`);

  const homeFormWins = (home?.form?.split('').filter((c) => c === 'W').length) || 0;
  if (homeFormWins >= 4) factors.push(`${home?.team} em grande fase: ${homeFormWins}V nos últimos 5`);

  if (h2h.total >= 3) {
    if (h2h.home_wins > h2h.away_wins + 1)
      factors.push(`H2H favorece ${home?.team}: ${h2h.home_wins}V ${h2h.draws}E ${h2h.away_wins}D${h2h.avg_goals ? ` | Média ${h2h.avg_goals} gols` : ''}`);
    else if (h2h.away_wins > h2h.home_wins + 1)
      factors.push(`H2H favorece ${away?.team}: ${h2h.away_wins}V ${h2h.draws}E ${h2h.home_wins}D${h2h.avg_goals ? ` | Média ${h2h.avg_goals} gols` : ''}`);
    else if (h2h.draws >= 2)
      factors.push(`H2H histórico equilibrado (${h2h.draws} empates em ${h2h.total} jogos)${h2h.avg_goals ? ` | Média ${h2h.avg_goals} gols` : ''}`);
  }

  if (h2h.btts_pct != null && h2h.btts_pct >= 70)
    factors.push(`BTTS em ${h2h.btts_pct}% dos H2H — padrão histórico de ambas marcando`);

  if (!factors.length) factors.push('Equipes equilibradas — sem vantagem tática clara.');

  return factors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk flags — inclui sinais de lesão e clima
// ─────────────────────────────────────────────────────────────────────────────
function detectRiskFlags(home, away, matchData, injurySignals) {
  const flags = [];

  if (matchData.weather?.wind_kmh > 40)
    flags.push(`Vento forte (${matchData.weather.wind_kmh} km/h) pode dificultar jogo aéreo`);

  if (matchData.weather?.condition?.includes('rain'))
    flags.push('Chuva prevista — pode reduzir ritmo e aumentar erros');

  const awayLosses = (away?.form?.split('').filter((c) => c === 'L').length) || 0;
  if (awayLosses >= 4) flags.push(`${away?.team} em má fase (${awayLosses} derrotas nos últimos 5)`);

  if (injurySignals.home_penalty >= 6)
    flags.push(`Desfalques importantes em ${home?.team} detectados nas notícias (-${injurySignals.home_penalty} pts)`);
  if (injurySignals.away_penalty >= 6)
    flags.push(`Desfalques importantes em ${away?.team} detectados nas notícias (-${injurySignals.away_penalty} pts)`);

  return flags;
}

// ─────────────────────────────────────────────────────────────────────────────
// Previsão de estilo de jogo — usa xG do modelo
// ─────────────────────────────────────────────────────────────────────────────
function predictStyle(home, away, xgHome, xgAway) {
  const combinedXg = xgHome + xgAway;
  const awayDefensive = (away?.goals_conceded_avg || 1.2) < 1.0;

  if (combinedXg >= 3.0)
    return `Jogo muito aberto esperado (xG combinado ${combinedXg.toFixed(2)}) — alto potencial de gols.`;
  if (xgHome >= 1.8 && awayDefensive)
    return `${home?.team} deve dominar — ${away?.team} tende a se fechar e buscar contra-ataques.`;
  if (xgHome >= 1.5)
    return `Jogo aberto esperado — ambos os times tendem a criar oportunidades.`;
  if (combinedXg < 2.0)
    return `Jogo disputado e fechado esperado (xG combinado ${combinedXg.toFixed(2)}) — resultado apertado.`;
  return `Jogo equilibrado, resultado em disputa até o fim.`;
}
