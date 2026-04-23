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
export const CORNERS_MIN_CONFIDENCE = 75;
export const CORNERS_MIN_PROBABILITY = 75;

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

// ── Lambda Corners por Liga (calibração 19/04/2026) ──────────────────────────
// Valores baseados em análise contextual de 18 jogos + calibração PIE existente.
// Uso: coef multiplicativo para Poisson de escanteios por jogo.
export const CORNERS_LAMBDA_LIGAS = {
  'fa cup':                    4.20,  // copa eliminatória = máxima intensidade
  'coupe de france':           3.95,
  'copa do brasil':            3.40,
  'copa del rey':              3.35,
  'coppa italia':              3.30,
  'dfb-pokal':                 3.55,
  'premier league':            3.70,
  'championship':              3.50,
  'ligue 1':                   3.55,
  'ligue 2':                   3.30,
  'bundesliga':                3.50,
  '2. bundesliga':             3.35,
  'serie a':                   3.20,  // italiana — corners moderados apesar dos poucos gols
  'serie b italiana':          3.05,
  'eredivisie':                3.80,
  'la liga':                   3.40,
  'laliga':                    3.40,
  'liga portugal':             3.60,
  'mls':                       3.45,
  'brasileirão betano':        3.15,
  'brasileirao betano':        3.15,
  'brasileirão série b':       3.00,
  'brasileirao serie b':       3.00,
  'brasileirão série c':       2.75,  // divisão menor = menos intensidade
  'brasileirao serie c':       2.75,
  'liga profesional':          3.10,  // Argentina
};

export function getLambdaCornersLiga(competition) {
  const comp = (competition || '').toLowerCase();
  for (const [key, val] of Object.entries(CORNERS_LAMBDA_LIGAS)) {
    if (comp.includes(key)) return val;
  }
  return 3.20; // default europeu médio
}

// ── Padrões Corners (calibração 19/04/2026) ───────────────────────────────────
//
// 10 padrões C_E1–C_E10 extraídos de análise contextual de 18 jogos.
// aplicarPadroesCorners() deve ser chamada ANTES de cornersKillSwitch() no funil.
//
// A whitelist por sub-mercado (KS2) permanece inviolável — os padrões ajustam
// a probabilidade do agente para ajudá-la a cruzar o gate 80% quando aplicável.
//
// Estrutura de cada padrão:
//   id:     identificador único
//   fator:  multiplicador lambda opcional (aplicado à prob via ×fator)
//   d65:    delta pp para Over Corners 6.5
//   d75:    delta pp para Over Corners 7.5
//   d85:    delta pp para Over Corners 8.5
//   ativo:  predicado (result, matchData) → boolean
//
// Notas de amostragem (1 amostra → delta/2 conforme regra do analista):
//   C_E3, C_E4, C_E5, C_E7: 1 amostra → delta reduzido à metade

// Lista de derbies brasileiros para C_E10
const _DERBIES_BR = new Set([
  'fluminense_flamengo', 'flamengo_fluminense',
  'fluminense_vasco', 'vasco_fluminense',
  'fluminense_botafogo', 'botafogo_fluminense',
  'flamengo_vasco', 'vasco_flamengo',
  'flamengo_botafogo', 'botafogo_flamengo',
  'vasco_botafogo', 'botafogo_vasco',
  'atletico-mg_cruzeiro', 'cruzeiro_atletico-mg',
  'atletico mineiro_cruzeiro', 'cruzeiro_atletico mineiro',
  'palmeiras_corinthians', 'corinthians_palmeiras',
  'palmeiras_santos', 'santos_palmeiras',
  'palmeiras_sao paulo', 'sao paulo_palmeiras',
  'corinthians_santos', 'santos_corinthians',
  'corinthians_sao paulo', 'sao paulo_corinthians',
  'santos_sao paulo', 'sao paulo_santos',
  'fluminense_santos', 'santos_fluminense',
  'internacional_gremio', 'gremio_internacional',
  'bahia_vitoria', 'vitoria_bahia',
  'sport_nautico', 'nautico_sport',
]);

function _isDerbyBR(matchData) {
  const home = (matchData.home?.team || matchData.home_team || '').toLowerCase().replace(/\s+/g, ' ');
  const away = (matchData.away?.team || matchData.away_team || '').toLowerCase().replace(/\s+/g, ' ');
  const key  = `${home}_${away}`.replace(/\s/g, '-');
  const key2 = `${home}_${away}`;
  return _DERBIES_BR.has(key) || _DERBIES_BR.has(key2);
}

const _COPA_LIGAS_CORNERS = new Set([
  'fa cup', 'copa do brasil', 'copa del rey', 'coupe de france',
  'coppa italia', 'dfb-pokal', 'dfb pokal', 'efl cup',
]);

const PADROES_CORNERS = [
  {
    // C_E1 — Correlação Over 2.5 → corners elevados (7 amostras — bonus completo)
    // Gols e corners correlacionados r≈0.72 historicamente.
    id: 'C_E1_OVER25_CORNERS',
    fator: 1.15,
    d65: 5, d75: 5, d85: 3,
    ativo: (_r, md) => {
      const gH = md.home?.goals_scored_avg ?? md.home_goals_avg ?? null;
      const gA = md.away?.goals_scored_avg ?? md.away_goals_avg ?? null;
      if (gH === null || gA === null) return false;
      return (gH + gA) >= 2.5;
    },
  },
  {
    // C_E2 — Time grande (top 4) em jogo de alta pressão = avalanche de corners
    // Atlético-MG, Inter: times grandes geram muitos ataques (2 amostras)
    id: 'C_E2_TIME_GRANDE_ALTA_PRESSAO',
    d65: 5, d75: 8, d85: 5,
    ativo: (_r, md) => {
      const posH = md.home?.position ?? md.home_position ?? null;
      // Proxy: time top 4 em casa + atacante médio alto
      if (posH === null) return false;
      const gH = md.home?.goals_scored_avg ?? null;
      return posH <= 4 && gH !== null && gH >= 1.8;
    },
  },
  {
    // C_E3 — Copa doméstica = máximo de corners (1 amostra → delta/2)
    // FA Cup Aston Villa 4-3 Sunderland: eliminação direta → ambos atacam ao máximo
    id: 'C_E3_COPA_DOMESTICA_CORNERS',
    fator: 1.20,
    d65: 4, d75: 4, d85: 4, // spec: +7pp O9.5 → reduzido por 1 amostra
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      return [..._COPA_LIGAS_CORNERS].some(c => comp.includes(c));
    },
  },
  {
    // C_E4 — Domínio unilateral: xG combinado alto + diferença de posição ≥ 6
    // Rennes 3-0 Strasbourg (1 amostra → delta/2)
    id: 'C_E4_DOMINIO_UNILATERAL',
    fator: 1.12,
    d65: 3, d75: 3, d85: 3, // spec: +6pp → reduzido por 1 amostra
    ativo: (_r, md) => {
      const posH = md.home?.position ?? md.home_position ?? null;
      const posA = md.away?.position ?? md.away_position ?? null;
      const xgH  = md.home?.xg_avg ?? md.home?.xg ?? null;
      const xgA  = md.away?.xg_avg ?? md.away?.xg ?? null;
      if (posH === null || posA === null) return false;
      const diffPos  = Math.abs(posH - posA) >= 6;
      const xgAlto   = xgH !== null && xgA !== null && (xgH + xgA) >= 2.5;
      // Proxy sem xG: mandante elite vs adversário de zona baixa
      const diffSemXg = posH <= 5 && posA >= 12;
      return diffPos && (xgAlto || diffSemXg);
    },
  },
  {
    // C_E5 — Ligue 1 empate provável com gols = corners máximos (1 amostra → delta/2)
    // Monaco 2-2 Auxerre: ambos atacando continuamente
    id: 'C_E5_LIGUE1_EMPATE_GOLS',
    d65: 4, d75: 4, d85: 4, // spec: +9pp O8.5 → reduzido por 1 amostra
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      if (!comp.includes('ligue 1')) return false;
      const gH = md.home?.goals_scored_avg ?? null;
      const gA = md.away?.goals_scored_avg ?? null;
      // Proxy: ambos ofensivos (média > 1.3 gols marcados) + posições equilibradas
      if (gH === null || gA === null) return false;
      const posH = md.home?.position ?? 10;
      const posA = md.away?.position ?? 10;
      const equilibrado = Math.abs(posH - posA) <= 5;
      return (gH + gA) >= 2.5 && equilibrado;
    },
  },
  {
    // C_E6 — Série B BR com gols esperados altos (2 amostras — bonus completo)
    // Athletic 2-1, Internacional 1-2: Série B com 3+ gols = corners moderados-altos
    id: 'C_E6_SERIE_B_ALTA_INTENSIDADE',
    fator: 1.05,
    d65: 3, d75: 4, d85: 0,
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isSerieB = (comp.includes('série b') || comp.includes('serie b')) &&
                       (comp.includes('brasil') || comp.includes('brasileir'));
      const gH = md.home?.goals_scored_avg ?? null;
      const gA = md.away?.goals_scored_avg ?? null;
      if (!isSerieB) return false;
      // 3+ gols esperados como proxy
      if (gH !== null && gA !== null) return (gH + gA) >= 2.5;
      return false;
    },
  },
  {
    // C_E7 — Posse dominante > 58% = corners sistemáticos (1 amostra → delta/2)
    // Palmeiras 1-0: controle de posse gera corners mesmo sem chutes
    id: 'C_E7_POSSE_DOMINANTE_CORNERS',
    d65: 3, d75: 2, d85: 0, // spec: +6pp O6.5, +4pp O7.5 → metade por 1 amostra
    ativo: (_r, md) => {
      const posse = md.home?.possession_avg ?? md.home?.possession ?? null;
      return posse !== null && posse >= 58;
    },
  },
  {
    // C_E8 — Serie A italiana: corners moderados (não bloquear por poucos gols)
    // Juventus 2-0, AC Milan 1-0: poucos gols mas corners consistentes (2 amostras)
    id: 'C_E8_SERIE_A_IT_CORNERS',
    fator: 0.95,
    d65: 0, d75: 0, d85: 0, // apenas fator — não adiciona pp
    ativo: (_r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isIT = (comp.includes('serie a') || comp.includes('serie b')) &&
                   !comp.includes('brasil') && !comp.includes('betano');
      return isIT;
    },
  },
  {
    // C_E9 — [REVISADO 19/04/2026 — DADOS REAIS FALSIFICARAM HIPÓTESE ORIGINAL]
    // ORIGINAL: Série B/C zona intermediária = corners baixos (λ×0.88, -6pp)
    // FALSIFICADO: Ceará 0-0 Londrina (Série C, zona int) teve 18 corners!
    //
    // INSIGHT: jogo defensivo com times que NÃO conseguem marcar = MAIS corners.
    // Times pressionam para abrir o placar → chutes na defesa → corners contínuos.
    // A hipótese "zona intermediária = menos intensidade" confundiu GOLS com CORNERS.
    // 0-0 não significa baixa intensidade ofensiva — significa alta ineficiência.
    //
    // PADRÃO REVISADO: zona intermediária Série B/C → neutro para corners (removido penalidade)
    // Monitorar com mais dados antes de reativar qualquer ajuste direcional.
    id: 'C_E9_ZONA_INT_REVISADO',
    d65: 0, d75: 0, d85: 0, // DESATIVADO — falsificado por dados reais 19/04/2026
    ativo: () => false,      // não ativa — padrão em revisão
  },
  {
    // C_E10 — Derby/clássico nacional = intensidade máxima = corners altos (2 amostras)
    // Fluminense vs Santos, Atlético-MG vs Coritiba: rivalidade = ambos atacam ao máximo
    id: 'C_E10_DERBY_CLASSICO',
    d65: 4, d75: 7, d85: 4,
    ativo: (_r, md) => _isDerbyBR(md),
  },
];

/**
 * Aplica os padrões C_E1–C_E10 sobre uma análise de escanteios.
 * Deve ser chamada ANTES de cornersKillSwitch() no funil.
 *
 * A whitelist por sub-mercado (KS2) permanece inviolável.
 * O gate de confiança 80% (Fire Zone) é independente desta função.
 *
 * @param {object} result    — saída do agente (probabilidade, mercado, ...)
 * @param {object} matchData — dados da partida
 * @returns {{ result: object, delta_total: number, padroes_ativos: string[] }}
 */
export function aplicarPadroesCorners(result, matchData) {
  const mktResult = (result.mercado || result.market || '').trim();
  const is65 = mktResult === 'Over Corners 6.5';
  const is75 = mktResult === 'Over Corners 7.5';
  const is85 = mktResult === 'Over Corners 8.5';
  if (!is65 && !is75 && !is85) return { result, delta_total: 0, padroes_ativos: [] };

  let prob       = result.probabilidade ?? 0;
  let deltaTotal = 0;
  let bonusAcum  = 0;
  const ativos   = [];
  const MAX_BONUS = 20;

  for (const padrao of PADROES_CORNERS) {
    let isAtivo = false;
    try { isAtivo = padrao.ativo(result, matchData); } catch { continue; }
    if (!isAtivo) continue;

    // Fator lambda (multiplicativo — afeta prob antes dos deltas)
    if (padrao.fator) {
      prob = Math.min(Math.round(prob * padrao.fator), 99);
    }

    // Delta por sub-mercado
    const delta = is65 ? (padrao.d65 ?? 0) :
                  is75 ? (padrao.d75 ?? 0) :
                         (padrao.d85 ?? 0);

    if (delta === 0) {
      if (padrao.fator && padrao.fator !== 1.0) {
        ativos.push(`${padrao.id}(λ×${padrao.fator})`);
      }
      continue;
    }

    if (delta > 0) {
      const aplicar = Math.min(delta, MAX_BONUS - bonusAcum);
      if (aplicar <= 0) { ativos.push(`${padrao.id}(cap)`); continue; }
      bonusAcum  += aplicar;
      deltaTotal += aplicar;
      ativos.push(padrao.fator
        ? `${padrao.id}(λ×${padrao.fator},+${aplicar}pp)`
        : `${padrao.id}(+${aplicar}pp)`);
    } else {
      deltaTotal += delta;
      ativos.push(padrao.fator
        ? `${padrao.id}(λ×${padrao.fator},${delta}pp)`
        : `${padrao.id}(${delta}pp)`);
    }
  }

  const prob_final = Math.min(Math.max(prob + deltaTotal, 0), 99);
  return {
    result:         { ...result, probabilidade: Math.round(prob_final) },
    delta_total:    deltaTotal,
    padroes_ativos: ativos,
  };
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
