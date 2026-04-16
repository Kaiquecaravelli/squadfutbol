/**
 * goals-sniper-report.js — Relatório do Goals Sniper v1
 *
 * Uso:
 *   npm run goals-report         → console
 *   npm run goals-report-tg      → console + Telegram admin DM
 *   npm run goals-backfill       → backfill retroativo
 */

import { readFileSync }  from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// telegram enviado inline quando necessário

const __dirSn = dirname(fileURLToPath(import.meta.url));
const TRACKER = join(__dirSn, '../data/goals-tracker.json');

function pct(hits, total) {
  if (!total) return 'N/A';
  return (hits / total * 100).toFixed(1) + '%';
}

function loadTracker() {
  try { return JSON.parse(readFileSync(TRACKER, 'utf8')); }
  catch { return null; }
}

async function main() {
  const tracker = loadTracker();
  if (!tracker) { console.error('❌ goals-tracker.json não encontrado'); process.exit(1); }

  const { summary, fired_log = [], blocked_log = [], shadow_log = [] } = tracker;

  // Acurácia dos disparos com resultado
  const resolved   = fired_log.filter(e => e.resolved);
  const hits        = resolved.filter(e => e.acertou).length;
  const accuracy    = pct(hits, resolved.length);

  // Por mercado
  const byMarket = {};
  for (const e of resolved) {
    const mkt = e.mercado || 'Unknown';
    if (!byMarket[mkt]) byMarket[mkt] = { total: 0, hits: 0 };
    byMarket[mkt].total++;
    if (e.acertou) byMarket[mkt].hits++;
  }

  // Kill Switch breakdown
  const ksCounts = {};
  for (const e of blocked_log) {
    const ks = (e.kill_switch || 'UNKNOWN').split(' — ')[0];
    ksCounts[ks] = (ksCounts[ks] || 0) + 1;
  }

  // Shadow mode
  const shadowFired  = shadow_log.filter(e => e.v0_would_fire);
  const shadowErrors = shadowFired.filter(e => !e.acertou && e.resolved).length;

  const lines = [
    '══════════════════════════════════════════════════',
    '  GOALS SNIPER v1 — RELATÓRIO DE PERFORMANCE',
    '══════════════════════════════════════════════════',
    '',
    `  Disparos totais : ${summary.total_fired}`,
    `  Bloqueados      : ${summary.total_blocked}`,
    `  Fechados c/ resultado: ${resolved.length}`,
    `  Acurácia (fired): ${accuracy}`,
    '',
    '  Por mercado:',
    ...Object.entries(byMarket).map(([mkt, s]) =>
      `     ${mkt.padEnd(12)}: ${pct(s.hits, s.total).padStart(6)}  (${s.hits}/${s.total})`
    ),
    '',
    '  Kill Switches mais ativos:',
    ...Object.entries(ksCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([ks,n]) =>
      `     ${String(n).padStart(4)}x  ${ks.slice(0,55)}`
    ),
    '',
    `  Shadow Mode: ${shadowFired.length} tiros v0 bloqueados → ${shadowErrors} erros evitados`,
    '',
    `  Última atualização: ${summary.last_updated?.slice(0,19) || '—'}`,
    '══════════════════════════════════════════════════',
  ];

  const text = lines.join('\n');
  console.log('\n' + text + '\n');

  if (process.argv.includes('--telegram')) {
    try {
      const { sendTelegramMessage } = await import('../src/utils/telegram.js');
      await sendTelegramMessage(text, { disable_notification: true });
      console.log('✅ Enviado via Telegram');
    } catch (e) {
      console.error('⚠️  Telegram falhou:', e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
