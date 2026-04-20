/**
 * autonomous-runner.js — Runner Autônomo do Squadfutbol
 *
 * Roda continuamente enquanto o usuário está ausente.
 * Distribui tarefas de acordo com a grade de jogos:
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │  Período          │ Ação                                            │
 *  ├─────────────────────────────────────────────────────────────────────┤
 *  │  A cada 10 min    │ Scan AO VIVO — 2° Tempo                        │
 *  │  A cada 30 min    │ Result-Checker — GREEN/RED + PIE                │
 *  │  08:00 e 13:00    │ Pipeline Diário — PRÉ-LIVE + SUPER ODDS         │
 *  │  Sem jogos        │ Treinamento — backfill histórico + calibração   │
 *  │  Todo dia 02:00   │ Expansão histórica — +7 dias de dados reais     │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 * Uso:
 *   node scripts/autonomous-runner.js
 *   npm run auto-runner
 */
import 'dotenv/config';
import cron                    from 'node-cron';
import chalk                   from 'chalk';
import axios                   from 'axios';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname }       from 'path';
import { fileURLToPath }       from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, '..');
const LOG_DIR = join(ROOT, 'logs');
const LOG_PATH = join(LOG_DIR, 'autonomous.log');

mkdirSync(LOG_DIR, { recursive: true });

// ── Logger ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function log(level, msg) {
  const line = `[${ts()}] [${level}] ${msg}`;
  console.log(
    level === 'OK'    ? chalk.green(line)  :
    level === 'WARN'  ? chalk.yellow(line) :
    level === 'ERR'   ? chalk.red(line)    :
    level === 'TRAIN' ? chalk.cyan(line)   :
    level === 'LIVE'  ? chalk.magenta(line):
    chalk.white(line)
  );
  try {
    writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
  } catch {}
}

// ── Estado global (anti-overlap) ──────────────────────────────────────────────
const state = {
  liveRunning:     false,
  resultRunning:   false,
  pipelineRunning: false,
  trainRunning:    false,
  lastTrainDate:   null,
  lastLiveScan:    null,
  liveOppsFound:   0,
  totalGreens:     0,
  totalReds:       0,
  startedAt:       new Date().toISOString(),
};

// ── Helpers de janela de tempo ────────────────────────────────────────────────
function hourBRT() {
  return parseInt(new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit', timeZone: 'America/Sao_Paulo'
  }));
}

/** Retorna true se estamos em horário de jogos (13h–23h BRT) */
function isGameHours() {
  const h = hourBRT();
  return h >= 13 && h <= 23;
}

/** Retorna true se estamos em janela de treinamento (00h–07h BRT) */
function isTrainingWindow() {
  const h = hourBRT();
  return h >= 0 && h < 7;
}

// ── Importações dinâmicas (lazy — evita falhas de boot) ───────────────────────
async function importModule(path) {
  try { return await import(path); }
  catch (e) { log('ERR', `Falha ao importar ${path}: ${e.message}`); return null; }
}

// ── TAREFA 1: Scan AO VIVO ────────────────────────────────────────────────────
async function runLiveScan() {
  if (state.liveRunning) return;
  state.liveRunning = true;
  try {
    const mod = await importModule('../src/workflows/live-2nd-half.js');
    if (!mod) return;

    log('LIVE', 'Iniciando scan AO VIVO 2° Tempo...');
    await mod.runLive2ndHalfAnalysis({ bankroll: 1000, loop: false });
    state.lastLiveScan = new Date().toISOString();
    log('OK', 'Scan AO VIVO concluído');
  } catch (e) {
    log('ERR', `Live scan falhou: ${e.message}`);
  } finally {
    state.liveRunning = false;
  }
}

// ── TAREFA 2: Result Checker (GREEN/RED + PIE) ────────────────────────────────
async function runResultCheck() {
  if (state.resultRunning) return;
  state.resultRunning = true;
  try {
    const mod = await importModule('./result-checker.js');
    if (!mod) return;

    log('INFO', 'Verificando resultados pendentes...');
    await mod.runResultChecker();
    log('OK', 'Result checker concluído');
  } catch (e) {
    log('ERR', `Result checker falhou: ${e.message}`);
  } finally {
    state.resultRunning = false;
  }
}

// ── TAREFA 2b: Game Watcher — dispara result-checker imediatamente quando jogo encerra ──
const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
  'Referer': 'https://www.sofascore.com/',
};

async function runGameWatcher() {
  if (state.resultRunning) return;

  // Lê pendentes diretamente (sem importação pesada)
  let pending = [];
  try {
    const dbPath = join(ROOT, 'data/pending-analyses.json');
    const all = JSON.parse(readFileSync(dbPath, 'utf8'));
    pending = all.filter(e => e.status === 'pending' && e.sofascoreId);
  } catch { return; }

  if (!pending.length) return;

  // Verifica silenciosamente cada jogo pendente no SofaScore
  let foundFinished = false;
  for (const entry of pending) {
    try {
      const { data } = await axios.get(
        `https://api.sofascore.com/api/v1/event/${entry.sofascoreId}`,
        { headers: SOFA_HEADERS, timeout: 6000 }
      );
      const status = data?.event?.status?.type;
      if (status === 'finished') {
        log('INFO', `🏁 Jogo encerrado detectado: ${entry.match} — acionando result-checker`);
        foundFinished = true;
        break;
      }
    } catch { /* ignora erros de rede */ }
    await new Promise(r => setTimeout(r, 800));
  }

  if (foundFinished) await runResultCheck();
}

// ── TAREFA 3: Pipeline Diário (PRÉ-LIVE + SUPER ODDS) ────────────────────────
async function runDailyPipeline(opts = {}) {
  if (state.pipelineRunning) return;
  state.pipelineRunning = true;
  try {
    const mod = await importModule('./daily-pipeline.js');
    if (!mod) return;

    log('INFO', `Iniciando pipeline diário${opts.label ? ' (' + opts.label + ')' : ''}...`);
    await mod.runDailyPipeline({ datesBack: opts.datesBack || 1, ...opts });
    log('OK', 'Pipeline diário concluído');
  } catch (e) {
    log('ERR', `Pipeline falhou: ${e.message}`);
  } finally {
    state.pipelineRunning = false;
  }
}

// ── TAREFA 4: Treinamento Autônomo ────────────────────────────────────────────
async function runTraining() {
  if (state.trainRunning || state.pipelineRunning) return;
  state.trainRunning = true;

  try {
    log('TRAIN', '═══ Iniciando ciclo de treinamento autônomo ═══');

    // 4a. Coleta partidas de ontem (SofaScore) se ainda não coletadas
    log('TRAIN', 'Coletando partidas de ontem...');
    const { default: collectDate } = await import('./sofascore-collector.js').catch(() => ({}));
    if (collectDate) {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
      await collectDate(yesterday).catch(e => log('WARN', `Coleta: ${e.message}`));
    }

    // 4b. Backfill de resultados — fecha o loop de predições pendentes
    log('TRAIN', 'Rodando result-backfill (PIE predictions)...');
    const { runBackfill } = await import('./result-backfill.js').catch(() => ({}));
    if (runBackfill) await runBackfill({ daysBack: 7, limit: 50 }).catch(e => log('WARN', `Backfill: ${e.message}`));

    // 4c. Treina com os dados do dia anterior
    log('TRAIN', 'Rodando training-cycle (ontem)...');
    const { trainDate } = await import('./training-cycle.js').catch(() => ({}));
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
    if (trainDate) await trainDate(yesterday).catch(e => log('WARN', `Training: ${e.message}`));

    // 4c-bis. Deep Training: re-minera padrões com todos os dados acumulados
    // Executa 1x por semana (domingo ou quando tem >20 novos jogos)
    const lastDeepTrain = state.lastDeepTrainDate
      ? (Date.now() - new Date(state.lastDeepTrainDate).getTime()) / 86_400_000
      : 999;
    if (lastDeepTrain >= 7) {
      log('TRAIN', 'Executando Deep Training (mineração de padrões semanal)...');
      try {
        const { execSync } = await import('child_process');
        execSync('node scripts/deep-training.js', { cwd: process.cwd(), stdio: 'pipe', timeout: 120_000 });
        state.lastDeepTrainDate = new Date().toISOString();
        log('TRAIN', '✅ Deep Training concluído — regras PIE atualizadas');
      } catch (e) {
        log('WARN', `Deep Training falhou: ${e.message?.slice(0, 100)}`);
      }
    }

    // 4d. Verifica calibração — reporta mercados próximos ao gate
    log('TRAIN', 'Verificando calibração pós-treino...');
    await checkCalibrationProgress();

    state.lastTrainDate = new Date().toISOString();
    log('TRAIN', '═══ Ciclo de treinamento concluído ═══');
  } catch (e) {
    log('ERR', `Training falhou: ${e.message}`);
  } finally {
    state.trainRunning = false;
  }
}

// ── TAREFA 5: Expansão histórica (backup de dados) ────────────────────────────
async function runHistoricalExpansion() {
  if (state.trainRunning) return;
  state.trainRunning = true;
  try {
    log('TRAIN', 'Expandindo calibração histórica (+7 dias)...');
    const { readFileSync } = await import('fs');
    const progressPath = join(ROOT, 'data/historical-progress.json');

    let progress = {};
    try { progress = JSON.parse(readFileSync(progressPath, 'utf8')); } catch {}

    const processed = progress.processedDates?.length || 0;
    log('TRAIN', `Histórico atual: ${processed} dias processados`);

    // Se temos menos de 90 dias, expande
    if (processed < 90) {
      const { spawnSync } = await import('child_process');
      const result = spawnSync('node', [
        join(__dir, 'historical-backfill.js'),
        '--days=90',
      ], { cwd: ROOT, timeout: 300_000, stdio: 'inherit' });

      if (result.status === 0) {
        log('OK', 'Expansão histórica concluída com sucesso');
      } else {
        log('WARN', 'Expansão histórica retornou código ' + result.status);
      }
    } else {
      log('TRAIN', 'Histórico já completo (90+ dias) — pulando expansão');
    }
  } catch (e) {
    log('ERR', `Expansão histórica falhou: ${e.message}`);
  } finally {
    state.trainRunning = false;
  }
}

// ── TAREFA 6: Auditoria Telegram — verifica cobertura de resultados e alimenta PIE ──
/**
 * Audita periodicamente o pending-analyses.json e garante:
 *  1. Toda entrada resolvida teve seu resultado enviado ao Telegram
 *  2. Todo resultado foi gravado no PIE (pieSaved === true)
 *  3. Entradas pendentes com jogo encerrado há >3h recebem nova tentativa
 *
 * Agenda: a cada 15 min (cron "* /15 * * * *")
 */
async function runTelegramAudit() {
  if (state.resultRunning) return;
  try {
    const dbPath = join(ROOT, 'data/pending-analyses.json');
    let all;
    try { all = JSON.parse(readFileSync(dbPath, 'utf8')); }
    catch { return; }

    const now      = Date.now();
    const resolved = all.filter(e => e.status === 'resolved');
    const pending  = all.filter(e => e.status === 'pending');

    // 1. Resolvidos sem pieSaved → dados não chegaram ao PIE
    const missingPie = resolved.filter(e =>
      e.pieSaved !== true &&
      e.acertou  !== null && e.acertou !== undefined &&
      e.placarReal
    );

    // 2. Resolvidos sem resultMsgId → resultado não foi ao Telegram
    const missingMsg = resolved.filter(e => !e.resultMsgId);

    // 3. Pendentes com jogo vencido há >3h (possível falha no game-watcher)
    const staleHours = 3;
    const stale = pending.filter(e => {
      const ref = e.gameTime || e.sentAt;
      if (!ref) return false;
      return (now - new Date(ref).getTime()) > staleHours * 3_600_000;
    });

    const needsAction = missingPie.length > 0 || stale.length > 0;

    if (missingPie.length > 0) {
      log('WARN', `📊 Auditoria PIE: ${missingPie.length} resultado(s) sem gravação → executando recuperação...`);
    }
    if (missingMsg.length > 0) {
      log('WARN', `📨 Auditoria Telegram: ${missingMsg.length} resultado(s) sem mensagem enviada`);
    }
    if (stale.length > 0) {
      const names = stale.map(e => e.match.split(' vs ')[0]).join(', ');
      log('WARN', `⏰ Auditoria: ${stale.length} análise(s) pendente(s) há >${staleHours}h → reverificando (${names})`);
    }

    if (needsAction) {
      await runResultCheck();
    } else {
      // Log resumido apenas quando há entradas (evita spam no log)
      const total = resolved.length + pending.length;
      if (total > 0) {
        const pieCoverage = resolved.length > 0
          ? Math.round(resolved.filter(e => e.pieSaved === true).length / resolved.length * 100)
          : 100;
        log('OK', `✅ Auditoria OK — ${pending.length} pendentes | ${resolved.length} resolvidos | PIE: ${pieCoverage}% cobertos`);
      }
    }
  } catch (e) {
    log('ERR', `Auditoria Telegram falhou: ${e.message}`);
  }
}

// ── Verifica calibração e loga mercados próximos do gate ─────────────────────
async function checkCalibrationProgress() {
  try {
    const db = JSON.parse(readFileSync(join(ROOT, 'data/pie.json'), 'utf8'));
    const calib = db.calibration || {};
    const GATE  = { MIN_SAMPLES: 30, MIN_ACC: 70 };

    const passing  = [];
    const almostOk = [];

    for (const [mkt, c] of Object.entries(calib)) {
      if (c.total < GATE.MIN_SAMPLES) continue;
      const acc = (c.hits / c.total * 100);
      if (acc >= GATE.MIN_ACC)       passing.push(`${mkt}: ${acc.toFixed(1)}%`);
      else if (acc >= GATE.MIN_ACC - 5) almostOk.push(`${mkt}: ${acc.toFixed(1)}% (faltam ${(GATE.MIN_ACC - acc).toFixed(1)}pp)`);
    }

    log('TRAIN', `Gate ✅ (${passing.length}): ${passing.join(' | ') || 'nenhum'}`);
    if (almostOk.length) log('TRAIN', `Quase lá ⚠️ (${almostOk.length}): ${almostOk.join(' | ')}`);
  } catch {}
}

// ── Heartbeat — status a cada hora ───────────────────────────────────────────
function printHeartbeat() {
  const uptime = Math.round((Date.now() - new Date(state.startedAt)) / 3_600_000);
  log('INFO', `💓 Runner ativo | uptime: ${uptime}h | live scan: ${state.lastLiveScan ? ts() : 'nunca'} | treino: ${state.lastTrainDate ? 'sim' : 'não'}`);
}

// ── Agendamento ───────────────────────────────────────────────────────────────
const TZ = { timezone: 'America/Sao_Paulo' };

// A cada 10 minutos — Scan AO VIVO (só em horário de jogos)
cron.schedule('*/10 * * * *', async () => {
  if (isGameHours()) await runLiveScan();
}, TZ);

// Game Watcher contínuo — polling a cada 60s (independente do cron)
// Detecta fim de jogo dentro de 1 min e dispara result-checker imediatamente
setInterval(async () => {
  await runGameWatcher().catch(() => {});
}, 60_000);

// A cada 15 minutos — Auditoria Telegram (verifica cobertura de resultados + PIE)
cron.schedule('*/15 * * * *', async () => {
  await runTelegramAudit();
}, TZ);

// A cada 30 minutos — Result Checker completo (cron de segurança)
cron.schedule('*/30 * * * *', async () => {
  await runResultCheck();
}, TZ);

// 08:00 — Pipeline principal
cron.schedule('0 8 * * *', async () => {
  await runDailyPipeline({ label: '08h', datesBack: 2 });
}, TZ);

// 13:00 — Pipeline extra
cron.schedule('0 13 * * *', async () => {
  await runDailyPipeline({ label: '13h', datesBack: 1 });
}, TZ);

// 21:00 domingo — Relatório semanal PIE
cron.schedule('0 21 * * 0', async () => {
  log('INFO', 'Enviando relatório semanal PIE...');
  try {
    const { getStats }       = await import('../src/pie/pie-storage.js');
    const { notifyPIEStats } = await import('../src/utils/telegram.js');
    await notifyPIEStats(getStats());
    log('OK', 'Relatório semanal enviado');
  } catch (e) {
    log('ERR', `Relatório semanal falhou: ${e.message}`);
  }
}, TZ);

// 02:00 — Expansão histórica (quando não há jogos)
cron.schedule('0 2 * * *', async () => {
  log('TRAIN', 'Janela noturna — expandindo histórico...');
  await runHistoricalExpansion();
}, TZ);

// Janela de treinamento — 01h, 03h, 05h (madrugada, sem jogos)
for (const hour of [1, 3, 5]) {
  cron.schedule(`0 ${hour} * * *`, async () => {
    if (!state.liveRunning && !state.pipelineRunning) {
      await runTraining();
    }
  }, TZ);
}

// Heartbeat a cada hora
cron.schedule('0 * * * *', printHeartbeat, TZ);

// ── Inicialização ─────────────────────────────────────────────────────────────
console.log('\n' + chalk.bold.cyan('═'.repeat(64)));
console.log(chalk.bold.cyan('  🤖 Squadfutbol — Runner Autônomo'));
console.log(chalk.bold.cyan('═'.repeat(64)));
console.log(chalk.white('  Rotinas ativas:'));
console.log(chalk.green('  ⚽  A cada 10 min  → Scan AO VIVO (13h–23h BRT)'));
console.log(chalk.green('  🏁  A cada 60s     → Game Watcher (GREEN/RED em ≤1 min)'));
console.log(chalk.green('  🔎  A cada 15 min  → Auditoria Telegram + PIE (cobertura 100%)'));
console.log(chalk.green('  🔍  A cada 30 min  → Result Checker completo (segurança)'));
console.log(chalk.green('  📡  08h00 diário   → Pipeline PRÉ-LIVE + SUPER ODDS'));
console.log(chalk.green('  📡  13h00 diário   → Pipeline extra'));
console.log(chalk.cyan( '  🧠  01h/03h/05h    → Treinamento autônomo (sem jogos)'));
console.log(chalk.cyan( '  📚  02h00 diário   → Expansão histórica SofaScore'));
console.log(chalk.green('  📊  Dom 21h00      → Relatório semanal PIE'));
console.log(chalk.gray( '  💡  Ctrl+C para parar\n'));
console.log(chalk.gray(`  Iniciado em: ${ts()}\n`));

// Verificação inicial completa ao iniciar
log('INFO', 'Verificação inicial de resultados pendentes...');
runResultCheck().catch(() => {});

// Auditoria imediata no startup para recuperar qualquer dado não gravado no PIE
setTimeout(() => runTelegramAudit().catch(() => {}), 8000);

// Se estiver em horário de jogos, roda live scan inicial
if (isGameHours()) {
  log('LIVE', 'Horário de jogos detectado — iniciando primeiro scan ao vivo...');
  setTimeout(() => runLiveScan().catch(() => {}), 5000);
}

// Mantém processo vivo
process.on('SIGINT',  () => { log('INFO', 'Runner encerrado pelo usuário.'); process.exit(0); });
process.on('SIGTERM', () => { log('INFO', 'Runner encerrado (SIGTERM).');    process.exit(0); });
process.on('uncaughtException', e => log('ERR', `Exceção não tratada: ${e.message}`));
await new Promise(() => {});
