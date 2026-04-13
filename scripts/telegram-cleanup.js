/**
 * telegram-cleanup.js — Levantamento e limpeza de mensagens do Telegram
 *
 * Lê o pending-analyses.json e apaga do chat:
 *  • resultMsgId — mensagens GREEN/RED de jogos já encerrados
 *  • msgId        — mensagens de análise originais ainda não apagadas
 *
 * Mantém intactas:
 *  • Mensagens de entradas com status 'pending' (jogos ainda não ocorreram)
 *
 * Uso:
 *   node scripts/telegram-cleanup.js
 *   node scripts/telegram-cleanup.js --dry-run
 */

import 'dotenv/config';
import axios from 'axios';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dir, '..');
const DRY    = process.argv.includes('--dry-run');
const BASE   = 'https://api.telegram.org';
const DELAY  = 400; // ms entre deletes (evita flood)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getChatId() {
  return process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;
}

async function tryDelete(msgId, label) {
  if (DRY) {
    console.log(chalk.gray(`  [DRY] apagaria msgId ${msgId}  (${label})`));
    return true;
  }
  try {
    await axios.post(`${BASE}/bot${process.env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      chat_id:    getChatId(),
      message_id: msgId,
    });
    return true;
  } catch (e) {
    const reason = e?.response?.data?.description || e.message;
    // "message to delete not found" = já apagada → OK
    if (reason.includes('not found') || reason.includes('Message_id_invalid')) return null;
    console.warn(chalk.yellow(`    ⚠ msgId ${msgId}: ${reason}`));
    return false;
  }
}

async function run() {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = getChatId();

  console.log('\n' + '═'.repeat(64));
  console.log('  🧹 Telegram Cleanup — Levantamento e limpeza de mensagens');
  console.log(`  Modo: ${DRY ? 'DRY-RUN (sem apagar)' : 'REAL'}`);
  console.log('═'.repeat(64) + '\n');

  if (!token || !chatId) {
    console.error(chalk.red('  ✗ TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurados.'));
    process.exit(1);
  }

  // ── Lê estado atual ──────────────────────────────────────────────────────
  const all = JSON.parse(readFileSync(join(ROOT, 'data/pending-analyses.json'), 'utf8'));

  const resolved = all.filter(e => e.status === 'resolved');
  const pending  = all.filter(e => e.status === 'pending');

  // ── Inventário ───────────────────────────────────────────────────────────
  console.log(chalk.white(`  📋 Inventário do pending-analyses.json:`));
  console.log(chalk.green(`     ✅ Resolvidos: ${resolved.length}`));
  console.log(chalk.yellow(`     ⏳ Pendentes:  ${pending.length}`));

  if (pending.length) {
    console.log(chalk.cyan('\n  Mensagens MANTIDAS (jogos ainda não ocorreram):'));
    for (const e of pending) {
      const gt = e.gameTime ? new Date(e.gameTime).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '–';
      console.log(chalk.cyan(`    • msgId ${e.msgId}  ${e.match} [${e.market}]  kickoff: ${gt}`));
    }
  }

  console.log(chalk.white('\n  Mensagens a apagar (jogos encerrados):'));

  // ── Coleta todas as IDs a deletar ────────────────────────────────────────
  // Cada resolved pode ter: resultMsgId (GREEN/RED) + msgId (análise original)
  const toDelete = [];

  for (const e of resolved) {
    if (e.resultMsgId) toDelete.push({ msgId: e.resultMsgId, label: `resultado ${e.acertou ? '✅' : '❌'} de ${e.match} [${e.market}]` });
    if (e.msgId)       toDelete.push({ msgId: e.msgId,       label: `análise original de ${e.match} [${e.market}]` });
  }

  // Remove IDs duplicadas (ex: mesmo msgId em duas entradas)
  const seen = new Set();
  const unique = toDelete.filter(({ msgId }) => {
    if (seen.has(msgId)) return false;
    seen.add(msgId);
    return true;
  });

  console.log(chalk.white(`\n  ${unique.length} mensagem(ns) identificada(s):\n`));
  for (const { msgId, label } of unique) {
    console.log(chalk.gray(`    msgId ${msgId}  — ${label}`));
  }

  if (!unique.length) {
    console.log(chalk.green('\n  Nada a apagar. Chat já está limpo.'));
    return;
  }

  // ── Apaga ────────────────────────────────────────────────────────────────
  console.log(chalk.white(`\n${'─'.repeat(64)}`));
  console.log(chalk.white(`  Apagando mensagens...\n`));

  let deleted = 0, alreadyGone = 0, failed = 0;

  for (const { msgId, label } of unique) {
    process.stdout.write(`  → msgId ${String(msgId).padEnd(6)}  `);
    const r = await tryDelete(msgId, label);
    if (r === true)  { console.log(chalk.green('apagado ✓'));  deleted++;    }
    if (r === null)  { console.log(chalk.gray ('já inexistente'));   alreadyGone++; }
    if (r === false) { console.log(chalk.red  ('falha ✗'));    failed++;     }
    await sleep(DELAY);
  }

  // ── Resumo ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(64));
  if (DRY) {
    console.log(`  [DRY-RUN] ${unique.length} mensagem(ns) seriam apagadas`);
  } else {
    console.log(`  ✓ Apagadas: ${deleted}  |  Já inexistentes: ${alreadyGone}  |  Falhas: ${failed}`);
    console.log(`  Chat limpo. Apenas mensagens de jogos pendentes foram mantidas.`);
  }
  console.log('═'.repeat(64) + '\n');
}

run().catch(e => {
  console.error(chalk.red(`\nERRO: ${e.message}`));
  process.exit(1);
});
