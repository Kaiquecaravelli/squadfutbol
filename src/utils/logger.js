/**
 * logger.js — Logger estruturado leve (ESM)
 *
 * Substituto de console.log em produção. Todos os outputs passam por
 * funções tipadas (info/warn/error/debug) com timestamp e nível.
 * Em produção: suprime debug. Em dev (NODE_ENV=development): mostra tudo.
 *
 * Uso:
 *   import logger from '../utils/logger.js';
 *   logger.info('mensagem');
 *   logger.warn('[GATE] reprovado por Under 80%');
 *   logger.error('[PIE] falha ao salvar lição', err);
 *   logger.debug('[IDLE] sistema ocioso — iniciando treino');
 */

const IS_DEV = process.env.NODE_ENV === 'development';

function _ts() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function _fmt(level, msg, extra) {
  const prefix = `[${_ts()}] [${level}]`;
  if (extra instanceof Error) {
    return `${prefix} ${msg} — ${extra.message}`;
  }
  if (extra !== undefined) {
    return `${prefix} ${msg} ${typeof extra === 'object' ? JSON.stringify(extra) : extra}`;
  }
  return `${prefix} ${msg}`;
}

const logger = {
  info(msg, extra)  { console.log(_fmt('INFO ', msg, extra)); },
  warn(msg, extra)  { console.warn(_fmt('WARN ', msg, extra)); },
  error(msg, extra) { console.error(_fmt('ERROR', msg, extra)); },
  debug(msg, extra) { if (IS_DEV) console.log(_fmt('DEBUG', msg, extra)); },
};

export default logger;
