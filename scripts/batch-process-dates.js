#!/usr/bin/env node
/**
 * batch-process-dates.js
 * Processa múltiplos arquivos de data de uma vez.
 *
 * Uso:
 *   node scripts/batch-process-dates.js                    # processa todos pendentes
 *   node scripts/batch-process-dates.js 2026-04-03,2026-04-05  # datas específicas
 *   node scripts/batch-process-dates.js --status           # mostra estado atual
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { batchSaveAnalysis, loadDB, getStats } from '../src/pie/pie-storage.js';
import { analyzeMatch } from './lib/match-analyzer.js';
import { isObsidianConfigured, updatePadroesAprendidos, updateRoiPerformance, rebuildDashboard } from '../src/utils/obsidian.js';

const __dir    = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dir, '..');
const DB_PATH  = join(ROOT, 'data/pie.json');
const HIST     = join(ROOT, 'data/historical-patterns.json');
const DIR      = join(ROOT, 'data/daily-matches');
const LOG      = join(ROOT, 'data/daily-matches/.processed.json');
const EXEC_LOG = join(ROOT, 'logs/pie-execucoes.jsonl');

function appendExecLog(entry) {
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    appendFileSync(EXEC_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* silencioso */ }
}

// ── Registro de datas processadas ────────────────────────────────────────────
function loadProcessed() {
  return existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf-8')) : {};
}
function markProcessed(date, summary) {
  const log = loadProcessed();
  log[date] = { ...summary, processed_at: new Date().toISOString() };
  writeFileSync(LOG, JSON.stringify(log, null, 2), 'utf-8');
}

// ── Salva lote de partidas no histórico (1 read + 1 write para N partidas) ─────
function batchSaveHistory(matches, date) {
  const hist = JSON.parse(readFileSync(HIST, 'utf-8'));
  let added = 0;
  for (const match of matches) {
    const slug    = (match.match || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 40);
    const matchId = `daily_${date.replace(/-/g, '')}_${slug}`;
    if (hist.matches.find(m => m.match_id === matchId)) continue;
    const r  = match.result || {};
    const s  = match.match_stats || {};
    const tg = (r.home_goals || 0) + (r.away_goals || 0);
    const tc = s.corners_total ?? ((s.corners_home || 0) + (s.corners_away || 0));
    const ty = (s.yellow_cards_home || 0) + (s.yellow_cards_away || 0);
    hist.matches.push({
      match_id: matchId, match: match.match, competition: match.competition,
      match_date: date, source: 'daily-update',
      result: r, ht_score: match.ht_score, goals_timeline: match.goals_timeline,
      match_stats: s, pre_match: match.pre_match, notes: match.notes,
      market_outcomes: [
        { market: 'BTTS',             won: r.home_goals > 0 && r.away_goals > 0 },
        { market: 'Over 1.5',         won: tg >= 2 },
        { market: 'Over 2.5',         won: tg >= 3 },
        { market: 'Over 3.5',         won: tg >= 4 },
        { market: 'Over Corners 8.5', won: tc > 8.5 },
        { market: 'Over Corners 7.5', won: tc > 7.5 },
        { market: 'Over Corners 6.5', won: tc > 6.5 },
        { market: 'YC 4.5',           won: ty > 4.5 },
        { market: 'YC 3.5',           won: ty > 3.5 },
        { market: 'YC 2.5',           won: ty > 2.5 },
      ],
      auto_analyzed: true,
    });
    added++;
  }
  writeFileSync(HIST, JSON.stringify(hist, null, 2), 'utf-8');
  return added;
}

// ── Processamento de uma data ─────────────────────────────────────────────────
function processDate(date, force = false) {
  const processed = loadProcessed();
  if (processed[date] && !force) {
    console.log(`  ⏭  ${date} já processada — use --force para reprocessar`);
    return null;
  }

  const file = join(DIR, `${date}.json`);
  if (!existsSync(file)) {
    console.log(`  ❌ ${date} — arquivo não encontrado: data/daily-matches/${date}.json`);
    return null;
  }

  let data;
  try { data = JSON.parse(readFileSync(file, 'utf-8')); }
  catch (e) { console.log(`  ❌ ${date} — JSON inválido: ${e.message}`); return null; }

  if (data._instructions) {
    console.log(`  ⚠️  ${date} — template não preenchido (campo _instructions ainda presente)`);
    return null;
  }

  const all       = data.matches || [];
  const qualified = all.filter(m => (m.result?.home_goals ?? 0) >= 1 && (m.result?.away_goals ?? 0) >= 1);
  if (qualified.length === 0) {
    console.log(`  ⚠️  ${date} — nenhuma partida com resultado >= 1:1`);
    return null;
  }

  const predId    = `daily_${date.replace(/-/g, '')}`;
  const analyses  = qualified.map(m => analyzeMatch(m));
  const totH      = batchSaveHistory(qualified, date);
  batchSaveAnalysis(analyses, predId);

  const totP = analyses.reduce((s, a) => s + a.positives.length, 0);
  const totL = analyses.reduce((s, a) => s + a.lessons.length, 0);
  const totC = analyses.reduce((s, a) => s + a.calibration.length, 0);
  const totW = analyses.reduce((s, a) => s + a.calibration.filter(x => x.acertou).length, 0);

  const summary = {
    matches: qualified.length, total_discarded: all.length - qualified.length,
    positives: totP, lessons: totL,
    calibration: totC, wins: totW, misses: totC - totW, new_history: totH,
  };
  markProcessed(date, summary);
  return summary;
}

// ── Status do sistema ─────────────────────────────────────────────────────────
function showStatus() {
  const db        = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
  const hist      = JSON.parse(readFileSync(HIST, 'utf-8'));
  const processed = loadProcessed();

  console.log('\n📊 PIE — Status Completo\n' + '═'.repeat(70));
  console.log('\n🗓  Datas processadas:');
  for (const [date, info] of Object.entries(processed).sort()) {
    console.log(`  ${date}  ${info.matches} jogos | +${info.positives}P +${info.lessons}L | ${info.wins}/${info.calibration} acertos`);
  }

  console.log('\n📈 Calibração por mercado (meta: 100 unidades):');
  const TARGET = 100;
  for (const [mkt, cal] of Object.entries(db.calibration).sort((a,b) => b[1].total - a[1].total)) {
    const pct   = ((cal.hits / cal.total) * 100).toFixed(1);
    const prog  = Math.round((cal.total / TARGET) * 20);
    const bar   = '█'.repeat(prog) + '░'.repeat(20 - prog);
    const falta = Math.max(0, TARGET - cal.total);
    console.log(`  ${mkt.padEnd(16)} ${String(cal.total).padStart(3)}/${TARGET}  ${bar}  ${pct.padStart(5)}%  ${falta > 0 ? 'faltam ' + falta : '✅ META ATINGIDA'}`);
  }

  const tot = db.stats.acertos + db.stats.erros;
  const pct = tot > 0 ? ((db.stats.acertos / tot) * 100).toFixed(1) : '0.0';
  console.log(`\n  Padrões positivos : ${db.positivePatterns.filter(p=>p.active).length}`);
  console.log(`  Lições ativas     : ${db.lessons.filter(l=>l.active).length}`);
  console.log(`  Partidas base     : ${hist.matches.length} jogos`);
  console.log(`  Taxa global       : ${pct}% (${db.stats.acertos} acertos)`);
  console.log('═'.repeat(70) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const force   = args.includes('--force');
const status  = args.includes('--status');

if (status) { showStatus(); process.exit(0); }

// Determina datas a processar
let dates;
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}/.test(a));
if (dateArg) {
  dates = dateArg.split(',').map(d => d.trim());
} else {
  // Processa todos os arquivos em data/daily-matches/
  dates = readdirSync(DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();
}

console.log(`\n🧠 PIE — Processamento em Lote`);
console.log(`   Datas a processar: ${dates.join(', ')}`);
console.log('═'.repeat(70));

let totalMatches = 0, totalP = 0, totalL = 0, totalW = 0, totalC = 0;

for (const date of dates) {
  process.stdout.write(`\n  📅 ${date} ... `);
  const result = processDate(date, force);
  if (result) {
    console.log(`✅ ${result.matches} jogos | +${result.positives}P +${result.lessons}L | ${result.wins}/${result.calibration} acertos`);
    totalMatches += result.matches;
    totalP += result.positives; totalL += result.lessons;
    totalW += result.wins; totalC += result.calibration;
  }
}

if (totalMatches > 0) {
  console.log('\n' + '─'.repeat(70));
  console.log(`  Total processado  : ${totalMatches} partidas`);
  console.log(`  Padrões injetados : ${totalP}`);
  console.log(`  Lições injetadas  : ${totalL}`);
  console.log(`  Acertos/Total cal : ${totalW}/${totalC}`);

  // Obsidian sync após lote
  if (isObsidianConfigured()) {
    process.stdout.write('\n🔄 Sincronizando Obsidian...');
    const db = loadDB();
    const stats = getStats();
    updatePadroesAprendidos(db.lessons.filter(l => l.active), db.calibration);
    updateRoiPerformance(stats);
    rebuildDashboard();
    console.log(' ✅ Vault atualizado em tempo real.');
  }

  appendExecLog({
    type: 'batch-update', dates, executed_at: new Date().toISOString(),
    total_matches: totalMatches, positives: totalP, lessons: totalL,
    wins: totalW, calibration: totalC,
    obsidian_synced: isObsidianConfigured(),
  });
}

showStatus();
