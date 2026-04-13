/**
 * scheduler.js — Agendador de Rotinas do Sistema
 *
 * Gerencia todas as execuções automáticas usando node-cron.
 * Mantenha este processo rodando em background (pm2, tmux ou Task Scheduler).
 *
 * Rotinas agendadas:
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │  Horário     │ Rotina                  │ Descrição                  │
 *  ├─────────────────────────────────────────────────────────────────────┤
 *  │  08:00 diário│ daily-pipeline          │ Coleta +24h, backfill, PIE │
 *  │  13:00 diário│ daily-pipeline (extra)  │ Partidas matinais fechadas  │
 *  │  21:00 dom.  │ weekly-report           │ Resumo semanal no Telegram │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 * Uso:
 *   node scripts/scheduler.js              → inicia o scheduler
 *   node scripts/scheduler.js --once       → executa o pipeline agora e sai
 *   npm run scheduler                       → via package.json
 */

import cron   from 'node-cron';
import chalk  from 'chalk';
import { runDailyPipeline } from './daily-pipeline.js';
import { runResultChecker } from './result-checker.js';

// ── Lock anti-overlap ──────────────────────────────────────────────────────────
// Evita que duas execuções simultâneas corrompam o PIE
let isRunning = false;

async function safePipeline(label, opts = {}) {
  if (isRunning) {
    console.log(chalk.yellow(`[${ts()}] ⏭  ${label} — pipeline já em execução, ignorando`));
    return;
  }
  isRunning = true;
  console.log(chalk.bold.cyan(`\n[${ts()}] 🚀 Iniciando: ${label}`));
  try {
    await runDailyPipeline(opts);
  } catch (err) {
    console.error(chalk.red(`[${ts()}] ❌ ${label} — erro: ${err.message}`));
  } finally {
    isRunning = false;
    console.log(chalk.green(`[${ts()}] ✅ ${label} — concluído\n`));
  }
}

function ts() { return new Date().toLocaleString('pt-BR'); }

// ── Execução única (--once) ────────────────────────────────────────────────────
if (process.argv.includes('--once')) {
  import('dotenv/config').catch(() => {});
  console.log(chalk.bold('\n📋 Execução única do pipeline diário...\n'));
  await runDailyPipeline({ datesBack: 2 });
  process.exit(0);
}

// ── Agendamento ────────────────────────────────────────────────────────────────
import('dotenv/config').catch(() => {});

console.log(chalk.bold.cyan('\n' + '═'.repeat(60)));
console.log(chalk.bold.cyan('  ⏰ Scheduler de Análise Esportiva — Ativo'));
console.log(chalk.bold.cyan('═'.repeat(60)));
console.log('  Rotinas programadas:');
console.log('  📡 08:00 diário  → Pipeline completo (dados de ontem)');
console.log('  📡 13:00 diário  → Pipeline extra (jogos da manhã)');
console.log('  🔍 */30 min      → Verificação de resultados GREEN/RED');
console.log('  📊 21:00 domingo → Relatório semanal PIE');
console.log('  💡 Ctrl+C para parar\n');

// Pipeline principal — todos os dias às 08:00
// Coleta partidas de ontem (>24h garantido)
cron.schedule('0 8 * * *', async () => {
  await safePipeline('Pipeline Diário 08h', { datesBack: 2 });
}, { timezone: 'America/Sao_Paulo' });

// Pipeline extra — todos os dias às 13:00
// Captura partidas da manhã que já encerraram
cron.schedule('0 13 * * *', async () => {
  await safePipeline('Pipeline Extra 13h', { datesBack: 1 });
}, { timezone: 'America/Sao_Paulo' });

// Relatório semanal — domingos às 21:00
cron.schedule('0 21 * * 0', async () => {
  console.log(chalk.bold.yellow(`\n[${ts()}] 📊 Relatório Semanal`));
  try {
    const { etapa6_relatorio } = await import('./daily-pipeline.js');
    // Emite relatório PIE no Telegram
    const { getStats } = await import('../src/pie/pie-storage.js');
    const { notifyPIEStats } = await import('../src/utils/telegram.js');
    await notifyPIEStats(getStats());
    console.log(chalk.green(`[${ts()}] ✅ Relatório semanal enviado`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ Relatório falhou: ${e.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

// Verificação de resultados GREEN/RED — a cada 30 minutos
cron.schedule('*/30 * * * *', async () => {
  console.log(chalk.cyan(`\n[${ts()}] 🔍 Verificando resultados pendentes (GREEN/RED)...`));
  try {
    await runResultChecker();
  } catch (err) {
    console.error(chalk.red(`[${ts()}] ❌ Result checker falhou: ${err.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

// Keepalive — confirma que o scheduler está ativo a cada hora
cron.schedule('0 * * * *', () => {
  console.log(chalk.gray(`[${ts()}] 💓 Scheduler ativo — próximo pipeline: 08:00`));
}, { timezone: 'America/Sao_Paulo' });

// Mantém processo vivo
console.log(chalk.gray(`[${ts()}] 💓 Scheduler iniciado — aguardando horários agendados...`));
