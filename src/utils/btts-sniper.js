/**
 * btts-sniper.js — Kill Switches e Tracker compartilhados do BTTS Sniper v3
 *
 * Módulo central usado por TODOS os pipelines (PRÉ-LIVE, LIVE, SUPERODDS).
 * Garante que as mesmas regras são aplicadas de forma consistente em qualquer
 * ponto de entrada que processe o mercado BTTS.
 *
 * Exporta:
 *   bttsKillSwitch(result, matchData)      → string (motivo) ou null (aprovado)
 *   trackBttsDecision(decision, r, md, rs) → void (registra no tracker)
 *   BTTS_MIN_PROBABILITY                   → 82
 *   BTTS_MIN_CONFIDENCE                    → 80
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirSn    = dirname(fileURLToPath(import.meta.url));
const TRACKER    = join(__dirSn, '../../data/btts-tracker.json');

// ── Thresholds Sniper v3 (calibrados na Fase 4: 100% em 9 amostras) ──────────
//
// Drill B2 (2026-04-16): threshold 85% PROIBIDO para BTTS
//   PIE byRange global (1644 amostras):
//     70-80%:  1446 amostras → 60% precisão  (baseline)
//     80-85%:  191 amostras  → 75% precisão  ← Fire Zone atual (gate correto)
//     85-90%:  7 amostras    → 29% precisão  ← COLAPSO CATASTRÓFICO
//   Elevar o gate para 85% reduz volume de 191→7 E piora precisão de 75%→29%.
//   NÃO alterar BTTS_MIN_CONFIDENCE para além de 80 por nenhum motivo.
export const BTTS_MIN_PROBABILITY = 82;
export const BTTS_MIN_CONFIDENCE  = 80; // NÃO ELEVAR — ver Drill B2 acima

// ── Liga Tier Map ──────────────────────────────────────────────────────────────
// Tier 1 → threshold reduzido (80%) + fire zone bonus
// Tier 2 → threshold elevado (85%) — acima da média global mas abaixo do limiar Sniper
// Tier 3 → bloqueio imediato
//
// Drill B1 (2026-04-16): Liga Portugal removida do Tier 1 (65% global, n=123)
//   Abaixo da média Tier1 (69%) em n significativo → threshold elevado para 85%
//   Shadow mode: monitorar FZ real por liga antes de reativar como Tier 1
const TIER1_PATTERNS = [
  'eredivisie', 'laliga', 'la liga', 'premier league', 'bundesliga',
  'brasileirão betano', 'brasileirao betano',
  'brasileirão série b', 'brasileirao serie b',
  'concacaf champions cup', 'liga mx',
  // Liga Portugal removida em 2026-04-16: 65% (n=123) < limiar Tier1 de 69% médio
];

// Tier 2 — acima do global (61%) mas abaixo do Tier 1 (69%) — prob mínima 85%
const TIER2_ELEVATED = [
  'liga portugal',  // 65% (n=123) — Drill B1 rebaixado de Tier 1 em 2026-04-16
];

const KNOCKOUT_PATTERNS = [
  'knockout', 'round of 16', 'round of 32', 'quarter-final', 'quarter final',
  'semi-final', 'semi final', 'knockout stage', 'knockout phase',
];

const DEAD_LEAGUE_PATTERNS = [
  'champions league',       // UCL qualquer fase — BTTS 27% (KS1 só pega keyword knockout)
  'europa league',          // bloqueia genérico — BTTS 49%
  'copa del rey',
  'conference league',      // BTTS 15% — confirmado Fase 4
  '2\\. bundesliga',        // regex: escapa o ponto
  'second bundesliga',
  'championship',           // inglesa
  'chinese super league',
  'i-league',
  'queensland premier',     // 0% — confirmado Fase 4
  'indonesia super league',
  'a-league.*men',
];

// ── Pre-filter helper (para uso nos funnels antes de chamar o modelo) ─────────
/**
 * Retorna true se a competição é liga morta para BTTS (KS1 + KS2 baseados no nome).
 * Usar nos funnels ANTES de chamar BTTSAgent.analyze() para evitar ~1.390 tokens
 * gastos em chamadas que seriam bloqueadas imediatamente pelo kill switch.
 *
 * @param {string} competition — nome da competição
 * @returns {boolean} true = liga morta → não chamar BTTSAgent
 */
export function bttsIsDeadLeague(competition) {
  const comp = (competition || '').toLowerCase();
  if (KNOCKOUT_PATTERNS.some(p => comp.includes(p))) return true;
  return DEAD_LEAGUE_PATTERNS.some(p => {
    try { return new RegExp(p, 'i').test(comp); } catch { return false; }
  });
}

// ── Kill Switch Engine ─────────────────────────────────────────────────────────
/**
 * Aplica os Kill Switches do Sniper v3 sobre uma análise BTTS.
 * Deve ser chamado ANTES dos thresholds de prob/conf.
 *
 * @param {object} result    — saída do agente (probabilidade, confianca, recomendacao)
 * @param {object} matchData — dados da partida (competition, league, home, away, odds)
 * @returns {string|null}    — motivo do bloqueio, ou null se aprovado
 */
export function bttsKillSwitch(result, matchData) {
  const competition = (
    matchData.competition ||
    matchData.league      ||
    matchData.competicao  ||
    ''
  ).toLowerCase();

  // KS1 — Fase eliminatória europeia (acurácia histórica: 0-49%)
  if (KNOCKOUT_PATTERNS.some(p => competition.includes(p))) {
    return 'Kill Switch 1 — fase eliminatória europeia (BTTS 0-49% histórico)';
  }

  // KS2 — Liga Morta (Tier 3)
  const isDeadLeague = DEAD_LEAGUE_PATTERNS.some(p => {
    try { return new RegExp(p, 'i').test(competition); } catch { return false; }
  });
  if (isDeadLeague && !competition.includes('group')) {
    return `Kill Switch 2 — liga Tier 3 (${matchData.competition || competition})`;
  }

  // KS2T — Liga Tier 2 (threshold elevado: prob mínima 85%)
  // Drill B1 (2026-04-16): Liga Portugal 65% global (n=123) rebaixada de Tier 1
  const isTier2 = TIER2_ELEVATED.some(p => competition.includes(p));
  if (isTier2) {
    const prob = result?.probabilidade ?? 0;
    if (prob < 85) {
      return `Kill Switch 2T — ${matchData.competition || competition} (Tier 2 · 65% base · prob ${prob}% < 85% mínimo)`;
    }
  }

  // KS2B — CONMEBOL grupo fraco (btts_pct < 55% em qualquer time)
  if (/conmebol.*(libertadores|sudamericana).*(group|grupo)/i.test(competition)) {
    const homeBtts = matchData.home?.btts_pct ?? 0;
    const awayBtts = matchData.away?.btts_pct ?? 0;
    if (homeBtts < 55 || awayBtts < 55) {
      return `Kill Switch 2B — CONMEBOL grupo fraco (btts_pct home:${homeBtts}% away:${awayBtts}% < 55%)`;
    }
  }

  // KS3 — Odd real BTTS muito baixa (sem edge)
  const bttsOdd = matchData.odds?.btts_yes
    ?? matchData.odds?.btts
    ?? matchData.odds?.btts_sim
    ?? null;
  if (bttsOdd !== null && bttsOdd < 1.60) {
    return `Kill Switch 3 — odd BTTS real ${bttsOdd} < 1.60 (mercado já precificou, EV ausente)`;
  }

  // KS4 — Dados insuficientes do modelo
  const prob = result?.probabilidade ?? 0;
  const conf = result?.confianca     ?? 0;
  if (conf < 70 && prob < 85) {
    return `Kill Switch 4 — dados insuficientes (conf:${conf}% + prob:${prob}%)`;
  }

  return null; // aprovado
}

/**
 * Retorna o threshold mínimo de probabilidade para o contexto da liga.
 * Tier 1 = 80% (Fire Zone) | Tier 2 = 85% (elevado, Drill B1) | padrão = 82%.
 */
export function bttsMinProbability(competition = '') {
  const comp = competition.toLowerCase();
  if (TIER1_PATTERNS.some(p => comp.includes(p))) return 80;
  if (TIER2_ELEVATED.some(p => comp.includes(p)))  return 85;
  return BTTS_MIN_PROBABILITY;
}

// ── Tracker ────────────────────────────────────────────────────────────────────
function _loadTracker() {
  try { return JSON.parse(readFileSync(TRACKER, 'utf8')); }
  catch { return null; }
}

function _saveTracker(t) {
  try { writeFileSync(TRACKER, JSON.stringify(t, null, 2), 'utf8'); }
  catch (err) { console.error('[BTTS Tracker] Falha ao salvar tracker:', err.message); }
}

/**
 * Registra uma decisão BTTS no tracker para acompanhamento de precisão.
 *
 * @param {'fired'|'blocked'} decision
 * @param {object} result       — saída do agente
 * @param {object} matchData    — dados da partida
 * @param {string|null} reason  — motivo do bloqueio (se blocked)
 * @param {string} source       — pipeline de origem ('prelive'|'live'|'superodds')
 */
export function trackBttsDecision(decision, result, matchData, reason = null, source = 'prelive') {
  const tracker = _loadTracker();
  if (!tracker) return;

  const matchId = `${matchData.home?.team || matchData.home_team || ''}` +
                  `_${matchData.away?.team || matchData.away_team || ''}`;
  const now     = new Date().toISOString();

  // Drill B4: captura odds BTTS em dois momentos para detectar movimento de mercado
  // Se odds_btts_sim_24h e odds_btts_sim_1h estiverem disponíveis em matchData,
  // registra ambos. Sinal: odd subiu > 10% entre 24h e 1h → mercado apostando em menos BTTS.
  const odd24h   = matchData.odds_btts_24h  ?? matchData.odds?.btts_yes_24h  ?? null;
  const odd1h    = matchData.odds_btts_1h   ?? matchData.odds?.btts_yes_1h   ?? null;
  const oddNow   = matchData.odds?.btts_yes ?? matchData.odds?.btts          ?? null;
  const oddsShift = (odd24h && odd1h)
    ? Math.round(((odd1h - odd24h) / odd24h) * 100)
    : null;

  const entry = {
    match_name:      matchData.match || matchData.match_name || matchId,
    competition:     matchData.competition || matchData.league || '',
    match_date:      matchData.date || matchData.match_date || now,
    fired_at:        now,
    probabilidade:   result.probabilidade,
    confianca:       result.confianca,
    recomendacao:    result.recomendacao || result.recommendation,
    // Drill B4 — rastreamento de odds
    odds_btts_24h:   odd24h,
    odds_btts_1h:    odd1h,
    odds_btts_now:   oddNow,
    odds_shift_pct:  oddsShift,   // positivo = odd subindo (mercado apostando contra BTTS)
    // Auditoria M8 — rastreabilidade de versão (2026-04-16)
    prompt_version:  process.env.BTTS_PROMPT_VERSION  || 'v3.1',
    model_version:   process.env.GROQ_MODEL            || 'llama-3.1-8b-instant',
    source,
    // Módulo 5 — rastreabilidade de fonte e qualidade de dados (2026-04-16)
    fonte_primaria:   'academia',
    dado_degradado:   !(matchData.home?.btts_pct > 0 && matchData.away?.btts_pct > 0),
    sequencia_usada:  matchData.home?.sequencia_sem_btts != null || matchData.away?.sequencia_sem_btts != null,
    resolved:      false,
    acertou:       null,
    score_real:    null,
  };

  if (decision === 'fired') {
    tracker.fired_log   = tracker.fired_log   || [];
    tracker.fired_log.push(entry);
    tracker.summary.total_fired = (tracker.summary.total_fired || 0) + 1;
  } else {
    // blocked
    tracker.blocked_log = tracker.blocked_log || [];
    tracker.blocked_log.push({ ...entry, kill_switch: reason || 'UNKNOWN' });
    tracker.summary.total_blocked = (tracker.summary.total_blocked || 0) + 1;

    // Shadow mode: v2 (prob >= 80%) teria disparado?
    const recom = (result.recomendacao || result.recommendation || '').toUpperCase();
    const v2WouldFire = (result.probabilidade >= 80) && (recom === 'SIM' || recom === 'APOSTAR');
    tracker.shadow_log = tracker.shadow_log || [];
    tracker.shadow_log.push({ ...entry, kill_switch: reason, v2_would_fire: v2WouldFire });
  }

  tracker.summary.last_updated = now;
  _saveTracker(tracker);
}
