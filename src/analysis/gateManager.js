/**
 * gateManager.js — Gate Manager v4 (Under + Gates Dinâmicos por Tier)
 *
 * Gate Under elevado para 80% (spec 2026-04-16) — INVIOLÁVEL.
 * Gates Over/BTTS/Corners calculados por tier da liga (tierConfig.js).
 * Regra dupla Under: probabilidade Poisson ≥ 80% E confiança ≥ 80% (simultânea).
 *
 * Exporta (Under — invioláveis):
 *   UNDER_GATE_ABSOLUTO      = 0.80
 *   UNDER_CONFIANCA_MINIMA   = 0.80
 *   validarUnder(mercado, prob_decimal, conf_decimal, liga) → objeto com {elegivel, motivo, ...}
 *   applyUnderPiso(gate_calculado)                         → Math.max(gate, 0.80)
 *
 * Exporta (dinâmicos — Módulo 4):
 *   obterGateVigente(mercado, liga, hora, contadorDia)     → número (0.72 – 0.90)
 *   obterGateConfianca(mercado, liga)                      → número (0.70 – 0.85)
 */

// ── Constantes absolutas ──────────────────────────────────────────────────────
export const UNDER_GATE_ABSOLUTO    = 0.80;
export const UNDER_CONFIANCA_MINIMA = 0.80;

/**
 * Verifica se o mercado é Under de gols (Under 1.5 / 2.5 / 3.5 etc.).
 * Exclui Under Corners (mercado distinto com lógica própria).
 */
function _isUnderGols(mercado = '') {
  return /^under\s*[\d.]+$/i.test(mercado.trim()) &&
         !/corner|escanteio/i.test(mercado);
}

/**
 * validarUnder — dupla validação prob + confiança para mercados Under.
 *
 * @param {string} mercado         — nome do mercado ('Under 1.5', 'Under 2.5', ...)
 * @param {number} prob_decimal    — probabilidade em decimal (0–1) ou percentual (0–100)
 * @param {number} conf_decimal    — confiança em decimal (0–1) ou percentual (0–100)
 * @param {string} [liga]          — nome da liga (para logging)
 * @returns {object|null}          — null se não for mercado Under; objeto com elegivel/motivo
 */
export function validarUnder(mercado, prob_decimal, conf_decimal, liga = '') {
  if (!_isUnderGols(mercado)) return null; // não Under de gols — usar lógica padrão

  // Normaliza: aceita tanto 0-1 quanto 0-100
  const prob = prob_decimal <= 1 ? prob_decimal : prob_decimal / 100;
  const conf = conf_decimal <= 1 ? conf_decimal : conf_decimal / 100;

  const probPct = parseFloat((prob * 100).toFixed(1));
  const confPct = parseFloat((conf * 100).toFixed(1));
  const gatePct = UNDER_GATE_ABSOLUTO   * 100;
  const confMin = UNDER_CONFIANCA_MINIMA * 100;

  const prob_ok = prob >= UNDER_GATE_ABSOLUTO;
  const conf_ok = conf >= UNDER_CONFIANCA_MINIMA;

  const resultado = {
    mercado,
    liga,
    prob:      probPct,
    confianca: confPct,
    gate_prob: gatePct,
    gate_conf: confMin,
    elegivel:  false,
    motivo:    null,
    detalhes:  {
      prob_decimal: prob.toFixed(4),
      conf_decimal: conf.toFixed(4),
      prob_ok,
      conf_ok,
      gap_prob: prob_ok ? 0 : parseFloat(((UNDER_GATE_ABSOLUTO    - prob) * 100).toFixed(1)),
      gap_conf: conf_ok ? 0 : parseFloat(((UNDER_CONFIANCA_MINIMA - conf) * 100).toFixed(1)),
    },
  };

  // ── Decisão ───────────────────────────────────────────────────────────────
  if (prob_ok && conf_ok) {
    resultado.elegivel = true;
    resultado.motivo   = `APROVADO — prob ${probPct}% ≥ 80% E confiança ${confPct}% ≥ 80%`;
    console.log(`[UNDER_GATE] ✅ ${resultado.motivo} · ${mercado}${liga ? ' · ' + liga : ''}`);
    return resultado;
  }

  if (!prob_ok && !conf_ok) {
    resultado.motivo = (
      `REPROVADO — prob ${probPct}% < 80% (faltam ${resultado.detalhes.gap_prob}pp) ` +
      `E confiança ${confPct}% < 80% (faltam ${resultado.detalhes.gap_conf}pp)`
    );
  } else if (!prob_ok) {
    resultado.motivo = `REPROVADO — prob ${probPct}% < 80% (faltam ${resultado.detalhes.gap_prob}pp)`;
  } else {
    resultado.motivo = `REPROVADO — confiança ${confPct}% < 80% (faltam ${resultado.detalhes.gap_conf}pp)`;
  }

  console.log(`[UNDER_GATE] ❌ ${resultado.motivo} · ${mercado}${liga ? ' · ' + liga : ''}`);
  return resultado;
}

/**
 * applyUnderPiso — garante que qualquer gate calculado para Under nunca caia abaixo de 80%.
 * Usar em todos os pontos onde gates são computados dinamicamente.
 *
 * @param {number} gate_calculado — gate em decimal (0–1)
 * @returns {number}              — Math.max(gate_calculado, UNDER_GATE_ABSOLUTO)
 */
export function applyUnderPiso(gate_calculado) {
  const result = Math.max(gate_calculado, UNDER_GATE_ABSOLUTO);
  if (gate_calculado < UNDER_GATE_ABSOLUTO) {
    console.warn(
      `[PISO_UNDER] Tentativa de usar gate ${(gate_calculado * 100).toFixed(0)}% ` +
      `para Under — corrigido para 80% (piso absoluto)`
    );
  }
  return result;
}

/**
 * obterGateUnder — retorna SEMPRE 0.80 para Under, ignorando escalada/hora/contador.
 * Usar como substituto de qualquer função de gate dinâmico para Under.
 *
 * @returns {number} 0.80 — invariante
 */
export function obterGateUnder() {
  return UNDER_GATE_ABSOLUTO; // never below 0.80
}

// ── Gates Dinâmicos por Liga + Mercado (Módulo 4 · 22/04/2026) ───────────────
// Importação lazy para evitar dependência circular (tierConfig importa gateManager)

let _tierConfig = null;
async function _getTierConfig() {
  if (!_tierConfig) {
    _tierConfig = await import('../config/tierConfig.js');
  }
  return _tierConfig;
}

/**
 * obterGateVigente — gate efetivo considerando tier da liga, mercado,
 * hora do dia (escalada noturna Tier 1/2) e contador de sinais do dia.
 *
 * Under é inviolável — retorna 0.80 independente de qualquer parâmetro.
 *
 * Escalada noturna (apenas Tier 1 e 2 após 20:00 com < 2 sinais no dia):
 *   Tier 1: -2pp (ex: 80% → 78%)
 *   Tier 2: -1pp (ex: 82% → 81%)
 *   Mínimo absoluto: 72%
 *
 * @param {string} mercado      — nome do mercado
 * @param {string} liga         — nome da liga
 * @param {number} [horaAtual]  — hora do dia (0-23, default: hora atual)
 * @param {number} [contadorDia]— sinais emitidos hoje (default: 0)
 * @returns {Promise<number>}   — gate em decimal (0.72 – 0.90)
 */
export async function obterGateVigente(mercado, liga, horaAtual, contadorDia = 0) {
  const mkt = (mercado || '').trim();

  // Under: piso absoluto inviolável
  if (/^under/i.test(mkt) && !/corner|escanteio/i.test(mkt)) {
    return UNDER_GATE_ABSOLUTO;
  }

  const tc       = await _getTierConfig();
  const gateBase = tc.getGateEfetivo(liga, mkt);
  const { config } = tc.getTierLiga(liga);
  const hora     = horaAtual ?? new Date().getHours();

  // Escalada noturna: Tier 1/2, após 20h, com poucos sinais no dia
  if (config.numero <= 2 && hora >= 20 && contadorDia < 2) {
    const relaxamento = config.numero === 1 ? 0.02 : 0.01;
    const gateFinal   = Math.max(gateBase - relaxamento, 0.72);
    if (gateFinal < gateBase) {
      console.log(
        `[GATE] Escalada noturna Tier${config.numero}: ${(gateBase*100).toFixed(0)}% → ${(gateFinal*100).toFixed(0)}%` +
        ` (${mkt} · ${liga} · ${hora}h · ${contadorDia} sinais hoje)`
      );
    }
    return gateFinal;
  }

  return gateBase;
}

/**
 * obterGateConfianca — gate mínimo de confiança para liga + mercado.
 * Under é inviolável — retorna 0.80.
 *
 * @param {string} mercado — nome do mercado
 * @param {string} liga    — nome da liga
 * @returns {Promise<number>} — gate em decimal (0.70 – 0.85)
 */
export async function obterGateConfianca(mercado, liga) {
  const mkt = (mercado || '').trim();

  // Under: piso absoluto inviolável
  if (/^under/i.test(mkt) && !/corner|escanteio/i.test(mkt)) {
    return UNDER_CONFIANCA_MINIMA;
  }

  const tc = await _getTierConfig();
  return tc.getGateConfianca(liga, mkt);
}

// ── Combinações competição+mercado bloqueadas por histórico insuficiente ───────
const COMPETITION_MARKET_BLOCKS = {
  'Conference League':              new Set(['BTTS']),
  'UEFA Conference League':         new Set(['BTTS']),
  'UEFA Europa Conference League':  new Set(['BTTS']),
};

/**
 * Verifica se a combinação competição+mercado está explicitamente bloqueada.
 * Usado quando o histórico do PIE é < 20% para aquele par.
 */
export function isCompetitionMarketBlocked(competition, market) {
  const blocks = COMPETITION_MARKET_BLOCKS[competition];
  if (!blocks) return false;
  return blocks.has(market);
}

/**
 * validarGateCompetition — gate baseado na calibração histórica PIE por competição.
 *
 * Retorna null quando não há dados suficientes (sem bloqueio — benefício da dúvida).
 * Retorna { elegivel, motivo, ... } quando há dados para decidir.
 *
 * @param {string} market        — nome do mercado (ex: 'BTTS', 'Over 1.5')
 * @param {string} competition   — nome da competição
 * @param {object} calibration   — db.calibration (de loadDB())
 * @param {object} [opts]
 * @param {number} [opts.minSamples=15]  — mínimo de amostras para decidir
 * @param {number} [opts.minAccuracy=0.55] — precisão mínima aceita (decimal)
 */
export function validarGateCompetition(market, competition, calibration, {
  minSamples  = 15,
  minAccuracy = 0.55,
} = {}) {
  // Bloqueio explícito por par conhecido
  if (isCompetitionMarketBlocked(competition, market)) {
    console.log(`[COMP_GATE] ❌ ${market} bloqueado para ${competition} (histórico < 20%)`);
    return {
      elegivel:    false,
      mercado:     market,
      competicao:  competition,
      accuracy:    null,
      samples:     null,
      motivo:      `REPROVADO — ${market} bloqueado para ${competition} (precisão histórica crítica)`,
    };
  }

  if (!calibration || !market || !competition) return null;

  const cal = calibration[market];
  if (!cal?.byCompetition) return null;

  const compData = cal.byCompetition[competition];
  if (!compData || compData.total < minSamples) return null; // sem dados → passa

  const accuracy = compData.hits / compData.total;
  const eligible = accuracy >= minAccuracy;
  const pctStr   = (accuracy * 100).toFixed(1);
  const minStr   = (minAccuracy * 100).toFixed(0);

  if (!eligible) {
    console.log(`[COMP_GATE] ❌ ${market} em ${competition}: ${pctStr}% < ${minStr}% (${compData.total} amostras)`);
  }

  return {
    elegivel:   eligible,
    mercado:    market,
    competicao: competition,
    accuracy:   +pctStr,
    samples:    compData.total,
    motivo: eligible
      ? `APROVADO — ${pctStr}% em ${competition} (${compData.total} amostras)`
      : `REPROVADO — ${pctStr}% < ${minStr}% mín para ${market} em ${competition} (${compData.total} amostras)`,
  };
}

/**
 * validarCalibracaoPorFaixa — detecta falsos positivos quando o modelo
 * é historicamente impreciso na faixa de probabilidade específica que está sendo prevista.
 *
 * Ex: Over 1.5 geral 92%, mas na faixa 65-70% só 55% de acerto → falso positivo.
 *
 * Retorna null quando não há dados suficientes na faixa (passa sem bloqueio).
 *
 * @param {string} market      — nome do mercado
 * @param {number} prob        — probabilidade prevista (decimal 0-1 ou 0-100)
 * @param {object} calibration — db.calibration
 * @param {object} [opts]
 * @param {number} [opts.minSamples=8]    — mínimo de amostras na faixa para decidir
 * @param {number} [opts.minAccuracy=0.58] — precisão mínima na faixa
 */
export function validarCalibracaoPorFaixa(market, prob, calibration, {
  minSamples  = 8,
  minAccuracy = 0.58,
} = {}) {
  if (!calibration || !market || prob == null) return null;

  const probPct = prob <= 1 ? prob * 100 : prob;

  const _faixa = (p) => {
    if (p >= 95) return '95+';
    if (p >= 90) return '90-95';
    if (p >= 85) return '85-90';
    if (p >= 80) return '80-85';
    if (p >= 70) return '70-80';
    if (p >= 60) return '60-70';
    return '<60';
  };

  const faixa   = _faixa(probPct);
  const cal     = calibration[market];
  if (!cal?.byRange) return null;

  const faixaData = cal.byRange[faixa];
  if (!faixaData || faixaData.total < minSamples) return null;

  const accuracy = faixaData.hits / faixaData.total;
  const eligible = accuracy >= minAccuracy;
  const pctStr   = (accuracy * 100).toFixed(1);
  const minStr   = (minAccuracy * 100).toFixed(0);

  if (!eligible) {
    console.log(`[FAIXA_GATE] ❌ ${market} faixa ${faixa}%: ${pctStr}% < ${minStr}% (${faixaData.total} amostras) → falso positivo`);
  }

  return {
    elegivel: eligible,
    mercado:  market,
    prob:     +probPct.toFixed(1),
    faixa,
    accuracy: +pctStr,
    samples:  faixaData.total,
    motivo: eligible
      ? `APROVADO — ${pctStr}% na faixa ${faixa}% (${faixaData.total} amostras)`
      : `REPROVADO — ${pctStr}% < ${minStr}% na faixa ${faixa}% para ${market} (falso positivo por superestimativa)`,
  };
}

/**
 * versão síncrona simplificada — usa tabela inline, sem tierConfig.
 * Para uso em contextos não-async. Sem escalada noturna.
 *
 * @param {string} mercado — nome do mercado
 * @param {string} liga    — nome da liga
 * @returns {number}       — gate em decimal
 */
export function obterGateVigenteSync(mercado, liga) {
  const mkt      = (mercado || '').trim();
  const ligaLow  = (liga    || '').toLowerCase();

  if (/^under/i.test(mkt) && !/corner|escanteio/i.test(mkt)) {
    return UNDER_GATE_ABSOLUTO;
  }

  // Tier 1: 80%
  const t1 = ['eredivisie','bundesliga','champions league','conference league',
               'brasileirão betano','brasileirao betano'];
  if (t1.some(l => ligaLow.includes(l))) {
    if (/corners?/i.test(mkt)) return 0.75;
    if (/btts/i.test(mkt))     return 0.78;
    return 0.80;
  }

  // Tier 2: 82%
  const t2 = ['la liga','laliga','premier league','serie a','ligue 1',
               'liga portugal','mls','brasileirão série b','brasileirao serie b'];
  if (t2.some(l => ligaLow.includes(l))) {
    if (/corners?/i.test(mkt)) return 0.78;
    if (/btts/i.test(mkt))     return 0.80;
    return 0.82;
  }

  // Default Tier 3: 84%
  if (/corners?/i.test(mkt)) return 0.80;
  if (/btts/i.test(mkt))     return 0.82;
  return 0.84;
}
