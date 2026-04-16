/**
 * goals-feedback-cycle.js — Backfill retroativo dos Kill Switches de Gols
 *
 * Aplica os Kill Switches do Goals Sniper v1 sobre as 1548-1626 amostras
 * históricas do PIE e computa o ganho real de precisão antes/depois.
 *
 * Uso:
 *   node scripts/goals-feedback-cycle.js           → relatório completo
 *   node scripts/goals-feedback-cycle.js --reset    → limpa tracker antes de rodar
 */

import { loadDB }          from '../src/pie/pie-storage.js';
import { goalsKillSwitch } from '../src/utils/goals-sniper.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

const __dirSn   = dirname(fileURLToPath(import.meta.url));
const TRACKER   = join(__dirSn, '../data/goals-tracker.json');
const INTEL     = join(__dirSn, '../data/goals-sniper-intel.json');

// ── Mercados de gols que o sniper monitora ────────────────────────────────────
const GOALS_MARKETS = ['Over 1.5', 'Over 2.5', 'Over 3.5', 'Over 4.5', 'Under 2.5'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadTracker() {
  try { return JSON.parse(readFileSync(TRACKER, 'utf8')); }
  catch { return null; }
}

function saveTracker(t) {
  writeFileSync(TRACKER, JSON.stringify(t, null, 2), 'utf8');
}

function pct(hits, total) {
  if (!total) return 'N/A';
  return (hits / total * 100).toFixed(1) + '%';
}

// ── Extrai amostras históricas do PIE (calibration byCompetition) ─────────────
function extractSamples(db) {
  const cal = db.calibration || {};
  const samples = [];

  for (const market of GOALS_MARKETS) {
    const mktData = cal[market];
    if (!mktData?.byCompetition) continue;

    for (const [competition, stats] of Object.entries(mktData.byCompetition)) {
      if (!stats.total || stats.total < 1) continue;

      // Reconstrói amostras sintéticas: hits = acertou, (total-hits) = errou
      samples.push({
        market,
        competition,
        total: stats.total,
        hits:  stats.hits,
        // Simula probabilidade média da faixa mais representativa
        probabilidade: _guessProb(mktData.byRange),
        confianca:     80, // proxy — não temos conf individual no calibration
      });
    }
  }
  return samples;
}

function _guessProb(byRange) {
  if (!byRange) return 75;
  // Retorna a midpoint da faixa com mais amostras
  let maxTotal = 0, bestRange = '70-80';
  for (const [range, v] of Object.entries(byRange)) {
    if (v.total > maxTotal) { maxTotal = v.total; bestRange = range; }
  }
  const [lo] = bestRange.split('-').map(Number);
  return lo + 5; // midpoint
}

// ── Backfill principal ─────────────────────────────────────────────────────────
async function runBackfill(reset = false) {
  const db      = loadDB();
  const tracker = loadTracker();
  if (!tracker) { console.error('❌ goals-tracker.json não encontrado'); process.exit(1); }

  if (reset) {
    tracker.fired_log   = [];
    tracker.blocked_log = [];
    tracker.shadow_log  = [];
    tracker.summary.total_fired   = 0;
    tracker.summary.total_blocked = 0;
    console.log('🔄 Tracker resetado\n');
  }

  const samples = extractSamples(db);
  console.log(`\n📦 Goals Sniper v1 — Backfill retroativo`);
  console.log(`   Amostras encontradas: ${samples.reduce((s,x)=>s+x.total,0)}`);
  console.log(`   Competições: ${new Set(samples.map(s=>s.competition)).size}\n`);

  // Resultados por mercado
  const stats = {};
  for (const mkt of GOALS_MARKETS) {
    stats[mkt] = {
      total: 0, hits: 0,          // v0 — sem sniper
      sn_total: 0, sn_hits: 0,    // sniper — amostras aprovadas
      blocked: 0, blocked_hits: 0, // bloqueados
    };
  }

  const killSwitchCounts = {};

  for (const sample of samples) {
    const s = stats[sample.market] || (stats[sample.market] = { total:0,hits:0,sn_total:0,sn_hits:0,blocked:0,blocked_hits:0 });
    s.total += sample.total;
    s.hits  += sample.hits;

    // Simula resultado do kill switch
    const fakeResult   = { mercado: sample.market, market: sample.market, probabilidade: sample.probabilidade, confianca: sample.confianca, recomendacao: 'APOSTAR' };
    const fakeMatchData = { competition: sample.competition };
    const killReason   = goalsKillSwitch(fakeResult, fakeMatchData);

    if (killReason) {
      s.blocked       += sample.total;
      s.blocked_hits  += sample.hits;
      killSwitchCounts[killReason] = (killSwitchCounts[killReason] || 0) + sample.total;
    } else {
      s.sn_total += sample.total;
      s.sn_hits  += sample.hits;
    }
  }

  // ── Relatório Fase 4 ─────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════════');
  console.log('  GOALS SNIPER v1 — RELATÓRIO ANTES/DEPOIS (Phase 4)');
  console.log('══════════════════════════════════════════════════════════\n');

  let totalErrosEvitados = 0;
  for (const [mkt, s] of Object.entries(stats)) {
    if (!s.total) continue;
    const errorsV0      = s.total - s.hits;
    const errorsSn      = s.sn_total - s.sn_hits;
    const errorsAvoided = errorsV0 - errorsSn - (s.blocked_hits);
    const diff = s.sn_total > 0
      ? ((s.sn_hits/s.sn_total - s.hits/s.total)*100).toFixed(1)
      : '—';

    console.log(`  📊 ${mkt.padEnd(12)}`);
    console.log(`     Antes  : ${pct(s.hits, s.total).padStart(6)}  (${s.hits}/${s.total})`);
    console.log(`     Depois : ${s.sn_total ? pct(s.sn_hits, s.sn_total).padStart(6) : '  N/A '}  (${s.sn_hits}/${s.sn_total})  ${diff !== '—' ? (parseFloat(diff)>=0?'+':'')+diff+'pp' : ''}`);
    console.log(`     Erros evitados: ${s.blocked - s.blocked_hits}`);
    console.log('');
    totalErrosEvitados += (s.blocked - s.blocked_hits);
  }

  console.log(`  💡 Total de erros evitados pelos Kill Switches: ${totalErrosEvitados}\n`);

  console.log('  🔫 Kill Switches mais ativos:');
  const topKS = Object.entries(killSwitchCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  for (const [ks, count] of topKS) {
    const label = ks.length > 60 ? ks.slice(0,60)+'…' : ks;
    console.log(`     ${count.toString().padStart(4)}x  ${label}`);
  }

  console.log('\n══════════════════════════════════════════════════════════\n');

  // Atualiza intel com resultados do backfill
  if (existsSync(INTEL)) {
    const intel = JSON.parse(readFileSync(INTEL, 'utf8'));
    intel.phase4_backfill.status = 'COMPLETE';
    intel.phase4_backfill.completed_at = new Date().toISOString();
    intel.phase4_backfill.total_errors_avoided = totalErrosEvitados;
    writeFileSync(INTEL, JSON.stringify(intel, null, 2), 'utf8');
  }

  saveTracker(tracker);
  console.log('✅ Backfill concluído — goals-tracker.json atualizado');
}

// ── Entry point ───────────────────────────────────────────────────────────────
const reset = process.argv.includes('--reset');
runBackfill(reset).catch(e => { console.error(e); process.exit(1); });
