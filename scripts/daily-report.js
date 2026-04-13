/**
 * daily-report.js — Relatório diário de resultados + PIE
 *
 * Envia ao Telegram:
 *  1. Resumo do dia: GREEN/RED por mercado, saldo estimado, taxa de acerto
 *  2. Estatísticas globais do PIE (acurácia por mercado, lições ativas)
 *
 * Uso:
 *   node scripts/daily-report.js
 *   npm run daily-report
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

function loadTodayResolved() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const all = JSON.parse(readFileSync(join(ROOT, 'data/pending-analyses.json'), 'utf8'));
    return all.filter(e =>
      e.status === 'resolved' &&
      (e.resolvedAt || e.sentAt || '').startsWith(today)
    );
  } catch { return []; }
}

async function run() {
  const { notifyDailyReport, notifyPIEStats } = await import('../src/utils/telegram.js');
  const { getStats } = await import('../src/pie/pie-storage.js');

  const resolved = loadTodayResolved();

  console.log(`\n  Relatório do dia — ${resolved.length} resultado(s) fechado(s) hoje`);
  for (const e of resolved) {
    const icon = e.acertou ? '✅' : '❌';
    console.log(`  ${icon}  ${e.match}  [${e.market}]  ${e.placarReal}`);
  }

  console.log('\n  Enviando relatório diário...');
  await notifyDailyReport(resolved);

  console.log('  Enviando estatísticas do PIE...');
  await notifyPIEStats(getStats());

  console.log('  ✅ Relatório enviado.\n');
}

run().catch(e => {
  console.error('Erro:', e.message);
  process.exit(1);
});
