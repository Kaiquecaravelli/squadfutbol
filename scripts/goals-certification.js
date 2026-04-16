/**
 * goals-certification.js — Certificação do Goals Sniper v1
 *
 * Compara acurácia antes/depois e certifica quando >= 88% em 30+ amostras.
 * Monitor automático: verifica a cada 6h se o critério foi atingido.
 *
 * Uso:
 *   node scripts/goals-certification.js           → relatório console
 *   node scripts/goals-certification.js --telegram → console + Telegram
 *   node scripts/goals-certification.js --monitor  → loop 6h
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// telegram enviado inline quando necessário (evita import antecipado)

const __dirSn  = dirname(fileURLToPath(import.meta.url));
const TRACKER  = join(__dirSn, '../data/goals-tracker.json');
const INTEL    = join(__dirSn, '../data/goals-sniper-intel.json');

// ── Critérios de certificação ─────────────────────────────────────────────────
const CERT_MIN_SAMPLES    = 30;   // mínimo de disparos com resultado
const CERT_MIN_ACCURACY   = 88;   // % mínima para certificação

// ── Baseline v0 (histórico antes do sniper) ────────────────────────────────────
const BASELINE_V0 = {
  'Over 1.5': { accuracy: 80.6, samples: 1626 },
  'Over 2.5': { accuracy: 56.3, samples: 1548 },
  'Over 3.5': { accuracy: 29.7, samples: 1548 },
};

function pct(hits, total) {
  if (!total) return null;
  return parseFloat((hits / total * 100).toFixed(1));
}

function loadTracker() {
  try { return JSON.parse(readFileSync(TRACKER, 'utf8')); }
  catch { return null; }
}

// ── Coleta dados do Sniper v1 (fired_log com resolved) ───────────────────────
function collectSniperData(tracker) {
  const byMarket = {};
  for (const entry of (tracker.fired_log || [])) {
    if (!entry.resolved) continue; // só conta amostras fechadas
    const mkt = entry.mercado || 'Unknown';
    if (!byMarket[mkt]) byMarket[mkt] = { total: 0, hits: 0 };
    byMarket[mkt].total++;
    if (entry.acertou) byMarket[mkt].hits++;
  }
  return byMarket;
}

// ── Relatório principal ────────────────────────────────────────────────────────
function buildReport(tracker) {
  const sniperData = collectSniperData(tracker);
  const lines = [];

  lines.push('══════════════════════════════════════════════════════════');
  lines.push('  GOALS SNIPER v1 — CERTIFICAÇÃO (Phase 5)');
  lines.push('══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('  ANTES/DEPOIS — Baseline v0 vs Sniper v1 (live)');
  lines.push('');

  let allCertified = true;
  const marketResults = [];

  for (const [mkt, base] of Object.entries(BASELINE_V0)) {
    const sn     = sniperData[mkt] || { total: 0, hits: 0 };
    const snAcc  = pct(sn.hits, sn.total);
    const diff   = snAcc !== null ? (snAcc - base.accuracy).toFixed(1) : null;
    const isCert = sn.total >= CERT_MIN_SAMPLES && snAcc >= CERT_MIN_ACCURACY;
    const status = sn.total < CERT_MIN_SAMPLES
      ? `⏳ ${sn.total}/${CERT_MIN_SAMPLES} amostras`
      : isCert ? '🏆 CERTIFICADO' : `❌ ${snAcc}% < ${CERT_MIN_ACCURACY}%`;

    if (sn.total < CERT_MIN_SAMPLES || !isCert) allCertified = false;

    lines.push(`  📊 ${mkt}`);
    lines.push(`     v0 (sem Sniper)  : ${base.accuracy}%  (${base.samples} amostras históricas)`);
    lines.push(`     v1 (Sniper live) : ${snAcc !== null ? snAcc + '%' : 'sem dados'}  (${sn.total} disparos fechados)`);
    if (diff !== null) {
      lines.push(`     Melhoria        : ${parseFloat(diff) >= 0 ? '+' : ''}${diff}pp`);
    }
    lines.push(`     Status          : ${status}`);
    lines.push('');

    marketResults.push({ mkt, snAcc, sn, isCert });
  }

  // Resumo Kill Switches
  const totalBlocked = tracker.summary?.total_blocked ?? 0;
  const totalFired   = tracker.summary?.total_fired   ?? 0;
  lines.push(`  🔫 Kill Switches — Total bloqueado: ${totalBlocked}`);
  lines.push(`  ✅ Disparos aprovados: ${totalFired}`);
  lines.push('');

  // Shadow mode: quantos erros o v0 teria cometido nos bloqueados
  const shadowErrors = (tracker.shadow_log || []).filter(e => e.v0_would_fire && !e.acertou).length;
  const shadowTotal  = (tracker.shadow_log || []).filter(e => e.v0_would_fire).length;
  if (shadowTotal > 0) {
    lines.push(`  👻 Shadow Mode: v0 teria disparado ${shadowTotal}x nos bloqueados → ${shadowErrors} erros evitados`);
    lines.push('');
  }

  lines.push(allCertified
    ? '  🏆 GOALS SNIPER v1 — CERTIFICADO EM TODOS OS MERCADOS!'
    : `  ⏳ Aguardando ${CERT_MIN_SAMPLES} amostras por mercado para certificação`
  );
  lines.push('══════════════════════════════════════════════════════════');

  return { text: lines.join('\n'), allCertified, marketResults };
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const tracker = loadTracker();
  if (!tracker) { console.error('❌ goals-tracker.json não encontrado'); process.exit(1); }

  const { text, allCertified } = buildReport(tracker);
  console.log('\n' + text + '\n');

  const sendTg = process.argv.includes('--telegram');
  if (sendTg) {
    try {
      const { sendTelegramMessage } = await import('../src/utils/telegram.js');
      await sendTelegramMessage(text, { disable_notification: true });
      console.log('✅ Relatório enviado via Telegram');
    } catch (e) {
      console.error('⚠️  Telegram falhou:', e.message);
    }
  }

  // Monitor loop
  if (process.argv.includes('--monitor')) {
    const intervalH = 6;
    console.log(`\n🔄 Monitor ativo — verificação a cada ${intervalH}h...\n`);
    setInterval(async () => {
      const t2 = loadTracker();
      const { text: t2text, allCertified: cert2 } = buildReport(t2);
      console.log('\n' + t2text + '\n');
      if (cert2 && sendTg) {
        const { sendTelegramMessage } = await import('../src/utils/telegram.js');
        await sendTelegramMessage(`🏆 GOALS SNIPER v1 CERTIFICADO!\n\n${t2text}`, { disable_notification: true }).catch(() => {});
      }
    }, intervalH * 3_600_000);
    await new Promise(() => {});
  }
}

main().catch(e => { console.error(e); process.exit(1); });
