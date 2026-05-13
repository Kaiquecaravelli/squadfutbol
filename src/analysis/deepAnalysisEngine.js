/**
 * deepAnalysisEngine.js — Motor de Análise Profunda 8 Dimensões
 *
 * Calcula um score composto (0–100) por jogo com base em 8 dimensões ponderadas.
 * Dimensões indisponíveis retornam score neutro 0.50 + flag SEM_DADO.
 *
 * D1  Histórico (0.16) — forma dos últimos 20 jogos (pontos/xG/gols)
 * D2  Forma Recente (0.16) — últimos 5 jogos de cada time
 * D3  H2H (0.13) — confronto direto dos últimos 5 anos
 * D4  Contexto Motivacional (0.18) — nível/fase/motivação das equipes  ← preditor #1
 * D5  Árbitro (0.08) — cartões/faltas médios do árbitro
 * D6  Pressão xG (0.12) — xG acumulado nas últimas 5 partidas (Sniper)
 * D7  Sequência Gols (0.10) — streak de Over/Under nas últimas 5 partidas
 * D8  Movimento Odds (0.07) — abertura vs. odds atual (valor detectado)
 *
 * Recalibrado em 2026-04-15 com base em 7 sinais GREEN auditados.
 * Referência: src/config/calibration_15042026.js
 */

import { loadDB } from '../pie/pie-storage.js';
import { PESOS } from '../config/calibration_15042026.js';

// ── Pesos por dimensão (calibração 15/04/2026) ────────────────────────────────
const WEIGHTS = {
  D1_historico:        PESOS.D1_historico_estrutural,  // 0.16
  D2_forma_recente:    PESOS.D2_forma_recente,          // 0.16
  D3_h2h:             PESOS.D3_h2h,                    // 0.13
  D4_posicao_tabela:   PESOS.D4_contexto_motivacional,  // 0.18
  D5_arbitro:          PESOS.D5_arbitro,                // 0.08
  D6_pressao_xg:       PESOS.D6_press_index,            // 0.12
  D7_sequencia_gols:   PESOS.D7_momentum_streak,        // 0.10
  D8_movimento_odds:   PESOS.D8_value_mercado,          // 0.07
};

const NEUTRAL = 0.50; // score quando dado indisponível

// ── Utilitários ───────────────────────────────────────────────────────────────

/**
 * Calcula score D2 — Forma Recente.
 * Usa sofascore stats dos últimos 5 jogos: goals_scored_avg, goals_conceded_avg, xg_avg.
 * Premia times com xG alto + defesa sólida.
 */
function _scoreFormaRecente(home, away) {
  const hGoals = home?.goals_scored_avg    ?? null;
  const aGoals = away?.goals_scored_avg    ?? null;
  const hConc  = home?.goals_conceded_avg  ?? null;
  const aConc  = away?.goals_conceded_avg  ?? null;
  const hXg    = home?.xg_avg             ?? null;
  const aXg    = away?.xg_avg             ?? null;

  if (hGoals === null && hXg === null) return { score: NEUTRAL, flag: 'SEM_DADO' };

  // Ataque home — normaliza 0–3 gols/jogo para 0–1
  const hAtk  = Math.min((hGoals ?? hXg ?? 1) / 3, 1);
  const aAtk  = Math.min((aGoals ?? aXg ?? 1) / 3, 1);
  // Defesa: menos gols concedidos = melhor
  const hDef  = hConc != null ? Math.max(0, 1 - hConc / 3) : NEUTRAL;
  const aDef  = aConc != null ? Math.max(0, 1 - aConc / 3) : NEUTRAL;

  // Score: soma ponderada ataque (0.6) + defesa (0.4)
  const raw = ((hAtk + aAtk) / 2) * 0.6 + ((hDef + aDef) / 2) * 0.4;
  return { score: Math.min(Math.max(raw, 0), 1) };
}

/**
 * Calcula score D3 — H2H.
 * Usa pie.json: registros históricos com resultado e mercado.
 * Premia quando H2H tem padrão consistente para o mercado alvo.
 */
function _scoreH2H(home, away, mercado, pieDB) {
  if (!pieDB?.patterns) return { score: NEUTRAL, flag: 'SEM_DADO' };

  const homeTeam = (home?.team || '').toLowerCase().trim();
  const awayTeam = (away?.team || '').toLowerCase().trim();

  // Busca padrões que mencionem os dois times
  const relevante = Object.values(pieDB.patterns).filter(p => {
    const m = (p.match || '').toLowerCase();
    return m.includes(homeTeam.substring(0, 6)) && m.includes(awayTeam.substring(0, 6));
  });

  if (!relevante.length) return { score: NEUTRAL, flag: 'SEM_DADO' };

  // Filtra pelo mercado alvo
  const mkLow = (mercado || '').toLowerCase();
  const comMkt = relevante.filter(p => (p.mercado || '').toLowerCase().includes(mkLow.split(' ')[0]));
  const lista  = comMkt.length ? comMkt : relevante;

  if (!lista.length) return { score: NEUTRAL, flag: 'SEM_DADO' };

  const acertos = lista.filter(p => p.resultado === p.predicao || p.hit === true).length;
  const score   = acertos / lista.length;
  return { score, amostras: lista.length };
}

/**
 * Calcula score D6 — Pressão xG.
 * Usa goals_sniper e btts_sniper intel se disponível via matchData.
 */
function _scorePressaoXG(matchData) {
  const home   = matchData?.home;
  const away   = matchData?.away;
  const hXg    = home?.xg_avg ?? null;
  const aXg    = away?.xg_avg ?? null;

  if (hXg === null && aXg === null) return { score: NEUTRAL, flag: 'SEM_DADO' };

  const lambdaTotal = (hXg ?? 1.2) + (aXg ?? 1.0);
  // xG > 2.5 → score alto; xG < 1.5 → score baixo
  const score = Math.min(Math.max((lambdaTotal - 1.0) / 2.5, 0), 1);
  return { score, lambda: Math.round(lambdaTotal * 100) / 100 };
}

/**
 * Calcula score D7 — Sequência Gols.
 * Usa goals_tracker / btts_tracker para extrair streak de Over/Under.
 */
function _scoreSequenciaGols(matchData, mercado) {
  // Tenta extrair da intel do sniper armazenada no matchData
  const intel = matchData?.goals_sniper_intel || matchData?.btts_sniper_intel;
  if (!intel) return { score: NEUTRAL, flag: 'SEM_DADO' };

  const streak = intel?.streak_over ?? intel?.streak_btts_yes ?? null;
  if (streak === null) return { score: NEUTRAL, flag: 'SEM_DADO' };

  // Streak > 0 → Over consistente; streak < 0 → Under consistente
  const mkLow = (mercado || '').toLowerCase();
  const isOver = mkLow.includes('over') || mkLow.includes('btts');

  // Normaliza: streak máx esperado ≈ 5
  const raw    = Math.abs(streak) / 5;
  const score  = (isOver ? streak > 0 : streak < 0) ? Math.min(raw, 1) : Math.max(0, NEUTRAL - raw * 0.2);
  return { score: Math.min(Math.max(score, 0), 1), streak };
}

/**
 * Calcula score D8 — Movimento de Odds.
 * Compara fair_odds do Quant com odds atual do mercado.
 * EV positivo → score alto (book subestimou probabilidade).
 */
function _scoreMovimentoOdds(quantResult, mercado) {
  if (!quantResult) return { score: NEUTRAL, flag: 'SEM_DADO' };

  // Encontra mercado correspondente nos resultados Quant
  const entry = (quantResult.markets || []).find(m =>
    (m.market || '').toLowerCase().includes((mercado || '').toLowerCase().split(' ')[0])
  );
  if (!entry) return { score: NEUTRAL, flag: 'SEM_DADO' };

  const ev = entry.ev ?? entry.expected_value ?? 0;
  // EV > 15% → score 1.0; EV = 0% → score 0.5; EV < -10% → score 0
  const score = Math.min(Math.max(0.5 + ev / 30, 0), 1);
  return { score, ev: Math.round(ev * 100) / 100 };
}

// ── Engine principal ──────────────────────────────────────────────────────────

/**
 * runDeepAnalysis — calcula score 8-D para um jogo e mercado.
 *
 * @param {object} matchData   — dados agregados do jogo (aggregator.js)
 * @param {string} mercado     — mercado alvo ex: "Over 2.5"
 * @param {object} quantResult — resultado do quant.js (pode ser null)
 * @returns {object} { score_total, tier, dimensoes, flags_sem_dado }
 */
export function runDeepAnalysis(matchData, mercado, quantResult = null) {
  let pieDB;
  try { pieDB = loadDB(); } catch { pieDB = null; }

  const home = matchData?.home;
  const away = matchData?.away;

  // ── Calcula cada dimensão ─────────────────────────────────────────────────
  const d1 = { score: NEUTRAL, flag: 'SEM_DADO' }; // D1: histórico 20j — aguarda fonte externa
  const d2 = _scoreFormaRecente(home, away);
  const d3 = _scoreH2H(home, away, mercado, pieDB);
  const d4 = { score: NEUTRAL, flag: 'SEM_DADO' }; // D4: posição tabela — aguarda fonte externa
  const d5 = { score: NEUTRAL, flag: 'SEM_DADO' }; // D5: árbitro — aguarda fonte externa
  const d6 = _scorePressaoXG(matchData);
  const d7 = _scoreSequenciaGols(matchData, mercado);
  const d8 = _scoreMovimentoOdds(quantResult, mercado);

  const dimensoes = { d1, d2, d3, d4, d5, d6, d7, d8 };

  // ── Score composto ponderado ──────────────────────────────────────────────
  const scoreTotal =
    d1.score * WEIGHTS.D1_historico +
    d2.score * WEIGHTS.D2_forma_recente +
    d3.score * WEIGHTS.D3_h2h +
    d4.score * WEIGHTS.D4_posicao_tabela +
    d5.score * WEIGHTS.D5_arbitro +
    d6.score * WEIGHTS.D6_pressao_xg +
    d7.score * WEIGHTS.D7_sequencia_gols +
    d8.score * WEIGHTS.D8_movimento_odds;

  // ── Classificação de qualidade ────────────────────────────────────────────
  // PLATINUM ≥ 82 | GOLD ≥ 70 | SILVER ≥ 55 | BRONZE ≥ 40
  const score100 = Math.round(scoreTotal * 100);
  let tier;
  if (score100 >= 82)      tier = 'PLATINUM';
  else if (score100 >= 70) tier = 'GOLD';
  else if (score100 >= 55) tier = 'SILVER';
  else if (score100 >= 40) tier = 'BRONZE';
  else                     tier = 'DESCARTADO';

  // ── Ajuste de gate por tier ───────────────────────────────────────────────
  // PLATINUM: +0pp | GOLD: +0pp | SILVER: +3pp | BRONZE: +8pp
  const gateAdjuste = { PLATINUM: 0, GOLD: 0, SILVER: 3, BRONZE: 8, DESCARTADO: 999 }[tier];

  const flagsSemDado = Object.entries(dimensoes)
    .filter(([, d]) => d.flag === 'SEM_DADO')
    .map(([k]) => k);

  return {
    score_total:   score100,
    tier,
    gate_ajuste:   gateAdjuste,
    dimensoes: {
      d1_historico:      { ...d1,  peso: WEIGHTS.D1_historico },
      d2_forma_recente:  { ...d2,  peso: WEIGHTS.D2_forma_recente },
      d3_h2h:            { ...d3,  peso: WEIGHTS.D3_h2h },
      d4_posicao_tabela: { ...d4,  peso: WEIGHTS.D4_posicao_tabela },
      d5_arbitro:        { ...d5,  peso: WEIGHTS.D5_arbitro },
      d6_pressao_xg:     { ...d6,  peso: WEIGHTS.D6_pressao_xg },
      d7_sequencia_gols: { ...d7,  peso: WEIGHTS.D7_sequencia_gols },
      d8_movimento_odds: { ...d8,  peso: WEIGHTS.D8_movimento_odds },
    },
    flags_sem_dado: flagsSemDado,
  };
}

/**
 * formatDeepScoreAdmin — formata relatório detalhado para DM do admin.
 */
export function formatDeepScoreAdmin(deepResult, match, mercado) {
  const { score_total, tier, dimensoes, flags_sem_dado, gate_ajuste } = deepResult;

  const tierEmoji = { PLATINUM: '💎', GOLD: '🥇', SILVER: '🥈', BRONZE: '🥉', DESCARTADO: '❌' }[tier] || '❓';
  const linhas = [
    `🔬 <b>[ANÁLISE PROFUNDA 8-D]</b>`,
    `📋 <b>${match}</b>`,
    `🎯 Mercado: <code>${mercado}</code>`,
    ``,
    `${tierEmoji} <b>Tier: ${tier}</b> · Score: <code>${score_total}/100</code>`,
    gate_ajuste > 0 ? `⚠️ Gate ajustado: <code>+${gate_ajuste}pp</code> (tier ${tier})` : `✅ Gate padrão`,
    ``,
    `<b>Dimensões:</b>`,
    `  D1 Histórico   · ${_barScore(dimensoes.d1_historico.score)} ${_flagNote(dimensoes.d1_historico)}`,
    `  D2 Forma       · ${_barScore(dimensoes.d2_forma_recente.score)} ${_flagNote(dimensoes.d2_forma_recente)}`,
    `  D3 H2H         · ${_barScore(dimensoes.d3_h2h.score)} ${_flagNote(dimensoes.d3_h2h)}`,
    `  D4 Tabela      · ${_barScore(dimensoes.d4_posicao_tabela.score)} ${_flagNote(dimensoes.d4_posicao_tabela)}`,
    `  D5 Árbitro     · ${_barScore(dimensoes.d5_arbitro.score)} ${_flagNote(dimensoes.d5_arbitro)}`,
    `  D6 xG Pressão  · ${_barScore(dimensoes.d6_pressao_xg.score)} ${_flagNote(dimensoes.d6_pressao_xg)}`,
    `  D7 Streak Gols · ${_barScore(dimensoes.d7_sequencia_gols.score)} ${_flagNote(dimensoes.d7_sequencia_gols)}`,
    `  D8 Odds Move   · ${_barScore(dimensoes.d8_movimento_odds.score)} ${_flagNote(dimensoes.d8_movimento_odds)}`,
  ];

  if (flags_sem_dado.length) {
    linhas.push(``, `📊 Sem dado: <code>${flags_sem_dado.join(', ')}</code>`);
  }

  return linhas.join('\n');
}

function _barScore(score) {
  const pct = Math.round(score * 10);
  const bar = '█'.repeat(pct) + '░'.repeat(10 - pct);
  return `<code>${bar}</code> <code>${Math.round(score * 100)}%</code>`;
}

function _flagNote(dim) {
  if (dim.flag === 'SEM_DADO') return '⚠️ sem dado';
  if (dim.amostras != null)   return `(n=${dim.amostras})`;
  if (dim.streak != null)     return `(streak=${dim.streak > 0 ? '+' : ''}${dim.streak})`;
  if (dim.lambda != null)     return `(λ=${dim.lambda})`;
  if (dim.ev != null)         return `(EV=${dim.ev > 0 ? '+' : ''}${dim.ev}%)`;
  return '';
}
