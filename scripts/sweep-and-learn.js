/**
 * sweep-and-learn.js — Varredura Completa + Protocolo de Aprendizagem
 *
 * Wrapper sobre result-checker.js que executa as 9 fases explicitamente:
 *   FASE 1 → Inventário de sinais pendentes (pending-analyses.json)
 *   FASE 2 → Enriquecimento com dados do PIE (feito internamente pelo result-checker)
 *   FASE 3 → Coleta de resultados reais (SofaScore via fetchByEventId / fetchByMatchName)
 *   FASE 4 → Cálculo GREEN/RED via determineOutcome()
 *   FASE 5 → Publicação no grupo Telegram (notifyResultFeedback)
 *   FASE 6 → Consulta razões PIE originais
 *   FASE 7 → Confronto pré-análise vs dados reais (confronto-engine.js)
 *   FASE 8 → Extração e salvamento de lição no PIE
 *   FASE 9 → Calibração automática (lambda-fator por competição)
 *
 * Nota sobre varredura Telegram: a Bot API não permite acesso ao histórico
 * completo de mensagens (getUpdates só retorna updates não processados).
 * O pending-analyses.json é a fonte de verdade — todo sinal enviado pelo bot
 * é registrado ali via savePendingAnalysis(). A varredura complementar via PIE
 * já é coberta pelo result-checker.
 *
 * Uso:
 *   node scripts/sweep-and-learn.js            → sweep completo real
 *   node scripts/sweep-and-learn.js --dry-run  → preview sem enviar ao grupo
 *   npm run sweep                              → alias direto
 *   npm run sweep-dry                          → alias dry-run
 */
import 'dotenv/config';
import chalk from 'chalk';
import https from 'https';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runResultChecker } from './result-checker.js';

const ROOT         = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN      = process.argv.includes('--dry-run');
const PENDING_PATH = join(ROOT, 'data', 'pending-analyses.json');

// ── Utilitários internos ───────────────────────────────────────────────────────

function _loadPending() {
  try {
    const raw = JSON.parse(readFileSync(PENDING_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw : Object.values(raw);
  } catch {
    return [];
  }
}

function _snapshot(entries) {
  return {
    total:    entries.length,
    pending:  entries.filter(e => !e.status || e.status === 'pending').length,
    resolved: entries.filter(e => e.status === 'resolved').length,
    green:    entries.filter(e => e.acertou === true).length,
    red:      entries.filter(e => e.acertou === false).length,
  };
}

async function _sendAdminMsg(text) {
  if (DRY_RUN) return;
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_USER_ID;
  if (!token || !chatId) return;

  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req  = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); }
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Orquestrador principal ─────────────────────────────────────────────────────

export async function runSweepAndLearn() {
  const inicio = Date.now();
  const agora  = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  console.log('\n' + '═'.repeat(64));
  console.log('  🔍 SWEEP & LEARN — Varredura Completa do Pipeline');
  console.log(`  Data: ${agora}`);
  console.log(`  Modo: ${DRY_RUN ? chalk.yellow('DRY-RUN (sem enviar)') : chalk.green('REAL')}`);
  console.log('═'.repeat(64));

  // ── FASE 1: Inventário de sinais pendentes ────────────────────────────────────
  console.log(chalk.bold('\n[FASE 1] Inventário de sinais...'));
  const antes = _snapshot(_loadPending());
  console.log(`  Total na base:     ${antes.total}`);
  console.log(`  Pendentes:         ${chalk.yellow(String(antes.pending))}`);
  console.log(`  Já resolvidos:     ${antes.resolved}`);
  console.log(`  Histórico:         ✅ ${antes.green}  ❌ ${antes.red}`);

  if (antes.pending === 0) {
    console.log(chalk.green('\n  ✅ Pipeline limpo — nenhum sinal aguarda resultado.\n'));
    await _sendAdminMsg(
      `🔍 <b>SWEEP &amp; LEARN · ${agora}</b>\n\n` +
      `✅ Pipeline limpo — nenhum sinal pendente.\n` +
      `Base: ${antes.total} registros (${antes.green} GREEN · ${antes.red} RED)`
    );
    return;
  }

  // ── FASES 2–9: Ciclo completo via result-checker ─────────────────────────────
  console.log(chalk.bold(`\n[FASES 2–9] Processando ${chalk.yellow(String(antes.pending))} sinal(is) pendente(s)...\n`));
  console.log(chalk.gray('  FASE 2 → Enriquecimento com dados do PIE'));
  console.log(chalk.gray('  FASE 3 → Coleta de resultados reais (SofaScore)'));
  console.log(chalk.gray('  FASE 4 → Cálculo GREEN/RED (determineOutcome)'));
  console.log(chalk.gray('  FASE 5 → Publicação no grupo Telegram'));
  console.log(chalk.gray('  FASE 6 → Consulta razões PIE originais'));
  console.log(chalk.gray('  FASE 7 → Confronto pré-análise vs resultado real'));
  console.log(chalk.gray('  FASE 8 → Extração e salvamento de lição'));
  console.log(chalk.gray('  FASE 9 → Calibração automática (λ-fator)'));
  console.log('');

  await runResultChecker();

  // ── Relatório após sweep ──────────────────────────────────────────────────────
  const depois     = _snapshot(_loadPending());
  const corrigidos = depois.resolved - antes.resolved;
  const novosGreen = depois.green    - antes.green;
  const novosRed   = depois.red      - antes.red;
  const tempo      = ((Date.now() - inicio) / 1000).toFixed(1);
  const precisao   = corrigidos > 0
    ? ((novosGreen / corrigidos) * 100).toFixed(1)
    : '0.0';

  console.log('\n' + '═'.repeat(64));
  console.log('  RELATÓRIO FINAL — SWEEP & LEARN');
  console.log('═'.repeat(64));
  console.log(`  Sinais antes:        ${antes.pending} pendentes`);
  console.log(`  Resultados fechados: ${chalk.bold(String(corrigidos))}`);
  console.log(`    ✅ GREEN:          ${chalk.green(String(novosGreen))}`);
  console.log(`    ❌ RED:            ${chalk.red(String(novosRed))}`);
  if (corrigidos > 0) {
    console.log(`    📊 Precisão:       ${chalk.cyan(precisao + '%')}`);
  }
  console.log(`  Ainda pendentes:     ${depois.pending}`);
  console.log(`  Tempo total:         ${tempo}s`);
  if (DRY_RUN) {
    console.log(chalk.yellow('\n  ⚠️  DRY-RUN: nenhuma mensagem foi enviada ao grupo.'));
  }
  console.log('═'.repeat(64) + '\n');

  // ── Resumo ao admin ───────────────────────────────────────────────────────────
  const adminMsg =
    `🔍 <b>SWEEP &amp; LEARN · ${agora}</b>\n\n` +
    `Sinais encontrados: <code>${antes.pending}</code>\n` +
    `Resultados fechados: <code>${corrigidos}</code>\n` +
    `✅ GREEN: <code>${novosGreen}</code>  ❌ RED: <code>${novosRed}</code>\n` +
    (corrigidos > 0 ? `📊 Precisão sessão: <code>${precisao}%</code>\n` : '') +
    `⏳ Ainda pendentes: <code>${depois.pending}</code>\n` +
    `⏱ Tempo: <code>${tempo}s</code>` +
    (DRY_RUN ? '\n\n<i>⚠️ Modo DRY-RUN — nenhuma mensagem enviada ao grupo</i>' : '');

  const r = await _sendAdminMsg(adminMsg);
  if (r?.ok) {
    console.log(chalk.gray('  📨 Resumo enviado ao admin.\n'));
  }
}

// ── Execução direta via CLI ────────────────────────────────────────────────────
const isCli = process.argv[1]?.endsWith('sweep-and-learn.js');
if (isCli) {
  runSweepAndLearn().catch(e => {
    console.error(chalk.red(`\n❌ ERRO: ${e.message}`));
    process.exit(1);
  });
}
