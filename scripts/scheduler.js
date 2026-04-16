/**
 * scheduler.js — Agendador de Rotinas do Sistema
 *
 * Gerencia todas as execuções automáticas usando node-cron.
 * Mantenha este processo rodando em background (pm2, tmux ou Task Scheduler).
 *
 * Rotinas programadas:
 *
 *  ┌────────────────────────────────────────────────────────────────────────────────┐
 *  │  Horário            │ Rotina                   │ Descrição                    │
 *  ├────────────────────────────────────────────────────────────────────────────────┤
 *  │  04:00/04:30        │ pré-operacional          │ Aquecimento cache Superbet   │
 *  │  05:00/05:30        │ pré-operacional +score   │ Score preliminar (dry run)   │
 *  │  05:45 diário       │ morning-message          │ Bom dia + resumo + agenda    │
 *  │  05:59              │ pré-op relatório         │ Relatório admin pré-abertura │
 *  │  06:00 diário       │ daily-pipeline           │ Coleta +24h, backfill, PIE   │
 *  │  06:00 · relatório  │ monitor início           │ Início de operação (admin)   │
 *  │  06-09h · /20min    │ monitor pré-live         │ 12 varreduras/período        │
 *  │  10-13h · /15min    │ monitor pré-live         │ 16 varreduras/período        │
 *  │  12:00 · relatório  │ monitor intermediário    │ Update 12h ao admin          │
 *  │  13:00 diário       │ daily-pipeline (extra)   │ Partidas da tarde            │
 *  │  14-21h · /10min    │ monitor pré-live         │ 48 varreduras/período        │
 *  │  18:00 · relatório  │ monitor intermediário    │ Update 18h ao admin          │
 *  │  a cada 1h          │ superodds-2t             │ Análise 2° Tempo (Superbet)  │
 *  │  21:00 dom.         │ weekly-report            │ Resumo semanal no Telegram   │
 *  │  22h · /15min       │ monitor pré-live         │ 4 varreduras/período         │
 *  │  23:30              │ monitor encerramento     │ Último ciclo + relatório     │
 *  └────────────────────────────────────────────────────────────────────────────────┘
 *
 * Uso:
 *   node scripts/scheduler.js              → inicia o scheduler
 *   node scripts/scheduler.js --once       → executa o pipeline agora e sai
 *   npm run scheduler                       → via package.json
 */

import cron   from 'node-cron';
import chalk  from 'chalk';
import { runDailyPipeline }  from './daily-pipeline.js';
import { runResultChecker }  from './result-checker.js';
import { runMonitorCycle, runPreOpCycle } from './prelive-monitor.js';

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

console.log(chalk.bold.cyan('\n' + '═'.repeat(62)));
console.log(chalk.bold.cyan('  ⏰ Scheduler de Análise Esportiva — Ativo'));
console.log(chalk.bold.cyan('═'.repeat(62)));
console.log('  Rotinas programadas:');
console.log('  🌅 04:00-05:59      → Pré-operacional (aquecimento + score)');
console.log('  🌅 05:45 diário     → Mensagem de bom dia');
console.log('  📡 06:00 diário     → Pipeline histórico (calibração PIE)');
console.log('  🔵 06-09h (20min)   → Monitor PRÉ-LIVE  · 12 ciclos');
console.log('  🔵 10-13h (15min)   → Monitor PRÉ-LIVE  · 16 ciclos');
console.log('  🔵 14-21h (10min)   → Monitor PRÉ-LIVE  · 48 ciclos');
console.log('  🔵 22h   (15min)    → Monitor PRÉ-LIVE  ·  4 ciclos');
console.log('  📋 06h/12h/18h/23h  → Relatórios operacionais ao admin');
console.log('  📡 13:00 diário     → Pipeline histórico extra (tarde)');
console.log('  🟢 */1h             → SUPERODDS 2T: análise 2° Tempo');
console.log('  🔍 */5 min          → Verificação de resultados GREEN/RED');
console.log('  📊 21:00 domingo    → Relatório semanal');
console.log('  💡 Ctrl+C para parar\n');

// ── Pré-operacional (04:00–05:59) ──────────────────────────────────────────────
// Aquece o cache Playwright, mapeia jogos e calcula scores sem enviar ao grupo

async function safePreOp(label, opts = {}) {
  console.log(chalk.bold.yellow(`\n[${ts()}] 🌅 ${label}`));
  try {
    await runPreOpCycle({ label, ...opts });
    console.log(chalk.yellow(`[${ts()}] ✅ ${label} — concluído\n`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ ${label} — erro: ${e.message}`));
  }
}

// 04:00 e 04:30 — aquecimento de cache
cron.schedule('0 4 * * *', () =>
  safePreOp('Pré-Op 04:00 (aquecimento)'),
  { timezone: 'America/Sao_Paulo' });

cron.schedule('30 4 * * *', () =>
  safePreOp('Pré-Op 04:30 (aquecimento)'),
  { timezone: 'America/Sao_Paulo' });

// 05:00 e 05:30 — cache + score preliminar (dry run)
cron.schedule('0 5 * * *', () =>
  safePreOp('Pré-Op 05:00 (score)', { calcScore: true }),
  { timezone: 'America/Sao_Paulo' });

cron.schedule('30 5 * * *', () =>
  safePreOp('Pré-Op 05:30 (score final)', { calcScore: true }),
  { timezone: 'America/Sao_Paulo' });

// 05:59 — relatório pré-abertura ao admin (fila pronta)
cron.schedule('59 5 * * *', () =>
  safePreOp('Pré-Op 05:59 (relatório)', { sendReport: true }),
  { timezone: 'America/Sao_Paulo' });

// ── Monitor PRÉ-LIVE contínuo (intervalos variáveis por período) ───────────────
// Detecta: novos jogos · variação de odds · gate 30min · anti-duplicata
// Relatórios automáticos: inicio(06:00) · intermediário(12:00/18:00) · encerramento(23:30)

let _monitorRunning = false;

/**
 * Executa um ciclo do monitor pré-live com proteção anti-overlap.
 * Auto-detecta horários de relatório (06:00, 12:00, 18:00, 23:30).
 */
async function safeMonitor(label, opts = {}) {
  if (_monitorRunning) {
    console.log(chalk.yellow(`[${ts()}] ⏭  ${label} — monitor já em execução, ignorando`));
    return;
  }
  _monitorRunning = true;

  // Auto-detectar horário de relatório operacional
  const h = new Date().getHours();
  const m = new Date().getMinutes();
  const autoReportTipo =
    (h === 6  && m === 0)  ? 'inicio'        :
    (h === 12 && m === 0)  ? 'intermediario' :
    (h === 18 && m === 0)  ? 'intermediario' :
    (h === 23 && m === 30) ? 'encerramento'  : null;

  const finalOpts = {
    ...opts,
    sendReport: opts.sendReport || autoReportTipo !== null,
    reportTipo: opts.reportTipo || autoReportTipo || undefined,
  };

  const suffix = finalOpts.sendReport ? ` [+relatório ${finalOpts.reportTipo}]` : '';
  console.log(chalk.bold.blue(`\n[${ts()}] 🔵 ${label}${suffix}`));

  try {
    await runMonitorCycle(finalOpts);
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ ${label} — erro: ${e.message}`));
  } finally {
    _monitorRunning = false;
    console.log(chalk.blue(`[${ts()}] ✅ ${label} — concluído\n`));
  }
}

function _monitorLabel() {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, '0');
  const mm  = String(now.getMinutes()).padStart(2, '0');
  return `Monitor ${hh}:${mm}`;
}

// 06-09h: ciclo a cada 20min — inclui relatório 'inicio' às 06:00
cron.schedule('*/20 6-9 * * *', () =>
  safeMonitor(_monitorLabel()),
  { timezone: 'America/Sao_Paulo' });

// 10-13h: ciclo a cada 15min — inclui relatório 'intermediario' às 12:00
cron.schedule('*/15 10-13 * * *', () =>
  safeMonitor(_monitorLabel()),
  { timezone: 'America/Sao_Paulo' });

// 14-21h: ciclo a cada 10min — inclui relatório 'intermediario' às 18:00
cron.schedule('*/10 14-21 * * *', () =>
  safeMonitor(_monitorLabel()),
  { timezone: 'America/Sao_Paulo' });

// 22h: ciclo a cada 15min
cron.schedule('*/15 22 * * *', () =>
  safeMonitor(_monitorLabel()),
  { timezone: 'America/Sao_Paulo' });

// 23:30 — encerramento do dia (último ciclo + relatório)
cron.schedule('30 23 * * *', () =>
  safeMonitor('Monitor Encerramento 23:30', { sendReport: true, reportTipo: 'encerramento' }),
  { timezone: 'America/Sao_Paulo' });

// ── Mensagem de bom dia ────────────────────────────────────────────────────────
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

// ── Pipeline diário ────────────────────────────────────────────────────────────
// Pipeline principal — todos os dias às 06:00
cron.schedule('0 6 * * *', async () => {
  await safePipeline('Pipeline Diário 06h', { datesBack: 2 });
}, { timezone: 'America/Sao_Paulo' });

// Pipeline extra — todos os dias às 13:00
cron.schedule('0 13 * * *', async () => {
  await safePipeline('Pipeline Extra 13h', { datesBack: 1 });
}, { timezone: 'America/Sao_Paulo' });

// ── GAMES RADAR — top jogos do dia ────────────────────────────────────────────
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

// ── LIVE — verifica Superbet a cada 1h e analisa jogos em andamento ────────────
const _liveNotifiedKeys = new Map();

// Cleanup diário do Map de notificações live — evita memory leak após meses de execução
setInterval(() => {
  const cutoff = Date.now() - 24 * 3_600_000;
  for (const [key, tsVal] of _liveNotifiedKeys) {
    if (tsVal < cutoff) _liveNotifiedKeys.delete(key);
  }
  if (_liveNotifiedKeys.size > 0) {
    console.log(chalk.gray(`[Scheduler] 🧹 _liveNotifiedKeys limpo — ${_liveNotifiedKeys.size} entradas ativas`));
  }
}, 6 * 3_600_000);

cron.schedule('0 * * * *', async () => {
  const h = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  console.log(chalk.bold.green(`\n[${ts()}] 🟢 LIVE Scan ${h} — verificando Superbet...`));
  try {
    const { refreshCache }    = await import('../src/scrapers/superbet-cache.js');
    const { runLive2TFunnel } = await import('../src/funnels/funnel-live-2t.js');
    const { notifyLive2TOpportunity } = await import('../src/utils/telegram.js');

    await refreshCache('live');

    const opps = await runLive2TFunnel(_liveNotifiedKeys);
    if (!opps.length) {
      console.log(chalk.gray(`[${ts()}] ℹ️  LIVE: nenhuma oportunidade no 2° Tempo`));
      return;
    }

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

// ── Relatório diário privado ao admin ─────────────────────────────────────────
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

// ── Relatório semanal ─────────────────────────────────────────────────────────
cron.schedule('0 21 * * 0', async () => {
  console.log(chalk.bold.yellow(`\n[${ts()}] 📊 Relatório Semanal`));
  try {
    const { getStats }     = await import('../src/pie/pie-storage.js');
    const { notifyPIEStats } = await import('../src/utils/telegram.js');
    await notifyPIEStats(getStats());
    console.log(chalk.green(`[${ts()}] ✅ Relatório semanal enviado`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ Relatório falhou: ${e.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

// ── Verificação de resultados GREEN/RED ───────────────────────────────────────
cron.schedule('*/5 * * * *', async () => {
  console.log(chalk.cyan(`\n[${ts()}] 🔍 Verificando resultados pendentes (GREEN/RED)...`));
  try {
    await runResultChecker();
  } catch (err) {
    console.error(chalk.red(`[${ts()}] ❌ Result checker falhou: ${err.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

// ── Polling do Guardian ────────────────────────────────────────────────────────
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
      if (upd.chat_join_request) {
        await handleJoinRequest(upd).catch(() => {});
        continue;
      }
      if (upd.callback_query) {
        await handleCallbackQuery(upd).catch(() => {});
        continue;
      }
      if (upd.message_reaction) {
        await handleMessageReaction(upd).catch(() => {});
        continue;
      }
      await handleGuardianCommand(upd).catch(() => {});
      await handleNewMember(upd).catch(() => {});
      await handleAntiFlood(upd).catch(() => {});
    }
  } catch { /* silent */ }
}, 10_000);

// ── Keepalive ─────────────────────────────────────────────────────────────────
console.log(chalk.gray(`[${ts()}] 💓 Scheduler iniciado — aguardando horários agendados...`));
console.log(chalk.bold.green(`[${ts()}] 🛡️  Group Guardian ativo — polling a cada 10s`));
console.log(chalk.yellow(`[${ts()}] 🌅 Pré-operacional: 04:00/04:30/05:00/05:30/05:59`));
console.log(chalk.blue(`[${ts()}] 🔵 Monitor PRÉ-LIVE: 06-09h(20min) · 10-13h(15min) · 14-21h(10min) · 22h(15min) · 23:30`));
console.log(chalk.green(`[${ts()}] 🟢 SUPERODDS 2T ativo — Superbet verificado a cada 1h`));
