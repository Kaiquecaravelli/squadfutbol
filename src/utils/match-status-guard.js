/**
 * match-status-guard.js — Verificação de status em tempo real antes do envio PRÉ-LIVE
 *
 * Problema que resolve:
 *   O pipeline coleta jogos com status "notstarted", mas a análise pode demorar
 *   vários minutos. Quando chega a hora do envio, o jogo pode já ter começado
 *   ou até terminado — resultando em sinais pré-live inválidos.
 *
 * Solução:
 *   Consulta a API SofaScore no momento exato do envio para confirmar que o
 *   jogo ainda está "notstarted". Bloqueia o envio caso contrário.
 *
 * Comportamento por status:
 *   notstarted  → ✅ PERMITIR envio
 *   inprogress  → 🚫 BLOQUEAR (já começou)
 *   finished    → 🚫 BLOQUEAR (já acabou)
 *   postponed   → 🚫 BLOQUEAR (adiado)
 *   canceled    → 🚫 BLOQUEAR (cancelado)
 *   desconhecido→ ✅ PERMITIR (fail-open: não punir por indisponibilidade da API)
 *
 * Uso:
 *   import { checkPreLiveEligible } from './match-status-guard.js';
 *   const ok = await checkPreLiveEligible(matchData);
 *   if (!ok) return; // não enviar
 */

import axios from 'axios';
import chalk from 'chalk';

const SOFA_BASE    = 'https://api.sofascore.com/api/v1';
const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':     'application/json',
  'Referer':    'https://www.sofascore.com/',
};
const REQUEST_TIMEOUT_MS = 6_000;

// Status que bloqueiam o envio pré-live
const BLOCKED_STATUSES = new Set([
  'inprogress',
  'finished',
  'postponed',
  'canceled',
  'cancelled',
  'interrupted',
  'abandoned',
]);

/**
 * Verifica o status atual do jogo via SofaScore e decide se o sinal pode ser enviado.
 *
 * @param {object} matchData  — objeto de dados do jogo (deve ter sofascore_id ou match_id)
 * @returns {Promise<{eligible: boolean, status: string, reason: string}>}
 */
export async function checkMatchStatus(matchData) {
  const eventId = matchData?.sofascore_id ?? matchData?.match_id ?? matchData?.sofascoreId;

  // Sem ID SofaScore: não conseguimos verificar → fail-open (permitir)
  if (!eventId) {
    return {
      eligible: true,
      status:   'unknown',
      reason:   'sem sofascore_id — verificação ignorada',
    };
  }

  try {
    const { data } = await axios.get(
      `${SOFA_BASE}/event/${eventId}`,
      { headers: SOFA_HEADERS, timeout: REQUEST_TIMEOUT_MS }
    );

    const event       = data?.event;
    const statusType  = event?.status?.type?.toLowerCase() ?? 'unknown';
    const statusDesc  = event?.status?.description ?? statusType;

    if (BLOCKED_STATUSES.has(statusType)) {
      return {
        eligible: false,
        status:   statusType,
        reason:   `jogo ${statusDesc} (${statusType})`,
      };
    }

    // Verificação extra de tempo: se o kickoff já passou há mais de 5 minutos
    // e o status retornou como "notstarted" (pode ser lag da API), bloquear por segurança
    const kickoffMs    = (event?.startTimestamp ?? 0) * 1000;
    const msSinceKick  = Date.now() - kickoffMs;
    if (kickoffMs > 0 && msSinceKick > 5 * 60_000) {
      return {
        eligible: false,
        status:   statusType,
        reason:   `kickoff passou há ${Math.round(msSinceKick / 60_000)} min (status API: ${statusType})`,
      };
    }

    return {
      eligible: true,
      status:   statusType,
      reason:   `status confirmado: ${statusDesc}`,
    };

  } catch (err) {
    // SofaScore indisponível → fail-open (não bloquear por falha de rede)
    return {
      eligible: true,
      status:   'api_error',
      reason:   `SofaScore indisponível (${err.message}) — envio permitido`,
    };
  }
}

/**
 * Wrapper simplificado: retorna true se pode enviar, false se deve bloquear.
 * Loga o resultado com chalk.
 *
 * @param {object} matchData
 * @param {string} [label]  — nome do jogo para o log
 * @returns {Promise<boolean>}
 */
export async function checkPreLiveEligible(matchData, label) {
  const matchName = label ?? matchData?.match ?? 'desconhecido';
  const result    = await checkMatchStatus(matchData);

  if (!result.eligible) {
    console.log(
      chalk.yellow(`  [StatusGuard] 🚫 ${matchName} — BLOQUEADO: ${result.reason}`)
    );
    return false;
  }

  if (result.status === 'api_error' || result.status === 'unknown') {
    console.log(
      chalk.gray(`  [StatusGuard] ⚠️  ${matchName} — ${result.reason}`)
    );
  } else {
    console.log(
      chalk.green(`  [StatusGuard] ✅ ${matchName} — ${result.reason}`)
    );
  }

  return true;
}
