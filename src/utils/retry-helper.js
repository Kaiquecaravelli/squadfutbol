/**
 * retry-helper.js — Wrapper de conveniência sobre withRetry()
 *
 * Expõe `comRetry(fn, opcoes)` como alias semântico em português
 * sobre o `withRetry()` existente em src/resilience/network-watchdog.js,
 * que já implementa exponential backoff, detecção de rede e jitter.
 *
 * Uso:
 *   import { comRetry } from '../utils/retry-helper.js';
 *   const data = await comRetry(() => fetch(url), { label: 'SofaScore odds' });
 *
 * Opções (repassadas diretamente ao withRetry):
 *   label        {string}  — nome da operação para logs (default: 'operação')
 *   maxAttempts  {number}  — tentativas máximas (default: 3)
 *   waitIfOffline {boolean} — aguarda reconexão antes de tentar (default: true)
 */

import { withRetry } from '../resilience/network-watchdog.js';

/**
 * Executa `fn` com retry automático e exponential backoff.
 * @param {Function} fn        — função async a executar
 * @param {Object}   [opcoes]  — label, maxAttempts, waitIfOffline
 * @returns {Promise<*>}
 */
export async function comRetry(fn, opcoes = {}) {
  return withRetry(fn, opcoes);
}

// Re-exporta withRetry diretamente para quem prefere o nome original
export { withRetry };
