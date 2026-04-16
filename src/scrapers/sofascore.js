/**
 * sofascore.js — SofaScore Scraper + Live Data
 *
 * Responsabilidade neste projeto:
 *   • Dados pré-jogo: xG, ratings, posse, forma, H2H (parseTeamForm, getSofascoreMatchDetails)
 *   • Dados ao vivo:  getLiveMatches, getLiveStats, collectLiveMatchData
 *
 * Hierarquia de fontes por agente:
 *   GoalsAgent / BTTSAgent / DoubleChanceAgent → Academia das Apostas (primária)
 *   CornersAgent                               → SofaScore (primária)
 *
 * SofaScore é sempre usado para validação técnica ao vivo e estatísticas de escanteios.
 */

import axios from 'axios';
import { chromium } from 'playwright';
import chalk from 'chalk';

const API_BASE = 'https://api.sofascore.com/api/v1';
const SITE_BASE = 'https://www.sofascore.com/pt';
const TIMEOUT = 12000;

const http = axios.create({
  baseURL: API_BASE,
  timeout: TIMEOUT,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.sofascore.com/',
  },
});

// ── Buscar partidas do dia ────────────────────────────────────────────────────
export async function getSofascoreMatches(date) {
  const dateStr = date || new Date().toISOString().split('T')[0];
  console.log(chalk.cyan(`  [SofaScore] Buscando partidas de ${dateStr}...`));

  try {
    const res = await http.get(`/sport/football/scheduled-events/${dateStr}`);
    const events = res.data?.events || [];

    return events
      .filter((e) => e.status?.type === 'notstarted')
      .map((e) => ({
        sofascore_id: e.id,
        home_team: e.homeTeam?.name,
        home_id:   e.homeTeam?.id,
        away_team: e.awayTeam?.name,
        away_id:   e.awayTeam?.id,
        competition: e.tournament?.name,
        country: e.tournament?.category?.country?.name,
        match_time: new Date(e.startTimestamp * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        match_date: new Date(e.startTimestamp * 1000).toISOString(),
        slug: e.slug,
      }));
  } catch (err) {
    console.warn(chalk.yellow(`  [SofaScore] API indisponível: ${err.message}`));
    return [];
  }
}

// ── Detalhes de uma partida (H2H + stats dos times) ──────────────────────────
export async function getSofascoreMatchDetails(eventId, homeId, awayId) {
  console.log(chalk.cyan(`  [SofaScore] Coletando dados avançados (event ${eventId})...`));

  const [h2hRes, homeLastRes, awayLastRes, preMatchRes] = await Promise.allSettled([
    http.get(`/event/${eventId}/h2h`),
    http.get(`/team/${homeId}/events/last/0`),
    http.get(`/team/${awayId}/events/last/0`),
    http.get(`/event/${eventId}/pregame-form`),
  ]);

  const h2h = parseH2H(h2hRes.status === 'fulfilled' ? h2hRes.value?.data : null, homeId, awayId);
  const homeStats = parseTeamForm(homeLastRes.status === 'fulfilled' ? homeLastRes.value?.data?.events : null, homeId);
  const awayStats = parseTeamForm(awayLastRes.status === 'fulfilled' ? awayLastRes.value?.data?.events : null, awayId);
  const preMatchForm = parsePreMatchForm(preMatchRes.status === 'fulfilled' ? preMatchRes.value?.data : null);

  return {
    source: 'sofascore',
    h2h,
    home: { ...homeStats, pregame_form: preMatchForm?.home },
    away: { ...awayStats, pregame_form: preMatchForm?.away },
  };
}

// ── Estatísticas avançadas de um time ────────────────────────────────────────
export async function getTeamSeasonStats(teamId, tournamentId = null) {
  try {
    const url = tournamentId
      ? `/team/${teamId}/unique-tournament/${tournamentId}/season/stats`
      : `/team/${teamId}/events/last/0`;
    const res = await http.get(url);
    return extractSeasonStats(res.data);
  } catch {
    return null;
  }
}

// ── Scrape visual (fallback) ──────────────────────────────────────────────────
export async function scrapeTeamFormVisual(teamSlug) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  try {
    await page.goto(`${SITE_BASE}/team/football/${teamSlug}`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT,
    });
    await page.waitForTimeout(2000);

    const form = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="form"] [class*="result"]');
      return Array.from(els).slice(0, 8).map((el) => el.textContent?.trim());
    });

    return form.filter(Boolean);
  } catch {
    return [];
  } finally {
    await browser.close();
  }
}

// ── Parsers internos ──────────────────────────────────────────────────────────
function parseH2H(data, homeId, awayId) {
  if (!data) return [];

  const matches = [
    ...(data.teamDuel?.homeEvents || []),
    ...(data.teamDuel?.awayEvents || []),
  ].sort((a, b) => b.startTimestamp - a.startTimestamp).slice(0, 10);

  return matches.map((m) => {
    const homeScore = m.homeScore?.current;
    const awayScore = m.awayScore?.current;
    const homeWon = m.homeTeam?.id === homeId
      ? homeScore > awayScore
      : awayScore > homeScore;
    const draw = homeScore === awayScore;

    return {
      date: new Date(m.startTimestamp * 1000).toISOString().split('T')[0],
      home: m.homeTeam?.name,
      away: m.awayTeam?.name,
      score: `${homeScore}-${awayScore}`,
      home_goals: homeScore,
      away_goals: awayScore,
      winner: draw ? 'Draw' : homeWon ? m.homeTeam?.name : m.awayTeam?.name,
      competition: m.tournament?.name,
    };
  });
}

function parseTeamForm(events, teamId) {
  if (!events?.length) return { form: 'N/A', goals_scored_avg: 1.3, goals_conceded_avg: 1.1, xg_avg: 0, ratings_avg: 0 };

  const last8 = events.slice(0, 8);
  let scored = 0, conceded = 0, xgTotal = 0, ratings = 0, ratingsCount = 0;
  const formChars = [];

  for (const ev of last8) {
    const isHome = ev.homeTeam?.id === teamId;
    const teamScore = isHome ? ev.homeScore?.current : ev.awayScore?.current;
    const oppScore  = isHome ? ev.awayScore?.current : ev.homeScore?.current;

    scored   += teamScore || 0;
    conceded += oppScore  || 0;

    // xG se disponível
    const xg = isHome ? ev.homeScore?.expectedGoals : ev.awayScore?.expectedGoals;
    if (xg) { xgTotal += parseFloat(xg); }

    // Rating médio do time
    const rating = isHome ? ev.homeTeam?.rating : ev.awayTeam?.rating;
    if (rating) { ratings += parseFloat(rating); ratingsCount++; }

    if (teamScore > oppScore) formChars.push('W');
    else if (teamScore === oppScore) formChars.push('D');
    else formChars.push('L');
  }

  const n = last8.length || 1;

  // ── Sequências e janelas temporais (Módulo 4 · 2026-04-16) ──────────────────
  // Calculadas dos placares já disponíveis — sem chamadas adicionais à API.
  const last5  = last8.slice(0, 5);
  const _btts   = (ev) => (ev.homeScore?.current > 0) && (ev.awayScore?.current > 0);
  const _over15 = (ev) => ((ev.homeScore?.current ?? 0) + (ev.awayScore?.current ?? 0)) >= 2;

  const btts_pct_5j   = last5.length ? Math.round(last5.filter(_btts).length   / last5.length * 100) : null;
  const btts_pct_8j   = last8.length ? Math.round(last8.filter(_btts).length   / last8.length * 100) : null;
  const over15_pct_5j = last5.length ? Math.round(last5.filter(_over15).length / last5.length * 100) : null;
  const over15_pct_8j = last8.length ? Math.round(last8.filter(_over15).length / last8.length * 100) : null;

  // Sequência consecutiva a partir do jogo mais recente (sinal de pressão estatística)
  let sequencia_sem_btts = 0;
  for (const ev of last8) { if (_btts(ev)) break; sequencia_sem_btts++; }
  let sequencia_btts = 0;
  for (const ev of last8) { if (!_btts(ev)) break; sequencia_btts++; }

  return {
    form: formChars.join(''),
    goals_scored_avg:   Math.round((scored / n) * 10) / 10,
    goals_conceded_avg: Math.round((conceded / n) * 10) / 10,
    xg_avg: xgTotal > 0 ? Math.round((xgTotal / n) * 10) / 10 : 0,
    ratings_avg: ratingsCount > 0 ? Math.round((ratings / ratingsCount) * 10) / 10 : 0,
    clean_sheets: last8.filter((ev) => {
      const isHome = ev.homeTeam?.id === teamId;
      const oppScore = isHome ? ev.awayScore?.current : ev.homeScore?.current;
      return oppScore === 0;
    }).length,
    // Sequências e janelas temporais — usadas por BTTSAgent e GoalsAgent
    btts_pct_5j,
    btts_pct_8j,
    over15_pct_5j,
    over15_pct_8j,
    sequencia_sem_btts,  // jogos consecutivos sem BTTS (pressão para ocorrência)
    sequencia_btts,      // jogos consecutivos com BTTS (confirmação de tendência)
  };
}

function parsePreMatchForm(data) {
  if (!data) return null;
  return {
    home: data.homeTeam?.value || null,
    away: data.awayTeam?.value || null,
  };
}

function extractSeasonStats(data) {
  if (!data) return {};
  const s = data.statistics || {};
  return {
    goals_scored:   s.goalsScored,
    goals_conceded: s.goalsConceded,
    avg_ball_possession: s.avgBallPossession,
    shots_on_target_pct: s.onTargetScoringAttempts,
    xg_total: s.expectedGoals,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// LIVE DATA — funções para coleta de partidas em andamento (SUPERODDS)
// ════════════════════════════════════════════════════════════════════════════════

// Retry com backoff exponencial para falhas de rede
async function _withRetryLive(fn, maxRetries = 2, baseDelayMs = 1500) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.response?.status >= 400 && err.response?.status < 500) break;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Busca todos os jogos de futebol em andamento.
 * Fonte primária para o funil SUPERODDS.
 * @returns {Array} lista de partidas ao vivo com placar, minuto e xG
 */
export async function getLiveMatches() {
  console.log(chalk.cyan('  [SofaScore] Buscando jogos em andamento (SUPERODDS)...'));
  try {
    const res    = await _withRetryLive(() => http.get('/sport/football/events/live'));
    const events = res.data?.events || [];

    return events
      .filter((e) => {
        const type = e.status?.type?.toLowerCase() || '';
        return ['inprogress', 'halftime', 'extra_time', 'overtime'].includes(type);
      })
      .map((e) => ({
        sofascore_id:  e.id,
        slug:          e.slug,
        home_team:     e.homeTeam?.name,
        home_id:       e.homeTeam?.id,
        away_team:     e.awayTeam?.name,
        away_id:       e.awayTeam?.id,
        competition:   e.tournament?.name,
        tournament_id: e.tournament?.uniqueTournament?.id ?? null,
        country:       e.tournament?.category?.country?.name,
        score_home:    e.homeScore?.current ?? 0,
        score_away:    e.awayScore?.current ?? 0,
        minute:        e.time?.played
          ?? (e.time?.currentPeriodStartTimestamp
            ? Math.floor((Date.now() / 1000 - e.time.currentPeriodStartTimestamp) / 60)
            : null),
        injuryTime:    e.time?.injuryTime ?? null,
        period:        e.status?.description || e.status?.type,
        status_type:   e.status?.type,
        xg_home:       e.homeScore?.expectedGoals ? parseFloat(e.homeScore.expectedGoals) : null,
        xg_away:       e.awayScore?.expectedGoals ? parseFloat(e.awayScore.expectedGoals) : null,
        start_timestamp: e.startTimestamp,
      }));
  } catch (err) {
    console.warn(chalk.yellow(`  [SofaScore] Falha ao buscar jogos ao vivo: ${err.message}`));
    return [];
  }
}

/**
 * Busca estatísticas ao vivo de um evento.
 * Fonte primária para CornersAgent (escanteios ao vivo).
 * @param {number|string} eventId
 * @returns {object|null}
 */
export async function getLiveStats(eventId) {
  try {
    const res  = await _withRetryLive(() => http.get(`/event/${eventId}/statistics`));
    const data = res.data?.statistics || [];

    const allPeriod  = data.find((p) => p.period === 'ALL') || data[0];
    if (!allPeriod) return null;

    // ── Extrator de stats por período ──────────────────────────────────────────
    const _extractStats = (periodData) => {
      if (!periodData) return {};
      const s = {};
      for (const group of periodData.groups || []) {
        for (const item of group.statisticsItems || []) {
          const key = item.name?.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
          if (key) s[key] = { home: _parseLiveStat(item.home), away: _parseLiveStat(item.away) };
        }
      }
      return s;
    };

    const stats  = _extractStats(allPeriod);
    const stats1 = _extractStats(data.find((p) => p.period === '1ST'));
    const stats2 = _extractStats(data.find((p) => p.period === '2ND'));

    // Pressure index — % de ataques perigosos do time em relação ao total da partida
    const _pressure = (own, opp) => {
      const total = (own ?? 0) + (opp ?? 0);
      return total > 0 ? Math.round((own ?? 0) / total * 100) : null;
    };
    const daHome = stats.dangerous_attacks?.home;
    const daAway = stats.dangerous_attacks?.away;

    return {
      possession_home:       stats.ball_possession?.home ?? null,
      possession_away:       stats.ball_possession?.away ?? null,
      shots_total_home:      stats.total_shots?.home ?? stats.shots?.home ?? null,
      shots_total_away:      stats.total_shots?.away ?? stats.shots?.away ?? null,
      shots_on_target_home:  stats.shots_on_target?.home ?? null,
      shots_on_target_away:  stats.shots_on_target?.away ?? null,
      shots_off_target_home: stats.shots_off_target?.home ?? null,
      shots_off_target_away: stats.shots_off_target?.away ?? null,
      corners_home:           stats.corner_kicks?.home ?? null,
      corners_away:           stats.corner_kicks?.away ?? null,
      // Distribuição temporal de escanteios — Módulo 4 CornersAgent (2026-04-16)
      corners_1st_home:       stats1.corner_kicks?.home ?? null,
      corners_1st_away:       stats1.corner_kicks?.away ?? null,
      corners_2nd_home:       stats2.corner_kicks?.home ?? null,
      corners_2nd_away:       stats2.corner_kicks?.away ?? null,
      fouls_home:             stats.fouls?.home ?? null,
      fouls_away:             stats.fouls?.away ?? null,
      yellow_cards_home:      stats.yellow_cards?.home ?? null,
      yellow_cards_away:      stats.yellow_cards?.away ?? null,
      dangerous_attacks_home: daHome ?? null,
      dangerous_attacks_away: daAway ?? null,
      // Pressure index — % de DA do time vs total (Módulo 4 · 2026-04-16)
      pressure_index_home:    _pressure(daHome, daAway),
      pressure_index_away:    _pressure(daAway, daHome),
      attacks_home:           stats.attacks?.home ?? null,
      attacks_away:           stats.attacks?.away ?? null,
      xg_home:                stats.expected_goals?.home ?? null,
      xg_away:                stats.expected_goals?.away ?? null,
      goalkeeper_saves_home:  stats.goalkeeper_saves?.home ?? null,
      goalkeeper_saves_away:  stats.goalkeeper_saves?.away ?? null,
      _raw: stats,
    };
  } catch {
    return null;
  }
}

/**
 * Busca forma recente e H2H de uma partida ao vivo.
 * @param {number|string} eventId
 * @param {number|string} homeId
 * @param {number|string} awayId
 * @returns {object}
 */
export async function getLiveMatchDetails(eventId, homeId, awayId) {
  const [formHomeRes, formAwayRes, h2hRes] = await Promise.allSettled([
    _withRetryLive(() => http.get(`/team/${homeId}/events/last/0`)),
    _withRetryLive(() => http.get(`/team/${awayId}/events/last/0`)),
    _withRetryLive(() => http.get(`/event/${eventId}/h2h`)),
  ]);

  const homeForm = _parseLiveTeamForm(formHomeRes.value?.data?.events, homeId);
  const awayForm = _parseLiveTeamForm(formAwayRes.value?.data?.events, awayId);
  const h2h      = _parseLiveH2H(h2hRes.value?.data, homeId, awayId);

  return { homeForm, awayForm, h2h };
}

/**
 * Coleta completa de dados para análise SUPERODDS.
 * Une stats ao vivo (SofaScore), forma histórica e H2H.
 *
 * @param {object} match - objeto retornado por getLiveMatches()
 * @returns {object} liveData normalizado para os agentes de mercado
 */
export async function collectLiveMatchData(match) {
  const [liveStats, details] = await Promise.allSettled([
    getLiveStats(match.sofascore_id),
    getLiveMatchDetails(match.sofascore_id, match.home_id, match.away_id),
  ]);

  const stats   = liveStats.status === 'fulfilled' ? liveStats.value   : null;
  const history = details.status   === 'fulfilled' ? details.value     : {};

  // Minuto total do jogo (e.time.played já fornece o valor correto)
  let minuto = match.minute;
  const period = (match.period || '').toLowerCase();

  if (minuto == null) {
    if (period.includes('halftime') || period.includes('half time')) minuto = 45;
    else if (period.includes('second') || period.includes('2nd'))    minuto = 70;
    else                                                              minuto = 25;
  }

  const isSegundoTempo  = period.includes('2nd') || period.includes('second') || (minuto != null && minuto >= 45 && !period.includes('halftime'));
  const isPrimeiroTempo = period.includes('1st') || period.includes('first')  || (minuto != null && minuto < 45);
  const isAcrescimo2T   = isSegundoTempo  && minuto >= 90;
  const isAcrescimo1T   = isPrimeiroTempo && minuto >= 45 && !period.includes('halftime');
  const acrescimo       = isAcrescimo2T ? (minuto - 90) : isAcrescimo1T ? (minuto - 45) : 0;

  const minutoLabel = isAcrescimo2T
    ? `90+${acrescimo}`
    : isAcrescimo1T
    ? `45+${acrescimo}`
    : String(minuto ?? '?');

  const acrescimoDeclarado = match.injuryTime ?? (isAcrescimo2T ? 5 : 3);
  let minutosRestantes;
  if (isAcrescimo2T)                           minutosRestantes = Math.max(0, (90 + acrescimoDeclarado) - minuto);
  else if (period.includes('halftime'))        minutosRestantes = 45;
  else if (isSegundoTempo)                     minutosRestantes = Math.max(0, 90 - minuto);
  else                                         minutosRestantes = Math.max(0, 45 - minuto);

  const xgHome = stats?.xg_home ?? match.xg_home;
  const xgAway = stats?.xg_away ?? match.xg_away;

  const totalGols    = (match.score_home || 0) + (match.score_away || 0);
  const minDecorrido = Math.max(minuto || 1, 1);
  const ritmoGols    = totalGols / minDecorrido;
  const golsEsperadosRestantes = Math.round(ritmoGols * minutosRestantes * 10) / 10;

  return {
    match_id:          match.sofascore_id,
    match:             `${match.home_team} vs ${match.away_team}`,
    competition:       match.competition,
    country:           match.country,
    minuto:            minuto ?? '?',
    minuto_label:      minutoLabel,
    minutos_restantes: minutosRestantes,
    acrescimo,
    is_acrescimo:      isAcrescimo2T || isAcrescimo1T,
    periodo:           period,
    placar:            `${match.score_home}-${match.score_away}`,
    gols_casa:         match.score_home,
    gols_fora:         match.score_away,
    projecao_total_gols:      Math.round((ritmoGols * 90 + totalGols) / 2 * 10) / 10,
    gols_esperados_restantes: golsEsperadosRestantes,
    xg_home: xgHome,
    xg_away: xgAway,
    xg_total: xgHome != null && xgAway != null ? Math.round((xgHome + xgAway) * 10) / 10 : null,
    live_stats: stats ? {
      posse_casa:          stats.possession_home,
      posse_fora:          stats.possession_away,
      chutes_total_casa:   stats.shots_total_home,
      chutes_total_fora:   stats.shots_total_away,
      chutes_alvo_casa:    stats.shots_on_target_home,
      chutes_alvo_fora:    stats.shots_on_target_away,
      escanteios_casa:     stats.corners_home,
      escanteios_fora:     stats.corners_away,
      ataques_perig_casa:  stats.dangerous_attacks_home,
      ataques_perig_fora:  stats.dangerous_attacks_away,
      amarelos_casa:       stats.yellow_cards_home,
      amarelos_fora:       stats.yellow_cards_away,
      defesas_casa:        stats.goalkeeper_saves_home,
      defesas_fora:        stats.goalkeeper_saves_away,
    } : null,
    home: { team: match.home_team, ...history.homeForm },
    away: { team: match.away_team, ...history.awayForm },
    h2h:  history.h2h || [],
  };
}

// ── Helpers internos (live) ───────────────────────────────────────────────────
function _parseLiveStat(val) {
  if (val == null) return null;
  const n = parseFloat(String(val).replace('%', '').trim());
  return isNaN(n) ? null : n;
}

function _parseLiveTeamForm(events, teamId) {
  if (!events?.length) return { form: 'N/A', goals_scored_avg: 1.3, goals_conceded_avg: 1.1 };
  const last6 = events.slice(0, 6);
  let scored = 0, conceded = 0;
  const formChars = [];
  for (const ev of last6) {
    const isHome   = ev.homeTeam?.id === teamId;
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

function _parseLiveH2H(data, homeId, awayId) {
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
