/**
 * match-analyzer.js
 * Motor de análise automática de partidas para o PIE.
 * Gera sinais, mercados e diretivas a partir de dados estruturados.
 */

// ── Detecção de Sinais ────────────────────────────────────────────────────────
export function detectSignals(match) {
  const s  = match.match_stats || {};
  const r  = match.result || {};
  const tl = match.goals_timeline || [];
  const ht = match.ht_score || null;
  const pm = match.pre_match || {};
  const ph = pm.home || {};
  const pa = pm.away || {};
  const h2h = pm.h2h || {};
  const signals = [];

  const totalGoals   = (r.home_goals || 0) + (r.away_goals || 0);
  const totalShots   = (s.shots_home || 0) + (s.shots_away || 0);
  const totalCorners = s.corners_total ?? ((s.corners_home || 0) + (s.corners_away || 0));
  const totalYC      = (s.yellow_cards_home || 0) + (s.yellow_cards_away || 0);
  const totalRC      = (s.red_cards_home || 0) + (s.red_cards_away || 0);

  // Posse
  if (s.possession_home >= 58) signals.push('home_possession_dominant');
  if (s.possession_away >= 58) signals.push('away_possession_dominant');
  if (s.possession_home && Math.abs(s.possession_home - s.possession_away) <= 8) signals.push('possession_balanced');

  // Chutes
  if (s.shots_home && s.shots_away) {
    if (s.shots_home >= s.shots_away * 2) signals.push('home_shot_dominant');
    if (s.shots_away >= s.shots_home * 2) signals.push('away_shot_dominant');
  }
  if (s.shots_home >= 15) signals.push('home_high_volume_shots');
  if (s.shots_away >= 15) signals.push('away_high_volume_shots');
  if (totalShots >= 25) signals.push('combined_shots_very_high');
  else if (totalShots >= 20) signals.push('combined_shots_high');

  // Visitante ultra-defensivo
  if ((s.shots_away || 99) <= 5 && (s.corners_away || 99) <= 2) signals.push('visitor_ultra_defensive');
  if ((s.shots_home || 99) <= 5 && (s.corners_home || 99) <= 2) signals.push('home_ultra_defensive');

  // Escanteios
  if (totalCorners >= 14) signals.push('corners_very_high');
  else if (totalCorners >= 10) signals.push('corners_high');

  const cornerDiff = Math.abs((s.corners_home || 0) - (s.corners_away || 0));
  if (cornerDiff >= 8) signals.push('corners_asymmetry_extreme');
  else if (cornerDiff >= 5) signals.push('corners_asymmetry_high');

  // Cartões
  if (totalYC >= 8) signals.push('yc_extreme');
  else if (totalYC >= 5) signals.push('yc_high');
  else if (totalYC >= 3) signals.push('yc_moderate');

  // Expulsões
  if (totalRC >= 2) signals.push('multiple_red_cards');
  else if (totalRC === 1) signals.push('one_red_card');

  // Timeline de gols
  if (tl.length > 0) {
    const firstGoal = tl[0];
    const min = typeof firstGoal.minute === 'number' ? firstGoal.minute : parseInt(firstGoal.minute) || 99;
    if (min <= 10) {
      signals.push(firstGoal.team === 'home' ? 'early_goal_home' : 'early_goal_away');
    } else if (min <= 20) {
      signals.push(firstGoal.team === 'home' ? 'early_goal_home_20' : 'early_goal_away_20');
    }
  }

  if (tl.some(g => {
    const min = typeof g.minute === 'number' ? g.minute : parseInt(g.minute) || 0;
    return min >= 85;
  })) signals.push('late_goal_85plus');

  // Forma do resultado
  if ((r.home_goals || 0) === 0) signals.push('home_shutout');
  if ((r.away_goals || 0) === 0) signals.push('away_shutout');
  if (r.home_goals === r.away_goals) signals.push('draw');
  if (Math.abs((r.home_goals || 0) - (r.away_goals || 0)) >= 3) signals.push('big_margin_win');

  // HT vs FT
  if (ht) {
    const htWinner = ht.home > ht.away ? 'home' : ht.away > ht.home ? 'away' : 'draw';
    const ftWinner = r.home_goals > r.away_goals ? 'home' : r.away_goals > r.home_goals ? 'away' : 'draw';
    if (htWinner !== ftWinner) signals.push('result_changed_second_half');
    if (ht.home === 0 && ht.away === 0) signals.push('goalless_first_half');
  }

  // ── Sinais de pré-jogo (quando dados disponíveis) ─────────────────────────
  // Média de gols combinada
  if (ph.goals_scored_avg && pa.goals_scored_avg) {
    const avg = (ph.goals_scored_avg || 0) + (pa.goals_scored_avg || 0);
    if (avg >= 3.0) signals.push('high_scoring_fixture');
    else if (avg <= 1.5) signals.push('low_scoring_fixture');
  }

  // xG combinado
  if (ph.xg_for_avg && pa.xg_for_avg) {
    const xg = (ph.xg_for_avg || 0) + (pa.xg_for_avg || 0);
    if (xg >= 3.0) signals.push('high_xg_combined');
    else if (xg <= 1.6) signals.push('low_xg_combined');
  }

  // Forma recente
  if (Array.isArray(ph.form_last5)) {
    const w = ph.form_last5.filter(r => r === 'W').length;
    if (w >= 4) signals.push('home_in_form');
    else if (w <= 1) signals.push('home_out_of_form');
  }
  if (Array.isArray(pa.form_last5)) {
    const w = pa.form_last5.filter(r => r === 'W').length;
    if (w >= 4) signals.push('away_in_form');
    else if (w <= 1) signals.push('away_out_of_form');
  }

  // Gap de qualidade (diferença de posição >= 10)
  if (ph.position && pa.position) {
    if (Math.abs(ph.position - pa.position) >= 10) signals.push('big_quality_gap');
  }

  // Pressão do rebaixamento
  if (ph.status === 'relegation_zone') signals.push('home_relegation_pressure');
  if (pa.status === 'relegation_zone') signals.push('away_relegation_pressure');

  // H2H — visitante domina
  if ((h2h.last5_away_wins || 0) >= 4) signals.push('away_h2h_dominant');

  // Média de escanteios do visitante (proxy de posse ofensiva fora)
  if (pa.corners_avg && pa.corners_avg >= 5.5) signals.push('away_high_corners_avg');

  return signals;
}

// ── Frases descritivas de sinais ──────────────────────────────────────────────
function signalPhrases(signals, s) {
  const phrases = [];
  if (signals.includes('home_possession_dominant'))
    phrases.push(`mandante dominou posse (${s.possession_home || '?'}%)`);
  if (signals.includes('away_possession_dominant'))
    phrases.push(`visitante dominou posse (${s.possession_away || '?'}%)`);
  if (signals.includes('home_shot_dominant'))
    phrases.push(`mandante dominou chutes (${s.shots_home} vs ${s.shots_away})`);
  if (signals.includes('away_shot_dominant'))
    phrases.push(`visitante dominou chutes (${s.shots_away} vs ${s.shots_home})`);
  if (signals.includes('combined_shots_very_high'))
    phrases.push(`volume muito alto de chutes (${(s.shots_home || 0) + (s.shots_away || 0)} combinados)`);
  if (signals.includes('combined_shots_high'))
    phrases.push(`alto volume de chutes (${(s.shots_home || 0) + (s.shots_away || 0)} combinados)`);
  if (signals.includes('early_goal_home') || signals.includes('early_goal_home_20'))
    phrases.push('gol precoce do mandante abriu o jogo');
  if (signals.includes('early_goal_away') || signals.includes('early_goal_away_20'))
    phrases.push('gol precoce do visitante forcou o mandante a atacar');
  if (signals.includes('late_goal_85plus'))
    phrases.push('gol tardio (min85+) selou o resultado');
  if (signals.includes('visitor_ultra_defensive'))
    phrases.push(`visitante ultra-defensivo (${s.shots_away || 0} chutes, ${s.corners_away || 0} escanteios)`);
  if (signals.includes('corners_asymmetry_extreme'))
    phrases.push(`assimetria extrema de escanteios (${s.corners_home || 0}H vs ${s.corners_away || 0}A)`);
  if (signals.includes('result_changed_second_half'))
    phrases.push('resultado mudou no 2 tempo');
  if (signals.includes('one_red_card') || signals.includes('multiple_red_cards'))
    phrases.push('expulsao ampliou espacos no campo');
  if (signals.includes('goalless_first_half'))
    phrases.push('1 tempo sem gols — jogo abriu no 2 tempo');
  // Pre-match context phrases
  if (signals.includes('high_scoring_fixture'))
    phrases.push(`confronto de alto volume gols (média combinada ≥3.0/jogo)`);
  if (signals.includes('high_xg_combined'))
    phrases.push(`xG combinado alto (≥3.0 esperado)`);
  if (signals.includes('home_in_form'))
    phrases.push('mandante em grande forma (4+ vitórias em 5)');
  if (signals.includes('away_in_form'))
    phrases.push('visitante em grande forma (4+ vitórias em 5)');
  if (signals.includes('home_out_of_form'))
    phrases.push('mandante em má fase (≤1 vitória em 5)');
  if (signals.includes('away_h2h_dominant'))
    phrases.push('visitante domina H2H (4+ vitórias recentes neste confronto)');
  if (signals.includes('big_quality_gap'))
    phrases.push('grande diferença de qualidade entre as equipes (gap ≥10 posições)');
  if (signals.includes('home_relegation_pressure') || signals.includes('away_relegation_pressure'))
    phrases.push('time(s) em zona de rebaixamento — motivação extra em campo');
  return phrases;
}

// ── Geração de Diretivas ──────────────────────────────────────────────────────
export function generateDirective(marketKey, won, match, signals) {
  const r = match.result || {};
  const s = match.match_stats || {};
  const comp  = match.competition || 'desconhecida';
  const home  = match.pre_match?.home?.team ?? (match.match || '').split(' vs ')[0] ?? 'Mandante';
  const away  = match.pre_match?.away?.team ?? (match.match || '').split(' vs ')[1] ?? 'Visitante';
  const score = r.placar ?? `${r.home_goals || 0}-${r.away_goals || 0}`;

  const totalGoals   = (r.home_goals || 0) + (r.away_goals || 0);
  const totalShots   = (s.shots_home || 0) + (s.shots_away || 0);
  const totalCorners = s.corners_total ?? ((s.corners_home || 0) + (s.corners_away || 0));
  const totalYC      = (s.yellow_cards_home || 0) + (s.yellow_cards_away || 0);

  const ph    = signalPhrases(signals, s);
  const ctx   = ph.length > 0 ? ` Contexto: ${ph.join('; ')}. ` : ' ';
  const tag   = won ? 'PADRAO CONFIRMADO' : 'CALIBRACAO MISS';

  switch (marketKey) {
    case 'btts':
      return won
        ? `${tag} BTTS — ${comp} [${home} ${score} ${away}]:${ctx}Ambas equipes marcaram. Total: ${totalGoals} gols. Chutes: ${s.shots_home || '?'}H vs ${s.shots_away || '?'}A. BTTS WIN.`
        : `${tag} BTTS NAO — ${comp} [${home} ${score} ${away}]: Apenas um time marcou.${ctx}Sinal de BTTS falhou — revisar condicoes desta liga.`;

    case 'over15':
      return won
        ? `${tag} Over 1.5 — ${comp} [${home} ${score} ${away}]:${ctx}${totalGoals} gols no total. Chutes combinados: ${totalShots}. Over 1.5 WIN.`
        : `${tag} Under 1.5 — ${comp} [${home} ${score} ${away}]: Apenas ${totalGoals} gol(s).${ctx}Over 1.5 MISS — jogo muito fechado.`;

    case 'over25':
      return won
        ? `${tag} Over 2.5 — ${comp} [${home} ${score} ${away}]:${ctx}${totalGoals} gols, ${totalShots} chutes combinados. Over 2.5 WIN.`
        : `${tag} Under 2.5 — ${comp} [${home} ${score} ${away}]: Apenas ${totalGoals} gols.${ctx}Over 2.5 MISS — Under 2.5 foi o resultado correto nesta liga.`;

    case 'over35':
      return won
        ? `${tag} Over 3.5 — ${comp} [${home} ${score} ${away}]:${ctx}${totalGoals} gols. Jogo muito aberto. Over 3.5 WIN.`
        : `${tag} Under 3.5 — ${comp} [${home} ${score} ${away}]: ${totalGoals} gols — abaixo de 4.${ctx}Revisar expectativa.`;

    case 'over_corners_65':
    case 'over_corners_75':
    case 'over_corners_85': {
      const line = marketKey === 'over_corners_65' ? '6.5' : marketKey === 'over_corners_75' ? '7.5' : '8.5';
      return won
        ? `${tag} Over ${line} Escanteios — ${comp} [${home} ${score} ${away}]:${ctx}${totalCorners} escanteios totais (${s.corners_home || 0}H + ${s.corners_away || 0}A). Over ${line} WIN.`
        : `${tag} Under ${line} Escanteios — ${comp} [${home} ${score} ${away}]: Apenas ${totalCorners} escanteios.${ctx}Revisar expectativa de corners nesta liga.`;
    }

    case 'over_yc_25':
    case 'over_yc_35':
    case 'over_yc_45': {
      const line = marketKey === 'over_yc_25' ? '2.5' : marketKey === 'over_yc_35' ? '3.5' : '4.5';
      return won
        ? `${tag} Over ${line} Cartoes — ${comp} [${home} ${score} ${away}]:${ctx}${totalYC} amarelos (${s.yellow_cards_home || 0}H + ${s.yellow_cards_away || 0}A). Over ${line} YC WIN.`
        : `${tag} Under ${line} Cartoes — ${comp} [${home} ${score} ${away}]: Apenas ${totalYC} amarelos.${ctx}Jogo menos agressivo que o esperado.`;
    }

    default:
      return `${tag} ${marketKey} — ${comp} [${home} ${score} ${away}]: resultado registrado.`;
  }
}

// ── Estimativa de Probabilidade ───────────────────────────────────────────────
const MARKET_SIGNALS = {
  btts: ['combined_shots_high', 'combined_shots_very_high', 'early_goal_away', 'early_goal_home',
         'possession_balanced', 'high_scoring_fixture', 'high_xg_combined'],
  over15: ['combined_shots_high', 'combined_shots_very_high', 'early_goal_away', 'early_goal_home',
           'high_scoring_fixture', 'high_xg_combined'],
  over25: ['combined_shots_very_high', 'home_shot_dominant', 'home_possession_dominant',
           'combined_shots_high', 'high_scoring_fixture', 'high_xg_combined'],
  over35: ['combined_shots_very_high', 'big_margin_win', 'high_xg_combined', 'high_scoring_fixture'],
  over_corners_85: ['combined_shots_high', 'home_possession_dominant', 'visitor_ultra_defensive',
                    'corners_asymmetry_extreme', 'corners_high', 'away_high_corners_avg'],
  over_corners_75: ['combined_shots_high', 'corners_high', 'away_high_corners_avg'],
  over_corners_65: ['combined_shots_high', 'possession_balanced'],
  over_yc_35: ['yc_high', 'yc_extreme', 'one_red_card', 'big_quality_gap', 'relegation_fight'],
  over_yc_45: ['yc_extreme', 'multiple_red_cards'],
  over_yc_25: ['yc_moderate', 'yc_high', 'big_quality_gap'],
};

export function estimateProbability(marketKey, won, signals) {
  const relevant = MARKET_SIGNALS[marketKey] ?? [];
  const matching = relevant.filter(s => signals.includes(s)).length;
  const base  = won ? 70 : 55;
  const bonus = matching * 5;
  return Math.min(Math.max(base + bonus, 60), 90);
}

// ── Seleção de mercados relevantes ────────────────────────────────────────────
function selectMarkets(match) {
  const r  = match.result || {};
  const s  = match.match_stats || {};
  const tg = (r.home_goals || 0) + (r.away_goals || 0);
  const tc = s.corners_total ?? ((s.corners_home || 0) + (s.corners_away || 0));
  const ty = (s.yellow_cards_home || 0) + (s.yellow_cards_away || 0);

  const list = [];

  // Gols
  list.push({ key: 'btts',   won: r.home_goals > 0 && r.away_goals > 0, label: 'BTTS' });
  list.push({ key: 'over15', won: tg >= 2, label: 'Over 1.5' });
  list.push({ key: 'over25', won: tg >= 3, label: 'Over 2.5' });
  if (tg >= 2) {  // Calibração Over 3.5 sempre que relevante
    list.push({ key: 'over35', won: tg >= 4, label: 'Over 3.5' });
  }

  // Escanteios — rastreia todas as 3 linhas independentemente para calibração máxima
  if (tc > 0) {
    list.push({ key: 'over_corners_85', won: tc > 8.5, label: 'Over Corners 8.5' });
    list.push({ key: 'over_corners_75', won: tc > 7.5, label: 'Over Corners 7.5' });
    list.push({ key: 'over_corners_65', won: tc > 6.5, label: 'Over Corners 6.5' });
  }

  // Cartões — rastreia todas as 3 linhas independentemente para calibração máxima
  list.push({ key: 'over_yc_45', won: ty > 4.5, label: 'YC 4.5' });
  list.push({ key: 'over_yc_35', won: ty > 3.5, label: 'YC 3.5' });
  list.push({ key: 'over_yc_25', won: ty > 2.5, label: 'YC 2.5' });

  return list;
}

// ── Análise completa ──────────────────────────────────────────────────────────
export function analyzeMatch(match) {
  const signals  = detectSignals(match);
  const markets  = selectMarkets(match);
  const comp     = match.competition || 'desconhecida';

  const positives   = [];
  const lessons     = [];
  const calibration = [];

  for (const mkt of markets) {
    const directive = generateDirective(mkt.key, mkt.won, match, signals);
    if (!directive) continue;

    const prob = estimateProbability(mkt.key, mkt.won, signals);

    if (mkt.won) {
      positives.push({ market: mkt.label, competition: comp, directive });
    }

    // Lição de calibração para acertos e erros
    lessons.push({
      market: mkt.label,
      competition: comp,
      errorType: 'calibration',
      directive: directive.length > 300 ? directive.substring(0, 300) + '...' : directive,
    });

    calibration.push({
      market: mkt.label,
      probabilidade: prob,
      acertou: mkt.won,
      competition: comp,
    });
  }

  return {
    signals,
    positives,
    lessons,
    calibration,
    summary: {
      totalGoals: (match.result?.home_goals || 0) + (match.result?.away_goals || 0),
      totalCorners: (match.match_stats?.corners_total) ?? ((match.match_stats?.corners_home || 0) + (match.match_stats?.corners_away || 0)),
      totalYC: (match.match_stats?.yellow_cards_home || 0) + (match.match_stats?.yellow_cards_away || 0),
    },
  };
}
