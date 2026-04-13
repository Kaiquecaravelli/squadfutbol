/**
 * historical-backfill.js — Coleta dados históricos reais do SofaScore
 *
 * Coleta os últimos N dias de partidas encerradas nas top ligas e adiciona
 * os resultados reais à calibração do PIE — sem dados sintéticos.
 *
 * Para cada partida coletada avalia todos os mercados com base no
 * placar final e estatísticas reais (escanteios, cartões).
 *
 * Uso:
 *   node scripts/historical-backfill.js              → últimos 60 dias
 *   node scripts/historical-backfill.js --days=30    → últimos 30 dias
 *   node scripts/historical-backfill.js --days=90    → últimos 90 dias
 *   node scripts/historical-backfill.js --dry-run    → coleta sem salvar no PIE
 *   node scripts/historical-backfill.js --reset      → reseta calibração antes de adicionar
 */
import 'dotenv/config';
import axios from 'axios';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, '../data/pie.json');
const CACHE_DIR = join(__dir, '../data/historical-cache');
const PROGRESS_PATH = join(__dir, '../data/historical-progress.json');

const ARGS     = process.argv.slice(2);
const DRY_RUN  = ARGS.includes('--dry-run');
const RESET    = ARGS.includes('--reset');
const DAYS_ARG = ARGS.find(a => a.startsWith('--days='));
const DAYS     = DAYS_ARG ? parseInt(DAYS_ARG.split('=')[1]) : 60;

const SOFA_BASE = 'https://api.sofascore.com/api/v1';
const HEADERS   = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.sofascore.com/',
};

// Ligas de referência para calibração (tier 1 + 2)
const TARGET_LEAGUES = new Set([
  17,   // Premier League
  8,    // La Liga
  23,   // Serie A (ITA)
  35,   // Bundesliga
  34,   // Ligue 1
  325,  // Brasileirão Série A
  7,    // Champions League
  679,  // Copa do Brasil
  390,  // Eredivisie
  155,  // Primeira Liga (POR)
  37,   // Jupiler Pro League
  130,  // Super Lig
  238,  // MLS
  329,  // Europa League
  480,  // Conference League
  242,  // Serie A (BRA) Season
]);

const DELAY_MS = 800; // respeita rate-limit
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── SofaScore helpers ─────────────────────────────────────────────────────────
async function sofaGet(path, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.get(`${SOFA_BASE}${path}`, { headers: HEADERS, timeout: 15_000 });
      return res.data;
    } catch (err) {
      if (err.response?.status === 429) { await sleep(i * 6000); continue; }
      if (i === retries) return null;
      await sleep(i * 2000);
    }
  }
  return null;
}

async function fetchDayMatches(date) {
  const data = await sofaGet(`/sport/football/scheduled-events/${date}`);
  if (!data?.events) return [];
  return data.events.filter(e =>
    e.status?.type === 'finished' &&
    e.homeScore?.current != null &&
    e.awayScore?.current != null &&
    TARGET_LEAGUES.has(e.tournament?.uniqueTournament?.id)
  );
}

async function fetchMatchStats(eventId) {
  await sleep(DELAY_MS);
  const data = await sofaGet(`/event/${eventId}/statistics`);
  if (!data?.statistics) return null;

  const allPeriod = data.statistics.find(s => s.period === 'ALL') || data.statistics[0];
  if (!allPeriod?.groups) return null;

  const stats = {};
  for (const group of allPeriod.groups) {
    for (const item of group.statisticsItems || []) {
      const key = item.name?.toLowerCase().replace(/\s+/g, '_');
      if (key) stats[key] = { home: parseInt(item.home) || 0, away: parseInt(item.away) || 0 };
    }
  }

  const g = f => stats[f] || null;
  const corners = g('corner_kicks') || g('corners') || { home: 0, away: 0 };
  const yc      = g('yellow_cards') || { home: 0, away: 0 };

  return {
    corners_total: (corners.home || 0) + (corners.away || 0),
    yc_total:      (yc.home || 0) + (yc.away || 0),
  };
}

// ── Avaliação de mercados por resultado real ──────────────────────────────────
function evaluateMarkets(homeGoals, awayGoals, stats) {
  const total   = homeGoals + awayGoals;
  const btts    = homeGoals > 0 && awayGoals > 0;
  const corners = stats?.corners_total ?? null;
  const yc      = stats?.yc_total ?? null;

  const outcomes = [
    { market: 'Over 1.5',  acertou: total > 1 },
    { market: 'Over 2.5',  acertou: total > 2 },
    { market: 'Over 3.5',  acertou: total > 3 },
    { market: 'BTTS',      acertou: btts },
    { market: 'Home Win',  acertou: homeGoals > awayGoals },
    { market: 'Away Win',  acertou: awayGoals > homeGoals },
    { market: 'Draw',      acertou: homeGoals === awayGoals },
    { market: '1X',        acertou: homeGoals >= awayGoals },
    { market: 'X2',        acertou: awayGoals >= homeGoals },
  ];

  if (corners !== null) {
    outcomes.push({ market: 'Over Corners 6.5', acertou: corners > 6 });
    outcomes.push({ market: 'Over Corners 7.5', acertou: corners > 7 });
    outcomes.push({ market: 'Over Corners 8.5', acertou: corners > 8 });
    outcomes.push({ market: 'Over Corners 9.5', acertou: corners > 9 });
  }

  if (yc !== null) {
    outcomes.push({ market: 'YC 2.5', acertou: yc > 2 });
    outcomes.push({ market: 'YC 3.5', acertou: yc > 3 });
    outcomes.push({ market: 'YC 4.5', acertou: yc > 4 });
  }

  return outcomes;
}

// ── Calibração helpers ────────────────────────────────────────────────────────
function probRange(p) {
  const n = Number(p) || 75;
  if (n < 50)  return '<50';
  if (n < 60)  return '50-60';
  if (n < 70)  return '60-70';
  if (n < 80)  return '70-80';
  if (n < 85)  return '80-85';
  if (n < 90)  return '85-90';
  return '90+';
}

function updateCalib(calibration, market, acertou, competition, prob = 75) {
  if (!calibration[market]) calibration[market] = { total: 0, hits: 0, byRange: {}, byCompetition: {} };
  const c   = calibration[market];
  const hit = acertou ? 1 : 0;
  const rng = probRange(prob);

  c.total++;
  c.hits += hit;

  if (!c.byRange[rng]) c.byRange[rng] = { total: 0, hits: 0 };
  c.byRange[rng].total++;
  c.byRange[rng].hits += hit;

  if (competition) {
    const comp = String(competition).slice(0, 40);
    if (!c.byCompetition[comp]) c.byCompetition[comp] = { total: 0, hits: 0 };
    c.byCompetition[comp].total++;
    c.byCompetition[comp].hits += hit;
  }
}

// ── Progress tracker ──────────────────────────────────────────────────────────
function loadProgress() {
  try { return JSON.parse(readFileSync(PROGRESS_PATH, 'utf8')); }
  catch { return { processedDates: [], processedEvents: [] }; }
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf8');
}

// ── Relatório ─────────────────────────────────────────────────────────────────
function printReport(calibration, label) {
  console.log(chalk.bold(`\n${label}`));

  const RELEVANT = ['Over 1.5','Over 2.5','Over 3.5','BTTS','Home Win','Away Win','Draw','1X','X2',
                    'Over Corners 6.5','Over Corners 7.5','Over Corners 8.5','YC 2.5','YC 3.5','YC 4.5'];

  for (const mkt of RELEVANT) {
    const c = calibration[mkt];
    if (!c || c.total === 0) {
      console.log(`  ⬜ ${mkt.padEnd(24)}  sem dados`);
      continue;
    }
    const acc    = (c.hits / c.total * 100).toFixed(1);
    const gate   = c.total >= 30 ? (parseFloat(acc) >= 70 ? chalk.green('✅ PASSA GATE') : chalk.red('❌ NÃO PASSA')) : chalk.gray('🔵 poucas amostras');
    console.log(`  ${gate}  ${mkt.padEnd(24)} ${String(c.total).padStart(5)} amostras  ${acc}%`);
  }
}

// ── Pipeline principal ────────────────────────────────────────────────────────
async function run() {
  console.log('\n' + '═'.repeat(64));
  console.log(`  📡 Historical Backfill — SofaScore (${DAYS} dias)`);
  console.log(`  Modo: ${DRY_RUN ? 'DRY-RUN' : 'REAL'}${RESET ? ' + RESET CALIBRAÇÃO' : ''}`);
  console.log('═'.repeat(64) + '\n');

  mkdirSync(CACHE_DIR, { recursive: true });

  const db       = JSON.parse(readFileSync(DB_PATH, 'utf8'));
  const progress = loadProgress();
  const processed = new Set(progress.processedEvents || []);

  // Reset calibração se solicitado
  if (RESET && !DRY_RUN) {
    console.log(chalk.yellow('🔄 Resetando calibração antes de adicionar dados históricos...\n'));
    db.calibration = {};
  }

  // Gera lista de datas a processar (do mais recente para o mais antigo)
  const dates = [];
  for (let i = 1; i <= DAYS; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    dates.push(d.toISOString().split('T')[0]);
  }

  const todosDates = dates.filter(d => !progress.processedDates?.includes(d));
  console.log(`  📅 ${dates.length} dias no período | ${todosDates.length} ainda não processados\n`);

  if (todosDates.length === 0) {
    console.log(chalk.green('  ✅ Todos os dias já foram processados!'));
    printReport(db.calibration, '📊 Calibração atual:');
    return;
  }

  let totalMatches = 0;
  let totalOutcomes = 0;
  let datesOk = 0;

  for (let di = 0; di < todosDates.length; di++) {
    const date = todosDates[di];
    process.stdout.write(`\r  📅 [${di + 1}/${todosDates.length}] ${date} — coletando...`.padEnd(60));

    // Cache local para não rebuscar
    const cachePath = join(CACHE_DIR, `${date}.json`);
    let events;

    if (existsSync(cachePath)) {
      events = JSON.parse(readFileSync(cachePath, 'utf8'));
    } else {
      events = await fetchDayMatches(date);
      if (!DRY_RUN) writeFileSync(cachePath, JSON.stringify(events), 'utf8');
    }

    if (!events?.length) {
      process.stdout.write(`\r  📅 [${di + 1}/${todosDates.length}] ${date} — 0 partidas nas ligas alvo\n`);
      if (!DRY_RUN) {
        progress.processedDates = progress.processedDates || [];
        progress.processedDates.push(date);
        saveProgress(progress);
      }
      continue;
    }

    let dayMatches = 0;
    for (const event of events) {
      const eventId = event.id;
      if (processed.has(String(eventId))) continue;

      const homeGoals = event.homeScore.current;
      const awayGoals = event.awayScore.current;
      const comp      = event.tournament?.name || '';

      // Busca estatísticas (escanteios, cartões)
      const stats = await fetchMatchStats(eventId);

      // Avalia todos os mercados com base no resultado real
      const outcomes = evaluateMarkets(homeGoals, awayGoals, stats);

      if (!DRY_RUN) {
        for (const o of outcomes) {
          updateCalib(db.calibration, o.market, o.acertou, comp);
        }
        processed.add(String(eventId));
        totalOutcomes += outcomes.length;
      }

      dayMatches++;
      totalMatches++;
    }

    process.stdout.write(`\r  📅 [${di + 1}/${todosDates.length}] ${date} — ${dayMatches} partidas | ${totalMatches} total\n`);

    if (!DRY_RUN) {
      progress.processedDates = progress.processedDates || [];
      progress.processedDates.push(date);
      progress.processedEvents = [...processed];

      // Salva PIE a cada 5 dias (crash-safe)
      if ((di + 1) % 5 === 0 || di === todosDates.length - 1) {
        writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
        saveProgress(progress);
        process.stdout.write(chalk.gray(`  💾 Progresso salvo (${di + 1}/${todosDates.length} dias)\n`));
      }
    }

    datesOk++;
  }

  // Salva final
  if (!DRY_RUN) {
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    saveProgress(progress);
  }

  // Relatório final
  console.log('\n' + '═'.repeat(64));
  console.log(`  ✅ Processados: ${totalMatches} partidas | ${totalOutcomes} outcomes | ${datesOk} dias`);
  console.log('═'.repeat(64));

  printReport(db.calibration, '📊 Calibração após historical backfill:');

  // Mercados que agora passam no gate
  console.log(chalk.bold('\n🎯 Resumo de gates (≥30 amostras, ≥70% acurácia):'));
  let passam = 0;
  for (const [mkt, c] of Object.entries(db.calibration)) {
    if (c.total < 30) continue;
    const acc = c.hits / c.total * 100;
    if (acc >= 70) {
      console.log(chalk.green(`  ✅ ${mkt.padEnd(24)} ${c.total} amostras — ${acc.toFixed(1)}%`));
      passam++;
    }
  }
  if (passam === 0) console.log(chalk.yellow('  Nenhum mercado passa o gate ainda — colete mais dados'));
  console.log('');
}

run().catch(e => {
  console.error(chalk.red(`\nERRO: ${e.message}`));
  process.exit(1);
});
