import { footballApi, weatherApi } from '../utils/api-client.js';

export async function collectMatchData(matchId) {
  console.log(`🔍 [Scout] Coletando dados da partida ${matchId}...`);

  // Odds exclusivamente via Superbet (superbet.bet.br) — coletadas pelo aggregator
  const [fixtureRes] = await Promise.allSettled([
    footballApi.get(`/fixtures?id=${matchId}`),
  ]);

  const fixture = fixtureRes.status === 'fulfilled'
    ? fixtureRes.value?.response?.[0]
    : null;

  if (!fixture) throw new Error(`Partida ${matchId} não encontrada.`);

  const homeId = fixture.teams.home.id;
  const awayId = fixture.teams.away.id;

  const [homeStats, awayStats, h2h, weather] = await Promise.allSettled([
    footballApi.get(`/teams/statistics?team=${homeId}&season=2024&league=${fixture.league.id}`),
    footballApi.get(`/teams/statistics?team=${awayId}&season=2024&league=${fixture.league.id}`),
    footballApi.get(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`),
    fetchWeather(fixture.fixture.venue?.city),
  ]);

  const homeForm = extractForm(homeStats.value?.response);
  const awayForm = extractForm(awayStats.value?.response);

  return {
    match_id: matchId,
    match: `${fixture.teams.home.name} vs ${fixture.teams.away.name}`,
    date: fixture.fixture.date,
    competition: fixture.league.name,
    venue: fixture.fixture.venue?.name,
    home: {
      id: homeId,
      team: fixture.teams.home.name,
      form: homeForm.form,
      goals_scored_avg: homeForm.goals_scored_avg,
      goals_conceded_avg: homeForm.goals_conceded_avg,
      xg_avg: homeForm.xg_avg,
      clean_sheets: homeForm.clean_sheets,
    },
    away: {
      id: awayId,
      team: fixture.teams.away.name,
      form: awayForm.form,
      goals_scored_avg: awayForm.goals_scored_avg,
      goals_conceded_avg: awayForm.goals_conceded_avg,
      xg_avg: awayForm.xg_avg,
      clean_sheets: awayForm.clean_sheets,
    },
    h2h: extractH2H(h2h.value?.response, homeId),
    odds: {}, // odds coletadas pelo aggregator via Superbet (superbet.bet.br)
    weather: weather.status === 'fulfilled' ? weather.value : null,
  };
}

export async function collectMatchesByDate(date = new Date().toISOString().split('T')[0]) {
  console.log(`🔍 [Scout] Coletando partidas de ${date}...`);

  const leagues = process.env.MONITORED_LEAGUES?.split(',') || ['39', '140', '135', '78', '61', '2', '71'];
  const results = [];

  for (const leagueId of leagues) {
    const res = await footballApi.get(`/fixtures?date=${date}&league=${leagueId}&season=2024`);
    if (res?.response?.length) {
      results.push(...res.response.map((f) => ({
        match_id: f.fixture.id,
        match: `${f.teams.home.name} vs ${f.teams.away.name}`,
        date: f.fixture.date,
        competition: f.league.name,
        league_id: leagueId,
      })));
    }
  }

  console.log(`🔍 [Scout] ${results.length} partidas encontradas.`);
  return results;
}

function extractForm(stats) {
  if (!stats) return { form: 'N/A', goals_scored_avg: 0, goals_conceded_avg: 0, xg_avg: 0, clean_sheets: 0 };
  const { form, goals, fixtures } = stats;
  const played = fixtures?.played?.total || 1;
  return {
    form: form?.slice(-5) || 'N/A',
    goals_scored_avg: +(goals?.for?.average?.total || 0),
    goals_conceded_avg: +(goals?.against?.average?.total || 0),
    xg_avg: 0, // requer plano pago
    clean_sheets: goals?.against?.total?.total === 0 ? Math.round(played * 0.3) : 0,
  };
}

function extractH2H(matches, homeId) {
  if (!matches?.length) return [];
  return matches.slice(0, 10).map((m) => ({
    date: m.fixture.date,
    home_team: m.teams.home.name,
    away_team: m.teams.away.name,
    score: `${m.goals.home}-${m.goals.away}`,
    winner: m.teams.home.winner ? m.teams.home.name : m.teams.away.winner ? m.teams.away.name : 'Draw',
  }));
}

// Odds removidas deste agente — coletadas exclusivamente via Superbet (superbet.bet.br)
// pelo aggregator (getSuperbetOdds) e injetadas em matchData.odds automaticamente.

async function fetchWeather(city) {
  if (!city || !process.env.OPENWEATHER_KEY) return null;
  const res = await weatherApi.get(`/weather?q=${encodeURIComponent(city)}&appid=${process.env.OPENWEATHER_KEY}&units=metric`);
  return {
    condition: res?.weather?.[0]?.description,
    temp_c: res?.main?.temp,
    wind_kmh: Math.round((res?.wind?.speed || 0) * 3.6),
    humidity_pct: res?.main?.humidity,
  };
}
