/**
 * pie-diagnostics.js — Diagnóstico Completo do PIE
 *
 * Mostra: calibração atual, gap até a meta, qualidade dos dados,
 * mercados prioritários, e próximos passos recomendados.
 *
 * Uso:
 *   node scripts/pie-diagnostics.js
 *   npm run pie-diag
 */

import chalk from 'chalk';
import { loadDB } from '../src/pie/pie-storage.js';

// Metas por mercado
const TARGETS = {
  // Tier 1 — Máxima liquidez, modelos calibrados
  'Over 1.5':          { meta: 100, alvo: 92, tier: 1, oddsSweet: '1.20-1.35' },
  'BTTS':              { meta: 100, alvo: 86, tier: 1, oddsSweet: '1.70-1.95' },
  'Over 2.5':          { meta: 100, alvo: 78, tier: 1, oddsSweet: '1.60-1.85' },
  'Over 3.5':          { meta: 100, alvo: 40, tier: 1, oddsSweet: '2.20-3.50' },
  // Tier 2 — Escanteios (dados ricos via PIE)
  'Over Corners 6.5':  { meta: 100, alvo: 78, tier: 2, oddsSweet: '1.40-1.70' },
  'Over Corners 7.5':  { meta: 100, alvo: 69, tier: 2, oddsSweet: '1.65-2.00' },
  'Over Corners 8.5':  { meta: 100, alvo: 62, tier: 2, oddsSweet: '1.80-2.30' },
  // Tier 2 — Cartões amarelos
  'YC 2.5':            { meta: 80,  alvo: 73, tier: 2, oddsSweet: '1.60-1.90' },
  'YC 3.5':            { meta: 80,  alvo: 54, tier: 2, oddsSweet: '2.00-2.80' },
  'YC 4.5':            { meta: 80,  alvo: 38, tier: 2, oddsSweet: '3.00-5.00' },
  // Tier 3 — 1X2 e Dupla Chance
  '1X':                { meta: 60,  alvo: 80, tier: 3, oddsSweet: '1.10-1.35' },
  'X2':                { meta: 60,  alvo: 53, tier: 3, oddsSweet: '1.20-1.50' },
  'Home Win':          { meta: 60,  alvo: 72, tier: 3, oddsSweet: '1.40-2.20' },
  'Resultado Final':   { meta: 50,  alvo: 70, tier: 3, oddsSweet: '1.50-2.80' },
};

function bar(filled, total, width = 20) {
  const pct    = Math.min(1, filled / total);
  const blocks = Math.round(pct * width);
  return '█'.repeat(blocks) + '░'.repeat(width - blocks);
}

function statusColor(pct, meta) {
  if (pct >= meta)   return chalk.green;
  if (pct >= meta * 0.7) return chalk.yellow;
  return chalk.red;
}

async function runDiagnostics() {
  const db  = loadDB();
  const cal = db.calibration || {};

  const predictions     = db.predictions || [];
  const pendingCount    = predictions.filter(p => !p.result_id).length;
  const resolvedCount   = predictions.filter(p => p.result_id).length;
  const lessons         = (db.lessons || []).filter(l => l.active);
  const positivePatterns = (db.positivePatterns || []).filter(p => p.active);

  console.log('\n' + chalk.bold('═'.repeat(70)));
  console.log(chalk.bold.cyan('  🧠 PIE — Diagnóstico Completo'));
  console.log(chalk.bold('═'.repeat(70)));

  // ── Saúde Geral ──────────────────────────────────────────────────────────
  console.log(chalk.bold('\n📊 SAÚDE GERAL DO PIE\n'));

  const feedbackRate = predictions.length > 0
    ? Math.round(resolvedCount / predictions.length * 100)
    : 0;

  const feedbackColor = feedbackRate >= 80 ? chalk.green :
                        feedbackRate >= 40 ? chalk.yellow : chalk.red;

  console.log(`  Predições totais:         ${predictions.length}`);
  console.log(`  Com resultado:            ${resolvedCount} (${feedbackColor(feedbackRate + '%')})`);
  console.log(`  Pendentes (sem resultado): ${chalk.yellow(pendingCount)}  ${pendingCount > 20 ? chalk.red('← LOOP QUEBRADO') : ''}`);
  console.log(`  Lições ativas:            ${lessons.length}`);
  console.log(`  Padrões positivos:        ${positivePatterns.length}`);

  if (feedbackRate < 50) {
    console.log(chalk.red('\n  ⚠️  ALERTA: Taxa de feedback baixa! Execute:'));
    console.log(chalk.yellow('     npm run backfill-dry  → ver o que será atualizado'));
    console.log(chalk.yellow('     npm run backfill       → fechar o loop de feedback'));
  }

  // ── Calibração por Mercado ────────────────────────────────────────────────
  console.log(chalk.bold('\n📈 CALIBRAÇÃO POR MERCADO\n'));
  console.log('  Mercado                   Amostras  Meta    Progresso           Precisão  Status');
  console.log('  ' + '─'.repeat(85));

  for (const [market, cfg] of Object.entries(TARGETS)) {
    const c   = cal[market];
    const tot = c?.total || 0;
    const acc = tot > 0 ? Math.round(c.hits / tot * 100) : 0;
    const col = statusColor(tot, cfg.meta);

    const barStr     = col(bar(tot, cfg.meta));
    const statusIcon = tot >= cfg.meta ? '✅' : tot >= cfg.meta * 0.5 ? '🟡' : '🔴';
    const precStr    = tot >= 10 ? chalk.bold(acc + '%') : chalk.gray(acc + '% (insuf)');

    console.log(
      `  ${market.padEnd(26)} ${String(tot).padStart(3)}/${cfg.meta}  ` +
      `${String(cfg.alvo + '%').padStart(4)} alvo  [${barStr}]  ` +
      `${precStr.padStart(8)}  ${statusIcon}`
    );
  }

  // Mercados no PIE que não têm target definido
  for (const [market, c] of Object.entries(cal)) {
    if (TARGETS[market]) continue;
    const acc = c.total > 0 ? Math.round(c.hits / c.total * 100) : 0;
    console.log(`  ${market.padEnd(26)} ${String(c.total).padStart(3)}/??    -       [${bar(c.total, 60)}]  ${acc}%    ⚪`);
  }

  // ── Predições por Mercado ─────────────────────────────────────────────────
  const byMarket = {};
  for (const p of predictions) {
    for (const m of (p.markets || [])) {
      byMarket[m.market] = (byMarket[m.market] || 0) + 1;
    }
  }

  console.log(chalk.bold('\n🎯 DISTRIBUIÇÃO DE PREDIÇÕES\n'));
  const sorted = Object.entries(byMarket).sort((a, b) => b[1] - a[1]);
  for (const [m, n] of sorted) {
    const pct = Math.round(n / sorted.reduce((s, [, v]) => s + v, 0) * 100);
    const bStr = bar(pct, 100, 15);
    const warn = m === 'Over 1.5' && pct > 60 ? chalk.red('  ← muito concentrado') : '';
    console.log(`  ${m.padEnd(28)} ${String(n).padStart(3)} predições  [${chalk.cyan(bStr)}] ${pct}%${warn}`);
  }

  // ── Próximos Passos ───────────────────────────────────────────────────────
  console.log(chalk.bold('\n🚀 PRÓXIMOS PASSOS RECOMENDADOS\n'));

  const steps = [];

  if (pendingCount > 10) {
    steps.push({
      prio: 1,
      cmd:  'npm run backfill',
      desc: `Fechar loop de feedback: ${pendingCount} predições aguardando resultado`,
    });
  }

  const needsData = Object.entries(TARGETS)
    .filter(([m, cfg]) => (cal[m]?.total || 0) < cfg.meta * 0.5)
    .sort((a, b) => a[1].tier - b[1].tier);

  if (needsData.length > 0) {
    steps.push({
      prio: 2,
      cmd:  'npm run collect-auto',
      desc: `Coletar mais dados: ${needsData.map(([m]) => m).join(', ')} precisam de amostras`,
    });
  }

  const needsTraining = Object.entries(TARGETS)
    .filter(([m, cfg]) => {
      const acc = cal[m]?.total > 5 ? cal[m].hits / cal[m].total * 100 : 0;
      return acc < cfg.alvo && (cal[m]?.total || 0) >= 10;
    });

  if (needsTraining.length > 0) {
    steps.push({
      prio: 3,
      cmd:  'npm run train-week',
      desc: `Treinar modelo: ${needsTraining.map(([m]) => m).join(', ')} abaixo da meta de precisão`,
    });
  }

  const overConcentrated = sorted.find(([m, n]) =>
    m === 'Over 1.5' && n / sorted.reduce((s, [, v]) => s + v, 0) > 0.6
  );
  if (overConcentrated) {
    steps.push({
      prio: 4,
      cmd:  'Diversificar mercados',
      desc: 'Over 1.5 representa >60% das predições. Ative Over 2.5, BTTS e Escanteios nos agentes.',
    });
  }

  if (steps.length === 0) {
    console.log(chalk.green('  ✅ PIE em boa saúde — continue a coleta diária.'));
  } else {
    for (const s of steps) {
      const icon = s.prio === 1 ? '🔴' : s.prio === 2 ? '🟡' : '🟢';
      console.log(`  ${icon} [P${s.prio}] ${chalk.bold(s.cmd)}`);
      console.log(`       ${s.desc}`);
    }
  }

  // ── Resumo de Valor ───────────────────────────────────────────────────────
  console.log(chalk.bold('\n💎 MERCADOS COM MELHOR ODDS DE VALOR (Risco-Retorno)\n'));
  console.log('  Mercado          Odds Sweet Spot  Precisão PIE  Tier');
  console.log('  ' + '─'.repeat(55));
  for (const [market, cfg] of Object.entries(TARGETS).sort((a, b) => a[1].tier - b[1].tier)) {
    const acc = cal[market]?.total >= 10
      ? Math.round(cal[market].hits / cal[market].total * 100) + '%'
      : chalk.gray('—');
    console.log(`  ${market.padEnd(17)} ${cfg.oddsSweet.padEnd(16)} ${String(acc).padEnd(14)} T${cfg.tier}`);
  }

  console.log('\n' + chalk.bold('═'.repeat(70)) + '\n');
}

runDiagnostics();
