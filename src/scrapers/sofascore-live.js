/**
 * SofaScore Live — Busca e coleta de jogos em andamento (in-play)
 *
 * Endpoints públicos não oficiais:
 *   GET /sport/football/events/live          → lista de todos os jogos ao vivo
 *   GET /event/{id}                          → detalhes + placar + minuto
 *   GET /event/{id}/statistics               → estatísticas ao vivo
 *   GET /event/{id}/h2h                      → histórico H2H (pré-jogo)
 *   GET /team/{id}/events/last/0             → forma recente de cada time
 */

import axios from 'axios';
import chalk from 'chalk';

const API  = 'https://api.sofascore.com/api/v1';
const http = axios.create({
  baseURL: API,
  timeout: 12_000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept':     'application/json',
    'Referer':    'https://www.sofascore.com/',
  },
});

// ── Retry com backoff exponencial para falhas de rede ─────────────────────────
async function _withRetry(fn, maxRetries = 2, baseDelayMs = 1500) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Não retenta em erros 4xx (problema do dado, não da rede)
      if (err.response?.status >= 400 && err.response?.status < 500) break;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Buscar todos os jogos ao vivo de futebol ──────────────────────────────────
export async function getLiveMatches() {
  console.log(chalk.cyan('  [SofaScore Live] Buscando jogos em andamento...'));
  try {
    const res    = await _withRetry(() => http.get('/sport/football/events/live'));
    const events = res.data?.events || [];

    return events
      .filter((e) => {
        const type = e.status?.type?.toLowerCase() || '';
        // Aceita apenas jogos em andamento (inprogress, halftime, extra time)
        return ['inprogress', 'halftime', 'extra_time', 'overtime'].includes(type);
      })
      .map((e) => ({
        sofascore_id: e.id,
        slug:         e.slug,
        home_team:    e.homeTeam?.name,
        home_id:      e.homeTeam?.id,
        away_team:    e.awayTeam?.name,
        away_id:      e.awayTeam?.id,
        competition:   e.tournament?.name,
        tournament_id: e.tournament?.uniqueTournament?.id ?? null,
        country:       e.tournament?.category?.country?.name,
        // Placar atual
        score_home:   e.homeScore?.current ?? 0,
        score_away:   e.awayScore?.current ?? 0,
        // Minuto e situação
        // Usa e.time.played (minuto total do jogo) quando disponível.
        // Fallback: calcula pelo timestamp do início do período atual.
        minute:       e.time?.played
          ?? (e.time?.currentPeriodStartTimestamp
            ? Math.floor((Date.now() / 1000 - e.time.currentPeriodStartTimestamp) / 60)
            : null),
        // Acréscimo declarado pelo árbitro (quando disponível)
        injuryTime:   e.time?.injuryTime ?? null,
        period:       e.status?.description || e.status?.type,
        status_type:  e.status?.type,
        // xG ao vivo (quando disponível)
        xg_home:      e.homeScore?.expectedGoals ? parseFloat(e.homeScore.expectedGoals) : null,
        xg_away:      e.awayScore?.expectedGoals ? parseFloat(e.awayScore.expectedGoals) : null,
        start_timestamp: e.startTimestamp,
      }));
  } catch (err) {
    console.warn(chalk.yellow(`  [SofaScore Live] Falha ao buscar jogos: ${err.message}`));
    return [];
  }
}

// ── Buscar estatísticas ao vivo de um jogo ────────────────────────────────────
export async function getLiveStats(eventId) {
  try {
    const res  = await _withRetry(() => http.get(`/event/${eventId}/statistics`));
    const data = res.data?.statistics || [];

    // Busca período completo (ALL) ou período mais recente
    const period = data.find((p) => p.period === 'ALL') || data[0];
    if (!period) return null;

    const stats = {};
    for (const group of period.groups || []) {
      for (const item of group.statisticsItems || []) {
        const key = item.name?.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (key) {
          stats[key] = {
            home: _parseStatValue(item.home),
            away: _parseStatValue(item.away),
          };
        }
      }
    }

    return {
      possession_home: stats.ball_possession?.home ?? null,
      possession_away: stats.ball_possession?.away ?? null,
      shots_total_home:     stats.total_shots?.home ?? stats.shots?.home ?? null,
      shots_total_away:     stats.total_shots?.away ?? stats.shots?.away ?? null,
      shots_on_target_home: stats.shots_on_target?.home ?? null,
      shots_on_target_away: stats.shots_on_target?.away ?? null,
      shots_off_target_home: stats.shots_off_target?.home ?? null,
      shots_off_target_away: stats.shots_off_target?.away ?? null,
      corners_home: stats.corner_kicks?.home ?? null,
      corners_away: stats.corner_kicks?.away ?? null,
      fouls_home:   stats.fouls?.home ?? null,
      fouls_away:   stats.fouls?.away ?? null,
      yellow_cards_home: stats.yellow_cards?.home ?? null,
      yellow_cards_away: stats.yellow_cards?.away ?? null,
      dangerous_attacks_home: stats.dangerous_attacks?.home ?? null,
      dangerous_attacks_away: stats.dangerous_attacks?.away ?? null,
      attacks_home: stats.attacks?.home ?? null,
      attacks_away: stats.attacks?.away ?? null,
      // xG ao vivo (quando a API fornece)
      xg_home: stats.expected_goals?.home ?? null,
      xg_away: stats.expected_goals?.away ?? null,
      goalkeeper_saves_home: stats.goalkeeper_saves?.home ?? null,
      goalkeeper_saves_away: stats.goalkeeper_saves?.away ?? null,
      _raw: stats,
    };
  } catch {
    return null;
  }
}

// ── Buscar detalhes completos (para enriquecer com forma e H2H) ───────────────
export async function getLiveMatchDetails(eventId, homeId, awayId) {
  const [formHomeRes, formAwayRes, h2hRes] = await Promise.allSettled([
    _withRetry(() => http.get(`/team/${homeId}/events/last/0`)),
    _withRetry(() => http.get(`/team/${awayId}/events/last/0`)),
    _withRetry(() => http.get(`/event/${eventId}/h2h`)),
  ]);

  const homeForm = _parseTeamForm(formHomeRes.value?.data?.events, homeId);
  const awayForm = _parseTeamForm(formAwayRes.value?.data?.events, awayId);
  const h2h      = _parseH2H(h2hRes.value?.data, homeId, awayId);

  return { homeForm, awayForm, h2h };
}

// ── Coleta completa para análise live ─────────────────────────────────────────
export async function collectLiveMatchData(match) {
  const [liveStats, details] = await Promise.allSettled([
    getLiveStats(match.sofascore_id),
    getLiveMatchDetails(match.sofascore_id, match.home_id, match.away_id),
  ]);

  const stats   = liveStats.status  === 'fulfilled' ? liveStats.value   : null;
  const history = details.status    === 'fulfilled' ? details.value     : {};

  // ── Calcular minuto total do jogo ──────────────────────────────────────────
  // e.time.played do SofaScore já dá o minuto total (ex: 92 = acréscimo 2T).
  // O período é usado apenas para exibição e para identificar acréscimo.
  let minuto = match.minute;             // já é o minuto total (via played)
  const period = (match.period || '').toLowerCase();

  // Se não tiver "played" mas tiver período, estima pelo período
  if (minuto == null) {
    if (period.includes('halftime') || period.includes('half time')) minuto = 45;
    else if (period.includes('second') || period.includes('2nd'))    minuto = 70; // estimativa
    else                                                              minuto = 25; // 1T estimativa
  }

  // Detecta acréscimo do 2T: minuto 90+ E período é 2T
  const isSegundoTempo   = period.includes('2nd') || period.includes('second') || (minuto != null && minuto >= 45 && !period.includes('halftime'));
  const isPrimeiroTempo  = period.includes('1st') || period.includes('first')  || (minuto != null && minuto < 45);
  const isAcrescimo2T    = isSegundoTempo && minuto >= 90;
  const isAcrescimo1T    = isPrimeiroTempo && minuto >= 45 && !period.includes('halftime');
  const acrescimo        = isAcrescimo2T ? (minuto - 90) : isAcrescimo1T ? (minuto - 45) : 0;

  // Label do minuto para exibição (ex: "90+2")
  const minutoLabel = isAcrescimo2T
    ? `90+${acrescimo}`
    : isAcrescimo1T
    ? `45+${acrescimo}`
    : String(minuto ?? '?');

  // Minutos restantes estimados (considerando acréscimo declarado pelo árbitro)
  const acrescimoDeclarado = match.injuryTime ?? (isAcrescimo2T ? 5 : 3); // fallback típico
  let minutosRestantes;
  if (isAcrescimo2T) {
    minutosRestantes = Math.max(0, (90 + acrescimoDeclarado) - minuto);
  } else if (period.includes('halftime')) {
    minutosRestantes = 45; // 2T inteiro
  } else if (isSegundoTempo) {
    minutosRestantes = Math.max(0, 90 - minuto);
  } else {
    minutosRestantes = Math.max(0, 45 - minuto);
  }

  // xG: preferir estatísticas > header do evento
  const xgHome = stats?.xg_home ?? match.xg_home;
  const xgAway = stats?.xg_away ?? match.xg_away;

  // Taxa de gols por minuto (para projeção do que ainda pode ocorrer)
  const totalGols    = (match.score_home || 0) + (match.score_away || 0);
  const minDecorrido = Math.max(minuto || 1, 1);
  const ritmoGols    = totalGols / minDecorrido;
  const golsEsperadosRestantes = Math.round(ritmoGols * minutosRestantes * 10) / 10;

  return {
    // Identificação
    match_id:    match.sofascore_id,
    match:       `${match.home_team} vs ${match.away_team}`,
    competition: match.competition,
    country:     match.country,
    // Estado do jogo
    minuto:            minuto ?? '?',
    minuto_label:      minutoLabel,
    minutos_restantes: minutosRestantes,
    acrescimo:         acrescimo,
    is_acrescimo:      isAcrescimo2T || isAcrescimo1T,
    periodo:           period,
    placar:      `${match.score_home}-${match.score_away}`,
    gols_casa:   match.score_home,
    gols_fora:   match.score_away,
    // Projeção de gols adicionais com base no ritmo atual
    projecao_total_gols:           Math.round((ritmoGols * 90 + totalGols) / 2 * 10) / 10,
    gols_esperados_restantes:      golsEsperadosRestantes,
    // xG ao vivo
    xg_home: xgHome,
    xg_away: xgAway,
    xg_total: xgHome != null && xgAway != null ? Math.round((xgHome + xgAway) * 10) / 10 : null,
    // Estatísticas ao vivo
    live_stats: stats ? {
      posse_casa:       stats.possession_home,
      posse_fora:       stats.possession_away,
      chutes_total_casa: stats.shots_total_home,
      chutes_total_fora: stats.shots_total_away,
      chutes_alvo_casa:  stats.shots_on_target_home,
      chutes_alvo_fora:  stats.shots_on_target_away,
      escanteios_casa:   stats.corners_home,
      escanteios_fora:   stats.corners_away,
      ataques_perig_casa: stats.dangerous_attacks_home,
      ataques_perig_fora: stats.dangerous_attacks_away,
      amarelos_casa:      stats.yellow_cards_home,
      amarelos_fora:      stats.yellow_cards_away,
      defesas_casa:       stats.goalkeeper_saves_home,
      defesas_fora:       stats.goalkeeper_saves_away,
    } : null,
    // Histórico (forma pré-jogo)
    home: {
      team: match.home_team,
      ...history.homeForm,
    },
    away: {
      team: match.away_team,
      ...history.awayForm,
    },
    h2h: history.h2h || [],
  };
}

// ── Parsers internos ──────────────────────────────────────────────────────────
function _parseStatValue(val) {
  if (val == null) return null;
  const s = String(val).replace('%', '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function _parseTeamForm(events, teamId) {
  if (!events?.length) return { form: 'N/A', goals_scored_avg: 1.3, goals_conceded_avg: 1.1 };

  const last6 = events.slice(0, 6);
  let scored = 0, conceded = 0;
  const formChars = [];

  for (const ev of last6) {
    const isHome    = ev.homeTeam?.id === teamId;
    const teamScore = isHome ? ev.homeScore?.current : ev.awayScore?.current;
    const oppScore  = isHome ? ev.awayScore?.current : ev.homeScore?.current;
    scored   += teamScore || 0;
    conceded += oppScore  || 0;
    if (teamScore > oppScore) formChars.push('W');
    else if (teamScore === oppScore) formChars.push('D');
    else formChars.push('L');
  }
  const n = last6.length || 1;
  return {
    form:               formChars.join(''),
    goals_scored_avg:   Math.round((scored   / n) * 10) / 10,
    goals_conceded_avg: Math.round((conceded / n) * 10) / 10,
  };
}

function _parseH2H(data, homeId, awayId) {
  if (!data) return [];
  const matches = [
    ...(data.teamDuel?.homeEvents || []),
    ...(data.teamDuel?.awayEvents || []),
  ].sort((a, b) => b.startTimestamp - a.startTimestamp).slice(0, 5);

  return matches.map((m) => ({
    date:       new Date(m.startTimestamp * 1000).toISOString().split('T')[0],
    score:      `${m.homeScore?.current ?? '?'}-${m.awayScore?.current ?? '?'}`,
    home_goals: m.homeScore?.current ?? 0,
    away_goals: m.awayScore?.current ?? 0,
  }));
}
