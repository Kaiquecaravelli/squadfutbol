/**
 * engagement-stats.js — Relatório de Engajamento dos Membros
 *
 * Exibe estatísticas de engajamento dos membros do grupo Telegram:
 *   • Quantos sinais foram enviados
 *   • Quantos cliques no link cada sinal recebeu
 *   • Quais membros mais interagem
 *   • Taxa de clique geral
 *
 * Uso:
 *   node scripts/engagement-stats.js          → últimos 7 dias
 *   node scripts/engagement-stats.js --days=30 → últimos 30 dias
 */

import 'dotenv/config';
import chalk from 'chalk';
import { getOverallStats } from '../src/utils/engagement-tracker.js';

const daysArg = parseInt(
  (process.argv.find(a => a.startsWith('--days=')) || '--days=7').split('=')[1]
) || 7;

const stats = getOverallStats({ daysBack: daysArg });

console.log('\n' + chalk.bold.cyan('═'.repeat(60)));
console.log(chalk.bold.cyan(`  📊 ENGAJAMENTO DOS MEMBROS — Últimos ${daysArg} dias`));
console.log(chalk.bold.cyan('═'.repeat(60) + '\n'));

console.log(chalk.white(`  📡 Sinais enviados:    ${chalk.bold(stats.totalSignals)}`));
console.log(chalk.white(`  🔗 Cliques no link:   ${chalk.bold(stats.totalClicks)}`));
console.log(chalk.white(`  💬 Reações:            ${chalk.bold(stats.totalReactions)}`));
console.log(chalk.white(`  📈 Taxa de clique:     ${chalk.bold(stats.clickRate + '%')}`));

if (stats.topSignals.length) {
  console.log('\n' + chalk.yellow('  🔥 Sinais com mais cliques:'));
  for (const s of stats.topSignals) {
    const date = new Date(s.sentAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    console.log(chalk.gray(`    • ${(s.match || '?').substring(0, 35).padEnd(35)}  ${s.clicks}🔗  ${s.reactions}💬  [${date}]`));
  }
}

if (stats.topMembers.length) {
  console.log('\n' + chalk.green('  🏆 Membros mais engajados:'));
  for (const [i, m] of stats.topMembers.entries()) {
    const tag = m.username || m.firstName || `ID ${m.userId}`;
    console.log(chalk.gray(`    ${i + 1}. ${tag.padEnd(25)}  ${m.clicks}🔗  ${m.reactions}💬`));
  }
} else {
  console.log('\n' + chalk.gray('  (nenhum dado de engajamento ainda — aguardando primeiros cliques)'));
}

console.log('\n' + chalk.bold.cyan('═'.repeat(60) + '\n'));
