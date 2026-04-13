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
 *  │  05:45 diário│ morning-message         │ Bom dia + resumo + agenda  │
 *  │  06:00 diário│ daily-pipeline          │ Coleta +24h, backfill, PIE │
 *  │  13:00 diário│ daily-pipeline (extra)  │ Partidas da tarde          │
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

// ── Group Guardian — ativa proteção de conteúdo no startup ────────────────────
try {
  const { initGroupGuardian, cacheBotId } = await import('../src/utils/group-guardian.js');
  await cacheBotId();
  await initGroupGuardian();
} catch (e) {
  console.warn(chalk.yellow(`[Guardian] Aviso ao iniciar: ${e.message}`));
}

console.log(chalk.bold.cyan('\n' + '═'.repeat(60)));
console.log(chalk.bold.cyan('  ⏰ Scheduler de Análise Esportiva — Ativo'));
console.log(chalk.bold.cyan('═'.repeat(60)));
console.log('  Rotinas programadas:');
console.log('  🌅 05:45 diário  → Mensagem de bom dia + resumo do dia anterior');
console.log('  📡 06:00 diário  → Pipeline histórico (calibração PIE)');
console.log('  📡 13:00 diário  → Pipeline histórico extra (tarde)');
console.log('  🔵 07,10,14,17h  → PRÉ-LIVE: oportunidades 6-24h antes do kickoff');
console.log('  🟢 */1h          → LIVE: verificação Superbet + análise 2° Tempo');
console.log('  🔍 */30 min      → Verificação de resultados GREEN/RED');
console.log('  📊 21:00 domingo → Relatório semanal');
console.log('  💡 Ctrl+C para parar\n');

// Mensagem de bom dia — todos os dias às 05:45
// Enviada antes dos sinais para preparar os jogadores
cron.schedule('45 5 * * *', async () => {
  console.log(chalk.bold.yellow(`\n[${ts()}] 🌅 Enviando mensagem de bom dia...`));
  try {
    const { sendMorningMessage } = await import('./morning-message.js');
    await sendMorningMessage();
    console.log(chalk.green(`[${ts()}] ✅ Mensagem de bom dia enviada`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ Morning message falhou: ${e.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

// Pipeline principal — todos os dias às 06:00
// Coleta partidas com 24h+ de antecedência para melhores odds
cron.schedule('0 6 * * *', async () => {
  await safePipeline('Pipeline Diário 06h', { datesBack: 2 });
}, { timezone: 'America/Sao_Paulo' });

// Pipeline extra — todos os dias às 13:00
// Captura partidas da manhã que já encerraram
cron.schedule('0 13 * * *', async () => {
  await safePipeline('Pipeline Extra 13h', { datesBack: 1 });
}, { timezone: 'America/Sao_Paulo' });

// ── PRÉ-LIVE — busca oportunidades 6-24h antes do kickoff ─────────────────────
// Executado às 07:00, 10:00, 14:00, 17:00 para cobrir todas as grades do dia
let _preLiveRunning = false;

async function safePreLive(label) {
  if (_preLiveRunning) {
    console.log(chalk.yellow(`[${ts()}] ⏭  ${label} — pipeline já em execução, ignorando`));
    return;
  }
  _preLiveRunning = true;
  console.log(chalk.bold.blue(`\n[${ts()}] 🔵 ${label}`));
  try {
    const { runPreLiveSuperOdds } = await import('./prelive-superodds-now.js');
    await runPreLiveSuperOdds();
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ ${label} — erro: ${e.message}`));
  } finally {
    _preLiveRunning = false;
    console.log(chalk.blue(`[${ts()}] ✅ ${label} — concluído\n`));
  }
}

cron.schedule('0 7,10,14,17 * * *', async () => {
  const h = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  await safePreLive(`Pipeline PRÉ-LIVE ${h} (janela 6-24h)`);
}, { timezone: 'America/Sao_Paulo' });

// ── LIVE — verifica Superbet a cada 1h e analisa jogos em andamento ────────────
// Refresca o cache LIVE (playwright), depois executa o funil 2° Tempo
const _liveNotifiedKeys = new Map();

cron.schedule('0 * * * *', async () => {
  const h = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  console.log(chalk.bold.green(`\n[${ts()}] 🟢 LIVE Scan ${h} — verificando Superbet...`));
  try {
    const { refreshCache }    = await import('../src/scrapers/superbet-cache.js');
    const { runLive2TFunnel } = await import('../src/funnels/funnel-live-2t.js');
    const { notifyLive2TOpportunity } = await import('../src/utils/telegram.js');

    // Atualiza cache AO VIVO do Superbet (raspa a página em tempo real)
    await refreshCache('live');

    const opps = await runLive2TFunnel(_liveNotifiedKeys);
    if (!opps.length) {
      console.log(chalk.gray(`[${ts()}] ℹ️  LIVE: nenhuma oportunidade no 2° Tempo`));
      return;
    }

    // Agrupa por jogo e envia uma notificação por partida
    const byMatch = new Map();
    for (const opp of opps) {
      const key = (opp._liveData?.match || 'unknown').toLowerCase().trim();
      if (!byMatch.has(key)) byMatch.set(key, { liveData: opp._liveData, markets: [] });
      const { _liveData, ...market } = opp;
      byMatch.get(key).markets.push(market);
    }
    for (const { liveData, markets } of byMatch.values()) {
      await notifyLive2TOpportunity(liveData, markets).catch(() => {});
    }
    console.log(chalk.bold.green(`[${ts()}] ✅ LIVE: ${opps.length} oportunidade(s) enviadas`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ LIVE Scan falhou: ${e.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

// Relatório diário privado ao admin — todos os dias às 21:30
cron.schedule('30 21 * * *', async () => {
  console.log(chalk.bold.yellow(`\n[${ts()}] 📋 Relatório diário → admin DM`));
  try {
    const { loadDB, getStats, loadPieSnapshots } = await import('../src/pie/pie-storage.js');
    const { notifyAdminDailySummary }            = await import('../src/utils/telegram.js');
    const { getOverallStats }                    = await import('../src/utils/engagement-tracker.js');
    const db       = loadDB();
    const pieStats = getStats();
    const snaps    = loadPieSnapshots(2);
    const engStats = getOverallStats({ daysBack: 1 });
    await notifyAdminDailySummary({
      pieStats,
      calibration: db.calibration || {},
      engStats,
      snapshots:   snaps,
    });
    console.log(chalk.green(`[${ts()}] ✅ Relatório diário enviado ao admin`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ Relatório diário falhou: ${e.message}`));
  }
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
  console.log(chalk.gray(`[${ts()}] 💓 Scheduler ativo — próximo pipeline: 06:00`));
}, { timezone: 'America/Sao_Paulo' });

// ── Polling do Guardian — verifica updates a cada 10s ────────────────────────
// Processa: comandos de admin, pedidos de entrada, aprovações, anti-flood, DM setup
let _guardianOffset = 0;
const ALLOWED_UPDATES = ['message', 'chat_join_request', 'callback_query', 'message_reaction'];

setInterval(async () => {
  try {
    const { handleGuardianCommand, handleNewMember, handleAntiFlood,
            handleJoinRequest, handleCallbackQuery,
            handleMessageReaction } = await import('../src/utils/group-guardian.js');

    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates` +
      `?offset=${_guardianOffset}&limit=20&timeout=0` +
      `&allowed_updates=${JSON.stringify(ALLOWED_UPDATES)}`;

    const updates = await fetch(url).then(r => r.json()).catch(() => ({ result: [] }));

    for (const upd of (updates?.result || [])) {
      _guardianOffset = upd.update_id + 1;
      // Pedido de entrada no grupo (link com aprovação obrigatória)
      if (upd.chat_join_request) {
        await handleJoinRequest(upd).catch(() => {});
        continue;
      }
      // Resposta do admin + rastreamento de clique no link do sinal
      if (upd.callback_query) {
        await handleCallbackQuery(upd).catch(() => {});
        continue;
      }
      // Reações a mensagens — rastreia engajamento por sinal
      if (upd.message_reaction) {
        await handleMessageReaction(upd).catch(() => {});
        continue;
      }
      // Comandos de admin e setup via DM
      await handleGuardianCommand(upd).catch(() => {});
      // Novos membros e anti-flood
      await handleNewMember(upd).catch(() => {});
      await handleAntiFlood(upd).catch(() => {});
    }
  } catch { /* silent */ }
}, 10_000);

// Mantém processo vivo
console.log(chalk.gray(`[${ts()}] 💓 Scheduler iniciado — aguardando horários agendados...`));
console.log(chalk.bold.green(`[${ts()}] 🛡️  Group Guardian ativo — polling a cada 10s`));
console.log(chalk.blue(`[${ts()}] 🔵 PRÉ-LIVE ativo — varredura às 07h, 10h, 14h, 17h (janela 6-24h)`));
console.log(chalk.green(`[${ts()}] 🟢 LIVE ativo — Superbet verificado a cada 1h`));
