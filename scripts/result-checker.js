/**
 * result-checker.js — Verifica resultados de análises enviadas ao Telegram
 *
 * Para cada análise pendente em data/pending-analyses.json:
 *  1. Consulta o SofaScore para saber se o jogo terminou
 *  2. Avalia se a predição foi GREEN ✅ ou RED ❌
 *  3. Envia um reply à mensagem original no Telegram com o resultado
 *  4. Apaga a mensagem original após o reply
 *  5. Salva o resultado no PIE para calibração contínua
 *
 * Uso:
 *   node scripts/result-checker.js              → processa todas pendentes
 *   node scripts/result-checker.js --dry-run    → mostra o que faria, sem enviar
 */
import 'dotenv/config';
import axios from 'axios';
import chalk from 'chalk';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getPendingAnalyses,
  resolvePendingAnalysis,
  notifyResultFeedback,
  getAllPendingAnalyses,
} from '../src/utils/telegram.js';
import { resolveTeamName } from '../src/utils/team-aliases.js';
import { saveResult, getPendingPredictions } from '../src/pie/pie-storage.js';
import { isObsidianConfigured, updateAnaliseNoteResult } from '../src/utils/obsidian.js';

const ROOT               = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN            = process.argv.includes('--dry-run');
const SOFASCORE_BASE     = 'https://api.sofascore.com/api/v1';
const DELAY_MS           = 1200;
const MAX_RETRIES        = 10;
const FAILED_CHECKS_PATH = join(ROOT, 'data/failed-checks.json');
const PENDING_PATH       = join(ROOT, 'data/pending-analyses.json');
const HEADERS            = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':     'application/json',
  'Referer':    'https://www.sofascore.com/',
};

// ── Avalia se a predição acertou (score + stats opcionais + entry para context) ──
function determineOutcome(market, prediction, score, entry = {}, stats = null) {
  if (score.home == null || score.away == null) return null;

  // Usa placar do tempo normal (90min) — ignora prorrogação/pênaltis
  const homeGoals = score.normaltime_home ?? score.home;
  const awayGoals = score.normaltime_away ?? score.away;
  const total = homeGoals + awayGoals;
  const rec   = String(prediction || '').toUpperCase().trim();
  const mkt   = (market || '').toUpperCase();

  // ── Gols Over/Under (pelo nome do mercado com limiar embutido) ───────────────
  if (market.includes('Over 0.5'))  return total > 0;
  if (market.includes('Over 1.5'))  return total > 1;
  if (market.includes('Over 2.5'))  return total > 2;
  if (market.includes('Over 3.5'))  return total > 3;
  if (market.includes('Over 4.5'))  return total > 4;
  if (market.includes('Over 5.5'))  return total > 5;
  if (market.includes('Under 0.5')) return total < 1;
  if (market.includes('Under 1.5')) return total < 2;
  if (market.includes('Under 2.5')) return total < 3;
  if (market.includes('Under 3.5')) return total < 4;
  if (market.includes('Under 4.5')) return total < 5;

  // ── Gols Over/Under — mercado genérico "Gols" → limiar extraído do messageText ──
  if (mkt === 'GOLS' || mkt === 'TOTAL GOLS') {
    const thresh = _extractThresholdFromText(entry.messageText, 'Gols');
    if (!thresh?.threshold) return null;
    const isOver = thresh.direction === 'OVER';
    return isOver ? total > thresh.threshold : total < thresh.threshold;
  }

  // ── BTTS / Ambas Marcam ──────────────────────────────────────────────────────
  if (mkt.includes('BTTS') || mkt.includes('AMBAS')) {
    const bttsOk = homeGoals > 0 && awayGoals > 0;
    if (rec === 'NÃO' || rec === 'NAO' || rec === 'NO' || rec === 'NÃO MARCAM') return !bttsOk;
    return bttsOk;
  }

  // ── Escanteios — limiar extraído do messageText + stats do SofaScore ─────────
  if (mkt.includes('ESCANTEIO') || mkt.includes('CORNER')) {
    const thresh = _extractThresholdFromText(entry.messageText, 'Escanteios');
    if (!thresh?.threshold || !stats) return null;
    // SofaScore nomeia: 'corner_kicks', 'corners', 'corner kicks'
    const ck = stats['corner_kicks'] || stats['corners'] || stats['corner_kicks_h1'];
    if (!ck) return null;
    const totalCorners = (ck.home || 0) + (ck.away || 0);
    return thresh.direction === 'OVER' ? totalCorners > thresh.threshold : totalCorners < thresh.threshold;
  }

  // ── Cartões Amarelos — limiar extraído do messageText + stats SofaScore ──────
  if (mkt.includes('CARTÃO') || mkt.includes('CARTAO') || mkt.includes('AMARELO') || mkt.includes('YC')) {
    const thresh = _extractThresholdFromText(entry.messageText, 'Cartões Amarelos');
    if (!thresh?.threshold || !stats) return null;
    const yc = stats['yellow_cards'] || stats['yellow card'] || stats['yellow_card'];
    if (!yc) return null;
    const totalYC = (yc.home || 0) + (yc.away || 0);
    return thresh.direction === 'OVER' ? totalYC > thresh.threshold : totalYC < thresh.threshold;
  }

  // ── Resultado — genéricos home/away verificados ANTES de "Resultado Final {time}" ──
  if (mkt.includes('RESULTADO FINAL CASA') || mkt.includes('HOME WIN') || market === '1')
    return homeGoals > awayGoals;
  if (mkt.includes('RESULTADO FINAL FORA') || mkt.includes('AWAY WIN') || market === '2')
    return awayGoals > homeGoals;
  if (mkt.includes('DRAW') || mkt.includes('EMPATE') || market === 'X')
    return homeGoals === awayGoals;

  // ── "Resultado Final {time}" — identifica time pelo nome ────────────────────
  if (mkt.includes('RESULTADO FINAL')) {
    const [homeTeam, awayTeam] = (entry.match || '').split(/\s+vs\s+/i);
    const teamInMarket = market.replace(/resultado final/i, '').trim().toLowerCase();
    if (teamInMarket.length >= 3) {
      const isHomeTeam = homeTeam && homeTeam.toLowerCase().includes(teamInMarket.slice(0, 6));
      const isAwayTeam = awayTeam && awayTeam.toLowerCase().includes(teamInMarket.slice(0, 6));
      if (isHomeTeam) return homeGoals > awayGoals;
      if (isAwayTeam) return awayGoals > homeGoals;
    }
    // Tenta extrair do messageText
    const thresh = _extractThresholdFromText(entry.messageText, 'Resultado Final');
    if (thresh?.variant) {
      if (thresh.variant === '1' || thresh.variant === 'CASA') return homeGoals > awayGoals;
      if (thresh.variant === 'X' || thresh.variant === 'EMPATE') return homeGoals === awayGoals;
      if (thresh.variant === '2' || thresh.variant === 'FORA') return awayGoals > homeGoals;
    }
    return null;
  }

  // ── Dupla Chance ─────────────────────────────────────────────────────────────
  if (market === '1X' || mkt.includes('DUPLA CHANCE 1X')) return homeGoals >= awayGoals;
  if (market === 'X2' || mkt.includes('DUPLA CHANCE X2')) return awayGoals >= homeGoals;
  if (market === '12' || mkt.includes('DUPLA CHANCE 12')) return homeGoals !== awayGoals;

  // "Dupla Chance" genérico — extrai variante do messageText
  if (mkt.includes('DUPLA CHANCE') || mkt === 'DUPLA') {
    const thresh = _extractThresholdFromText(entry.messageText, 'Dupla Chance');
    if (thresh?.variant === '1X') return homeGoals >= awayGoals;
    if (thresh?.variant === 'X2') return awayGoals >= homeGoals;
    if (thresh?.variant === '12') return homeGoals !== awayGoals;
    return null;
  }

  return null;
}

// ── Extrai limiar e direção do messageText para mercados Escanteios/Cartões/Gols ──
// Suporta mensagens antigas onde "Escanteios" era exibido como "Gols" (bug corrigido).
function _extractThresholdFromText(messageText, marketCategory) {
  if (!messageText) return null;
  const catUpper = (marketCategory || '').toUpperCase();

  // Dupla Chance — extrai variante (1X/X2/12)
  if (catUpper.includes('DUPLA') || catUpper.includes('CHANCE')) {
    const dupla = messageText.match(/dupla chance[^<]*<b>(1x|x2|12)<\/b>/i);
    return dupla ? { variant: dupla[1].toUpperCase() } : null;
  }

  // Resultado Final — extrai resultado (1/X/2/Casa/Fora/Empate)
  if (catUpper.includes('RESULTADO FINAL')) {
    const res = messageText.match(/resultado final[^<]*<b>(1|x|2|casa|fora|empate)[^<]*<\/b>/i);
    return res ? { variant: res[1].toUpperCase() } : null;
  }

  // Para Escanteios/Cartões/Gols: tenta padrão específico da categoria primeiro,
  // depois fallback em qualquer Over/Under no texto (cobre mensagens antigas com label errado)
  let specificPattern;
  if (catUpper.includes('ESCANTEIO') || catUpper.includes('CORNER')) {
    specificPattern = /escanteio[^<]*<b>(over|under)\s*([\d.]+)<\/b>/i;
  } else if (catUpper.includes('CARTÃO') || catUpper.includes('CARTAO') || catUpper.includes('AMARELO') || catUpper.includes('YC')) {
    specificPattern = /cart[oõãa][eõ]?s?[^<]*<b>(over|under)\s*([\d.]+)<\/b>/i;
  } else if (catUpper.includes('GOL') || catUpper.includes('TOTAL')) {
    specificPattern = /gols?[^<]*<b>(over|under)\s*([\d.]+)<\/b>/i;
  }

  // Tenta padrão específico
  if (specificPattern) {
    const m = messageText.match(specificPattern);
    if (m) return { direction: m[1].toUpperCase(), threshold: parseFloat(m[2]) };
  }

  // Fallback: extrai qualquer Over/Under de uma linha de mercado do messageText
  // Cobre casos onde o label estava errado (ex: Escanteios exibido como "Gols")
  const fallback = messageText.match(/<b>(over|under)\s*([\d.]+)<\/b>/i);
  if (fallback) return { direction: fallback[1].toUpperCase(), threshold: parseFloat(fallback[2]), fallback: true };

  return null;
}

// ── Busca stats de escanteios e cartões via SofaScore ────────────────────────
async function fetchEventStats(sofascoreId) {
  try {
    const { data } = await axios.get(`${SOFASCORE_BASE}/event/${sofascoreId}/statistics`, {
      headers: HEADERS, timeout: 8000,
    });
    const periods = data?.statistics || [];
    const allPeriod = periods.find(p => p.period === 'ALL') || periods[periods.length - 1];
    if (!allPeriod?.groups) return null;

    const stats = {};
    for (const group of allPeriod.groups) {
      for (const item of group.statisticsItems || []) {
        const key = (item.name || '').toLowerCase().replace(/\s+/g, '_');
        if (key) stats[key] = { home: parseFloat(item.home) || 0, away: parseFloat(item.away) || 0 };
      }
    }
    return stats;
  } catch {
    return null;
  }
}

// ── Busca resultado no SofaScore por ID do evento (placar + stats) ───────────
async function fetchByEventId(sofascoreId) {
  try {
    const { data } = await axios.get(`${SOFASCORE_BASE}/event/${sofascoreId}`, {
      headers: HEADERS, timeout: 8000,
    });
    const event = data?.event;
    if (!event) return null;

    const status = event.status?.type;
    if (status !== 'finished') return { status, score: null };

    // Usa placar do tempo normal (90min) — preferência sobre current que inclui prorrogação
    const home = event.homeScore?.normaltime ?? event.homeScore?.current;
    const away = event.awayScore?.normaltime ?? event.awayScore?.current;
    if (home == null || away == null) return { status, score: null };

    // Busca stats: escanteios e cartões (independente do mercado, custo ~1 req extra)
    const stats = await fetchEventStats(sofascoreId);

    return {
      status: 'finished',
      score:  { home: Number(home), away: Number(away) },
      stats,
      label:  `${event.homeTeam?.name} ${home}-${away} ${event.awayTeam?.name}`,
    };
  } catch (err) {
    if (err.response?.status === 429 || err.response?.status === 503)
      return { status: 'rate_limited', score: null, retryAfter: 60_000 };
    return null;
  }
}

// ── Busca por nome do jogo + data (tenta data fornecida ±1 dia) ──────────────
async function fetchByMatchName(matchName, dateStr) {
  const [homeSearch, awaySearch] = (matchName || '').split(/\s+vs\s+/i);
  if (!homeSearch || !awaySearch) return null;

  const hKey = homeSearch.toLowerCase().trim();
  const aKey = awaySearch.toLowerCase().trim();

  // Resolve aliases (ex: "PSG" → "paris saint-germain")
  const hResolved = resolveTeamName(hKey);
  const aResolved = resolveTeamName(aKey);

  // Gera janela de datas: data fornecida + dia anterior + dia seguinte
  const base = new Date((dateStr || new Date().toISOString()).split('T')[0] + 'T00:00:00Z');
  const dates = [
    new Date(base.getTime() - 86_400_000).toISOString().split('T')[0],
    base.toISOString().split('T')[0],
    new Date(base.getTime() + 86_400_000).toISOString().split('T')[0],
  ];

  for (const date of dates) {
    try {
      const { data } = await axios.get(`${SOFASCORE_BASE}/sport/football/scheduled-events/${date}`, {
        headers: HEADERS, timeout: 8000,
      });
      const events = data?.events || [];

      const found = events.find(e => {
        const hn = (e.homeTeam?.name || '').toLowerCase();
        const an = (e.awayTeam?.name || '').toLowerCase();
        // Tenta match com 5 chars (mais tolerante que 6 para nomes curtos)
        const hMatch = hn.includes(hKey.slice(0, 5)) || hn.includes(hResolved.slice(0, 5));
        const aMatch = an.includes(aKey.slice(0, 5)) || an.includes(aResolved.slice(0, 5));
        return hMatch && aMatch;
      });

      if (!found) continue;
      if (found.status?.type !== 'finished') {
        return { status: found.status?.type, score: null };
      }

      const home = found.homeScore?.normaltime ?? found.homeScore?.current;
      const away = found.awayScore?.normaltime ?? found.awayScore?.current;
      if (home == null || away == null) continue;

      const foundStats = await fetchEventStats(String(found.id));
      return {
        status:      'finished',
        score:       { home: Number(home), away: Number(away) },
        stats:       foundStats,
        label:       `${found.homeTeam?.name} ${home}-${away} ${found.awayTeam?.name}`,
        sofascoreId: String(found.id),
      };
    } catch (err) {
      if (err.response?.status === 429 || err.response?.status === 503)
        return { status: 'rate_limited', score: null, retryAfter: 60_000 };
      continue;
    }
  }

  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Dead-letter queue ─────────────────────────────────────────────────────────
function _moveToDeadLetter(entry, reason) {
  let failed = [];
  try { failed = JSON.parse(readFileSync(FAILED_CHECKS_PATH, 'utf8')); } catch { /* não existe ainda */ }
  failed.push({ ...entry, failedAt: new Date().toISOString(), reason, status: 'failed' });
  writeFileSync(FAILED_CHECKS_PATH, JSON.stringify(failed, null, 2));
  resolvePendingAnalysis(entry.id, { acertou: null, placarReal: null, resultMsgId: null, pieSaved: false });
  console.log(chalk.yellow(`[DeadLetter] ${entry.match} [${entry.market}] → ${reason}`));
}

function _incrementRetries(id) {
  let pending = [];
  try { pending = JSON.parse(readFileSync(PENDING_PATH, 'utf8')); } catch { return; }
  const idx = pending.findIndex(e => e.id === id);
  if (idx === -1) return;
  pending[idx].retries = (pending[idx].retries || 0) + 1;
  writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
}

function _setNextRetry(id, ts) {
  let pending = [];
  try { pending = JSON.parse(readFileSync(PENDING_PATH, 'utf8')); } catch { return; }
  const idx = pending.findIndex(e => e.id === id);
  if (idx === -1) return;
  pending[idx].nextRetry = ts;
  writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
}

// ── Health alert ao admin ─────────────────────────────────────────────────────
let _consecutiveSkips = 0;

async function _notifyAdminHealthAlert(pendingCount, consecutiveSkips) {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
  if (!token || !adminId) {
    console.log(chalk.yellow(`[HealthAlert] ${pendingCount} análise(s) sem resolução após ${consecutiveSkips} execuções consecutivas. (TELEGRAM_ADMIN_USER_ID não configurado)`));
    _consecutiveSkips = 0;
    return;
  }
  const text = `⚠️ Result Checker — ${pendingCount} análise(s) pendente(s) sem resolução após ${consecutiveSkips} execuções consecutivas. SofaScore pode estar instável.`;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: adminId,
      text,
    });
  } catch (e) {
    console.warn(chalk.yellow(`[HealthAlert] Falha ao enviar DM ao admin: ${e.message}`));
  }
  _consecutiveSkips = 0;
}

// ── Pipeline principal ────────────────────────────────────────────────────────
// ── Recuperação de PIE: reprocessa resolvidos que não foram gravados ─────────
async function recoverMissingPieData() {
  const all = getAllPendingAnalyses();
  const sem  = all.filter(e =>
    e.status === 'resolved' &&
    e.pieSaved !== true &&
    e.acertou !== null &&
    e.acertou !== undefined &&
    e.placarReal
  );

  if (!sem.length) return;
  console.log(chalk.cyan(`  🔄 Recuperando ${sem.length} resultado(s) não gravados no PIE...`));

  const piePending = getPendingPredictions();

  for (const entry of sem) {
    try {
      const matchKey = (entry.match || '').toLowerCase().slice(0, 12);
      const piePred  = piePending.find(p =>
        (p.match_name || '').toLowerCase().includes(matchKey)
      );

      saveResult({
        predictionId:  piePred?.id || null,
        matchName:     entry.match,
        placarReal:    entry.placarReal,
        competition:   entry.competition || '',
        marketOutcomes: [{
          market:        entry.market,
          recomendacao:  entry.prediction,
          probabilidade: entry.probabilidade,
          acertou:       entry.acertou,
        }],
      });

      // Marca como gravado
      resolvePendingAnalysis(entry.id, {
        acertou:     entry.acertou,
        placarReal:  entry.placarReal,
        resultMsgId: entry.resultMsgId,
        pieSaved:    true,
      });

      console.log(chalk.cyan(`    ✅ Recuperado: ${entry.match} [${entry.market}]`));
    } catch (e) {
      console.warn(chalk.yellow(`    ⚠ Falha na recuperação de ${entry.match}: ${e.message}`));
    }
  }
}

export async function runResultChecker() {
  console.log('\n' + '═'.repeat(64));
  console.log('  🔍 Result Checker — Fechamento de Ciclo GREEN/RED');
  console.log(`  Modo: ${DRY_RUN ? 'DRY-RUN (sem enviar)' : 'REAL'}`);
  console.log('═'.repeat(64) + '\n');

  // Recupera resultados resolvidos que porventura não foram gravados no PIE
  if (!DRY_RUN) await recoverMissingPieData();

  const pending = getPendingAnalyses();
  if (!pending.length) {
    console.log(chalk.gray('  Nenhuma análise pendente de resultado.'));
    return;
  }

  console.log(chalk.white(`  ${pending.length} análise(s) pendente(s)\n`));

  let greens = 0, reds = 0, skipped = 0;

  for (const entry of pending) {
    // Melhoria 2: pula silenciosamente entradas em cooldown de rate-limit
    if (entry.nextRetry && Date.now() < entry.nextRetry) {
      skipped++;
      continue;
    }

    const label = `${entry.match} [${entry.market}]`;
    process.stdout.write(`  → ${label.substring(0, 50).padEnd(50)}  `);

    try {
      // 1. Buscar resultado no SofaScore
      let result = null;

      if (entry.sofascoreId) {
        result = await fetchByEventId(entry.sofascoreId);
      }

      if (!result || (result.status !== 'finished' && result.status !== 'rate_limited')) {
        // Tenta por nome se não tem ID ou jogo não terminou ainda
        const dateToSearch = entry.gameTime || entry.sentAt;
        result = await fetchByMatchName(entry.match, dateToSearch);
      }

      // Melhoria 2: rate limit detectado
      if (result?.status === 'rate_limited') {
        const retryAfter = result.retryAfter || 60_000;
        _setNextRetry(entry.id, Date.now() + retryAfter);
        console.log(chalk.gray(`[RateLimit] aguardando ${Math.round(retryAfter / 1000)}s`));
        skipped++;
        await sleep(DELAY_MS);
        continue;
      }

      if (!result) {
        // Melhoria 1: dead-letter após MAX_RETRIES tentativas sem resposta
        entry.retries = (entry.retries || 0) + 1;
        _incrementRetries(entry.id);
        if (entry.retries >= MAX_RETRIES) {
          _moveToDeadLetter(entry, `SofaScore indisponível após ${entry.retries} tentativas`);
        } else {
          console.log(chalk.gray(`SofaScore indisponível — pular (tentativa ${entry.retries}/${MAX_RETRIES})`));
        }
        skipped++;
        await sleep(DELAY_MS);
        continue;
      }

      if (result.status !== 'finished') {
        console.log(chalk.yellow(`Em andamento (${result.status || '?'}) — aguardar`));
        skipped++;
        await sleep(DELAY_MS);
        continue;
      }

      // 2. Avaliar resultado (passa stats do SofaScore para mercados de escanteios/cartões)
      const acertou = determineOutcome(entry.market, entry.prediction, result.score, entry, result.stats);

      if (acertou === null) {
        console.log(chalk.yellow('Resultado não verificável para este mercado'));
        skipped++;
        await sleep(DELAY_MS);
        continue;
      }

      const placarReal = `${result.score.home}-${result.score.away}`;
      const icon       = acertou ? chalk.green('✅ GREEN') : chalk.red('❌ RED');
      console.log(`${icon}  ${placarReal}`);

      if (DRY_RUN) {
        skipped++;
        await sleep(DELAY_MS);
        continue;
      }

      // 3. Enviar reply GREEN/RED e apagar mensagem original
      const resultMsgId = await notifyResultFeedback({
        msgId:        entry.msgId,
        acertou,
        match:        entry.match,
        market:       entry.market,
        prediction:   entry.prediction,
        placarReal,
        probabilidade: entry.probabilidade,
        competition:  entry.competition,
        originalText: entry.messageText || null,  // texto original para edição
      });

      // 4. Salvar no PIE para calibração — obrigatório antes de resolver a entrada
      let pieSaved = false;
      try {
        // Tenta vincular ao ID de predição PIE pelo nome da partida
        const piePending = getPendingPredictions();
        const matchKey   = (entry.match || '').toLowerCase().slice(0, 12);
        const piePred    = piePending.find(p =>
          (p.match_name || '').toLowerCase().includes(matchKey)
        );

        saveResult({
          predictionId:  piePred?.id || null,
          matchName:     entry.match,
          placarReal,
          competition:   entry.competition || '',
          marketOutcomes: [{
            market:        entry.market,
            recomendacao:  entry.prediction,
            probabilidade: entry.probabilidade,
            acertou,
          }],
        });

        pieSaved = true;
        console.log(chalk.gray(`    📊 PIE atualizado — ${entry.market} (${entry.competition || 'sem liga'})`));
      } catch (e) {
        // PIE falhou mas não bloqueia o fluxo — loga de forma visível
        console.warn(chalk.yellow(`    ⚠ PIE não atualizado: ${e.message}`));
      }

      // 5. Marcar como resolvida (independente do PIE — evita reprocessar o resultado)
      resolvePendingAnalysis(entry.id, { acertou, placarReal, resultMsgId, pieSaved });

      // 6. Atualiza nota Obsidian com resultado real (GREEN/RED)
      if (!DRY_RUN && isObsidianConfigured()) {
        try {
          const gameDate = (entry.gameTime || entry.sentAt || '').slice(0, 10);
          updateAnaliseNoteResult({
            match:       entry.match,
            dateStr:     gameDate,
            placarReal,
            acertou,
            market:      entry.market,
            competition: entry.competition || '',
          });
        } catch { /* não bloqueia */ }
      }

      if (acertou) greens++; else reds++;

    } catch (entryErr) {
      // Erro isolado por entrada — não bloqueia as demais
      console.log(chalk.red(`ERRO`));
      console.warn(chalk.red(`    ✗ Falha ao processar ${label}: ${entryErr.message}`));
      skipped++;
    }

    await sleep(DELAY_MS);
  }

  // Resumo
  console.log('\n' + '═'.repeat(64));
  console.log(`  ✅ GREEN: ${greens}  |  ❌ RED: ${reds}  |  ⏳ Pendentes: ${skipped}`);
  console.log('═'.repeat(64) + '\n');

  // Melhoria 3: health alert ao admin após N execuções sem resolução
  if (skipped > 0 && greens === 0 && reds === 0) {
    _consecutiveSkips++;
  } else if (greens > 0 || reds > 0) {
    _consecutiveSkips = 0;
  }
  if (_consecutiveSkips >= 3 && pending.length > 0) {
    await _notifyAdminHealthAlert(pending.length, _consecutiveSkips);
  }
}

// Executa diretamente quando chamado via CLI
const isCli = process.argv[1] && process.argv[1].endsWith('result-checker.js');
if (isCli) {
  runResultChecker().catch(e => {
    console.error(chalk.red(`\nERRO: ${e.message}`));
    process.exit(1);
  });
}
