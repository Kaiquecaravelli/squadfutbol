/**
 * cleanup-and-resend.mjs
 * Apaga todas as mensagens do grupo que estão no dedup DB,
 * limpa os estados de notificação e dispara novas análises.
 */

import axios from 'axios';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── Config ───────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config({ path: join(ROOT, '.env') });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID  = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;
const BASE      = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !GROUP_ID) {
  console.error('❌ TELEGRAM_BOT_TOKEN ou TELEGRAM_GROUP_ID não configurados.');
  process.exit(1);
}

// ── Caminhos dos arquivos de estado ──────────────────────────────
const DEDUP_PATH          = join(ROOT, 'data/telegram-sent.json');
const PRELIVE_KEYS_PATH   = join(ROOT, 'data/prelive-notified-keys.json');
const NOTIFIED_KEYS_PATH  = join(ROOT, 'data/notified-keys.json');
const MORNING_SENT_PATH   = join(ROOT, 'data/morning-sent.json');

// ── API Telegram ──────────────────────────────────────────────────
async function deleteMessage(msgId) {
  try {
    const res = await axios.post(`${BASE}/deleteMessage`, {
      chat_id:    GROUP_ID,
      message_id: msgId,
    });
    return res.data?.ok === true;
  } catch (e) {
    const err = e.response?.data?.description || e.message;
    // Mensagem já apagada ou muito antiga (>48h) — não é erro crítico
    if (err.includes('message to delete not found') || err.includes('MESSAGE_ID_INVALID')) {
      return 'not_found';
    }
    console.log(`  ⚠️  msgId ${msgId}: ${err}`);
    return false;
  }
}

async function sendNotice(text) {
  try {
    await axios.post(`${BASE}/sendMessage`, {
      chat_id:    GROUP_ID,
      text,
      parse_mode: 'HTML',
    });
  } catch {}
}

// ── Execução ──────────────────────────────────────────────────────
console.log('\n🧹 Iniciando limpeza do grupo Telegram...\n');

// 1. Ler dedup DB e coletar todos os msgIds
let dedupDb = {};
if (existsSync(DEDUP_PATH)) {
  try { dedupDb = JSON.parse(readFileSync(DEDUP_PATH, 'utf-8')); } catch {}
}

const msgIds = [...new Set(
  Object.values(dedupDb)
    .map(v => v.msgId)
    .filter(id => typeof id === 'number' && id > 0)
)].sort((a, b) => a - b);

console.log(`📋 ${msgIds.length} mensagens encontradas no dedup DB`);
console.log(`   IDs: ${msgIds.slice(0, 5).join(', ')}${msgIds.length > 5 ? ` ... ${msgIds[msgIds.length-1]}` : ''}\n`);

// 2. Apagar mensagens do grupo
let deleted = 0, notFound = 0, failed = 0;

for (const msgId of msgIds) {
  const result = await deleteMessage(msgId);
  if (result === true)         { deleted++;  process.stdout.write('🗑️ '); }
  else if (result === 'not_found') { notFound++; process.stdout.write('·'); }
  else                         { failed++;   process.stdout.write('✗'); }

  // Throttle para não bater limite de rate do Telegram (30 req/s)
  await new Promise(r => setTimeout(r, 50));
}

console.log(`\n\n✅ Apagadas: ${deleted}  |  Não encontradas: ${notFound}  |  Falhas: ${failed}\n`);

// 3. Limpar todos os estados de notificação
const emptyObj  = '{}';
const emptyArr  = '[]';

const toReset = [
  { path: DEDUP_PATH,          content: emptyObj, label: 'telegram-sent.json' },
  { path: PRELIVE_KEYS_PATH,   content: emptyObj, label: 'prelive-notified-keys.json' },
  { path: NOTIFIED_KEYS_PATH,  content: emptyObj, label: 'notified-keys.json' },
  { path: MORNING_SENT_PATH,   content: emptyObj, label: 'morning-sent.json' },
];

for (const { path, content, label } of toReset) {
  try {
    writeFileSync(path, content, 'utf-8');
    console.log(`  ♻️  ${label} → limpo`);
  } catch (e) {
    console.log(`  ⚠️  ${label}: ${e.message}`);
  }
}

// 4. Aviso no grupo que o sistema foi reiniciado
await sendNotice(
  '🔄 <b>Sistema reiniciado</b>\n' +
  'Novas análises serão enviadas em instantes...'
);

console.log('\n✅ Limpeza concluída. Estados zerados.\n');
console.log('🚀 Agora execute as análises:');
console.log('   npm run daily         → pipeline completo');
console.log('   node scripts/prelive-superodds-now.js  → SuperOdds PRÉ-LIVE');
