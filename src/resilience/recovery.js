/**
 * recovery.js — Sistema de Recuperação Pós-Queda
 *
 * Ao iniciar o scheduler, verifica se existe uma execução interrompida
 * (queda de energia, crash, perda de internet prolongada).
 * Se sim, retoma o pipeline do ponto exato onde parou.
 *
 * Lógica de recuperação por etapa:
 *   etapa1 → reinicia a coleta (idempotente — pula arquivos já existentes)
 *   etapa2 → reinicia o backfill (idempotente — só fecha pendentes)
 *   etapa3 → reinicia injeção (idempotente — duplicatas são ignoradas)
 *   etapa4 → revalida (recalcula do zero — rápido)
 *   etapa4b → re-consulta cache Superbet (rápido)
 *   etapa5 → retoma Telegram: pula chaves já enviadas via notified-keys.json
 *   etapa6+ → reexecuta relatório
 */

import chalk from 'chalk';
import { readState, hasInterruptedRun } from './state-manager.js';

/**
 * Verifica e reporta o estado de recuperação ao iniciar.
 * @returns {{ shouldRecover: boolean, state: object|null, summary: string }}
 */
export function checkRecovery() {
  if (!hasInterruptedRun()) {
    return { shouldRecover: false, state: null, summary: 'Nenhuma execução interrompida.' };
  }

  const state   = readState();
  const savedAt = state?.savedAt ? new Date(state.savedAt) : null;
  const agoMs   = savedAt ? Date.now() - savedAt.getTime() : 0;
  const agoMin  = Math.round(agoMs / 60_000);

  const summary = [
    `⚡ Execução interrompida detectada!`,
    `   Etapa salva: ${state.stage}`,
    `   Salvo há: ${agoMin < 60 ? `${agoMin} min` : `${Math.round(agoMin / 60)}h`}`,
    `   Run ID: ${state.runId || 'N/A'}`,
    `   Datas: ${(state.data?.dates || []).join(', ')}`,
  ].join('\n');

  return { shouldRecover: true, state, summary };
}

/**
 * Decide se a execução interrompida ainda é relevante.
 * Descarta estados muito antigos (>6h) ou com datas completamente passadas.
 * @param {object} state
 * @returns {boolean}
 */
export function isRecoverable(state) {
  if (!state?.savedAt) return false;

  const age = Date.now() - new Date(state.savedAt).getTime();
  if (age > 6 * 3_600_000) {
    console.log(chalk.gray(`[Recovery] Estado muito antigo (${Math.round(age / 3_600_000)}h) — descartando`));
    return false;
  }

  // Se a etapa foi concluída ou é "start" (não chegou a processar nada útil)
  if (state.stage === 'done' || state.stage === 'start') return false;

  return true;
}

/**
 * Loga o resumo de recuperação de forma clara.
 */
export function logRecoveryStatus() {
  const { shouldRecover, state, summary } = checkRecovery();

  if (!shouldRecover) {
    console.log(chalk.green(`[Recovery] ✅ Sistema limpo — sem execução pendente`));
    return null;
  }

  if (!isRecoverable(state)) {
    console.log(chalk.gray(`[Recovery] Estado descartado — iniciando execução nova`));
    return null;
  }

  console.log(chalk.yellow(`\n[Recovery] ${summary}\n`));
  console.log(chalk.cyan(`[Recovery] Retomando pipeline do ponto de interrupção...`));
  return state;
}
