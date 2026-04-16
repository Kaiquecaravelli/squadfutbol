/**
 * signal-formatter.js — Protocolo de Identidade Visual v1.0.0
 *
 * FONTE ÚNICA DE VERDADE para toda formatação de mensagens ao grupo.
 * Qualquer pipeline que emite sinal ao grupo DEVE passar por aqui.
 * Nenhuma formatação inline em pipelines — toda lógica visual fica aqui.
 *
 * Módulos implementados (spec 10-módulos):
 *   M1  — Elementos obrigatórios em todo sinal
 *   M2  — Emojis fixos · espaçamento · tipografia (HTML)
 *   M3  — Template pré-live: mercado único (BTTS · Goals · Corners)
 *   M4  — Template SUPER ODDS (3–5 seleções)
 *   M5  — Template resultado pós-jogo (individual e SUPER ODD)
 *   M6  — Contagem regressiva dinâmica (calculada no momento do envio)
 *   M7  — Resolução e validação do link da partida
 *   M8  — Validador de padrão (bloqueia envio se estrutura inválida)
 *   M9  — Casos especiais: cancelamento · correção · escalação alterada
 *
 * Exporta:
 *   formatPreLiveSignal(matchData, agentResult)    → string HTML | null
 *   formatSuperOddsSignal(combo)                   → string HTML | null
 *   formatResultadoSignal(opts)                    → string HTML
 *   formatResultadoSuperOdds(combo, resultados)    → string HTML
 *   formatCancelamento(matchData)                  → string HTML
 *   formatCorrecao(matchData, antes, depois)       → string HTML
 *   calcularContagemRegressiva(timestampMs)        → string
 *   resolverLink(matchData)                        → Promise<string|null>
 *   validarMensagem(html, tipo)                    → { ok, erros }
 *   EMOJI                                          → object (emojis fixos)
 *   SEP                                            → string (separador ════)
 */

import axios from 'axios';

// ── M2 · Emojis fixos por tipo (imutáveis) ────────────────────────────────────
export const EMOJI = Object.freeze({
  BTTS:        '🎯',
  GOLS:        '⚽',
  CORNERS:     '🚩',
  SUPER:       '🔥',
  VERDE:       '✅',
  VERMELHO:    '❌',
  TIMER:       '⏱',
  DATA:        '📅',
  LINK:        '🔗',
  AVISO:       '⚠️',
  CORRECAO:    '🔄',
});

// ── M2 · Separadores (imutáveis) ─────────────────────────────────────────────
export const SEP  = '════════════════════════════════════';  // separador principal
const SEP_INT     = '—';                                     // separador interno (bloco)

// ── M2 · Emoji de mercado por tipo ────────────────────────────────────────────
/**
 * Retorna o emoji fixo para o tipo de mercado.
 * Regra: BTTS=🎯 · Corners=🚩 · qualquer gol=⚽
 */
export function emojiDeMercado(mercado = '') {
  const m = mercado.toUpperCase();
  if (m.includes('BTTS') || m.includes('AMBAS') || m.includes('MARCAM')) return EMOJI.BTTS;
  if (m.includes('CORNER') || m.includes('ESCANTEIO'))                    return EMOJI.CORNERS;
  return EMOJI.GOLS;
}

// ── M2 · Nome do mercado para o cabeçalho (CAIXA ALTA) ───────────────────────
/**
 * Converte o campo `mercado` do agente para o nome de cabeçalho padronizado.
 * Ex: "Over 2.5" → "OVER 2.5 GOLS"
 *     "Over Corners 6.5" → "ESCANTEIOS OVER 6.5"
 *     "BTTS" → "AMBAS MARCAM"
 */
export function nomeCabecalhoMercado(mercado = '') {
  const m = mercado.toUpperCase().trim();
  if (m.includes('BTTS') || m.includes('AMBAS') || m.includes('MARCAM'))
    return 'AMBAS MARCAM';
  if (m.includes('CORNER') || m.includes('ESCANTEIO')) {
    const num = mercado.match(/\d+\.?\d*/)?.[0];
    return num ? `ESCANTEIOS OVER ${num}` : 'ESCANTEIOS';
  }
  if (m.includes('OVER') || m.includes('MAIS DE')) {
    const num = mercado.match(/\d+\.?\d*/)?.[0];
    return num ? `OVER ${num} GOLS` : 'OVER GOLS';
  }
  if (m.includes('UNDER') || m.includes('MENOS DE')) {
    const num = mercado.match(/\d+\.?\d*/)?.[0];
    return num ? `UNDER ${num} GOLS` : 'UNDER GOLS';
  }
  return m;
}

// ── M2 · Descrição por extenso do mercado (para o campo "Mercado:") ───────────
/**
 * Converte o campo `mercado` para descrição por extenso.
 * Ex: "Over 2.5" → "Mais de 2.5 gols na partida"
 *     "BTTS"     → "Ambas as equipes marcam — Sim"
 *     "Over Corners 6.5" → "Mais de 6.5 escanteios na partida"
 */
export function descricaoMercado(mercado = '') {
  const m = mercado.toUpperCase().trim();
  const num = mercado.match(/\d+\.?\d*/)?.[0];

  if (m.includes('BTTS') || m.includes('AMBAS') || m.includes('MARCAM'))
    return 'Ambas as equipes marcam — Sim';

  if (m.includes('CORNER') || m.includes('ESCANTEIO')) {
    return num
      ? `Mais de ${num} escanteios na partida`
      : 'Over Escanteios';
  }

  if (m.includes('OVER') || m.includes('MAIS DE')) {
    return num
      ? `Mais de ${num} gols na partida`
      : 'Over Gols';
  }

  if (m.includes('UNDER') || m.includes('MENOS DE')) {
    return num
      ? `Menos de ${num} gols na partida`
      : 'Under Gols';
  }

  return mercado; // fallback: retorna o original sem alteração
}

// ── M6 · Contagem regressiva dinâmica ─────────────────────────────────────────
/**
 * Calcula a contagem regressiva no momento exato da chamada.
 * Nunca estimada — sempre calculada com Date.now().
 *
 * @param {number} timestampMs — timestamp do jogo em MILISSEGUNDOS
 *   Se o valor parecer ser unix seconds (< 1e12), converte automaticamente.
 * @returns {string} texto formatado conforme M6.1
 */
export function calcularContagemRegressiva(timestampMs) {
  // Auto-detecção: se parece ser unix seconds, converte para ms
  const tsMs = timestampMs < 1e12 ? timestampMs * 1000 : timestampMs;

  const agora    = Date.now();
  const deltaMs  = tsMs - agora;
  const deltaMin = Math.floor(deltaMs / 60_000);
  const horas    = Math.floor(deltaMin / 60);
  const minutos  = deltaMin % 60;

  if (deltaMin >= 120) return `${horas} horas e ${minutos} min`;
  if (deltaMin >= 60)  return `1 hora e ${minutos} min`;
  if (deltaMin >= 10)  return `${deltaMin} min`;
  if (deltaMin > 0)    return `menos de 10 min`;
  return `INICIANDO AGORA`;
}

// ── M6 · Resolução de timestamp da partida ────────────────────────────────────
/**
 * Extrai o timestamp (ms) do matchData, tentando múltiplos campos.
 * @param {object} matchData
 * @returns {number|null} timestamp em ms, ou null se indisponível
 */
function _resolveTimestampMs(matchData) {
  if (matchData.start_timestamp) {
    const ts = matchData.start_timestamp;
    return ts < 1e12 ? ts * 1000 : ts;
  }
  if (matchData.startTimestamp) {
    const ts = matchData.startTimestamp;
    return ts < 1e12 ? ts * 1000 : ts;
  }
  if (matchData.date) {
    const d = new Date(matchData.date);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}

// ── M6 · Formatação de data e hora ────────────────────────────────────────────
function _formatarData(tsMs) {
  const d = new Date(tsMs);
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function _formatarHora(tsMs) {
  return new Date(tsMs).toLocaleTimeString('pt-BR', {
    hour:     '2-digit',
    minute:   '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
}

// ── M7 · Resolução e validação de link ────────────────────────────────────────
/**
 * Resolve o melhor link disponível para a partida.
 * Hierarquia: SofaScore → Flashscore → 365score
 * Valida se o link responde (HEAD com timeout 4s).
 *
 * @param {object} matchData
 * @returns {Promise<string|null>} URL válida ou null se nenhuma disponível
 */
export async function resolverLink(matchData) {
  const candidatos = _coletarCandidatosLink(matchData);
  if (candidatos.length === 0) return null;

  for (const url of candidatos) {
    if (!url || typeof url !== 'string') continue;
    const ok = await _validarLinkHttp(url);
    if (ok) return url;
  }
  return null;
}

/**
 * Coleta URLs candidatas na ordem de hierarquia (M7.1).
 */
function _coletarCandidatosLink(matchData) {
  const candidatos = [];

  // SofaScore (1º)
  const ssUrl = matchData.sofascore_url || matchData.sofascoreUrl;
  if (ssUrl) candidatos.push(ssUrl);
  // Construído via slug + id
  if (matchData.slug && matchData.sofascore_id) {
    candidatos.push(`https://www.sofascore.com/${matchData.slug}/${matchData.sofascore_id}`);
  }

  // Flashscore (2º)
  const fsUrl = matchData.flashscore_url || matchData.flashscoreUrl;
  if (fsUrl) candidatos.push(fsUrl);

  // 365score (3º)
  const _365 = matchData['365score_url'] || matchData.score365Url;
  if (_365) candidatos.push(_365);

  return candidatos;
}

/**
 * Valida se o link responde HTTP 2xx/3xx com timeout 4s.
 * Falha silenciosa: se timeout ou erro de rede → retorna false (tenta próximo).
 */
async function _validarLinkHttp(url) {
  try {
    const res = await axios.head(url, {
      timeout: 4_000,
      validateStatus: s => s < 500,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

// ── M3 · Template pré-live: mercado único ─────────────────────────────────────
/**
 * Formata um sinal pré-live conforme template M3.
 * Um sinal = um mercado. Chamar uma vez por mercado aprovado.
 *
 * @param {object} matchData   — dados da partida
 * @param {object} agentResult — saída do agente (mercado, confianca, odd, etc.)
 * @param {object} opts
 * @param {string} [opts.linkOverride] — link já resolvido (evita fetch extra)
 * @returns {string|null} HTML pronto para envio, ou null se campo obrigatório ausente
 */
export function formatPreLiveSignal(matchData, agentResult, opts = {}) {
  // ── Extrair campos obrigatórios ──────────────────────────────────────────────
  const tsMs      = _resolveTimestampMs(matchData);
  const link      = opts.linkOverride || matchData.sofascore_url || matchData.sofascoreUrl || matchData.flashscore_url || null;
  const mercado   = agentResult.mercado || agentResult.market || '';
  const odd       = agentResult.odd     || agentResult.odds_minima || 0;

  // M6.3 — Validação de timestamp
  if (!tsMs) return null;          // sem data/hora → sinal retido
  if (tsMs < Date.now() - 5 * 60_000) return null; // jogo já passou (tolerância 5min)

  // M7 — Link obrigatório (validação síncrona de presença)
  if (!link) return null;          // sem link → sinal retido

  // ── Dados derivados ───────────────────────────────────────────────────────────
  const [homeRaw, awayRaw] = (matchData.match || matchData.match_name || ' vs ').split(' vs ');
  const home   = (homeRaw  || matchData.home_team  || '').trim();
  const away   = (awayRaw  || matchData.away_team  || '').trim();
  const liga   = matchData.competition || matchData.league || '';
  const data   = _formatarData(tsMs);
  const hora   = _formatarHora(tsMs);
  const contag = calcularContagemRegressiva(tsMs);
  const emoji  = emojiDeMercado(mercado);
  const header = nomeCabecalhoMercado(mercado);
  const descr  = descricaoMercado(mercado);
  const oddFmt = typeof odd === 'number' ? odd.toFixed(2) : String(odd);

  // ── Montagem do template M3 ───────────────────────────────────────────────────
  return [
    SEP,
    `${emoji} <b>${header}  ·  ${_esc(liga)}</b>`,
    ``,
    `<b>${_esc(home)}</b> vs <b>${_esc(away)}</b>`,
    ``,
    `${EMOJI.DATA} <code>${data}  ·  ${hora}  (Brasília)</code>`,
    `${EMOJI.TIMER} <code>${contag}</code> para o início`,
    ``,
    SEP_INT,
    `Mercado: <b>${_esc(descr)}</b>`,
    `Odd: <code>${oddFmt}</code>`,
    SEP_INT,
    ``,
    `${EMOJI.LINK} ${link}`,
    SEP,
  ].join('\n');
}

// ── M4 · Template SUPER ODDS ──────────────────────────────────────────────────
/**
 * Formata uma mensagem SUPER ODDS conforme template M4.
 * Cada seleção tem seu bloco individual idêntico ao template M3 (sem separador externo).
 *
 * @param {object} combo — saída de buildCombination() do super-odds-engine.js
 * @param {object} opts
 * @param {Map<string,string>} [opts.links] — map match_name → link resolvido
 * @returns {string|null} HTML pronto para envio, ou null se inválido
 */
export function formatSuperOddsSignal(combo, opts = {}) {
  if (!combo?.selections?.length) return null;

  const { selections, odd_acumulada } = combo;
  const hoje  = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const oddAc = (odd_acumulada || 0).toFixed(2);

  const linhas = [
    SEP,
    `${EMOJI.SUPER} <b>SUPER ODD  ·  ${selections.length} SELEÇÕES  ·  ${hoje}</b>`,
    ``,
    `<b>Odd total: <code>${oddAc}x</code></b>`,
    ``,
  ];

  for (let i = 0; i < selections.length; i++) {
    const s   = selections[i];
    const r   = s.agentResult || {};
    const m   = s.matchData   || {};
    const tsMs = _resolveTimestampMs(m);

    // Link resolvido: prioridade ao mapa injetado → fallback nos campos do matchData
    const link = opts.links?.get(s.match_name)
      || r.sofascore_url || m.sofascore_url || m.sofascoreUrl
      || r.flashscore_url || m.flashscore_url
      || null;

    const mercado   = s.mercado || r.mercado || r.market || '';
    const odd       = s.odd || r.odd || r.odds_minima || 0;
    const oddFmt    = typeof odd === 'number' ? odd.toFixed(2) : String(odd);
    const liga      = m.competition || m.league || s.liga || '';
    const [homeRaw, awayRaw] = (m.match || m.match_name || s.match_name || ' vs ').split(' vs ');
    const home      = (homeRaw || m.home_team || '').trim();
    const away      = (awayRaw || m.away_team || '').trim();
    const emoji     = emojiDeMercado(mercado);
    const header    = nomeCabecalhoMercado(mercado);
    const descr     = descricaoMercado(mercado);

    const dataStr   = tsMs ? _formatarData(tsMs) : '—';
    const horaStr   = tsMs ? _formatarHora(tsMs) : '—';
    const contag    = tsMs ? calcularContagemRegressiva(tsMs) : '—';

    linhas.push(SEP);
    linhas.push(`<b>— Seleção ${i + 1} —</b>`);
    linhas.push(``);
    linhas.push(`${emoji} <b>${_esc(header)}</b>`);
    linhas.push(`<b>${_esc(home)}</b> vs <b>${_esc(away)}</b>`);
    linhas.push(`<i>${_esc(liga)}</i>`);
    linhas.push(``);
    linhas.push(`${EMOJI.DATA} <code>${dataStr}  ·  ${horaStr}  (Brasília)</code>`);
    linhas.push(`${EMOJI.TIMER} <code>${contag}</code> para o início`);
    linhas.push(``);
    linhas.push(`Mercado: <b>${_esc(descr)}</b>`);
    linhas.push(`Odd: <code>${oddFmt}</code>`);
    linhas.push(``);
    if (link) {
      linhas.push(`${EMOJI.LINK} ${link}`);
    }
    linhas.push(``);
  }

  linhas.push(SEP);
  linhas.push(`${EMOJI.SUPER} <b>Odd acumulada: <code>${oddAc}x</code></b>`);
  linhas.push(SEP);

  return linhas.join('\n');
}

// ── M5.1 · Template resultado: sinal individual ───────────────────────────────
/**
 * Formata mensagem de resultado pós-jogo para sinal individual.
 *
 * @param {object} opts
 * @param {boolean} opts.acertou           — true = verde, false = vermelho
 * @param {object}  opts.matchData
 * @param {object}  opts.agentResult
 * @param {string}  opts.placar            — ex: "2-1"
 * @param {string}  opts.descricaoResultado — ex: "3 gols na partida"
 * @param {string}  [opts.link]
 * @returns {string} HTML
 */
export function formatResultadoSignal({ acertou, matchData, agentResult, placar, descricaoResultado, link }) {
  const r      = agentResult || {};
  const m      = matchData   || {};
  const tsMs   = _resolveTimestampMs(m);
  const [homeRaw, awayRaw] = (m.match || m.match_name || ' vs ').split(' vs ');
  const home   = (homeRaw || m.home_team || '').trim();
  const away   = (awayRaw || m.away_team || '').trim();
  const liga   = m.competition || m.league || '';
  const mercado = r.mercado || r.market || '';
  const descr   = descricaoMercado(mercado);
  const odd     = r.odd || r.odds_minima || 0;
  const oddFmt  = typeof odd === 'number' ? odd.toFixed(2) : String(odd);
  const emoji   = emojiDeMercado(mercado);
  const data    = tsMs ? _formatarData(tsMs) : '—';
  const hora    = tsMs ? _formatarHora(tsMs) : '—';
  const iconRes = acertou ? EMOJI.VERDE : EMOJI.VERMELHO;
  const label   = acertou ? 'VERDE' : 'VERMELHO';

  return [
    SEP,
    `${iconRes} <b>RESULTADO  ·  ${label}</b>`,
    ``,
    `${emoji} <b>${_esc(nomeCabecalhoMercado(mercado))}  ·  ${_esc(liga)}</b>`,
    `<b>${_esc(home)}</b> <code>${placar || ''}</code> <b>${_esc(away)}</b>`,
    ``,
    `${EMOJI.DATA} <code>${data}  ·  ${hora}  (Brasília)</code>`,
    ``,
    SEP_INT,
    `Mercado: <b>${_esc(descr)}</b>`,
    `Odd: <code>${oddFmt}</code>`,
    `Resultado: <b>${_esc(descricaoResultado || '')}</b>`,
    SEP_INT,
    ``,
    link ? `${EMOJI.LINK} ${link}` : '',
    SEP,
  ].filter(l => l !== '').join('\n');
}

// ── M5.2 · Template resultado: SUPER ODD ─────────────────────────────────────
/**
 * Formata mensagem de resultado de SUPER ODD.
 *
 * @param {object}  combo      — combinação original (com selections)
 * @param {Array}   resultados — [{ idx, acertou }] — resultado de cada seleção
 * @returns {string} HTML
 */
export function formatResultadoSuperOdds(combo, resultados) {
  const { selections, odd_acumulada } = combo || {};
  const hoje   = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const oddAc  = (odd_acumulada || 0).toFixed(2);
  const todasVerde = resultados.every(r => r.acertou);
  const iconFinal  = todasVerde ? EMOJI.VERDE : EMOJI.VERMELHO;
  const labelFinal = todasVerde ? 'VERDE TOTAL' : 'VERMELHO';

  const linhas = [
    SEP,
    `${iconFinal} <b>RESULTADO SUPER ODD  ·  ${hoje}</b>`,
    ``,
  ];

  (selections || []).forEach((s, i) => {
    const res    = resultados.find(r => r.idx === i) || resultados[i] || {};
    const m      = s.matchData   || {};
    const r      = s.agentResult || {};
    const mercado = s.mercado || r.mercado || r.market || '';
    const emoji   = emojiDeMercado(mercado);
    const [homeRaw, awayRaw] = (m.match || s.match_name || ' vs ').split(' vs ');
    const home   = (homeRaw || '').trim();
    const away   = (awayRaw || '').trim();
    const icon   = res.acertou ? EMOJI.VERDE : EMOJI.VERMELHO;

    linhas.push(`Sel. ${i + 1}: ${emoji} <b>${_esc(nomeCabecalhoMercado(mercado))}</b> — ${_esc(home)} vs ${_esc(away)} · ${icon} ${res.acertou ? 'VERDE' : 'VERMELHO'}`);
  });

  linhas.push(``, SEP_INT);
  linhas.push(`<b>Odd acumulada: <code>${oddAc}x</code></b>`);
  linhas.push(`<b>Resultado final: ${labelFinal}</b>`);
  linhas.push(SEP_INT);
  linhas.push(SEP);

  return linhas.join('\n');
}

// ── M9.1 · Sinal cancelado (jogo adiado/cancelado) ───────────────────────────
/**
 * Formata aviso de cancelamento de sinal por adiamento/cancelamento do jogo.
 *
 * @param {object} matchData
 * @param {string} [motivo] — motivo opcional além do padrão
 * @returns {string} HTML
 */
export function formatCancelamento(matchData, motivo = 'partida adiada / cancelada') {
  const m    = matchData || {};
  const tsMs = _resolveTimestampMs(m);
  const [homeRaw, awayRaw] = (m.match || m.match_name || ' vs ').split(' vs ');
  const home  = (homeRaw || m.home_team || '').trim();
  const away  = (awayRaw || m.away_team || '').trim();
  const liga  = m.competition || m.league || '';
  const data  = tsMs ? _formatarData(tsMs) : '—';
  const hora  = tsMs ? _formatarHora(tsMs) : '—';
  const link  = m.sofascore_url || m.sofascoreUrl || m.flashscore_url || null;

  return [
    SEP,
    `${EMOJI.AVISO} <b>SINAL CANCELADO  ·  ${_esc(liga)}</b>`,
    ``,
    `<b>${_esc(home)}</b> vs <b>${_esc(away)}</b>`,
    `<i>Motivo: ${_esc(motivo)}</i>`,
    ``,
    `${EMOJI.DATA} Data original: <code>${data}  ·  ${hora}</code>`,
    ``,
    link ? `${EMOJI.LINK} ${link}` : '',
    SEP,
  ].filter(l => l !== '').join('\n');
}

// ── M9.2 · Correção de sinal ──────────────────────────────────────────────────
/**
 * Formata mensagem de correção de dado incorreto em sinal enviado.
 *
 * @param {object} matchData
 * @param {string} antes  — dado antes da correção (ex: "@1.80")
 * @param {string} depois — dado depois da correção (ex: "@1.75")
 * @returns {string} HTML
 */
export function formatCorrecao(matchData, antes, depois) {
  const m    = matchData || {};
  const tsMs = _resolveTimestampMs(m);
  const [homeRaw, awayRaw] = (m.match || m.match_name || ' vs ').split(' vs ');
  const home   = (homeRaw || m.home_team || '').trim();
  const away   = (awayRaw || m.away_team || '').trim();
  const liga   = m.competition || m.league || '';
  const data   = tsMs ? _formatarData(tsMs) : '—';
  const hora   = tsMs ? _formatarHora(tsMs) : '—';
  const contag = tsMs ? calcularContagemRegressiva(tsMs) : '—';
  const link   = m.sofascore_url || m.sofascoreUrl || m.flashscore_url || null;

  return [
    SEP,
    `${EMOJI.CORRECAO} <b>CORREÇÃO DE SINAL  ·  ${_esc(liga)}</b>`,
    ``,
    `<b>${_esc(home)}</b> vs <b>${_esc(away)}</b>`,
    ``,
    `Informação corrigida:`,
    `<i>Antes:</i> <code>${_esc(antes)}</code>`,
    `<i>Depois:</i> <code>${_esc(depois)}</code>`,
    ``,
    `${EMOJI.DATA} <code>${data}  ·  ${hora}  (Brasília)</code>`,
    `${EMOJI.TIMER} <code>${contag}</code> para o início`,
    ``,
    link ? `${EMOJI.LINK} ${link}` : '',
    SEP,
  ].filter(l => l !== '').join('\n');
}

// ── M8 · Validador de padrão ──────────────────────────────────────────────────
/**
 * Valida que a mensagem está conforme o template antes do envio.
 * Uma falha em qualquer check bloqueia o envio.
 *
 * @param {string} html  — mensagem HTML gerada
 * @param {'PRELIVE'|'SUPER_ODD'|'RESULTADO'|'CANCELAMENTO'|'CORRECAO'} tipo
 * @returns {{ ok: boolean, erros: string[] }}
 */
export function validarMensagem(html, tipo) {
  if (!html || typeof html !== 'string') {
    return { ok: false, erros: ['Mensagem nula ou não-string'] };
  }

  const erros = [];

  // Checks universais (M1)
  if (!html.includes(SEP))          erros.push('Separador ════ ausente');
  if (!html.includes(EMOJI.DATA))   erros.push('Emoji 📅 (data/hora) ausente');
  if (!html.includes(EMOJI.LINK))   erros.push(`Emoji ${EMOJI.LINK} (link) ausente`);
  if (!html.includes('Odd:'))        erros.push('Campo "Odd:" ausente');
  if (!html.includes('(Brasília)'))  erros.push('Fuso horário "(Brasília)" ausente');

  // Pré-live e SUPER ODD exigem contagem regressiva (M6)
  if (['PRELIVE', 'SUPER_ODD'].includes(tipo)) {
    if (!html.includes(EMOJI.TIMER)) erros.push(`Emoji ${EMOJI.TIMER} (contagem regressiva) ausente`);
    if (!html.includes('para o início') && !html.includes('INICIANDO AGORA'))
      erros.push('Texto da contagem regressiva ausente');
  }

  // SUPER ODD: checks adicionais (M4)
  if (tipo === 'SUPER_ODD') {
    if (!html.includes('Odd acumulada'))
      erros.push('Odd acumulada ausente');
    if (!html.includes('Seleção 1') && !html.includes('— Seleção 1 —'))
      erros.push('Bloco "Seleção 1" ausente');
    if (!html.includes('SUPER ODD'))
      erros.push('Cabeçalho "SUPER ODD" ausente');
  }

  // Resultado: sem contagem regressiva
  if (tipo === 'RESULTADO') {
    if (!html.includes('RESULTADO'))  erros.push('Cabeçalho "RESULTADO" ausente');
    if (!html.includes('VERDE') && !html.includes('VERMELHO'))
      erros.push('Indicador verde/vermelho ausente');
  }

  return { ok: erros.length === 0, erros };
}

// ── Helpers internos ──────────────────────────────────────────────────────────
/** Escapa caracteres HTML especiais para evitar quebras de parse. */
function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default {
  EMOJI, SEP,
  emojiDeMercado,
  nomeCabecalhoMercado,
  descricaoMercado,
  calcularContagemRegressiva,
  resolverLink,
  formatPreLiveSignal,
  formatSuperOddsSignal,
  formatResultadoSignal,
  formatResultadoSuperOdds,
  formatCancelamento,
  formatCorrecao,
  validarMensagem,
};
