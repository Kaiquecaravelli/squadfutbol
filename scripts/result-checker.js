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
import {
  getPendingAnalyses,
  resolvePendingAnalysis,
  notifyResultFeedback,
  getAllPendingAnalyses,
} from '../src/utils/telegram.js';
import { saveResult, getPendingPredictions } from '../src/pie/pie-storage.js';

const DRY_RUN        = process.argv.includes('--dry-run');
const SOFASCORE_BASE = 'https://api.sofascore.com/api/v1';
const DELAY_MS       = 1200;
const HEADERS        = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':     'application/json',
  'Referer':    'https://www.sofascore.com/',
};

// ── Avalia se a predição acertou ─────────────────────────────────────────────
// entry é opcional — usado para "Resultado Final {time}" que precisa saber qual time
function determineOutcome(market, prediction, score, entry = {}) {
  if (score.home == null || score.away == null) return null;

  const total = score.home + score.away;
  const rec   = String(prediction || '').toUpperCase().trim();
  const mkt   = (market || '').toUpperCase();

  if (market.includes('Over 0.5'))  return total > 0;
  if (market.includes('Over 1.5'))  return total > 1;
  if (market.includes('Over 2.5'))  return total > 2;
  if (market.includes('Over 3.5'))  return total > 3;
  if (market.includes('Over 4.5'))  return total > 4;
  if (market.includes('Under 1.5')) return total < 2;
  if (market.includes('Under 2.5')) return total < 3;

  if (mkt.includes('BTTS') || mkt.includes('AMBAS')) {
    const bttsOk = score.home > 0 && score.away > 0;
    if (rec === 'NÃO' || rec === 'NAO' || rec === 'NO' || rec === 'NÃO MARCAM') return !bttsOk;
    return bttsOk;
  }

  // Mercados genéricos de home/away — verificados ANTES do bloco "Resultado Final {time}"
  // para evitar que "Resultado Final Casa/Fora" seja interceptado pelo matcher genérico
  if (mkt.includes('RESULTADO FINAL CASA') || market.includes('Home Win') || market === '1') return score.home > score.away;
  if (mkt.includes('RESULTADO FINAL FORA') || market.includes('Away Win') || market === '2') return score.away > score.home;
  if (market.includes('Draw') || market === 'X') return score.home === score.away;

  // "Resultado Final {time}" — verifica qual time venceu pelo nome no mercado
  if (mkt.includes('RESULTADO FINAL')) {
    const [homeTeam, awayTeam] = (entry.match || '').split(/\s+vs\s+/i);
    // Extrai o nome do time do mercado: "Resultado Final Boca Juniors" → "Boca Juniors"
    const teamInMarket = market.replace(/resultado final/i, '').trim().toLowerCase();
    const isHomeTeam = homeTeam && homeTeam.toLowerCase().includes(teamInMarket.slice(0, 6));
    const isAwayTeam = awayTeam && awayTeam.toLowerCase().includes(teamInMarket.slice(0, 6));
    if (isHomeTeam) return score.home > score.away;
    if (isAwayTeam) return score.away > score.home;
    // Se não identificou o time, usa a recomendação
    if (rec === 'APOSTAR' || rec === 'SIM') return score.home !== score.away;
  }
  if (market === '1X' || market.includes('Dupla Chance 1X')) return score.home >= score.away;
  if (market === 'X2' || market.includes('Dupla Chance X2')) return score.away >= score.home;

  return null;
}

// ── Busca resultado no SofaScore por ID do evento ────────────────────────────
async function fetchByEventId(sofascoreId) {
  try {
    const { data } = await axios.get(`${SOFASCORE_BASE}/event/${sofascoreId}`, {
      headers: HEADERS, timeout: 8000,
    });
    const event = data?.event;
    if (!event) return null;

    const status = event.status?.type;
    if (status !== 'finished') return { status, score: null };

    const home = event.homeScore?.current ?? event.homeScore?.normaltime;
    const away = event.awayScore?.current ?? event.awayScore?.normaltime;
    if (home == null || away == null) return { status, score: null };

    return {
      status: 'finished',
      score:  { home: Number(home), away: Number(away) },
      label:  `${event.homeTeam?.name} ${home}-${away} ${event.awayTeam?.name}`,
    };
  } catch { return null; }
}

// ── Busca por nome do jogo + data atual (quando sem sofascoreId) ──────────────
async function fetchByMatchName(matchName, dateStr) {
  try {
    const date = (dateStr || new Date().toISOString()).split('T')[0];
    const { data } = await axios.get(`${SOFASCORE_BASE}/sport/football/scheduled-events/${date}`, {
      headers: HEADERS, timeout: 8000,
    });
    const events = data?.events || [];

    const [homeSearch, awaySearch] = (matchName || '').split(/\s+vs\s+/i);
    if (!homeSearch || !awaySearch) return null;

    const found = events.find(e => {
      const hn = (e.homeTeam?.name || '').toLowerCase();
      const an = (e.awayTeam?.name || '').toLowerCase();
      return (
        hn.includes(homeSearch.toLowerCase().slice(0, 6)) &&
        an.includes(awaySearch.toLowerCase().slice(0, 6))
      );
    });

    if (!found) return null;
    if (found.status?.type !== 'finished') return { status: found.status?.type, score: null };

    const home = found.homeScore?.current;
    const away = found.awayScore?.current;
    if (home == null || away == null) return null;

    return {
      status:      'finished',
      score:       { home: Number(home), away: Number(away) },
      label:       `${found.homeTeam?.name} ${home}-${away} ${found.awayTeam?.name}`,
      sofascoreId: String(found.id),
    };
  } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    const label = `${entry.match} [${entry.market}]`;
    process.stdout.write(`  → ${label.substring(0, 50).padEnd(50)}  `);

    try {
      // 1. Buscar resultado no SofaScore
      let result = null;

      if (entry.sofascoreId) {
        result = await fetchByEventId(entry.sofascoreId);
      }

      if (!result || result.status !== 'finished') {
        // Tenta por nome se não tem ID ou jogo não terminou ainda
        const dateToSearch = entry.gameTime || entry.sentAt;
        result = await fetchByMatchName(entry.match, dateToSearch);
      }

      if (!result) {
        console.log(chalk.gray('SofaScore indisponível — pular'));
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

      // 2. Avaliar resultado
      const acertou = determineOutcome(entry.market, entry.prediction, result.score, entry);

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
}

// Executa diretamente quando chamado via CLI
const isCli = process.argv[1] && process.argv[1].endsWith('result-checker.js');
if (isCli) {
  runResultChecker().catch(e => {
    console.error(chalk.red(`\nERRO: ${e.message}`));
    process.exit(1);
  });
}
