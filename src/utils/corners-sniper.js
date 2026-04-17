/**
 * corners-sniper.js — Kill Switches, Whitelist e Tracker do Corners Sniper v2
 *
 * Módulo central usado por TODOS os pipelines (PRÉ-LIVE, LIVE, SUPERODDS).
 *
 * Arquitetura Sniper:
 *   Fire Zone: conf ≥ 80% → 100% de precisão em 232 amostras (6.5/7.5/8.5)
 *   Kill Zone: conf < 70% → 0% de precisão em 212 amostras
 *
 *   Whitelists POR SUB-MERCADO (Módulo 2 · Protocolo 100% Sniper · 2026-04-16):
 *     Over 6.5 → 13 ligas com precisão ≥ 75% (n ≥ 20) no PIE
 *     Over 7.5 →  5 ligas com precisão ≥ 75% (n ≥ 20) no PIE
 *     Over 8.5 →  2 ligas com precisão ≥ 75% (n ≥ 20) no PIE
 *
 *   Critério de inclusão: precisão ≥ 75% com n ≥ 20 NAQUELE sub-mercado específico.
 *   Uma liga aprovada em Over 6.5 NÃO é automaticamente aprovada em Over 7.5/8.5.
 *
 * Exporta:
 *   cornersKillSwitch(result, matchData)       → string (motivo) | null (aprovado)
 *   cornersMinConfidence(market)               → número (80 — Fire Zone gate)
 *   trackCornersDecision(dec, r, md, rsn, src) → void
 *   CORNERS_MIN_CONFIDENCE                     → 80
 *   CORNERS_WHITELIST                          → alias de CORNERS_WHITELIST_65 (retrocompat)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirCS = dirname(fileURLToPath(import.meta.url));
const TRACKER = join(__dirCS, '../../data/corners-tracker.json');

// ── Fire Zone Gate ────────────────────────────────────────────────────────────
// Conf ≥ 80%: 100% precisão em 56 (6.5) + 63 (7.5) + 113 (8.5) = 232 amostras
//
// Drill C3 (2026-04-16): lambda_corners calibrado por liga
//   Com coef correto, ligas antes abaixo de 80% de confiança entram na fire zone:
//   Brasileirão Over 6.5: P(>6.5) sobe 79%→93% (xG=2.5)
//   Brasileirão Over 8.5: P(>8.5) sobe 54%→79% (xG=2.5)
//   Bundesliga  Over 8.5: P(>8.5) cai  54%→28% (evita falsos positivos)
export const CORNERS_MIN_CONFIDENCE = 80;
export const CORNERS_MIN_PROBABILITY = 80;

/**
 * Retorna threshold mínimo de confiança para o mercado de escanteios.
 * Todos os sub-mercados exigem 80% (Fire Zone absoluta).
 */
export function cornersMinConfidence(/* market */) {
  return CORNERS_MIN_CONFIDENCE;
}

// ── Liga Whitelists por sub-mercado ───────────────────────────────────────────
// Calibração: pie.json byCompetition (dados reais, n ≥ 20 por liga por mercado)
// Atualização: Módulo 2 · Protocolo 100% Sniper · 2026-04-16
//
// Regra: cada sub-mercado usa sua própria whitelist.
// Uma liga aprovada em Over 6.5 NÃO é automaticamente válida para Over 7.5/8.5.
// Revisão obrigatória a cada 30 dias com novos dados do PIE.

// Over Corners 6.5 — precisão ≥ 75% (n ≥ 20): 13 ligas aprovadas
// ┌─────────────────────────────┬──────┬─────┐
// │ Liga                        │ Prec │  n  │
// ├─────────────────────────────┼──────┼─────┤
// │ Brasileirão Betano          │  89% │ 142 │
// │ Bundesliga                  │  89% │ 113 │
// │ Brasileirão Série B         │  89% │  62 │
// │ Liga Portugal Betclic       │  86% │ 123 │
// │ Ligue 1                     │  86% │ 106 │
// │ LaLiga                      │  85% │ 135 │
// │ VriendenLoterij Eredivisie  │  85% │ 126 │
// │ MLS                         │  84% │ 103 │
// │ Premier League              │  83% │ 125 │
// │ Serie A                     │  77% │ 132 │
// │ Liga Profesional (Arg)      │  76% │ 232 │
// │ UCL Knockout stage          │  76% │  41 │ ← bloqueada por dead league
// │ EL Knockout stage           │  75% │  36 │
// └─────────────────────────────┴──────┴─────┘
// Nota: UCL KO (76%) passa o critério de precisão mas está em DEAD_LEAGUES
// pois não conseguimos separar UCL group (67%) de UCL KO apenas pelo nome.
const CORNERS_WHITELIST_65 = [
  'brasileirão betano',
  'brasileirao betano',
  'bundesliga',
  'brasileirão série b',
  'brasileirao serie b',
  'liga portugal',
  'ligue 1',
  'laliga',
  'la liga',
  'vriendenloterij eredivisie',
  'eredivisie',
  'mls',
  'premier league',
  'serie a',
  'liga profesional',         // Argentina — 76% (n=232)
  'europa league, knockout',  // EL KO específico — 75% (NÃO o grupo geral)
];

// Over Corners 7.5 — precisão ≥ 75% (n ≥ 20): 5 ligas aprovadas
// Ligas removidas vs 6.5: PL 73%❌ · Eredivisie 71%❌ · Série B 68%❌ · Serie A 67%❌
//                          Ligue 1 65%❌ · Liga Profesional 64%❌ · EL KO 61%❌
// ┌────────────────────┬──────┬─────┐
// │ Brasileirão Betano │  86% │ 142 │
// │ Liga Portugal      │  83% │ 123 │
// │ LaLiga             │  78% │ 135 │
// │ Bundesliga         │  78% │ 113 │
// │ MLS                │  76% │ 103 │
// └────────────────────┴──────┴─────┘
const CORNERS_WHITELIST_75 = [
  'brasileirão betano',
  'brasileirao betano',
  'liga portugal',
  'laliga',
  'la liga',
  'bundesliga',
  'mls',
];

// Over Corners 8.5 — precisão ≥ 75% (n ≥ 20): 2 ligas aprovadas
// Ligas removidas vs 7.5: LaLiga 69%❌ · Bundesliga 61%❌ · MLS 66%❌
// ┌────────────────────┬──────┬─────┐
// │ Brasileirão Betano │  80% │ 142 │
// │ Liga Portugal      │  76% │ 123 │
// └────────────────────┴──────┴─────┘
const CORNERS_WHITELIST_85 = [
  'brasileirão betano',
  'brasileirao betano',
  'liga portugal',
];

// Alias retrocompatível — Over 6.5 é o mercado âncora
export const CORNERS_WHITELIST = CORNERS_WHITELIST_65;

// C1: Corners Under ligas ativas (exportado para uso nos funnels)
export { CORNERS_UNDER_LIGAS };

// Ligas explicitamente bloqueadas para QUALQUER sub-mercado (abaixo do limiar ou sem dados)
const CORNERS_DEAD_LEAGUES = [
  'champions league',   // UCL — grupo 67% / KO 76% (separados por data — ver Module 2)
  'conference league',  // sem dados suficientes para validar (n < 20)
];

// ── C1: Corners Under — ligas ativas (2026-04-16) ────────────────────────────
// Corners Under é válido apenas em competições eliminatórias/defensivas.
// Gate: 80% (mesmo padrão Under absoluto — inviolável).
// Mercados: Under Corners 6.5 (≤6) e Under Corners 7.5 (≤7).
// Protocolo: shadow mode para demais ligas antes de ativar.
const CORNERS_UNDER_LIGAS = [
  'champions league knockout',   // UCL KO (Fev–Mai): jogo controlado, menos escanteios
  'europa league knockout',      // UEL KO: 54% Under 7.5 histórico
  'copa del rey',                // Copa espanhola: jogos gerenciados
  'copa do brasil',              // Copa nacional: mandante gerencia vantagem
];

// ── Module 2 — UCL Phase Detector (2026-04-16) ────────────────────────────────
//
// Problema: UCL grupo (67%) e UCL KO (76%) compartilham o mesmo nome de competição.
// Solução: detecção por data.
//
// Calendário UCL 2024/25+ (formato liga fase):
//   Liga phase:   Set–Jan → lower scoring (67% Corners 6.5 — bloquear)
//   Knockout:     Fev–Mai → higher scoring (76% Corners 6.5, n=41 — liberar)
//
// Heurística: mês Fev(2)–Mai(5) = fase KO. Resto = fase de liga.
// Limitação conhecida: Final de Maio usa estádio neutro → lambda pode diferir.
function isUCLKnockoutPhase(dateInput) {
  // Usa data fornecida ou data atual para determinar fase UCL
  const d     = (dateInput && !Number.isNaN(new Date(dateInput).getTime()))
    ? new Date(dateInput)
    : new Date();
  const month = d.getMonth() + 1; // 1–12
  return month >= 2 && month <= 5; // Fevereiro–Maio = fase Knockout
}

// ── Pre-filter helper (para uso nos funnels antes de chamar o modelo) ────────
/**
 * Retorna true se a competição é liga morta para Corners (KS1 baseado no nome).
 * Usar nos funnels ANTES de chamar CornersAgent.analyze() para evitar tokens
 * gastos em chamadas que seriam bloqueadas imediatamente pelo kill switch.
 *
 * Module 2: UCL durante fase KO (Fev–Mai) NÃO é liga morta para Corners 6.5.
 *
 * @param {string}  competition — nome da competição
 * @param {string?} matchDate   — data da partida ISO (opcional — usa new Date() se omitido)
 * @returns {boolean} true = liga morta → não chamar CornersAgent
 */
export function cornersIsDeadLeague(competition, matchDate = null) {
  const comp = (competition || '').toLowerCase();

  // Module 2 — UCL KO exception: Fev–Mai tem 76% precisão para Over 6.5 (n=41)
  if (comp.includes('champions league') && isUCLKnockoutPhase(matchDate)) {
    return false; // UCL KO não é liga morta para Corners
  }

  return CORNERS_DEAD_LEAGUES.some(p => comp.includes(p));
}

// ── Kill Switch Engine ────────────────────────────────────────────────────────
/**
 * Aplica os Kill Switches do Corners Sniper v2.
 * Whitelist agora é específica por sub-mercado (Módulo 2 · 2026-04-16).
 *
 * @param {object} result    — saída do agente (probabilidade, confianca, mercado)
 * @param {object} matchData — dados da partida (competition, league)
 * @returns {string|null}    — motivo do bloqueio, ou null se aprovado
 */
export function cornersKillSwitch(result, matchData) {
  const competition = (
    matchData.competition ||
    matchData.league      ||
    matchData.competicao  ||
    ''
  ).toLowerCase();

  const matchDate = matchData.date || matchData.match_date || matchData.startTime || null;

  // Module 2 — UCL KO phase check (Fev–Mai = 76% precisão, n=41)
  const isUCLKO = competition.includes('champions league') && isUCLKnockoutPhase(matchDate);

  // KS1 — Liga explicitamente morta para qualquer sub-mercado de escanteios
  const isDead = CORNERS_DEAD_LEAGUES.some(p => competition.includes(p));
  if (isDead && !isUCLKO) {
    const cmpName = matchData.competition || competition;
    return `Corners Kill Switch 1 — ${cmpName} (bloqueada: UCL grupos 67% / Conference League sem dados)`;
  }
  // UCL KO detectada → cai para KS2 (whitelist específica por sub-mercado)

  // KS2 — Whitelist específica por sub-mercado
  // Over 6.5: 13 ligas + UCL KO | Over 7.5: 5 ligas | Over 8.5: 2 ligas
  const mkt = (result.mercado || result.market || '').trim();

  if (mkt === 'Over Corners 8.5') {
    const ok = CORNERS_WHITELIST_85.some(w => competition.includes(w));
    if (!ok) {
      const cmpName = matchData.competition || competition;
      return `Corners Kill Switch 2 — ${cmpName} (Over 8.5 · fora da whitelist 8.5 · apenas Brasileirão e Liga Portugal ≥ 75%)`;
    }
  } else if (mkt === 'Over Corners 7.5') {
    const ok = CORNERS_WHITELIST_75.some(w => competition.includes(w));
    if (!ok) {
      const cmpName = matchData.competition || competition;
      return `Corners Kill Switch 2 — ${cmpName} (Over 7.5 · fora da whitelist 7.5 · ligas aprovadas: Brasileirão · Liga PT · LaLiga · Bundesliga · MLS)`;
    }
  } else if (mkt === 'Over Corners 6.5') {
    // Module 2: UCL KO (76%, n=41) é válido para Over 6.5 na fase KO
    const ok = isUCLKO || CORNERS_WHITELIST_65.some(w => competition.includes(w));
    if (!ok) {
      const cmpName = matchData.competition || competition;
      return `Corners Kill Switch 2 — ${cmpName} (Over 6.5 · fora da whitelist 6.5 · precisão não validada ≥ 75%)`;
    }
  } else if (mkt === 'Under Corners 7.5' || mkt === 'Under Corners 6.5') {
    // C1 — Corners Under: lista restrita a competições eliminatórias/defensivas (2026-04-16)
    // UCL KO (Fev–Mai) é válido; outras ligas precisam de shadow mode antes de ativar.
    const okUnder = isUCLKO || CORNERS_UNDER_LIGAS.some(w => competition.includes(w));
    if (!okUnder) {
      const cmpName = matchData.competition || competition;
      return `Corners Kill Switch 2 — ${cmpName} (${mkt} · não está na lista de ligas defensivas ativas para Corners Under)`;
    }
  } else if (mkt !== 'Over Corners 9.5') {
    // Mercado Under ou desconhecido: usa whitelist 6.5 como fallback (UCL KO incluído)
    const ok = isUCLKO || CORNERS_WHITELIST_65.some(w => competition.includes(w));
    if (!ok) {
      const cmpName = matchData.competition || competition;
      return `Corners Kill Switch 2 — ${cmpName} (${mkt} · fora da whitelist · precisão não validada)`;
    }
  }

  // KS3 — Over 9.5 bloqueado: sem Fire Zone, 48.7% global
  if (mkt === 'Over Corners 9.5') {
    return `Corners Kill Switch 3 — Over 9.5 bloqueado (48.7% global · sem Fire Zone validada)`;
  }

  return null; // aprovado
}

// ── Tracker ───────────────────────────────────────────────────────────────────
function _loadTracker() {
  try { return JSON.parse(readFileSync(TRACKER, 'utf8')); }
  catch {
    return {
      summary: {
        total_fired: 0, total_blocked: 0,
        total_resolved: 0, hits: 0, misses: 0,
        accuracy: null, last_updated: null,
      },
      fired_log: [], blocked_log: [],
    };
  }
}

function _saveTracker(t) {
  try { writeFileSync(TRACKER, JSON.stringify(t, null, 2), 'utf8'); }
  catch (err) { console.error('[Corners Tracker] Falha ao salvar tracker:', err.message); }
}

/**
 * Registra uma decisão Corners no tracker.
 *
 * @param {'fired'|'blocked'} decision
 * @param {object} result    — saída do agente
 * @param {object} matchData — dados da partida
 * @param {string|null} reason — motivo do bloqueio
 * @param {string} source    — pipeline de origem
 */
export function trackCornersDecision(decision, result, matchData, reason = null, source = 'prelive') {
  const tracker = _loadTracker();
  const now = new Date().toISOString();

  const entry = {
    ts:            now,
    source,
    match:         matchData.match || matchData.match_name || '',
    competition:   matchData.competition || matchData.league || '',
    mercado:       result.mercado || result.market || '',
    probabilidade: result.probabilidade,
    confianca:     result.confianca,
    recomendacao:  result.recomendacao || result.recommendation,
    // Auditoria M8 — rastreabilidade de versão (2026-04-16)
    prompt_version: process.env.CORNERS_PROMPT_VERSION || 'v2.1',
    model_version:  process.env.GROQ_MODEL              || 'llama-3.1-8b-instant',
    // Módulo 5 — rastreabilidade de fonte e qualidade de dados (2026-04-16)
    fonte_primaria: 'sofascore',
    dado_degradado: !(matchData.home?.corners_avg > 0 || matchData.away?.corners_avg > 0),
    lambda_fonte:   (matchData.home?.corners_avg > 0 && matchData.away?.corners_avg > 0)
      ? 'historico'
      : (matchData.home?.xg_avg > 0 ? 'estimado_xg' : 'estimado_base'),
    resolved:      false,
    acertou:       null,
    score_real:    null,
  };

  if (decision === 'fired') {
    tracker.fired_log.push(entry);
    tracker.summary.total_fired++;
  } else {
    tracker.blocked_log = tracker.blocked_log || [];
    tracker.blocked_log.push({ ...entry, kill_switch: reason || 'UNKNOWN' });
    tracker.summary.total_blocked++;
  }

  tracker.summary.last_updated = now;
  _saveTracker(tracker);
}
