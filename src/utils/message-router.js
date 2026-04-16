/**
 * message-router.js — Roteador Central de Mensagens v1.0.0
 *
 * Toda comunicação do sistema passa por aqui.
 * Nenhuma mensagem de operação interna chega ao grupo público.
 *
 * CANAL ADMIN (privado):
 *   alertas WatchdogAgent · erros pipeline · sinais retidos · relatórios auditoria
 *   anomalias precisão · kill switch · fonte inacessível · sugestões melhoria
 *
 * CANAL GRUPO (público):
 *   sinais aprovados (BTTS · Goals · Corners) · resultados · SUPER ODDS
 *
 * Variáveis de ambiente:
 *   ADMIN_CHAT_ID  → ID do chat privado do administrador
 *   GRUPO_CHAT_ID  → ID do grupo público
 *   (fallbacks: TELEGRAM_ADMIN_USER_ID, TELEGRAM_GROUP_ID, TELEGRAM_CHAT_ID)
 */

import axios from 'axios';

const TG_BASE     = 'https://api.telegram.org';
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID    = process.env.ADMIN_CHAT_ID    || process.env.TELEGRAM_ADMIN_USER_ID || process.env.TELEGRAM_CHAT_ID;
const GRUPO_ID    = process.env.GRUPO_CHAT_ID    || process.env.TELEGRAM_GROUP_ID     || process.env.TELEGRAM_CHAT_ID;

// ── Tipos de destino ───────────────────────────────────────────────────────────
export const DEST = { ADMIN: 'ADMIN', GRUPO: 'GRUPO', AMBOS: 'AMBOS' };
export const PRIO = { CRITICA: 'CRÍTICA', ALTA: 'ALTA', NORMAL: 'NORMAL', LOG: 'LOG' };

// ── Construtor de mensagem tipada ──────────────────────────────────────────────
export function criarMensagem(conteudo, destino, prioridade = PRIO.NORMAL) {
  if (!Object.values(DEST).includes(destino)) {
    throw new Error(`[Router] Destino inválido: "${destino}". Use DEST.ADMIN | DEST.GRUPO | DEST.AMBOS`);
  }
  return {
    conteudo,
    destino,
    prioridade,
    timestamp: new Date().toISOString(),
  };
}

// ── Envio de baixo nível ───────────────────────────────────────────────────────
async function _enviarParaChatId(chatId, texto, opts = {}) {
  if (!TG_TOKEN || !chatId) return null;
  try {
    const res = await axios.post(
      `${TG_BASE}/bot${TG_TOKEN}/sendMessage`,
      {
        chat_id:    chatId,
        text:       texto,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...opts,
      },
      { timeout: 8_000 }
    );
    return res.data?.result?.message_id ?? null;
  } catch (err) {
    // Falha de envio é silenciosa — nunca deve quebrar o pipeline
    console.error(`[Router] Falha ao enviar para ${chatId}: ${err.message}`);
    return null;
  }
}

// ── Roteador principal ─────────────────────────────────────────────────────────
/**
 * Roteia uma mensagem para o destino correto.
 * NUNCA inverte o roteamento. Mensagem de erro no grupo = falha crítica.
 *
 * @param {object} mensagem — criada por criarMensagem()
 * @param {object} opts     — opções extras do Telegram (reply_to_message_id, etc.)
 * @returns {Promise<{admin?: number|null, grupo?: number|null}>}
 */
export async function rotear(mensagem, opts = {}) {
  const { conteudo, destino } = mensagem;
  const result = {};

  if (destino === DEST.ADMIN || destino === DEST.AMBOS) {
    result.admin = await _enviarParaChatId(ADMIN_ID, conteudo, opts);
  }

  if (destino === DEST.GRUPO || destino === DEST.AMBOS) {
    // Guardrail: mensagens de LOG e CRÍTICA nunca vão ao grupo
    if (mensagem.prioridade === PRIO.LOG || mensagem.prioridade === PRIO.CRITICA) {
      console.warn(`[Router] Mensagem ${mensagem.prioridade} bloqueada para o grupo (destino redirecionado para ADMIN)`);
      result.admin = await _enviarParaChatId(ADMIN_ID, conteudo, opts);
      result.grupo = null;
    } else {
      result.grupo = await _enviarParaChatId(GRUPO_ID, conteudo, opts);
    }
  }

  return result;
}

// ── Helpers de conveniência ────────────────────────────────────────────────────

/** Envia ao ADMIN sem limite ou restrição. */
export async function enviarAdmin(texto, prioridade = PRIO.NORMAL) {
  return rotear(criarMensagem(texto, DEST.ADMIN, prioridade));
}

/** Envia ao GRUPO — apenas sinais aprovados, resultados, SUPER ODDS. */
export async function enviarGrupo(texto, prioridade = PRIO.NORMAL) {
  return rotear(criarMensagem(texto, DEST.GRUPO, prioridade));
}

/** Envia para ambos — usado apenas em confirmações de deploy ou reinício. */
export async function enviarAmbos(texto, prioridade = PRIO.NORMAL) {
  return rotear(criarMensagem(texto, DEST.AMBOS, prioridade));
}

// ── Formatador de mensagem admin técnica ──────────────────────────────────────
/**
 * Formata mensagem técnica para o admin conforme padrão definido.
 *
 * @param {object} params
 * @param {string} params.componente — nome do componente (ex: 'WatchdogAgent')
 * @param {string} params.status     — ALERTA | ERRO | INFO | CRÍTICO
 * @param {string} params.detalhe    — descrição técnica completa
 * @param {string} [params.agente]   — nome do agente envolvido
 * @param {string} [params.dado]     — campo ou métrica afetada
 * @param {string} [params.acao]     — ação tomada (automática ou pendente)
 * @param {string} [params.proxCheck] — HH:MM do próximo check
 */
export function formatarMensagemAdmin({ componente, status, detalhe, agente, dado, acao, proxCheck }) {
  const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const linhas = [
    `🔧 <b>[SISTEMA] · ${componente} · ${hora}</b>`,
    `Status: <code>${status}</code>`,
    `————————————————————————————————————`,
    `Detalhe: ${detalhe}`,
  ];
  if (agente)    linhas.push(`Agente: <code>${agente}</code>`);
  if (dado)      linhas.push(`Dado afetado: <code>${dado}</code>`);
  if (acao)      linhas.push(`Ação tomada: ${acao}`);
  if (proxCheck) linhas.push(`Próximo check: <code>${proxCheck}</code>`);
  return linhas.join('\n');
}

export default { rotear, enviarAdmin, enviarGrupo, enviarAmbos, criarMensagem, DEST, PRIO };
