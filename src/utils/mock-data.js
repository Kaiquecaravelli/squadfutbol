/**
 * Dados de demonstração para testar o sistema sem chaves de API.
 * Ativado quando DEMO_MODE=true no .env ou --demo na CLI.
 */

export const DEMO_MATCHES = [
  {
    match_id: 'demo_001',
    match: 'Manchester City vs Arsenal',
    date: new Date(Date.now() + 3 * 3600000).toISOString(),
    competition: 'Premier League',
    venue: 'Etihad Stadium',
    home: {
      id: 50, team: 'Manchester City',
      form: 'WWWDW',
      goals_scored_avg: 2.4, goals_conceded_avg: 0.9, xg_avg: 2.6, clean_sheets: 8,
    },
    away: {
      id: 42, team: 'Arsenal',
      form: 'WDWLW',
      goals_scored_avg: 1.9, goals_conceded_avg: 1.1, xg_avg: 2.0, clean_sheets: 5,
    },
    h2h: [
      { date: '2025-09-22', home_team: 'Arsenal', away_team: 'Manchester City', score: '2-2', winner: 'Draw' },
      { date: '2025-04-10', home_team: 'Manchester City', away_team: 'Arsenal', score: '3-0', winner: 'Manchester City' },
      { date: '2024-09-22', home_team: 'Arsenal', away_team: 'Manchester City', score: '1-0', winner: 'Arsenal' },
    ],
    odds: {
      home_win: 1.85, draw: 3.75, away_win: 4.20,
      over_05: 1.08, over_15: 1.35, over_25: 1.75, over_35: 2.90,
      btts_yes: 1.72, btts_no: 2.05,
      double_chance_1x: 1.28, double_chance_x2: 1.95, double_chance_12: 1.32,
    },
    weather: { condition: 'partly cloudy', temp_c: 14, wind_kmh: 18, humidity_pct: 65 },
  },
  {
    match_id: 'demo_002',
    match: 'Real Madrid vs Barcelona',
    date: new Date(Date.now() + 24 * 3600000).toISOString(),
    competition: 'La Liga',
    venue: 'Santiago Bernabéu',
    home: {
      id: 541, team: 'Real Madrid',
      form: 'WWWWL',
      goals_scored_avg: 2.8, goals_conceded_avg: 1.0, xg_avg: 2.9, clean_sheets: 7,
    },
    away: {
      id: 529, team: 'Barcelona',
      form: 'WDWWW',
      goals_scored_avg: 2.6, goals_conceded_avg: 1.2, xg_avg: 2.7, clean_sheets: 6,
    },
    h2h: [
      { date: '2025-10-26', home_team: 'Barcelona', away_team: 'Real Madrid', score: '4-0', winner: 'Barcelona' },
      { date: '2025-03-12', home_team: 'Real Madrid', away_team: 'Barcelona', score: '2-1', winner: 'Real Madrid' },
      { date: '2024-10-26', home_team: 'Barcelona', away_team: 'Real Madrid', score: '1-2', winner: 'Real Madrid' },
    ],
    odds: {
      home_win: 2.10, draw: 3.40, away_win: 3.30,
      over_05: 1.05, over_15: 1.22, over_25: 1.55, over_35: 2.30,
      btts_yes: 1.60, btts_no: 2.20,
      double_chance_1x: 1.38, double_chance_x2: 1.62, double_chance_12: 1.25,
    },
    weather: { condition: 'clear', temp_c: 22, wind_kmh: 8, humidity_pct: 45 },
  },
  {
    match_id: 'demo_003',
    match: 'Flamengo vs Palmeiras',
    date: new Date(Date.now() + 6 * 3600000).toISOString(),
    competition: 'Brasileirão Série A',
    venue: 'Maracanã',
    home: {
      id: 127, team: 'Flamengo',
      form: 'WWDWW',
      goals_scored_avg: 2.2, goals_conceded_avg: 1.1, xg_avg: 2.1, clean_sheets: 5,
    },
    away: {
      id: 121, team: 'Palmeiras',
      form: 'WDLWW',
      goals_scored_avg: 1.8, goals_conceded_avg: 0.9, xg_avg: 1.9, clean_sheets: 9,
    },
    h2h: [
      { date: '2025-08-10', home_team: 'Palmeiras', away_team: 'Flamengo', score: '1-1', winner: 'Draw' },
      { date: '2025-04-05', home_team: 'Flamengo', away_team: 'Palmeiras', score: '2-0', winner: 'Flamengo' },
      { date: '2024-11-20', home_team: 'Flamengo', away_team: 'Palmeiras', score: '0-1', winner: 'Palmeiras' },
    ],
    odds: {
      home_win: 2.25, draw: 3.20, away_win: 3.10,
      over_05: 1.06, over_15: 1.30, over_25: 1.90, over_35: 3.10,
      btts_yes: 1.80, btts_no: 1.95,
      double_chance_1x: 1.42, double_chance_x2: 1.70, double_chance_12: 1.35,
    },
    weather: { condition: 'rain', temp_c: 28, wind_kmh: 12, humidity_pct: 82 },
  },
];

export const DEMO_NEWS = {
  'Manchester City': {
    team: 'Manchester City',
    news_count: 8,
    impact_score: 5,
    sentiment: 'positive',
    key_headlines: [
      { title: 'Haaland retorna após lesão e deve ser titular', source: 'BBC Sport', impact: 10, category: 'return' },
      { title: 'City em forma impressionante com 3 vitórias seguidas', source: 'Guardian', impact: 6, category: 'momentum' },
    ],
    summary: 'Manchester City: impacto positivo (+5 pts). Haaland disponível após recuperação.',
  },
  Arsenal: {
    team: 'Arsenal',
    news_count: 6,
    impact_score: -8,
    sentiment: 'negative',
    key_headlines: [
      { title: 'Saka desfalca Arsenal com lesão muscular', source: 'Sky Sports', impact: -15, category: 'injury' },
      { title: 'Arsenal com 2 titulares em dúvida para clássico', source: 'ESPN', impact: -10, category: 'injury' },
    ],
    summary: 'Arsenal: impacto negativo (-8 pts). Saka suspenso, defensores em dúvida.',
  },
  'Real Madrid': {
    team: 'Real Madrid',
    news_count: 10,
    impact_score: 8,
    sentiment: 'positive',
    key_headlines: [
      { title: 'Vinícius Jr em grande fase, 5 gols nos últimos 3 jogos', source: 'Marca', impact: 8, category: 'momentum' },
      { title: 'Bernabéu em festa com sequência invicta do Madrid', source: 'AS', impact: 6, category: 'momentum' },
    ],
    summary: 'Real Madrid: impacto positivo (+8 pts). Vinícius inspirado, time motivado.',
  },
  Barcelona: {
    team: 'Barcelona',
    news_count: 7,
    impact_score: -5,
    sentiment: 'negative',
    key_headlines: [
      { title: 'Lewandowski com dores e treina separado', source: 'Sport', impact: -10, category: 'injury' },
    ],
    summary: 'Barcelona: impacto neutro-negativo (-5 pts). Lewandowski em dúvida.',
  },
  Flamengo: {
    team: 'Flamengo',
    news_count: 12,
    impact_score: 10,
    sentiment: 'positive',
    key_headlines: [
      { title: 'Gabigol titular no Maracanã após recuperação', source: 'ge.globo', impact: 10, category: 'return' },
      { title: 'Flamengo entra em campo para conquistar liderança', source: 'UOL Esporte', impact: 8, category: 'motivation' },
    ],
    summary: 'Flamengo: impacto positivo (+10 pts). Gabigol de volta, time motivado pela liderança.',
  },
  Palmeiras: {
    team: 'Palmeiras',
    news_count: 9,
    impact_score: -3,
    sentiment: 'neutral',
    key_headlines: [
      { title: 'Palmeiras viajou 4h para chegar ao Rio', source: 'GE', impact: -5, category: 'fatigue_travel' },
    ],
    summary: 'Palmeiras: sem grandes destaques. Leve desvantagem de viagem.',
  },
};

export function getMockMatch(matchId) {
  return DEMO_MATCHES.find((m) => m.match_id === matchId) || DEMO_MATCHES[0];
}

export function getMockNews(teamName) {
  return DEMO_NEWS[teamName] || {
    team: teamName,
    news_count: 0,
    impact_score: 0,
    sentiment: 'neutral',
    key_headlines: [],
    summary: `Sem notícias recentes para ${teamName} (modo demo).`,
  };
}
