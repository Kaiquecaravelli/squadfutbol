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
 *  │  06-09h · /30min    │ varredura pré-live IA    │ 6 varreduras/período         │
 *  │  10-13h · /20min    │ varredura pré-live IA    │ 9 varreduras/período         │
 *  │  12:00 · relatório  │ monitor intermediário    │ Update 12h ao admin          │
 *  │  13:00 diário       │ daily-pipeline (extra)   │ Partidas da tarde            │
 *  │  14-21h · /15min    │ varredura pré-live IA    │ 32 varreduras/período        │
 *  │  18:00 · relatório  │ monitor intermediário    │ Update 18h ao admin          │
 *  │  a cada 1h          │ superodds-2t             │ Análise 2° Tempo (Superbet)  │
 *  │  21:00 dom.         │ weekly-report            │ Resumo semanal no Telegram   │
 *  │  22h · /30min       │ varredura pré-live IA    │ 2 varreduras/período         │
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
import { runSweepAndLearn }  from './sweep-and-learn.js';
import { runPreOpCycle } from './prelive-monitor.js';
import { runPreLiveSuperOdds } from './prelive-superodds-now.js';
import { checkAndEscalate, runEscalationProtocol } from './escalation-protocol.js';
import { restaurarAoStartup } from './alert-protocol.js';
import { sendDailyClosingReport } from './educational-analysis.js';
import { getDailyStatus } from './daily-counter.js';
import { layerOneCheck, markScanExecutedSync } from './cycle-check.js';
import { executarFeedLoop, verificarFeedLoop } from '../src/learning/feed-loop.js';
import { isSystemIdle }        from '../src/training/idleDetector.js';
import { executarCicloTreino, executarSessaoNoturna } from '../src/training/trainingOrchestrator.js';

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

// ── Limpeza de alertas orphan de sessões anteriores ───────────────────────────
try {
  await restaurarAoStartup();
} catch (e) {
  console.warn(chalk.yellow(`[AlertProtocol] Aviso ao restaurar alertas: ${e.message}`));
}

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
console.log('  🔵 06-09h (30min)   → Varredura PRÉ-LIVE IA  ·  6 ciclos');
console.log('  🔵 10-13h (20min)   → Varredura PRÉ-LIVE IA  ·  9 ciclos');
console.log('  🔵 14-21h (15min)   → Varredura PRÉ-LIVE IA  · 32 ciclos');
console.log('  🔵 22h   (30min)    → Varredura PRÉ-LIVE IA  ·  2 ciclos');
console.log('  📋 06h/12h/18h/23h  → Relatórios operacionais ao admin');
console.log('  📡 13:00 diário     → Pipeline histórico extra (tarde)');
console.log('  🟢 */1h             → SUPERODDS 2T: análise 2° Tempo');
console.log('  🔍 */5 min          → Verificação de resultados GREEN/RED');
console.log('  🧹 08:00 / 22:00    → Sweep & Learn (varredura completa + admin)');
console.log('  📊 21:00 domingo    → Relatório semanal');
console.log('  🚨 12h/15h/18h/21h  → Alertas de mínimo diário (Módulo 1.3)');
console.log('  📝 23:45            → Relatório de fechamento do dia (admin)');
console.log('  🧠 01:30 diário     → Sessão noturna intensiva (prep overnight-trainer)');
console.log('  🧠 */10 min (ocioso)→ Ciclo de treino contínuo (backfill + sniper)');
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

// ── Varredura PRÉ-LIVE com IA (intervalos variáveis por período) ───────────────
// Executa agentes BTTS · Gols · Escanteios + Parlay Builder em todas as partidas
// Anti-overlap: ignora disparo se varredura anterior ainda estiver rodando

let _scanRunning = false;
const SCAN_TIMEOUT_MS = 8 * 60_000; // 8 min — libera lock se scan travar

async function safeScan(label, opts = {}) {
  if (_scanRunning) {
    console.log(chalk.yellow(`[${ts()}] ⏭  ${label} — varredura em execução, ignorando`));
    return;
  }

  // ── Camada 1: Check Binário (Módulo 1.1) ───────────────────────────────────
  // Executa 5 checks ultra-leves (50 tokens) antes de acionar o scan completo.
  // SE todos negativos: encerra aqui — economiza ~550 tokens/ciclo.
  // SE forceRun=true (escalada de emergência): pula o check.
  if (!opts.forceRun) {
    try {
      const l1 = layerOneCheck();
      if (!l1.shouldScan) {
        console.log(chalk.gray(`[${ts()}] ⏩ ${label} — ${l1.reason}`));
        return;
      }
      console.log(chalk.gray(`[${ts()}] 🟡 Camada 1: ${l1.reason}`));
    } catch { /* falha no check não bloqueia o scan */ }
  }

  _scanRunning = true;

  const watchdog = setTimeout(() => {
    if (_scanRunning) {
      console.error(chalk.red(`[${ts()}] ⏰ TIMEOUT — ${label} travou há mais de 8min; liberando lock`));
      _scanRunning = false;
    }
  }, SCAN_TIMEOUT_MS);

  console.log(chalk.bold.blue(`\n[${ts()}] 🔵 ${label}`));
  try {
    await runPreLiveSuperOdds();
    markScanExecutedSync(); // registra timestamp para check C4 nos próximos ciclos
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ ${label} — erro: ${e.message}`));
  } finally {
    clearTimeout(watchdog);
    _scanRunning = false;
    console.log(chalk.blue(`[${ts()}] ✅ ${label} — concluído\n`));
  }
}

function _scanLabel() {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, '0');
  const mm  = String(now.getMinutes()).padStart(2, '0');
  return `Varredura PRÉ-LIVE ${hh}:${mm}`;
}

// 06-09h: a cada 30min
cron.schedule('*/30 6-9 * * *', () =>
  safeScan(_scanLabel()),
  { timezone: 'America/Sao_Paulo' });

// 10-13h: a cada 20min
cron.schedule('*/20 10-13 * * *', () =>
  safeScan(_scanLabel()),
  { timezone: 'America/Sao_Paulo' });

// 14-21h: a cada 15min — janela principal de jogos
cron.schedule('*/15 14-21 * * *', () =>
  safeScan(_scanLabel()),
  { timezone: 'America/Sao_Paulo' });

// 22h: a cada 30min
cron.schedule('*/30 22 * * *', () =>
  safeScan(_scanLabel()),
  { timezone: 'America/Sao_Paulo' });

// 23:30 — último ciclo do dia
cron.schedule('30 23 * * *', () =>
  safeScan('Varredura PRÉ-LIVE 23:30 (última do dia)'),
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
    const { getStats }       = await import('../src/pie/pie-storage.js');
    const { notifyPIEStats } = await import('../src/utils/telegram.js');
    await notifyPIEStats(getStats());
    console.log(chalk.green(`[${ts()}] ✅ Relatório semanal enviado`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ Relatório PIE falhou: ${e.message}`));
  }

  // ── Relatório semanal de Under Bloqueados (Módulo 4) ─────────────────────
  try {
    const token   = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
    if (token && adminId) {
      const { gerarRelatorioUnderBloqueados } = await import('../src/data/underBlockedTracker.js');
      const msg = gerarRelatorioUnderBloqueados();
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: adminId, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      console.log(chalk.green(`[${ts()}] ✅ Relatório Under Bloqueados enviado ao admin`));
    }
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ Relatório Under Bloqueados falhou: ${e.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

// ── Protocolo de Mínimo Diário Garantido — Módulo 1.3 ────────────────────────
// Verifica contador e escala para o nível adequado se abaixo da meta.
//   12:00 → SE contador = 0: escala para Nível 2
//   15:00 → SE contador < 2: escala para Nível 3
//   18:00 → SE contador < 3: escala para Nível 4 + educacional
//   21:00 → SE contador < 3: ALERTA CRÍTICO — Nível 5 + 6
//   23:59 → Registra fechamento (sem escalada)

cron.schedule('0 12 * * *', async () => {
  const { total } = getDailyStatus();
  console.log(chalk.bold.red(`\n[${ts()}] 🚨 Verificação 12h — análises hoje: ${total}`));
  try { await checkAndEscalate('12:00'); }
  catch (e) { console.error(chalk.red(`[${ts()}] ❌ Alerta 12h falhou: ${e.message}`)); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 15 * * *', async () => {
  const { total } = getDailyStatus();
  console.log(chalk.bold.red(`\n[${ts()}] 🚨 Verificação 15h — análises hoje: ${total}`));
  try { await checkAndEscalate('15:00'); }
  catch (e) { console.error(chalk.red(`[${ts()}] ❌ Alerta 15h falhou: ${e.message}`)); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 18 * * *', async () => {
  const { total } = getDailyStatus();
  console.log(chalk.bold.red(`\n[${ts()}] 🚨 Verificação 18h — análises hoje: ${total}`));
  try { await checkAndEscalate('18:00'); }
  catch (e) { console.error(chalk.red(`[${ts()}] ❌ Alerta 18h falhou: ${e.message}`)); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 20 * * *', async () => {
  const { total } = getDailyStatus();
  console.log(chalk.bold.red(`\n[${ts()}] 🚨 ALERTA CRÍTICO 20h — análises hoje: ${total}`));
  try { await checkAndEscalate('20:00'); }
  catch (e) { console.error(chalk.red(`[${ts()}] ❌ Alerta 20h falhou: ${e.message}`)); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 21 * * *', async () => {
  const { total } = getDailyStatus();
  console.log(chalk.bold.red(`\n[${ts()}] 🚨 ALERTA CRÍTICO 21h — análises hoje: ${total}`));
  try { await checkAndEscalate('21:00'); }
  catch (e) { console.error(chalk.red(`[${ts()}] ❌ Alerta 21h falhou: ${e.message}`)); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 22 * * *', async () => {
  const { total } = getDailyStatus();
  console.log(chalk.bold.red(`\n[${ts()}] 🆘 EMERGÊNCIA 22h — análises hoje: ${total}`));
  try { await checkAndEscalate('22:00'); }
  catch (e) { console.error(chalk.red(`[${ts()}] ❌ Emergência 22h falhou: ${e.message}`)); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('59 23 * * *', async () => {
  const { total, status } = getDailyStatus();
  const label = total >= 3 ? '[META ATINGIDA]' : '[DIA INCOMPLETO]';
  console.log(chalk.bold.yellow(`\n[${ts()}] 📊 Fechamento 23:59 — ${total} análises — ${label} (${status})`));
  try { await checkAndEscalate('23:59'); }
  catch { /* apenas log, sem escalada */ }
}, { timezone: 'America/Sao_Paulo' });

// ── Relatório de fechamento diário (admin DM · 23:45) ─────────────────────────
// Módulo 6.1 — resume o dia: análises enviadas, resultados, padrão estudado
// Agendado 15min após a última varredura (23:30) para incluir resultados finais.
cron.schedule('45 23 * * *', async () => {
  console.log(chalk.bold.yellow(`\n[${ts()}] 📝 Relatório de fechamento do dia → admin DM`));
  try {
    await sendDailyClosingReport();
    console.log(chalk.green(`[${ts()}] ✅ Fechamento enviado ao admin`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ Fechamento falhou: ${e.message}`));
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

// ── Sweep & Learn — varredura completa 2× por dia ────────────────────────────
// Complementa o result-checker (*/5 min) com um relatório consolidado ao admin
// Útil para detectar pendências acumuladas e forçar ciclo de aprendizagem completo
cron.schedule('0 8 * * *', async () => {
  console.log(chalk.bold.magenta(`\n[${ts()}] 🧹 Sweep & Learn 08:00 — varredura completa`));
  try {
    await runSweepAndLearn();
  } catch (err) {
    console.error(chalk.red(`[${ts()}] ❌ Sweep 08:00 falhou: ${err.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 22 * * *', async () => {
  console.log(chalk.bold.magenta(`\n[${ts()}] 🧹 Sweep & Learn 22:00 — varredura completa`));
  try {
    await runSweepAndLearn();
  } catch (err) {
    console.error(chalk.red(`[${ts()}] ❌ Sweep 22:00 falhou: ${err.message}`));
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

// ── Feed Loop — autoalimentação do PIE ────────────────────────────────────────
// Diariamente às 06:05 (após o pipeline): ajusta lambdaFatores + relatório dominical
cron.schedule('5 6 * * *', async () => {
  console.log(chalk.bold.cyan(`\n[${ts()}] 🧠 Feed Loop — ciclo de autoalimentação PIE`));
  try {
    const { processadas, ajustes } = await executarFeedLoop();
    console.log(chalk.cyan(`[${ts()}] ✅ FeedLoop: ${processadas} lições · ${ajustes} ajuste(s) de λ`));
  } catch (e) {
    console.error(chalk.red(`[${ts()}] ❌ FeedLoop falhou: ${e.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

// Verificação horária: aciona se >= 10 lições novas acumuladas
cron.schedule('30 * * * *', async () => {
  try { await verificarFeedLoop(); }
  catch { /* silencioso */ }
}, { timezone: 'America/Sao_Paulo' });

// ── Treinamento Contínuo em Janelas Ociosas ───────────────────────────────────
// Ciclo leve a cada 10 min: verifica ociosidade e treina se disponível.
// Anti-sobreposição: respeita _scanRunning para não competir com varreduras ativas.

setInterval(async () => {
  try {
    const { isIdle, janela, reason } = isSystemIdle({ scanRunning: _scanRunning });
    if (!isIdle) {
      console.log(chalk.gray(`[${ts()}] 🧠 Treino: sistema ativo (${reason}) — aguardando`));
      return;
    }
    console.log(chalk.cyan(`[${ts()}] 🧠 Treino: sistema ocioso (${janela}) — iniciando ciclo`));
    await executarCicloTreino();
  } catch (err) {
    console.error(chalk.red(`[${ts()}] ❌ Ciclo de treino: ${err.message}`));
  }
}, 10 * 60 * 1000); // a cada 10 minutos

// 01:30 — sessão noturna intensiva (fecha loops + calibra antes do overnight-trainer das 02:00)
cron.schedule('30 1 * * *', async () => {
  console.log(chalk.bold.cyan(`\n[${ts()}] 🌙 Sessão noturna intensiva iniciada (01:30)`));
  try {
    await executarSessaoNoturna();
  } catch (err) {
    console.error(chalk.red(`[${ts()}] ❌ Sessão noturna falhou: ${err.message}`));
  }
}, { timezone: 'America/Sao_Paulo' });

// ── Handlers globais de erros não capturados ──────────────────────────────────
// Evita que o processo scheduler morra silenciosamente por exceções imprevistas.
// Notifica o admin via Telegram e mantém o processo vivo.
async function _notifyAdminError(tipo, err) {
  const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  if (!adminId || !token) return;
  const msg = `🚨 <b>Scheduler — ${tipo}</b>\n\n<code>${String(err?.message || err).slice(0, 800)}</code>\n\n<i>${ts()}</i>`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminId, text: msg, parse_mode: 'HTML' }),
    });
  } catch { /* silent — não re-lançar dentro do handler */ }
}

process.on('uncaughtException', (err) => {
  console.error(chalk.bold.red(`[${ts()}] 💥 uncaughtException: ${err.message}`), err.stack);
  _notifyAdminError('uncaughtException', err).catch(() => {});
  // Não chama process.exit — mantém o scheduler vivo
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(chalk.bold.red(`[${ts()}] ⚠️  unhandledRejection: ${msg}`));
  _notifyAdminError('unhandledRejection', reason).catch(() => {});
});

// ── Keepalive ─────────────────────────────────────────────────────────────────
console.log(chalk.gray(`[${ts()}] 💓 Scheduler iniciado — aguardando horários agendados...`));
console.log(chalk.bold.green(`[${ts()}] 🛡️  Group Guardian ativo — polling a cada 10s`));
console.log(chalk.yellow(`[${ts()}] 🌅 Pré-operacional: 04:00/04:30/05:00/05:30/05:59`));
console.log(chalk.blue(`[${ts()}] 🔵 Varredura PRÉ-LIVE IA: 06-09h(30min) · 10-13h(20min) · 14-21h(15min) · 22h(30min) · 23:30`));
console.log(chalk.green(`[${ts()}] 🟢 SUPERODDS 2T ativo — Superbet verificado a cada 1h`));
