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
 *   Tier 1 Elite  (prob ≥ 80%): Eredivisie 92.1% · Bundesliga 85.8% · UCL 84.2% · Brasileirão 83.1% (shadow mode 2026-04-21)
 *   Tier 2        (prob ≥ 82%): LaLiga 83.7% · PL 83.6%
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
  'champions league',     // UCL group 84.2% + KO 89.7% — ambos acima de 80%
  'conference league',    // KO Phase: 7/7 = 100% Over 1.5 (PIE 2026) — TIER 1 Elite
  'brasileirão betano',   // 83.1% (n=142) — promovido shadow mode 2026-04-21
  'brasileirao betano',
];

// TIER 2 — precisão 83-84%, prob ≥ 82% (threshold ligeiramente elevado)
// Drill G1: Top6 com estes leagues = 86% (abaixo da meta 88%)
// ┌───────────────────┬──────┬──────┐
// │ LaLiga            │  84% │ ~130 │
// │ Premier League    │  84% │ ~120 │
// │ CONCACAF CC       │  ≥80%│  n<  │ estimativa — recalibrar com dados
// └───────────────────┴──────┴──────┘
// Brasileirão promovido para Tier 1 (shadow mode confirmado 2026-04-21):
//   83.1% real com n=142 → tolerância de 80% aprovada pelo estudo PIE
const TIER2_OVER15 = [
  'laliga', 'la liga',
  'premier league',
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

// ── Padrões Over Gols (calibração 19/04/2026) ────────────────────────────────
//
// 12 padrões P_G1–P_G12 extraídos de 15 jogos confirmados.
// aplicarPadroesOverGols() deve ser chamada ANTES dos Kill Switches no funil
// para que padrões positivos possam elevar sinais borderline acima dos gates.
//
// Estrutura de cada padrão:
//   id:      identificador único
//   mercado: mercado-alvo (Over 1.5 / Over 2.5 / Over 3.5 / null = todos)
//   ativo:   função predicado (result, matchData) → boolean
//   delta:   ajuste em pp (positivo = bônus, negativo = penalidade)
//   fator:   multiplicador lambda opcional (undefined = sem ajuste)
//
// Limite total: delta positivo ≤ +20pp | delta negativo sem limite mínimo.
// Múltiplos padrões positivos acumulam até o limite. Negativos sempre se aplicam.

const _COPA_DOMESTICA_LIGAS = [
  'fa cup', 'copa do brasil', 'copa argentina', 'copa del rey',
  'dfb-pokal', 'coupe de france', 'coppa italia',
];

const _SEGUNDA_DIV_OFENSIVA = [
  'ligue 2', 'championnat national', '2. liga österreich',
];

const _SERIE_A_ITALIANA = ['serie a', 'serie b'];  // detecta cultura defensiva italiana

// P_G9 lambda Ligue 2 e P_G12 lambda Serie A italiana são aplicados à probabilidade
// via fator multiplicativo antes dos ajustes pp.

const PADROES_OVER_GOLS = [
  {
    // P_G1 — Gate Over 1.5: penalidade universal para sinais fracos
    // Ligas de alto volume são Tier 1 e já têm prob ≥ 80% exigida.
    // Sinal abaixo de 78% em Over 1.5 indica jogo defensivo → penalidade.
    id: 'P_G1_OVER15_GATE_FRACO',
    mercado: 'Over 1.5',
    ativo: (r, _md) => (r.probabilidade ?? 0) < 78,
    delta: -2,
  },
  {
    // P_G2 — Motivações opostas urgentes: campeão vs rebaixado → jogo aberto
    // Ambos os times PRECISAM dos 3 pontos → alta taxa de gols histórica.
    id: 'P_G2_MOTIVACOES_OPOSTAS',
    mercado: 'Over 3.5',
    ativo: (r, md) => {
      const posC = md.home?.position ?? md.home_position ?? null;
      const posF = md.away?.position ?? md.away_position ?? null;
      const total = md.total_teams ?? md.teams_in_league ?? 20;
      if (posC === null || posF === null) return false;
      const topTier   = Math.min(posC, posF) <= 3;
      const botTier   = Math.max(posC, posF) >= total - 2;
      return topTier && botTier;
    },
    delta: 10,
  },
  {
    // P_G3 — Copa doméstica: fase mata-mata → times abertos, menos cálculo
    id: 'P_G3_COPA_DOMESTICA',
    mercado: 'Over 3.5',
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      return _COPA_DOMESTICA_LIGAS.some(c => comp.includes(c));
    },
    delta: 8,
  },
  {
    // P_G4 — Mandante prolífico ≥ 2.2 gols/jogo: pressão ofensiva constante
    id: 'P_G4_MANDANTE_PROLIFICO',
    mercado: 'Over 3.5',
    ativo: (_r, md) => {
      const avg = md.home?.goals_scored_avg ?? md.home_goals_avg ?? null;
      return avg !== null && avg >= 2.2;
    },
    delta: 7,
  },
  {
    // P_G5 — Serie A italiana + zona de rebaixamento: desespero defensivo quebra
    // Time em rebaixamento na Serie A abre o jogo → Over 2.5 e 3.5 sobem.
    id: 'P_G5_SERIEA_REBAIXAMENTO',
    mercado: null, // aplica a Over 2.5 e Over 3.5 (filtro interno)
    ativo: (r, md) => {
      const comp  = (md.competition || md.league || '').toLowerCase();
      const isSerieA = comp.includes('serie a') && !comp.includes('brasileir');
      const mkt   = (r.mercado || r.market || '').trim();
      const valid = (mkt === 'Over 2.5' || mkt === 'Over 3.5');
      const total = md.total_teams ?? 20;
      const posH  = md.home?.position ?? md.home_position ?? null;
      const posA  = md.away?.position ?? md.away_position ?? null;
      const inRelZ = (posH !== null && posH >= total - 3) ||
                     (posA !== null && posA >= total - 3);
      return isSerieA && valid && inRelZ;
    },
    delta: (r) => {
      const mkt = (r.mercado || r.market || '').trim();
      return mkt === 'Over 3.5' ? 6 : 5;
    },
  },
  {
    // P_G6 — Premier League: penalidade Over 3.5
    // PL tem estrutura defensiva sólida mesmo nos jogos ofensivos — Over 3.5 é raro.
    id: 'P_G6_PL_PENALIDADE_OVER35',
    mercado: 'Over 3.5',
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      return comp.includes('premier league');
    },
    delta: -7,
  },
  {
    // P_G7 — Championship playoff: pressão máxima → jogo aberto garantido
    // Todos os 4 times precisam vencer → intensidade máxima → mais gols.
    id: 'P_G7_CHAMPIONSHIP_PLAYOFF',
    mercado: 'Over 3.5',
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isChamp = comp.includes('championship');
      const isPlayoff = comp.includes('playoff') || comp.includes('play-off') ||
                        (md.stage || '').toLowerCase().includes('playoff');
      return isChamp && isPlayoff;
    },
    delta: 7,
  },
  {
    // P_G8 — Zona intermediária sem pressão: equipes sem motivação → pouco risco
    // Posição 8–14 sem pressão por título ou rebaixamento → jogo controlado.
    id: 'P_G8_ZONA_INTERMEDIARIA',
    mercado: 'Over 2.5',
    ativo: (_r, md) => {
      const total = md.total_teams ?? 20;
      const posH = md.home?.position ?? md.home_position ?? null;
      const posA = md.away?.position ?? md.away_position ?? null;
      if (posH === null || posA === null) return false;
      const midLow  = Math.ceil(total * 0.35);
      const midHigh = Math.ceil(total * 0.70);
      const bothMid = posH >= midLow && posH <= midHigh &&
                      posA >= midLow && posA <= midHigh;
      return bothMid;
    },
    delta: -6,
  },
  {
    // P_G9 — Ligue 2 ofensiva: menos estrutura defensiva, mais gols
    // Calibração PIE: lambda ×1.06 eleva probabilidade base.
    id: 'P_G9_LIGUE2_OFENSIVA',
    mercado: 'Over 3.5',
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      return _SEGUNDA_DIV_OFENSIVA.some(c => comp.includes(c));
    },
    delta: 7,
    fator: 1.06,
  },
  {
    // P_G10 — Recém-promovido vs Top 5: desequilíbrio → espaços abertos
    // Top 5 ataca, promovido contraataca → jogo com muitos gols.
    id: 'P_G10_RECEM_PROMOVIDO_VS_TOP5',
    mercado: 'Over 2.5',
    ativo: (_r, md) => {
      const posH = md.home?.position ?? md.home_position ?? null;
      const posA = md.away?.position ?? md.away_position ?? null;
      const isPromH = md.home?.newly_promoted === true || md.home_newly_promoted === true;
      const isPromA = md.away?.newly_promoted === true || md.away_newly_promoted === true;
      const isNewlyPromoted = isPromH || isPromA;
      const hasTop5 = (posH !== null && posH <= 5) || (posA !== null && posA <= 5);
      return isNewlyPromoted && hasTop5;
    },
    delta: 6,
  },
  {
    // P_G11 — Série B brasileira Over 2.5: lambda conservador 0.97
    // Brasileirão Série B tende a ser menos goleada que Série A.
    id: 'P_G11_SERIE_B_BRASILEIRA',
    mercado: 'Over 2.5',
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      return comp.includes('série b') || comp.includes('serie b') ||
             comp.includes('brasileirao serie b') || comp.includes('brasileirão série b');
    },
    delta: 3,
    fator: 0.97,
  },
  {
    // P_G12 — Cultura defensiva italiana: lambda ×0.92 + penalidade Over 3.5
    // Serie A e Serie B italiana têm os melhores sistemas defensivos da Europa.
    id: 'P_G12_CULTURA_DEFENSIVA_IT',
    mercado: 'Over 3.5',
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isItalian = _SERIE_A_ITALIANA.some(c => comp.includes(c));
      // exclui "Brasileirão Série A/B" e "Serie B brasileira"
      const isBrazilian = comp.includes('brasil') || comp.includes('betano');
      return isItalian && !isBrazilian;
    },
    delta: -5,
    fator: 0.92,
  },
];

/**
 * Aplica os padrões P_G1–P_G12 sobre uma análise de gols.
 * Deve ser chamada ANTES de goalsKillSwitch() no funil.
 *
 * @param {object} result    — saída do agente (probabilidade, mercado, ...)
 * @param {object} matchData — dados da partida (competition, home, away, ...)
 * @returns {{ result: object, delta_total: number, padroes_ativos: string[] }}
 */
export function aplicarPadroesOverGols(result, matchData) {
  const mktResult = (result.mercado || result.market || '').trim();
  let prob        = result.probabilidade ?? 0;
  let deltaTotal  = 0;
  const ativos    = [];

  const MAX_BONUS = 20; // pp cap para bônus positivos
  let bonusAcum   = 0;

  for (const padrao of PADROES_OVER_GOLS) {
    // Filtra por mercado se o padrão tem alvo específico
    if (padrao.mercado && padrao.mercado !== mktResult) continue;

    // Avalia predicado
    let isAtivo = false;
    try { isAtivo = padrao.ativo(result, matchData); } catch { continue; }
    if (!isAtivo) continue;

    // Calcula delta (pode ser função ou número)
    const delta = typeof padrao.delta === 'function' ? padrao.delta(result) : padrao.delta;

    // Aplica fator multiplicativo lambda se existir
    if (padrao.fator) {
      prob = Math.min(Math.round(prob * padrao.fator), 99);
    }

    // Acumula delta respeitando cap de bônus positivo
    if (delta > 0) {
      const aplicar = Math.min(delta, MAX_BONUS - bonusAcum);
      if (aplicar <= 0) { ativos.push(`${padrao.id}(cap)`); continue; }
      bonusAcum  += aplicar;
      deltaTotal += aplicar;
      ativos.push(`${padrao.id}(+${aplicar}pp)`);
    } else {
      // Penalidades aplicam sempre (sem limite mínimo)
      deltaTotal += delta;
      ativos.push(`${padrao.id}(${delta}pp)`);
    }
  }

  const prob_final = Math.min(Math.max(prob + deltaTotal, 0), 99);
  return {
    result:        { ...result, probabilidade: Math.round(prob_final) },
    delta_total:   deltaTotal,
    padroes_ativos: ativos,
  };
}

// ── Padrões Under Gols (calibração 19/04/2026) ──────────────────────────────
//
// 10 padrões P_U1–P_U10 extraídos de 9 jogos Under confirmados.
// Média da amostra: 1.33 gols/jogo. Under 2.5: 9/9 · Under 3.5: 9/9.
// aplicarPadroesUnderGols() deve ser chamada ANTES de goalsKillSwitch() no funil.
//
// O gate absoluto de 80% (KS8-10) permanece inviolável — os bônus ajudam a
// CHEGAR ao gate, nunca a CONTORNÁ-lo.
//
// Estrutura:
//   id:        identificador único
//   delta15:   ajuste em pp para Under 1.5 (0 = não se aplica)
//   delta25:   ajuste em pp para Under 2.5 (0 = não se aplica)
//   fator:     multiplicador lambda opcional (undefined = sem ajuste)
//   ativo:     predicado (result, matchData) → boolean
//
// Cap: bônus positivos acumulam até +20pp por mercado. Penalidades ilimitadas.

// ── Helpers internos Under ────────────────────────────────────────────────────

function _gConcedidosCasa(md) {
  return md.home?.goals_conceded_avg ??
         md.home?.goals_against_avg  ??
         md.home_goals_conceded_avg  ?? null;
}
function _gConcedidosFora(md) {
  return md.away?.goals_conceded_avg ??
         md.away?.goals_against_avg  ??
         md.away_goals_conceded_avg  ?? null;
}
function _gMarcadosFora(md) {
  return md.away?.goals_scored_avg   ??
         md.away?.goals_for_avg      ??
         md.away_goals_scored_avg    ?? null;
}
function _gMarcadosCasa(md) {
  return md.home?.goals_scored_avg   ??
         md.home?.goals_for_avg      ??
         md.home_goals_scored_avg    ?? null;
}

/**
 * Fator de perfil defensivo combinado.
 * Quanto menor a média de gols sofridos dos dois times, menor o fator.
 * Retorna 0.75–1.05 multiplicado pela prob base.
 */
function _fatorPerfilDefensivo(matchData) {
  const gc = _gConcedidosCasa(matchData);
  const gf = _gConcedidosFora(matchData);
  if (gc === null && gf === null) return 1.0; // sem dados — neutro
  const vals = [gc, gf].filter(v => v !== null);
  const media = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (media <= 0.60) return 0.75;
  if (media <= 0.80) return 0.85;
  if (media <= 1.00) return 0.92;
  if (media <= 1.20) return 0.98;
  return 1.05;
}

const _ITALIA_COMPS  = ['serie a', 'serie b', 'coppa italia'];
const _BRASIL_EXCL   = ['brasil', 'betano', 'série b', 'serie b'];

const PADROES_UNDER_GOLS = [
  {
    // P_U1 — Itália: DNA defensivo cultural (3/3 = 100% na amostra)
    // Serie A: 1.50 gols/j · Serie B: 0.00 gols/j
    id: 'P_U1_ITALIA_UNDER_DNA',
    delta15: 5, delta25: 9,
    fator: (md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      if (comp.includes('serie b')) return 0.85;
      return 0.88; // serie a + coppa italia
    },
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isIT = _ITALIA_COMPS.some(c => comp.includes(c));
      const isBR = _BRASIL_EXCL.some(c => comp.includes(c));
      return isIT && !isBR;
    },
  },
  {
    // P_U2 — Time com DNA defensivo ≤ 0.80 gols sofridos/jogo
    // Palmeiras 1-0, Juventus 2-0, AC Milan 1-0 (3/9)
    id: 'P_U2_DNA_DEFENSIVO_TIME',
    delta15: 4, delta25: 8,
    ativo: (_r, md) => {
      const gc = _gConcedidosCasa(md);
      const gf = _gConcedidosFora(md);
      return (gc !== null && gc <= 0.80) || (gf !== null && gf <= 0.80);
    },
  },
  {
    // P_U3 — Divisão inferior (Série C BR / Serie B IT) + ataque fraco
    // Londrina 0-0 Ceará, Cremonese 0-0 Torino (2/9)
    id: 'P_U3_DIV_INFERIOR_ATAQUE_FRACO',
    delta15: 7, delta25: 5,
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isDivInf = comp.includes('serie c') ||
                       (comp.includes('serie b') && !comp.includes('brasileir') && !comp.includes('betano')) ||
                       comp.includes('championship');
      const gcH = _gMarcadosCasa(md);
      const gcA = _gMarcadosFora(md);
      const ataqueFragil = (gcH !== null && gcH <= 1.0) || (gcA !== null && gcA <= 1.0);
      return isDivInf && ataqueFragil;
    },
  },
  {
    // P_U4 — Time que gere resultado: mandante favorito com perfil 1-0/2-0
    // Palmeiras, Juventus: vencem e fecham o jogo (2/9)
    id: 'P_U4_GESTAO_RESULTADO',
    delta15: 0, delta25: 6,
    ativo: (_r, md) => {
      const posH = md.home?.position ?? md.home_position ?? null;
      // Dados de % jogos 1-0/2-0 raramente disponíveis — usa proxy: mandante elite + defensivo
      if (posH === null) return false;
      const gc = _gConcedidosCasa(md);
      const gm = _gMarcadosCasa(md);
      const ehFavorito  = posH <= 5;
      const ehDefensivo = gc !== null && gc <= 0.85;
      const ehEficiente = gm !== null && gm >= 1.5 && gm <= 2.2; // marca mas não explode
      return ehFavorito && ehDefensivo && ehEficiente;
    },
  },
  {
    // P_U5 — Zona intermediária = Under natural (complemento de P_G8)
    // Botafogo-SP 1-1 e Nantes 1-1 (2/9)
    id: 'P_U5_ZONA_INTERMEDIARIA_UNDER',
    delta15: 0, delta25: 6,
    ativo: (_r, md) => {
      const total = md.total_teams ?? md.teams_in_league ?? 20;
      const posH  = md.home?.position ?? md.home_position ?? null;
      const posA  = md.away?.position ?? md.away_position ?? null;
      if (posH === null || posA === null) return false;
      const midLow  = Math.ceil(total * 0.35);
      const midHigh = Math.ceil(total * 0.70);
      return posH >= midLow && posH <= midHigh &&
             posA >= midLow && posA <= midHigh;
    },
  },
  {
    // P_U6 — Visitante fraco ofensivamente + mandante defensivo em casa
    // 7/9 jogos Under: visitante não marcou ou marcou apenas 1 gol
    id: 'P_U6_VISITANTE_FRACO_MANDANTE_DEFENSIVO',
    delta15: 0, delta25: 7,
    ativo: (_r, md) => {
      const gMarcFora  = _gMarcadosFora(md);
      const gConcCasa  = _gConcedidosCasa(md);
      return (gMarcFora !== null && gMarcFora <= 1.0) &&
             (gConcCasa !== null && gConcCasa <= 0.80);
    },
  },
  {
    // P_U7 — Série A brasileira com mandante de perfil defensivo
    // Coritiba 2-0 Atlético-MG, Palmeiras 1-0 Athletico-PR (2/9)
    id: 'P_U7_SERIE_A_BR_MANDANTE_DEFENSIVO',
    delta15: 0, delta25: 5,
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isSerieA = (comp.includes('brasileir') || comp.includes('brasileirao')) &&
                       !comp.includes('serie b') && !comp.includes('série b') &&
                       !comp.includes('serie c');
      const gc = _gConcedidosCasa(md);
      return isSerieA && gc !== null && gc <= 0.85;
    },
  },
  {
    // P_U8 — Série B/C brasileira sem urgência = lambda 0.88
    // Goiás 0-2 e Botafogo 1-1 na Série B, Londrina 0-0 na Série C (2/9)
    id: 'P_U8_SERIE_BC_SEM_URGENCIA',
    delta15: 0, delta25: 4,
    fator: 0.88,
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isDivInf = (comp.includes('serie b') || comp.includes('série b') ||
                        comp.includes('serie c') || comp.includes('série c')) &&
                       (comp.includes('brasileir') || comp.includes('brasil'));
      const total  = md.total_teams ?? 20;
      const posH   = md.home?.position ?? md.home_position ?? null;
      const posA   = md.away?.position ?? md.away_position ?? null;
      if (!isDivInf || posH === null || posA === null) return false;
      const zonaSeg = (pos) => pos >= 4 && pos <= Math.floor(total * 0.75);
      return zonaSeg(posH) && zonaSeg(posA);
    },
  },
  {
    // P_U9 — Dupla defensiva italiana = Under extremo
    // AC Milan × Verona e Cremonese × Torino (2/9)
    id: 'P_U9_DUPLA_DEFENSIVA_ITALIANA',
    delta15: 8, delta25: 6,
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isIT = _ITALIA_COMPS.some(c => comp.includes(c));
      const isBR = _BRASIL_EXCL.some(c => comp.includes(c));
      if (!isIT || isBR) return false;
      const gcH = _gConcedidosCasa(md);
      const gcA = _gConcedidosFora(md);
      // Ambos defensivos: média de gols sofridos ≤ 1.0
      return gcH !== null && gcH <= 1.0 && gcA !== null && gcA <= 1.0;
    },
  },
  // P_U10 — Princípio: contexto supera liga. Sem bônus direto — aplicado via fator de perfil.
  // Implementado como _fatorPerfilDefensivo() acima, que pondera gols sofridos de ambos os times.
];

/**
 * Aplica os padrões P_U1–P_U9 sobre uma análise de mercado Under.
 * Deve ser chamada ANTES de goalsKillSwitch() no funil.
 * O gate 80% permanece inviolável — Kill Switches KS8-10 continuam ativos.
 *
 * @param {object} result    — saída do agente (probabilidade, mercado, ...)
 * @param {object} matchData — dados da partida
 * @returns {{ result: object, delta_total: number, padroes_ativos: string[] }}
 */
export function aplicarPadroesUnderGols(result, matchData) {
  const mktResult = (result.mercado || result.market || '').trim().toLowerCase();
  const isUnder15 = /^under\s*1\.5$/i.test(mktResult);
  const isUnder25 = /^under\s*2\.5$/i.test(mktResult);
  const isUnder35 = /^under\s*3\.5$/i.test(mktResult);
  if (!isUnder15 && !isUnder25 && !isUnder35) return { result, delta_total: 0, padroes_ativos: [] };

  let prob       = result.probabilidade ?? 0;
  let deltaTotal = 0;
  let bonusAcum  = 0;
  const ativos   = [];
  const MAX_BONUS = 20;

  // P_U10: fator de perfil defensivo (princípio — contexto > liga)
  const fatorPerfil = _fatorPerfilDefensivo(matchData);
  if (fatorPerfil !== 1.0) {
    prob = Math.min(Math.round(prob * fatorPerfil), 99);
  }

  for (const padrao of PADROES_UNDER_GOLS) {
    let isAtivo = false;
    try { isAtivo = padrao.ativo(result, matchData); } catch { continue; }
    if (!isAtivo) continue;

    // Aplicar fator lambda do padrão (pode ser número ou função)
    if (padrao.fator) {
      const f = typeof padrao.fator === 'function' ? padrao.fator(matchData) : padrao.fator;
      prob = Math.min(Math.round(prob * f), 99);
    }

    // Seleciona delta por mercado
    const delta = isUnder15 ? (padrao.delta15 ?? 0) :
                  isUnder25 ? (padrao.delta25 ?? 0) :
                  /* 3.5 usa U25 como aproximação */ (padrao.delta25 ?? 0);

    if (delta === 0) continue;

    if (delta > 0) {
      const aplicar = Math.min(delta, MAX_BONUS - bonusAcum);
      if (aplicar <= 0) { ativos.push(`${padrao.id}(cap)`); continue; }
      bonusAcum  += aplicar;
      deltaTotal += aplicar;
      ativos.push(`${padrao.id}(+${aplicar}pp)`);
    } else {
      deltaTotal += delta;
      ativos.push(`${padrao.id}(${delta}pp)`);
    }
  }

  const prob_final = Math.min(Math.max(prob + deltaTotal, 0), 99);
  return {
    result:         { ...result, probabilidade: Math.round(prob_final) },
    delta_total:    deltaTotal,
    padroes_ativos: ativos,
  };
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
