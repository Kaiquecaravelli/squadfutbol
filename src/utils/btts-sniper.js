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

// ── Derbies históricos — calibração P_B3 (19/04/2026) ────────────────────────
const DERBIES_HISTORICOS = new Set([
  // Inglaterra
  'everton_liverpool', 'liverpool_everton',
  'manchester city_manchester united', 'manchester united_manchester city',
  'arsenal_tottenham', 'tottenham_arsenal',
  'chelsea_arsenal', 'arsenal_chelsea',
  'chelsea_tottenham', 'tottenham_chelsea',
  'aston villa_birmingham', 'birmingham_aston villa',
  // Brasil
  'flamengo_fluminense', 'fluminense_flamengo',
  'santos_palmeiras', 'palmeiras_santos',
  'corinthians_são paulo', 'são paulo_corinthians',
  'corinthians_sao paulo', 'sao paulo_corinthians',
  'grêmio_internacional', 'internacional_grêmio',
  'gremio_internacional', 'internacional_gremio',
  'atlético mineiro_cruzeiro', 'cruzeiro_atlético mineiro',
  'atletico mineiro_cruzeiro', 'cruzeiro_atletico mineiro',
  'vasco_flamengo', 'flamengo_vasco',
  'ceará_fortaleza', 'fortaleza_ceará',
  'ceara_fortaleza', 'fortaleza_ceara',
  // Espanha
  'real madrid_barcelona', 'barcelona_real madrid',
  'atlético de madrid_real madrid', 'real madrid_atlético de madrid',
  'atletico de madrid_real madrid', 'real madrid_atletico de madrid',
  'barcelona_espanyol', 'espanyol_barcelona',
  // Itália
  'inter_milan', 'milan_inter',
  'juventus_torino', 'torino_juventus',
  'roma_lazio', 'lazio_roma',
  // França
  'psg_lyon', 'lyon_psg',
  'paris saint-germain_lyon', 'lyon_paris saint-germain',
  'marseille_psg', 'psg_marseille',
  // Alemanha
  'borussia dortmund_schalke', 'schalke_borussia dortmund',
  'fc bayern münchen_borussia dortmund', 'borussia dortmund_fc bayern münchen',
  'fc bayern munchen_borussia dortmund', 'borussia dortmund_fc bayern munchen',
]);

function _isDerbyHistorico(matchData) {
  const casa = (matchData.home?.team || matchData.home_team || '').toLowerCase().trim();
  const fora = (matchData.away?.team || matchData.away_team || '').toLowerCase().trim();
  return DERBIES_HISTORICOS.has(`${casa}_${fora}`) || DERBIES_HISTORICOS.has(`${fora}_${casa}`);
}

// ── Padrões BTTS — calibração 19/04/2026 ─────────────────────────────────────
// Derivados de análise de 15 jogos BTTS confirmados (7 ligas · 4 países)
// Bônus em pp (pontos percentuais). Teto acumulado: +15pp por análise.
const PADROES_BTTS = [
  {
    id:      'P_B1_OVER35_CORRELACAO',
    // 11/15 jogos com 4+ gols totais tiveram BTTS. P(BTTS|Over3.5≥70%) ≈ 0.95
    ativo:   (r, md) => (r._probOver35 ?? 0) >= 70,
    bonus:   8, // pp
  },
  {
    id:      'P_B2_VISITANTE_REBAIXAMENTO',
    // 7/15 jogos: time inferior/rebaixamento visitante marcou mesmo perdendo
    ativo:   (r, md) => {
      const pos  = md.away?.league_position ?? md.away?.posicao ?? 0;
      const total = md.total_teams ?? md.away?.total_times ?? 20;
      return pos > 0 && pos >= total - 4;
    },
    bonus:   7,
  },
  {
    id:      'P_B3_DERBY_CLASSICO',
    // Everton×Liverpool confirmou: rivalidade elimina postura conservadora
    ativo:   (r, md) => _isDerbyHistorico(md),
    bonus:   9,
  },
  {
    id:      'P_B4_FAVORITO_TAMBEM_SOFRE',
    // 10/15: favorito venceu mas levou gol. Remove penalidade implícita por desequilíbrio.
    ativo:   (r, md) => {
      const posC = md.home?.league_position ?? md.home?.posicao ?? 0;
      const posF = md.away?.league_position ?? md.away?.posicao ?? 0;
      return posC > 0 && posF > 0 && Math.abs(posC - posF) >= 8;
    },
    bonus:   4,
  },
  {
    id:      'P_B5_SEGUNDA_DIVISAO_OFENSIVA',
    // Série B BR, Championship EN, Ligue 2 FR, Serie B IT — defesas menos organizadas
    ligas:   [
      'brasileirão série b', 'brasileirao serie b', 'série b', 'serie b',
      'ligue 2',
      // Championship removida: já está em DEAD_LEAGUE_PATTERNS (sem BTTS histórico)
      // 2. Bundesliga: EXCLUÍDA (BTTS historicamente baixo na Bundesliga 2)
      'segunda division', 'segunda división',
    ],
    ativo:   (r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      return PADROES_BTTS.find(p => p.id === 'P_B5_SEGUNDA_DIVISAO_OFENSIVA')
        .ligas.some(l => comp.includes(l));
    },
    bonus:   5,
    fator:   1.03, // eleva prob_base em 3% antes dos bônus aditivos
  },
  {
    id:      'P_B6_COPA_DOMESTICA',
    // FA Cup Aston Villa 4-3 Sunderland: eliminação direta remove postura conservadora
    ligas:   ['fa cup', 'copa do brasil', 'coupe de france', 'coppa italia', 'dfb pokal'],
    // copa del rey está em DEAD_LEAGUE_PATTERNS → não aplicar
    ativo:   (r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      return PADROES_BTTS.find(p => p.id === 'P_B6_COPA_DOMESTICA')
        .ligas.some(l => comp.includes(l));
    },
    bonus:   6,
  },
  {
    id:      'P_B7_H2H_EMPATE_FREQUENTE',
    // 3 empates hoje — todos BTTS. H2H com ≥40% de empates alimenta BTTS.
    ativo:   (r, md) => (md.h2h?.draw_rate ?? md.taxa_empate_h2h ?? 0) >= 0.40,
    bonus:   5,
  },
  {
    id:      'P_B8_LIGUE1_SISTEMATICO',
    // 3/3 jogos Ligue 1 hoje com BTTS. Whitelist mantida com fator extra.
    ativo:   (r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      return comp.includes('ligue 1') || comp.includes('ligue1');
    },
    bonus:   4,
  },
  {
    id:      'P_B10_SERIE_A_PRESSAO',
    // Santos marcou 2, Criciúma marcou 2 — times pressionados da Série A atacam
    ativo:   (r, md) => {
      const comp = (md.competition || md.league || '').toLowerCase();
      const isSerieA = (comp.includes('brasileirão') || comp.includes('brasileirao')) &&
                       !comp.includes('série b') && !comp.includes('serie b');
      const posC = md.home?.league_position ?? 0;
      const posF = md.away?.league_position ?? 0;
      return isSerieA && (posC >= 14 || posF >= 14);
    },
    bonus:   6,
  },
  // P_B9 é princípio arquitetural — não adiciona bônus, apenas documenta que
  // prob_vitória_mandante NÃO deve ser usada como fator BTTS (PSG perdeu mas marcou)
];

/**
 * Aplica os padrões BTTS (P_B1–P_B10) à probabilidade retornada pelo LLM.
 * Deve ser chamado ANTES do kill switch para que os padrões possam ajudar
 * sinais borderline a cruzar o threshold.
 *
 * @param {object} result    — saída do agente { probabilidade, confianca, ... }
 * @param {object} matchData — dados da partida
 * @returns {{ result: object, bonus_total: number, padroes_ativos: string[] }}
 */
export function aplicarBonusBTTS(result, matchData) {
  let prob     = result.probabilidade ?? 0;
  let bonus    = 0;
  const ativos = [];
  const MAX_BONUS = 15; // pp — teto acumulado

  for (const padrao of PADROES_BTTS) {
    try {
      if (!padrao.ativo(result, matchData)) continue;

      // Fator multiplicativo (aplicado à prob base, antes dos bônus aditivos)
      if (padrao.fator) {
        prob = Math.min(prob * padrao.fator, 99);
      }

      // Bônus aditivo (com teto)
      if (padrao.bonus && bonus < MAX_BONUS) {
        const aplicar = Math.min(padrao.bonus, MAX_BONUS - bonus);
        bonus += aplicar;
        ativos.push(`${padrao.id}(+${aplicar}pp)`);
      } else if (padrao.fator) {
        ativos.push(`${padrao.id}(×${padrao.fator})`);
      }
    } catch { /* padrão individual não bloqueia o pipeline */ }
  }

  if (ativos.length === 0) return { result, bonus_total: 0, padroes_ativos: [] };

  const prob_final = Math.min(prob + bonus, 99);
  const novo_result = { ...result, probabilidade: Math.round(prob_final) };

  console.log(
    `[BTTS Padrões] ${ativos.join(' · ')} ` +
    `· prob ${result.probabilidade}% → ${Math.round(prob_final)}%`
  );

  return { result: novo_result, bonus_total: bonus, padroes_ativos: ativos };
}

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
export const BTTS_MIN_PROBABILITY = 78;
export const BTTS_MIN_CONFIDENCE  = 75;

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
