#!/usr/bin/env node
/**
 * Benchmark — Operação APEX Phase Delta
 * Avalia assertividade de cada agente/mercado contra resultados históricos reais.
 * Usa o PIE database como fonte de verdade.
 *
 * USO:
 *   npm run benchmark            → relatório completo
 *   npm run benchmark -- --json  → output JSON puro
 *   npm run benchmark -- --csv   → export CSV
 *   npm run benchmark -- --gate  → exit 1 se algum mercado abaixo do gate
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const PIE_PATH = join(__dir, '../data/pie.json');

// ── Quality Gates por mercado ─────────────────────────────────────────────────
const QUALITY_GATES = {
  'Over 1.5':         { min_accuracy: 80, min_samples: 30 },
  'Over 2.5':         { min_accuracy: 65, min_samples: 30 },
  'Over 3.5':         { min_accuracy: 55, min_samples: 20 },
  'BTTS':             { min_accuracy: 65, min_samples: 30 },
  'Over Corners 6.5': { min_accuracy: 70, min_samples: 20 },
  'Over Corners 7.5': { min_accuracy: 60, min_samples: 20 },
  'Over Corners 8.5': { min_accuracy: 55, min_samples: 20 },
  'YC Over 2.5':      { min_accuracy: 65, min_samples: 20 },
  'YC Over 3.5':      { min_accuracy: 50, min_samples: 20 },
  '1X':               { min_accuracy: 65, min_samples: 15 },
  'X2':               { min_accuracy: 50, min_samples: 15 },
  '12':               { min_accuracy: 65, min_samples: 15 },
  'Home Win':         { min_accuracy: 50, min_samples: 15 },
  'Away Win':         { min_accuracy: 45, min_samples: 15 },
  'Draw':             { min_accuracy: 30, min_samples: 10 },
  'Correct Score':    { min_accuracy: 18, min_samples: 10 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Carregar e processar dados do PIE
// ─────────────────────────────────────────────────────────────────────────────
function loadData() {
  if (!existsSync(PIE_PATH)) {
    console.error('❌ PIE database não encontrada:', PIE_PATH);
    process.exit(1);
  }
  return JSON.parse(readFileSync(PIE_PATH, 'utf-8'));
}

function buildMarketStats(db) {
  const stats = {};  // { [market]: { hits, total, by_prob_bucket, by_competition, recent } }

  // Deduplicação: cada par (match_name, market) conta UMA vez
  // Mantém a entrada mais recente quando há duplicatas
  const seen = new Map();  // key: match_name|market → { result, mo }
  for (const result of (db.results || [])) {
    for (const mo of (result.market_outcomes || [])) {
      const key = `${result.match_name}|${mo.market}`;
      const existing = seen.get(key);
      if (!existing || new Date(result.registered_at || 0) > new Date(existing.result.registered_at || 0)) {
        seen.set(key, { result, mo });
      }
    }
  }

  const totalRaw = (db.results || []).reduce((s, r) => s + (r.market_outcomes?.length || 0), 0);
  const totalDedup = seen.size;
  if (totalRaw !== totalDedup) {
    console.log(`  ♻️  Deduplicação: ${totalRaw} entradas → ${totalDedup} únicas (removidas ${totalRaw - totalDedup} duplicatas)`);
  }

  for (const { result, mo } of seen.values()) {
      const market = mo.market;
      if (!market) continue;

      if (!stats[market]) {
        stats[market] = { hits: 0, total: 0, skipped: 0, by_prob_bucket: {}, by_competition: {}, recent: [] };
      }

      const s = stats[market];
      s.total++;
      if (mo.acertou === true)  s.hits++;

      // Bucket de probabilidade
      const prob = mo.probabilidade || 0;
      const bucket = probBucket(prob);
      if (!s.by_prob_bucket[bucket]) s.by_prob_bucket[bucket] = { hits: 0, total: 0 };
      s.by_prob_bucket[bucket].total++;
      if (mo.acertou === true) s.by_prob_bucket[bucket].hits++;

      // Por competição
      const comp = result.competition || 'unknown';
      if (!s.by_competition[comp]) s.by_competition[comp] = { hits: 0, total: 0 };
      s.by_competition[comp].total++;
      if (mo.acertou === true) s.by_competition[comp].hits++;

      // Recentes (últimos 10)
      s.recent.push({ acertou: mo.acertou, match: result.match_name, date: result.registered_at || result.resolved_at });
  }

  // Calcular accuracy e limitar recentes
  for (const [market, s] of Object.entries(stats)) {
    s.accuracy = s.total > 0 ? Math.round((s.hits / s.total) * 1000) / 10 : 0;

    // Recentes: últimos 10 ordenados por data
    s.recent = s.recent
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 10);

    // Accuracy nos últimos 10
    const last10 = s.recent.slice(0, 10);
    const last10Hits = last10.filter((r) => r.acertou === true).length;
    s.accuracy_last10 = last10.length > 0 ? Math.round((last10Hits / last10.length) * 1000) / 10 : null;

    // Calibration curve (bucket actual vs expected)
    s.calibration_curve = buildCalibrationCurve(s.by_prob_bucket);
  }

  return stats;
}

function probBucket(prob) {
  if (prob >= 90) return '90+';
  if (prob >= 80) return '80-90';
  if (prob >= 70) return '70-80';
  if (prob >= 60) return '60-70';
  if (prob >= 50) return '50-60';
  return '<50';
}

function buildCalibrationCurve(byBucket) {
  const BUCKET_MID = { '90+': 92, '80-90': 85, '70-80': 75, '60-70': 65, '50-60': 55, '<50': 40 };
  return Object.entries(byBucket)
    .filter(([, v]) => v.total >= 3)
    .map(([bucket, v]) => ({
      bucket,
      predicted_pct: BUCKET_MID[bucket] || 0,
      actual_pct:    Math.round((v.hits / v.total) * 1000) / 10,
      n:             v.total,
      deviation:     Math.round((BUCKET_MID[bucket] - (v.hits / v.total) * 100) * 10) / 10,
    }))
    .sort((a, b) => b.predicted_pct - a.predicted_pct);
}

function buildGateResults(stats) {
  const gateResults = [];

  for (const [market, gate] of Object.entries(QUALITY_GATES)) {
    const s = stats[market];
    if (!s) {
      gateResults.push({ market, status: 'NO_DATA', samples: 0, accuracy: null, gate });
      continue;
    }

    const status = s.total < gate.min_samples
      ? 'INSUFFICIENT_DATA'
      : s.accuracy >= gate.min_accuracy
      ? 'PASS'
      : 'FAIL';

    gateResults.push({
      market,
      status,
      samples:       s.total,
      accuracy:      s.accuracy,
      accuracy_last10: s.accuracy_last10,
      gate,
      delta:         s.accuracy != null ? Math.round((s.accuracy - gate.min_accuracy) * 10) / 10 : null,
    });
  }

  return gateResults;
}

function buildRecentStreak(db) {
  const results = (db.results || [])
    .flatMap((r) => (r.market_outcomes || []).map((mo) => ({
      acertou:    mo.acertou,
      market:     mo.market,
      match:      r.match_name,
      date:       r.resolved_at || r.timestamp,
    })))
    .filter((r) => r.acertou === true || r.acertou === false)
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 20);

  let consecutive = 0;
  for (const r of results) {
    if (!r.acertou) consecutive++;
    else break;
  }

  return { consecutive_losses: consecutive, recent: results.slice(0, 10) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relatório terminal
// ─────────────────────────────────────────────────────────────────────────────
function printReport(stats, gateResults, streak, db) {
  const LINE = '═'.repeat(62);
  const sep  = '─'.repeat(62);

  console.log(`\n╔${LINE}╗`);
  console.log(`║  🏆 BENCHMARK — OPERAÇÃO APEX                            ║`);
  console.log(`║  ${new Date().toLocaleString('pt-BR').padEnd(58)}║`);
  console.log(`╠${LINE}╣`);

  // Resumo global
  const allResults = db.results || [];
  const totalDecisions = allResults.reduce((sum, r) => sum + (r.market_outcomes?.length || 0), 0);
  const totalHits      = allResults.reduce((sum, r) => sum + (r.market_outcomes?.filter((m) => m.acertou === true).length || 0), 0);
  const globalAcc      = totalDecisions > 0 ? ((totalHits / totalDecisions) * 100).toFixed(1) : 'N/A';

  console.log(`║  📊 RESUMO GLOBAL`);
  console.log(`║  Jogos analisados: ${allResults.length}  |  Decisões: ${totalDecisions}  |  Acertos: ${totalHits}`);
  console.log(`║  Precisão global: ${globalAcc}%`);
  if (streak.consecutive_losses >= 3) {
    console.log(`║  ⚠️  STREAK NEGATIVO: ${streak.consecutive_losses} perdas consecutivas`);
  }

  console.log(`╠${LINE}╣`);
  console.log(`║  📈 PRECISÃO POR MERCADO`);
  console.log(`║  ${'Mercado'.padEnd(22)} ${'Amostras'.padStart(8)} ${'Geral'.padStart(7)} ${'Últimas10'.padStart(9)} ${'Gate'.padStart(6)}`);
  console.log(`║  ${sep.slice(0, 54)}`);

  // Ordena por acurácia decrescente
  const sorted = Object.entries(stats).sort((a, b) => b[1].accuracy - a[1].accuracy);
  for (const [market, s] of sorted) {
    const gate   = QUALITY_GATES[market];
    const status = !gate ? '  —  '
                 : s.total < (gate?.min_samples || 0) ? ' N/A '
                 : s.accuracy >= gate.min_accuracy ? '  ✅  '
                 : '  ❌  ';
    const last10 = s.accuracy_last10 != null ? `${s.accuracy_last10}%` : '  —  ';
    console.log(`║  ${market.padEnd(22)} ${String(s.total).padStart(8)} ${String(s.accuracy + '%').padStart(7)} ${last10.padStart(9)} ${status.padStart(6)}`);
  }

  console.log(`╠${LINE}╣`);
  console.log(`║  🎯 QUALITY GATES`);

  const passes   = gateResults.filter((g) => g.status === 'PASS').length;
  const fails    = gateResults.filter((g) => g.status === 'FAIL').length;
  const noData   = gateResults.filter((g) => g.status === 'NO_DATA' || g.status === 'INSUFFICIENT_DATA').length;

  console.log(`║  ✅ PASS: ${passes}  ❌ FAIL: ${fails}  ⏳ Dados insuficientes: ${noData}`);
  console.log(`║`);

  for (const g of gateResults.filter((g) => g.status === 'FAIL')) {
    const delta = g.delta != null ? `(${g.delta > 0 ? '+' : ''}${g.delta}pp vs gate ${g.gate.min_accuracy}%)` : '';
    console.log(`║  ❌ ${g.market}: ${g.accuracy}% — ${g.samples} amostras ${delta}`);
  }

  for (const g of gateResults.filter((g) => g.status === 'INSUFFICIENT_DATA')) {
    console.log(`║  ⏳ ${g.market}: ${g.samples}/${g.gate.min_samples} amostras (aguardando dados)`);
  }

  console.log(`╠${LINE}╣`);

  // Curva de calibração do melhor mercado (Over 1.5)
  const best = stats['Over 1.5'] || stats['Over 2.5'];
  if (best?.calibration_curve?.length) {
    console.log(`║  🔬 CALIBRAÇÃO — Over 1.5/2.5`);
    console.log(`║  ${'Bucket'.padEnd(10)} ${'Previsto'.padStart(9)} ${'Real'.padStart(7)} ${'N'.padStart(5)} ${'Desvio'.padStart(8)}`);
    for (const c of best.calibration_curve) {
      const dev = c.deviation > 5 ? '⚠️ ' : c.deviation < -5 ? '📉 ' : '✅ ';
      console.log(`║  ${c.bucket.padEnd(10)} ${String(c.predicted_pct + '%').padStart(9)} ${String(c.actual_pct + '%').padStart(7)} ${String(c.n).padStart(5)} ${dev}${String(c.deviation + 'pp').padStart(6)}`);
    }
    console.log(`╠${LINE}╣`);
  }

  // Top competições
  console.log(`║  🌍 TOP 5 COMPETIÇÕES (acurácia geral)`);
  const compStats = {};
  for (const result of db.results || []) {
    const comp = result.competition || 'unknown';
    if (!compStats[comp]) compStats[comp] = { hits: 0, total: 0 };
    for (const mo of result.market_outcomes || []) {
      compStats[comp].total++;
      if (mo.acertou === true) compStats[comp].hits++;
    }
  }
  const topComps = Object.entries(compStats)
    .filter(([, v]) => v.total >= 5)
    .map(([c, v]) => ({ comp: c, acc: (v.hits / v.total * 100).toFixed(1), n: v.total }))
    .sort((a, b) => b.acc - a.acc)
    .slice(0, 5);

  for (const { comp, acc, n } of topComps) {
    console.log(`║  ${comp.slice(0, 35).padEnd(35)} ${String(acc + '%').padStart(6)} (${n})`);
  }

  console.log(`╚${LINE}╝\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isJson = args.includes('--json');
const isCsv  = args.includes('--csv');
const isGate = args.includes('--gate');

const db          = loadData();
const marketStats = buildMarketStats(db);
const gateResults = buildGateResults(marketStats);
const streak      = buildRecentStreak(db);

if (isJson) {
  const output = {
    timestamp:    new Date().toISOString(),
    global_stats: { total_results: db.results?.length || 0 },
    markets:      marketStats,
    gates:        gateResults,
    streak,
  };
  console.log(JSON.stringify(output, null, 2));
} else if (isCsv) {
  const header = 'market,samples,accuracy,accuracy_last10,gate_min,status';
  const rows   = Object.entries(marketStats).map(([m, s]) => {
    const gate = QUALITY_GATES[m];
    const status = !gate ? 'no_gate'
                 : s.total < (gate?.min_samples || 0) ? 'insufficient'
                 : s.accuracy >= gate.min_accuracy ? 'pass' : 'fail';
    return `${m},${s.total},${s.accuracy},${s.accuracy_last10 ?? ''},${gate?.min_accuracy ?? ''},${status}`;
  });
  console.log([header, ...rows].join('\n'));
} else {
  printReport(marketStats, gateResults, streak, db);
}

// Salvar JSON de benchmark
const benchmarkPath = join(__dir, '../data/benchmark-latest.json');
writeFileSync(benchmarkPath, JSON.stringify({
  timestamp:    new Date().toISOString(),
  markets:      Object.entries(marketStats).map(([m, s]) => ({
    market: m, samples: s.total, accuracy: s.accuracy, accuracy_last10: s.accuracy_last10,
  })),
  gates:        gateResults,
  streak,
}, null, 2), 'utf-8');

if (!isJson && !isCsv) {
  console.log(`💾 Benchmark salvo em: data/benchmark-latest.json`);
}

// Exit code para CI gate
if (isGate) {
  const hardFails = gateResults.filter((g) => g.status === 'FAIL');
  if (hardFails.length > 0) {
    console.error(`\n⛔ GATE FAILED: ${hardFails.length} mercado(s) abaixo do threshold:`);
    hardFails.forEach((g) => console.error(`  - ${g.market}: ${g.accuracy}% (min ${g.gate.min_accuracy}%)`));
    process.exit(1);
  }
  console.log('✅ All quality gates passed.');
  process.exit(0);
}
