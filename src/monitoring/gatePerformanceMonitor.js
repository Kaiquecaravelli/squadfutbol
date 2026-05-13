/**
 * gatePerformanceMonitor.js — Módulo 6: Monitoramento Contínuo de Performance
 *
 * Verifica semanalmente se algum mercado ou liga está com precisão abaixo do piso.
 * Dispara alerta ao admin via Telegram quando detecta degradação.
 * Integrado ao scheduler (domingo 06:01).
 *
 * Exporta: monitorarPerformance()
 */

import { loadDB } from '../pie/pie-storage.js';
import { atualizarTiersComPIE } from '../config/tierConfig.js';

// Limiares de alerta por mercado
const ALERTAS_CONFIG = {
  'Over 1.5':         { prec_minima: 0.78, n_minimo: 20 },
  'Over 2.5':         { prec_minima: 0.74, n_minimo: 20 },
  'Over 3.5':         { prec_minima: 0.70, n_minimo: 15 },
  'BTTS':             { prec_minima: 0.72, n_minimo: 20 },
  'Over Corners 6.5': { prec_minima: 0.72, n_minimo: 15 },
  'Over Corners 7.5': { prec_minima: 0.70, n_minimo: 10 },
  'Under 2.5':        { prec_minima: 0.78, n_minimo: 10 },
};

/**
 * Executa a auditoria semanal de performance dos gates.
 * Verifica calibração global + por liga.
 * Envia Telegram ao admin se detectar degradação.
 *
 * @param {object} [opts]
 * @param {string} opts.token    — TELEGRAM_BOT_TOKEN (default: process.env)
 * @param {string} opts.adminId  — TELEGRAM_ADMIN_USER_ID (default: process.env)
 * @returns {Promise<{ alertas: object[], sugestoesTier: object }>}
 */
export async function monitorarPerformance(opts = {}) {
  const token   = opts.token   || process.env.TELEGRAM_BOT_TOKEN;
  const adminId = opts.adminId || process.env.TELEGRAM_ADMIN_USER_ID;

  console.log('[GATE_MONITOR] Iniciando auditoria semanal de performance...');

  const db    = loadDB();
  const calib = db.calibration || {};
  const alertas = [];
  const ok      = [];

  // ── Verificação global por mercado ────────────────────────────────────────
  for (const [mercado, cfg] of Object.entries(ALERTAS_CONFIG)) {
    const mc = calib[mercado];
    if (!mc || mc.total < cfg.n_minimo) continue;

    const precGlobal = mc.hits / mc.total;

    if (precGlobal < cfg.prec_minima) {
      alertas.push({
        tipo:         'mercado',
        mercado,
        liga:         null,
        precisao_real: precGlobal,
        precisao_min:  cfg.prec_minima,
        n:             mc.total,
        acao: precGlobal < 0.65 ? 'BLOQUEAR_IMEDIATAMENTE' : 'ELEVAR_GATE_2PP',
      });
    } else {
      ok.push(`${mercado}: ${(precGlobal*100).toFixed(1)}% (n=${mc.total})`);
    }

    // Verificação por liga
    if (!mc.byCompetition) continue;
    for (const [liga, dados] of Object.entries(mc.byCompetition)) {
      if (dados.total < cfg.n_minimo) continue;
      const precLiga = dados.hits / dados.total;
      if (precLiga < cfg.prec_minima) {
        alertas.push({
          tipo:          'liga',
          mercado,
          liga,
          precisao_real: precLiga,
          precisao_min:  cfg.prec_minima,
          n:             dados.total,
          acao: precLiga < 0.65 ? 'BLOQUEAR_IMEDIATAMENTE' : 'ELEVAR_GATE_2PP',
        });
      }
    }
  }

  // ── Sugestões de tier ─────────────────────────────────────────────────────
  let sugestoesTier = { promovidos: [], rebaixados: [], sugestoes: [] };
  try {
    sugestoesTier = atualizarTiersComPIE();
  } catch (e) {
    console.warn('[GATE_MONITOR] Erro ao verificar tiers:', e.message);
  }

  // ── Log ───────────────────────────────────────────────────────────────────
  if (alertas.length === 0) {
    console.log(`[GATE_MONITOR] ✅ Todos os gates dentro da performance esperada (${ok.length} mercados OK)`);
  } else {
    console.warn(`[GATE_MONITOR] ⚠️  ${alertas.length} alerta(s) de performance:`);
    for (const a of alertas) {
      const onde = a.liga ? `${a.mercado} × ${a.liga}` : a.mercado;
      console.warn(`  ${a.acao === 'BLOQUEAR_IMEDIATAMENTE' ? '🔴' : '🟡'} ${onde}: ${(a.precisao_real*100).toFixed(1)}% < ${(a.precisao_min*100).toFixed(0)}% (n=${a.n}) → ${a.acao}`);
    }
  }

  // ── Notificação Telegram ──────────────────────────────────────────────────
  if (token && adminId) {
    const msg = _buildTelegramMsg(alertas, sugestoesTier, ok);
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    adminId,
          text:       msg,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      console.log('[GATE_MONITOR] ✅ Relatório semanal de gates enviado ao admin');
    } catch (e) {
      console.error('[GATE_MONITOR] Falha ao enviar Telegram:', e.message);
    }
  }

  return { alertas, sugestoesTier };
}

function _buildTelegramMsg(alertas, tierSugest, ok) {
  const linhas = ['<b>📊 AUDITORIA SEMANAL DE GATES</b>', ''];

  if (alertas.length === 0) {
    linhas.push('✅ <b>Todos os gates OK</b>');
    linhas.push(`   ${ok.length} mercados verificados sem alertas`);
  } else {
    const criticos = alertas.filter(a => a.acao === 'BLOQUEAR_IMEDIATAMENTE');
    const atencao  = alertas.filter(a => a.acao !== 'BLOQUEAR_IMEDIATAMENTE');

    if (criticos.length > 0) {
      linhas.push('🔴 <b>CRÍTICOS — Bloquear imediatamente:</b>');
      for (const a of criticos) {
        const onde = a.liga ? `${a.mercado} × ${a.liga}` : a.mercado;
        linhas.push(`  ${onde}: ${(a.precisao_real*100).toFixed(1)}% (n=${a.n})`);
      }
      linhas.push('');
    }

    if (atencao.length > 0) {
      linhas.push('🟡 <b>Atenção — Elevar gate 2pp:</b>');
      for (const a of atencao) {
        const onde = a.liga ? `${a.mercado} × ${a.liga}` : a.mercado;
        linhas.push(`  ${onde}: ${(a.precisao_real*100).toFixed(1)}% (mín ${(a.precisao_min*100).toFixed(0)}%, n=${a.n})`);
      }
      linhas.push('');
    }
  }

  if (tierSugest.sugestoes?.length > 0) {
    linhas.push('🏆 <b>Sugestões de Tier:</b>');
    for (const s of tierSugest.sugestoes) {
      linhas.push(`  ${s.trim()}`);
    }
    linhas.push('');
  }

  linhas.push(`<i>${new Date().toLocaleString('pt-BR')} — verificação automática</i>`);
  return linhas.join('\n');
}
