/**
 * health-monitor.js — Vigilante de Saúde do Sistema
 *
 * Processo separado gerenciado pelo PM2.
 * Verifica a cada 2 minutos:
 *  1. Se o processo 'squadfutbol' (scheduler) está rodando
 *  2. Se o arquivo de estado do pipeline foi atualizado recentemente
 *  3. Se a internet está disponível
 *  4. Se o disco tem espaço suficiente
 *
 * Em caso de anomalia: envia alerta ao Telegram e tenta recuperação automática.
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const CHECK_INTERVAL_MS     = 2 * 60_000;   // a cada 2 minutos
const MAX_STATE_SILENCE_MS  = 30 * 60_000;  // alarma se estado não atualizar em 30min (fora do horário de pipeline)
const MIN_DISK_FREE_GB      = 5;            // mínimo de 5GB livres
const ALERT_COOLDOWN_MS     = 10 * 60_000;  // não repete o mesmo alerta por 10min

const STATE_PATH = join(ROOT, 'data/pipeline-state.json');

let lastAlerts = {};

function ts() { return new Date().toLocaleString('pt-BR'); }
function log(icon, msg, color = 'white') {
  console.log(chalk[color]?.(`[${ts()}] ${icon}  ${msg}`) ?? `[${ts()}] ${icon}  ${msg}`);
}

// ── Telegram alerta — envia APENAS para o admin no privado, nunca no grupo ────
async function sendAlert(msg) {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  // Prioridade: admin configurado → fallback para CHAT_ID (DM do dono)
  const adminId = process.env.TELEGRAM_ADMIN_USER_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !adminId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id:    adminId,   // ← DM do admin, nunca o grupo
      text:       msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch { /* silencioso */ }
}

async function alertOnce(key, msg) {
  const now   = Date.now();
  const last  = lastAlerts[key] || 0;
  if (now - last < ALERT_COOLDOWN_MS) return;
  lastAlerts[key] = now;
  log('🚨', msg, 'red');
  await sendAlert(`🚨 <b>SQUADFUTBOL — ALERTA</b>\n\n${msg}\n\n<i>${ts()}</i>`);
}

async function infoOnce(key, msg) {
  const now  = Date.now();
  const last = lastAlerts[key] || 0;
  if (now - last < ALERT_COOLDOWN_MS) return;
  lastAlerts[key] = now;
  log('ℹ️', msg, 'cyan');
  await sendAlert(`ℹ️ <b>SQUADFUTBOL — INFO</b>\n\n${msg}\n\n<i>${ts()}</i>`);
}

// ── Verificações ───────────────────────────────────────────────────────────────
function checkSchedulerProcess() {
  try {
    const out  = execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const list = JSON.parse(out);
    const proc = list.find(p => p.name === 'squadfutbol');
    if (!proc) return { ok: false, reason: 'Processo "squadfutbol" não encontrado no PM2' };
    if (proc.pm2_env?.status !== 'online') {
      return { ok: false, reason: `Processo em estado "${proc.pm2_env?.status}" (esperado: online)` };
    }
    return { ok: true, restarts: proc.pm2_env?.restart_time || 0 };
  } catch (err) {
    return { ok: false, reason: `Falha ao consultar PM2: ${err.message}` };
  }
}

async function checkInternet() {
  for (const url of ['https://1.1.1.1', 'https://8.8.8.8']) {
    try {
      await axios.get(url, { timeout: 5000, validateStatus: () => true });
      return true;
    } catch { /* tenta próximo */ }
  }
  return false;
}

function checkDiskSpace() {
  try {
    // Windows: usa wmic
    const out  = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /value', { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const match = out.match(/FreeSpace=(\d+)/);
    if (match) {
      const freeGB = parseInt(match[1]) / (1024 ** 3);
      return { ok: freeGB >= MIN_DISK_FREE_GB, freeGB: freeGB.toFixed(1) };
    }
  } catch { /* silencioso */ }
  return { ok: true, freeGB: '?' };
}

function checkStateFile() {
  if (!existsSync(STATE_PATH)) return { ok: true, note: 'sem estado salvo (normal)' };
  try {
    const stat  = statSync(STATE_PATH);
    const age   = Date.now() - stat.mtimeMs;
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));

    // Se está em execução ativa e não atualizou em >30min → pode estar travado
    if (state.interrupted && state.stage !== 'done' && age > MAX_STATE_SILENCE_MS) {
      return { ok: false, reason: `Pipeline pode estar travado na etapa "${state.stage}" (último save: ${Math.round(age / 60_000)}min atrás)` };
    }
    return { ok: true, stage: state.stage, ageMin: Math.round(age / 60_000) };
  } catch {
    return { ok: true, note: 'erro ao ler estado' };
  }
}

// ── Loop principal ─────────────────────────────────────────────────────────────
async function checkAll() {
  // 1. Processo scheduler
  const proc = checkSchedulerProcess();
  if (!proc.ok) {
    await alertOnce('proc_down', `Scheduler parado: ${proc.reason}`);
    // Tenta reiniciar automaticamente
    try {
      execSync('pm2 restart squadfutbol', { timeout: 10000, windowsHide: true });
      await infoOnce('proc_restart', 'Scheduler reiniciado automaticamente pelo health monitor');
    } catch {}
  // Alerta de múltiplos restarts desativado — gerava ruído durante deploys/atualizações
  }

  // 2. Internet
  const online = await checkInternet();
  if (!online) {
    await alertOnce('no_internet', 'Sem conexão com a internet — análises em pausa até reconexão');
  } else if (lastAlerts['no_internet']) {
    await infoOnce('internet_back', 'Conexão restaurada — pipeline retomará na próxima execução agendada');
    delete lastAlerts['no_internet'];
  }

  // 3. Disco
  const disk = checkDiskSpace();
  if (!disk.ok) {
    await alertOnce('disk_low', `Espaço em disco baixo: apenas ${disk.freeGB}GB livres em C:\\ — necessário limpar arquivos`);
  }

  // 4. Estado do pipeline
  const stateCheck = checkStateFile();
  if (!stateCheck.ok) {
    await alertOnce('state_stale', stateCheck.reason);
  }

  log('💓', `Saúde OK — proc:${proc.ok ? '✅' : '❌'}  net:${online ? '✅' : '❌'}  disco:${disk.freeGB}GB  estado:${stateCheck.stage || 'N/A'}`, 'gray');
}

// ── Inicialização ──────────────────────────────────────────────────────────────
log('🏥', 'Health Monitor iniciado', 'green');
// Notificação de startup é apenas interna (log local) — sem mensagem ao Telegram

await checkAll(); // verificação imediata
setInterval(checkAll, CHECK_INTERVAL_MS);
