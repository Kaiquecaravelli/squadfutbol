#!/usr/bin/env node
/**
 * place-bet-now.js — Auto-Bettor acionado pelo Dashboard (localhost:3000)
 *
 * Fluxo: Dashboard → seleciona aposta → Aplicar → este script →
 *        Playwright abre Superbet → coloca aposta → grava resultado em JSON
 *        ← Dashboard lê status via polling /api/autobet/status/:entryId
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { placeBet, findGameOnLivePage } from '../src/scrapers/superbet-placer.js';

const __dir  = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dir, '..');
const DATA   = join(ROOT, 'data');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Helpers de args ───────────────────────────────────────────────────────────
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.split('=').slice(1).join('=') || null;

// ── Gravar status para o dashboard ───────────────────────────────────────────
function writeStatus(entryId, status, extra = {}) {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(
      join(DATA, `autobet-result-${entryId}.json`),
      JSON.stringify({ entryId, status, updatedAt: new Date().toISOString(), ...extra }, null, 2),
      'utf8',
    );
  } catch (e) {
    console.warn('[Status] Falha ao gravar status:', e.message);
  }
}

// ── Normaliza labels do dashboard → chaves do MARKET_MAP ─────────────────────
function normMarket(label) {
  const MAP = {
    'Casa Vence': 'Home Win', 'Fora Vence': 'Away Win', 'Empate': 'Draw',
    '1X (Casa ou Emp.)': '1X', 'X2 (Emp. ou Fora)': 'X2', '12 (Casa ou Fora)': '12',
    'Over 2.5 Cartões': 'Over YC 2.5', 'Over 3.5 Cartões': 'Over YC 3.5', 'Over 4.5 Cartões': 'Over YC 4.5',
  };
  return MAP[label] || label;
}

function deriveRec(market) {
  const m = (market || '').toLowerCase();
  if (m.includes('btts') || m.includes('ambas'))        return 'SIM';
  if (m.startsWith('under') || m.includes('menos de'))  return 'UNDER';
  if (m === 'empate' || m === 'draw')                    return 'X';
  if (m === 'casa vence' || m === 'home win')            return '1';
  if (m === 'fora vence' || m === 'away win')            return '2';
  if (m.startsWith('1x'))                               return '1X';
  if (m.startsWith('x2'))                               return 'X2';
  if (m.startsWith('12'))                               return '12';
  return 'APOSTAR';
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const entryId      = arg('entry-id')  || String(Date.now());
  const argUrl       = arg('url');
  const argHome      = arg('home');
  const argAway      = arg('away');
  const argMatch     = arg('match');
  const argMarket    = arg('market');
  const argRec       = arg('recommendation');
  const argStake     = parseFloat(arg('stake') || '2.00');
  const argProb      = arg('prob')      || '—';
  const argComp      = arg('competition') || '—';

  const marketLabel  = argMarket  || 'Over 1.5';
  const marketKey    = normMarket(marketLabel);
  const recommendation = argRec || deriveRec(marketLabel);
  const minOdds      = 1.10;

  if (!argUrl && !argHome) {
    writeStatus(entryId, 'error', { error: 'URL ou times não fornecidos' });
    console.error(chalk.red('❌ --url ou --home/--away obrigatórios'));
    process.exit(1);
  }

  const matchName = argMatch
    || (argHome && argAway ? `${argHome} vs ${argAway}` : 'Jogo');

  // ── 1. Gravar status inicial ─────────────────────────────────────────────
  writeStatus(entryId, 'starting', { match: matchName, market: marketKey, recommendation });
  console.log(chalk.bold(`\n🤖 AUTO-BETTOR — ${matchName}`));
  console.log(`   Mercado:  ${marketKey} (${recommendation})`);
  console.log(`   Stake:    R$${argStake.toFixed(2)}`);
  console.log(`   Prob:     ${argProb}%`);
  console.log(`   Modo:     ${DRY_RUN ? 'DRY-RUN' : 'REAL'}\n`);

  // ── 2. Resolver URL ──────────────────────────────────────────────────────
  let resolvedUrl = argUrl || null;

  if (!resolvedUrl && argHome && argAway) {
    writeStatus(entryId, 'searching', { match: matchName, market: marketKey, step: `Buscando "${argHome} vs ${argAway}" na Superbet` });
    console.log(chalk.cyan(`[AutoBet] Sem URL — buscando "${argHome} vs ${argAway}" ao vivo...`));

    resolvedUrl = await findGameOnLivePage(argHome, argAway);

    if (!resolvedUrl) {
      writeStatus(entryId, 'error', {
        match: matchName, market: marketKey,
        error: `Jogo "${matchName}" não encontrado na Superbet. Pode não estar disponível para apostas ao vivo.`,
      });
      console.error(chalk.red(`❌ Jogo não encontrado na Superbet`));
      process.exit(1);
    }
    console.log(chalk.green(`[AutoBet] URL encontrada: ${resolvedUrl}`));
  }

  // ── 3. Gravar status "colocando aposta" ──────────────────────────────────
  writeStatus(entryId, 'placing', {
    match: matchName, market: marketKey, recommendation,
    superbetUrl: resolvedUrl,
    step: `Abrindo Superbet e localizando mercado "${marketKey}"`,
  });

  // ── 4. Executar aposta via Playwright ────────────────────────────────────
  console.log(chalk.cyan(`[AutoBet] Abrindo Superbet: ${resolvedUrl}`));
  let result;
  try {
    result = await placeBet({
      url:            resolvedUrl,
      market:         marketKey,
      recommendation,
      minOdds,
      stake:          argStake,
      dryRun:         DRY_RUN,
    });
  } catch (err) {
    result = { success: false, details: { error: err.message } };
  }

  // ── 5. Gravar resultado final ────────────────────────────────────────────
  if (result.success) {
    console.log(chalk.green(`\n✅ Aposta ${DRY_RUN ? 'simulada' : 'colocada'}: ${marketKey} @ ${result.details?.oddsObtained || '?'}`));
    writeStatus(entryId, 'success', {
      match:       matchName,
      market:      marketKey,
      recommendation,
      superbetUrl: resolvedUrl,
      odds:        result.details?.oddsObtained,
      stake:       argStake,
      dryRun:      DRY_RUN,
      competition: argComp,
      prob:        argProb,
      screenshot:  result.details?.screenshot || null,
    });
  } else {
    const errMsg = result.details?.error || 'Falha desconhecida';
    console.error(chalk.red(`\n❌ Falha: ${errMsg}`));
    writeStatus(entryId, 'error', {
      match:       matchName,
      market:      marketKey,
      superbetUrl: resolvedUrl,
      error:       errMsg,
      screenshot:  result.details?.screenshot || null,
    });
    process.exit(1);
  }
}

main().catch(err => {
  const entryId = arg('entry-id') || 'unknown';
  writeStatus(entryId, 'error', { error: err.message });
  console.error(chalk.red('ERRO FATAL:'), err.message);
  process.exit(1);
});
