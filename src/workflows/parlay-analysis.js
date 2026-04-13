/**
 * parlay-analysis.js — Pipeline completo de análise de apostas combinadas
 *
 * Uso:
 *   import { runParlayAnalysis } from './parlay-analysis.js';
 *   const result = await runParlayAnalysis([matchId1, matchId2, ...], options);
 *
 * Ou via CLI:
 *   node src/workflows/parlay-analysis.js --matches="id1,id2,id3" --bankroll=1000
 */

import { runFullMatchAnalysis } from './full-match-analysis.js';
import { buildLegsFromAnalyses, buildParlayOptions, formatParlayReport } from '../agents/parlay-builder.js';
import { notifySuperOddsParlay } from '../utils/telegram.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Analisa múltiplos jogos e constrói opções de parlay.
 *
 * @param {string[]} matchIds - IDs das partidas a analisar
 * @param {object}   options
 * @param {number}   options.bankroll      - Banca disponível (default 1000)
 * @param {boolean}  options.demo          - Usar dados mock
 * @param {boolean}  options.printReport   - Exibir relatório no terminal
 * @param {boolean}  options.saveReport    - Salvar relatório em arquivo
 */
export async function runParlayAnalysis(matchIds, options = {}) {
  const bankroll  = options.bankroll || parseFloat(process.env.USER_BANKROLL || '1000');
  const isDemo    = options.demo || process.env.DEMO_MODE === 'true';

  console.log('\n' + '═'.repeat(68));
  console.log(`  🎰 ANÁLISE DE ALAVANCAGEM — ${matchIds.length} PARTIDAS`);
  console.log(`  Banca: R$ ${bankroll} | Modo: ${isDemo ? 'DEMO' : 'REAL'}`);
  console.log('═'.repeat(68) + '\n');

  // FASE 1 — Analisa cada jogo individualmente em paralelo
  console.log('🔄 Fase 1: Analisando partidas individualmente...\n');
  const analysisResults = await Promise.allSettled(
    matchIds.map(id => runFullMatchAnalysis(id, { bankroll, demo: isDemo }))
  );

  const analyses = analysisResults
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  const failed = matchIds.length - analyses.length;
  if (failed > 0) console.log(`\n  ⚠️  ${failed} análise(s) falharam e foram ignoradas.\n`);

  if (analyses.length < 2) {
    console.log('❌ Mínimo de 2 análises bem-sucedidas para construir parlays.');
    return null;
  }

  // FASE 2 — Extrai pernas qualificadas das análises
  console.log(`\n🔄 Fase 2: Selecionando pernas para parlay (${analyses.length} análises disponíveis)...`);
  const legs = buildLegsFromAnalyses(analyses);

  console.log(`  Pernas qualificadas: ${legs.length}`);
  if (legs.length > 0) {
    for (const leg of legs.slice(0, 5)) {
      console.log(`    ✓ ${leg.match.substring(0, 35).padEnd(35)} ${leg.market.padEnd(12)} odds:${leg.odds} conf:${leg.confidence}%`);
    }
    if (legs.length > 5) console.log(`    ... +${legs.length - 5} pernas adicionais`);
  }

  // FASE 3 — Constrói opções de parlay
  console.log('\n🔄 Fase 3: Construindo combinações de parlay...');
  const parlayOptions = buildParlayOptions(legs, bankroll);

  // FASE 4 — Relatório
  const report = formatParlayReport(parlayOptions, bankroll);

  if (options.printReport !== false) {
    console.log(report);
  }

  // FASE 5 — Salvar relatório (opcional)
  // FASE 5b — Notifica Super Odds no Telegram
  if (options.notifyTelegram !== false) {
    await notifySuperOddsParlay(parlayOptions, bankroll).catch(e =>
      console.warn(`  ⚠️ Telegram falhou: ${e.message}`)
    );
  }

  // FASE 5c — Salvar relatório (opcional)
  if (options.saveReport !== false) {
    try {
      mkdirSync('./reports', { recursive: true });
      const filename = `parlay_${new Date().toISOString().split('T')[0]}_${Date.now()}.md`;
      const markdown = buildMarkdownReport(parlayOptions, legs, bankroll);
      writeFileSync(join('./reports', filename), markdown, 'utf-8');
      console.log(`📁 Relatório de parlay salvo: reports/${filename}`);
    } catch { /* silencioso */ }
  }

  return {
    analyses,
    legs,
    parlay_options: parlayOptions,
    report,
    summary: parlayOptions.summary,
  };
}

// ── Relatório Markdown ────────────────────────────────────────────────────────
function buildMarkdownReport(options, legs, bankroll) {
  const date = new Date().toLocaleString('pt-BR');
  const lines = [
    `# 🎰 Apostas Combinadas — ${new Date().toLocaleDateString('pt-BR')}`,
    `**Banca:** R$ ${bankroll} | **Gerado em:** ${date}`,
    '',
    `## 📊 Pernas Disponíveis`,
    '',
    '| Partida | Mercado | Odds | Confiança | PIE |',
    '|---------|---------|------|-----------|-----|',
    ...legs.map(l => `| ${l.match} | ${l.market} | ${l.odds} | ${l.confidence}% | ${l.pie_accuracy ? l.pie_accuracy+'%' : '-'} |`),
    '',
  ];

  const { PARLAY_TIERS } = { PARLAY_TIERS: [
    { name: 'Seguro', emoji: '🛡️' },
    { name: 'Acumulador', emoji: '⚡' },
    { name: 'Super Odds', emoji: '🚀' },
  ]};

  for (const tier of PARLAY_TIERS) {
    const tierData = options.tiers[tier.name];
    lines.push(`## ${tier.emoji} ${tier.name}`);
    if (!tierData?.available) {
      lines.push(`*${tierData?.reason || 'Não disponível'}*`);
    } else {
      for (let i = 0; i < tierData.best.length; i++) {
        const p = tierData.best[i];
        lines.push(`### Opção ${i + 1} — Odds ${p.combined_odds}x (${p.leg_count} pernas)`);
        lines.push(`- **Confiança:** ${p.confidence}% | **EV:** ${p.ev_pct}`);
        lines.push(`- **Stake sugerida:** R$ ${p.stake} | **Retorno potencial:** R$ ${p.potential_return}`);
        lines.push('');
        lines.push('| Partida | Mercado | Odds | Confiança |');
        lines.push('|---------|---------|------|-----------|');
        for (const leg of p.legs) {
          lines.push(`| ${leg.match} | ${leg.market} | ${leg.odds} | ${leg.confidence}% |`);
        }
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('*⚠️ Apostas combinadas aumentam ROI mas reduzem probabilidade. Gerencie o risco adequadamente.*');

  return lines.join('\n');
}

// ── CLI direto ────────────────────────────────────────────────────────────────
if (process.argv[1].endsWith('parlay-analysis.js')) {
  const args = process.argv.slice(2);
  const matchArg = args.find(a => a.startsWith('--matches='));
  const bankArg  = args.find(a => a.startsWith('--bankroll='));
  const demo     = args.includes('--demo');

  if (!matchArg) {
    console.log('Uso: node src/workflows/parlay-analysis.js --matches="id1,id2,id3" [--bankroll=1000] [--demo]');
    process.exit(1);
  }

  const matchIds = matchArg.split('=')[1].split(',');
  const bankroll = bankArg ? parseFloat(bankArg.split('=')[1]) : 1000;

  await runParlayAnalysis(matchIds, { bankroll, demo });
}
