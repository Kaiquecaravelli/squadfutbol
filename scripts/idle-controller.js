/**
 * idle-controller.js — Controlador Automático de Modo Economia
 *
 * Detecta inatividade do usuário (sem mouse/teclado por N minutos).
 * Quando inativo: ativa scripts\idle-mode.ps1
 * Quando o usuário volta: ativa scripts\idle-restore.ps1
 *
 * Gerenciado pelo PM2 como processo separado.
 * NÃO interfere nos processos Node.js do pipeline.
 */

import { execSync, exec } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── Configuração ───────────────────────────────────────────────────────────────
const IDLE_THRESHOLD_MS  = 15 * 60_000;   // 15 minutos sem atividade → ativa modo economia
const CHECK_INTERVAL_MS  =  1 * 60_000;   // verifica a cada 1 minuto
const ACTIVE_THRESHOLD_MS =      30_000;  // 30s de atividade contínua → restaura

// -WindowStyle Hidden + windowsHide:true → janela PowerShell nunca aparece na tela
const PS_OPTS = '-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden';
const PS_IDLE    = `powershell ${PS_OPTS} -File "${join(ROOT, 'scripts', 'idle-mode.ps1')}" -Silent`;
const PS_RESTORE = `powershell ${PS_OPTS} -File "${join(ROOT, 'scripts', 'idle-restore.ps1')}" -Silent`;

// ── Detectar última atividade do usuário via Windows API ───────────────────────
// Chama scripts\get-idle-time.ps1 que usa GetLastInputInfo
const PS_GET_IDLE = `powershell ${PS_OPTS} -File "${join(ROOT, 'scripts', 'get-idle-time.ps1')}"`;

function getIdleTimeMs() {
  try {
    const out = execSync(PS_GET_IDLE, {
      encoding:    'utf8',
      timeout:     6000,
      windowsHide: true,   // impede abertura de janela visível
    }).trim();
    const ms = parseInt(out);
    return isNaN(ms) ? 0 : ms;
  } catch {
    return 0;
  }
}

// ── Estado ─────────────────────────────────────────────────────────────────────
let idleMode    = false;
let activeStart = null; // quando detectamos atividade após modo idle

function ts() { return new Date().toLocaleString('pt-BR'); }
function log(icon, msg, color = 'white') {
  console.log(chalk[color]?.(`[${ts()}] ${icon}  ${msg}`) ?? `[${ts()}] ${icon}  ${msg}`);
}

function runScript(cmd, label) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30_000, windowsHide: true }, (err) => {
      if (err) log('⚠️', `${label} retornou erro (não crítico): ${err.message}`, 'yellow');
      else     log('✅', `${label} executado`, 'green');
      resolve();
    });
  });
}

// ── Loop de verificação ────────────────────────────────────────────────────────
async function tick() {
  const idleMs = getIdleTimeMs();
  const idleMin = Math.round(idleMs / 60_000);

  if (!idleMode && idleMs >= IDLE_THRESHOLD_MS) {
    // Usuário ficou inativo → ativar modo economia
    idleMode    = true;
    activeStart = null;
    log('💤', `Usuário inativo há ${idleMin}min — ativando modo economia...`, 'cyan');
    await runScript(PS_IDLE, 'idle-mode.ps1');
    log('🔋', `Modo economia ATIVO — PM2/Node continua rodando`, 'cyan');
    return;
  }

  if (idleMode && idleMs < ACTIVE_THRESHOLD_MS) {
    // Detectou atividade enquanto estava em modo idle
    if (!activeStart) {
      activeStart = Date.now();
      log('👋', 'Atividade detectada — aguardando confirmação...', 'yellow');
      return;
    }

    // Atividade confirmada por > ACTIVE_THRESHOLD_MS
    if (Date.now() - activeStart >= ACTIVE_THRESHOLD_MS) {
      idleMode    = false;
      activeStart = null;
      log('🖥️', 'Usuário voltou — restaurando configurações normais...', 'green');
      await runScript(PS_RESTORE, 'idle-restore.ps1');
      log('✅', 'Sistema restaurado ao normal', 'green');
    }
    return;
  }

  // Estado estável — apenas log periódico a cada 30min
  if (!idleMode) {
    const minuteMark = new Date().getMinutes();
    if (minuteMark % 30 === 0) {
      log('⚡', `Ativo — inatividade atual: ${idleMin}min (limite: 15min)`, 'gray');
    }
  }
}

// ── Inicialização ──────────────────────────────────────────────────────────────
log('🔋', `Idle Controller iniciado`, 'green');
log('⚙️',  `Threshold: ${IDLE_THRESHOLD_MS / 60_000}min de inatividade → modo economia`, 'gray');
log('⚙️',  `Verificação: a cada ${CHECK_INTERVAL_MS / 60_000}min`, 'gray');

// Verifica imediatamente
await tick();

// Inicia loop
setInterval(tick, CHECK_INTERVAL_MS);
