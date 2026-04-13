#!/usr/bin/env node
/**
 * sofascore-collector.js
 * Coleta automaticamente resultados do SofaScore e converte para daily-matches.
 *
 * Uso:
 *   node scripts/sofascore-collector.js              # coleta ontem
 *   node scripts/sofascore-collector.js 2026-04-10   # data específica
 *   node scripts/sofascore-collector.js --auto        # coleta + injeta no PIE automaticamente
 *   node scripts/sofascore-collector.js --leagues     # lista ligas disponíveis
 */

import axios from 'axios';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');
const DIR   = join(ROOT, 'data/daily-matches');

// ── SofaScore API ──────────────────────────────────────────────────────────────
const SOFA_BASE = 'https://api.sofascore.com/api/v1';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://www.sofascore.com/',
  'Origin': 'https://www.sofascore.com',
  'Cache-Control': 'no-cache',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Ligas prioritárias (classificadas por liquidez + dados disponíveis) ──────
// Formato: { id, name, country, tier } — tier 1=elite, 2=premium, 3=tracking
const PRIORITY_LEAGUES = [
  // Tier 1 — Máxima liquidez e dados completos
  { id: 17,   name: 'Premier League',         country: 'ENG', tier: 1 },
  { id: 8,    name: 'La Liga',                country: 'ESP', tier: 1 },
  { id: 23,   name: 'Serie A',                country: 'ITA', tier: 1 },
  { id: 35,   name: 'Bundesliga',             country: 'GER', tier: 1 },
  { id: 34,   name: 'Ligue 1',                country: 'FRA', tier: 1 },
  { id: 325,  name: 'Brasileirão Série A',    country: 'BRA', tier: 1 },
  { id: 7,    name: 'Champions League',       country: 'EUR', tier: 1 },
  // Tier 2 — Alta liquidez
  { id: 679,  name: 'Copa do Brasil',         country: 'BRA', tier: 2 },
  { id: 390,  name: 'Eredivisie',             country: 'NED', tier: 2 },
  { id: 155,  name: 'Primeira Liga',          country: 'POR', tier: 2 },
  { id: 37,   name: 'Jupiler Pro League',     country: 'BEL', tier: 2 },
  { id: 130,  name: 'Super Lig',             country: 'TUR', tier: 2 },
  { id: 238,  name: 'MLS',                   country: 'USA', tier: 2 },
  { id: 8,    name: 'Europa League',         country: 'EUR', tier: 2 },
  // Tier 3 — Acompanhamento para PIE
  { id: 325,  name: 'Brasileirão Série B',   country: 'BRA', tier: 3 },
  { id: 981,  name: 'Campeonato Paulista',   country: 'BRA', tier: 3 },
  { id: 982,  name: 'Campeonato Carioca',    country: 'BRA', tier: 3 },
];

// ── Utilitários ────────────────────────────────────────────────────────────────
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

async function sofaGet(path, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.get(`${SOFA_BASE}${path}`, {
        headers: HEADERS,
        timeout: 20_000,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        const delay = i * 5000;
        process.stdout.write(` [429 rate-limit, aguardando ${delay/1000}s]`);
        await sleep(delay);
        continue;
      }
      if (i === retries) throw err;
      await sleep(i * 2000);
    }
  }
}

// ── Coleta de estatísticas de uma partida ─────────────────────────────────────
async function fetchMatchStats(eventId) {
  try {
    const data = await sofaGet(`/event/${eventId}/statistics`);
    const allPeriod = data.statistics?.find(s => s.period === 'ALL');
    if (!allPeriod) return {};

    const stats = {};
    for (const group of allPeriod.groups || []) {
      for (const item of group.statisticsItems || []) {
        const key = item.name?.toLowerCase().replace(/\s+/g, '_');
        stats[key] = { home: item.home, away: item.away };
      }
    }

    // Normaliza campos para o formato do PIE
    const g = (field) => {
      const v = stats[field];
      return v ? { home: parseInt(v.home) || 0, away: parseInt(v.away) || 0 } : null;
    };

    const shots    = g('total_shots') || g('shots') || {};
    const onTarget = g('shots_on_target') || g('on_target') || {};
    const corners  = g('corner_kicks') || g('corners') || {};
    const yc       = g('yellow_cards') || {};
    const rc       = g('red_cards') || {};
    const poss     = g('ball_possession') || {};
    const fouls    = g('fouls') || {};

    return {
      shots_home:            shots.home || 0,
      shots_away:            shots.away || 0,
      shots_on_goal_home:    onTarget.home || 0,
      shots_on_goal_away:    onTarget.away || 0,
      possession_home:       poss.home ? parseInt(String(poss.home).replace('%','')) : 50,
      possession_away:       poss.away ? parseInt(String(poss.away).replace('%','')) : 50,
      corners_home:          corners.home || 0,
      corners_away:          corners.away || 0,
      yellow_cards_home:     yc.home || 0,
      yellow_cards_away:     yc.away || 0,
      red_cards_home:        rc.home || 0,
      red_cards_away:        rc.away || 0,
      fouls_home:            fouls.home || 0,
      fouls_away:            fouls.away || 0,
    };
  } catch {
    return {};
  }
}

// ── Converte evento SofaScore para formato daily-matches ──────────────────────
async function convertEvent(event) {
  const homeGoals = event.homeScore?.current ?? null;
  const awayGoals = event.awayScore?.current ?? null;

  if (homeGoals === null || awayGoals === null) return null;

  const htHome = event.homeScore?.period1 ?? null;
  const htAway = event.awayScore?.period1 ?? null;

  // Aguarda levemente para não saturar a API
  await sleep(400);
  const matchStats = await fetchMatchStats(event.id);

  return {
    match:       `${event.homeTeam.name} vs ${event.awayTeam.name}`,
    competition: event.tournament?.name || 'Unknown',
    sofa_id:     event.id,
    result: {
      home_goals: homeGoals,
      away_goals: awayGoals,
      placar: `${homeGoals}-${awayGoals}`,
    },
    ht_score: htHome !== null ? { home: htHome, away: htAway } : null,
    match_stats: matchStats,
    pre_match: {
      home: { team: event.homeTeam.name, position: null, form: null, goals_avg: null },
      away: { team: event.awayTeam.name, position: null, form: null, goals_avg: null },
    },
    notes: `SofaScore ID: ${event.id} | Liga: ${event.tournament?.uniqueTournament?.name || event.tournament?.name}`,
  };
}

// ── Coleta eventos de uma data via SofaScore ──────────────────────────────────
async function collectDate(date) {
  console.log(`\n📡 [SofaScore] Coletando: ${date}`);

  let allEvents = [];

  // SofaScore retorna todos os esportes — filtramos football
  try {
    const data = await sofaGet(`/sport/football/scheduled-events/${date}`);
    allEvents = data.events || [];
  } catch (e) {
    // Tenta endpoint alternativo
    try {
      const data = await sofaGet(`/sport/football/events/last/${date}`);
      allEvents = data.events || [];
    } catch {
      console.error(`  ❌ Falha ao acessar SofaScore para ${date}: ${e.message}`);
      return null;
    }
  }

  // Filtra apenas partidas encerradas
  const finished = allEvents.filter(e =>
    e.status?.type === 'finished' &&
    e.homeScore?.current !== undefined &&
    e.awayScore?.current !== undefined
  );

  console.log(`  Total de partidas encerradas: ${finished.length}`);

  // Filtra por ligas prioritárias (tiers 1 e 2) ou todas se nenhuma encontrada
  const priorityIds = new Set(PRIORITY_LEAGUES.map(l => l.id));
  const prioritized = finished.filter(e =>
    priorityIds.has(e.tournament?.uniqueTournament?.id || e.tournament?.id)
  );

  const toProcess = prioritized.length > 0 ? prioritized : finished.slice(0, 60);
  console.log(`  Partidas priorizadas (ligas elite): ${toProcess.length}`);

  const matches = [];
  let processed = 0;
  for (const event of toProcess) {
    process.stdout.write(`\r  Convertendo ${++processed}/${toProcess.length}: ${event.homeTeam.name} vs ${event.awayTeam.name}`.padEnd(80));
    const converted = await convertEvent(event);
    if (converted) matches.push(converted);
  }
  console.log('\n');

  return {
    date,
    source: 'sofascore.com',
    collected_at: new Date().toISOString(),
    total_events_available: finished.length,
    matches,
  };
}

// ── Merge com arquivo existente (evita duplicatas) ────────────────────────────
function mergeWithExisting(filePath, newData) {
  if (!existsSync(filePath)) return newData;

  try {
    const existing = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (existing._instructions) return newData; // template — substituir

    const existingIds = new Set(
      (existing.matches || []).map(m => m.sofa_id).filter(Boolean)
    );
    const newMatches = newData.matches.filter(m => !existingIds.has(m.sofa_id));

    return {
      ...existing,
      source: `${existing.source} + sofascore.com`,
      merged_at: new Date().toISOString(),
      matches: [...(existing.matches || []), ...newMatches],
    };
  } catch {
    return newData;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const auto    = args.includes('--auto');
const leagues = args.includes('--leagues');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date    = dateArg || yesterday();

if (leagues) {
  console.log('\n📋 Ligas monitoradas pelo SofaScore Collector:\n');
  for (const tier of [1, 2, 3]) {
    const list = PRIORITY_LEAGUES.filter(l => l.tier === tier);
    console.log(`  Tier ${tier}:`);
    for (const l of list) console.log(`    • ${l.name} (${l.country}) — ID ${l.id}`);
  }
  process.exit(0);
}

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

const data = await collectDate(date);

if (!data || data.matches.length === 0) {
  console.log(`⚠️  Nenhuma partida coletada para ${date}`);
  process.exit(1);
}

const filePath = join(DIR, `${date}.json`);
const finalData = mergeWithExisting(filePath, data);

writeFileSync(filePath, JSON.stringify(finalData, null, 2), 'utf-8');

const btts = finalData.matches.filter(m => (m.result?.home_goals || 0) >= 1 && (m.result?.away_goals || 0) >= 1).length;

console.log(`✅ Coleta concluída: ${finalData.matches.length} partidas salvas → data/daily-matches/${date}.json`);
console.log(`   BTTS (qualificadas p/ PIE): ${btts} partidas`);

if (auto) {
  console.log('\n🔄 Modo --auto: injetando no PIE...\n');
  const { execSync } = await import('child_process');
  execSync(`node scripts/daily-pie-update.js ${date}`, { stdio: 'inherit', cwd: ROOT });
}
