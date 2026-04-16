/**
 * super-odds-engine.js — Motor SUPER ODDS v1.0.0
 *
 * Combina os melhores sinais do dia em uma única aposta combinada de alto valor.
 *
 * Critérios de seleção (S1–S5):
 *   S1 — Confiança ≥ 68% (Fire Zone de cada mercado)
 *   S2 — Liga na whitelist do mercado correspondente
 *   S3 — Odd individual entre 1.40 e 3.50
 *   S4 — Eventos independentes (máx. 2 seleções da mesma liga; 0 do mesmo jogo correlacionadas)
 *   S5 — Escalação confirmada (não bloqueado por ausência crítica)
 *
 * Critérios do gate final (G1–G6):
 *   G1 — Mínimo 3 seleções, máximo 5
 *   G2 — Odd acumulada ≥ 10.0 (SUPER ODDS threshold)
 *   G3 — EV global > 0 (P_conjunta × odd_acumulada > 1)
 *   G4 — Máximo 2 seleções da mesma liga
 *   G5 — Score multicamada médio ≥ 0.72 (qualidade de dados)
 *   G6 — Nenhuma seleção com dado degradado (dado_degradado = true) como seleção primária
 *
 * Exporta:
 *   collectCandidates(analyzedSignals)         → Signal[]
 *   calcValueScore(confianca, odd)             → number
 *   buildCombination(candidates)               → Combination | null
 *   checkCorrelation(selections)               → { ok, motivo }
 *   calcEV(selections)                         → { p_conjunta, odd_acumulada, ev }
 *   gateFinal(combo)                           → { approved, gates }
 *   formatGroupMessage(combo)                  → string
 *   formatAdminMessage(combo)                  → string
 *   runSuperOddsEngine(analyzedSignals)        → Promise<Combination | null>
 */

import { calcScoreComposite } from '../utils/score-composite.js';
import { formatSuperOddsSignal, validarMensagem, SEP, EMOJI } from '../utils/signal-formatter.js';

// ── Constantes ────────────────────────────────────────────────────────────────
const MIN_CONFIANCA      = 68;     // S1
const MIN_ODD_INDIVIDUAL = 1.40;   // S3
const MAX_ODD_INDIVIDUAL = 3.50;   // S3
const MIN_SELECOES       = 3;      // G1
const MAX_SELECOES       = 5;      // G1
const MIN_ODD_ACUMULADA  = 10.0;   // G2
const MIN_SCORE_MEDIO    = 0.72;   // G5
const MAX_MESMA_LIGA     = 2;      // G4 / S4

// ── S1–S5: Coleta de candidatos ───────────────────────────────────────────────
/**
 * Filtra sinais analisados que atendem todos os critérios de seleção (S1–S5).
 *
 * @param {Array<object>} analyzedSignals — array de { matchData, agentResult, scoreData? }
 *   agentResult deve conter: { confianca, probabilidade, mercado, odd, recomendacao }
 * @returns {Array<object>} candidatos filtrados com value_score calculado
 */
export function collectCandidates(analyzedSignals) {
  if (!Array.isArray(analyzedSignals) || analyzedSignals.length === 0) return [];

  return analyzedSignals
    .filter(s => {
      const r = s.agentResult || s;
      const m = s.matchData  || {};

      // S1 — Confiança ≥ 68%
      if ((r.confianca || 0) < MIN_CONFIANCA) return false;

      // S3 — Odd no range [1.40, 3.50]
      const odd = r.odd || r.odds_minima || 0;
      if (odd < MIN_ODD_INDIVIDUAL || odd > MAX_ODD_INDIVIDUAL) return false;

      // S5 — Sinal não bloqueado por dado crítico ausente
      if (r.bloqueado || r.kill_switch || r.blocked) return false;

      return true;
    })
    .map(s => {
      const r = s.agentResult || s;
      const m = s.matchData   || {};
      const odd = r.odd || r.odds_minima || 0;

      // Calcular score multicamada se ainda não calculado
      const scoreData = s.scoreData || calcScoreComposite(m, r);
      const value     = calcValueScore(r.confianca, odd);

      return {
        matchData:   m,
        agentResult: r,
        scoreData,
        value_score: value,
        liga: (m.competition || m.league || '').toLowerCase(),
        mercado: r.mercado || r.market || '',
        odd,
        confianca:   r.confianca,
        probabilidade: r.probabilidade,
        match_name:  m.match || m.match_name || '',
      };
    })
    .sort((a, b) => b.value_score - a.value_score); // ordena do melhor para o pior
}

// ── Value Score ───────────────────────────────────────────────────────────────
/**
 * Calcula o value score de uma seleção.
 * value = P(evento) - P(odd implícita)
 *       = confianca/100 - 1/odd
 *
 * @param {number} confianca — [0, 100]
 * @param {number} odd       — odd decimal ≥ 1.01
 * @returns {number} — positivo = valor; negativo = sem valor
 */
export function calcValueScore(confianca, odd) {
  if (!confianca || !odd || odd <= 1) return -1;
  return (confianca / 100) - (1 / odd);
}

// ── Verificação de correlação ─────────────────────────────────────────────────
/**
 * Verifica independência entre seleções.
 *
 * Regras:
 *   - Máximo 2 seleções da mesma liga
 *   - 0 seleções do mesmo jogo com mercados correlacionados
 *     (BTTS + Over 1.5 do mesmo jogo = correlação direta → bloqueado)
 *
 * @param {Array<object>} selections — candidatos selecionados
 * @returns {{ ok: boolean, motivo: string|null }}
 */
export function checkCorrelation(selections) {
  // Contagem por liga
  const ligaCount = {};
  for (const s of selections) {
    const liga = s.liga || 'desconhecida';
    ligaCount[liga] = (ligaCount[liga] || 0) + 1;
    if (ligaCount[liga] > MAX_MESMA_LIGA) {
      return { ok: false, motivo: `Máximo ${MAX_MESMA_LIGA} seleções da mesma liga (${liga})` };
    }
  }

  // Correlação intra-jogo: BTTS + Over 1.5 do mesmo jogo
  const mercadosCorrelatosParDoJogo = [
    ['BTTS', 'Over 1.5'],
    ['Ambas Marcam', 'Over 1.5'],
    ['BTTS', 'Over 2.5'],
    ['Ambas Marcam', 'Over 2.5'],
  ];

  const jogos = {};
  for (const s of selections) {
    const key = s.match_name || s.liga;
    if (!jogos[key]) jogos[key] = [];
    jogos[key].push(s.mercado);
  }

  for (const [jogo, mercados] of Object.entries(jogos)) {
    for (const [m1, m2] of mercadosCorrelatosParDoJogo) {
      const temM1 = mercados.some(m => m.toLowerCase().includes(m1.toLowerCase()));
      const temM2 = mercados.some(m => m.toLowerCase().includes(m2.toLowerCase()));
      if (temM1 && temM2) {
        return { ok: false, motivo: `${m1} e ${m2} do mesmo jogo são correlacionados (${jogo})` };
      }
    }
  }

  return { ok: true, motivo: null };
}

// ── Construção da combinação ──────────────────────────────────────────────────
/**
 * Constrói a melhor combinação possível a partir dos candidatos.
 *
 * Algoritmo:
 *   1. Começa com os 3 melhores candidatos por value_score
 *   2. Verifica correlação — substitui se necessário
 *   3. Tenta adicionar 4ª e 5ª seleções se odd_acumulada < 10.0
 *   4. Retorna a combinação que atende G1-G6 ou null se impossível
 *
 * @param {Array<object>} candidates — saída de collectCandidates()
 * @returns {object|null} combination ou null
 */
export function buildCombination(candidates) {
  if (candidates.length < MIN_SELECOES) return null;

  // Tentativa greedy: adiciona candidatos um a um respeitando correlação e gate
  let selections = [];

  for (const cand of candidates) {
    if (selections.length >= MAX_SELECOES) break;

    const tentativa = [...selections, cand];
    const corr = checkCorrelation(tentativa);
    if (!corr.ok) continue; // pula — viola correlação

    selections = tentativa;

    // Verificar se já atende G1 + G2 — para de adicionar se sim
    if (selections.length >= MIN_SELECOES) {
      const ev = calcEV(selections);
      if (ev.odd_acumulada >= MIN_ODD_ACUMULADA) break;
    }
  }

  if (selections.length < MIN_SELECOES) return null;

  const ev = calcEV(selections);
  const scoresMedios = selections.map(s => s.scoreData?.score ?? 0.5);
  const scoreMedio = scoresMedios.reduce((a, b) => a + b, 0) / scoresMedios.length;

  return {
    selections,
    odd_acumulada: ev.odd_acumulada,
    p_conjunta:    ev.p_conjunta,
    ev:            ev.ev,
    score_medio:   scoreMedio,
    criado_em:     new Date().toISOString(),
  };
}

// ── Cálculo de EV ─────────────────────────────────────────────────────────────
/**
 * Calcula probabilidade conjunta, odd acumulada e EV da combinação.
 *
 * Assume independência entre eventos (validada por checkCorrelation).
 *
 * @param {Array<object>} selections
 * @returns {{ p_conjunta: number, odd_acumulada: number, ev: number }}
 */
export function calcEV(selections) {
  let pConjunta   = 1;
  let oddAcum     = 1;

  for (const s of selections) {
    const p   = (s.probabilidade || s.agentResult?.probabilidade || 50) / 100;
    const odd = s.odd || 1;
    pConjunta   *= p;
    oddAcum     *= odd;
  }

  const ev = pConjunta * oddAcum - 1;

  return {
    p_conjunta:    parseFloat(pConjunta.toFixed(4)),
    odd_acumulada: parseFloat(oddAcum.toFixed(2)),
    ev:            parseFloat(ev.toFixed(4)),
  };
}

// ── Gate Final ────────────────────────────────────────────────────────────────
/**
 * Aplica os 6 gates finais na combinação.
 *
 * @param {object} combo — saída de buildCombination()
 * @returns {{ approved: boolean, gates: object }}
 */
export function gateFinal(combo) {
  if (!combo) return { approved: false, gates: { G0: 'combinação nula' } };

  const { selections, odd_acumulada, ev, score_medio } = combo;
  const gates = {};

  // G1 — Número de seleções
  gates.G1 = selections.length >= MIN_SELECOES && selections.length <= MAX_SELECOES
    ? null : `${selections.length} seleções (esperado ${MIN_SELECOES}–${MAX_SELECOES})`;

  // G2 — Odd acumulada
  gates.G2 = odd_acumulada >= MIN_ODD_ACUMULADA
    ? null : `Odd acumulada ${odd_acumulada.toFixed(2)} < ${MIN_ODD_ACUMULADA}`;

  // G3 — EV positivo
  gates.G3 = ev > 0
    ? null : `EV ${(ev * 100).toFixed(1)}% ≤ 0`;

  // G4 — Correlação (já verificado em buildCombination, confirmar aqui)
  const corr = checkCorrelation(selections);
  gates.G4 = corr.ok ? null : corr.motivo;

  // G5 — Score médio
  gates.G5 = score_medio >= MIN_SCORE_MEDIO
    ? null : `Score médio ${(score_medio * 100).toFixed(0)}% < ${MIN_SCORE_MEDIO * 100}%`;

  // G6 — Dado degradado como seleção primária
  const degradadas = selections.filter(s => s.agentResult?.dado_degradado === true);
  gates.G6 = degradadas.length === 0
    ? null : `${degradadas.length} seleção(ões) com dado degradado`;

  const failures = Object.entries(gates).filter(([, v]) => v !== null);
  return {
    approved: failures.length === 0,
    gates:    Object.fromEntries(
      Object.entries(gates).map(([k, v]) => [k, v === null ? 'OK' : v])
    ),
    failures: failures.map(([k, v]) => `${k}: ${v}`),
  };
}

// ── Formatadores — delegam para signal-formatter.js (Identidade Visual) ───────

/**
 * Formata mensagem SUPER ODDS para o GRUPO.
 * Usa template M4 do Protocolo de Identidade Visual (signal-formatter.js).
 * Valida o padrão antes de retornar — retorna null se inválido.
 *
 * @param {object} combo — combinação aprovada
 * @returns {string|null} HTML conforme template M4
 */
export function formatGroupMessage(combo) {
  const html = formatSuperOddsSignal(combo);
  if (!html) return null;

  const check = validarMensagem(html, 'SUPER_ODD');
  if (!check.ok) {
    console.error('[SuperOddsEngine] formatGroupMessage — validação falhou:', check.erros.join(' · '));
    return null;
  }
  return html;
}

/**
 * Formata mensagem SUPER ODDS para o ADMIN (análise técnica completa).
 * Inclui breakdown de scores, gates, EV detalhado — não vai ao grupo.
 *
 * @param {object} combo   — combinação aprovada
 * @param {object} gateRes — resultado de gateFinal()
 * @returns {string} HTML (sem validação — é mensagem de admin, não de grupo)
 */
export function formatAdminMessage(combo, gateRes) {
  const { selections, odd_acumulada, p_conjunta, ev, score_medio } = combo;
  const hora = new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });

  const linhas = [
    SEP,
    `🔧 <b>[ADMIN] SUPER ODD — ${hora}</b>`,
    ``,
    `<b>${selections.length} seleções · Gates: ${gateRes.approved ? 'APROVADO ✅' : 'REJEITADO ❌'}</b>`,
    SEP,
  ];

  for (const s of selections) {
    const r  = s.agentResult || {};
    const sd = s.scoreData   || {};
    linhas.push(`<b>${s.match_name}</b> · ${s.mercado} @${s.odd?.toFixed(2)}`);
    linhas.push(`  Conf: <code>${s.confianca}%</code> · Prob: <code>${s.probabilidade}%</code>`);
    linhas.push(`  Value: <code>${(s.value_score * 100).toFixed(1)}pp</code> · Score: <code>${sd.pct ?? '—'}% (${sd.label ?? '—'})</code>`);
    if (sd.breakdown) {
      linhas.push(`  Hist:${sd.breakdown.historico}% · Forma:${sd.breakdown.forma_recente}% · Ctx:${sd.breakdown.contexto}% · Mkt:${sd.breakdown.mercado}% · Liga×${sd.breakdown.fator_liga}`);
    }
    if (r.dado_degradado) linhas.push(`  ${EMOJI.AVISO} DADO DEGRADADO`);
    linhas.push(``);
  }

  linhas.push(SEP);
  linhas.push(`Odd acumulada: <code>${odd_acumulada.toFixed(2)}x</code>`);
  linhas.push(`P(conjunta):   <code>${(p_conjunta * 100).toFixed(2)}%</code>`);
  linhas.push(`EV:            <code>${(ev * 100).toFixed(1)}%</code>`);
  linhas.push(`Score médio:   <code>${(score_medio * 100).toFixed(0)}%</code>`);
  linhas.push(``);
  linhas.push(`<b>Gates:</b>`);
  for (const [k, v] of Object.entries(gateRes.gates)) {
    const icon = v === 'OK' ? '✅' : '❌';
    linhas.push(`${icon} ${k}: ${v}`);
  }
  linhas.push(SEP);

  return linhas.join('\n');
}

// ── Pipeline completo ─────────────────────────────────────────────────────────
/**
 * Executa o pipeline completo de SUPER ODDS.
 *
 * @param {Array<object>} analyzedSignals — sinais já analisados pelos agentes
 * @returns {Promise<{combo, gateRes, groupMsg, adminMsg, motivo?}>}
 */
export async function runSuperOddsEngine(analyzedSignals) {
  try {
    // 1. Coletar candidatos (S1–S5)
    const candidates = collectCandidates(analyzedSignals);
    if (candidates.length < MIN_SELECOES) {
      return { combo: null, gateRes: null, groupMsg: null, adminMsg: null,
        motivo: `Candidatos insuficientes: ${candidates.length}/${MIN_SELECOES}` };
    }

    // 2. Construir combinação
    const combo = buildCombination(candidates);
    if (!combo) {
      return { combo: null, gateRes: null, groupMsg: null, adminMsg: null,
        motivo: 'Nenhuma combinação válida encontrada' };
    }

    // 3. Gate final (G1–G6)
    const gateRes = gateFinal(combo);

    // 4. Formatar — grupo usa template M4 validado; admin usa formato técnico
    const groupMsg = gateRes.approved ? formatGroupMessage(combo) : null;
    const adminMsg = formatAdminMessage(combo, gateRes);

    return { combo, gateRes, groupMsg, adminMsg };

  } catch (err) {
    console.error('[SuperOddsEngine] Erro interno:', err.message);
    return { combo: null, gateRes: null, groupMsg: null, adminMsg: null,
      motivo: `Erro interno: ${err.message}` };
  }
}

export default {
  collectCandidates,
  calcValueScore,
  buildCombination,
  checkCorrelation,
  calcEV,
  gateFinal,
  formatGroupMessage,
  formatAdminMessage,
  runSuperOddsEngine,
};
