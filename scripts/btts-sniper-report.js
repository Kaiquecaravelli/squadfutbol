/**
 * btts-sniper-report.js — Relatório diário de precisão do BTTS Sniper v3
 *
 * Compara:
 *   • Sniper v3 (atual): decisões com threshold 82%/80% + Kill Switches
 *   • Baseline v2 (sombra): o que teria sido recomendado sem os Kill Switches
 *
 * Métricas reportadas:
 *   - Taxa de acerto atual (disparos confirmados)
 *   - Taxa de bloqueio por Kill Switch
 *   - Comparação shadow: quantos erros foram evitados pelo Sniper
 *   - Status de certificação (meta: 88% em 30+ amostras)
 *
 * Uso:
 *   node scripts/btts-sniper-report.js            → relatório no console + Telegram
 *   node scripts/btts-sniper-report.js --console  → só console
 *   node scripts/btts-sniper-report.js --backfill → fecha loop de resultados pendentes
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, '..');
const TRACKER = join(ROOT, 'data/btts-tracker.json');
const PIE     = join(ROOT, 'data/pie.json');
const DAILY   = join(ROOT, 'data/daily-matches');

const args           = process.argv.slice(2);
const CONSOLE_ONLY   = args.includes('--console');
const DO_BACKFILL    = args.includes('--backfill');

// ── Helpers ────────────────────────────────────────────────────────────────────
function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function pct(hits, total) {
  if (!total) return null;
  return Math.round((hits / total) * 100);
}

function bar(acc, width = 20) {
  if (acc === null) return '[ sem dados ]';
  const filled = Math.round((acc / 100) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

// ── Backfill: fecha resultados pendentes no tracker ────────────────────────────
function backfillTracker(tracker, pie) {
  if (!pie || !pie.results) return 0;

  const firedLog   = tracker.fired_log   || [];
  const resolvedSet = new Set(firedLog.filter(e => e.resolved).map(e => e.match_id + '_' + e.competition));
  let closed = 0;

  for (const result of pie.results) {
    const bttsMkt = (result.market_outcomes || []).find(m => m.market === 'BTTS');
    if (!bttsMkt) continue;

    const key = result.match_name + '_' + (result.competition || '');
    if (resolvedSet.has(key)) continue;

    // Encontra o fired_log entry correspondente
    const entry = firedLog.find(e =>
      !e.resolved &&
      e.match_name === result.match_name &&
      Math.abs(new Date(e.fired_at) - new Date(result.registered_at)) < 48 * 3600_000
    );

    if (!entry) continue;

    entry.resolved     = true;
    entry.acertou      = bttsMkt.acertou;
    entry.score_real   = result.placar_real;
    entry.resolved_at  = result.registered_at;
    closed++;
  }

  return closed;
}

// ── Análise dos Kill Switches no shadow_log ────────────────────────────────────
function analyzeKillSwitches(tracker) {
  const blocked = tracker.blocked_log || [];
  const counts  = {};
  for (const b of blocked) {
    const ks = b.kill_switch || 'UNKNOWN';
    counts[ks] = (counts[ks] || 0) + 1;
  }
  return counts;
}

// ── Shadow analysis: quantos erros teria cometido o v2 ────────────────────────
function analyzeShadow(tracker) {
  const shadow = tracker.shadow_log || [];
  const total  = shadow.length;
  if (!total) return null;

  const wouldFire   = shadow.filter(s => s.v2_would_fire);
  const blocked     = shadow.filter(s => !s.v2_would_fire);
  const resolvedFire = wouldFire.filter(s => s.resolved);
  const v2Hits      = resolvedFire.filter(s => s.acertou).length;
  const v2Errors    = resolvedFire.filter(s => !s.acertou).length;
  const errorsAvoided = blocked.filter(s => s.resolved && !s.acertou).length;

  return {
    total,
    v2_would_fire: wouldFire.length,
    v2_hits: v2Hits,
    v2_errors: v2Errors,
    v2_accuracy: pct(v2Hits, resolvedFire.length),
    errors_avoided_by_sniper: errorsAvoided,
  };
}

// ── Status de certificação ────────────────────────────────────────────────────
function certStatus(tracker) {
  const { total_resolved, hits } = tracker.summary;
  const acc = pct(hits, total_resolved);
  const MIN_SAMPLES = tracker._meta?.min_sample_for_cert || 30;

  if (total_resolved < MIN_SAMPLES) {
    return {
      status: 'COLETANDO',
      message: `${total_resolved}/${MIN_SAMPLES} amostras para certificação`,
      color: 'yellow',
    };
  }
  if (acc >= 88) {
    return {
      status: 'CERTIFICADO',
      message: `${acc}% ≥ 88% — BTTS Sniper v3 operacional`,
      color: 'green',
    };
  }
  return {
    status: 'EM TREINAMENTO',
    message: `${acc}% < 88% — calibração adicional necessária`,
    color: 'red',
  };
}

// ── Relatório em console ──────────────────────────────────────────────────────
function printReport(tracker, shadow, killCounts, cert) {
  const { summary } = tracker;
  const acc = pct(summary.hits, summary.total_resolved);

  console.log('\n' + chalk.bold.cyan('━'.repeat(60)));
  console.log(chalk.bold.cyan('  🎯 BTTS SNIPER v3 — RELATÓRIO DE PRECISÃO'));
  console.log(chalk.bold.cyan('━'.repeat(60)));

  console.log(chalk.bold('\n📊 DESEMPENHO ATUAL:'));
  console.log(`  Disparos realizados:  ${chalk.yellow(summary.total_fired)}`);
  console.log(`  Tiros resolvidos:     ${chalk.yellow(summary.total_resolved)}`);
  console.log(`  ✅ Acertos:           ${chalk.green(summary.hits)}`);
  console.log(`  ❌ Erros:             ${chalk.red(summary.misses)}`);

  const accColor = acc === null ? chalk.gray : acc >= 88 ? chalk.green : acc >= 75 ? chalk.yellow : chalk.red;
  console.log(`  Precisão:             ${accColor(acc !== null ? acc + '%' : 'N/A')} ${bar(acc)}`);
  console.log(`  Tiros bloqueados:     ${chalk.gray(summary.total_blocked)} (Kill Switches ativos)`);

  if (Object.keys(killCounts).length) {
    console.log(chalk.bold('\n🛑 KILL SWITCHES — BLOQUEIOS POR TIPO:'));
    Object.entries(killCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([ks, count]) => {
        console.log(`  ${chalk.gray('•')} ${ks}: ${chalk.yellow(count)} bloqueios`);
      });
  }

  if (shadow) {
    console.log(chalk.bold('\n👻 ANÁLISE SHADOW (v2 vs v3):'));
    console.log(`  v2 teria disparado:       ${shadow.v2_would_fire} de ${shadow.total} casos`);
    console.log(`  Precisão v2 (resolv.):    ${shadow.v2_accuracy !== null ? shadow.v2_accuracy + '%' : 'N/A'}`);
    console.log(`  Erros evitados pelo v3:   ${chalk.green(shadow.errors_avoided_by_sniper)}`);
  }

  console.log(chalk.bold('\n🏅 CERTIFICAÇÃO:'));
  const certColors = { CERTIFICADO: chalk.green, 'EM TREINAMENTO': chalk.red, COLETANDO: chalk.yellow };
  const cc = certColors[cert.status] || chalk.gray;
  console.log(`  Status: ${cc(cert.status)}`);
  console.log(`  ${cert.message}`);
  console.log(`  Meta final: 95% de precisão`);

  console.log('\n' + chalk.bold.cyan('━'.repeat(60)) + '\n');
}

// ── Mensagem Telegram ─────────────────────────────────────────────────────────
function buildTelegramMessage(tracker, shadow, killCounts, cert) {
  const { summary } = tracker;
  const acc = pct(summary.hits, summary.total_resolved);

  const accEmoji = acc === null ? '⏳' : acc >= 88 ? '🟢' : acc >= 75 ? '🟡' : '🔴';
  const certEmoji = cert.status === 'CERTIFICADO' ? '🏅' : cert.status === 'COLETANDO' ? '⏳' : '🔧';

  let msg = `🎯 <b>BTTS Sniper v3 — Relatório</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  msg += `📊 <b>Desempenho:</b>\n`;
  msg += `  Disparos: <b>${summary.total_fired}</b>  |  Resolvidos: <b>${summary.total_resolved}</b>\n`;
  msg += `  ✅ ${summary.hits} acertos  ❌ ${summary.misses} erros\n`;
  msg += `  Precisão: ${accEmoji} <b>${acc !== null ? acc + '%' : 'N/A'}</b>\n`;
  msg += `  Bloqueados: <b>${summary.total_blocked}</b> (Kill Switches)\n\n`;

  const topKs = Object.entries(killCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topKs.length) {
    msg += `🛑 <b>Top Kill Switches:</b>\n`;
    topKs.forEach(([ks, c]) => { msg += `  • ${ks}: ${c}x\n`; });
    msg += '\n';
  }

  if (shadow && shadow.errors_avoided_by_sniper > 0) {
    msg += `👻 <b>Shadow:</b> ${shadow.errors_avoided_by_sniper} erros evitados vs modelo v2\n\n`;
  }

  msg += `${certEmoji} <b>Certificação:</b> ${cert.status}\n`;
  msg += `${cert.message}`;

  return msg;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  let tracker = loadJSON(TRACKER);
  if (!tracker) {
    console.error(chalk.red('❌ btts-tracker.json não encontrado'));
    process.exit(1);
  }

  const pie = loadJSON(PIE);

  // Backfill: fecha resultados pendentes no tracker
  if (DO_BACKFILL && pie) {
    const closed = backfillTracker(tracker, pie);
    if (closed > 0) {
      // Recalcula summary
      const fired = tracker.fired_log || [];
      const resolved = fired.filter(e => e.resolved);
      tracker.summary.total_fired    = fired.length;
      tracker.summary.total_resolved = resolved.length;
      tracker.summary.hits           = resolved.filter(e => e.acertou).length;
      tracker.summary.misses         = resolved.filter(e => !e.acertou).length;
      tracker.summary.accuracy       = pct(tracker.summary.hits, tracker.summary.total_resolved);
      tracker.summary.last_updated   = new Date().toISOString();
      saveJSON(TRACKER, tracker);
      console.log(chalk.green(`  ✅ Backfill: ${closed} resultado(s) fechado(s)`));
    }
  }

  const shadow     = analyzeShadow(tracker);
  const killCounts = analyzeKillSwitches(tracker);
  const cert       = certStatus(tracker);

  printReport(tracker, shadow, killCounts, cert);

  if (!CONSOLE_ONLY) {
    try {
      const { sendTelegramMessage } = await import('../src/utils/telegram.js');
      const msg = buildTelegramMessage(tracker, shadow, killCounts, cert);
      await sendTelegramMessage(msg, { parse_mode: 'HTML', disable_notification: true });
      console.log(chalk.green('  ✅ Relatório enviado ao Telegram'));
    } catch (e) {
      console.log(chalk.yellow(`  ⚠️ Telegram não disponível: ${e.message}`));
    }
  }
}

run().catch(e => {
  console.error(chalk.red('Erro:'), e.message);
  process.exit(1);
});
