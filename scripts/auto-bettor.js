#!/usr/bin/env node
/**
 * auto-bettor.js — Daemon de apostas automáticas
 *
 * Fluxo:
 *  1. Ouve mensagens no grupo do Telegram (long polling)
 *  2. Detecta mensagens de análise do próprio bot
 *  3. Extrai: jogo, mercado, odds, URL da Superbet
 *  4. Calcula stake via Kelly criterion
 *  5. Chama superbet-placer.js para executar a aposta
 *  6. Loga resultado e notifica admin
 *
 * Uso:
 *   node scripts/auto-bettor.js           → modo real (AUTOBET_ENABLED=true required)
 *   node scripts/auto-bettor.js --dry-run → simula sem confirmar apostas
 *   node scripts/auto-bettor.js --login   → faz login e salva sessão
 *   node scripts/auto-bettor.js --status  → verifica sessão e configuração
 */

import 'dotenv/config';
import axios  from 'axios';
import chalk  from 'chalk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { placeBet, loginSuperbet, checkSession } from '../src/scrapers/superbet-placer.js';

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, '..');
const LOG_PATH = join(ROOT, 'data/auto-bets.json');
const DATA_DIR = join(ROOT, 'data');

// ── Configuração ──────────────────────────────────────────────────────────────
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_GROUP_ID,
  TELEGRAM_SIGNAL_GROUP_ID,
  TELEGRAM_ADMIN_USER_ID,
  SUPERBET_EMAIL,
  SUPERBET_PASSWORD,
  AUTOBET_ENABLED,
  BANKROLL_BRL,
  KELLY_FRACTION,
  MAX_STAKE_BRL,
  MAX_STAKE_PCT,
  MAX_DAILY_BETS,
} = process.env;

// Grupo de onde chegam os sinais (Fut Win Analytics)
// Se não configurado, usa o grupo padrão como fallback
const SIGNAL_GROUP_ID = TELEGRAM_SIGNAL_GROUP_ID || TELEGRAM_GROUP_ID;

const IS_ENABLED   = AUTOBET_ENABLED === 'true';
const DRY_RUN      = process.argv.includes('--dry-run') || !IS_ENABLED;
const BANKROLL     = parseFloat(BANKROLL_BRL)   || 1000;
const KELLY        = parseFloat(KELLY_FRACTION) || 0.25;
const MAX_STAKE    = parseFloat(MAX_STAKE_BRL)  || 50;
const MAX_STAKE_P  = parseFloat(MAX_STAKE_PCT)  || 5;
const MAX_BETS_DAY = parseInt(MAX_DAILY_BETS)   || 5;

const TG_API  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const SEP     = '─'.repeat(50);

// ── Setup ─────────────────────────────────────────────────────────────────────
function _ensureDirs() {
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function _loadLog() {
  if (!existsSync(LOG_PATH)) return [];
  try { return JSON.parse(readFileSync(LOG_PATH, 'utf8')); }
  catch { return []; }
}

function _saveLog(log) {
  try {
    const tmp = LOG_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(log, null, 2));
    // rename atômico — evita corrupção
    import('fs').then(fs => fs.renameSync(tmp, LOG_PATH)).catch(() => {
      writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
    });
  } catch (e) {
    console.warn(chalk.yellow('[Bettor] Falha ao salvar log:', e.message));
  }
}

function _countTodayBets() {
  const log   = _loadLog();
  const today = new Date().toISOString().slice(0, 10);
  return log.filter(b => b.placedAt?.startsWith(today) && b.success && !b.dryRun).length;
}

// ── Deduplicação de sinais ────────────────────────────────────────────────────
// Chave: "match|market|YYYY-MM-DD" — impede apostas duplicadas no mesmo dia
function _dedupKey(match, market) {
  const today = new Date().toISOString().slice(0, 10);
  return `${match.toLowerCase().trim()}|${market.toLowerCase().trim()}|${today}`;
}

function _alreadyBet(match, market) {
  const key = _dedupKey(match, market);
  const log = _loadLog();
  const today = new Date().toISOString().slice(0, 10);
  return log.some(b =>
    b.placedAt?.startsWith(today) &&
    b.match?.toLowerCase().trim() === match.toLowerCase().trim() &&
    b.market?.toLowerCase().trim() === market.toLowerCase().trim()
  );
}

// ── Cálculo de Stake (aleatório entre R$5–R$10) ───────────────────────────────
const RANDOM_STAKE_MIN = 5;
const RANDOM_STAKE_MAX = 10;

function calcStake(_prob, _odds) {
  // Stake aleatório para evitar padrão detectável nas apostas
  const raw = RANDOM_STAKE_MIN + Math.random() * (RANDOM_STAKE_MAX - RANDOM_STAKE_MIN);
  // Arredondar para centavos (ex: 7.43, 5.87, 9.12...)
  return Math.round(raw * 100) / 100;
}

// ── Parser de mensagem Telegram ────────────────────────────────────────────────
/**
 * Extrai todas as apostas de uma mensagem de análise do bot.
 * Suporta tanto PRÉ-LIVE quanto LIVE.
 *
 * @returns {Array<{match, competition, market, recommendation, minOdds, url, gameTime}>}
 */
function parseAnalysisMessage(text, entities) {
  if (!text) return [];

  const bets = [];

  // Extrair URL da Superbet (obrigatória)
  const urlMatch = text.match(/https:\/\/superbet\.bet\.br\/[^\s<"')]+/);
  if (!urlMatch) return []; // sem URL Superbet → ignorar

  const url = urlMatch[0].replace(/[>)'"]+$/, ''); // limpar possíveis resíduos

  // Extrair jogo
  // Formatos: "⚽  [+24h] Time A vs Time B" ou "⚽  Time A vs Time B"
  const matchMatch = text.match(/⚽\s+(?:\[.*?\]\s+)?([^\n]+)/);
  const match = matchMatch
    ? matchMatch[1].replace(/<[^>]+>/g, '').replace(/\[.*?\]/g, '').trim()
    : null;

  // Extrair competição
  const compMatch = text.match(/🏆\s+([^\n]+)/);
  const competition = compMatch ? compMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  // Extrair horário do jogo
  const timeMatch = text.match(/⏰\s+(\d{2}:\d{2})/);
  const dateMatch = text.match(/📅\s+.*?(\d{2}\/\d{2}\/\d{4}|\d{2}\/\d{2})/);

  // Extrair todos os mercados da mensagem
  // Padrão: "✅  {mercado}: {recomendação}   ...   Odds mín: {odds}"
  const marketRegex = /✅\s+([^:]+):\s+(?:<b>)?([^<✔\n]+?)(?:<\/b>)?(?:\s*✔)?\s+[🔴🟡🟢][^\n]*\n[^\n]*Odds mín:\s*(?:<b>)?(\d+[\.,]\d+)(?:<\/b>)?/g;

  let m;
  while ((m = marketRegex.exec(text)) !== null) {
    const marketRaw    = m[1].replace(/<[^>]+>/g, '').trim();
    const recRaw       = m[2].replace(/<[^>]+>/g, '').replace(/✔/g, '').trim().toUpperCase();
    const oddsRaw      = m[3].replace(',', '.');
    const minOdds      = parseFloat(oddsRaw) || null;

    if (!marketRaw || !minOdds) continue;

    bets.push({
      match:          match || 'Desconhecido',
      competition:    competition,
      market:         marketRaw,
      recommendation: recRaw,
      minOdds,
      url,
    });
  }

  // Fallback: tentar parse mais simples (uma aposta por mensagem)
  if (bets.length === 0) {
    const simpleMarket = text.match(/✅\s+([^:\n]+):/);
    const simpleRec    = text.match(/:\s+(?:<b>)?([A-ZÁÉÍÓÚ\s]+?)(?:<\/b>)?(?:\s*✔)/i);
    const simpleOdds   = text.match(/[Oo]dds\s+m[íi]n[^\d]*(\d+[\.,]\d+)/);

    if (simpleMarket && simpleOdds) {
      bets.push({
        match:          match || 'Desconhecido',
        competition,
        market:         simpleMarket[1].replace(/<[^>]+>/g, '').trim(),
        recommendation: simpleRec ? simpleRec[1].trim().toUpperCase() : 'APOSTAR',
        minOdds:        parseFloat((simpleOdds[1] || '1.5').replace(',', '.')),
        url,
      });
    }
  }

  return bets;
}

// ── Enviar resultado da aposta ao DM do admin (mesmo canal do Result Checker) ──
async function _notifyAdmin(text) {
  if (!TELEGRAM_ADMIN_USER_ID || !TELEGRAM_BOT_TOKEN) return;
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id:    TELEGRAM_ADMIN_USER_ID,
      text,
      parse_mode: 'HTML',
    });
  } catch (e) {
    console.warn(chalk.yellow('[Bettor] Falha ao notificar admin:', e.message));
  }
}

// ── Processar uma aposta extraída ─────────────────────────────────────────────
async function processBet(betData) {
  const { match, competition, market, recommendation, minOdds, url } = betData;

  console.log(chalk.white(`\n${SEP}`));
  console.log(chalk.white(`  🎰 APOSTA DETECTADA`));
  console.log(chalk.white(`  ${match} | ${competition}`));
  console.log(chalk.white(`  Mercado: ${market} — ${recommendation}`));
  console.log(chalk.white(`  Odds mín: ${minOdds} | URL: ${url.slice(0, 60)}...`));

  // ── Verificar duplicidade ────────────────────────────────────────────────────
  // Bloqueia sinal duplicado: mesmo jogo + mesmo mercado já apostado hoje
  if (_alreadyBet(match, market)) {
    const msg = `⚠️ Sinal duplicado ignorado: <b>${match}</b> — ${market} já apostado hoje.`;
    console.log(chalk.yellow(`[Bettor] Duplicado: ${match} | ${market} — ignorado.`));
    await _notifyAdmin(msg);
    return;
  }

  // Verificar limite diário
  const todayBets = _countTodayBets();
  if (!DRY_RUN && todayBets >= MAX_BETS_DAY) {
    const msg = `⛔ Limite diário atingido (${todayBets}/${MAX_BETS_DAY} apostas hoje). Aposta em ${match} ignorada.`;
    console.log(chalk.red(`[Bettor] ${msg}`));
    await _notifyAdmin(msg);
    return;
  }

  // Calcular stake
  // Usa prob de 80% como base (mínimo do gate) se não disponível na mensagem
  const prob  = betData.probabilidade || 80;
  const stake = calcStake(prob, minOdds);

  if (stake <= 0) {
    const msg = `⚠️ EV negativo para ${market} @ ${minOdds} — aposta ignorada (Kelly = 0).`;
    console.log(chalk.yellow(`[Bettor] ${msg}`));
    return;
  }

  console.log(chalk.cyan(`[Bettor] Kelly stake calculado: R$${stake.toFixed(2)} (bankroll R$${BANKROLL})`));

  // Executar aposta
  let result;
  try {
    result = await placeBet({ url, market, recommendation, minOdds, stake, dryRun: DRY_RUN });
  } catch (err) {
    result = { success: false, details: { error: err.message } };
  }

  // Registrar no log
  const logEntry = {
    id:             `bet_${Date.now()}`,
    match,
    competition,
    market,
    recommendation,
    minOdds,
    stake,
    url,
    success:        result.success,
    dryRun:         DRY_RUN,
    placedAt:       result.details?.placedAt || new Date().toISOString(),
    oddsObtained:   result.details?.oddsObtained || null,
    confirmed:      result.details?.confirmed || false,
    error:          result.details?.error || null,
  };

  const log = _loadLog();
  log.push(logEntry);
  _saveLog(log);

  // Notificar admin
  const icon   = result.success ? (DRY_RUN ? '🔵' : '✅') : '❌';
  const mode   = DRY_RUN ? '[DRY-RUN] ' : '';
  const errMsg = result.details?.error ? `\nErro: ${result.details.error}` : '';
  const notif  = `${icon} <b>Auto-Bet ${mode}</b>\n` +
    `⚽ ${match}\n` +
    `📊 ${market}: ${recommendation}\n` +
    `💰 Stake: R$${stake.toFixed(2)}  |  Odds mín: ${minOdds}\n` +
    `${result.success ? `🎯 ${DRY_RUN ? 'Pronto para confirmar' : `Odds obtidas: ${result.details?.oddsObtained || '?'}`}` : `❌ Falhou${errMsg}`}`;

  await _notifyAdmin(notif);
  console.log(result.success
    ? chalk.green(`[Bettor] ✅ Aposta ${DRY_RUN ? 'simulada' : 'colocada'}: R$${stake.toFixed(2)} em ${market}`)
    : chalk.red(`[Bettor] ❌ Falha: ${result.details?.error}`));
}

// ── Long polling do Telegram ──────────────────────────────────────────────────
let _lastUpdateId = 0;

async function _getUpdates() {
  try {
    const res = await axios.get(`${TG_API}/getUpdates`, {
      params: {
        offset:          _lastUpdateId + 1,
        timeout:         25,   // long polling: aguarda 25s
        allowed_updates: ['message', 'channel_post'],
      },
      timeout: 30_000,
    });
    return res.data?.result || [];
  } catch (e) {
    if (e.code !== 'ECONNABORTED') {
      console.warn(chalk.yellow(`[Bettor] Erro no getUpdates: ${e.message}`));
    }
    return [];
  }
}

// Verifica se é mensagem de sinal no grupo Fut Win Analytics
function _isBotAnalysis(update) {
  const msg = update.message || update.channel_post;
  if (!msg) return false;

  const chatId  = String(msg.chat?.id  || msg.chat?.username || '');
  const groupId = String(SIGNAL_GROUP_ID || '');

  // Aceita mensagens do grupo de sinais (Fut Win Analytics)
  if (!chatId.includes(groupId.replace('-', '')) && !groupId.includes(chatId.replace('-', ''))) return false;

  const text = msg.text || msg.caption || '';

  // Identificar mensagens de análise do bot (contém URL da Superbet + marcador de análise)
  return text.includes('superbet.bet.br') &&
    (text.includes('PRÉ-LIVE') || text.includes('LIVE') || text.includes('⚽')) &&
    text.includes('✅');
}

// ── API pública: chamada pelo scheduler dentro do loop Guardian ───────────────
// Recebe um update do getUpdates já feito pelo Guardian e processa se for sinal
export async function processBetSignal(update) {
  if (!_isBotAnalysis(update)) return;
  const msg  = update.message || update.channel_post;
  const text = msg.text || msg.caption || '';
  console.log(chalk.cyan(`\n[Bettor] 📨 Sinal detectado via Guardian (msg_id: ${msg.message_id})`));
  const bets = parseAnalysisMessage(text);
  if (!bets.length) {
    console.log(chalk.gray('[Bettor] Nenhuma aposta extraível neste sinal.'));
    return;
  }
  for (const bet of bets) {
    await processBet(bet);
    await _sleep(3000);
  }
}

// ── Loop principal (standalone — não usar quando scheduler já faz polling) ────
async function main() {
  _ensureDirs();

  const mode = DRY_RUN ? chalk.yellow('DRY-RUN') : chalk.green('REAL');
  console.log('\n' + '═'.repeat(50));
  console.log(`  🤖 AUTO-BETTOR  |  Modo: ${mode}`);
  console.log('═'.repeat(50));
  console.log(`  Bankroll:   R$${BANKROLL}`);
  console.log(`  Kelly:      ${(KELLY * 100).toFixed(0)}%`);
  console.log(`  Max stake:  R$${MAX_STAKE} / ${MAX_STAKE_P}% do bankroll`);
  console.log(`  Max/dia:    ${MAX_BETS_DAY} apostas`);
  console.log(`  Sinais de:  ${SIGNAL_GROUP_ID} (Fut Win Analytics)`);
  console.log(`  Notifica:   ${TELEGRAM_GROUP_ID} (Fut Turbo Analise)`);
  console.log('═'.repeat(50));

  // ── Modo --login ─────────────────────────────────────────────────────────
  if (process.argv.includes('--login')) {
    if (!SUPERBET_EMAIL || !SUPERBET_PASSWORD) {
      console.error(chalk.red('Configure SUPERBET_EMAIL e SUPERBET_PASSWORD no .env'));
      process.exit(1);
    }
    await loginSuperbet(SUPERBET_EMAIL, SUPERBET_PASSWORD);
    return;
  }

  // ── Modo --status ────────────────────────────────────────────────────────
  if (process.argv.includes('--status')) {
    console.log('\nVerificando configuração...');
    const checks = {
      'TELEGRAM_BOT_TOKEN': !!TELEGRAM_BOT_TOKEN,
      'TELEGRAM_GROUP_ID':  !!TELEGRAM_GROUP_ID,
      'SUPERBET_EMAIL':     !!SUPERBET_EMAIL,
      'SUPERBET_PASSWORD':  !!SUPERBET_PASSWORD,
      'BANKROLL_BRL':       !!BANKROLL_BRL,
      'AUTOBET_ENABLED':    IS_ENABLED,
    };
    for (const [k, v] of Object.entries(checks)) {
      console.log(`  ${v ? chalk.green('✅') : chalk.red('❌')}  ${k}`);
    }
    const sessionOk = await checkSession();
    console.log(`  ${sessionOk ? chalk.green('✅') : chalk.yellow('⚠️')}  Sessão Superbet${sessionOk ? ' ativa' : ' expirada (rode --login)'}`);
    return;
  }

  // Validar credenciais obrigatórias
  if (!TELEGRAM_BOT_TOKEN) { console.error(chalk.red('TELEGRAM_BOT_TOKEN não configurado')); process.exit(1); }
  if (!TELEGRAM_GROUP_ID)  { console.error(chalk.red('TELEGRAM_GROUP_ID não configurado'));  process.exit(1); }

  if (!IS_ENABLED && !DRY_RUN) {
    console.log(chalk.yellow('\n⚠️  AUTOBET_ENABLED=false — rodando em DRY-RUN.'));
    console.log(chalk.yellow('   Para apostas reais: defina AUTOBET_ENABLED=true no .env\n'));
  }

  console.log(chalk.cyan('\n[Bettor] Monitorando grupo... (Ctrl+C para parar)\n'));

  // Loop de long polling
  while (true) {
    const updates = await _getUpdates();

    for (const update of updates) {
      _lastUpdateId = update.update_id;

      if (!_isBotAnalysis(update)) continue;

      const msg  = update.message || update.channel_post;
      const text = msg.text || msg.caption || '';

      console.log(chalk.cyan(`\n[Bettor] 📨 Análise detectada (msg_id: ${msg.message_id})`));

      const bets = parseAnalysisMessage(text);

      if (!bets.length) {
        console.log(chalk.gray('[Bettor] Nenhuma aposta extraível nesta mensagem.'));
        continue;
      }

      console.log(chalk.white(`[Bettor] ${bets.length} aposta(s) extraída(s) da mensagem`));

      for (const bet of bets) {
        await processBet(bet);
        await _sleep(3000); // intervalo entre apostas da mesma análise
      }
    }

    // Sem updates: aguardar um pouco antes de novo polling
    if (updates.length === 0) {
      await _sleep(1000);
    }
  }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n[Bettor] Parando... (SIGINT)'));
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n[Bettor] Parando... (SIGTERM)'));
  process.exit(0);
});

// Só inicia o loop quando executado diretamente (não quando importado como módulo)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(chalk.red('\n[Bettor] ERRO FATAL:', err.message));
    console.error(err.stack);
    process.exit(1);
  });
}
