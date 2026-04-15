/**
 * scheduler.js — Agendador de Rotinas do Sistema
 *
 * Gerencia todas as execuções automáticas usando node-cron.
 * Mantenha este processo rodando em background (pm2, tmux ou Task Scheduler).
 *
 * Rotinas agendadas:
 *
 *  ┌──────────────────────────────────────────────────────────────────────────┐
 *  │  Horário        │ Rotina                  │ Descrição                   │
 *  ├──────────────────────────────────────────────────────────────────────────┤
 *  │  05:45 diário   │ morning-message         │ Bom dia + resumo + agenda   │
 *  │  06:00 diário   │ daily-pipeline          │ Coleta +24h, backfill, PIE  │
 *  │  06-22h /30min  │ prelive-superodds       │ Sinais PRÉ-LIVE (buckets)   │
 *  │  13:00 diário   │ daily-pipeline (extra)  │ Partidas da tarde           │
 *  │  */1h           │ superodds-2t            │ Análise 2° Tempo (Superbet) │
 *  │  21:00 dom.     │ weekly-report           │ Resumo semanal no Telegram  │
 *  └──────────────────────────────────────────────────────────────────────────┘
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
const PIPELINE_TIMEOUT_MS = 55 * 60_000; // 55 minutos — libera lock se pipeline travar

async function safePipeline(label, opts = {}) {
  if (isRunning) {
    console.log(chalk.yellow(`[${ts()}] ⏭  ${label} — pipeline já em execução, ignorando`));
    return;
  }
  isRunning = true;
  console.log(chalk.bold.cyan(`\n[${ts()}] 🚀 Iniciando: ${label}`));

  // Watchdog — libera lock automaticamente se pipeline travar
  const watchdog = setTimeout(() => {
    if (isRunning) {
      console.error(chalk.red(`[${ts()}] ⏰ TIMEOUT — ${label} travou há mais de 55min; liberando lock`));
      isRunning = false;
    }
  }, PIPELINE_TIMEOUT_MS);

  try {
    await runDailyPipeline(opts);
  } catch (err) {
    console.error(chalk.red(`[${ts()}] ❌ ${label} — erro: ${err.message}`));
  } finally {
    clearTimeout(watchdog);
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
console.log('  🔵 06-22h (cada 30min) → PRÉ-LIVE + Super Odds: 34 varreduras/dia (buckets +1h/+3h/+6h/+12h)');
console.log('  🟢 */1h          → SUPERODDS 2T: verificação Superbet + análise 2° Tempo');
console.log('  🔍 */5 min       → Verificação de resultados GREEN/RED');
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

// ── GAMES RADAR — top jogos do dia ────────────────────────────────────────────
// Executado às 07:15 (após pipeline 06:00) e às 12:30 (resumo da tarde)
async function safeRadar(label) {
  console.log(chalk.bold.yellow(`\n[${ts()}] 📡 ${label}`));
  try {
    const { execFileSync } = await import('child_process');
    execFileSync(process.execPath, ['scripts/games-radar.js'], {
      cwd:         new URL('..', import.meta.url).pathname.replace(/^\//, ''),
      stdio:       'inherit',
      timeout:     60_000,
      windowsHide: true,
    });
    console.log(chalk.yellow(`[${ts()}] ✅ ${label} — concluído\n`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ ${label} — erro: ${e.message}`));
  }
}

// Radar matutino — todos os dias às 07:15 (após pipeline 06:00)
cron.schedule('15 7 * * *', async () => {
  await safeRadar('Games Radar — Top jogos do dia (07:15)');
}, { timezone: 'America/Sao_Paulo' });

// Radar da tarde — todos os dias às 12:30 (antes do pipeline extra das 13:00)
cron.schedule('30 12 * * *', async () => {
  await safeRadar('Games Radar — Atualização da tarde (12:30)');
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

// Executa a cada 30min das 06h às 22h — 34 varreduras/dia
// Classifica cada jogo em bucket +1h/+3h/+6h/+12h e envia ao detectar nova transição
cron.schedule('*/30 6-22 * * *', async () => {
  const h = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  await safePreLive(`Pipeline PRÉ-LIVE + Super Odds ${h} (buckets +1h/+3h/+6h/+12h)`);
}, { timezone: 'America/Sao_Paulo' });

// ── LIVE — verifica Superbet a cada 1h e analisa jogos em andamento ────────────
// Refresca o cache LIVE (playwright), depois executa o funil 2° Tempo
const _liveNotifiedKeys = new Map();

// Cleanup diário do Map de notificações live — evita memory leak após meses de execução
setInterval(() => {
  const cutoff = Date.now() - 24 * 3_600_000; // entradas > 24h
  for (const [key, ts] of _liveNotifiedKeys) {
    if (ts < cutoff) _liveNotifiedKeys.delete(key);
  }
  if (_liveNotifiedKeys.size > 0) {
    console.log(chalk.gray(`[Scheduler] 🧹 _liveNotifiedKeys limpo — ${_liveNotifiedKeys.size} entradas ativas`));
  }
}, 6 * 3_600_000); // a cada 6h

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

// Verificação de resultados GREEN/RED — a cada 5 minutos
cron.schedule('*/5 * * * *', async () => {
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
console.log(chalk.blue(`[${ts()}] 🔵 PRÉ-LIVE + Super Odds — varredura cada 30min (06-22h) | 34×/dia | buckets +1h/+3h/+6h/+12h`));
console.log(chalk.green(`[${ts()}] 🟢 SUPERODDS 2T ativo — Superbet verificado a cada 1h`));
