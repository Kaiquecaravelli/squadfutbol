/**
 * idleDetector.js — Detector de Janela Ociosa
 *
 * Determina se o sistema está ocioso e disponível para treinamento.
 * O sistema é considerado ocioso quando:
 *   → Nenhum jogo nas próximas 2h na grade do radar
 *   → Nenhum sinal pendente urgente (iniciado há 95–180 min)
 *   → Scanner não está em execução ativa (informado pelo caller)
 *   → Período de madrugada (00:00–03:59) — janela de treino garantida
 *
 * Filosofia: um sniper não espera o alvo para praticar.
 * Todo período sem jogo ativo é uma oportunidade de evolução.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname }            from 'path';
import { fileURLToPath }            from 'url';

const ROOT         = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PENDING_PATH = join(ROOT, 'data', 'pending-analyses.json');
const RADAR_PATH   = join(ROOT, 'data', 'radar-today.json');

// Threshold: jogo nas próximas 2h = sistema ativo
const IDLE_THRESHOLD_MIN = 120;

// Período pré-operacional: 04:00–05:59 (cache Superbet aquecendo — não treinar)
const PRE_OP_START = 4;
const PRE_OP_END   = 6;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _loadPending() {
  try {
    const raw = JSON.parse(readFileSync(PENDING_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw : Object.values(raw);
  } catch {
    return [];
  }
}

function _loadRadar() {
  try {
    if (!existsSync(RADAR_PATH)) return [];
    const raw = JSON.parse(readFileSync(RADAR_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw : (raw.top_games || []);
  } catch {
    return [];
  }
}

// ── Detector principal ────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {boolean} [opts.scanRunning=false]  - indica se o scanner está ativo no momento
 * @returns {{ isIdle: boolean, janela: string, reason: string }}
 */
export function isSystemIdle(opts = {}) {
  const { scanRunning = false } = opts;
  const agora = Date.now();
  const hora  = new Date().getHours();

  // 1. Scanner ativo → não treinar
  if (scanRunning) {
    return { isIdle: false, janela: getJanelaAtual(), reason: 'scanner em execução' };
  }

  // 2. Período pré-operacional (04:00–05:59) — cache Superbet aquecendo
  if (hora >= PRE_OP_START && hora < PRE_OP_END) {
    return { isIdle: false, janela: 'PRE_OP', reason: 'período pré-operacional (04h–06h)' };
  }

  // 3. Madrugada (00:00–03:59) — janela de treino garantida, sem verificações extras
  if (hora >= 0 && hora < PRE_OP_START) {
    return { isIdle: true, janela: 'MADRUGADA', reason: 'madrugada — janela de treino garantida' };
  }

  // 4. Horário ativo (06:00–23:59) — verificar jogos e pendentes urgentes

  // 4a. Jogos nas próximas 2h no radar
  const radar      = _loadRadar();
  const jogosProximos = radar.filter(j => {
    if (!j.kickoff) return false;
    const minParaInicio = (j.kickoff - agora) / 60_000;
    return minParaInicio > 0 && minParaInicio <= IDLE_THRESHOLD_MIN;
  });

  if (jogosProximos.length > 0) {
    return {
      isIdle: false,
      janela: getJanelaAtual(),
      reason: `${jogosProximos.length} jogo(s) nas próximas 2h (${jogosProximos.map(j => j.match?.split(' vs ')[0] || '?').join(', ')})`,
    };
  }

  // 4b. Sinais pendentes urgentes (jogo iniciado 95–180 min atrás)
  const pendentes = _loadPending();
  const urgentes  = pendentes.filter(p => {
    if (p.status && p.status !== 'pending') return false;
    if (!p.sentAt) return false;
    const minPassados = (agora - new Date(p.sentAt).getTime()) / 60_000;
    return minPassados >= 95 && minPassados <= 180;
  });

  if (urgentes.length > 0) {
    return {
      isIdle: false,
      janela: getJanelaAtual(),
      reason: `${urgentes.length} resultado(s) urgente(s) aguardando verificação`,
    };
  }

  // 5. Nenhuma condição de bloqueio → sistema ocioso
  return {
    isIdle: true,
    janela: getJanelaAtual(),
    reason: 'sem jogos próximos e sem pendentes urgentes',
  };
}

/**
 * Retorna a janela de tempo atual.
 * @returns {'MADRUGADA'|'PRE_OP'|'MANHA'|'TARDE'|'NOITE'}
 */
export function getJanelaAtual() {
  const hora = new Date().getHours();
  if (hora >= 0  && hora < 4)  return 'MADRUGADA';
  if (hora >= 4  && hora < 6)  return 'PRE_OP';
  if (hora >= 6  && hora < 12) return 'MANHA';
  if (hora >= 12 && hora < 18) return 'TARDE';
  return 'NOITE';
}
