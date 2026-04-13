import { oddsApi } from '../utils/api-client.js';

export async function trackOdds(matchData) {
  console.log(`📈 [Odds Tracker] Monitorando movimentos de odds...`);

  const sport = 'soccer';
  let liveOdds = null;

  // Fonte exclusiva de odds: Superbet (superbet.bet.br)
  // As odds chegam via matchData.odds coletadas pelo aggregator (getSuperbetOdds)
  // Não há chamada a APIs externas de terceiros — tudo vem da Superbet diretamente.

  const currentOdds = matchData.odds || {};
  const movement = detectMovement(matchData.odds, currentOdds);
  const bestOdds = findBestOdds(currentOdds);
  const alerts = generateAlerts(movement);

  return {
    match: matchData.match,
    current_odds: currentOdds,
    movement,
    best_odds: bestOdds,
    alerts,
    market_sentiment: deriveSentiment(movement),
  };
}

function extractOddsFromEvent(event) {
  if (!event) return null;

  const result = {};
  for (const bookmaker of event.bookmakers || []) {
    const name = bookmaker.key;
    for (const market of bookmaker.markets || []) {
      if (market.key === 'h2h') {
        result[name] = {
          home_win: +market.outcomes.find((o) => o.name === event.home_team)?.price || null,
          draw:     +market.outcomes.find((o) => o.name === 'Draw')?.price || null,
          away_win: +market.outcomes.find((o) => o.name === event.away_team)?.price || null,
        };
      }
      if (market.key === 'totals') {
        const over = market.outcomes.find((o) => o.name === 'Over' && o.point === 2.5);
        if (over && result[name]) result[name].over_2_5 = +over.price;
      }
    }
  }

  return Object.keys(result).length ? result : null;
}

function detectMovement(opening, current) {
  if (!opening || !current) return {};

  const movement = {};
  const houses = [...new Set([...Object.keys(opening), ...Object.keys(current)])];

  for (const house of houses) {
    const open = opening[house] || {};
    const curr = current[house] || {};
    movement[house] = {};

    for (const market of ['home_win', 'draw', 'away_win', 'over_2_5']) {
      const o = open[market], c = curr[market];
      if (!o || !c) continue;

      const change = +(c - o).toFixed(3);
      const pct = +((change / o) * 100).toFixed(1);
      let signal = 'neutral';

      if (Math.abs(pct) >= 10) signal = change < 0 ? 'steam_move_shorten' : 'steam_move_drift';
      else if (Math.abs(pct) >= 5) signal = change < 0 ? 'shortening' : 'drifting';

      movement[house][market] = { change, pct, signal };
    }
  }

  return movement;
}

function findBestOdds(odds) {
  const best = {};
  const markets = ['home_win', 'draw', 'away_win', 'over_2_5', 'btts'];

  for (const market of markets) {
    let bestHouse = null, bestOdd = 0;
    for (const [house, houseOdds] of Object.entries(odds)) {
      const val = houseOdds?.[market];
      if (val && val > bestOdd) { bestOdd = val; bestHouse = house; }
    }
    if (bestHouse) best[market] = { house: bestHouse, odds: bestOdd };
  }

  return best;
}

function generateAlerts(movement) {
  const alerts = [];
  for (const [house, markets] of Object.entries(movement)) {
    for (const [market, data] of Object.entries(markets)) {
      if (data.signal?.includes('steam')) {
        const dir = data.change < 0 ? 'encurtando (sharp money)' : 'subindo (fuga de liquidez)';
        alerts.push(`⚡ Steam move em ${market} (${house}): odds ${dir} ${data.pct}%`);
      }
    }
  }
  return alerts;
}

function deriveSentiment(movement) {
  const signals = Object.values(movement).flatMap((m) => Object.values(m).map((v) => v.signal));
  const steamShortenings = signals.filter((s) => s === 'steam_move_shorten').length;
  const steamDrifts = signals.filter((s) => s === 'steam_move_drift').length;

  if (steamShortenings > 0) return 'sharp_money_home';
  if (steamDrifts > 0) return 'sharp_against_home';
  return 'neutral';
}
