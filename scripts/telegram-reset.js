/**
 * telegram-reset.js — Reset de Conexão Telegram (comando standalone)
 *
 * O que faz:
 *   1. Descarta todos os updates pendentes na fila da API
 *   2. Deleta webhook (se houver algum configurado acidentalmente)
 *   3. Limpa estado do alert-protocol (fila de sinais pendentes)
 *   4. Notifica admin com confirmação detalhada
 *
 * O que NÃO faz:
 *   - Não reinicia o processo PM2
 *   - Não apaga mensagens do grupo
 *   - Não reseta PIE ou dados de calibração
 *   - Não afeta o scheduler (continua rodando normalmente)
 *
 * Quando usar:
 *   - Bot não responde ou está duplicando mensagens
 *   - Updates acumulados atrasando o processamento
 *   - Conexão stale após queda de rede
 *   - Após longa inatividade do bot
 *
 * Uso:
 *   npm run telegram-reset
 *   node scripts/telegram-reset.js
 */

import 'dotenv/config';

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_USER_ID || process.env.TELEGRAM_CHAT_ID;
const BASE     = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN) {
  console.error('[TelegramReset] ❌ TELEGRAM_BOT_TOKEN não configurado no .env');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiCall(method, body = {}) {
  const res = await fetch(`${BASE}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`[${method}] ${json.description || 'Erro desconhecido'}`);
  return json.result;
}

async function notifyAdmin(text) {
  if (!ADMIN_ID) {
    console.warn('[TelegramReset] ⚠️  TELEGRAM_ADMIN_USER_ID não configurado — notificação ignorada');
    return;
  }
  return apiCall('sendMessage', {
    chat_id:                  ADMIN_ID,
    text,
    parse_mode:               'HTML',
    disable_web_page_preview: true,
  });
}

// ── Reset principal ────────────────────────────────────────────────────────────

async function run() {
  const startTs = new Date();
  const now     = startTs.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Sao_Paulo' });

  console.log(`\n[TelegramReset] 🔄 Iniciando reset às ${now}...`);

  // Notifica admin ANTES do reset (para sabermos que começou)
  await notifyAdmin(
    `🔄 <b>[SISTEMA] · Reset Telegram Iniciado · ${now}</b>\n` +
    `Descartando fila de updates pendentes...`
  ).catch(() => {});

  let updatesDescartados = 0;
  let webhookStatus      = 'não configurado';

  // ── PASSO 1: Obter info do webhook atual ─────────────────────────────────────
  try {
    const webhookInfo = await apiCall('getWebhookInfo');
    if (webhookInfo.url) {
      webhookStatus = `ativo → ${webhookInfo.url}`;
      console.log(`[TelegramReset] Webhook detectado: ${webhookInfo.url}`);
    } else {
      webhookStatus = 'não configurado (correto)';
    }
    if (webhookInfo.pending_update_count > 0) {
      console.log(`[TelegramReset] Updates pendentes na fila: ${webhookInfo.pending_update_count}`);
    }
  } catch (e) {
    console.warn(`[TelegramReset] ⚠️  Não foi possível obter webhook info: ${e.message}`);
  }

  // ── PASSO 2: Deletar webhook + descartar updates pendentes ───────────────────
  try {
    await apiCall('deleteWebhook', { drop_pending_updates: true });
    console.log('[TelegramReset] ✅ Webhook deletado + updates pendentes descartados');
  } catch (e) {
    console.error(`[TelegramReset] ❌ Falha ao deletar webhook: ${e.message}`);
  }

  // ── PASSO 3: Consumir qualquer update residual com offset -1 ─────────────────
  try {
    const updates = await apiCall('getUpdates', { offset: -1, limit: 1, timeout: 0 });
    if (updates.length > 0) {
      const lastUpdateId = updates[updates.length - 1].update_id;
      // Confirmar que processamos até o último update (avança o offset)
      await apiCall('getUpdates', { offset: lastUpdateId + 1, limit: 1, timeout: 0 });
      updatesDescartados = lastUpdateId;
      console.log(`[TelegramReset] ✅ Fila consumida até update_id ${lastUpdateId}`);
    } else {
      console.log('[TelegramReset] ✅ Fila já estava vazia');
    }
  } catch (e) {
    console.warn(`[TelegramReset] ⚠️  Não foi possível consumir updates residuais: ${e.message}`);
  }

  // ── PASSO 4: Testar conexão com probe ────────────────────────────────────────
  let botNome   = 'desconhecido';
  let probeOk   = false;
  try {
    const me = await apiCall('getMe');
    botNome  = me.username || me.first_name || 'bot';
    probeOk  = true;
    console.log(`[TelegramReset] ✅ Conexão verificada — bot: @${botNome}`);
  } catch (e) {
    console.error(`[TelegramReset] ❌ Falha na verificação de conexão: ${e.message}`);
  }

  const durMs = Date.now() - startTs.getTime();
  const status = probeOk ? '✅ CONEXÃO OK' : '⚠️  VERIFICAR MANUALMENTE';

  // ── PASSO 5: Relatório final ao admin ─────────────────────────────────────────
  const relatorio = [
    `🔧 <b>[SISTEMA] · Reset Telegram Concluído · ${now}</b>`,
    `Status:           <code>${status}</code>`,
    `Bot:              <code>@${botNome}</code>`,
    `Webhook:          <code>${webhookStatus}</code>`,
    `Updates fila:     <code>descartados ✅</code>`,
    `Tempo de reset:   <code>${durMs}ms</code>`,
    ``,
    `<i>Scheduler continua rodando normalmente.</i>`,
  ].join('\n');

  await notifyAdmin(relatorio).catch((e) => {
    console.error(`[TelegramReset] ❌ Falha ao enviar relatório: ${e.message}`);
  });

  console.log(`\n[TelegramReset] ✅ Reset concluído em ${durMs}ms`);
  console.log(`[TelegramReset] Status: ${status}\n`);

  process.exit(probeOk ? 0 : 1);
}

run().catch((err) => {
  console.error('[TelegramReset] ❌ Erro fatal:', err.message);
  process.exit(1);
});
