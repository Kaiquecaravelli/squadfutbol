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
import { loadDB, getCalibrationAboveGate } from '../src/pie/pie-storage.js';

// Metas por mercado — alvo mínimo unificado: 75% precisão com gate
// gate: probabilidade mínima para que o sinal seja enviado (derivado do byRange do PIE)
const TARGETS = {
  // Tier 1 — Gols
  'Over 1.5':          { meta: 100, alvo: 75, gate: 70, tier: 1, oddsSweet: '1.20-1.35' },
  'BTTS':              { meta: 100, alvo: 75, gate: 80, tier: 1, oddsSweet: '1.70-1.95' },
  'Over 2.5':          { meta: 100, alvo: 75, gate: 80, tier: 1, oddsSweet: '1.60-1.85' },
  'Over 3.5':          { meta: 50,  alvo: 75, gate: 82, tier: 1, oddsSweet: '2.20-3.50', shadow: true },
  // Tier 2 — Escanteios
  'Over Corners 6.5':  { meta: 100, alvo: 75, gate: 75, tier: 2, oddsSweet: '1.40-1.70' },
  'Over Corners 7.5':  { meta: 100, alvo: 75, gate: 77, tier: 2, oddsSweet: '1.65-2.00' },
  'Over Corners 8.5':  { meta: 100, alvo: 75, gate: 80, tier: 2, oddsSweet: '1.80-2.30' },
  // Tier 2 — Cartões
  'YC 2.5':            { meta: 80,  alvo: 75, gate: 73, tier: 2, oddsSweet: '1.60-1.90' },
  'YC 3.5':            { meta: 80,  alvo: 75, gate: 80, tier: 2, oddsSweet: '2.00-2.80' },
  'YC 4.5':            { meta: 80,  alvo: 75, gate: 92, tier: 2, oddsSweet: '3.00-5.00', blocked: true },
  // Tier 3 — 1X2
  '1X':                { meta: 60,  alvo: 75, gate: 80, tier: 3, oddsSweet: '1.10-1.35' },
  'X2':                { meta: 60,  alvo: 75, gate: 92, tier: 3, oddsSweet: '1.20-1.50', blocked: true },
  'Home Win':          { meta: 60,  alvo: 75, gate: 92, tier: 3, oddsSweet: '1.40-2.20', blocked: true },
  'Resultado Final':   { meta: 50,  alvo: 75, gate: 85, tier: 3, oddsSweet: '1.50-2.80', shadow: true },
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

  // ── Precisão com Gate (sinais aprovados apenas) ───────────────────────────
  console.log(chalk.bold('\n🎯 PRECISÃO COM GATE (sinais efetivamente enviados)\n'));
  console.log('  Mercado                   Gate   Amostras  Precisão  Alvo   Status');
  console.log('  ' + '─'.repeat(72));

  let gateOk = 0, gateTotal = 0;
  for (const [market, cfg] of Object.entries(TARGETS)) {
    if (cfg.blocked) {
      console.log(`  ${market.padEnd(26)} ${String(cfg.gate + '%').padStart(5)}   ${chalk.gray('BLOQUEADO — gate ≥92% (precisão histórica insuficiente)')}`);
      continue;
    }
    if (cfg.shadow) {
      const shadowResult = getCalibrationAboveGate(market, cfg.gate);
      if (shadowResult) {
        const sAcc = shadowResult.accuracy;
        const sColor = sAcc >= cfg.alvo ? chalk.green : sAcc >= cfg.alvo * 0.9 ? chalk.yellow : chalk.gray;
        const gap = (cfg.alvo - sAcc).toFixed(1);
        const gapStr = sAcc >= cfg.alvo ? chalk.green('META ATINGIDA') : chalk.yellow(`falta ${gap}pp p/ graduar`);
        console.log(
          `  ${market.padEnd(26)} ${String(cfg.gate + '%').padStart(5)}   ` +
          `${String(shadowResult.total).padStart(4)} am.   ` +
          `${sColor.bold(String(sAcc + '%').padStart(6))}  🔵 SHADOW  ${gapStr}`
        );
      } else {
        console.log(`  ${market.padEnd(26)} ${String(cfg.gate + '%').padStart(5)}   ${chalk.gray('SHADOW — sem dados acima do gate ainda')}`);
      }
      continue;
    }

    const result = getCalibrationAboveGate(market, cfg.gate);
    gateTotal++;

    if (!result) {
      console.log(`  ${market.padEnd(26)} ${String(cfg.gate + '%').padStart(5)}   ${chalk.gray('sem dados acima do gate ainda')}`);
      continue;
    }

    const acc       = result.accuracy;
    const atingiu   = acc >= cfg.alvo;
    const icon      = atingiu ? '✅' : acc >= cfg.alvo * 0.85 ? '🟡' : '🔴';
    const accColor  = atingiu ? chalk.green.bold : acc >= cfg.alvo * 0.85 ? chalk.yellow.bold : chalk.red.bold;
    const barGate   = bar(acc, 100, 12);
    const barColor  = atingiu ? chalk.green : chalk.yellow;

    if (atingiu) gateOk++;

    console.log(
      `  ${market.padEnd(26)} ${String(cfg.gate + '%').padStart(5)}   ` +
      `${String(result.total).padStart(4)} am.   ` +
      `${accColor(String(acc + '%').padStart(6))}    ` +
      `${cfg.alvo}%   ${icon}  [${barColor(barGate)}]`
    );
  }

  const gateRate = gateTotal > 0 ? Math.round(gateOk / gateTotal * 100) : 0;
  const gateRateColor = gateRate >= 80 ? chalk.green.bold : gateRate >= 50 ? chalk.yellow.bold : chalk.red.bold;
  console.log(`\n  Mercados ativos ≥75% com gate: ${gateRateColor(gateOk + '/' + gateTotal)} (${gateRateColor(gateRate + '%')})`);
  if (gateRate < 100) {
    console.log(chalk.yellow('  → Coletar mais dados nas faixas acima do gate para atingir 100%'));
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
      if (cfg.blocked || cfg.shadow) return false;
      const gateResult = getCalibrationAboveGate(m, cfg.gate);
      if (!gateResult || gateResult.total < 5) return false;
      return gateResult.accuracy < cfg.alvo;
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
  console.log('  Mercado          Odds Sweet Spot  Gate  Precisão c/ Gate  Tier');
  console.log('  ' + '─'.repeat(65));
  for (const [market, cfg] of Object.entries(TARGETS).sort((a, b) => a[1].tier - b[1].tier)) {
    if (cfg.blocked) {
      console.log(`  ${market.padEnd(17)} ${cfg.oddsSweet.padEnd(16)} ${String(cfg.gate + '%').padStart(5)}  ${chalk.gray('BLOQUEADO'.padEnd(18))} T${cfg.tier}`);
      continue;
    }
    if (cfg.shadow) {
      const sr = getCalibrationAboveGate(market, cfg.gate);
      const shadowAccStr = sr
        ? (sr.accuracy >= cfg.alvo ? chalk.green : chalk.yellow)(`${sr.accuracy}% (${sr.total} am.) 🔵`)
        : chalk.gray('SHADOW (sem dados)');
      console.log(`  ${market.padEnd(17)} ${cfg.oddsSweet.padEnd(16)} ${String(cfg.gate + '%').padStart(5)}  ${String(shadowAccStr).padEnd(18)} T${cfg.tier}`);
      continue;
    }
    const gateResult = getCalibrationAboveGate(market, cfg.gate);
    const accStr = gateResult
      ? (gateResult.accuracy >= cfg.alvo ? chalk.green.bold : chalk.yellow)(
          gateResult.accuracy + '% (' + gateResult.total + ' am.)'
        )
      : chalk.gray('—');
    console.log(`  ${market.padEnd(17)} ${cfg.oddsSweet.padEnd(16)} ${String(cfg.gate + '%').padStart(5)}  ${String(accStr).padEnd(18)} T${cfg.tier}`);
  }

  console.log('\n' + chalk.bold('═'.repeat(70)) + '\n');
}

runDiagnostics();
