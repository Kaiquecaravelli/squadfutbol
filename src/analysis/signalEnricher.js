/**
 * signalEnricher.js — Orquestrador de Análise Profunda por Sinal
 *
 * Chamado APÓS aprovação do funil pré-live.
 * Enriquece cada sinal com:
 *   - Score 8-D (deepAnalysisEngine)
 *   - Padrões especializados (specializedPatterns)
 *   - Relatório admin via DM (não altera mensagem do grupo)
 *
 * É fire-and-forget — não bloqueia o envio ao grupo.
 */

import axios from 'axios';
import { runDeepAnalysis, formatDeepScoreAdmin } from './deepAnalysisEngine.js';
import { detectPatterns, formatPatternsAdmin }   from './specializedPatterns.js';

const ADMIN_COOLDOWN_MS = 5 * 60_000; // 5 min entre relatórios do mesmo jogo
const _recentReports    = new Map();   // chave: `${match}|${mercado}`

/**
 * enrichSignalAndNotifyAdmin — roda deep analysis e envia DM ao admin.
 * Fire-and-forget: não lança exceção, nunca bloqueia o caller.
 *
 * @param {object} matchData   — matchData do sinal aprovado
 * @param {Array}  enriched    — mercados aprovados [{mercado, probabilidade, ...}]
 */
export function enrichSignalAndNotifyAdmin(matchData, enriched) {
  // Roda de forma assíncrona sem bloquear
  _run(matchData, enriched).catch(() => {});
}

async function _run(matchData, enriched) {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
  if (!token || !adminId) return;

  const quantResult = matchData?._quant ?? null;

  for (const signal of (enriched || [])) {
    const mercado = signal.mercado || signal.market || '';
    const match   = matchData.match || `${matchData.home_team} vs ${matchData.away_team}`;
    const coolKey = `${match}|${mercado}`;

    // Dedup
    const last = _recentReports.get(coolKey) || 0;
    if (Date.now() - last < ADMIN_COOLDOWN_MS) continue;
    _recentReports.set(coolKey, Date.now());

    try {
      // ── Análise profunda ──────────────────────────────────────────────────
      const deep     = runDeepAnalysis(matchData, mercado, quantResult);
      const patterns = detectPatterns(matchData, deep);

      // ── Monta relatório admin ─────────────────────────────────────────────
      const flagAnt  = matchData.flag_antecipado ? '\n⏰ <b>Sinal Antecipado (+24H)</b>\n' : '';
      const probStr  = signal.probabilidade != null ? ` · prob <code>${signal.probabilidade}%</code>` : '';
      const confStr  = signal.confianca     != null ? ` · conf <code>${signal.confianca}%</code>`     : '';

      const header = [
        `📊 <b>[RELATÓRIO ADMIN — ANÁLISE PROFUNDA]</b>`,
        `🏟️ <b>${match}</b>`,
        `🎯 <b>${mercado}</b>${probStr}${confStr}`,
        flagAnt,
      ].filter(Boolean).join('\n');

      const deepReport    = formatDeepScoreAdmin(deep, match, mercado);
      const patternReport = patterns.length ? formatPatternsAdmin(patterns) : '';

      const gateNote = deep.gate_ajuste > 0
        ? `\n⚠️ <i>Gate ajustado +${deep.gate_ajuste}pp para tier ${deep.tier}</i>`
        : '';

      const fullText = [
        header,
        '',
        deepReport,
        patternReport ? '' : null,
        patternReport,
        gateNote,
      ].filter(s => s != null).join('\n');

      // ── Envia ao admin ────────────────────────────────────────────────────
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id:                  adminId,
        text:                     fullText,
        parse_mode:               'HTML',
        disable_web_page_preview: true,
      });

    } catch { /* falha silenciosa — não impacta grupo */ }
  }
}

/**
 * applyGateAdjustment — ajusta threshold mínimo baseado no tier do deepResult.
 * Chamado ANTES de aprovar o sinal, para filtrar BRONZE com gate elevado.
 *
 * @param {object} deepResult    — resultado do runDeepAnalysis()
 * @param {number} baseThreshold — threshold padrão (ex: 70)
 * @returns {number}             — threshold ajustado
 */
export function applyGateAdjustment(deepResult, baseThreshold) {
  if (!deepResult) return baseThreshold;
  return baseThreshold + (deepResult.gate_ajuste || 0);
}
