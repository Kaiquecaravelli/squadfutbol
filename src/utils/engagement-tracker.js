/**
 * engagement-tracker.js — Rastreamento de Engajamento dos Membros
 *
 * Registra, por sinal enviado:
 *   • Quem clicou no link da casa de apostas (e quando)
 *   • Quais membros reagiram com emoji
 *   • Taxa de clique por sinal e por membro
 *
 * Limitação do Telegram: não há read receipts em grupos.
 * "Aberto" é aproximado por click no botão ou reação.
 *
 * Persistência: data/engagement.json
 *
 * Estrutura:
 * {
 *   signals: {
 *     [signalId]: {
 *       match, market, sentAt, msgId, linkUrl,
 *       clicks: [{ userId, firstName, username, clickedAt }],
 *       reactions: [{ userId, firstName, emoji, reactedAt }]
 *     }
 *   },
 *   members: {
 *     [userId]: { firstName, username, totalClicks, totalReactions, lastSeen }
 *   }
 * }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname }                           from 'path';
import { fileURLToPath }                           from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '../..');
const DB    = join(ROOT, 'data/engagement.json');

mkdirSync(join(ROOT, 'data'), { recursive: true });

// ── Persistência ──────────────────────────────────────────────────────────────
function _load() {
  try { return JSON.parse(readFileSync(DB, 'utf-8')); }
  catch { return { signals: {}, members: {} }; }
}

function _save(data) {
  try { writeFileSync(DB, JSON.stringify(data, null, 2)); } catch {}
}

// ── Registro de sinal enviado ─────────────────────────────────────────────────
/**
 * Registra um sinal recém-enviado para rastreamento.
 * Deve ser chamado logo após o send() retornar o msgId.
 */
export function trackSignalSent({ signalId, match, market, msgId, linkUrl, competition = '' }) {
  if (!signalId) return;
  const db = _load();
  if (!db.signals) db.signals = {};
  db.signals[signalId] = {
    match,
    market,
    competition,
    msgId,
    linkUrl,
    sentAt:    new Date().toISOString(),
    clicks:    [],
    reactions: [],
  };
  _save(db);
}

// ── Registro de clique no link ────────────────────────────────────────────────
/**
 * Chamado quando o membro toca no botão "Apostar agora → Superbet".
 * Retorna a URL associada ao sinal (para o answerCallbackQuery).
 */
export function trackLinkClick({ signalId, userId, firstName = '', username = '' }) {
  const db  = _load();
  if (!db.signals) db.signals = {};
  if (!db.members) db.members = {};

  const sig = db.signals[signalId];
  if (!sig) return null;

  const now = new Date().toISOString();
  const uid = String(userId);

  // Evita duplicata do mesmo usuário no mesmo sinal
  const alreadyClicked = sig.clicks.some(c => String(c.userId) === uid);
  if (!alreadyClicked) {
    sig.clicks.push({ userId: uid, firstName, username, clickedAt: now });
  }

  // Atualiza perfil do membro
  if (!db.members[uid]) {
    db.members[uid] = { firstName, username, totalClicks: 0, totalReactions: 0, lastSeen: now };
  }
  db.members[uid].firstName      = firstName || db.members[uid].firstName;
  db.members[uid].username       = username  || db.members[uid].username;
  db.members[uid].lastSeen       = now;
  if (!alreadyClicked) db.members[uid].totalClicks++;

  _save(db);
  return sig.linkUrl || null;
}

// ── Registro de reação ────────────────────────────────────────────────────────
/**
 * Chamado quando um membro reage a uma mensagem do bot.
 * msgId é usado para encontrar o sinal correspondente.
 */
export function trackReaction({ msgId, userId, firstName = '', username = '', emoji = '' }) {
  const db  = _load();
  if (!db.signals) db.signals = {};
  if (!db.members) db.members = {};

  // Encontra sinal pelo msgId
  const signalId = Object.keys(db.signals).find(id => db.signals[id].msgId === msgId);
  if (!signalId) return;

  const sig = db.signals[signalId];
  const now = new Date().toISOString();
  const uid = String(userId);

  const alreadyReacted = sig.reactions.some(r => String(r.userId) === uid && r.emoji === emoji);
  if (!alreadyReacted) {
    sig.reactions.push({ userId: uid, firstName, username, emoji, reactedAt: now });
  }

  // Atualiza perfil do membro
  if (!db.members[uid]) {
    db.members[uid] = { firstName, username, totalClicks: 0, totalReactions: 0, lastSeen: now };
  }
  db.members[uid].firstName = firstName || db.members[uid].firstName;
  db.members[uid].username  = username  || db.members[uid].username;
  db.members[uid].lastSeen  = now;
  if (!alreadyReacted) db.members[uid].totalReactions++;

  _save(db);
}

// ── Consultas de estatísticas ─────────────────────────────────────────────────
/**
 * Retorna stats de um sinal específico.
 */
export function getSignalStats(signalId) {
  const db  = _load();
  const sig = db.signals?.[signalId];
  if (!sig) return null;
  return {
    signalId,
    match:        sig.match,
    market:       sig.market,
    sentAt:       sig.sentAt,
    clicks:       sig.clicks.length,
    reactions:    sig.reactions.length,
    clickers:     sig.clicks,
    reactors:     sig.reactions,
  };
}

/**
 * Retorna URL do link de uma análise (para answerCallbackQuery).
 */
export function getSignalUrl(signalId) {
  const db = _load();
  return db.signals?.[signalId]?.linkUrl || null;
}

/**
 * Retorna estatísticas gerais de engajamento — para o comando /stats.
 * Inclui: sinais enviados, total de cliques, top membros, taxa de clique.
 */
export function getOverallStats({ daysBack = 7 } = {}) {
  const db      = _load();
  const cutoff  = Date.now() - daysBack * 86_400_000;
  const signals = Object.values(db.signals || {})
    .filter(s => new Date(s.sentAt).getTime() > cutoff);

  const totalSignals   = signals.length;
  const totalClicks    = signals.reduce((a, s) => a + s.clicks.length, 0);
  const totalReactions = signals.reduce((a, s) => a + s.reactions.length, 0);
  const clickRate      = totalSignals > 0
    ? ((totalClicks / totalSignals) * 100).toFixed(1)
    : '0.0';

  // Top membros por cliques
  const memberMap = {};
  for (const sig of signals) {
    for (const c of sig.clicks) {
      const uid = String(c.userId);
      if (!memberMap[uid]) memberMap[uid] = { firstName: c.firstName, username: c.username, clicks: 0, reactions: 0 };
      memberMap[uid].clicks++;
    }
    for (const r of sig.reactions) {
      const uid = String(r.userId);
      if (!memberMap[uid]) memberMap[uid] = { firstName: r.firstName, username: r.username, clicks: 0, reactions: 0 };
      memberMap[uid].reactions++;
    }
  }

  const topMembers = Object.entries(memberMap)
    .sort(([, a], [, b]) => (b.clicks + b.reactions) - (a.clicks + a.reactions))
    .slice(0, 10)
    .map(([uid, m]) => ({ userId: uid, ...m }));

  // Sinais com mais cliques
  const topSignals = [...signals]
    .sort((a, b) => b.clicks.length - a.clicks.length)
    .slice(0, 5)
    .map(s => ({
      match:    s.match,
      market:   s.market,
      clicks:   s.clicks.length,
      reactions: s.reactions.length,
      sentAt:   s.sentAt,
    }));

  return {
    period:       `${daysBack}d`,
    totalSignals,
    totalClicks,
    totalReactions,
    clickRate,
    topMembers,
    topSignals,
  };
}
