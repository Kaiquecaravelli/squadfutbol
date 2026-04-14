/**
 * group-guardian.js — Guardião do Grupo Squad Futbol
 *
 * Mecanismos de defesa:
 *
 *  1. APROVAÇÃO DE MEMBROS  — link com join request: ninguém entra sem aprovação do admin
 *  2. NOTIFICAÇÃO ADMIN     — bot envia mensagem privada ao admin com botões [✅ Aprovar] [❌ Recusar]
 *  3. CONTEÚDO PROTEGIDO    — proíbe forward, salvar, copiar mensagens e print (iOS/Android)
 *  4. COMANDOS DE ADMIN     — /proteger /lock /desbloquear /ban /kick /admins /status /myid /link
 *  5. MONITOR DE MEMBROS    — detecta bots e contas suspeitas ao entrar
 *  6. ANTI-FLOOD            — 5 mensagens/60s → silenciar 1h
 *  7. ANTI-LINK             — remove convites externos e links de spam
 *
 * SETUP (primeira vez):
 *   1. Envie uma mensagem privada ao bot (@seu_bot)
 *   2. O bot responde com seu Telegram User ID
 *   3. Adicione ao .env: TELEGRAM_ADMIN_USER_ID=<seu_id>
 *   4. Use /link no grupo para gerar o link de convite com aprovação obrigatória
 *   5. Substitua o link antigo do grupo por este novo
 *
 * Uso:
 *   import { initGroupGuardian } from './group-guardian.js';
 *   await initGroupGuardian();
 */

import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackLinkClick, trackReaction, getOverallStats, _loadEngagementDB } from './engagement-tracker.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '../..');
const DB    = join(ROOT, 'data/guardian.json');

const BASE  = 'https://api.telegram.org';
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const CHAT  = () => process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;

// ID do admin que recebe notificações de aprovação
// Pode ser definido via .env (TELEGRAM_ADMIN_USER_ID) ou via comando /setadmin
const ADMIN_NOTIFY_ID = () => process.env.TELEGRAM_ADMIN_USER_ID || _loadDB().adminUserId || null;

mkdirSync(join(ROOT, 'data'), { recursive: true });

// ── Persistência ──────────────────────────────────────────────────────────────
function _loadDB() {
  try { return JSON.parse(readFileSync(DB, 'utf-8')); }
  catch { return { bannedUsers: [], floodLog: {}, pendingRequests: {}, adminUserId: null, approvalLinkId: null }; }
}
function _saveDB(data) {
  try { writeFileSync(DB, JSON.stringify(data, null, 2)); } catch {}
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, body = {}) {
  try {
    const res = await axios.post(`${BASE}/bot${TOKEN()}/${method}`, body, { timeout: 10_000 });
    return res.data?.result ?? null;
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.warn(`[Guardian] API ${method}: ${e.message}`);
    return null;
  }
}

async function sendMsg(chatId, text, opts = {}) {
  return api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });
}

async function deleteMsg(chatId, msgId) {
  return api('deleteMessage', { chat_id: chatId, message_id: msgId });
}

async function banUser(chatId, userId) {
  return api('banChatMember', { chat_id: chatId, user_id: userId, revoke_messages: true });
}

async function kickUser(chatId, userId) {
  await api('banChatMember', { chat_id: chatId, user_id: userId });
  return api('unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true });
}

async function restrictUser(chatId, userId) {
  return api('restrictChatMember', {
    chat_id:     chatId,
    user_id:     userId,
    permissions: {
      can_send_messages: false, can_send_media_messages: false,
      can_send_polls: false, can_send_other_messages: false,
      can_add_web_page_previews: false, can_change_info: false,
      can_invite_users: false, can_pin_messages: false,
    },
    until_date: Math.floor(Date.now() / 1000) + 3600, // mudo por 1h
  });
}

// ── Verifica se usuário é admin ───────────────────────────────────────────────
const HARDCODED_ADMINS = new Set(
  (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

async function isAdmin(chatId, userId) {
  if (HARDCODED_ADMINS.has(String(userId))) return true;
  const adminNotifyId = ADMIN_NOTIFY_ID();
  if (adminNotifyId && String(userId) === String(adminNotifyId)) return true;
  const admins = await api('getChatAdministrators', { chat_id: chatId });
  if (!Array.isArray(admins)) return false;
  return admins.some(a => a.user?.id === userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LINK DE CONVITE COM APROVAÇÃO OBRIGATÓRIA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cria um link de convite onde o usuário faz um pedido de entrada
 * que precisa ser aprovado manualmente pelo admin.
 * Ninguém entra no grupo sem autorização.
 */
export async function createApprovalInviteLink(name = 'Squad Futbol — Acesso Controlado') {
  const chatId = CHAT();
  if (!chatId) return null;

  const link = await api('createChatInviteLink', {
    chat_id:              chatId,
    name,
    creates_join_request: true,   // ← chave: ativa aprovação manual obrigatória
  });

  if (link?.invite_link) {
    const db = _loadDB();
    db.approvalLinkId   = link.invite_link_id || null;
    db.approvalLink     = link.invite_link;
    db.approvalLinkName = name;
    db.approvalLinkAt   = new Date().toISOString();
    _saveDB(db);
    console.log(`[Guardian] 🔗 Link de aprovação criado: ${link.invite_link}`);
  }

  return link?.invite_link || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. HANDLER DE PEDIDOS DE ENTRADA (chat_join_request)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chamado quando um usuário solicita entrar no grupo via link de aprovação.
 * Envia notificação privada ao admin com botões Aprovar / Recusar.
 */
export async function handleJoinRequest(update) {
  const req = update?.chat_join_request;
  if (!req) return false;

  const chatId  = req.chat?.id;
  const user    = req.from;
  const userId  = user?.id;
  const fname   = user?.first_name || '';
  const lname   = user?.last_name  || '';
  const uname   = user?.username   ? `@${user.username}` : '(sem username)';
  const bio     = req.bio          || '';
  const date    = new Date(req.date * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const chatName = req.chat?.title || 'Squad Futbol';

  // Salva pedido pendente no DB
  const db = _loadDB();
  if (!db.pendingRequests) db.pendingRequests = {};
  db.pendingRequests[userId] = {
    userId,
    chatId,
    name:      `${fname} ${lname}`.trim(),
    username:  uname,
    requestedAt: new Date().toISOString(),
  };
  _saveDB(db);

  const adminId = ADMIN_NOTIFY_ID();
  if (!adminId) {
    console.warn('[Guardian] ⚠️  TELEGRAM_ADMIN_USER_ID não configurado — use /setadmin no bot');
    return true;
  }

  // Monta notificação para o admin com botões inline
  const text = [
    `🚪 <b>PEDIDO DE ENTRADA — ${chatName}</b>`,
    ``,
    `👤 <b>Nome:</b> ${fname} ${lname}`,
    `🔖 <b>Username:</b> ${uname}`,
    `🆔 <b>ID:</b> <code>${userId}</code>`,
    bio ? `📝 <b>Bio:</b> ${bio.slice(0, 120)}` : '',
    `🕐 <b>Horário:</b> ${date}`,
    ``,
    `Deseja <b>aprovar</b> ou <b>recusar</b> a entrada deste usuário?`,
  ].filter(Boolean).join('\n');

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ APROVAR', callback_data: `approve_${userId}_${chatId}` },
      { text: '❌ RECUSAR', callback_data: `decline_${userId}_${chatId}` },
    ]],
  };

  await sendMsg(adminId, text, { reply_markup: keyboard });

  console.log(`[Guardian] 📩 Pedido de entrada: ${fname} ${lname} (${uname}) — aguardando aprovação do admin`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. HANDLER DE CALLBACK (botões Aprovar / Recusar)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processa a resposta do admin ao tocar em Aprovar ou Recusar.
 */
export async function handleCallbackQuery(update) {
  const cb = update?.callback_query;
  if (!cb) return false;

  const data     = cb?.data || '';
  const adminId  = cb?.from?.id;
  const cbId     = cb?.id;

  // ── Rastreamento de clique no link do sinal ────────────────────────────────
  if (data.startsWith('link_')) {
    const signalId  = data.slice(5); // remove prefixo "link_"
    const clicker   = cb?.from;
    const url = trackLinkClick({
      signalId,
      userId:    clicker?.id,
      firstName: clicker?.first_name || '',
      username:  clicker?.username   ? `@${clicker.username}` : '',
    });
    // Abre a URL no dispositivo do usuário (sem mensagem de alerta)
    await api('answerCallbackQuery', {
      callback_query_id: cbId,
      url:               url || 'https://superbet.bet.br/apostas/futebol/hoje',
    });
    return true;
  }

  if (!data.startsWith('approve_') && !data.startsWith('decline_')) return false;

  // Valida que quem respondeu é o admin autorizado
  const expectedAdmin = ADMIN_NOTIFY_ID();
  if (expectedAdmin && String(adminId) !== String(expectedAdmin)) {
    await api('answerCallbackQuery', { callback_query_id: cbId, text: '⛔ Não autorizado.', show_alert: true });
    return true;
  }

  const [action, userId, chatId] = data.split('_');
  const db = _loadDB();
  const pending = db.pendingRequests?.[userId];
  const name    = pending?.name || `ID ${userId}`;

  if (action === 'approve') {
    const ok = await api('approveChatJoinRequest', { chat_id: chatId, user_id: userId });
    if (ok) {
      // Boas-vindas no grupo
      await sendMsg(chatId,
        `👋 <b>Bem-vindo(a) ao Squad Futbol, ${name}!</b>\n\n` +
        `✅ Acesso autorizado pelo administrador.\n` +
        `Aqui você acompanha sinais de análise esportiva em tempo real.\n\n` +
        `📌 <b>Regras:</b> Respeite o grupo. Zero spam. Zero links externos.`
      );
      // Confirma para o admin
      await api('editMessageReplyMarkup', {
        chat_id:      adminId,
        message_id:   cb.message?.message_id,
        reply_markup: { inline_keyboard: [[{ text: `✅ APROVADO — ${name}`, callback_data: 'done' }]] },
      });
      await api('answerCallbackQuery', { callback_query_id: cbId, text: `✅ ${name} aprovado!` });
      console.log(`[Guardian] ✅ Aprovado: ${name} (${userId})`);

      // Remove da fila de pendentes
      delete db.pendingRequests[userId];
      _saveDB(db);
    } else {
      await api('answerCallbackQuery', { callback_query_id: cbId, text: 'Erro ao aprovar. Tente novamente.', show_alert: true });
    }

  } else if (action === 'decline') {
    const ok = await api('declineChatJoinRequest', { chat_id: chatId, user_id: userId });
    if (ok) {
      await api('editMessageReplyMarkup', {
        chat_id:      adminId,
        message_id:   cb.message?.message_id,
        reply_markup: { inline_keyboard: [[{ text: `❌ RECUSADO — ${name}`, callback_data: 'done' }]] },
      });
      await api('answerCallbackQuery', { callback_query_id: cbId, text: `❌ ${name} recusado.` });
      console.log(`[Guardian] ❌ Recusado: ${name} (${userId})`);

      delete db.pendingRequests[userId];
      _saveDB(db);
    } else {
      await api('answerCallbackQuery', { callback_query_id: cbId, text: 'Erro ao recusar. Tente novamente.', show_alert: true });
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SETUP VIA DM — admin envia /start ou /myid ao bot em conversa privada
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quando o admin inicia conversa privada com o bot, salva o chat_id
 * automaticamente como destino das notificações de aprovação.
 */
export async function handlePrivateSetup(update) {
  const msg  = update?.message;
  if (!msg) return false;
  if (msg.chat?.type !== 'private') return false;

  const text   = msg?.text || '';
  const userId = msg?.from?.id;
  const chatId = msg?.chat?.id; // em DM, chat_id == user_id
  const fname  = msg?.from?.first_name || '';
  const uname  = msg?.from?.username ? `@${msg.from.username}` : '';

  // /myid — retorna o ID do usuário (qualquer um pode usar em DM)
  if (text.startsWith('/myid') || text.startsWith('/start')) {
    await sendMsg(chatId,
      `🆔 <b>Seu Telegram User ID:</b>\n\n` +
      `<code>${userId}</code>\n\n` +
      `Copie este número e adicione ao arquivo <code>.env</code>:\n` +
      `<code>TELEGRAM_ADMIN_USER_ID=${userId}</code>\n\n` +
      `Após configurar, você receberá notificações de aprovação de novos membros diretamente aqui.`
    );
    return true;
  }

  // /setadmin — salva este usuário como admin de notificações
  if (text.startsWith('/setadmin')) {
    const db = _loadDB();
    db.adminUserId = String(userId);
    _saveDB(db);

    // Atualiza .env em memória para a sessão atual
    process.env.TELEGRAM_ADMIN_USER_ID = String(userId);

    await sendMsg(chatId,
      `✅ <b>Admin de notificações configurado!</b>\n\n` +
      `👤 ${fname} ${uname}\n` +
      `🆔 ID: <code>${userId}</code>\n\n` +
      `A partir de agora você receberá <b>todos os pedidos de entrada</b> no grupo aqui neste chat.\n\n` +
      `Para gerar o link de convite com aprovação obrigatória, use <b>/link</b> no grupo.`
    );
    console.log(`[Guardian] 👑 Admin configurado: ${fname} (${userId})`);
    return true;
  }

  // /minha-stats — estatísticas pessoais de engajamento (qualquer membro pode usar em DM)
  if (text.startsWith('/minha-stats') || text.startsWith('/minhas-stats')) {
    try {
      const engDb  = _loadEngagementDB();
      const uid    = String(userId);
      const member = engDb.members?.[uid];

      // Conta sinais em que clicou e reagiu
      const signals    = Object.values(engDb.signals || {});
      const clicados   = signals.filter(s => s.clicks?.some(c => String(c.userId) === uid));
      const reagidos   = signals.filter(s => s.reactions?.some(r => String(r.userId) === uid));
      const totalSinais = signals.length;

      if (!member && !clicados.length) {
        await sendMsg(chatId,
          `📊 <b>Suas Estatísticas — Squad Futbol</b>\n\n` +
          `Ainda não detectamos nenhuma interação sua com nossos sinais.\n\n` +
          `💡 <b>Como interagir:</b>\n` +
          `  • Toque no botão <b>"Apostar agora → Superbet"</b> nos sinais enviados\n` +
          `  • Reaja com qualquer emoji às mensagens de análise\n\n` +
          `<i>Quanto mais você interage, melhor conseguimos calibrar o timing dos sinais para o seu perfil.</i>`
        );
        return true;
      }

      const taxa = totalSinais > 0
        ? `${Math.round((clicados.length / totalSinais) * 100)}%`
        : '—';

      // Últimos 3 sinais clicados
      const ultimos = clicados.slice(-3).reverse().map(s => {
        const d = new Date(s.sentAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const status = s.clicks.find(c => String(c.userId) === uid) ? '' : '';
        return `  • ${(s.match || '?').substring(0, 28)} <i>(${d})</i>`;
      }).join('\n');

      await sendMsg(chatId,
        `📊 <b>Suas Estatísticas — Squad Futbol</b>\n\n` +
        `👤 <b>${fname} ${uname}</b>\n\n` +
        `🔗 <b>Links clicados:</b> ${clicados.length} de ${totalSinais} sinais\n` +
        `💬 <b>Reações:</b> ${reagidos.length}\n` +
        `📈 <b>Sua taxa de engajamento:</b> ${taxa}\n\n` +
        (ultimos ? `🕐 <b>Últimos sinais que você acessou:</b>\n${ultimos}\n\n` : '') +
        `<i>Dados coletados automaticamente · Squad Futbol</i>`
      );
    } catch (e) {
      await sendMsg(chatId, `⚠️ Não foi possível carregar suas estatísticas. Tente novamente em instantes.`);
    }
    return true;
  }

  // /pendentes — lista pedidos aguardando aprovação
  if (text.startsWith('/pendentes')) {
    const db   = _loadDB();
    const pend = Object.values(db.pendingRequests || {});
    if (!pend.length) {
      await sendMsg(chatId, '✅ Nenhum pedido de entrada pendente no momento.');
      return true;
    }
    const list = pend.map((p, i) =>
      `${i + 1}. <b>${p.name}</b> (${p.username}) — <code>${p.userId}</code>`
    ).join('\n');
    await sendMsg(chatId,
      `⏳ <b>Pedidos pendentes (${pend.length}):</b>\n\n${list}\n\n` +
      `Use os botões nas notificações anteriores para aprovar/recusar.`
    );
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. COMANDOS DE ADMIN NO GRUPO
// ─────────────────────────────────────────────────────────────────────────────

export async function handleGuardianCommand(update) {
  const msg = update?.message;
  if (!msg) return false;

  const text   = msg?.text || '';
  const chatId = msg?.chat?.id;
  const userId = msg?.from?.id;
  const msgId  = msg?.message_id;

  // Redireciona DM para handler de setup
  if (msg.chat?.type === 'private') {
    return handlePrivateSetup(update);
  }

  if (!text.startsWith('/')) return false;

  const [cmd, ...args] = text.split(/\s+/);
  const cmdClean = cmd.toLowerCase().split('@')[0];

  const adminCmds = ['/proteger', '/lock', '/desbloquear', '/unlock', '/ban', '/kick',
                     '/admins', '/status', '/guardian', '/link', '/pendentes', '/myid', '/stats',
                     '/pie-semanal'];
  if (!adminCmds.includes(cmdClean)) return false;

  // /myid — qualquer membro pode usar
  if (cmdClean === '/myid') {
    await sendMsg(chatId, `🆔 Seu ID: <code>${userId}</code>`);
    return true;
  }

  const admin = await isAdmin(chatId, userId);
  if (!admin) {
    await deleteMsg(chatId, msgId);
    return true;
  }

  switch (cmdClean) {
    case '/proteger':
    case '/lock': {
      await enableProtectedContent();
      await sendMsg(chatId,
        `🔒 <b>GRUPO PROTEGIDO</b>\n\n` +
        `Forward, cópia e salvamento de conteúdo <b>bloqueados</b>.\n` +
        `Novos membros precisam de aprovação para entrar.\n\n` +
        `Use /link para obter o link de convite com aprovação.`
      );
      break;
    }

    case '/desbloquear':
    case '/unlock': {
      await disableProtectedContent();
      await sendMsg(chatId, `🔓 Proteção desativada temporariamente. Use /proteger para reativar.`);
      break;
    }

    case '/link': {
      const inviteLink = await createApprovalInviteLink();
      if (inviteLink) {
        await sendMsg(chatId,
          `🔗 <b>Link de Convite com Aprovação Obrigatória</b>\n\n` +
          `<code>${inviteLink}</code>\n\n` +
          `✅ Quem clicar neste link precisa aguardar sua aprovação.\n` +
          `📩 Você receberá uma notificação privada para cada pedido.\n\n` +
          `<b>Substitua o link antigo do grupo por este.</b>`
        );
      } else {
        await sendMsg(chatId, `⚠️ Erro ao gerar link. Verifique se o bot é administrador do grupo.`);
      }
      break;
    }

    case '/pendentes': {
      const db   = _loadDB();
      const pend = Object.values(db.pendingRequests || {});
      if (!pend.length) {
        await sendMsg(chatId, '✅ Nenhum pedido pendente.');
        break;
      }
      const list = pend.map((p, i) =>
        `${i + 1}. <b>${p.name}</b> (${p.username})`
      ).join('\n');
      await sendMsg(chatId, `⏳ <b>${pend.length} pedido(s) pendente(s):</b>\n\n${list}`);
      break;
    }

    case '/ban': {
      const target = _resolveTarget(msg, args);
      if (!target) { await sendMsg(chatId, `⚠️ Use: <code>/ban @usuario</code> ou responda a mensagem.`); break; }
      const db = _loadDB();
      db.bannedUsers = db.bannedUsers || [];
      db.bannedUsers.push({ userId: target.id, username: target.username, bannedAt: new Date().toISOString() });
      _saveDB(db);
      await banUser(chatId, target.id);
      await sendMsg(chatId, `🔨 <b>${target.username}</b> banido permanentemente.`);
      break;
    }

    case '/kick': {
      const target = _resolveTarget(msg, args);
      if (!target) { await sendMsg(chatId, `⚠️ Use: <code>/kick @usuario</code> ou responda a mensagem.`); break; }
      await kickUser(chatId, target.id);
      await sendMsg(chatId, `👢 <b>${target.username}</b> removido do grupo.`);
      break;
    }

    case '/admins': {
      const admins = await api('getChatAdministrators', { chat_id: chatId });
      if (!admins) break;
      const list = admins.filter(a => !a.user?.is_bot)
        .map(a => `• ${a.user?.first_name || '?'} ${a.user?.username ? `(@${a.user.username})` : ''} — ${_roleLabel(a.status)}`)
        .join('\n');
      await sendMsg(chatId, `👮 <b>Administradores</b>\n\n${list}`);
      break;
    }

    case '/stats': {
      // Disponível apenas em DM (dados sensíveis)
      const adminId = ADMIN_NOTIFY_ID();
      if (adminId && String(userId) !== String(adminId)) {
        await deleteMsg(chatId, msgId);
        break;
      }
      const daysArg = parseInt(args[0]) || 7;
      const stats   = getOverallStats({ daysBack: daysArg });
      const top     = stats.topMembers.slice(0, 5)
        .map((m, i) => {
          const tag = m.username || m.firstName || `ID ${m.userId}`;
          return `  ${i + 1}. ${tag}  —  ${m.clicks}🔗  ${m.reactions}💬`;
        }).join('\n') || '  (nenhum registro ainda)';
      const topSig = stats.topSignals.slice(0, 3)
        .map(s => `  • ${(s.match || '?').substring(0, 30)}  →  ${s.clicks}🔗 ${s.reactions}💬`)
        .join('\n') || '  (nenhum sinal registrado)';
      const text =
        `📊 <b>ENGAJAMENTO — últimos ${daysArg}d</b>\n\n` +
        `📡 Sinais enviados: <b>${stats.totalSignals}</b>\n` +
        `🔗 Cliques no link: <b>${stats.totalClicks}</b>\n` +
        `💬 Reações: <b>${stats.totalReactions}</b>\n` +
        `📈 Taxa de clique: <b>${stats.clickRate}%</b>\n\n` +
        `🏆 <b>Top membros:</b>\n${top}\n\n` +
        `🔥 <b>Sinais com mais cliques:</b>\n${topSig}\n\n` +
        `<i>Use /stats 30 para ver os últimos 30 dias</i>`;
      await sendMsg(chatId, text);
      break;
    }

    case '/status':
    case '/guardian': {
      const db      = _loadDB();
      const chat    = await api('getChat', { chat_id: chatId });
      const prot    = chat?.has_protected_content ? '🔒 Ativo' : '🔓 Inativo';
      const pend    = Object.keys(db.pendingRequests || {}).length;
      const adminId = ADMIN_NOTIFY_ID();

      const lines = [
        `🛡️ <b>Status do Guardian</b>`,
        ``,
        `Conteúdo protegido: <b>${prot}</b>`,
        `Pedidos pendentes: <b>${pend}</b>`,
        `Admin notificações: <b>${adminId ? `✅ ID ${adminId}` : '⚠️ Não configurado'}</b>`,
        `Banidos: <b>${db.bannedUsers?.length || 0}</b>`,
        `Membros: <b>${chat?.member_count ?? '—'}</b>`,
      ];

      // ── Seção PIE ─────────────────────────────────────────────────────────
      try {
        const pieDB = JSON.parse(readFileSync(join(ROOT, 'data/pie.json'), 'utf-8'));
        const cal   = pieDB.calibration || {};

        // Total outcomes e taxa global
        let totalOutcomes = 0;
        let totalHits     = 0;
        const marketList  = [];

        for (const [market, data] of Object.entries(cal)) {
          const t = data.total || 0;
          const h = data.hits  || 0;
          totalOutcomes += t;
          totalHits     += h;
          if (t >= 30) {
            marketList.push({ market, total: t, rate: t > 0 ? h / t : 0 });
          }
        }

        const globalRate = totalOutcomes > 0
          ? `${(totalHits / totalOutcomes * 100).toFixed(1)}%`
          : '—';

        // Top 3 mercados por calibração
        marketList.sort((a, b) => b.rate - a.rate);
        const top3 = marketList.slice(0, 3)
          .map(m => `  • ${m.market}: ${(m.rate * 100).toFixed(1)}% (${m.total})`)
          .join('\n') || '  (sem dados suficientes)';

        lines.push(``);
        lines.push(`📊 <b>PIE</b>`);
        lines.push(`Outcomes: <b>${totalOutcomes}</b> · Taxa global: <b>${globalRate}</b>`);
        lines.push(`Top mercados:\n${top3}`);
      } catch {}

      // ── Seção Análises pendentes ───────────────────────────────────────────
      try {
        const analyses = JSON.parse(readFileSync(join(ROOT, 'data/pending-analyses.json'), 'utf-8'));
        const list      = Array.isArray(analyses) ? analyses : Object.values(analyses);
        const now       = Date.now();
        const h24       = 24 * 60 * 60 * 1000;

        const pending   = list.filter(a => !a.result);
        const resolved  = list.filter(a => a.result && a.resolvedAt && (now - new Date(a.resolvedAt).getTime()) < h24);
        const greens    = resolved.filter(a => a.result === 'GREEN').length;
        const reds      = resolved.filter(a => a.result === 'RED').length;

        lines.push(``);
        lines.push(`🔍 <b>Análises</b>`);
        lines.push(`Pendentes de resultado: <b>${pending.length}</b>`);
        lines.push(`Resolvidas (24h): <b>${resolved.length}</b> — ✅ ${greens} GREEN · ❌ ${reds} RED`);
      } catch {}

      // ── Seção Próximos jogos ───────────────────────────────────────────────
      try {
        const health = JSON.parse(readFileSync(join(ROOT, 'data/pipeline-health.json'), 'utf-8'));
        const runs   = Array.isArray(health) ? health : (health.runs || []);
        const last   = runs[runs.length - 1] || health;

        if (last && (last.aprovados || last.matches_details?.length)) {
          const details = (last.matches_details || []).slice(0, 5);
          const matchLines = details
            .map(m => `  • ${m.match || m.home + ' x ' + m.away || '?'} (${m.market || ''}${m.ev ? ` EV:${m.ev}%` : ''})`)
            .join('\n');

          lines.push(``);
          lines.push(`⚽ <b>Próximos jogos aprovados</b> (último run: ${last.aprovados ?? details.length})`);
          if (matchLines) lines.push(matchLines);
        }
      } catch {}

      lines.push(``);
      lines.push(`<i>/link — gerar convite com aprovação | /pendentes — ver fila</i>`);

      await sendMsg(chatId, lines.join('\n'));
      break;
    }

    case '/pie-semanal': {
      const snapshotPath = join(ROOT, 'data/pie-snapshots.jsonl');
      if (!existsSync(snapshotPath)) {
        await sendMsg(chatId, `⚠️ Nenhum snapshot encontrado em <code>data/pie-snapshots.jsonl</code>.`);
        break;
      }

      let snapshots;
      try {
        snapshots = readFileSync(snapshotPath, 'utf-8')
          .split('\n')
          .filter(l => l.trim())
          .map(l => JSON.parse(l));
      } catch (e) {
        await sendMsg(chatId, `⚠️ Erro ao ler snapshots: ${e.message}`);
        break;
      }

      if (!snapshots.length) {
        await sendMsg(chatId, `⚠️ Arquivo de snapshots está vazio.`);
        break;
      }

      // Seleciona até 4 snapshots (1 por semana — domingos ou últimos N disponíveis)
      const weekly = snapshots
        .filter(s => {
          if (!s.ts) return false;
          const d = new Date(s.ts);
          return d.getDay() === 0; // domingos
        });

      // Se não há domingos suficientes, pega os últimos 4 disponíveis
      const selected = (weekly.length >= 2 ? weekly : snapshots).slice(-4);

      const lines = [`📈 <b>Evolução PIE — Últimas ${selected.length} semanas</b>`, ``];

      for (const snap of selected) {
        const date  = new Date(snap.ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
        const cal   = snap.calibration || {};
        const stats = snap.stats || {};

        // Calcula totais do snapshot
        let total  = stats.total  || 0;
        let acertos = stats.acertos || 0;
        if (!total) {
          for (const d of Object.values(cal)) {
            total   += d.total || 0;
            acertos += d.hits  || 0;
          }
        }
        const taxa = total > 0 ? `${(acertos / total * 100).toFixed(1)}%` : '—';

        // Top 3 mercados do snapshot
        const markets = Object.entries(cal)
          .filter(([, d]) => (d.total || 0) >= 30)
          .map(([m, d]) => ({ m, rate: d.total > 0 ? d.hits / d.total : 0, total: d.total }))
          .sort((a, b) => b.rate - a.rate)
          .slice(0, 3)
          .map(x => `    ${x.m}: ${(x.rate * 100).toFixed(1)}% (${x.total})`)
          .join('\n') || '    (sem dados)';

        lines.push(`📅 <b>${date}</b> — ${total} outcomes · ${taxa}`);
        lines.push(markets);
        lines.push(``);
      }

      await sendMsg(chatId, lines.join('\n'));
      break;
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. NOVOS MEMBROS — detecta bots e contas na lista de banidos
// ─────────────────────────────────────────────────────────────────────────────

export async function handleNewMember(update) {
  const msg     = update?.message;
  const newMems = msg?.new_chat_members;
  if (!newMems?.length) return;

  const chatId = msg?.chat?.id;
  const db     = _loadDB();

  for (const member of newMems) {
    if (member.is_bot && member.id !== _cachedBotId) {
      await banUser(chatId, member.id);
      await sendMsg(chatId, `🤖 Bot não autorizado removido automaticamente.`);
      continue;
    }
    const banned = (db.bannedUsers || []).find(b => String(b.userId) === String(member.id));
    if (banned) {
      await banUser(chatId, member.id);
      await sendMsg(chatId, `🚫 Usuário banido impedido de reentrar.`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ANTI-FLOOD + ANTI-LINK
// ─────────────────────────────────────────────────────────────────────────────

const FLOOD_LIMIT  = 5;
const FLOOD_WINDOW = 60_000;

export async function handleAntiFlood(update) {
  const msg = update?.message;
  if (!msg || msg.chat?.type === 'private') return;

  const chatId = msg?.chat?.id;
  const userId = msg?.from?.id;
  const msgId  = msg?.message_id;
  if (!userId) return;

  if (await isAdmin(chatId, userId)) return;

  // Anti-link
  const text = msg?.text || msg?.caption || '';
  if (_isSpamLink(text)) {
    await deleteMsg(chatId, msgId);
    await restrictUser(chatId, userId);
    await sendMsg(chatId, `🚫 Link externo removido. Compartilhamento de links de terceiros é proibido.`);
    return;
  }

  // Anti-flood
  const db  = _loadDB();
  const now = Date.now();
  const key = `${chatId}_${userId}`;
  if (!db.floodLog) db.floodLog = {};
  db.floodLog[key] = (db.floodLog[key] || []).filter(t => now - t < FLOOD_WINDOW);
  db.floodLog[key].push(now);

  if (db.floodLog[key].length >= FLOOD_LIMIT) {
    db.floodLog[key] = [];
    _saveDB(db);
    await deleteMsg(chatId, msgId);
    await restrictUser(chatId, userId);
    await sendMsg(chatId, `⚠️ Anti-flood: usuário silenciado por 1h.`);
    return;
  }

  _saveDB(db);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. RASTREAMENTO DE REAÇÕES (message_reaction updates)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chamado quando um membro reage a uma mensagem do grupo.
 * Registra no engagement tracker para medir interesse por sinal.
 */
export async function handleMessageReaction(update) {
  const react = update?.message_reaction;
  if (!react) return;

  const msgId    = react?.message_id;
  const user     = react?.user;
  if (!user || !msgId) return;

  // Processa apenas novas reações (new_reaction), ignora remoções
  for (const r of (react.new_reaction || [])) {
    const emoji = r.emoji || r.type || '?';
    trackReaction({
      msgId,
      userId:    user.id,
      firstName: user.first_name || '',
      username:  user.username ? `@${user.username}` : '',
      emoji,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROTEÇÕES DE CONTEÚDO
// ─────────────────────────────────────────────────────────────────────────────

export async function enableProtectedContent() {
  const chatId = CHAT();
  if (!chatId) return false;
  const ok = await api('setChatProtectedContent', { chat_id: chatId, is_protected: true });
  if (ok !== null) console.log('[Guardian] ✅ Conteúdo protegido ATIVADO');
  return ok !== null;
}

export async function disableProtectedContent() {
  const chatId = CHAT();
  if (!chatId) return false;
  await api('setChatProtectedContent', { chat_id: chatId, is_protected: false });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// INICIALIZAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

export async function initGroupGuardian() {
  console.log('[Guardian] 🛡️  Iniciando Group Guardian...');

  await enableProtectedContent();

  // Permissões padrão — membros NÃO podem enviar nada. Somente admins falam.
  const chatId = CHAT();
  if (chatId) {
    await api('setChatPermissions', {
      chat_id: chatId,
      permissions: {
        can_send_messages:         false,  // silêncio total para membros
        can_send_media_messages:   false,
        can_send_polls:            false,
        can_send_other_messages:   false,
        can_add_web_page_previews: false,
        can_change_info:           false,
        can_invite_users:          false,
        can_pin_messages:          false,
      },
    });
    console.log('[Guardian] ✅ Grupo bloqueado — somente admins podem enviar mensagens');
  }

  const adminId = ADMIN_NOTIFY_ID();
  if (adminId) {
    console.log(`[Guardian] 📩 Notificações de aprovação → ID ${adminId}`);
  } else {
    console.log('[Guardian] ⚠️  Admin não configurado. Envie /myid ao bot em DM e adicione ao .env: TELEGRAM_ADMIN_USER_ID=<id>');
  }

  console.log('[Guardian] 🛡️  Guardian ativo. Comandos: /proteger /link /ban /kick /admins /status /myid');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS INTERNOS
// ─────────────────────────────────────────────────────────────────────────────

function _resolveTarget(msg, args) {
  if (msg.reply_to_message) {
    const u = msg.reply_to_message.from;
    return { id: u.id, username: u.username ? `@${u.username}` : u.first_name };
  }
  if (args[0]) {
    return { id: null, username: args[0].startsWith('@') ? args[0] : `@${args[0]}` };
  }
  return null;
}

function _roleLabel(status) {
  return { creator: '👑 Dono', administrator: '🛡️ Admin' }[status] || status;
}

function _isSpamLink(text) {
  return [
    /t\.me\/joinchat\//i, /t\.me\/\+/i,
    /telegram\.me\/joinchat/i,
    /bit\.ly\//i, /tinyurl\.com\//i,
    /@\w+bot\b/i,
  ].some(p => p.test(text));
}

let _cachedBotId = null;
export async function cacheBotId() {
  try {
    const me = await api('getMe');
    if (me?.id) _cachedBotId = me.id;
  } catch {}
}
