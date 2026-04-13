import axios from 'axios';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { trackSignalSent } from './engagement-tracker.js';
import { isObsidianConfigured, saveAnaliseNote } from './obsidian.js';

const BASE = 'https://api.telegram.org';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────
// CONSTANTES VISUAIS — padrão unificado para todas as mensagens
// ─────────────────────────────────────────────────────────────

const SEP_HEAVY = '<b>━━━━━━━━━━━━━━━━</b>';  // separador principal
const SEP_LIGHT = '<b>━━━━━━━━━━━━━━━━</b>';   // separador secundário
const BR        = '';                   // linha em branco

/** Links diretos por competição no Superbet (superbet.bet.br) */
const SUPERBET_COMPETITION_LINKS = {
  'brasileir':   'https://superbet.bet.br/apostas/futebol/brasil/brasileiro-serie-a/todos',
  'serie b':     'https://superbet.bet.br/apostas/futebol/brasil/brasileiro-serie-b/todos',
  'premier':     'https://superbet.bet.br/apostas/futebol/inglaterra/premier-league/todos',
  'serie a':     'https://superbet.bet.br/apostas/futebol/italia/serie-a/todos',
  'la liga':     'https://superbet.bet.br/apostas/futebol/espanha/la-liga/todos',
  'bundesliga':  'https://superbet.bet.br/apostas/futebol/alemanha/bundesliga/todos',
  'ligue 1':     'https://superbet.bet.br/apostas/futebol/franca/ligue-1/todos',
  'champions':   'https://superbet.bet.br/apostas/futebol/europa/champions-league/todos',
  'europa leag': 'https://superbet.bet.br/apostas/futebol/europa/europa-league/todos',
  'mls':         'https://superbet.bet.br/apostas/futebol/eua/mls/todos',
  'liga profesional': 'https://superbet.bet.br/apostas/futebol/argentina/liga-profesional/todos',
  'apertura':    'https://superbet.bet.br/apostas/futebol/argentina/liga-profesional/todos',
  'clausura':    'https://superbet.bet.br/apostas/futebol/argentina/liga-profesional/todos',
  'eredivisie':  'https://superbet.bet.br/apostas/futebol/holanda/eredivisie/todos',
  'süper lig':   'https://superbet.bet.br/apostas/futebol/turquia/super-lig/todos',
  'turkish':     'https://superbet.bet.br/apostas/futebol/turquia/super-lig/todos',
  'primeira liga': 'https://superbet.bet.br/apostas/futebol/portugal/primeira-liga/todos',
  'libertadores':'https://superbet.bet.br/apostas/futebol/america-do-sul/copa-libertadores/todos',
  'sudamericana': 'https://superbet.bet.br/apostas/futebol/america-do-sul/copa-sudamericana/todos',
};
const SUPERBET_FALLBACK = 'https://superbet.bet.br/apostas/futebol/hoje';

/**
 * Gera link para a casa de apostas.
 * @param {string} house      - Nome da casa (ex: 'Superbet')
 * @param {string} [comp]     - Competição (fallback por liga)
 * @param {string} [directUrl]- URL direta já resolvida via Playwright
 */
function _houseLink(house, comp = '', directUrl = null) {
  let url = directUrl;
  if (!url) {
    const key = (comp || '').toLowerCase();
    url = Object.entries(SUPERBET_COMPETITION_LINKS)
      .find(([k]) => key.includes(k))?.[1]
      ?? SUPERBET_FALLBACK;
  }
  return `<a href="${url}">🔗 Apostar agora → ${house}</a>`;
}

// Mapa de legendas por tipo de mercado
const LEGENDA_MAP = {
  BTTS:        `⚽  BTTS — Ambas marcam`,
  GOLS:        `🥅  Gols — Over / Under (X.5)`,
  ESCANTEIOS:  `⛳  Escanteios — Over / Under (X.5)`,
  CARTOES:     `🟨  Cartões — Amarelos Over / Under`,
  DUPLA:       `🔄  Dupla Chance — 1X · X2 · 12`,
  PLACAR:      `🎯  Placar Exato — Resultado final`,
  RESULTADO:   `🏆  Resultado Final — 1 · X · 2`,
  PROXIMO_GOL: `⚡  Próximo Gol — qual time marca`,
  GOL_ACRESCIMO: `⏱  Gol no Acréscimo`,
};

/** Gera legenda dinâmica com apenas os mercados presentes nos resultados */
function _buildLegenda(results) {
  const itens = new Set();
  for (const r of results) {
    const m = (r.mercado ?? r.market ?? '').toUpperCase();
    if (m.includes('BTTS') || m.includes('AMBAS'))                              itens.add('BTTS');
    if (m.includes('GOLS') || m.includes('TOTAL') || m.includes('OVER') || m.includes('UNDER')) itens.add('GOLS');
    if (m.includes('ESCANTEIO') || m.includes('CORNER'))                        itens.add('ESCANTEIOS');
    if (m.includes('CARTÃO') || m.includes('CARTAO') || m.includes('AMARELO')) itens.add('CARTOES');
    if (m.includes('DUPLA') || m.includes('CHANCE'))                            itens.add('DUPLA');
    if (m.includes('PLACAR') || m.includes('EXATO'))                            itens.add('PLACAR');
    if (m.includes('RESULTADO FINAL') || m.includes('RESULTADO MANTIDO'))       itens.add('RESULTADO');
    if (m.includes('PRÓXIMO GOL') || m.includes('PROXIMO GOL'))                 itens.add('PROXIMO_GOL');
    if (m.includes('ACRÉSCIMO') || m.includes('ACRESCIMO'))                     itens.add('GOL_ACRESCIMO');
  }
  return [
    SEP_LIGHT,
    `📖  <b>Legenda</b>`,
    ...[...itens].map((k) => LEGENDA_MAP[k]).filter(Boolean),
    BR,
    `📊  Probabilidade (%)   🔒  Confiança (%)`,
    `🟢  Baixo  ·  🟡  Médio  ·  🔴  Alto`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// HELPERS BASE
// ─────────────────────────────────────────────────────────────

function getChatId() {
  return process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;
}

function isConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && getChatId());
}

// ─────────────────────────────────────────────────────────────
// FILTRO DE DEDUPLICAÇÃO — evita duplicatas e apaga as antigas
// ─────────────────────────────────────────────────────────────

/** Janela de tempo em ms para considerar mensagem como duplicada (padrão: 10 min) */
const DEDUP_WINDOW_MS      = Number(process.env.TELEGRAM_DEDUP_WINDOW_MS) || 10 * 60 * 1000;
/** Janela de dedup estendida para mensagens live — evita reenvio entre ciclos de 10min */
const DEDUP_WINDOW_LIVE_MS = 25 * 60 * 1000; // 25 min (cobre 2 ciclos de scan + margem)

// ─────────────────────────────────────────────────────────────
// RASTREAMENTO DE ANÁLISES PENDENTES — para feedback GREEN/RED
// ─────────────────────────────────────────────────────────────

const PENDING_DB_PATH = join(__dirname, '../../data/pending-analyses.json');

function _loadPendingDb() {
  try { return JSON.parse(readFileSync(PENDING_DB_PATH, 'utf8')); }
  catch { return []; }
}

function _savePendingDb(entries) {
  try {
    mkdirSync(dirname(PENDING_DB_PATH), { recursive: true });
    writeFileSync(PENDING_DB_PATH, JSON.stringify(entries, null, 2), 'utf8');
  } catch {}
}

/**
 * Registra uma análise enviada para posterior verificação de resultado.
 * @param {object} meta
 * @param {number}   meta.msgId         — ID da mensagem no Telegram
 * @param {string}   meta.type          — 'prelive' | 'live'
 * @param {string}   meta.match         — "Home vs Away"
 * @param {string}   meta.competition   — nome da liga
 * @param {string}   [meta.sofascoreId] — ID do evento no SofaScore
 * @param {string}   meta.market        — ex: 'BTTS', 'Over 2.5'
 * @param {string}   meta.prediction    — ex: 'Sim', 'Over'
 * @param {number}   meta.probabilidade
 * @param {number}   meta.confianca
 * @param {number}   [meta.odds]
 * @param {string}   [meta.gameTime]    — ISO string do horário do jogo
 */
export function savePendingAnalysis(meta) {
  if (!meta?.msgId || !meta?.match) return;
  const entries = _loadPendingDb();

  // Deduplicação: se já existe entrada pending com mesmo sofascoreId + market,
  // ATUALIZA o msgId (caso a mensagem tenha sido substituída pelo dedup do Telegram)
  if (meta.sofascoreId && meta.market) {
    const existing = entries.find(e =>
      e.status === 'pending' &&
      e.sofascoreId === String(meta.sofascoreId) &&
      e.market === meta.market
    );
    if (existing) {
      if (existing.msgId !== meta.msgId) {
        existing.msgId   = meta.msgId;
        existing.sentAt  = new Date().toISOString();
        _savePendingDb(entries);
      }
      return;
    }
  }

  entries.push({
    id:           randomUUID(),
    status:       'pending',
    sentAt:       new Date().toISOString(),
    resolvedAt:   null,
    resultMsgId:  null,
    ...meta,
  });
  _savePendingDb(entries);
}

/** Marca análise como resolvida e registra o msgId da mensagem de resultado */
export function resolvePendingAnalysis(id, { acertou, placarReal, resultMsgId, pieSaved = false }) {
  const entries = _loadPendingDb();
  const entry   = entries.find(e => e.id === id);
  if (!entry) return;
  entry.status      = 'resolved';
  entry.resolvedAt  = new Date().toISOString();
  entry.acertou     = acertou;
  entry.placarReal  = placarReal;
  entry.resultMsgId = resultMsgId;
  entry.pieSaved    = pieSaved;   // rastreia se o dado foi gravado no PIE
  _savePendingDb(entries);
}

/** Retorna todas as análises com status 'pending' */
export function getPendingAnalyses() {
  return _loadPendingDb().filter(e => e.status === 'pending');
}

/** Retorna análises resolvidas que ainda não foram gravadas no PIE (para recuperação) */
export function getAllPendingAnalyses() {
  return _loadPendingDb();
}

// ─────────────────────────────────────────────────────────────
// REPLY E DELETE — para fechar o ciclo de feedback
// ─────────────────────────────────────────────────────────────

/**
 * Envia mensagem em reply a uma mensagem existente no grupo.
 * Retorna o msgId da mensagem de reply, ou null se falhar.
 */
export async function sendReply(replyToMsgId, text) {
  if (!isConfigured() || !replyToMsgId) return null;
  try {
    const res = await axios.post(`${BASE}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id:             getChatId(),
      text,
      parse_mode:          'HTML',
      disable_web_page_preview: true,
      reply_to_message_id: replyToMsgId,
    });
    return res.data?.result?.message_id ?? null;
  } catch (err) {
    console.warn(`[Telegram] Falha ao enviar reply: ${err.message}`);
    return null;
  }
}

/**
 * Deleta uma mensagem do grupo pelo ID.
 * Silencioso se a mensagem já foi apagada ou expirou (>48h).
 */
export async function deleteMessage(msgId) {
  if (!isConfigured() || !msgId) return;
  try {
    await axios.post(`${BASE}/bot${process.env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      chat_id:    getChatId(),
      message_id: msgId,
    });
  } catch { /* ignora — pode ter expirado */ }
}

/** Edita uma mensagem existente no grupo (mantém histórico visível) */
export async function editMessage(msgId, newText) {
  if (!isConfigured() || !msgId) return false;
  try {
    await axios.post(`${BASE}/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      chat_id:                  getChatId(),
      message_id:               msgId,
      text:                     newText,
      parse_mode:               'HTML',
      disable_web_page_preview: true,
    });
    return true;
  } catch { return false; }
}

/**
 * Envia o resultado GREEN/RED como reply à análise original e depois a apaga.
 * @param {object} opts
 * @param {number}  opts.msgId        — mensagem original a responder e apagar
 * @param {boolean} opts.acertou      — true = GREEN, false = RED
 * @param {string}  opts.match        — "Home vs Away"
 * @param {string}  opts.market       — mercado analisado
 * @param {string}  opts.prediction   — seleção feita
 * @param {string}  opts.placarReal   — "2-1"
 * @param {number}  opts.probabilidade
 * @param {string}  [opts.competition]
 */
// Frases motivacionais — sorteadas a cada resultado
const _FRASES_GREEN = [
  '🔥  Foco total. O modelo entregou.',
  '💡  Leitura certa. Processo validado.',
  '🎯  Análise precisa. Resultado confirmado.',
  '⚡  Padrão identificado, resultado colhido.',
  '🧠  Inteligência aplicada, lucro gerado.',
  '✨  Cada acerto alimenta o próximo.',
  '🚀  Modelo afiado. Seguimos em frente.',
  '💎  Consistência é o caminho.',
  '📐  Matemática aplicada com precisão.',
  '🌟  Mais um dado real para o PIE aprender.',
];
const _FRASES_RED = [
  '📖  Cada erro é uma lição que o modelo absorve.',
  '🔬  Resultado adverso registrado — PIE ajusta.',
  '⚙️  Calibração contínua. O modelo evolui.',
  '🧩  Variância existe. A borda permanece.',
  '📉  Um RED hoje, melhor filtro amanhã.',
  '🏗️  Construção sólida vem de aprender com o erro.',
  '🎲  Probabilidade não é certeza — é vantagem no longo prazo.',
  '🔄  Feedback registrado. Próxima análise mais calibrada.',
  '💪  Disciplina no processo, não no resultado.',
  '🌱  Cada dado negativo melhora o modelo.',
];

function _fraseMotiacional(acertou) {
  const pool = acertou ? _FRASES_GREEN : _FRASES_RED;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Adiciona uma reação emoji a uma mensagem do grupo.
 * GREEN → 🎯  |  RED → 📖
 * Silencioso se a API não suportar (grupos sem permissão de reação de bot).
 */
async function reactToMessage(msgId, emoji) {
  if (!isConfigured() || !msgId) return;
  try {
    await axios.post(`${BASE}/bot${process.env.TELEGRAM_BOT_TOKEN}/setMessageReaction`, {
      chat_id:   getChatId(),
      message_id: msgId,
      reaction:  [{ type: 'emoji', emoji }],
      is_big:    false,
    });
  } catch { /* silencioso — reação é opcional */ }
}

export async function notifyResultFeedback(opts) {
  if (!isConfigured()) return null;
  const { msgId, acertou, match, market, prediction, placarReal, probabilidade, competition, originalText } = opts;

  const icon  = acertou ? '✅' : '❌';
  const label = acertou ? 'GREEN' : 'RED';
  const comp  = competition ? `\n<b>🏆  ${competition.toUpperCase()}</b>` : '';

  const resultBlock = [
    ``,
    `<b>━━━━━━━━━━━━━━━━</b>`,
    `<b>${icon}  RESULTADO FINAL  —  ${label}</b>`,
    comp,
    `<b>📊  Placar:  ${placarReal}</b>`,
    `📈  Probabilidade prevista:  ${probabilidade}%`,
    `<i>${_fraseMotiacional(acertou)}</i>`,
  ].filter(l => l !== undefined).join('\n');

  // Tenta EDITAR a mensagem original (mantém histórico)
  let editOk = false;
  if (msgId && originalText) {
    const edited = `${originalText}\n${resultBlock}`;
    editOk = await editMessage(msgId, edited);
  }

  // Se edição falhou (mensagem muito antiga, apagada, etc.) — envia reply
  let resultMsgId = null;
  if (!editOk) {
    const fallbackLines = [
      `<b>${icon}  ${label}  —  ${market}  →  ${prediction}</b>`,
      comp,
      `<b>⚽️  ${match}</b>`,
      `<b>📊  Placar final:  ${placarReal}</b>`,
      ``,
      `📈  Probabilidade prevista:  ${probabilidade}%`,
      `<i>${_fraseMotiacional(acertou)}</i>`,
      ``,
      `🤖  <i>Betting Analysis Squad</i>`,
    ].filter(l => l !== undefined);
    resultMsgId = await sendReply(msgId, fallbackLines.join('\n'));
    if (resultMsgId) _trackResultMessage(resultMsgId);
  } else {
    // Edição OK — rastreia msgId original como resultado (não apaga mais)
    resultMsgId = msgId;
    _trackResultMessage(msgId);
  }

  // Reação automática do bot: 🎯 = GREEN, 📖 = RED
  // Chama de forma assíncrona sem bloquear o retorno
  const targetId = resultMsgId || msgId;
  if (targetId) reactToMessage(targetId, acertou ? '🎯' : '📖').catch(() => {});

  return resultMsgId;
}

// ─────────────────────────────────────────────────────────────
// PROTEÇÃO DE MENSAGENS DE RESULTADO — 24h
// ─────────────────────────────────────────────────────────────

const RESULT_MSG_DB_PATH = join(__dirname, '../../data/result-messages.json');
const RESULT_PROTECT_MS  = 24 * 3_600_000; // 24 horas

function _loadResultMsgDb() {
  try { return JSON.parse(readFileSync(RESULT_MSG_DB_PATH, 'utf8')); }
  catch { return []; }
}

function _saveResultMsgDb(entries) {
  try {
    mkdirSync(dirname(RESULT_MSG_DB_PATH), { recursive: true });
    writeFileSync(RESULT_MSG_DB_PATH, JSON.stringify(entries, null, 2), 'utf8');
  } catch {}
}

/** Registra msgId de resultado para protegê-lo de exclusão por 24h */
function _trackResultMessage(msgId) {
  if (!msgId) return;
  const entries = _loadResultMsgDb();
  const cutoff  = Date.now() - RESULT_PROTECT_MS;
  const fresh   = entries.filter((e) => e.ts > cutoff);
  if (!fresh.some((e) => e.msgId === msgId)) fresh.push({ msgId, ts: Date.now() });
  _saveResultMsgDb(fresh);
}

/** Retorna Set de IDs de mensagens de resultado ainda dentro da janela de 24h */
export function getProtectedResultMessageIds() {
  const cutoff = Date.now() - RESULT_PROTECT_MS;
  return new Set(_loadResultMsgDb().filter((e) => e.ts > cutoff).map((e) => e.msgId));
}

/** Arquivo persistente de rastreamento de mensagens enviadas */
const SENT_DB_PATH = join(__dirname, '../../data/telegram-sent.json');

/** Carrega o banco de mensagens do disco */
function _loadSentDb() {
  try {
    return JSON.parse(readFileSync(SENT_DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** Persiste o banco de mensagens no disco */
function _saveSentDb(db) {
  try {
    mkdirSync(dirname(SENT_DB_PATH), { recursive: true });
    writeFileSync(SENT_DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[Telegram] Falha ao salvar histórico: ${err.message}`);
  }
}

/**
 * Gera uma fingerprint leve da mensagem.
 * Remove tags HTML e colapsa espaços para comparar o conteúdo real.
 */
function _fingerprint(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

/** Remove do banco entradas fora da janela de deduplicação */
function _pruneDb(db) {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const key of Object.keys(db)) {
    if (db[key].ts < cutoff) delete db[key];
  }
}

/**
 * Deleta uma mensagem já enviada no grupo via API do Telegram.
 * Silencioso em caso de falha (mensagem pode já ter sido apagada).
 */
async function _deleteOldMessage(messageId) {
  if (!messageId) return;
  try {
    await axios.post(`${BASE}/bot${process.env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      chat_id: getChatId(),
      message_id: messageId,
    });
    console.log(`[Telegram] Duplicata removida (msg_id: ${messageId})`);
  } catch { /* ignora — mensagem pode já ter expirado (>48h) ou sido apagada */ }
}

async function send(text, options = {}) {
  if (!isConfigured()) return null;

  // Extrai opções de controle antes de repassar ao Telegram
  const { dedupKey: explicitKey, dedupWindowMs, protected: isProtected, ...sendOptions } = options;
  const key    = explicitKey ?? _fingerprint(text);
  const window = dedupWindowMs ?? DEDUP_WINDOW_MS;

  const db = _loadSentDb();
  _pruneDb(db);

  if (db[key] && Date.now() - db[key].ts < window) {
    if (db[key].protected) {
      // Mensagem de análise ativa — nunca apagar antes do resultado; bloquear reenvio
      console.log(`[Telegram] Mensagem protegida (análise ativa) — reenvio bloqueado (msg_id: ${db[key].msgId})`);
      return db[key].msgId;
    }
    // Mensagem normal: apaga antiga, envia nova (atualização)
    console.warn(`[Telegram] Duplicata detectada — removendo mensagem anterior (msg_id: ${db[key].msgId})`);
    await _deleteOldMessage(db[key].msgId);
    delete db[key];
  }

  try {
    const res = await axios.post(`${BASE}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: getChatId(),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...sendOptions,
    });
    const msgId = res.data?.result?.message_id ?? null;

    if (msgId) {
      db[key] = { msgId, ts: Date.now(), protected: isProtected ?? false };
      _saveSentDb(db);
    }

    return msgId;
  } catch (err) {
    console.warn(`[Telegram] Falha ao enviar: ${err.message}`);
    return null;
  }
}

function formatDateTime(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const d    = new Date(dateStr);
    const data = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `${data}  às  ${hora}`;
  } catch { return dateStr; }
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch { return dateStr; }
}

function formatTime(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch { return dateStr; }
}

// ─────────────────────────────────────────────────────────────
// HELPERS DE MERCADO
// ─────────────────────────────────────────────────────────────

function _marketIcon(mercado) {
  const m = (mercado || '').toUpperCase();
  if (m.includes('BTTS') || m.includes('AMBAS'))                                         return '⚽';
  if (m.includes('ESCANTEIO') || m.includes('CANTO') || m.includes('CORNER'))           return '⛳';
  if (m.includes('CARTÃO') || m.includes('CARTAO') || m.includes('AMARELO'))            return '🟨';
  if (m.includes('DUPLA') || m.includes('CHANCE') || m === '1X' || m === 'X2' || m === '12') return '🔄';
  if (m.includes('PLACAR') || m.includes('EXATO'))                                       return '🎯';
  if (m.includes('GOLS') || m.includes('TOTAL') || m.includes('OVER') || m.includes('UNDER')) return '🥅';
  return '📊';
}

function _marketLabel(mercado) {
  const m = (mercado || '').toUpperCase();
  if (m.includes('BTTS') || m.includes('AMBAS') || m.includes('MARCAM')) return 'Ambas Marcam';
  if (m.includes('ESCANTEIO') || m.includes('CORNER'))    return 'Escanteios';
  if (m.includes('CARTÃO') || m.includes('CARTAO') || m.includes('AMARELO')) return 'Cartões';
  if (m.includes('DUPLA') || m.includes('CHANCE'))        return 'Dupla Chance';
  if (m.includes('PLACAR') || m.includes('EXATO'))        return 'Placar Exato';
  if (m.includes('GOLS') || m.includes('TOTAL') ||
      m.includes('OVER') || m.includes('UNDER'))          return 'Gols';
  return mercado;
}

/**
 * Formata recomendação de mercado — sempre usa "Over X.5" / "Under X.5"
 * Exemplos: "APOSTAR" + mercado "Over 2.5" → "Over 2.5"
 *           "OVER" + mercado "Gols" + linha ausente → "Over"
 *           "SIM" → "SIM"
 */
function _formatRec(mercado, rec) {
  const mu = (mercado || '').toUpperCase();
  const ru = (rec     || '').toUpperCase();

  // Mercados binários sem linha numérica
  if (mu.includes('BTTS') || mu.includes('AMBAS') || mu.includes('MARCAM')) {
    if (ru === 'SIM' || ru === 'APOSTAR') return 'Sim';
    if (ru === 'NÃO' || ru === 'NAO')    return 'Não';
    return rec;
  }
  if (mu.includes('DUPLA') || mu.includes('CHANCE')) return rec;
  if (mu.includes('PLACAR') || mu.includes('EXATO')) return rec;

  // Mercados com linha numérica (Gols, Escanteios, Cartões)
  const linhaFromMercado = mercado.match(/\d+\.?\d*/)?.[0];
  const linhaFromRec     = rec.match(/\d+\.?\d*/)?.[0];
  const linha = linhaFromMercado || linhaFromRec || '';

  // Garante que a linha seja sempre X.5
  const linhaFmt = linha
    ? (linha.includes('.') ? linha : `${linha}.5`)
    : '';

  const isOver = ru.includes('OVER') || ru.includes('MAIS') || ru === 'SIM' || ru === 'APOSTAR';
  const dir    = isOver ? 'Over' : 'Under';

  return linhaFmt ? `${dir} ${linhaFmt}` : dir;
}

/**
 * Constrói a descrição completa da aposta para exibição ao usuário.
 * Combina tipo de mercado + seleção específica, resultando em frases como:
 *   "Gols  Over 1.5", "Ambas Marcam  Sim", "Escanteios  Over 8.5"
 *
 * @param {string} marketType   - Tipo do agente  (ex: "Total de Gols", "Ambas Marcam", "Escanteios")
 * @param {string} mercado      - Seleção Gemini  (ex: "Over 1.5", "BTTS", "Over 8.5")
 * @param {string} recomendacao - Ação do agente  (ex: "APOSTAR", "SIM", "NÃO")
 */
function _buildBetLabel(marketType, mercado, recomendacao) {
  const mt  = (marketType  || '').toUpperCase();
  const mc  = (mercado     || '').toUpperCase();
  const rec = (recomendacao || 'APOSTAR').toUpperCase();

  // BTTS / Ambas Marcam
  if (mt.includes('BTTS') || mc.includes('BTTS') || mt.includes('AMBAS') || mt.includes('MARCAM')) {
    const dir = (rec === 'SIM' || rec === 'APOSTAR') ? 'Sim' : 'Não';
    return `Ambas Marcam  ${dir}`;
  }

  // Escanteios / Corners
  if (mt.includes('ESCANTEIO') || mt.includes('CORNER') || mc.includes('ESCANTEIO')) {
    return `Escanteios  ${_formatRec(mercado, recomendacao)}`;
  }

  // Cartões
  if (mt.includes('CARTÃO') || mt.includes('CARTAO') || mt.includes('AMARELO')) {
    return `Cartões  ${_formatRec(mercado, recomendacao)}`;
  }

  // Dupla Chance: 1X, X2, 12
  if (mc === '1X' || mc === 'X2' || mc === '12' ||
      mt.includes('DUPLA') || mt.includes('CHANCE')) {
    return `Dupla Chance  ${mercado.toUpperCase()}`;
  }

  // Gols (fallback — "Total de Gols", "Over X.5", etc.)
  return `Gols  ${_formatRec(mercado, recomendacao)}`;
}

// Risco calculado com base em probabilidade + confiança
function _calcRisk(prob, conf) {
  const p = Number(prob) || 0;
  const c = Number(conf) || 0;
  if (p >= 90 && c >= 88) return { label: 'Baixo',  icon: '🟢' };
  if (p >= 85 && c >= 80) return { label: 'Médio',  icon: '🟡' };
  return                   { label: 'Alto',   icon: '🔴' };
}

// Agrupa array de partidas por competição
function _groupByComp(matches, getComp = (m) => m.competition || 'Outros') {
  const map = new Map();
  for (const m of matches) {
    const comp = getComp(m) || 'Outros';
    if (!map.has(comp)) map.set(comp, []);
    map.get(comp).push(m);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// GRADE DO DIA — agrupada por campeonato
// ─────────────────────────────────────────────────────────────
export async function notifyGradeDoDia(matches) {
  if (!isConfigured() || !matches?.length) return;

  const hoje = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const lines = [
    `📅  <b>${hoje.toUpperCase()}</b>`,
    SEP_HEAVY,
    BR,
  ];

  const byComp = _groupByComp(matches);

  for (const [comp, compMatches] of byComp) {
    lines.push(`🏆  <b>${comp}</b>`);
    for (const m of compMatches) {
      const hora  = m.match_time || (m.date ? formatTime(m.date) : '—');
      const home  = m.home_team  || m.match  || '?';
      const away  = m.away_team  || '';
      const enc   = m.date && (new Date(m.date) - Date.now()) / 3_600_000 < -2;
      const pref  = enc ? '⛔' : '⏰';
      const label = away ? `<b>${home}</b>  vs  <b>${away}</b>` : `<b>${home}</b>`;
      lines.push(`  ${pref}  ${hora}  —  ${label}`);
    }
    lines.push(BR);
  }

  lines.push(SEP_HEAVY);
  lines.push(`🤖 <i>Análise automática · oportunidades enviadas em tempo real</i>`);

  const dedupKey = `grade_dia_${new Date().toISOString().slice(0, 10)}`;
  await send(lines.join('\n'), { dedupKey });
}

// ─────────────────────────────────────────────────────────────
// MINI-GRADE — apenas jogos com oportunidade, agrupados por liga
// ─────────────────────────────────────────────────────────────
export async function notifyMiniGrade(approvedMatches) {
  if (!isConfigured() || !approvedMatches.length) return;

  const hoje = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: '2-digit',
  });

  const lines = [
    `📡  <b>ANÁLISE AUTOMÁTICA</b>`,
    SEP_HEAVY,
    `📅  ${hoje.toUpperCase()}`,
    `⚽  <b>${approvedMatches.length}  oportunidade(s) encontrada(s)</b>`,
    BR,
  ];

  const byComp = _groupByComp(approvedMatches, (r) => r.matchData?.competition);

  for (const [comp, items] of byComp) {
    lines.push(`🏆  <b>${comp}</b>`);
    for (const { idx, matchData } of items) {
      const hora  = matchData.match_time || (matchData.date ? formatTime(matchData.date) : '—');
      const [h, a] = (matchData.match || '').split(' vs ');
      const label  = h && a
        ? `<b>${h.trim()}</b>  vs  <b>${a.trim()}</b>`
        : `<b>${matchData.match}</b>`;
      lines.push(`  #${idx}  ·  ⏰  ${hora}  —  ${label}`);
    }
    lines.push(BR);
  }

  lines.push(SEP_LIGHT);
  lines.push(`<i>Análises detalhadas a seguir ↓</i>`);

  const dedupKey = `mini_grade_${new Date().toISOString().slice(0, 13)}`;
  await send(lines.join('\n'), { dedupKey });
}

// ─────────────────────────────────────────────────────────────
// ANÁLISE DE MERCADOS — modelo padrão unificado por partida
// ─────────────────────────────────────────────────────────────
export async function notifyMarketAnalysis(matchData, approvedResults) {
  if (!isConfigured()) return;

  // Regra obrigatória: análise só enviada com link direto Superbet confirmado
  if (!matchData.superbetUrl) {
    console.log(`[Telegram] PRÉ-LIVE bloqueado — sem URL Superbet para: ${matchData.match || '?'}`);
    return null;
  }

  const hora = matchData.date ? formatTime(matchData.date) : (matchData.match_time || '—');
  const data = matchData.date ? formatDate(matchData.date) : '';
  const comp = matchData.competition || '';

  const [homeRaw, awayRaw] = (matchData.match || '').split(' vs ');
  const matchLabel = homeRaw && awayRaw
    ? `<b>${homeRaw.trim()} vs ${awayRaw.trim()}</b>`
    : `<b>${matchData.match}</b>`;

  const lines = [
    `🟢  <b>PRÉ-LIVE</b>`,
    SEP_HEAVY,
    `⚽  ${matchLabel}`,
    comp ? `🏆  <b>${comp}</b>  ·  ⏰  ${hora}${data ? '  ·  📅  ' + data : ''}` : `⏰  ${hora}${data ? '  ·  📅  ' + data : ''}`,
    BR,
  ];

  for (const r of approvedResults) {
    const mercado = r.mercado      ?? r.market         ?? '';
    const rec     = r.recomendacao ?? r.recommendation ?? '';
    const prob    = r.probabilidade ?? r.probability   ?? 0;
    const conf    = r.confianca    ?? r.confidence     ?? 0;

    const icon   = _marketIcon(mercado);
    const label  = _marketLabel(mercado);
    const recFmt = _formatRec(mercado, rec);
    const risco  = _calcRisk(prob, conf);

    lines.push(`${icon} <b>${label} → ${recFmt}</b>  📊 ${prob}%  🔒 ${conf}%  ${risco.icon}`);

    if (r.top_placares?.length) {
      const tops = r.top_placares.slice(0, 2)
        .map((p) => `${p.placar}(${p.probabilidade}%)`)
        .join(' · ');
      lines.push(`  🎯 ${tops}`);
    }
  }

  lines.push(BR);
  lines.push(`<i>📊 Prob  🔒 Conf  🟢 Baixo  🟡 Médio  🔴 Alto</i>`);
  lines.push(SEP_LIGHT);
  lines.push(`🤖  <i>Betting Analysis Squad</i>`);

  // Gera ID único para rastreamento de engajamento
  const signalId = randomUUID();

  // URL resolvida para o botão de link rastreado
  const _superbetUrl = (() => {
    if (matchData.superbetUrl) return matchData.superbetUrl;
    const key = (comp || '').toLowerCase();
    return Object.entries(SUPERBET_COMPETITION_LINKS)
      .find(([k]) => key.includes(k))?.[1] ?? SUPERBET_FALLBACK;
  })();

  // Botão inline rastreável — substitui o link de texto simples
  const replyMarkup = {
    inline_keyboard: [[
      { text: '🔗 Apostar agora → Superbet', callback_data: `link_${signalId}` },
    ]],
  };

  // Chave estável por jogo — bloqueia duplicata da mesma partida por 24h (evita reenvio pelo daily-pipeline)
  const _mNorm = (matchData.match || '').replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '').substring(0, 40);
  const monitorDedupKey = `monitor_${_mNorm}`;

  // protected: true — impede deleção automática por dedup até o resultado ser registrado
  const msgId = await send(lines.join('\n'), {
    protected:     true,
    dedupKey:      monitorDedupKey,
    dedupWindowMs: 24 * 60 * 60 * 1000,  // 24h
    reply_markup:  replyMarkup,
  });

  // Registra sinal para rastreamento de engajamento + nota Obsidian
  if (msgId) {
    const primaryMarket = approvedResults[0]?.mercado ?? approvedResults[0]?.market ?? '';
    trackSignalSent({
      signalId,
      match:       matchData.match || '',
      market:      primaryMarket,
      competition: comp,
      msgId,
      linkUrl:     _superbetUrl,
    });
    // Cria nota individual no Obsidian para esta análise
    if (isObsidianConfigured()) {
      try { saveAnaliseNote(matchData, approvedResults, msgId, signalId); } catch { /* não bloqueia */ }
    }
  }

  return msgId;
}

// ─────────────────────────────────────────────────────────────
// OPORTUNIDADE — usado pelo pipeline full-match-analysis
// ─────────────────────────────────────────────────────────────
export async function notifyMatchOpportunity(matchData, report) {
  if (!isConfigured()) return;

  const { confidence_score, recommendation, top_bet, risk } = report;
  const icon     = recommendation?.action === 'BET' ? '🟢' : '🟡';
  const recLabel = recommendation?.label || '';

  const matchDateTime = matchData.date
    ? formatDateTime(matchData.date)
    : (matchData.match_time || 'N/A');

  const market = top_bet?.market || 'N/A';
  const odds   = top_bet?.odds   || 'N/A';
  const house  = top_bet?.house  || 'N/A';
  const ev     = top_bet?.ev_pct || 'N/A';

  const scores = report.probabilistic_scores || report.quant?.probabilistic_scores;
  const comp   = matchData.competition || 'N/A';

  const lines = [
    `${icon}  <b>${recLabel}</b>`,
    SEP_HEAVY,
    BR,
    `🏆  <b>${comp}</b>`,
    `⚽  <b>${matchData.match}</b>`,
    `📅  ${matchDateTime}`,
    BR,
    `🎯  <b>MELHOR  MERCADO</b>`,
    SEP_LIGHT,
    `📌  <b>${market}</b>`,
    `💰  Odds :  ${odds}  (${house})`,
    `📈  Edge (EV) :  ${ev}`,
    BR,
    `🔒  Confiança :  ${confidence_score} / 100`,
  ];

  if (risk?.risk_level) {
    const rIcon = risk.risk_level === 'LOW' ? '🟢' : risk.risk_level === 'MEDIUM' ? '🟡' : '🔴';
    lines.push(`${rIcon}  Risco :  ${risk.risk_level}`);
  }
  if (scores) {
    lines.push(BR);
    lines.push(`📊  Score  ${scores.home?.score?.toFixed(2)}  vs  ${scores.away?.score?.toFixed(2)}  —  ${scores.favoritismo?.toUpperCase()}`);
  }

  if (matchData._meta?.sources_used?.length) {
    lines.push(BR);
    lines.push(`🔗  Fontes :  ${matchData._meta.sources_used.join('  ·  ')}`);
  }

  lines.push(BR);
  lines.push(SEP_HEAVY);
  lines.push(`🤖  <i>Betting Analysis Squad</i>`);

  await send(lines.join('\n'));
}

// ─────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────
export async function sendStartup(intervalMin, hoursAhead) {
  if (!isConfigured()) return;

  const agora   = formatDateTime(new Date().toISOString());
  const destino = process.env.TELEGRAM_GROUP_ID ? '👥  Grupo' : '👤  Chat individual';

  const lines = [
    `🚀  <b>BET ANALYSIS SQUAD  —  INICIADO</b>`,
    SEP_HEAVY,
    BR,
    `📅  ${agora}`,
    `${destino}`,
    BR,
    `⏱  Scan a cada  <b>${intervalMin} min</b>`,
    `🌐  Fontes :  FlashScore  ·  SofaScore  ·  Academia  ·  365scores`,
    BR,
    SEP_LIGHT,
    `<i>Aguarde... primeiro scan em andamento.</i>`,
  ];

  await send(lines.join('\n'));
}

// ─────────────────────────────────────────────────────────────
// RELATÓRIO DIÁRIO
// ─────────────────────────────────────────────────────────────
export async function notifyDailySummary(analyses) {
  if (!isConfigured()) return;

  const bets       = analyses.filter((a) => a.recommendation?.action === 'BET');
  const considers  = analyses.filter((a) => a.recommendation?.action === 'CONSIDER');
  const totalStake = analyses.reduce((s, a) => s + (a.risk?.stake || 0), 0);
  const data       = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const lines = [
    `📊  <b>RELATÓRIO DIÁRIO  —  ${data}</b>`,
    SEP_HEAVY,
    BR,
    `✅  Apostar :       <b>${bets.length}</b>`,
    `🟡  Considerar :  <b>${considers.length}</b>`,
    `❌  Ignorar :       <b>${analyses.length - bets.length - considers.length}</b>`,
    `💰  Exposição :   <b>R$  ${totalStake.toFixed(2)}</b>`,
  ];

  if (bets.length) {
    lines.push(BR, `🎯  <b>TOP  APOSTAS</b>`, SEP_LIGHT);
    for (const bet of bets.slice(0, 3)) {
      const tb = bet.top_bet;
      const dt = bet.match_date ? formatDateTime(bet.match_date) : '';
      lines.push(`⚽  <b>${bet.match}</b>${dt ? '\n    📅  ' + dt : ''}`);
      if (tb) lines.push(`    📌  ${tb.market}  @  ${tb.odds}  —  EV :  ${tb.ev_pct}`);
      lines.push(BR);
    }
  }

  lines.push(SEP_HEAVY);
  lines.push(`🤖  <i>Betting Analysis Squad</i>`);

  await send(lines.join('\n'));
}

export async function notifyBetRecommendation(report, matchData) {
  return notifyMatchOpportunity(matchData, report);
}

// ─────────────────────────────────────────────────────────────
// ALERTAS DE ODDS
// ─────────────────────────────────────────────────────────────
export async function notifySteamAlert(matchName, alert) {
  if (!isConfigured()) return;
  await send([
    `🚨  <b>STEAM  MOVE</b>`,
    `⚽  ${matchName}`,
    alert,
  ].join('\n'));
}

export async function notifyError(context, error) {
  if (!isConfigured()) return;
  await send([
    `❌  <b>ERRO  —  ${context}</b>`,
    `<code>${(error.message || '').slice(0, 200)}</code>`,
  ].join('\n'));
}

// ─────────────────────────────────────────────────────────────
// RESUMO DO SCAN
// ─────────────────────────────────────────────────────────────
export async function notifyScanSummary({ scanned, opportunities, elapsed }) {
  if (!isConfigured() || opportunities === 0) return;
  const agora = formatDateTime(new Date().toISOString());
  await send([
    `📊  <b>Scan concluído  —  ${agora}</b>`,
    `Analisados :  <b>${scanned}</b>  jogos   Oportunidades :  <b>${opportunities}</b>   Tempo :  <b>${elapsed}s</b>`,
  ].join('\n'));
}

// ─────────────────────────────────────────────────────────────
// LEMBRETE DE RESULTADO — 2h após kickoff
// ─────────────────────────────────────────────────────────────
export async function notifyResultReminder(idx, matchName, competition, extraNote = '') {
  if (!isConfigured()) return;

  const lines = [
    `⏱  <b>JOGO  FINALIZADO  —  #${idx}</b>`,
    SEP_LIGHT,
    BR,
    `⚽  <b>${matchName}</b>`,
  ];

  if (competition) lines.push(`🏆  ${competition}`);

  lines.push(
    BR,
    `Registre o placar para ver  ✅ Green  /  ❌ Red  e alimentar o modelo PIE :`,
    BR,
    `<code>/resultado ${idx} X-X</code>`,
    `<i>Exemplo :  /resultado ${idx} 2-1</i>`,
  );

  if (extraNote) lines.push(extraNote);

  await send(lines.filter((l) => l !== undefined).join('\n'));
}

// ─────────────────────────────────────────────────────────────
// RESULTADO DO JOGO — comparativo análise vs realidade
// ─────────────────────────────────────────────────────────────
export async function notifyMatchResult(matchData, idx, placar, analyses, requester, pieResult) {
  if (!isConfigured()) return;

  const parts     = placar.split(/[-x×:]/i).map((s) => parseInt(s.trim(), 10));
  const homeGoals = isNaN(parts[0]) ? 0 : parts[0];
  const awayGoals = isNaN(parts[1]) ? 0 : parts[1];
  const totalGols = homeGoals + awayGoals;
  const ambosMarcaram = homeGoals > 0 && awayGoals > 0;

  const matchName = matchData.match || matchData.match_name || `Jogo #${idx}`;
  const comp      = matchData.competition || '';

  const lines = [
    `📊  <b>RESULTADO  FINAL  —  #${idx}</b>`,
    SEP_HEAVY,
    BR,
    comp ? `🏆  ${comp}` : '',
    `⚽  <b>${matchName}</b>`,
    `🏟  Placar :  <b>${homeGoals}  ×  ${awayGoals}</b>`,
    BR,
    `📋  <b>COMPARATIVO  PRÉ-LIVE</b>`,
    SEP_LIGHT,
  ].filter(Boolean);

  let acertos = 0;
  let erros   = 0;

  for (const a of analyses) {
    const mercado = a.market         || '';
    const rec     = a.recommendation || '';
    const prob    = a.probabilidade  || 0;
    const mu      = mercado.toUpperCase();
    const ru      = rec.toUpperCase();

    let status  = '🔍';
    let acertou = null;

    if (mu.includes('BTTS') || mu.includes('AMBAS')) {
      acertou = (ru === 'SIM' || ru === 'APOSTAR') ? ambosMarcaram : !ambosMarcaram;
    } else if (mu.includes('GOLS') || mu.includes('TOTAL') || mu.includes('OVER') || mu.includes('UNDER')) {
      const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? '2.5');
      if (ru.includes('OVER') || ru.includes('MAIS') || ru === 'SIM' || ru === 'APOSTAR') {
        acertou = totalGols > linha;
      } else if (ru.includes('UNDER') || ru.includes('MENOS') || ru === 'NÃO') {
        acertou = totalGols < linha;
      }
    } else if (mu.includes('DUPLA') || mu.includes('CHANCE')) {
      if (ru === '1X')      acertou = homeGoals >= awayGoals;
      else if (ru === 'X2') acertou = awayGoals >= homeGoals;
      else if (ru === '12') acertou = homeGoals !== awayGoals;
    } else if (mu.includes('PLACAR') || mu.includes('EXATO')) {
      const m = rec.match(/(\d+)\s*[x×\-:]\s*(\d+)/i);
      if (m) acertou = parseInt(m[1]) === homeGoals && parseInt(m[2]) === awayGoals;
    }

    if (acertou === true)  { status = '✅'; acertos++; }
    if (acertou === false) { status = '❌'; erros++;   }

    const icon    = _marketIcon(mercado);
    const label   = _marketLabel(mercado);
    const recFmt  = _formatRec(mercado, rec);

    lines.push(`${status}  ${icon}  <b>${label}  →  ${recFmt}</b>  (${prob}%)`);
  }

  lines.push(BR);
  const total           = acertos + erros;
  const naoVerificaveis = analyses.length - total;

  if (total > 0) {
    lines.push(`📈  Verificáveis :  ${total}   ✅  ${acertos}   ❌  ${erros}`);
  }
  if (naoVerificaveis > 0) {
    lines.push(`🔍  ${naoVerificaveis}  mercado(s) requerem verificação manual`);
  }

  if (pieResult?.newLessons?.length) {
    lines.push(BR, `📚  <b>Lição  registrada  no  PIE :</b>`);
    for (const l of pieResult.newLessons) {
      lines.push(`<i>${l.directive}</i>`);
    }
    lines.push(`<i>Diretiva aplicada nas próximas análises de ${pieResult.newLessons[0]?.market || 'mercado'}.</i>`);
  }

  lines.push(BR, SEP_HEAVY);
  lines.push(`<i>Registrado por :  ${requester}</i>`);

  const msgId = await send(lines.join('\n'));
  // Protege a mensagem de resultado por 24h — não será apagada pelo grupo cleanup
  _trackResultMessage(msgId);
  return msgId;
}

// ─────────────────────────────────────────────────────────────
// ESTATÍSTICAS PIE
// ─────────────────────────────────────────────────────────────
export async function notifyPIEStats(stats) {
  if (!isConfigured()) return;

  const { total, acertos, erros, verificaveis, taxaAcerto, nao_verificaveis,
          licoesAtivas, licoesTotal, porMercado } = stats;

  const lines = [
    `🧠  <b>SISTEMA  —  ESTATÍSTICAS  DO  MODELO</b>`,
    SEP_HEAVY,
    BR,
    `📊  Predições totais :  <b>${total}</b>`,
    `✅  Acertos :  <b>${acertos}</b>   ❌  Erros :  <b>${erros}</b>   🔍  N/V :  <b>${nao_verificaveis || 0}</b>`,
    taxaAcerto
      ? `📈  Taxa de acerto :  <b>${taxaAcerto}%</b>  (${verificaveis} verificáveis)`
      : `📈  Sem resultados registrados ainda`,
    BR,
    `📚  Lições :  <b>${licoesAtivas}</b>  ativas  /  <b>${licoesTotal}</b>  total`,
  ];

  if (Object.keys(porMercado).length) {
    lines.push(BR, `<b>Acurácia por Mercado :</b>`, SEP_LIGHT);
    for (const [mercado, v] of Object.entries(porMercado)) {
      const t   = v.acertos + v.erros;
      const pct = t > 0 ? ((v.acertos / t) * 100).toFixed(0) : '—';
      const icon = _marketIcon(mercado);
      lines.push(`  ${icon}  ${mercado}  :  ${v.acertos} ✅  ${v.erros} ❌  (${pct}%)`);
    }
  }

  lines.push(BR, SEP_HEAVY);
  lines.push(`🤖  <i>${new Date().toLocaleString('pt-BR')}  ·  Betting Analysis Squad</i>`);

  await send(lines.join('\n'));
}

// ═════════════════════════════════════════════════════════════════
// 🔵 PRÉ-LIVE — Análise prévia (até 24h antes do evento)
// Odds alvo: 2x – 10x · retorno potencial + risco explícito
// ═════════════════════════════════════════════════════════════════
export async function notifyPreLiveAnalysis(analysis, opts = {}) {
  if (!isConfigured()) return;

  const { stakeInfo, risco, pieAccuracy, horasAte, directUrl } = opts;

  // Regra obrigatória: análise só enviada com link direto Superbet confirmado
  if (!directUrl) {
    console.log(`[Telegram] PRÉ-LIVE bloqueado — sem URL Superbet para: ${analysis.matchData?.match || analysis.match_name || '?'}`);
    return null;
  }
  const matchData = analysis.matchData || {};
  const topBet    = analysis.top_bet   || {};
  const score     = analysis.confidence_score ?? 0;
  const comp      = matchData.competition || 'N/A';

  const hora = matchData.date ? formatTime(matchData.date) : (matchData.match_time || '—');
  const data = matchData.date ? formatDate(matchData.date) : '';

  const [homeRaw, awayRaw] = (matchData.match || '').split(' vs ');
  const homeStr = homeRaw?.trim() || matchData.match || 'Jogo';
  const awayStr = awayRaw?.trim() || '';

  // Aposta: tipo de mercado + seleção
  const marketLabel = _marketLabel(topBet.market) || topBet.market || 'N/A';
  const betSel      = _formatRec(topBet.market || '', 'APOSTAR');
  const betLine     = betSel && betSel !== 'Over' && betSel !== 'Under'
    ? `${marketLabel}  →  <b>${betSel}</b>`
    : `<b>${marketLabel}</b>`;

  // Odds
  const oddsVal = topBet.odds ? String(topBet.odds).replace('.', ',') : null;

  // Horas até o jogo
  let horaStr = '';
  if (horasAte != null && horasAte > 0) {
    horaStr = horasAte >= 2 ? `  ·  ⏳ em ${horasAte}h` : `  ·  ⏳ em breve`;
  }

  const lines = [
    `<b>🔵  PRÉ-LIVE</b>`,
    `<b>🏆  ${comp.toUpperCase()}</b>`,
    `<b>⚽️  ${homeStr}  vs  ${awayStr}</b>`,
    `<b>⏰  ${hora}${data ? '  ·  📅  ' + data : ''}${horaStr}</b>`,
    BR,
    SEP_HEAVY,
    BR,
    `⚽  ${betLine}`,
  ];

  if (oddsVal) lines.push(`💰  Odds mínimas:  <b>${oddsVal}</b>`);
  lines.push(`📈  Prob: ${score}%  ·  🎯  Conf: ${score}%`);

  if (risco) lines.push(`${risco.icon}  Risco:  <b>${risco.label}</b>`);
  if (pieAccuracy != null) lines.push(`📊  Precisão PIE:  ${pieAccuracy}%`);

  // xG esperado pelo modelo (lambda Poisson ou coletado via SofaScore)
  const xgH = analysis.xg_home ?? matchData.xg_home ?? null;
  const xgA = analysis.xg_away ?? matchData.xg_away ?? null;
  if (xgH != null && xgA != null) {
    lines.push(`🧮  xG esperado:  <b>${Number(xgH).toFixed(2)}</b>  –  <b>${Number(xgA).toFixed(2)}</b>`);
  }

  lines.push(BR);
  lines.push(SEP_LIGHT);
  lines.push(_houseLink(topBet.house || 'Superbet', comp, directUrl || null));
  lines.push(`🤖  <i>Betting Analysis Squad</i>`);

  // Chave estável por jogo+mercado — bloqueia reenvio por 24h de qualquer rota
  const _dedupMatch  = (matchData.match || '').replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '').substring(0, 40);
  const _dedupMarket = (topBet.market || '').replace(/\s+/g, '_').replace(/[^a-z0-9_.]/gi, '');
  const stableDedupKey = `prelive_${_dedupMatch}_${_dedupMarket}`;

  const msgId = await send(lines.join('\n'), {
    protected:     true,
    dedupKey:      stableDedupKey,
    dedupWindowMs: 24 * 60 * 60 * 1000,  // 24h — impede duplicata do auto-monitor
  });

  // Registra análise para verificação de resultado posterior
  if (msgId) {
    savePendingAnalysis({
      msgId,
      type:         'prelive',
      match:        matchData.match,
      competition:  comp,
      sofascoreId:  String(matchData.match_id || matchData.sofascore_id || matchData.event_id || ''),
      market:       topBet.market || '',
      prediction:   _formatRec(topBet.market || '', 'APOSTAR') || 'Sim',
      probabilidade: score,
      confianca:    score,
      odds:         topBet.odds || null,
      gameTime:     matchData.date || null,
      messageText:  lines.join('\n'),  // guarda texto original para edição posterior
    });
  }

  return msgId;
}

// ═════════════════════════════════════════════════════════════════
// 🔴 AO VIVO 2° TEMPO — Análise em tempo real (min 46+)
// Odds alvo: 2x – 20x · stats ao vivo + retorno potencial + risco
// ═════════════════════════════════════════════════════════════════
export async function notifyLiveSecondHalf(liveData, opportunities, opts = {}) {
  if (!isConfigured() || !opportunities?.length) return;

  // Regra obrigatória: análise LIVE só enviada com link direto Superbet confirmado
  if (!opts.directUrl) {
    console.log(`[Telegram] LIVE bloqueado — sem URL Superbet para: ${liveData.match || '?'}`);
    return null;
  }

  const ls     = liveData.live_stats || {};
  const min    = liveData.minuto ?? '?';
  const restam = liveData.minutos_restantes ?? (typeof min === 'number' ? Math.max(0, 90 - min) : '?');
  const placarRaw = liveData.placar || `${liveData.gols_casa ?? 0}-${liveData.gols_fora ?? 0}`;
  // Formata placar como "1 - 0"
  const placarFmt = placarRaw.replace(/[-x×:]/g, ' - ').replace(/\s{2,}/g, ' - ');
  const match  = liveData.match  || 'Jogo';
  const comp   = liveData.competition || '';

  const [homeRaw, awayRaw] = match.split(' vs ');
  const matchBold = homeRaw && awayRaw
    ? `<b>${homeRaw.trim()}  vs  ${awayRaw.trim()}</b>`
    : `<b>${match}</b>`;

  const lines = [
    `<b>🔴  AO VIVO  ·  2° TEMPO</b>`,
    comp ? `<b>🏆  ${comp.toUpperCase()}</b>` : null,
    `<b>⚽️  ${homeRaw?.trim() || match}  vs  ${awayRaw?.trim() || ''}</b>`,
    `<b>⏱  ${min}'  ·  Placar:  ${placarFmt}${restam !== '?' ? `  ·  ${restam}' restantes` : ''}</b>`,
  ].filter(Boolean);

  // Stats ao vivo — 📡 = sinal de dados em tempo real
  const statParts = [];
  if (ls.posse_casa != null)       statParts.push(`🚩 Posse ${ls.posse_casa}%×${ls.posse_fora ?? (100 - ls.posse_casa)}%`);
  if (ls.chutes_alvo_casa != null) statParts.push(`🥅 Chutes ${ls.chutes_alvo_casa}×${ls.chutes_alvo_fora ?? '?'}`);
  if (ls.escanteios_casa != null)  statParts.push(`⛳️ Escanteios ${ls.escanteios_casa}×${ls.escanteios_fora ?? '?'}`);
  if (statParts.length) {
    lines.push(BR);
    lines.push(statParts.join('  ·  '));
  }

  // xG ao vivo — indica pressão real além do placar
  if (liveData.xg_home != null && liveData.xg_away != null) {
    const xgH   = liveData.xg_home.toFixed(2);
    const xgA   = liveData.xg_away.toFixed(2);
    const total = liveData.xg_total != null ? `  ·  Total xG: <b>${liveData.xg_total.toFixed(2)}</b>` : '';
    lines.push(`🧮  xG:  <b>${xgH}</b>  –  <b>${xgA}</b>${total}`);
  }

  lines.push(BR);
  lines.push(SEP_HEAVY);

  for (const o of opportunities) {
    const marketLbl  = _marketLabel(o.mercado);
    const rec        = _formatRec(o.mercado, o.recomendacao);
    const riscoIcon  = o.risco?.icon  ?? '🟡';
    const riscoLabel = o.risco?.label ?? '';

    // Seleção da aposta
    lines.push(BR);
    lines.push(`${_marketIcon(o.mercado)}  ${marketLbl}  →  <b>${rec}</b>`);

    // Odds (se disponível via stakeInfo ou diretamente em o.odds)
    const oddsDisp = o.odds ?? o.odds_minima ?? null;
    if (oddsDisp) lines.push(`💰  Odds sugeridas:  <b>≥ ${String(oddsDisp).replace('.', ',')}</b>`);

    lines.push(`📈  Prob: ${o.probabilidade}%  ·  🎯  Conf: ${o.confianca}%`);
    lines.push(`${riscoIcon}  Risco:  <b>${riscoLabel}</b>`);

    if (o.justificativa) {
      const just = o.justificativa.slice(0, 120);
      lines.push(BR);
      lines.push(`💬  <i>${just}</i>`);
    }
  }

  lines.push(BR);
  lines.push(SEP_LIGHT);
  lines.push(`<i>⚠️  Confirme as odds antes de apostar</i>`);
  lines.push(_houseLink('Superbet', comp, opts.directUrl || null));
  lines.push(`🤖  <i>Betting Analysis Squad</i>`);

  const msgId = await send(lines.join('\n'), {
    dedupWindowMs: 25 * 60_000, // 25min — evita reenvio entre ciclos
  });

  // Registra análise AO VIVO para verificação de resultado posterior
  if (msgId && opportunities?.length) {
    const topOpp = opportunities[0];
    savePendingAnalysis({
      msgId,
      type:         'live',
      match:        liveData.match,
      competition:  comp,
      sofascoreId:  String(liveData.match_id || liveData.sofascore_id || liveData.event_id || ''),
      market:       topOpp.mercado || '',
      prediction:   _formatRec(topOpp.mercado || '', topOpp.recomendacao) || 'Sim',
      probabilidade: topOpp.probabilidade,
      confianca:    topOpp.confianca,
      odds:         topOpp.odds ?? null,
      gameTime:     null, // jogo já em andamento
    });
  }

  return msgId;
}

/**
 * Retorna URL da competição na Superbet.
 * Prioridade: URL direta da partida → página da competição → futebol geral.
 */
function _superbetCompUrl() {
  // Página de futebol do Superbet (URL válida confirmada pelo scraper interno).
  // Links de partida específica só existem quando há odds coletadas (leg.superbet_url).
  return 'https://superbet.bet.br/apostas/futebol';
}

// ═════════════════════════════════════════════════════════════════
// 🚀 SUPER ODDS — Apostas combinadas (parlay)
// Odds alvo: 20x – 2000x · cada perna listada + retorno potencial
// ═════════════════════════════════════════════════════════════════
export async function notifySuperOddsParlay(parlayOptions, bankroll = 1000, { maxTiers = 4 } = {}) {
  if (!isConfigured()) return;

  const TIER_EMOJIS = {
    'Seguro':       '🛡️',
    'Acumulador':   '⚡',
    'Mega Retorno': '💥',
    'Super Odds':   '🚀',
  };
  const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

  const sentIds = [];
  let tiersSent = 0;

  // Prioridade: Mega Retorno (20x+) primeiro, depois demais por ordem
  const TIER_PRIORITY = ['Mega Retorno', 'Super Odds', 'Acumulador', 'Seguro'];
  const orderedTiers  = TIER_PRIORITY
    .map(name => [name, (parlayOptions.tiers || {})[name]])
    .filter(([, data]) => data?.available && data?.best?.length);

  for (const [tierName, tierData] of orderedTiers) {
    if (tiersSent >= maxTiers) break;

    const emoji    = TIER_EMOJIS[tierName] || '🎰';
    const topCombo = tierData.best[0];
    if (!topCombo?.legs?.length) continue;

    // Gate por tier: confiança combinada mínima proporcional ao número de pernas
    const confComb = topCombo.confidence ?? 0;
    const confGate = tierName === 'Seguro' ? 50
                   : tierName === 'Acumulador' ? 30
                   : 15;  // Mega Retorno e Super Odds: gate mais baixo (alto risco/retorno)
    if (confComb < confGate) continue;

    const isMega = topCombo.is_mega || topCombo.combined_odds >= 20.0;

    const risco = tierName === 'Seguro'
      ? { label: 'Baixo',  icon: '🟢' }
      : tierName === 'Acumulador'
      ? { label: 'Médio',  icon: '🟡' }
      : tierName === 'Mega Retorno'
      ? { label: 'Alto+',  icon: '🔴' }
      : { label: 'Máximo', icon: '🔴' };

    const megaHeader = isMega ? `\n💥  <b>MEGA RETORNO — ODDS ${topCombo.combined_odds}×</b>` : '';

    const lines = [
      `<b>${emoji}  SUPER ODDS  ·  ${tierName.toUpperCase()}</b>`,
      megaHeader,
      `<b>💎  Odds combinadas:  ${topCombo.combined_odds}×</b>`,
      `<b>📈  Probabilidade de acerto:  ${confComb}%</b>`,
      BR,
      SEP_HEAVY,
      `✅  Seleções (${topCombo.legs.length} pernas)`,
      SEP_HEAVY,
    ].filter(l => l !== undefined && l !== '');

    for (let i = 0; i < topCombo.legs.length; i++) {
      const leg      = topCombo.legs[i];
      const num      = NUMBERS[i] || `${i + 1}.`;
      const legScore = leg.confidence    ?? 0;
      const legProb  = leg.probabilidade ?? legScore;
      const legConf  = leg.confianca     ?? legScore;
      const confIcon = legScore >= 80 ? '🟢' : legScore >= 70 ? '🟡' : '🔴';

      const [homeR, awayR] = (leg.match || '').split(' vs ');
      const matchBold = homeR && awayR
        ? `<b>${homeR.trim()}  vs  ${awayR.trim()}</b>`
        : `<b>${leg.match || '?'}</b>`;

      const legDateTime = leg.match_date
        ? `⏰  ${formatTime(leg.match_date)}  ·  📅  ${formatDate(leg.match_date)}`
        : leg.match_time
        ? `⏰  ${leg.match_time}`
        : null;

      const betLabel = _buildBetLabel(
        leg.market_type || leg.market,
        leg.market,
        leg.recomendacao || 'APOSTAR',
      );

      // Liga acima do nome do jogo (ex: Premier League › Nottingham Forest vs Aston Villa)
      const compLabel = leg.competition && leg.competition !== '-'
        ? leg.competition
        : null;

      lines.push(BR);
      if (compLabel) lines.push(`${num}  🏆  <i>${compLabel}</i>`);
      lines.push(compLabel ? `   ${matchBold}` : `${num}  ${matchBold}`);
      if (legDateTime) lines.push(`   ${legDateTime}`);
      lines.push(`   ${confIcon}  ${_marketIcon(leg.market_type || leg.market)}  <b>${betLabel}</b>`);
      lines.push(`   📈  Prob: ${legProb}%  ·  🎯  Conf: ${legConf}%`);
      // Link Superbet: URL direta da partida se disponível, senão URL da competição
      const superbetUrl = leg.superbet_url || _superbetCompUrl(leg.competition);
      lines.push(`   <a href="${superbetUrl}">🎯  Apostar → Superbet</a>`);
    }

    const roiPct = Math.round((topCombo.combined_odds - 1) * 100);

    lines.push(BR);
    lines.push(SEP_HEAVY);
    lines.push(`📈  Multiplicador:  <b>${topCombo.combined_odds}×</b>  ·  Retorno:  <b>+${roiPct}%</b>`);
    lines.push(`${risco.icon}  Risco:  <b>${risco.label}</b>  —  ${confComb}% de chance de acerto`);

    if ((tierName === 'Super Odds' || tierName === 'Mega Retorno') && topCombo.combined_prob) {
      lines.push(BR);
      lines.push(`⚠️  Probabilidade real de acerto:  <b>${topCombo.combined_prob}%</b>`);
    }

    lines.push(BR);
    lines.push(SEP_HEAVY);
    if (isMega) {
      lines.push(`💡  <i>Mercados selecionados: Over Corners 6.5 (82% PIE) · Over 1.5 (78% PIE) · 1X (71% PIE)</i>`);
    }
    lines.push(`<i>⚠️  Apostas combinadas são de alto risco — gerencie bem sua banca</i>`);
    lines.push(`🤖  <i>Betting Analysis Squad  ·  ${tierName}</i>`);

    const msgId = await send(lines.join('\n'));
    if (msgId) sentIds.push(msgId);
    tiersSent++;

    if (Object.keys(parlayOptions.tiers).length > 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return sentIds;
}

// ─────────────────────────────────────────────────────────────
// LIÇÕES APRENDIDAS PIE
// ─────────────────────────────────────────────────────────────
export async function notifyLicoes(licoes) {
  if (!isConfigured()) return;

  if (!licoes.length) {
    await send([
      `📚  <b>LIÇÕES  APRENDIDAS</b>`,
      SEP_LIGHT,
      `<i>Nenhuma lição registrada ainda.\nUse  /resultado N placar  após os jogos para alimentar o modelo.</i>`,
    ].join('\n'));
    return;
  }

  const lines = [
    `📚  <b>LIÇÕES  APRENDIDAS  —  PIE</b>`,
    SEP_HEAVY,
    BR,
  ];

  for (let i = 0; i < licoes.length; i++) {
    const l       = licoes[i];
    const icon    = _marketIcon(l.market);
    const prio    = (l.weight || 1) >= 2 ? '🔴  Crítico' : '🟡  Atenção';
    lines.push(`<b>${i + 1}.  ${icon}  ${l.market}${l.competition ? '  |  ' + l.competition : ''}</b>`);
    lines.push(`${prio}`);
    lines.push(`${l.directive}`);
    lines.push(BR);
  }

  lines.push(SEP_HEAVY);
  lines.push(`🤖  <i>${new Date().toLocaleString('pt-BR')}  ·  Betting Analysis Squad</i>`);

  await send(lines.join('\n'));
}

// ─────────────────────────────────────────────────────────────
// LIMPAR MENSAGENS DO GRUPO
// ─────────────────────────────────────────────────────────────
export async function deleteGroupMessages(protectedIds = new Set()) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = getChatId();
  if (!token || !chatId) return;

  // Adiciona IDs de resultados recentes (< 24h) ao conjunto protegido
  const resultIds   = getProtectedResultMessageIds();
  const allProtected = new Set([...protectedIds, ...resultIds]);
  if (resultIds.size) {
    console.log(`[Telegram] Protegendo ${resultIds.size} mensagem(ns) de resultado (< 24h)`);
  }

  try {
    const probe = await axios.post(`${BASE}/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: '🗑',
    });
    const maxId  = probe.data.result.message_id;
    const fromId = Math.max(1, maxId - 599);

    for (let base = fromId; base <= maxId; base += 100) {
      const ids = [];
      for (let id = base; id <= Math.min(base + 99, maxId); id++) {
        if (!allProtected.has(id)) ids.push(id);
      }
      if (ids.length) {
        await axios.post(`${BASE}/bot${token}/deleteMessages`, {
          chat_id: chatId, message_ids: ids,
        }).catch(() => {});
      }
    }
    console.log(`[Telegram] Histórico apagado (até msg #${maxId})`);
  } catch (err) {
    console.warn(`[Telegram] Falha ao apagar mensagens: ${err.message}`);
  }
}

/**
 * Apaga mensagens de análise de um jogo após o resultado ser registrado.
 * @param {number[]} messageIds — IDs das mensagens a apagar
 */
export async function deleteMatchMessages(messageIds = []) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = getChatId();
  if (!token || !chatId || !messageIds.length) return;
  await axios.post(`${BASE}/bot${token}/deleteMessages`, {
    chat_id: chatId,
    message_ids: messageIds.filter(Boolean),
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// PERFORMANCE DASHBOARD — ranking dos analistas em tempo real
// ─────────────────────────────────────────────────────────────
export async function notifyPerformanceDashboard(dash) {
  if (!isConfigured()) return;

  const data = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const lines = [
    `🏆  <b>PERFORMANCE DOS ANALISTAS</b>`,
    SEP_HEAVY,
    `📅  ${data}   ⏱  Tempo real`,
    BR,
  ];

  if (!dash.ranking.length) {
    lines.push(`<i>Nenhum resultado registrado ainda.\nOs dados serão preenchidos automaticamente após cada jogo.</i>`);
    lines.push(BR, SEP_HEAVY);
    lines.push(`🤖  <i>Betting Analysis Squad</i>`);
    await send(lines.join('\n'));
    return;
  }

  // ── Ranking ──────────────────────────────────────────────────
  lines.push(`📊  <b>RANKING</b>`, SEP_LIGHT);

  const medals = ['🥇', '🥈', '🥉'];

  for (let i = 0; i < dash.ranking.length; i++) {
    const r       = dash.ranking[i];
    const pos     = medals[i] || `${i + 1}°`;
    const acc     = r.accuracy !== null ? `${r.accuracy}%` : '—';
    const acc7d   = r.acc7d    !== null ? `  📆  ${r.acc7d}% (7d)` : '';
    const trend   = r.trend.arrow !== '→'
      ? `  ${r.trend.delta > 0 ? '↗' : '↘'}  ${r.trend.label}`
      : '  →  Estável';
    const streakStr = r.streak.count >= 2
      ? `  ${r.streak.type === 'win' ? '🔥' : '❄️'}  ${r.streak.count}x`
      : '';

    lines.push(`${pos}  ${r.icon}  <b>${r.market.padEnd(14)}</b>  ${r.grade.icon}  <b>${acc}</b>${acc7d}${trend}${streakStr}`);
    lines.push(`      ✅  ${r.acertos}   ❌  ${r.erros}   📝  ${r.total} predições   📚  ${r.licoes} lição(ões)`);
    lines.push(BR);
  }

  // Agentes sem dados
  if (dash.semDados.length) {
    lines.push(SEP_LIGHT);
    lines.push(`⚪  <i>Sem dados ainda :  ${dash.semDados.map((a) => `${a.icon} ${a.market}`).join('  ·  ')}</i>`);
    lines.push(BR);
  }

  // ── Destaques ─────────────────────────────────────────────────
  const hasDestaques = dash.bestStreak || dash.alertStreak || dash.bestTrend;
  if (hasDestaques) {
    lines.push(SEP_LIGHT, `⚡  <b>DESTAQUES</b>`);
    if (dash.bestStreak) {
      lines.push(`🔥  Sequência positiva :  ${dash.bestStreak.icon}  ${dash.bestStreak.market}  (${dash.bestStreak.streak.count} acertos seguidos)`);
    }
    if (dash.bestTrend) {
      lines.push(`📈  Melhorando :  ${dash.bestTrend.icon}  ${dash.bestTrend.market}  (${dash.bestTrend.trend.label} nas últimas 10)`);
    }
    if (dash.alertStreak) {
      lines.push(`⚠️  Atenção :  ${dash.alertStreak.icon}  ${dash.alertStreak.market}  (${dash.alertStreak.streak.count} erros seguidos)`);
    }
    lines.push(BR);
  }

  // ── Totais ────────────────────────────────────────────────────
  lines.push(SEP_HEAVY);
  lines.push(`🧠  <b>TOTAL :  ${dash.globalTotal} predições  ·  ${dash.globalAcertos} acertos  ·  ${dash.globalAcc !== null ? dash.globalAcc + '%' : '—'}</b>`);
  lines.push(BR);

  // ── Legenda de notas ──────────────────────────────────────────
  lines.push(SEP_LIGHT);
  lines.push(`📖  <b>Notas de Calibração</b>`);
  lines.push(`🟢 A+/A — Excelente  ·  🟡 B — Aceitável  ·  🟠 C — Superestimando  ·  🔴 D — Crítico`);
  lines.push(BR);
  lines.push(`🤖  <i>Atualizado :  ${dash.updatedAt}  ·  Betting Analysis Squad</i>`);

  await send(lines.join('\n'));
}

// Mini-update inline após auto-treino — exibe só o agente atualizado
export async function notifyAgentMiniUpdate(report, matchName) {
  if (!isConfigured() || !report) return;

  const acc     = report.accuracy !== null ? `${report.accuracy}%` : '—';
  const trend   = report.trend.arrow;
  const streak  = report.streak.count >= 2
    ? `  ${report.streak.type === 'win' ? '🔥' : '❄️'}  ${report.streak.count}x`
    : '';

  const lines = [
    `🎓  <b>ANALISTA ATUALIZADO  —  Auto-Treino</b>`,
    SEP_LIGHT,
    BR,
    `⚽  <b>${matchName}</b>`,
    BR,
    `${report.icon}  <b>${report.market}</b>`,
    `     📊  Acurácia :  <b>${acc}</b>   ${trend}${streak}`,
    `     ${report.grade.icon}  Nota :  <b>${report.grade.grade}</b>  —  ${report.grade.desc}`,
    `     📝  ${report.total} predições   ✅  ${report.acertos}   ❌  ${report.erros}`,
    report.licoes > 0 ? `     📚  ${report.licoes} lição(ões) ativa(s)` : '',
    BR,
    `<i>Use  /performance  para ver o ranking completo.</i>`,
  ];

  await send(lines.filter(Boolean).join('\n'));
}

// ─────────────────────────────────────────────────────────────
// FUNIL PRÉ-LIVE — alerta de oportunidade pré-jogo
// ─────────────────────────────────────────────────────────────

export async function notifyPreLiveOpportunity(matchData, markets) {
  if (!isConfigured() || !markets?.length) return;

  const hora = matchData.date
    ? new Date(matchData.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '—';

  const lines = [
    `🟢  <b>PRÉ-LIVE</b>`,
    SEP_HEAVY,
    `⚽  <b>${matchData.match}</b>`,
    `🏆  ${matchData.competition || '—'}  ·  ⏰  ${hora}`,
    BR,
    SEP_LIGHT,
    `<b>🎯  OPORTUNIDADES PRÉ-JOGO</b>`,
    BR,
  ];

  for (const m of markets) {
    const risk = _calcRisk(m.probabilidade, m.confianca);

    // ── Nome do mercado com direção clara ─────────────────────────────────
    const rawMarket = m.market || m.mercado || '—';
    const rec       = String(m.recomendacao || '').toUpperCase();

    let marketLabel;
    if (rawMarket === 'Ambas Marcam' || rawMarket === 'BTTS') {
      // BTTS: sempre mostrar SIM/NÃO explicitamente
      const dir = (rec === 'SIM' || rec === 'APOSTAR') ? 'SIM ✔' : rec === 'NÃO' ? 'NÃO ✘' : rec;
      marketLabel = `Ambas Marcam: <b>${dir}</b>`;
    } else if (/^YC\s*([\d.]+)$/i.test(rawMarket)) {
      // Cartões Amarelos: "YC 2.5" → "🟨 Cartões Amarelos  Over 2.5"
      const linha = rawMarket.match(/[\d.]+/)?.[0] || '';
      const dir   = (rec === 'UNDER' || rec === 'NÃO') ? 'Under' : 'Over';
      marketLabel = `🟨 Cartões Amarelos:  <b>${dir} ${linha}</b>`;
    } else if (/^(over|under)\s*[\d.]+\s*(corners?|escanteios?)/i.test(rawMarket) ||
               /corners?\s*(over|under)/i.test(rawMarket) ||
               /^over corners\s*[\d.]+$/i.test(rawMarket)) {
      // Escanteios
      const linha = rawMarket.match(/[\d.]+/)?.[0] || '';
      const dir   = /under/i.test(rawMarket) ? 'Under' : 'Over';
      marketLabel = `⛳ Escanteios:  <b>${dir} ${linha}</b>`;
    } else if (/^(over|under)\s*[\d.]+/i.test(rawMarket)) {
      // Over/Under de gols — inclui direção explícita
      const linha = rawMarket.match(/[\d.]+/)?.[0] || '';
      const dir   = /^under/i.test(rawMarket) ? 'Under' : 'Over';
      marketLabel = `🥅 Gols:  <b>${dir} ${linha}</b>`;
    } else {
      marketLabel = `<b>${rawMarket}</b>`;
    }

    const recIcon = (rec === 'APOSTAR' || rec === 'SIM') ? '✅' : '⚡';
    const oddsStr = m.odds_minima ? `  |  Odds mín: <b>${m.odds_minima}</b>` : '';

    lines.push(`${recIcon}  ${marketLabel}   ${risk.icon} ${risk.label}`);
    lines.push(`     📊 Prob: <b>${m.probabilidade}%</b>   🔒 Conf: <b>${m.confianca}%</b>${oddsStr}`);
    if (m.justificativa || m.contexto) {
      lines.push(`     <i>${(m.justificativa || m.contexto).substring(0, 120)}</i>`);
    }
    lines.push(BR);
  }

  lines.push(_buildLegenda(markets));
  lines.push(SEP_LIGHT);
  lines.push(_houseLink('Superbet', matchData.competition || ''));
  lines.push(`🤖  <i>Betting Analysis Squad</i>`);

  // Chave estável: match + mercados + recomendações (ignora horário dinâmico do rodapé)
  const dedupKeyPre = `prelive|${matchData.match}|${markets.map((m) => `${m.market || m.mercado}:${m.recomendacao}`).join(',')}`;
  await send(lines.join('\n'), { dedupKey: dedupKeyPre, dedupWindowMs: DEDUP_WINDOW_LIVE_MS });
}

// ─────────────────────────────────────────────────────────────
// FUNIL LIVE 2T — alerta de oportunidade no 2° Tempo
// ─────────────────────────────────────────────────────────────

export async function notifyLive2TOpportunity(liveData, markets) {
  if (!isConfigured() || !markets?.length) return;

  const minLabel  = liveData.minuto_label ?? liveData.minuto ?? '?';
  const placar    = liveData.placar || '?-?';
  const restStr   = liveData.minutos_restantes != null ? `  ~${liveData.minutos_restantes}' rest.` : '';
  const min2T     = typeof liveData.minuto === 'number' ? Math.max(0, liveData.minuto - 45) : '?';

  const lines = [
    `🔴  <b>AO VIVO  ·  2° TEMPO</b>`,
    SEP_HEAVY,
    `⚽  <b>${liveData.match}</b>`,
    liveData.competition ? `🏆  ${liveData.competition}  ·  ⏱  ${minLabel}'` : `⏱  ${minLabel}'`,
    `🔵  Placar atual:  <b>${placar}</b>${restStr}`,
  ];

  if (liveData.xg_home != null && liveData.xg_away != null) {
    lines.push(`📊  xG: <b>${liveData.xg_home}</b> – <b>${liveData.xg_away}</b>`);
  }

  const ls = liveData.live_stats;
  if (ls?.chutes_alvo_casa != null) {
    lines.push(`🎯  Chutes no alvo: <b>${ls.chutes_alvo_casa}</b> – <b>${ls.chutes_alvo_fora}</b>`);
  }
  if (ls?.posse_casa != null) {
    lines.push(`⚽  Posse: <b>${ls.posse_casa}%</b> – <b>${ls.posse_fora}%</b>`);
  }

  lines.push(BR, SEP_LIGHT, `<b>🎯  OPORTUNIDADES 2° TEMPO</b>`, BR);

  for (const m of markets) {
    const risk    = _calcRisk(m.probabilidade, m.confianca);
    const recIcon = m.recomendacao === 'APOSTAR' ? '✅' : '⚡';
    const oddsStr = m.odds_minima ? `  |  Odds min: <b>${m.odds_minima}</b>` : '';
    lines.push(`${recIcon}  <b>${m.mercado}</b>   ${risk.icon} ${risk.label}`);
    lines.push(`     📊 ${m.probabilidade}%   🔒 ${m.confianca}%${oddsStr}`);
    if (m.justificativa) {
      lines.push(`     <i>${m.justificativa}</i>`);
    }
    lines.push(BR);
  }

  lines.push(_buildLegenda(markets));
  lines.push(SEP_LIGHT);
  lines.push(_houseLink('Superbet', liveData.competition || ''));
  lines.push(`🤖  <i>Betting Analysis Squad</i>`);

  // Chave estável: match + placar — se o placar mudar, deleta antiga e envia nova
  const dedupKey2T = `live_jogo|${liveData.match}|${placar}`;
  await send(lines.join('\n'), { dedupKey: dedupKey2T, dedupWindowMs: DEDUP_WINDOW_LIVE_MS });
}

// ─────────────────────────────────────────────────────────────
// LIVE IN-PLAY — alerta de oportunidade em jogo ao vivo
// ─────────────────────────────────────────────────────────────

export async function notifyLiveOpportunity(liveData, markets) {
  if (!isConfigured() || !markets?.length) return;

  const minLabel = liveData.minuto_label ?? liveData.minuto ?? '?';
  const placar   = liveData.placar || '?-?';
  const periodo  = (liveData.periodo || '').toLowerCase();
  const restStr  = liveData.minutos_restantes != null ? `  ~${liveData.minutos_restantes}' rest.` : '';
  const periodoLabel = periodo.includes('halftime') ? '⏸ Intervalo'
    : periodo.includes('2nd') || periodo.includes('second') ? `${minLabel}' 2T${restStr}`
    : `${minLabel}'${restStr}`;

  const lines = [
    `🔴  <b>AO VIVO  ·  2° TEMPO</b>`,
    SEP_HEAVY,
    `⚽  <b>${liveData.match}</b>`,
    liveData.competition ? `🏆  ${liveData.competition}  ·  ⏱  ${periodoLabel}` : `⏱  ${periodoLabel}`,
    `🔵  Placar atual:  <b>${placar}</b>`,
  ];

  // xG
  if (liveData.xg_home != null && liveData.xg_away != null) {
    lines.push(`📊  xG: <b>${liveData.xg_home}</b> – <b>${liveData.xg_away}</b>`);
  }

  // Estatísticas ao vivo (resumo)
  const ls = liveData.live_stats;
  if (ls?.chutes_alvo_casa != null) {
    lines.push(`🎯  Chutes no alvo: <b>${ls.chutes_alvo_casa}</b> – <b>${ls.chutes_alvo_fora}</b>`);
  }
  if (ls?.posse_casa != null) {
    lines.push(`⚽  Posse: <b>${ls.posse_casa}%</b> – <b>${ls.posse_fora}%</b>`);
  }

  lines.push(BR, SEP_LIGHT, `<b>🎯  OPORTUNIDADES DETECTADAS</b>`, BR);

  for (const m of markets) {
    const risk   = _calcRisk(m.probabilidade, m.confianca);
    const recIcon = m.recomendacao === 'APOSTAR' ? '✅' : '⚡';
    const oddsStr = m.odds_minima ? `  |  Odds min: <b>${m.odds_minima}</b>` : '';
    lines.push(`${recIcon}  <b>${m.mercado}</b>   ${risk.icon} ${risk.label}`);
    lines.push(`     📊 ${m.probabilidade}%   🔒 ${m.confianca}%${oddsStr}`);
    if (m.justificativa) {
      lines.push(`     <i>${m.justificativa}</i>`);
    }
    lines.push(BR);
  }

  lines.push(_buildLegenda(markets));
  lines.push(SEP_LIGHT);
  lines.push(_houseLink('Superbet', liveData.competition || ''));
  lines.push(`🤖  <i>Betting Analysis Squad</i>`);

  // Chave no nível do jogo: qualquer funil que notifique esse match+placar será bloqueado como duplicata
  const dedupKeyLive = `live_jogo|${liveData.match}|${placar}`;
  await send(lines.join('\n'), { dedupKey: dedupKeyLive, dedupWindowMs: DEDUP_WINDOW_LIVE_MS });
}

// Resumo de scan live (quantos jogos / oportunidades)
export async function notifyLiveScanSummary(totalJogos, totalOportunidades, analiseMs) {
  if (!isConfigured()) return;
  const durStr = analiseMs > 60000
    ? `${Math.round(analiseMs / 60000)}min`
    : `${Math.round(analiseMs / 1000)}s`;
  await send([
    `🔴  <b>SCAN LIVE CONCLUÍDO</b>`,
    SEP_LIGHT,
    `📡  Jogos ao vivo analisados: <b>${totalJogos}</b>`,
    `🎯  Oportunidades encontradas: <b>${totalOportunidades}</b>`,
    `⏱  Tempo de análise: ${durStr}`,
    BR,
    `<i>Próxima verificação: ${Math.round((parseInt(process.env.LIVE_SCAN_INTERVAL_MINUTES || '10')))}min  ·  Use /live-grade para ver os jogos</i>`,
  ].join('\n'));
}

// ─────────────────────────────────────────────────────────────
// UTILITÁRIO — obter ID do grupo
// ─────────────────────────────────────────────────────────────
export async function getGroupId() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error('TELEGRAM_BOT_TOKEN não configurado'); return; }
  try {
    const res     = await axios.get(`${BASE}/bot${token}/getUpdates`);
    const updates = res.data?.result || [];
    if (!updates.length) {
      console.log('Nenhuma mensagem recente. Envie uma mensagem no grupo e tente novamente.');
      return;
    }
    const groups = updates.filter((u) => u.message?.chat?.type?.includes('group'));
    if (!groups.length) {
      console.log('Nenhum grupo encontrado. Certifique-se de que o bot foi adicionado e enviou mensagem.');
      return;
    }
    for (const u of groups) {
      console.log(`Grupo : "${u.message.chat.title}"  →  ID : ${u.message.chat.id}`);
    }
  } catch (err) {
    console.error('Erro ao buscar updates :', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 🔑 GEMINI KEY MANAGER — Processo interno (sem envio ao Telegram)
// ─────────────────────────────────────────────────────────────
export async function notifyGeminiKeyAlert(msg) {
  // Processo interno — apenas log local, nunca enviado ao usuário
  console.log(`[GeminiKeyAlert] ${msg}`);
}

// ─────────────────────────────────────────────────────────────
// RELATÓRIO DIÁRIO — GREEN/RED + resumo de saldo
// ─────────────────────────────────────────────────────────────
/**
 * @param {Array} resolved  Entradas resolvidas do dia (de pending-analyses.json)
 */
export async function notifyDailyReport(resolved = []) {
  if (!isConfigured()) return;

  const today  = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const greens = resolved.filter(e => e.acertou === true);
  const reds   = resolved.filter(e => e.acertou === false);
  const total  = greens.length + reds.length;
  const taxa   = total > 0 ? ((greens.length / total) * 100).toFixed(0) : '—';

  // Saldo estimado (1.5u por aposta, odds média da entrada ou 1.75 padrão)
  let saldo = 0;
  for (const e of resolved) {
    const stake = 1.5;
    if (e.acertou === true)  saldo += stake * ((e.odds ?? 1.75) - 1);
    if (e.acertou === false) saldo -= stake;
  }
  const saldoIcon = saldo >= 0 ? '📈' : '📉';
  const saldoStr  = saldo >= 0 ? `+${saldo.toFixed(1)}u` : `${saldo.toFixed(1)}u`;

  // Agrupamento por mercado
  const porMercado = {};
  for (const e of resolved) {
    const m = e.market || 'Outro';
    if (!porMercado[m]) porMercado[m] = { g: 0, r: 0, odds: [] };
    if (e.acertou) porMercado[m].g++; else porMercado[m].r++;
    if (e.odds) porMercado[m].odds.push(e.odds);
  }

  const lines = [
    `📊  <b>RELATÓRIO DO DIA  —  ${today}</b>`,
    SEP_HEAVY,
    BR,
  ];

  if (total === 0) {
    lines.push(`<i>Nenhum resultado fechado hoje.</i>`);
  } else {
    lines.push(
      `✅  GREEN :  <b>${greens.length}</b>      ❌  RED :  <b>${reds.length}</b>`,
      `🎯  Taxa de acerto :  <b>${taxa}%</b>  (${total} resultado${total !== 1 ? 's' : ''})`,
      `${saldoIcon}  Saldo estimado :  <b>${saldoStr}</b>`,
      BR,
      `<b>Por mercado :</b>`,
    );

    for (const [mkt, v] of Object.entries(porMercado)) {
      const t = v.g + v.r;
      const p = ((v.g / t) * 100).toFixed(0);
      lines.push(`  📌  ${mkt}  :  ${v.g} ✅  ${v.r} ❌  (${p}%)`);
    }
  }

  lines.push(BR, SEP_HEAVY);
  lines.push(`🤖  <i>Betting Analysis Squad  ·  ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</i>`);

  await send(lines.join('\n'));
}

// ═════════════════════════════════════════════════════════════════
// 🎯 ARIEL — Placar Exato · Vitória com Margem · Dupla Chance
// Formato: top-3 CS + melhor DC + placar mais provável
// ═════════════════════════════════════════════════════════════════
export async function notifyScorePredictions(scoreData, matchData = {}, opts = {}) {
  if (!isConfigured() || !scoreData) return;

  const comp    = matchData.competition || opts.competition || 'N/A';
  const hora    = matchData.date ? formatTime(matchData.date) : (matchData.match_time || '—');
  const [homeRaw, awayRaw] = (matchData.match || scoreData.match || '').split(' vs ');
  const homeStr = homeRaw?.trim() || 'Casa';
  const awayStr = awayRaw?.trim() || 'Fora';

  const exactScores  = scoreData.exact_scores  || {};
  const victory      = scoreData.victory_depth  || {};
  const dc           = scoreData.double_chance_bets || {};
  const topScores    = exactScores.top_scores  || [];
  const valueBets    = exactScores.value_bets  || [];
  const dcValueBets  = dc.value_bets || [];

  // Emojis de tendência
  const domEmoji = victory.dominant === 'home' ? '🏠' : victory.dominant === 'away' ? '✈️' : '⚖️';
  const confEmoji = { FORTE: '🔥', MODERADA: '⚡', FRACA: '⚠️', INCERTO: '❓' };

  const lines = [
    `<b>🎯  ARIEL — ANÁLISE CIRÚRGICA</b>`,
    `<b>🏆  ${comp.toUpperCase()}</b>`,
    `<b>⚽️  ${homeStr}  vs  ${awayStr}</b>`,
    `<b>⏰  ${hora}</b>`,
    BR,
    SEP_HEAVY,
    BR,
  ];

  // ── Placar Exato ──
  lines.push(`<b>📊  PLACAR EXATO — Top Probabilidades</b>`);
  const displayScores = topScores.slice(0, 5);
  for (const s of displayScores) {
    const valueTag = s.is_value ? `  🎯 EV ${s.ev_pct}` : '';
    const marker   = s.is_value ? '→' : '·';
    lines.push(`  ${marker}  <b>${s.label}</b>  ${s.prob_pct}${valueTag}`);
  }

  if (valueBets.length > 0) {
    const best = valueBets[0];
    lines.push(BR);
    lines.push(`💡  <b>CS Value Bet:</b>  ${best.label}  @  odds necessária`);
    lines.push(`    Prob real: ${best.prob_pct}  ·  EV: ${best.ev_pct}`);
  }

  lines.push(BR, `<b>━━━━━━━</b>`, BR);

  // ── Vitória com Margem ──
  lines.push(`<b>${domEmoji}  VITÓRIA COM MARGEM</b>`);
  const wConf  = victory.win_confidence || 'INCERTO';
  const wEmoji = confEmoji[wConf] || '❓';
  lines.push(`  Tendência:  <b>${(victory.dominant || 'equilibrio').toUpperCase()}</b>  ${wEmoji} ${wConf}`);
  lines.push(`  Placar mais provável:  <b>${victory.most_likely_score || '—'}</b>`);

  if (victory.dominant === 'home' && victory.home_margins) {
    const hm = victory.home_margins;
    lines.push(`  Casa +1:  ${pct(hm.by_1)}  ·  +2:  ${pct(hm.by_2)}  ·  +3:  ${pct(hm.by_3plus)}`);
  } else if (victory.dominant === 'away' && victory.away_margins) {
    const am = victory.away_margins;
    lines.push(`  Fora +1:  ${pct(am.by_1)}  ·  +2:  ${pct(am.by_2)}  ·  +3:  ${pct(am.by_3plus)}`);
  }

  lines.push(BR, `<b>━━━━━━━</b>`, BR);

  // ── Dupla Chance ──
  lines.push(`<b>🔀  DUPLA CHANCE</b>`);
  const dcMarkets = dc.markets || [];
  for (const m of dcMarkets) {
    const oddsStr = m.best_odds ? `  @  ${String(m.best_odds).replace('.', ',')}` : '';
    const evStr   = m.ev_pct   ? `  EV ${m.ev_pct}` : '';
    const vTag    = m.is_value ? '  ✅' : '';
    lines.push(`  ${m.rating}  <b>${m.market}</b>${oddsStr}  —  ${m.prob_pct}${evStr}${vTag}`);
  }

  if (dcValueBets.length > 0) {
    lines.push(BR);
    lines.push(`💡  <b>DC Value:</b>  ${dcValueBets[0].market}  (${dcValueBets[0].prob_pct})`);
  }

  lines.push(BR, SEP_HEAVY);
  lines.push(_houseLink('Superbet', comp, opts.directUrl || null));
  lines.push(`🤖  <i>Ariel · Betting Analysis Squad</i>`);

  return await send(lines.join('\n'));
}

function pct(val) {
  if (val == null) return 'N/A';
  return `${(val * 100).toFixed(1)}%`;
}

// ─────────────────────────────────────────────────────────────
// RELATÓRIO DIÁRIO PRIVADO — DM ao admin às 21:30
// ─────────────────────────────────────────────────────────────

/**
 * Envia resumo privado do dia ao admin via DM.
 * Inclui: sinais enviados, GREEN/RED do dia, engajamento e alerta de mercado.
 *
 * @param {object} opts
 * @param {object}  opts.pieStats      — resultado de getStats() do pie-storage
 * @param {object}  opts.calibration   — db.calibration do pie
 * @param {object}  opts.engStats      — resultado de getOverallStats({ daysBack: 1 })
 * @param {Array}   [opts.snapshots]   — últimos 2 snapshots para calcular delta
 */
export async function notifyAdminDailySummary({ pieStats, calibration = {}, engStats, snapshots = [] }) {
  const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  if (!adminId || !token) return;

  const hoje = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: '2-digit',
  });

  // Delta da taxa global (hoje vs ontem)
  let deltaTaxa = '';
  if (snapshots.length >= 2) {
    const d = (snapshots[0].globalRate - snapshots[1].globalRate).toFixed(1);
    deltaTaxa = d > 0 ? ` (📈 +${d}pp vs ontem)` : d < 0 ? ` (📉 ${d}pp vs ontem)` : '';
  }

  // Top 3 mercados com melhor accuracy hoje
  const topMkt = Object.entries(calibration)
    .filter(([, v]) => v.total >= 20)
    .map(([m, v]) => ({ m, acc: Math.round(v.hits / v.total * 100), total: v.total }))
    .sort((a, b) => b.acc - a.acc)
    .slice(0, 3)
    .map(x => `  • <b>${x.m}</b>: ${x.acc}% (${x.total} amostras)`)
    .join('\n');

  // Mercado que mais piorou (se houver delta de snapshots)
  let alertaMkt = '';
  if (snapshots.length >= 2) {
    const prev = snapshots[1].markets || {};
    const curr = snapshots[0].markets || {};
    let piorDelta = 0;
    let piorMkt   = '';
    for (const [m, d] of Object.entries(curr)) {
      const delta = d.acc - (prev[m]?.acc ?? d.acc);
      if (delta < piorDelta) { piorDelta = delta; piorMkt = m; }
    }
    if (piorMkt) alertaMkt = `\n⚠️ <b>Queda:</b> <b>${piorMkt}</b> −${Math.abs(piorDelta).toFixed(1)}pp em relação ao dia anterior`;
  }

  // Sinais do dia — lê pending-analyses do dia de hoje
  const todayStr = new Date().toISOString().slice(0, 10);
  let sinaisHoje = 0, greensHoje = 0, redsHoje = 0;
  try {
    const all          = _loadPendingDb();
    const hojeEntries  = all.filter(e => (e.sentAt || '').startsWith(todayStr));
    sinaisHoje = hojeEntries.length;
    greensHoje = hojeEntries.filter(e => e.acertou === true).length;
    redsHoje   = hojeEntries.filter(e => e.acertou === false).length;
  } catch {}

  const taxaHoje = (greensHoje + redsHoje) > 0
    ? `${Math.round(greensHoje / (greensHoje + redsHoje) * 100)}%`
    : '—';

  const text = [
    `📋 <b>RESUMO DO DIA — ${hoje.toUpperCase()}</b>`,
    `<b>━━━━━━━━━━━━━━━━</b>`,
    ``,
    `📡 <b>Sinais enviados:</b> ${sinaisHoje}`,
    `✅ <b>GREEN:</b> ${greensHoje}  |  ❌ <b>RED:</b> ${redsHoje}  |  📈 <b>Taxa:</b> ${taxaHoje}`,
    ``,
    `<b>━━━━━━━━━━━━━━━━</b>`,
    `🧠 <b>PIE — Taxa Global:</b> ${pieStats?.taxaAcerto ?? '—'}%${deltaTaxa}`,
    topMkt ? `\n🏆 <b>Top Mercados:</b>\n${topMkt}` : '',
    alertaMkt,
    ``,
    `<b>━━━━━━━━━━━━━━━━</b>`,
    `📱 <b>Engajamento (hoje):</b>`,
    `  🔗 Cliques: ${engStats?.totalClicks ?? 0}  |  💬 Reações: ${engStats?.totalReactions ?? 0}`,
    `  📈 Taxa de clique: ${engStats?.clickRate ?? '0.0'}%`,
    ``,
    `<i>Relatório automático · Betting Analysis Squad</i>`,
  ].filter(l => l !== undefined).join('\n');

  try {
    await axios.post(`${BASE}/bot${token}/sendMessage`, {
      chat_id:    adminId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch { /* silencioso */ }
}
