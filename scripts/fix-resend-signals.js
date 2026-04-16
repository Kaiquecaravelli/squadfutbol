#!/usr/bin/env node
/**
 * fix-resend-signals.js — Apaga sinais com problemas e reenvio correto
 *
 * Uso: node scripts/fix-resend-signals.js
 */

import 'dotenv/config';
import axios from 'axios';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api.telegram.org';

function getChatId()  { return process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID; }
function getToken()   { return process.env.TELEGRAM_BOT_TOKEN; }
function isConfigured() { return !!(getToken() && getChatId()); }

const SENT_DB_PATH    = join(__dirname, '../data/telegram-sent.json');
const PENDING_DB_PATH = join(__dirname, '../data/pending-analyses.json');

// ── IDs das mensagens problemáticas ──────────────────────────────────────────
// Identificados em data/telegram-sent.json e data/pending-analyses.json
const MSG_IDS_TO_DELETE = [
  1216,  // prelive: Vélez Sarsfield vs Central Córdoba (link errado)
  1160,  // live: São Paulo vs Corinthians (informações faltando)
];

async function deleteMsg(msgId) {
  if (!isConfigured() || !msgId) return;
  try {
    const res = await axios.post(`${BASE}/bot${getToken()}/deleteMessage`, {
      chat_id:    getChatId(),
      message_id: msgId,
    });
    if (res.data?.ok) {
      console.log(`  ✅ Mensagem ${msgId} apagada do grupo`);
    }
  } catch (e) {
    // Pode já ter expirado (48h) ou sido apagada manualmente
    const code = e?.response?.data?.error_code;
    if (code === 400) {
      console.log(`  ⚠️  Mensagem ${msgId} não encontrada (já apagada ou expirada)`);
    } else {
      console.log(`  ⚠️  Erro ao apagar ${msgId}: ${e.message}`);
    }
  }
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  🔧 Fix & Resend — Correção de sinais com problemas');
  console.log('════════════════════════════════════════════════════════════\n');

  if (!isConfigured()) {
    console.error('❌ TELEGRAM_BOT_TOKEN ou TELEGRAM_GROUP_ID não configurado no .env');
    process.exit(1);
  }

  // ── ETAPA 1: Apagar mensagens problemáticas do grupo ──────────────────────
  console.log('📭 ETAPA 1 — Apagando mensagens incorretas do grupo Telegram...');
  for (const msgId of MSG_IDS_TO_DELETE) {
    await deleteMsg(msgId);
  }

  // ── ETAPA 2: Limpar registro de dedup (telegram-sent.json) ───────────────
  console.log('\n🗑️  ETAPA 2 — Limpando registros de deduplicação...');
  try {
    // Zera completamente para garantir que o reenvio não seja bloqueado
    writeFileSync(SENT_DB_PATH, '{}', 'utf8');
    console.log('  ✅ telegram-sent.json limpo');
  } catch (e) {
    console.warn(`  ⚠️  Não foi possível limpar telegram-sent.json: ${e.message}`);
  }

  // ── ETAPA 3: Remover análise live obsoleta (São Paulo vs Corinthians) ─────
  console.log('\n🗑️  ETAPA 3 — Removendo análise live obsoleta...');
  try {
    const pending = JSON.parse(readFileSync(PENDING_DB_PATH, 'utf8') || '[]');
    const filtered = pending.filter(p => p.msgId !== 1160);
    writeFileSync(PENDING_DB_PATH, JSON.stringify(filtered, null, 2), 'utf8');
    const removed = pending.length - filtered.length;
    console.log(`  ✅ ${removed} análise(s) obsoleta(s) removida(s) de pending-analyses.json`);
  } catch (e) {
    console.warn(`  ⚠️  Não foi possível limpar pending-analyses.json: ${e.message}`);
  }

  // ── ETAPA 4: Re-executar pipeline pré-live para reenvio correto ──────────
  console.log('\n🚀 ETAPA 4 — Re-executando pipeline PRÉ-LIVE com dados corretos...');
  console.log('  (Cache Superbet será atualizado — links diretos dos jogos serão usados)\n');

  try {
    execSync('node scripts/prelive-superodds-now.js', {
      cwd: join(__dirname, '..'),
      stdio: 'inherit',
      timeout: 300_000,  // 5 minutos
    });
    console.log('\n✅ Pipeline concluído — sinais reenviados com sucesso');
  } catch (e) {
    console.error(`\n❌ Erro no pipeline: ${e.message}`);
    process.exit(1);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  ✅ Fix & Resend concluído');
  console.log('════════════════════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error('Erro fatal:', e.message);
  process.exit(1);
});
