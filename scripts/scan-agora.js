/**
 * scan-agora.js — Scanner Forçado Imediato (comando standalone)
 *
 * Executa runPreLiveSuperOdds() fora do ciclo automático de 15 min.
 * Bypassa a Camada 1 (cycle-check) e o lock do scheduler.
 *
 * Proteção contra colisão:
 *   - Lê data/cycle-check-state.json: se último scan foi há < 90s,
 *     aborta e notifica admin (scan em andamento).
 *   - Escreve lock antes de iniciar, remove após conclusão.
 *
 * Gates mantidos:
 *   - Qualidade mínima (Kill Zone 71% floor: nunca desativado)
 *   - Odds mínimas (≥ 1.50)
 *   - Protocolo ALERTA → 90s → SINAL
 *
 * Uso:
 *   npm run scan-agora
 *   node scripts/scan-agora.js
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname }       from 'path';
import { fileURLToPath }       from 'url';
import { runPreLiveSuperOdds } from './prelive-superodds-now.js';
import { getDailyStatus }      from './daily-counter.js';
import { markScanExecutedSync } from './cycle-check.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const CYCLE_STATE  = join(__dirname, '../data/cycle-check-state.json');
const LOCK_FILE    = join(__dirname, '../data/scan-force.lock');
const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID     = process.env.TELEGRAM_ADMIN_USER_ID || process.env.TELEGRAM_CHAT_ID;
const BASE         = `https://api.telegram.org/bot${TOKEN}`;

// ── Helper de notificação admin ───────────────────────────────────────────────

async function notifyAdmin(text) {
  if (!TOKEN || !ADMIN_ID) return;
  try {
    await fetch(`${BASE}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:                  ADMIN_ID,
        text,
        parse_mode:               'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch { /* falha silenciosa — não bloqueia o scan */ }
}

// ── Proteção contra colisão ────────────────────────────────────────────────────

function checkCollision() {
  // Verifica lock file (scan-agora já em execução)
  if (existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      const ageMs = Date.now() - (lock.startedAt || 0);
      if (ageMs < 8 * 60_000) { // lock com < 8 min → scan em andamento
        return { blocked: true, reason: `scan-agora já em execução (iniciado há ${Math.round(ageMs / 1000)}s)` };
      }
      // Lock velho (> 8 min) → provavelmente sobrou de crash anterior
      unlinkSync(LOCK_FILE);
    } catch { unlinkSync(LOCK_FILE); }
  }

  // Verifica se o scheduler rodou scan há < 90s (pode ainda estar em andamento)
  if (existsSync(CYCLE_STATE)) {
    try {
      const state = JSON.parse(readFileSync(CYCLE_STATE, 'utf-8'));
      const ageMs = Date.now() - (state.lastScanTs || 0);
      if (ageMs < 90_000) {
        return { blocked: true, reason: `scheduler executou scan há ${Math.round(ageMs / 1000)}s — aguarde` };
      }
    } catch { /* ignora leitura corrompida */ }
  }

  return { blocked: false };
}

function writeLock() {
  try {
    writeFileSync(LOCK_FILE, JSON.stringify({ startedAt: Date.now(), pid: process.pid }), 'utf-8');
  } catch { /* falha silenciosa */ }
}

function removeLock() {
  try { if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE); } catch { /* ignora */ }
}

// ── Execução principal ────────────────────────────────────────────────────────

async function run() {
  const startTs = Date.now();
  const now     = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

  console.log(`\n[ScanAgora] ⚡ Scanner forçado acionado às ${now}`);

  // ── Verificação de colisão ────────────────────────────────────────────────
  const { blocked, reason } = checkCollision();
  if (blocked) {
    const msg = `⚠️ <b>[SCANNER FORÇADO] · Bloqueado</b>\n<code>${reason}</code>\n<i>Aguarde o ciclo atual terminar e tente novamente.</i>`;
    console.warn(`[ScanAgora] ⚠️  Bloqueado: ${reason}`);
    await notifyAdmin(msg);
    process.exit(0);
  }

  // ── Confirmação de início ao admin ────────────────────────────────────────
  const { total, target } = getDailyStatus();
  await notifyAdmin(
    `⚡ <b>[SCANNER FORÇADO] · Iniciado · ${now}</b>\n` +
    `Análises hoje: <code>${total}/${target}</code>\n` +
    `<i>Varrendo mercado — aguarde o relatório...</i>`
  );

  // ── Escreve lock + executa scan ───────────────────────────────────────────
  writeLock();

  try {
    console.log('[ScanAgora] 🔵 Executando runPreLiveSuperOdds()...');
    await runPreLiveSuperOdds();
    markScanExecutedSync();
  } catch (err) {
    console.error(`[ScanAgora] ❌ Erro durante scan: ${err.message}`);
    await notifyAdmin(
      `🔴 <b>[SCANNER FORÇADO] · Erro</b>\n` +
      `<code>${err.message}</code>\n` +
      `<i>Verificar logs: npm run pm2-logs-err</i>`
    );
    removeLock();
    process.exit(1);
  }

  removeLock();

  // ── Relatório de conclusão ao admin ──────────────────────────────────────
  const durMs       = Date.now() - startTs;
  const durS        = (durMs / 1000).toFixed(1);
  const { total: totalFinal } = getDailyStatus();
  const novos       = totalFinal - total;

  const relatorio = [
    `✅ <b>[SCANNER FORÇADO] · Concluído · ${now}</b>`,
    `Tempo: <code>${durS}s</code>`,
    `Análises antes: <code>${total}/${target}</code>  ·  Após: <code>${totalFinal}/${target}</code>`,
    novos > 0
      ? `Novos sinais enfileirados: <code>${novos}</code> ✅`
      : `Sem novos sinais (gates não atingidos ou mercado sem liquidez)`,
    `<i>Ciclo automático de 15min continua normalmente.</i>`,
  ].join('\n');

  await notifyAdmin(relatorio);

  console.log(`\n[ScanAgora] ✅ Concluído em ${durS}s`);
  console.log(`[ScanAgora] Sinais novos: ${novos}\n`);

  process.exit(0);
}

run().catch((err) => {
  removeLock();
  console.error('[ScanAgora] ❌ Erro fatal:', err.message);
  process.exit(1);
});
