/**
 * score-composite.js — Score Multicamada v1.0.0
 *
 * Calcula um score consolidado de qualidade de análise com 4 dimensões ponderadas:
 *
 *   score_final = (
 *     score_historico     × 0.35   historico 20j — base estatística
 *   + score_forma_recente × 0.30   últimos 5j — pesos decrescentes 0.40/0.35/0.25
 *   + score_contexto      × 0.20   motivação · H2H · ausências
 *   + score_mercado       × 0.15   movimento de odds · liquidez
 *   ) × fator_liga
 *
 * Saída: número em [0, 1] — quanto mais próximo de 1, maior a qualidade do sinal.
 *
 * Exporta:
 *   calcScoreComposite(matchData, agentResult)  → { score, breakdown, escalado }
 *   FATOR_LIGA                                   → Map<string, number>
 *   scoreToLabel(score)                          → string ('ELITE'|'FORTE'|'MÉDIO'|'FRACO')
 */

// ── Fatores de qualidade por liga ─────────────────────────────────────────────
// Baseado em regularidade, volume de dados e previsibilidade histórica no PIE.
// Liga não listada → 0.90 (conservador, não bloqueia — só reduz score levemente)
export const FATOR_LIGA = new Map([
  ['brasileirão betano',       1.00],
  ['brasileirao betano',       1.00],
  ['bundesliga',               1.00],
  ['premier league',           0.98],
  ['laliga',                   0.97],
  ['la liga',                  0.97],
  ['serie a',                  0.96],
  ['ligue 1',                  0.95],
  ['liga portugal',            0.95],
  ['eredivisie',               0.94],
  ['vriendenloterij eredivisie', 0.94],
  ['brasileirão série b',      0.93],
  ['brasileirao serie b',      0.93],
  ['mls',                      0.92],
  ['liga profesional',         0.91],
  ['europa league',            0.88],
  ['champions league',         0.85], // UCL: dado degradado, modelo não calibrado por fase
]);

function _fatLiga(competition = '') {
  const c = competition.toLowerCase();
  for (const [k, v] of FATOR_LIGA) {
    if (c.includes(k)) return v;
  }
  return 0.90;
}

// ── Dimensão 1: Score Histórico (últimos 20j) ─────────────────────────────────
/**
 * Avalia consistência histórica de ambos os times.
 *
 * Entradas usadas (de matchData.home/away):
 *   - btts_pct           : % BTTS nos últimos registros
 *   - over15_pct         : % Over 1.5 nos últimos registros
 *   - goals_scored_avg   : média de gols marcados
 *   - goals_conceded_avg : média de gols sofridos
 *   - corners_avg        : média de escanteios (para mercado Corners)
 *
 * @param {object} matchData
 * @param {string} market — mercado atual ('BTTS', 'Over 1.5', etc.)
 * @returns {number} [0, 1]
 */
function _scoreHistorico(matchData, market) {
  const h = matchData.home || {};
  const a = matchData.away || {};

  // BTTS: consistência de ambas as equipes marcarem
  if (market === 'BTTS' || market === 'Ambas Marcam') {
    const hScore = h.btts_pct  != null ? h.btts_pct  / 100 : (h.goals_scored_avg  > 0 ? Math.min(h.goals_scored_avg  / 3, 1) : 0.5);
    const aScore = a.btts_pct  != null ? a.btts_pct  / 100 : (a.goals_scored_avg  > 0 ? Math.min(a.goals_scored_avg  / 3, 1) : 0.5);
    return (hScore + aScore) / 2;
  }

  // Gols: média de gols combinados normalizada
  if (market?.startsWith('Over') && !market.includes('Corner')) {
    const hGoals = h.goals_scored_avg != null ? Math.min(h.goals_scored_avg / 3, 1) : 0.5;
    const aGoals = a.goals_scored_avg != null ? Math.min(a.goals_scored_avg / 3, 1) : 0.5;
    const hConc  = a.goals_conceded_avg != null ? Math.min(a.goals_conceded_avg / 3, 1) : 0.5;
    const aConc  = h.goals_conceded_avg != null ? Math.min(h.goals_conceded_avg / 3, 1) : 0.5;
    return (hGoals * 0.30 + aGoals * 0.30 + hConc * 0.20 + aConc * 0.20);
  }

  // Escanteios
  if (market?.includes('Corner')) {
    const hCorners = h.corners_avg != null ? Math.min(h.corners_avg / 7, 1) : 0.5;
    const aCorners = a.corners_avg != null ? Math.min(a.corners_avg / 7, 1) : 0.5;
    return (hCorners + aCorners) / 2;
  }

  return 0.5; // fallback para mercados desconhecidos
}

// ── Dimensão 2: Score de Forma Recente (últimos 5j, pesos decrescentes) ──────
/**
 * Avalia tendência de forma com pesos no tempo:
 *   jogo 1 (mais recente) = 0.40, jogo 2 = 0.35, jogo 3 = 0.25
 *
 * Usa janelas 5j e 8j para detectar tendência vs estabilidade.
 *
 * @param {object} matchData
 * @param {string} market
 * @returns {number} [0, 1]
 */
function _scoreFormaRecente(matchData, market) {
  const h = matchData.home || {};
  const a = matchData.away || {};

  // Janelas disponíveis para BTTS e Gols
  const hPct5  = h.btts_pct_5j  ?? h.over15_pct_5j  ?? null;
  const hPct8  = h.btts_pct_8j  ?? h.over15_pct_8j  ?? null;
  const aPct5  = a.btts_pct_5j  ?? a.over15_pct_5j  ?? null;
  const aPct8  = a.btts_pct_8j  ?? a.over15_pct_8j  ?? null;

  // Sem dados de janela → usa média histórica com penalidade leve
  if (hPct5 == null && aPct5 == null) return 0.45;

  // Forma 5j (recente) com peso 0.40+0.35 / forma 8j (base) com peso 0.25
  const _avg5  = ((hPct5 ?? 50) + (aPct5 ?? 50)) / 2;
  const _avg8  = ((hPct8 ?? _avg5) + (aPct8 ?? _avg5)) / 2;

  // Peso ponderado: mais recente tem mais peso
  const formScore = (_avg5 * 0.75 + _avg8 * 0.25) / 100;

  // Penalidade por divergência de janelas (instabilidade de forma)
  const divH = hPct5 != null && hPct8 != null ? Math.abs(hPct5 - hPct8) : 0;
  const divA = aPct5 != null && aPct8 != null ? Math.abs(aPct5 - aPct8) : 0;
  const maxDiv = Math.max(divH, divA);
  const penalidade = maxDiv > 25 ? 0.05 : maxDiv > 15 ? 0.02 : 0;

  return Math.max(0, Math.min(1, formScore - penalidade));
}

// ── Dimensão 3: Score de Contexto ─────────────────────────────────────────────
/**
 * Avalia fatores contextuais: motivação, H2H, ausências confirmadas.
 *
 * @param {object} matchData
 * @returns {number} [0, 1]
 */
function _scoreContexto(matchData) {
  let score = 0.70; // base neutra

  // H2H disponível com histórico favorável
  if (matchData.h2h_total >= 5) {
    const h2hRate = (matchData.h2h_hits || 0) / matchData.h2h_total;
    if (h2hRate >= 0.70) score += 0.15;
    else if (h2hRate >= 0.55) score += 0.05;
    else if (h2hRate < 0.35)  score -= 0.10;
  }

  // Ausências confirmadas de titulares impactantes
  const ausencias = (matchData.home_ausencias || 0) + (matchData.away_ausencias || 0);
  if (ausencias >= 3)      score -= 0.10;
  else if (ausencias >= 1) score -= 0.03;

  // Motivação — clássico, decisivo ou sem motivação (declarado no matchData)
  if (matchData.motivacao === 'alta')  score += 0.08;
  if (matchData.motivacao === 'baixa') score -= 0.10;

  // Árbitro: índice de cartões/faltas quando disponível
  if (matchData.arbitro_idx_cartoes > 0) {
    // Árbitro permissivo em mercado de gols/escanteios → ligeiramente positivo
    if (matchData.arbitro_idx_cartoes < 3.5) score += 0.03;
  }

  return Math.max(0, Math.min(1, score));
}

// ── Dimensão 4: Score de Mercado ─────────────────────────────────────────────
/**
 * Avalia sinais do mercado de apostas (movimento de odds, liquidez).
 *
 * @param {object} agentResult — saída do agente (probabilidade, confianca, odd)
 * @returns {number} [0, 1]
 */
function _scoreMercado(agentResult) {
  if (!agentResult) return 0.50;

  const prob  = (agentResult.probabilidade || 0) / 100;
  const conf  = (agentResult.confianca     || 0) / 100;
  const odd   = agentResult.odd || agentResult.odds_minima || 0;

  // EV implícito: prob > 1/odd → valor positivo
  const ev = odd > 0 ? prob - (1 / odd) : 0;
  const evScore = Math.max(0, Math.min(1, 0.5 + ev * 3)); // normaliza EV [-0.33, +0.67] → [0, 1]

  // Confiança do modelo
  const confScore = conf;

  // Combinado — EV tem mais peso que confiança nesta dimensão
  return evScore * 0.60 + confScore * 0.40;
}

// ── Score Final ───────────────────────────────────────────────────────────────
/**
 * Calcula o score multicamada para um sinal.
 *
 * @param {object} matchData    — dados completos da partida
 * @param {object} agentResult  — saída do agente (probabilidade, confianca, mercado, odd)
 * @returns {{
 *   score:    number,    — [0, 1] score final ponderado e ajustado por liga
 *   pct:      number,    — score em % (0-100, arredondado)
 *   label:    string,    — 'ELITE' | 'FORTE' | 'MÉDIO' | 'FRACO'
 *   breakdown: {
 *     historico:    number,
 *     forma_recente: number,
 *     contexto:     number,
 *     mercado:      number,
 *     fator_liga:   number,
 *   },
 *   escalado: boolean,   — true se score ≥ 0.80 (candidato a escalação/SUPER ODDS)
 * }}
 */
export function calcScoreComposite(matchData, agentResult) {
  const market = agentResult?.mercado || agentResult?.market || '';
  const comp   = matchData?.competition || matchData?.league || '';

  const s1 = _scoreHistorico(matchData, market);
  const s2 = _scoreFormaRecente(matchData, market);
  const s3 = _scoreContexto(matchData);
  const s4 = _scoreMercado(agentResult);

  const raw   = s1 * 0.35 + s2 * 0.30 + s3 * 0.20 + s4 * 0.15;
  const fLiga = _fatLiga(comp);
  const final = Math.max(0, Math.min(1, raw * fLiga));

  return {
    score:    final,
    pct:      Math.round(final * 100),
    label:    scoreToLabel(final),
    breakdown: {
      historico:     Math.round(s1 * 100),
      forma_recente: Math.round(s2 * 100),
      contexto:      Math.round(s3 * 100),
      mercado:       Math.round(s4 * 100),
      fator_liga:    fLiga,
    },
    escalado: final >= 0.80,
  };
}

// ── Label legível ─────────────────────────────────────────────────────────────
/**
 * Converte score numérico em rótulo de qualidade.
 * @param {number} score — [0, 1]
 * @returns {string}
 */
export function scoreToLabel(score) {
  if (score >= 0.85) return 'ELITE';
  if (score >= 0.75) return 'FORTE';
  if (score >= 0.60) return 'MÉDIO';
  return 'FRACO';
}

// ── Detecção de padrões de sequência ─────────────────────────────────────────
/**
 * Detecta padrões de sequência que influenciam probabilidade.
 * Retorna ajuste em pp a ser somado à probabilidade base.
 *
 * @param {object} matchData
 * @param {string} market
 * @returns {{ ajuste_pp: number, padrao: string|null }}
 */
export function detectSequencePatter(matchData, market) {
  const h = matchData.home || {};
  const a = matchData.away || {};

  if (market === 'BTTS' || market === 'Ambas Marcam') {
    // 5+ jogos consecutivos com BTTS → regressão à média esperada → boost
    const seqBttsH = h.sequencia_btts || 0;
    const seqBttsA = a.sequencia_btts || 0;
    if (seqBttsH >= 5 || seqBttsA >= 5) {
      return { ajuste_pp: 4, padrao: `BTTS em ${Math.max(seqBttsH, seqBttsA)} consecutivos` };
    }

    // 5+ sem BTTS → desequilíbrio acumulado → boost condicional
    const seqSemH = h.sequencia_sem_btts || 0;
    const seqSemA = a.sequencia_sem_btts || 0;
    if (seqSemH >= 5 || seqSemA >= 5) {
      return { ajuste_pp: 3, padrao: `${Math.max(seqSemH, seqSemA)} consecutivos sem BTTS` };
    }
  }

  if (market?.startsWith('Over') && !market.includes('Corner')) {
    // Over 1.5: sequências de gols recentes
    const hPct5 = h.over15_pct_5j ?? null;
    const aPct5 = a.over15_pct_5j ?? null;
    if (hPct5 != null && aPct5 != null) {
      const avg5 = (hPct5 + aPct5) / 2;
      if (avg5 >= 80) return { ajuste_pp: 3, padrao: `Over 1.5 recente ${Math.round(avg5)}% (5j)` };
      if (avg5 <= 30) return { ajuste_pp: -3, padrao: `Over 1.5 recente baixo ${Math.round(avg5)}% (5j)` };
    }
  }

  return { ajuste_pp: 0, padrao: null };
}

export default { calcScoreComposite, scoreToLabel, detectSequencePatter, FATOR_LIGA };
