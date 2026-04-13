/**
 * Result Fetcher — Busca automática de placares finais via SofaScore API
 *
 * Fluxo por ciclo horário:
 *  1. Verifica partidas na analysisHistory com kickoff + 105 min passados
 *  2. Consulta SofaScore API → GET /event/{id} → status + placar
 *  3. Se finalizada: dispara PIE training + notifica grupo
 *  4. Se ainda em andamento: aguarda próximo ciclo
 */

import axios from 'axios';
import chalk from 'chalk';

const API  = 'https://api.sofascore.com/api/v1';
const http = axios.create({
  baseURL: API,
  timeout: 10_000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept':     'application/json',
    'Referer':    'https://www.sofascore.com/',
  },
});

// Status que indicam jogo encerrado com placar válido — apto para treino
const FINISHED_STATUSES = new Set([
  'finished', 'ended', 'after extra time', 'after penalties', 'aet', 'ap',
  'walkover', 'awarded',
]);

// Status que indicam jogo não realizado — NÃO treinar com placar 0-0
const ABANDONED_STATUSES = new Set([
  'postponed', 'canceled', 'cancelled', 'abandoned', 'interrupted',
]);

/**
 * Busca o resultado final de um evento via SofaScore.
 * @param {number|string} sofascoreId — ID do evento
 * @returns {{ homeGoals, awayGoals, status, statusType } | null}
 */
export async function fetchEventResult(sofascoreId) {
  if (!sofascoreId) return null;
  try {
    const res       = await http.get(`/event/${sofascoreId}`);
    const event     = res.data?.event;
    if (!event) return null;

    const statusType = event.status?.type?.toLowerCase() || '';
    const statusDesc = event.status?.description?.toLowerCase() || '';

    // Jogo adiado/cancelado — marcar como encerrado sem treinar
    if (ABANDONED_STATUSES.has(statusType) || ABANDONED_STATUSES.has(statusDesc)) {
      return { abandoned: true, status: statusDesc || statusType };
    }

    const isFinished = FINISHED_STATUSES.has(statusType) || FINISHED_STATUSES.has(statusDesc);
    if (!isFinished) return null;

    const homeGoals = event.homeScore?.current ?? event.homeScore?.normaltime ?? null;
    const awayGoals = event.awayScore?.current ?? event.awayScore?.normaltime ?? null;

    if (homeGoals === null || awayGoals === null) return null;

    return {
      homeGoals: Number(homeGoals),
      awayGoals: Number(awayGoals),
      status:    statusDesc || statusType,
      placar:    `${homeGoals}-${awayGoals}`,
    };
  } catch {
    return null; // API indisponível — tenta no próximo ciclo
  }
}

/**
 * Varre o analysisHistory, busca resultados de partidas finalizadas
 * e dispara o PIE training automaticamente.
 *
 * @param {Map}      analysisHistory  — Map de idx → { matchData, approved, predictionId, kickoffTime, resultRegistered, sofascoreId }
 * @param {Function} onResult         — callback({ matchData, idx, placar, approved, predictionId }) chamado para cada resultado obtido
 */
export async function autoFetchResults(analysisHistory, onResult) {
  const now     = Date.now();
  const checked = [];

  for (const [idx, entry] of analysisHistory.entries()) {
    // Ignora: resultado já registrado
    if (entry.resultRegistered) continue;

    // Ignora: jogo não aconteceu ainda (< 135 min após kickoff — 90' + 15' intervalo + 30' prorrogação)
    const matchEnd = (entry.kickoffTime || 0) + 135 * 60_000;
    if (now < matchEnd) continue;

    // Precisa do sofascoreId para consultar API
    const sofascoreId = entry.matchData?.match_id
      || entry.matchData?.sofascore_id
      || entry.sofascoreId;

    if (!sofascoreId || String(sofascoreId).startsWith('demo')) continue;

    console.log(chalk.cyan(`  🔍 [Result Fetcher] Buscando placar: ${entry.matchData?.match} (ID ${sofascoreId})`));

    const result = await fetchEventResult(sofascoreId);

    if (!result) {
      console.log(chalk.gray(`      Jogo ainda em andamento ou API indisponível — tentará no próximo ciclo`));
      await sleep(500); // rate limiting entre chamadas à API
      continue;
    }

    // Jogo adiado/cancelado — encerrar sem treinar
    if (result.abandoned) {
      console.log(chalk.yellow(`      ⚠️  Jogo não realizado (${result.status}) — ignorando treino`));
      entry.resultRegistered = true; // não tentar novamente
      await sleep(500);
      continue;
    }

    console.log(chalk.green(`      ✅ Resultado: ${result.placar} (${result.status})`));

    entry.resultRegistered = true;
    checked.push({ idx, entry, result });
    await sleep(500); // rate limiting entre chamadas à API

    // Callback para processar resultado (PIE training + notificação)
    try {
      await onResult({
        idx,
        matchData:    entry.matchData,
        placar:       result.placar,
        approved:     entry.approved,
        predictionId: entry.predictionId,
      });
    } catch (err) {
      console.error(chalk.red(`      ❌ Erro ao processar resultado: ${err.message}`));
    }
  }

  if (checked.length) {
    console.log(chalk.bold.green(`\n  🎓 [PIE] ${checked.length} resultado(s) processado(s) automaticamente`));
  }

  return checked.length;
}
