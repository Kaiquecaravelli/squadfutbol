/**
 * goals-sniper.js — Kill Switches e Tracker do Goals Sniper v2
 *
 * Módulo central usado por TODOS os pipelines (PRÉ-LIVE, LIVE, LIVE-2T).
 * Garante aplicação consistente dos Kill Switches de gols em qualquer ponto de entrada.
 *
 * Arquitetura Tier (Módulo 2 · Drill G1 · 2026-04-16):
 *   Over 1.5 não tem Fire Zone real por confiança — a meta 88% exige restrição de liga.
 *   Drill G1 simulação: apenas Top3 (Eredivisie+UCL+Bundesliga) atingem 89% (265/299).
 *
 *   Tier 1 Elite  (prob ≥ 80%): Eredivisie 92.1% · Bundesliga 85.8% · UCL 84.2%
 *   Tier 2        (prob ≥ 82%): LaLiga 83.7% · PL 83.6% · Brasileirão 83.1%
 *   Tier 3        (prob ≥ 84%): Liga Portugal 82.1% · Serie A 80.3% (rebaixadas Drill G1)
 *   Não-listadas  (prob ≥ 85%): elevado de 83% (Drill G1 2026-04-16)
 *
 *   Over 2.5 e Over 3.5: Fire Zone absoluta conf ≥ 80% → 100% histórico.
 *   Sem alterações necessárias — KS7 já protege.
 *
 * Módulos implementados:
 *   Module 1 — Granularização por mercado: Championship bloqueada Over 1.5 / HABILITADA Under 1.5
 *   Module 3 — Under Intelligence: TIER1_UNDER15 (Championship/ConferenceLeague) · TIER1_UNDER25
 *   Module 5 — Emerging Leagues Watchlist: Eliteserien · Allsvenskan · Süper Lig · etc.
 *   Module 6 — Conference League: Over 1.5 HABILITADA (100% PIE real) · Under 1.5 BLOQUEADA
 *
 * Exporta:
 *   goalsKillSwitch(result, matchData)        → string (motivo) ou null (aprovado)
 *   goalsMinProbability(market, competition)  → número (threshold calibrado por tier)
 *   goalsMinConfidence(market)                → número (threshold confiança por mercado)
 *   trackGoalsDecision(decision, r, md, reason, source) → void
 *   GOALS_MIN_CONFIDENCE                      → 75 (padrão — Over 2.5 usa 80 via goalsMinConfidence)
 *   EMERGING_LEAGUES_WATCHLIST                → array de ligas em shadow mode para coleta
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirSn = dirname(fileURLToPath(import.meta.url));
const TRACKER = join(__dirSn, '../../data/goals-tracker.json');

// ── Thresholds Sniper v1 (calibrados: 100% de acurácia na fire zone 80%+) ──────
// Confiança padrão para todos os mercados de gols.
// Over 2.5 usa threshold elevado via goalsMinConfidence() — fire zone exige conf >= 80%.
export const GOALS_MIN_CONFIDENCE = 75;

// Threshold de confiança por mercado — Over 2.5/3.5 exigem 80% (fire zone absoluta)
// Under 1.5/2.5 usam 65% — mercados novos sem calibração histórica suficiente.
// Critério de revisão: quando n≥50 amostras reais, recalibrar com dados PIE.
const GOALS_CONFIDENCE_THRESHOLDS = {
  'Over 2.5':  80, // fire zone: 100% histórico com conf >= 80% (113 amostras)
  'Over 3.5':  80, // fire zone: 100% histórico com conf >= 80% (13 amostras)
  'Over 4.5':  80,
  // ── Under: piso absoluto 80% — sem tier especial, sem escalada ────────────
  // Dupla condição obrigatória: probabilidade Poisson ≥ 80% E confiança ≥ 80%
  // Ambas devem ser verdadeiras simultaneamente — uma sozinha não aprova.
  'Under 1.5': 80,
  'Under 2.5': 80,
  'Under 3.5': 80,
};

/**
 * Retorna o threshold mínimo de confiança para um mercado de gols.
 * Over 2.5 e Over 3.5 exigem 80% — fora da fire zone o histórico cai para 0%.
 */
export function goalsMinConfidence(market) {
  const mkt = (market || '').trim();
  return GOALS_CONFIDENCE_THRESHOLDS[mkt] ?? GOALS_MIN_CONFIDENCE;
}

// Threshold mínimo por mercado (padrão — pode ser reduzido em Tier 1 para Over 1.5)
const GOALS_THRESHOLDS = {
  'Over 1.5':  80,
  'Over 2.5':  80, // fire zone absoluta — 100% histórico com >= 80
  'Over 3.5':  80, // fire zone absoluta — 100% histórico com >= 80
  'Over 4.5':  85,
  'Under 2.5': 80,
  'Under 1.5': 80,
};

// ── Liga Tier Map para Over 1.5 ───────────────────────────────────────────────
// Drill G1 (2026-04-16): Full Tier1 = 84% · Top6 = 86% · Top3 = 89% ← única configuração
// que atinge meta 88% de certificação.
//
// TIER 1 ELITE — prob ≥ 80% (Fire Zone virtual por liga)
// Apenas estes 3 atingem 89% em 265/299 amostras — meta 88% aprovada
// ┌────────────────────┬──────┬──────┐
// │ Liga               │ Prec │  n   │
// ├────────────────────┼──────┼──────┤
// │ Eredivisie         │  92% │  ~80 │
// │ Champions League   │  84% │ ~160 │ ← KO stage 89.7%
// │ Bundesliga         │  86% │  ~90 │
// └────────────────────┴──────┴──────┘
const TIER1_OVER15 = [
  'eredivisie',
  'bundesliga',
  'champions league',  // UCL group 84.2% + KO 89.7% — ambos acima de 80%
  'conference league', // KO Phase: 7/7 = 100% Over 1.5 (PIE 2026) — TIER 1 Elite
];

// TIER 2 — precisão 83-84%, prob ≥ 82% (threshold ligeiramente elevado)
// Drill G1: Top6 com estes leagues = 86% (abaixo da meta 88%)
// ┌───────────────────┬──────┬──────┐
// │ LaLiga            │  84% │ ~130 │
// │ Premier League    │  84% │ ~120 │
// │ Brasileirão       │  83% │ ~142 │
// │ CONCACAF CC       │  ≥80%│  n<  │ estimativa — recalibrar com dados
// └───────────────────┴──────┴──────┘
const TIER2_OVER15 = [
  'laliga', 'la liga',
  'premier league',
  'brasileirão betano', 'brasileirao betano',
  'concacaf champions cup',
];

// TIER 3 — precisão 80-82%, prob ≥ 84% (threshold máximo pré-bloqueio)
// Drill G1 (2026-04-16): rebaixadas de Tier 1 — margem muito estreita
// ┌───────────────────┬──────┬──────┐
// │ Liga Portugal     │  82% │  123 │ ← rebaixada Drill G1
// │ Serie A           │  80% │  132 │ ← rebaixada Drill G1
// └───────────────────┴──────┴──────┘
const TIER3_OVER15 = [
  'liga portugal',   // 82.1% (n=123) — rebaixada de Tier 1 em 2026-04-16
  'serie a',         // 80.3% (n=132) — rebaixada de Tier 1 em 2026-04-16
];

// ── Kill Switch Patterns ────────────────────────────────────────────────────────

// KS1 — Liga Profesional Argentina (Over 2.5 = 42.6%, Over 3.5 = 15.7%)
const DEAD_LEAGUES_OVER25 = [
  'liga profesional',      // Argentina — 42.6% para Over 2.5
  'europa league',         // 47-50% para Over 2.5 (todas as fases)
  'conmebol sudamericana, group',  // 0-50% inconsistente
  'conmebol sudamericana, grupo',
];

// KS2 — Ligas mortas para Over 1.5 (precisão global < 80% com n ≥ 10)
// Calibração: pie.json byCompetition (dados reais)
const DEAD_LEAGUES_OVER15 = [
  'championship',            // inglesa — 33.3% (OURO para Under 1.5: ~67% → ver TIER1_UNDER15)
  '2\\. bundesliga',         // regex: 2. Bundesliga — 50.0% (bom para Under 1.5/2.5)
  'second bundesliga',
  'liga profesional',        // Argentina — 72.1% (n=233 — maior amostra, resultado conclusivo)
  'europa league',           // UEFA Europa League qualquer fase — 72-79%
  'ligue 1',                 // 75.5% (n=106) — abaixo do limiar Sniper
  'mls',                     // 77.7% (n=103) — abaixo do limiar Sniper
  'brasileirão série b',     // 77.4% (n=62)
  'brasileirao serie b',
  'conmebol sudamericana, qualification', // 75.0% (n=16)
  // Conference League REMOVIDA — PIE real: Over 1.5 = 7/7 = 100% (KO Phase 2026)
];

// KS3 — Ligue 1 requer threshold elevado para Over 2.5 (50.0% base rate)
const ELEVATED_THRESHOLD_LEAGUES = {
  'ligue 1': { 'Over 2.5': 82 },
};

// ── Module 1 — Under Market Tier System (2026-04-16) ──────────────────────────
//
// Ligas mortas para Over são frequentemente EXCELENTES para Under.
// Championship: 33% Over 1.5 → ~67% Under 1.5 → Tier 1 Under (provar com n≥30)
// Conference League: 15% BTTS, baixa pontuação → Under 2.5 promissora
// 2.Bundesliga: 50% Over 1.5 → ~50% Under 1.5 (neutro, threshold elevado)
//
// Critério de inclusão: inferência inversa dos dados Over existentes.
// NOTA: thresholds conservadores até n≥30 em dados diretos Under.

// TIER 1 Under 1.5 — alta probabilidade de Under (probabilidade > 65% de ~0-1 gols)
// Inferência: Over 1.5 < 40% implica Under 1.5 > 60%
// ┌────────────────────────┬────────────────────────────────────────────┐
// │ Championship           │ 33% Over 1.5 → ~67% Under 1.5 (inferido) │
// └────────────────────────┴────────────────────────────────────────────┘
// Conference League REMOVIDA: PIE real = 100% Over 1.5 (7/7). BTTS baixo ≠ baixo scoring.
const TIER1_UNDER15 = [
  'championship',       // ~67% Under 1.5 (inferido de 33% Over) — verificar com dados diretos
];

// TIER 1 Under 2.5 — baixa pontuação, Under 2.5 > 55% base rate
// ┌────────────────────────────────┬────────────────────────────────────────┐
// │ Europa League (grupos)         │ 47-50% Over 2.5 → ~50-53% Under 2.5  │
// │ Liga Profesional (Argentina)   │ 42.6% Over 2.5 → ~57% Under 2.5      │
// └────────────────────────────────┴────────────────────────────────────────┘
// Conference League REMOVIDA: Under 2.5 = 0/2 no PIE. Over 1.5 = 100%.
const TIER1_UNDER25 = [
  'liga profesional',   // 57.4% Under 2.5 (inferido de 42.6% Over)
  // 'europa league'    — aguarda dados diretos Under 2.5 para validar (~50-53%)
];

// ── Module 5 — Emerging Leagues Watchlist (2026-04-16) ────────────────────────
//
// Ligas com dados insuficientes (n < 30) mas com perfil promissor.
// Protocolo: coletar dados em SHADOW MODE → não gera sinais → só coleta PIE.
// Critério de promoção: n ≥ 30 com precisão ≥ 78% num mercado específico.
//
// Para habilitar shadow mode: adicionar ao PI.json byCompetition com flag shadow:true
// e monitorar via scripts/pie-diagnostics.js --watchlist
//
// Atualizar esta lista trimestralmente com base nos dados do PIE.
export const EMERGING_LEAGUES_WATCHLIST = [
  // Ligas nórdicas — alto volume de gols esperado (clima favorece jogos ofensivos)
  { competition: 'eliteserien',           priority: 'high',   targetMarkets: ['Over 1.5', 'Over Corners 6.5'] },
  { competition: 'allsvenskan',           priority: 'high',   targetMarkets: ['Over 1.5', 'Over Corners 6.5'] },
  { competition: 'superliga turca',       priority: 'medium', targetMarkets: ['Over 2.5', 'BTTS'] },
  { competition: 'süper lig',             priority: 'medium', targetMarkets: ['Over 2.5', 'BTTS'] },
  // Ligas sul-americanas adicionais
  { competition: 'primera division',      priority: 'medium', targetMarkets: ['Under 2.5'] },  // Uruguai/Chile
  { competition: 'liga 1',               priority: 'low',    targetMarkets: ['Over 1.5'] },    // Peru/Tailândia
  // Conference League — Over 1.5 = 100% PIE; coletar Over 2.5 e Corners para expandir
  { competition: 'conference league',     priority: 'high',   targetMarkets: ['Over 2.5', 'Over Corners 6.5'], note: 'Over 1.5=100% confirmado; próximo: Over 2.5 e Corners KO' },
  // Championship inglesa (ouro para Under 1.5 se dados confirmarem)
  { competition: 'championship',          priority: 'high',   targetMarkets: ['Under 1.5'],               note: '33% Over → inferir Under, validar com n≥30' },
];

// ── Kill Switch Engine ──────────────────────────────────────────────────────────
/**
 * Aplica os Kill Switches do Goals Sniper v1 sobre uma análise de gols.
 * Deve ser chamado ANTES dos thresholds de prob/conf.
 *
 * @param {object} result    — saída do agente (probabilidade, confianca, mercado)
 * @param {object} matchData — dados da partida (competition, league, odds)
 * @returns {string|null}    — motivo do bloqueio, ou null se aprovado
 */
export function goalsKillSwitch(result, matchData) {
  const competition = (
    matchData.competition ||
    matchData.league      ||
    matchData.competicao  ||
    ''
  ).toLowerCase();

  const mkt   = (result.mercado || result.market || '').trim();
  const prob  = result.probabilidade ?? 0;

  // KS1 — Liga Profesional Argentina (zona morta para Over 2.5/3.5)
  if (competition.includes('liga profesional')) {
    if (mkt === 'Over 2.5' || mkt === 'Over 3.5') {
      return `Kill Switch 1 — Liga Profesional Argentina (Over 2.5: 42.6% | Over 3.5: 15.7% histórico)`;
    }
  }

  // KS2 — UEFA Europa League (qualquer fase, Over 2.5)
  if (competition.includes('europa league') && (mkt === 'Over 2.5' || mkt === 'Over 3.5')) {
    return `Kill Switch 2 — Europa League (47-50% histórico para Over 2.5/3.5)`;
  }

  // KS3 — CONMEBOL Sudamericana grupos (Over 2.5)
  if (/conmebol\s+sudamericana.*(group|grupo)/i.test(competition) && mkt === 'Over 2.5') {
    return `Kill Switch 3 — CONMEBOL Sudamericana grupos (0-50% inconsistente para Over 2.5)`;
  }

  // KS4 — Divisões inferiores e ligas mortas (Over 1.5)
  if (mkt === 'Over 1.5') {
    const isDeadLeague15 = DEAD_LEAGUES_OVER15.some(p => {
      try { return new RegExp(p, 'i').test(competition); } catch { return false; }
    });
    if (isDeadLeague15) {
      return `Kill Switch 4 — Liga inferior/morta Over 1.5 (Championship 33% | 2.Bundesliga 50% | bloqueada)`;
    }
  }

  // KS4b — Over 1.5 · Tier 2 · threshold elevado (prob mínima 82%)
  // Drill G1 (2026-04-16): LaLiga/PL/Brasileirão = 83-84% — exige sinal mais forte
  if (mkt === 'Over 1.5') {
    const isTier2 = TIER2_OVER15.some(p => competition.includes(p));
    if (isTier2 && prob < 82) {
      return `Kill Switch 4b — ${matchData.competition || competition} (Tier 2 Over 1.5 · 83-84% base · prob ${prob}% < 82% mínimo)`;
    }
  }

  // KS4c — Over 1.5 · Tier 3 · threshold elevado máximo (prob mínima 84%)
  // Drill G1 (2026-04-16): Liga Portugal 82.1% e Serie A 80.3% — margem estreita, exige prob alta
  if (mkt === 'Over 1.5') {
    const isTier3 = TIER3_OVER15.some(p => competition.includes(p));
    if (isTier3 && prob < 84) {
      return `Kill Switch 4c — ${matchData.competition || competition} (Tier 3 Over 1.5 · 80-82% base · prob ${prob}% < 84% mínimo)`;
    }
  }

  // KS5 — Ligue 1 com prob abaixo do threshold elevado (Over 2.5)
  if (mkt === 'Over 2.5' && competition.includes('ligue 1')) {
    const minProb = ELEVATED_THRESHOLD_LEAGUES['ligue 1']?.['Over 2.5'] ?? 80;
    if (prob < minProb) {
      return `Kill Switch 5 — Ligue 1 (50% base rate — Over 2.5 requer prob >= ${minProb}%, atual: ${prob}%)`;
    }
  }

  // KS6 — Over 3.5 abaixo do threshold mínimo (0% na faixa 60-70%)
  if (mkt === 'Over 3.5' && prob < 80) {
    return `Kill Switch 6 — Over 3.5 com prob ${prob}% < 80% (0% acurácia histórica nessa faixa)`;
  }

  // KS7 — Over 2.5/3.5 em qualquer liga fora da fire zone (sem FZ ativa)
  // → Bloqueia se prob < 80 (fire zone começa em 80%)
  if ((mkt === 'Over 2.5' || mkt === 'Over 3.5') && prob < 80) {
    return `Kill Switch 7 — ${mkt} com prob ${prob}% fora da fire zone (exige >= 80% para 100% histórico)`;
  }

  // ── Module 3 — Under Market Intelligence (2026-04-16) ──────────────────────
  // Under markets têm kill switches INVERTIDOS:
  //   Ligas mortas para Over → potencialmente EXCELENTES para Under.
  //   Threshold conservador até dados diretos Under acumularem n ≥ 30.

  // ── KS8-10 — Under: piso absoluto 80% — sem Tier especial, sem escalada ──────
  // Gate Under elevado para 80% em 2026-04-16 (spec v3):
  //   · Piso inviolável: 80% de probabilidade Poisson
  //   · Piso inviolável: 80% de confiança (verificado em goalsMinConfidence)
  //   · Nenhuma liga ou contexto reduz esse piso
  //   · Tier 1 Under removido — Championship não tem dados diretos suficientes
  if (mkt === 'Under 1.5' && prob < 80) {
    return `Kill Switch 8 — Under 1.5 — prob ${prob}% < 80% (piso absoluto inviolável — nenhuma liga reduz este gate)`;
  }
  if (mkt === 'Under 2.5' && prob < 80) {
    return `Kill Switch 9 — Under 2.5 — prob ${prob}% < 80% (piso absoluto inviolável — nenhuma liga reduz este gate)`;
  }
  if (mkt === 'Under 3.5' && prob < 80) {
    return `Kill Switch 10 — Under 3.5 — prob ${prob}% < 80% (piso absoluto inviolável — nenhuma liga reduz este gate)`;
  }

  return null; // aprovado
}

/**
 * Retorna o threshold mínimo de probabilidade para o mercado e competição.
 *
 * Over 1.5 usa sistema de 3 tiers (Drill G1 · 2026-04-16):
 *   Tier 1 Elite  (Eredivisie, Bundesliga, UCL)         → 80%
 *   Tier 2        (LaLiga, PL, Brasileirão, CONCACAF)   → 82%
 *   Tier 3        (Liga Portugal, Serie A)               → 84%
 *   Não-listadas                                         → 85% (elevado de 83%)
 */
export function goalsMinProbability(market, competition = '') {
  const mkt  = (market || '').trim();
  const comp = competition.toLowerCase();

  // Threshold elevado para Ligue 1 Over 2.5
  if (mkt === 'Over 2.5' && comp.includes('ligue 1')) return 82;

  // Sistema 3-tier para Over 1.5 (Drill G1 2026-04-16)
  if (mkt === 'Over 1.5') {
    if (TIER1_OVER15.some(p => comp.includes(p))) return 80; // Elite Fire Zone
    if (TIER2_OVER15.some(p => comp.includes(p))) return 82; // Tier 2 elevado
    if (TIER3_OVER15.some(p => comp.includes(p))) return 84; // Tier 3 máx elevado
    return 85; // não-listada: elevado de 83% → Drill G1
  }

  // Under: piso absoluto 80% — sem tier especial (gate elevado 2026-04-16)
  if (mkt === 'Under 1.5' || mkt === 'Under 2.5' || mkt === 'Under 3.5') return 80;

  return GOALS_THRESHOLDS[mkt] ?? 80;
}

// ── Tracker ─────────────────────────────────────────────────────────────────────
function _loadTracker() {
  try { return JSON.parse(readFileSync(TRACKER, 'utf8')); }
  catch { return null; }
}

function _saveTracker(t) {
  try { writeFileSync(TRACKER, JSON.stringify(t, null, 2), 'utf8'); }
  catch (err) { console.error('[Goals Tracker] Falha ao salvar tracker:', err.message); }
}

/**
 * Registra uma decisão Goals no tracker para acompanhamento de precisão.
 *
 * @param {'fired'|'blocked'} decision
 * @param {object} result       — saída do agente
 * @param {object} matchData    — dados da partida
 * @param {string|null} reason  — motivo do bloqueio (se blocked)
 * @param {string} source       — pipeline de origem ('prelive'|'live'|'live-2t'|'live-2h')
 */
export function trackGoalsDecision(decision, result, matchData, reason = null, source = 'prelive') {
  const tracker = _loadTracker();
  if (!tracker) return;

  const matchId = `${matchData.home?.team || matchData.home_team || ''}` +
                  `_${matchData.away?.team || matchData.away_team || ''}`;
  const now = new Date().toISOString();

  // Drill G2: captura eficiência xG de ambos os times para diagnóstico de precisão futura
  // xg_efficiency = xG_total / shots_on_target_total (quanto gol por chute perigoso)
  // Sinal: alta eficiência (> 0.35) indica times clínicos → Over 1.5 mais provável
  const homeXg      = matchData.home?.xg   ?? matchData.home_xg   ?? null;
  const awayXg      = matchData.away?.xg   ?? matchData.away_xg   ?? null;
  const homeSot     = matchData.home?.sot   ?? matchData.home_sot  ?? null;
  const awaySot     = matchData.away?.sot   ?? matchData.away_sot  ?? null;
  const totalXg     = (homeXg !== null && awayXg !== null) ? homeXg + awayXg : null;
  const totalSot    = (homeSot !== null && awaySot !== null) ? homeSot + awaySot : null;
  const xgEffic     = (totalXg && totalSot && totalSot > 0)
    ? Math.round((totalXg / totalSot) * 1000) / 1000
    : null;

  const entry = {
    match_name:    matchData.match || matchData.match_name || matchId,
    competition:   matchData.competition || matchData.league || '',
    match_date:    matchData.date || matchData.match_date || now,
    fired_at:      now,
    mercado:       result.mercado || result.market || '',
    probabilidade: result.probabilidade,
    confianca:     result.confianca,
    recomendacao:  result.recomendacao || result.recommendation,
    // Drill G2 — rastreamento de eficiência xG
    xg_home:          homeXg,
    xg_away:          awayXg,
    xg_total:         totalXg,
    sot_home:         homeSot,
    sot_away:         awaySot,
    xg_efficiency:    xgEffic,  // xG/SOT — alto (>0.35) = times clínicos
    // Auditoria M8 — rastreabilidade de versão (2026-04-16)
    prompt_version:  process.env.GOALS_PROMPT_VERSION || 'v2.0',
    model_version:   process.env.GROQ_MODEL           || 'llama-3.1-8b-instant',
    source,
    // Módulo 5 — rastreabilidade de fonte e qualidade de dados (2026-04-16)
    fonte_primaria:   'academia',
    dado_degradado:   !(matchData.home?.goals_scored_avg > 0 || matchData.home?.xg_avg > 0),
    janela_divergente: (
      matchData.home?.over15_pct_5j != null &&
      matchData.home?.over15_pct_8j != null &&
      Math.abs(matchData.home.over15_pct_5j - matchData.home.over15_pct_8j) > 25
    ) || (
      matchData.away?.over15_pct_5j != null &&
      matchData.away?.over15_pct_8j != null &&
      Math.abs(matchData.away.over15_pct_5j - matchData.away.over15_pct_8j) > 25
    ),
    resolved:      false,
    acertou:       null,
    score_real:    null,
  };

  if (decision === 'fired') {
    tracker.fired_log = tracker.fired_log || [];
    tracker.fired_log.push(entry);
    tracker.summary.total_fired = (tracker.summary.total_fired || 0) + 1;
  } else {
    // blocked
    tracker.blocked_log = tracker.blocked_log || [];
    tracker.blocked_log.push({ ...entry, kill_switch: reason || 'UNKNOWN' });
    tracker.summary.total_blocked = (tracker.summary.total_blocked || 0) + 1;

    // Shadow mode: v1 sem sniper (prob >= 80%) teria disparado?
    const recom = (result.recomendacao || result.recommendation || '').toUpperCase();
    const v0WouldFire = (result.probabilidade >= 80) && (recom === 'APOSTAR');
    tracker.shadow_log = tracker.shadow_log || [];
    tracker.shadow_log.push({ ...entry, kill_switch: reason, v0_would_fire: v0WouldFire });
  }

  tracker.summary.last_updated = now;
  _saveTracker(tracker);
}
