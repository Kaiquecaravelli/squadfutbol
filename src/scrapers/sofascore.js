/**
 * SofaScore Scraper
 * Usa a API pública não oficial do SofaScore (api.sofascore.com)
 * Fornece: xG, ratings de jogadores, posse, estatísticas avançadas
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
