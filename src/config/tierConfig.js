/**
 * tierConfig.js — Sistema de Tiers Dinâmicos por Liga (Módulo 2)
 *
 * Define a estrutura de tiers de qualidade por liga e calcula o gate efetivo
 * (probabilidade mínima) para cada combinação liga × mercado.
 *
 * Tiers (22/04/2026):
 *   TIER1_ELITE  — precisão real ≥ 82% + n ≥ 100 amostras → gate 80%
 *   TIER2_SOLIDO — precisão 78-82% + n ≥ 60 amostras      → gate 82%
 *   TIER3_MONIT  — em calibração ou n < 60               → gate 84%
 *   TIER4_SHADOW — n < 30, apenas coleta                   → gate 88%
 *
 * Piso absoluto Under (inviolável): 80% prob + 80% conf — nunca alterar.
 */

import { loadDB } from '../pie/pie-storage.js';
import { applyUnderPiso } from '../analysis/gateManager.js';

// ── Tiers Base ────────────────────────────────────────────────────────────────

export const TIERS_BASE = {

  TIER1_ELITE: {
    numero:       1,
    gate_prob:    0.80,
    gate_conf:    0.75,
    ligas: [
      'eredivisie',
      'vriendenloterij eredivisie',
      'bundesliga',
      'champions league',
      'uefa champions league',
      'conference league',
      'uefa conference league',
      'brasileirão betano',
      'brasileirao betano',
      'brasileirão série a',
      'brasileirao serie a',
    ],
    justificativa: 'Precisão real ≥ 82% + n ≥ 100 amostras verificadas',
  },

  TIER2_SOLIDO: {
    numero:       2,
    gate_prob:    0.82,
    gate_conf:    0.78,
    ligas: [
      'la liga', 'laliga',
      'premier league',
      'serie a',
      'ligue 1',
      'liga portugal', 'liga portugal betclic',
      'mls',
      'brasileirão série b', 'brasileirao serie b',
      'concacaf champions cup',
    ],
    justificativa: 'Precisão real 78-82% + n ≥ 60 amostras',
  },

  TIER3_MONIT: {
    numero:       3,
    gate_prob:    0.84,
    gate_conf:    0.80,
    ligas: [
      'championship',
      'serie b',
      '2. bundesliga', 'second bundesliga',
      'ligue 2',
      'brasileirão série c', 'brasileirao serie c',
      'copa libertadores', 'conmebol libertadores',
      'sul-americana', 'conmebol sudamericana',
      'europa league', 'uefa europa league',
      'liga profesional', 'liga profesional de fútbol',
    ],
    justificativa: 'Em calibração — gate elevado por precaução',
  },

  TIER4_SHADOW: {
    numero:       4,
    gate_prob:    0.88,
    gate_conf:    0.85,
    ligas: [
      'fa cup',
      'copa do brasil',
      'copa del rey',
      'dfb-pokal',
      'coupe de france',
      'coppa italia',
      'superliga turca', 'trendyol süper lig', 'süper lig',
      'eliteserien',
      'allsvenskan',
    ],
    justificativa: 'n < 30 — shadow mode apenas, gate elevado',
  },
};

// ── Gates por Mercado (sobreposição sobre tiers) ─────────────────────────────
// Derivados empiricamente do byRange do PIE (2026-04-30).
// Regra: gate mínimo = faixa mais baixa onde precisão_histórica ≥ 75%.
// Mercados com NENHUMA faixa ≥ 75%: gate 0.92-0.95 (efetivamente bloqueados).
// Under usa piso absoluto 80% — inviolável (ver gateManager.js).

export const GATES_MERCADO = {
  // ── Gols ─────────────────────────────────────────────────────────────────
  // Over 1.5: faixa 70-80 = 82.4% ✅ → gate mantido em 70%
  'Over 1.5':          { t1: 0.70, t2: 0.72, t3: 0.75, t4: 0.80 },
  // Over 2.5: faixa 70-80 = 58.6% 🔴; faixa 80-85 = 100% ✅ → gate elevado para 80%
  'Over 2.5':          { t1: 0.80, t2: 0.82, t3: 0.85, t4: 0.88 },
  // Over 3.5: faixa 70-80 = 37.7% 🔴; faixa 80-85 = 100% ✅ (n=15) → gate elevado
  'Over 3.5':          { t1: 0.82, t2: 0.84, t3: 0.86, t4: 0.90 },
  // Under: inviolável
  'Under 1.5':         { t1: 0.80, t2: 0.80, t3: 0.80, t4: 0.80 },
  'Under 2.5':         { t1: 0.80, t2: 0.80, t3: 0.80, t4: 0.80 },
  'Under 3.5':         { t1: 0.80, t2: 0.80, t3: 0.80, t4: 0.80 },

  // ── BTTS ─────────────────────────────────────────────────────────────────
  // faixa 70-80 = 64.2% 🔴; faixa 80-85 = 79.7% ✅ → gate elevado de 78% para 80%
  'BTTS':              { t1: 0.80, t2: 0.82, t3: 0.84, t4: 0.88 },

  // ── Escanteios ────────────────────────────────────────────────────────────
  // Over Corners 6.5: faixa 70-80 = 86% ✅ → gate mantido em 75%
  'Over Corners 6.5':  { t1: 0.75, t2: 0.78, t3: 0.80, t4: 0.85 },
  // Over Corners 7.5: faixa 70-80 = 76.4% ✅ → gate mantido
  'Over Corners 7.5':  { t1: 0.77, t2: 0.80, t3: 0.82, t4: 0.86 },
  // Over Corners 8.5: faixa 70-80 = 64.9% 🔴; faixa 80-85 = 100% ✅ → gate elevado
  'Over Corners 8.5':  { t1: 0.80, t2: 0.82, t3: 0.84, t4: 0.88 },
  // Over Corners 9.5: poucos dados — gate alto por precaução
  'Over Corners 9.5':  { t1: 0.85, t2: 0.86, t3: 0.88, t4: 0.92 },

  // ── Cartões Amarelos ──────────────────────────────────────────────────────
  // YC 2.5: faixa 70-80 = 83.1% ✅ → gate em 73%
  'YC 2.5':            { t1: 0.73, t2: 0.75, t3: 0.78, t4: 0.85 },
  // YC 3.5: faixa 70-80 = 67.6% 🔴; faixa 80-85 = 100% ✅ → gate elevado para 80%
  'YC 3.5':            { t1: 0.80, t2: 0.82, t3: 0.84, t4: 0.88 },
  // YC 4.5: BLOQUEADO — máx 50.9% em qualquer faixa analisada
  'YC 4.5':            { t1: 0.92, t2: 0.92, t3: 0.92, t4: 0.92 },

  // ── Dupla Chance / 1X2 ───────────────────────────────────────────────────
  // 1X: faixa 80-85 = 88.2% ✅ → gate em 80%
  '1X':                { t1: 0.80, t2: 0.82, t3: 0.84, t4: 0.88 },
  // X2: BLOQUEADO — máx 53.1% em qualquer faixa; nunca atingiu 75%
  'X2':                { t1: 0.92, t2: 0.92, t3: 0.92, t4: 0.92 },
  // Home Win: BLOQUEADO — máx 52% em qualquer faixa
  'Home Win':          { t1: 0.92, t2: 0.92, t3: 0.92, t4: 0.92 },
  // Away Win: BLOQUEADO — máx 48% em qualquer faixa
  'Away Win':          { t1: 0.95, t2: 0.95, t3: 0.95, t4: 0.95 },
  // Draw: BLOQUEADO — máx 33% em qualquer faixa
  'Draw':              { t1: 0.95, t2: 0.95, t3: 0.95, t4: 0.95 },
  // Resultado Final: em calibração → gate conservador
  'Resultado Final':   { t1: 0.85, t2: 0.87, t3: 0.88, t4: 0.92 },
};

// Mercados efetivamente bloqueados (gate ≥ 92% — modelo nunca atinge)
export const MERCADOS_BLOQUEADOS = new Set(['YC 4.5', 'X2', 'Home Win', 'Away Win', 'Draw']);
// Mercados em shadow mode (calibrando, sem sinais enviados)
export const MERCADOS_SHADOW = new Set(['Over 3.5', 'Over Corners 9.5', 'Resultado Final']);

// ── getTierLiga ───────────────────────────────────────────────────────────────

/**
 * Determina o tier de uma liga pelo nome.
 * Retorna o objeto do tier correspondente ou TIER3_MONIT como default.
 *
 * @param {string} liga — nome da liga/competição
 * @returns {{ nome: string, config: object }}
 */
export function getTierLiga(liga) {
  const ligaLower = (liga || '').toLowerCase();
  for (const [nome, config] of Object.entries(TIERS_BASE)) {
    if (config.ligas.some(l => ligaLower.includes(l))) {
      return { nome, config };
    }
  }
  return { nome: 'TIER3_MONIT', config: TIERS_BASE.TIER3_MONIT };
}

// ── getGateEfetivo ────────────────────────────────────────────────────────────

/**
 * Retorna o gate mínimo de probabilidade para uma liga + mercado.
 * Under sempre usa piso absoluto 0.80 (via applyUnderPiso).
 *
 * @param {string} liga    — nome da liga/competição
 * @param {string} mercado — nome do mercado ('Over 1.5', 'BTTS', etc.)
 * @returns {number}       — gate em decimal (0.75 – 0.90)
 */
export function getGateEfetivo(liga, mercado) {
  const mkt = (mercado || '').trim();

  // Under: piso absoluto inviolável
  if (/^under/i.test(mkt) && !/corner|escanteio/i.test(mkt)) {
    return applyUnderPiso(0.80);
  }

  const { config } = getTierLiga(liga);
  const gates = GATES_MERCADO[mkt];
  if (!gates) return 0.82; // fallback conservador

  const n = config.numero;
  return n === 1 ? gates.t1 :
         n === 2 ? gates.t2 :
         n === 3 ? gates.t3 : gates.t4;
}

// ── getGateConfianca ──────────────────────────────────────────────────────────

/**
 * Retorna o gate mínimo de confiança para uma liga + mercado.
 * Confiança é 3-5pp menos restritiva que probabilidade.
 *
 * @param {string} liga    — nome da liga/competição
 * @param {string} mercado — nome do mercado
 * @returns {number}       — gate em decimal (0.72 – 0.85)
 */
export function getGateConfianca(liga, mercado) {
  const mkt = (mercado || '').trim();

  // Under: piso absoluto inviolável
  if (/^under/i.test(mkt) && !/corner|escanteio/i.test(mkt)) {
    return 0.80;
  }

  const { config } = getTierLiga(liga);
  const n = config.numero;
  const confBase = n === 1 ? 0.72 : n === 2 ? 0.75 : n === 3 ? 0.78 : 0.82;

  // Corners: 3pp mais permissivos (confirmado: 75% conf já em vigor)
  if (/corner|escanteio/i.test(mkt)) {
    return Math.max(confBase - 0.03, 0.70);
  }

  return confBase;
}

// ── atualizarTiersComPIE ──────────────────────────────────────────────────────

/**
 * Verifica se alguma liga merece promoção ou rebaixamento com base nos dados reais do PIE.
 * Critérios:
 *   Promoção → precisão real ≥ 82% com n ≥ 100 amostras em qualquer mercado chave
 *   Rebaixamento → precisão real < 70% com n ≥ 30 amostras (liga que era Tier 1)
 *
 * @returns {{ promovidos: string[], rebaixados: string[] }}
 */
export function atualizarTiersComPIE() {
  const db    = loadDB();
  const calib = db.calibration || {};

  const MERCADOS_CHAVE = ['Over 1.5', 'Over 2.5', 'BTTS', 'Over Corners 6.5'];
  const promovidos = [];
  const rebaixados = [];
  const sugestoes  = [];

  // Agrupa precisão por liga (cruzando mercados chave)
  const porLiga = {};
  for (const mkt of MERCADOS_CHAVE) {
    const mc = calib[mkt];
    if (!mc?.byCompetition) continue;
    for (const [liga, dados] of Object.entries(mc.byCompetition)) {
      if (dados.total < 10) continue;
      if (!porLiga[liga]) porLiga[liga] = { mercados: {}, total_n: 0 };
      porLiga[liga].mercados[mkt] = { prec: dados.hits / dados.total, n: dados.total };
      porLiga[liga].total_n += dados.total;
    }
  }

  for (const [liga, info] of Object.entries(porLiga)) {
    const precs = Object.values(info.mercados).map(m => m.prec);
    if (!precs.length) continue;
    const mediaPrec = precs.reduce((a, b) => a + b, 0) / precs.length;
    const { nome: tierAtual } = getTierLiga(liga);

    // Candidato à promoção para Tier 1
    if (mediaPrec >= 0.82 && info.total_n >= 100 && tierAtual !== 'TIER1_ELITE') {
      promovidos.push(liga);
      sugestoes.push(`  🔼 PROMOÇÃO sugerida: "${liga}" → Tier 1 (prec=${(mediaPrec*100).toFixed(1)}%, n=${info.total_n})`);
    }

    // Candidato ao rebaixamento do Tier 1
    if (mediaPrec < 0.70 && info.total_n >= 30 && tierAtual === 'TIER1_ELITE') {
      rebaixados.push(liga);
      sugestoes.push(`  🔽 REBAIXAMENTO sugerido: "${liga}" ← Tier 1 (prec=${(mediaPrec*100).toFixed(1)}%, n=${info.total_n})`);
    }
  }

  if (sugestoes.length > 0) {
    console.log('[TierConfig] Sugestões de atualização de tiers:');
    sugestoes.forEach(s => console.log(s));
  } else {
    console.log('[TierConfig] Tiers validados — nenhuma alteração necessária.');
  }

  return { promovidos, rebaixados, sugestoes };
}
