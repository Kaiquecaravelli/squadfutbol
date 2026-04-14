/**
 * network-watchdog.js — Monitor de Conectividade em Tempo Real
 *
 * Verifica a conexão a cada 15 segundos.
 * Quando a internet cai: pausa operações e enfileira para retry.
 * Quando volta: drena a fila na ordem de chegada.
 *
 * Uso:
 *   import { watchdog, withRetry, waitOnline } from './network-watchdog.js';
 *
 *   // Inicia monitoramento
 *   watchdog.start();
 *
 *   // Envolve qualquer operação de rede com retry automático
 *   const data = await withRetry(() => axios.get(url), { label: 'SofaScore' });
 *
 *   // Aguarda a internet antes de uma operação crítica
 *   await waitOnline();
 */

import axios from 'axios';
import { EventEmitter } from 'events';

// ── Configuração ───────────────────────────────────────────────────────────────
const CHECK_INTERVAL_MS  = 15_000;   // verifica a cada 15 segundos
const RECOVERY_DELAY_MS  =  5_000;   // aguarda 5s após reconexão antes de drenar fila
const MAX_RETRY_ATTEMPTS =     10;   // máximo de tentativas por operação
const RETRY_BASE_DELAY   =  2_000;   // delay base para backoff exponencial (ms)
const PING_URLS = [
  'https://1.1.1.1',              // Cloudflare DNS
  'https://8.8.8.8',              // Google DNS
  'https://api.sofascore.com',    // serviço principal do projeto
];

// ── Estado interno ─────────────────────────────────────────────────────────────
let _online        = true;
let _lastCheck     = 0;
let _checkTimer    = null;
let _offlineSince  = null;
let _totalDrops    = 0;
let _totalDowntime = 0; // ms acumulados offline

const _emitter = new EventEmitter();

// ── Verificação de conectividade ───────────────────────────────────────────────
async function _checkConnectivity() {
  for (const url of PING_URLS) {
    try {
      await axios.get(url, { timeout: 4_000, validateStatus: () => true });
      _lastCheck = Date.now();
      return true;
    } catch { /* tenta próximo */ }
  }
  return false;
}

// ── Watchdog principal ─────────────────────────────────────────────────────────
async function _tick() {
  const alive = await _checkConnectivity();

  if (!alive && _online) {
    // Acabou de cair
    _online       = false;
    _offlineSince = Date.now();
    _totalDrops++;
    console.warn(`[Watchdog] ⚠️  INTERNET CAIU (queda #${_totalDrops}) — operações em pausa`);
    _emitter.emit('offline');
  }

  if (alive && !_online) {
    // Voltou
    const downtime = Date.now() - (_offlineSince || Date.now());
    _totalDowntime += downtime;
    _online = true;
    console.log(`[Watchdog] ✅ INTERNET RESTAURADA — ficou offline por ${Math.round(downtime / 1000)}s`);
    console.log(`[Watchdog] 📊 Total: ${_totalDrops} quedas | ${Math.round(_totalDowntime / 1000)}s acumulados`);
    _offlineSince = null;
    _emitter.emit('online', { downtime });
  }
}

// ── API Pública ────────────────────────────────────────────────────────────────

export const watchdog = {
  /** Inicia o monitoramento periódico */
  start() {
    if (_checkTimer) return;
    console.log(`[Watchdog] 🟢 Monitor de rede ativo (check a cada ${CHECK_INTERVAL_MS / 1000}s)`);
    _checkTimer = setInterval(_tick, CHECK_INTERVAL_MS);
    // Não bloqueia o processo (unref)
    _checkTimer.unref();
    // Verificação imediata
    _tick();
  },

  /** Para o monitoramento */
  stop() {
    if (_checkTimer) {
      clearInterval(_checkTimer);
      _checkTimer = null;
    }
  },

  /** True se a última verificação indicou conexão ativa */
  get isOnline() { return _online; },

  /** Estatísticas de uptime */
  get stats() {
    return {
      online:         _online,
      totalDrops:     _totalDrops,
      totalDowntimeS: Math.round(_totalDowntime / 1000),
      offlineSince:   _offlineSince ? new Date(_offlineSince).toISOString() : null,
    };
  },

  on:  (event, fn) => _emitter.on(event, fn),
  off: (event, fn) => _emitter.off(event, fn),
};

/**
 * Aguarda a internet estar disponível.
 * Se já estiver online, resolve imediatamente.
 * @param {number} [timeoutMs=300_000]  — desiste após 5 minutos por padrão
 */
export function waitOnline(timeoutMs = 300_000) {
  if (_online) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _emitter.off('online', handler);
      reject(new Error(`[Watchdog] Timeout aguardando internet (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    function handler() {
      clearTimeout(timer);
      // Pequeno delay para estabilizar a conexão antes de retomar
      setTimeout(resolve, RECOVERY_DELAY_MS);
    }

    _emitter.once('online', handler);
  });
}

/**
 * Executa uma função com retry automático em caso de falha de rede.
 * Usa backoff exponencial com jitter.
 *
 * @param {() => Promise<any>} fn        — operação a executar
 * @param {object} opts
 * @param {string} [opts.label]          — nome da operação (para logs)
 * @param {number} [opts.maxAttempts]    — número máximo de tentativas
 * @param {boolean} [opts.waitIfOffline] — aguarda internet antes de tentar
 */
export async function withRetry(fn, opts = {}) {
  const {
    label        = 'operação',
    maxAttempts  = MAX_RETRY_ATTEMPTS,
    waitIfOffline = true,
  } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Se sabemos que estamos offline, espera antes de tentar
    if (waitIfOffline && !_online) {
      console.log(`[Watchdog] ⏸  ${label} — aguardando reconexão...`);
      await waitOnline();
    }

    try {
      return await fn();
    } catch (err) {
      const isNetworkError = (
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND'    ||
        err.code === 'ETIMEDOUT'    ||
        err.code === 'ECONNRESET'   ||
        err.code === 'EAI_AGAIN'    ||
        err?.response?.status >= 500 ||
        err.message?.toLowerCase().includes('network') ||
        err.message?.toLowerCase().includes('timeout') ||
        err.message?.toLowerCase().includes('socket')
      );

      if (!isNetworkError || attempt === maxAttempts) {
        throw err;
      }

      const delay = Math.min(
        RETRY_BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 1000,
        60_000  // cap de 60s
      );

      console.warn(`[Watchdog] ↩  ${label} falhou (tentativa ${attempt}/${maxAttempts}) — retry em ${Math.round(delay / 1000)}s`);
      console.warn(`[Watchdog]    Erro: ${err.code || err.message}`);

      await new Promise(r => setTimeout(r, delay));
    }
  }
}
