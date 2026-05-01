#!/usr/bin/env node
/**
 * calibrate-resultado-final-retro.js
 * Calibração retroativa do mercado "Resultado Final" usando fan votes do SofaScore.
 *
 * Para cada partida histórica em data/daily-matches/:
 *   1. Busca fan votes (vote1/voteX/vote2) via SofaScore API
 *   2. Determina a probabilidade do resultado real (quem ganhou vs probabilidade atribuída)
 *   3. Injeta no PIE calibration com _updateCalibration
 *
 * Uso:
 *   node scripts/calibrate-resultado-final-retro.js          # processa tudo
 *   node scripts/calibrate-resultado-final-retro.js --limit 50  # apenas 50 matches
 *   node scripts/calibrate-resultado-final-retro.js --dry      # preview sem salvar
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const DB_PATH    = join(ROOT, 'data/pie.json');
const DONE_PATH  = join(ROOT, 'data/rf-retro-done.json');
const MATCHES_DIR = join(ROOT, 'data/daily-matches');

const SOFA_BASE = 'https://api.sofascore.com/api/v1';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Referer': 'https://www.sofascore.com/',
  'Origin': 'https://www.sofascore.com',
  'X-Requested-With': 'XMLHttpRequest',
};

const args  = process.argv.slice(2);
const DRY   = args.includes('--dry');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1]) || 999 : 999; })();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _probRange(prob) {
  if (prob >= 95) return '95+';
  if (prob >= 90) return '90-95';
  if (prob >= 85) return '85-90';
  if (prob >= 80) return '80-85';
  if (prob >= 70) return '70-80';
  if (prob >= 60) return '60-70';
  return '<60';
}

function updateCalibration(db, market, prob, acertou, competition) {
  if (!db.calibration[market]) {
    db.calibration[market] = { total: 0, hits: 0, byRange: {}, byCompetition: {} };
  }
  const c    = db.calibration[market];
  const fxP  = Number(prob) || 0;
  const hit  = acertou ? 1 : 0;
  const range = _probRange(fxP);

  c.total++;
  c.hits += hit;

  if (!c.byRange[range]) c.byRange[range] = { total: 0, hits: 0 };
  c.byRange[range].total++;
  c.byRange[range].hits += hit;

  if (competition) {
    const comp = competition.slice(0, 40);
    if (!c.byCompetition[comp]) c.byCompetition[comp] = { total: 0, hits: 0 };
    c.byCompetition[comp].total++;
    c.byCompetition[comp].hits += hit;
  }
}

async function fetchVotes(sofaId) {
  try {
    const res = await axios.get(`${SOFA_BASE}/event/${sofaId}/votes`, {
      headers: HEADERS, timeout: 6000,
    });
    const v = res.data?.vote;
    if (!v) return null;
    const total = (v.vote1 || 0) + (v.vote2 || 0) + (v.voteX || 0);
    if (total < 100) return null; // muito poucos votos — ignorar
    return {
      home: Math.round((v.vote1 / total) * 100),
      draw: Math.round((v.voteX / total) * 100),
      away: Math.round((v.vote2 / total) * 100),
    };
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Carrega IDs já processados (para resumir em caso de interrupção)
let done = new Set();
if (existsSync(DONE_PATH)) {
  try { done = new Set(JSON.parse(readFileSync(DONE_PATH, 'utf-8'))); } catch {}
}

// Lê todos os matches históricos
const files = readdirSync(MATCHES_DIR).sort();
const allMatches = [];
for (const f of files) {
  try {
    const data = JSON.parse(readFileSync(join(MATCHES_DIR, f), 'utf-8'));
    for (const m of (data.matches || [])) {
      if (m.sofa_id && m.result?.home_goals != null && m.result?.away_goals != null) {
        allMatches.push({ ...m, _file: f });
      }
    }
  } catch {}
}

const pending = allMatches.filter(m => !done.has(String(m.sofa_id)));
const toProcess = pending.slice(0, LIMIT);

console.log(`\n🎯 Calibração Retroativa — Resultado Final`);
console.log(`   Total histórico  : ${allMatches.length} partidas`);
console.log(`   Já processadas   : ${done.size}`);
console.log(`   A processar agora: ${toProcess.length}${DRY ? '  [DRY RUN]' : ''}`);
console.log('═'.repeat(60));

// Carrega DB (apenas se não for dry)
let db = null;
if (!DRY) {
  try { db = JSON.parse(readFileSync(DB_PATH, 'utf-8')); } catch { db = { calibration: {} }; }
  if (!db.calibration) db.calibration = {};
}

let injected = 0, skipped = 0, errors = 0;
const stats = { ranges: {}, competitions: {} };

for (let i = 0; i < toProcess.length; i++) {
  const m = toProcess[i];
  const homeGoals = m.result.home_goals;
  const awayGoals = m.result.away_goals;

  // Determinar resultado real
  const outcome = homeGoals > awayGoals ? 'home' : awayGoals > homeGoals ? 'away' : 'draw';

  // Buscar fan votes
  const votes = await fetchVotes(m.sofa_id);
  if (!votes) { skipped++; await sleep(250); continue; }

  // Estratégia: guardar a prob do resultado real (calibração honesta)
  // Também guarda o "mais provável" para saber se o modelo teria acertado
  const probWinner = votes[outcome];
  const acertou    = probWinner >= 50; // "apostaria" no favorito → acertou se era o mais provável

  // Mais rico: guardar os 3 outcomes individualmente
  const outcomes3 = [
    { prob: votes.home, won: outcome === 'home' },
    { prob: votes.draw, won: outcome === 'draw' },
    { prob: votes.away, won: outcome === 'away' },
  ];

  const comp = (m.competition || '').replace(/,.*$/, '').trim();

  if (!DRY) {
    for (const o of outcomes3) {
      updateCalibration(db, 'Resultado Final', o.prob, o.won, comp);
    }
  }

  // Estatísticas locais
  for (const o of outcomes3) {
    const r = _probRange(o.prob);
    if (!stats.ranges[r]) stats.ranges[r] = { total: 0, hits: 0 };
    stats.ranges[r].total++;
    if (o.won) stats.ranges[r].hits++;
  }
  if (!stats.competitions[comp]) stats.competitions[comp] = 0;
  stats.competitions[comp]++;

  done.add(String(m.sofa_id));
  injected++;

  const pct = Math.round(i / toProcess.length * 100);
  if (i % 20 === 0) {
    process.stdout.write(`\r  Progresso: ${i + 1}/${toProcess.length} (${pct}%) — ${injected} injetados`);
  }

  await sleep(300); // rate limit: ~3 req/s
}

console.log(`\r  Concluído: ${toProcess.length}/${toProcess.length} (100%) — ${injected} injetados`);

// Salva DB e estado
if (!DRY && injected > 0) {
  const { lessons, ...dbWithout } = db;
  writeFileSync(DB_PATH, JSON.stringify({ ...dbWithout, lessons: [] }, null, 2), 'utf-8');
  writeFileSync(DONE_PATH, JSON.stringify([...done]), 'utf-8');
  console.log('\n✅ pie.json atualizado.');
}

// Resumo
console.log('\n📊 Distribuição por faixa de probabilidade:');
console.log('  Faixa     Total  Acertos  Precisão');
console.log('  ' + '─'.repeat(38));
const rangeOrder = ['<60', '60-70', '70-80', '80-85', '85-90', '90-95', '95+'];
for (const r of rangeOrder) {
  const s = stats.ranges[r];
  if (!s) continue;
  const pct = Math.round(s.hits / s.total * 100);
  const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
  const flag = pct >= 75 ? '✅' : pct >= 60 ? '🟡' : '🔴';
  console.log(`  ${r.padEnd(8)} ${String(s.total).padStart(5)}   ${String(s.hits).padStart(4)}    ${String(pct + '%').padStart(5)}  [${bar}] ${flag}`);
}

console.log('\n📍 Top 10 competições:');
Object.entries(stats.competitions)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .forEach(([comp, n]) => console.log(`   ${comp.padEnd(35)} ${n}`));

console.log(`\n  Total de outcomes injetados: ${injected * 3} (${injected} partidas × 3)`);
console.log(`  Partidas sem fan votes (puladas): ${skipped}`);
if (errors > 0) console.log(`  Erros de API: ${errors}`);

if (DRY) console.log('\n⚠️  Modo --dry: nenhum dado foi salvo.');
else console.log('\n✅ Calibração retroativa concluída!');
