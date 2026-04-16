/**
 * groq-token-economy.js — Economia de Tokens Groq (otimização interna)
 *
 * Aplica 4 mecanismos sem alterar nada do output Telegram:
 *
 *  1. CACHE     — Mesmo jogo + mesmo agente na mesma sessão → reutiliza resultado
 *  2. COMPACT   — Comprime matchData antes de enviar (remove nulos, limita arrays)
 *  3. GATE      — Se Quant confidence ≥ SKIP_THRESHOLD, pula Groq e usa Quant direto
 *  4. TRACKING  — Registra tokens estimados economizados por sessão
 *
 * Groq rate limits (llama-3.1-8b-instant, por chave):
 *   30 RPM | 20,000 TPM | 14,400 RPD
 *
 * Uso interno apenas — chamado pelos BaseAgents. Sem impacto no Telegram.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dir, '../..');
const LOG    = join(ROOT, 'logs/token-economy.jsonl');

mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ── Configuração ───────────────────────────────────────────────────────────────
const CACHE_TTL_MS     = 2 * 60 * 60 * 1000;  // 2h — mesmo jogo não re-analisado na sessão
const SKIP_THRESHOLD   = 92;                   // Quant confidence ≥ 92% → skip Groq (mercado muito claro)
const SKIP_MARKETS     = new Set([             // mercados onde o skip é seguro
  'Over 1.5', 'Over Corners 6.5', 'YC 2.5',   // mercados tier-1 calibrados com 77%+
]);
const AVG_TOKENS_SAVED = 1800;                 // tokens médios por chamada evitada (estimativa conservadora)

// ── Cache em memória (por sessão PM2) ─────────────────────────────────────────
const _cache = new Map(); // chave → { result, expiresAt }

/** Gera chave de cache estável para agente + partida */
function cacheKey(agentName, matchName, market = '') {
  const m = (matchName || '').toLowerCase().replace(/\s+/g, '_').slice(0, 40);
  const k = (market    || '').toLowerCase().replace(/\s+/g, '_').slice(0, 20);
  return `${agentName}:${m}:${k}`;
}

/** Lê resultado do cache. Retorna null se ausente ou expirado. */
export function cacheGet(agentName, matchName, market = '') {
  const key   = cacheKey(agentName, matchName, market);
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.result;
}

/** Armazena resultado no cache com TTL de 2h. */
export function cacheSet(agentName, matchName, market = '', result) {
  const key = cacheKey(agentName, matchName, market);
  _cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Retorna estatísticas do cache para diagnóstico. */
export function cacheStats() {
  const now  = Date.now();
  const live = [..._cache.values()].filter(e => now < e.expiresAt).length;
  return { total: _cache.size, live };
}

// ── Compressão de matchData ───────────────────────────────────────────────────
/**
 * Comprime matchData para reduzir tokens enviados ao Groq.
 * Remove nulos, undefined, arrays vazios e limita arrays históricos.
 */
export function compactMatchData(matchData) {
  if (!matchData || typeof matchData !== 'object') return matchData;

  const round = (n) => typeof n === 'number' ? Math.round(n * 100) / 100 : n;

  // Remove campos nulos/undefined/vazios recursivamente
  const clean = (obj) => {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj)
          .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
          .map(([k, v]) => [k, clean(v)])
      );
    }
    return obj;
  };

  const forma5 = (str) => (str || '').slice(-5) || undefined;

  const compactTeam = (team) => team ? clean({
    time:       team.team || team.name,
    forma5:     forma5(team.form),
    gm_avg:     round(team.goals_scored_avg),
    gc_avg:     round(team.goals_conceded_avg),
    xg:         round(team.xg_avg),
    btts_pct:   round(team.btts_pct),
    over25_pct: round(team.over_25_pct),
    cs_pct:     round(team.clean_sheet_pct),
    over15_pct: round(team.over_15_pct),
    corners_avg:round(team.corners_avg),
    yc_avg:     round(team.yellow_cards_avg),
  }) : undefined;

  // H2H — máx 3 partidas, apenas gols
  const h2hCompact = (matchData.h2h || []).slice(0, 3).map(m => ({
    hg: m.home_goals ?? 0,
    ag: m.away_goals ?? 0,
  }));

  const compact = clean({
    partida:    matchData.match || matchData.match_name,
    competicao: matchData.competition,
    mandante:   compactTeam(matchData.home),
    visitante:  compactTeam(matchData.away),
    odds:       matchData.odds,
    h2h:        h2hCompact.length ? h2hCompact : undefined,
    placar:     matchData.score,
    minuto:     matchData.minute,
    escanteios: matchData.corners,
    cartoes:    matchData.yellow_cards,
  });

  return compact;
}

// ── Gate de confiança — skip Groq quando Quant já é muito seguro ──────────────
/**
 * Retorna true se o Groq pode ser pulado para economizar tokens.
 *
 * Usado quando o modelo Quant já tem confiança muito alta (≥92%) em mercados
 * calibrados, onde a contribuição do LLM é marginal (<3pp na decisão final).
 * NUNCA pula em mercados não calibrados ou com confiança abaixo do threshold.
 *
 * @param {string} market          - nome do mercado
 * @param {number} quantConfidence - confiança do modelo Quant (0–100)
 * @param {number} quantProbability - probabilidade do modelo Quant (0–100)
 * @returns {boolean}
 */
export function shouldSkipGroq(market, quantConfidence, quantProbability) {
  if (!SKIP_MARKETS.has(market)) return false;
  if (!quantConfidence || quantConfidence < SKIP_THRESHOLD) return false;
  if (!quantProbability || quantProbability < 78) return false;
  return true;
}

// ── Tracking de uso ────────────────────────────────────────────────────────────
const _session = {
  calls:      0,
  cacheHits:  0,
  gateSkips:  0,
  startedAt:  new Date().toISOString(),
};

export function trackCall()      { _session.calls++; }
export function trackCacheHit()  { _session.cacheHits++; }
export function trackGateSkip()  { _session.gateSkips++; }

/** Retorna resumo de economia da sessão atual. */
export function sessionStats() {
  const avoided = _session.cacheHits + _session.gateSkips;
  const saved   = avoided * AVG_TOKENS_SAVED;
  return {
    calls:              _session.calls,
    cacheHits:          _session.cacheHits,
    gateSkips:          _session.gateSkips,
    avoided,
    tokensEconomizados: saved,
    startedAt:          _session.startedAt,
  };
}

/** Persiste snapshot de economia no log para análise posterior. */
export function flushStats(label = 'snapshot') {
  try {
    const stats = sessionStats();
    const line  = JSON.stringify({ ts: new Date().toISOString(), label, ...stats });
    writeFileSync(LOG, line + '\n', { flag: 'a' });
  } catch { /* não crítico */ }
}
