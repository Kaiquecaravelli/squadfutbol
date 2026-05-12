/**
 * heartbeat.js — Batimento cardíaco do sistema
 *
 * Envia mensagem silenciosa ao Telegram a cada 12 horas confirmando
 * que o sistema SquadFutbol está online e monitorando.
 *
 * Uso:
 *   node scripts/heartbeat.js              → Envia heartbeat único
 *   node scripts/heartbeat.js --daemon    → Roda em background (12h loop)
 *
 * Agendamento (PM2/nohup):
 *   nohup node scripts/heartbeat.js --daemon &
 */
import 'dotenv/config';
import axios from 'axios';

const BASE_URL = 'https://api.telegram.org';
const TELEGRAM_ADMIN = process.env.TELEGRAM_ADMIN_USER_ID;
const INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 horas

async function sendHeartbeat() {
  const now = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });

  const uptime = process.uptime();
  const uptimeStr = uptime > 86400
    ? `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h`
    : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  const msg = `✅ *SquadFutbol Online*\n` +
             `━━━━━━━━━━━━━━━━━━━━\n` +
             `🕐Horario: ${now}\n` +
             `⏱️Uptime: ${uptimeStr}\n` +
             `🔄Status: Monitorando...\n` +
             `━━━━━━━━━━━━━━━━━━━━\n` +
             `_Heartbeat 12h - sistema ativo_`;

  try {
    if (!TELEGRAM_ADMIN) {
      console.log('[Heartbeat] ⚠️ TELEGRAM_ADMIN_USER_ID nao configurado');
      return;
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    await axios.post(`${BASE_URL}/bot${token}/sendMessage`, {
      chat_id: TELEGRAM_ADMIN,
      text: msg,
      parse_mode: 'Markdown',
    });
    console.log(`[Heartbeat] ✅ Enviado ao admin ${TELEGRAM_ADMIN}`);
  } catch (err) {
    console.error(`[Heartbeat] ❌ Erro: ${err.message}`);
  }
}

async function daemon() {
  console.log(`[Heartbeat] 🔄 Daemon iniciado — enviando a cada 12h`);
  await sendHeartbeat(); // primeira execução imediata

  setInterval(async () => {
    await sendHeartbeat();
  }, INTERVAL_MS);

  // Keep alive
  process.on('SIGINT', () => {
    console.log('[Heartbeat] 🛑 Encerrando...');
    process.exit(0);
  });
}

// CLI
if (process.argv[1]?.endsWith('heartbeat.js')) {
  const isDaemon = process.argv.includes('--daemon');

  if (isDaemon) {
    daemon();
  } else {
    sendHeartbeat();
  }
}