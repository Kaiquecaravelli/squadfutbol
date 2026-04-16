/**
 * cycle-check.js — Camada 1: Check Binário (Módulo 1.1)
 *
 * Executado no início de todo ciclo de 15 minutos.
 * Responde: devemos rodar o scan completo agora?
 *
 * Budget: ~50 tokens (leitura de JSON local · zero chamadas externas)
 *
 * Critérios de disparo (qualquer SIM → rodar scan):
 *   C1 — Contador diário abaixo de 3 análises
 *   C2 — Horário de alerta (12h · 15h · 18h · 20h · 21h · 22h)
 *   C3 — Algum jogo mapeado entra na janela PRÓXIMO ou +1H agora
 *   C4 — Cache do Superbet foi atualizado desde o último scan
 *   C5 — Há jogo com variação de odds > 5% no histórico do monitor
 *
 * SE todos NÃO → retorna { shouldScan: false } → ciclo encerra.
 * Custo real: apenas leitura de 2 arquivos JSON.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDailyStatus } from './daily-counter.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const STATE_FILE  = join(__dirname, '../data/prelive-monitor-state.json');
const CACHE_FILE  = join(__dirname, '../data/superbet-url-cache.json');
const CYCLE_STATE = join(__dirname, '../data/cycle-check-state.json');

// Horas que sempre disparam scan independente dos outros checks
const ALERT_HOURS = new Set([12, 15, 18, 20, 21, 22]);

// ── Helpers ────────────────────────────────────────────────────────────────────

function readJSON(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

// ── Checks individuais (todos síncronos — sem I/O externo) ────────────────────

/** C1: contador diário abaixo da meta (≥ 3) */
function checkC1() {
  const { total, target } = getDailyStatus();
  if (total < target) return { trigger: true, reason: `C1: contador ${total}/${target}` };
  return { trigger: false };
}

/** C2: horário de alerta programado */
function checkC2() {
  const hour = new Date().getHours();
  if (ALERT_HOURS.has(hour)) return { trigger: true, reason: `C2: horário de alerta ${hour}h` };
  return { trigger: false };
}

/** C3: jogo mapeado entrando em PRÓXIMO ou +1H nos próximos 15 min */
function checkC3() {
  const state = readJSON(STATE_FILE);
  if (!state?.known_games) return { trigger: false };

  const now  = Date.now();
  const in75 = now + 75 * 60_000; // próximos 75 min → cobre ciclo de 15 min com margem

  for (const game of Object.values(state.known_games)) {
    const kickoff = game.kickoff_ts;
    if (!kickoff) continue;
    if (kickoff > now && kickoff <= in75) {
      const minLeft = Math.round((kickoff - now) / 60_000);
      return { trigger: true, reason: `C3: "${game.match || 'jogo'}" em ${minLeft} min` };
    }
  }
  return { trigger: false };
}

/** C4: cache do Superbet atualizado desde o último scan registrado */
function checkC4() {
  const cache     = readJSON(CACHE_FILE);
  const lastState = readJSON(CYCLE_STATE);
  const cacheTs   = cache?.prelive?.refreshed_at || 0;
  const lastTs    = lastState?.lastScanTs || 0;

  if (cacheTs > lastTs) {
    const ageMin = Math.round((Date.now() - cacheTs) / 60_000);
    return { trigger: true, reason: `C4: cache Superbet atualizado há ${ageMin} min` };
  }
  return { trigger: false };
}

/** C5: odds com variação > 5% no histórico do monitor */
function checkC5() {
  const state = readJSON(STATE_FILE);
  if (!state?.odds_history) return { trigger: false };

  for (const [key, hist] of Object.entries(state.odds_history)) {
    if (!hist.last_odd || !hist.prev_odd) continue;
    const varPct = Math.abs((hist.last_odd - hist.prev_odd) / hist.prev_odd) * 100;
    if (varPct > 5) {
      return { trigger: true, reason: `C5: var ${varPct.toFixed(1)}% em ${key}` };
    }
  }
  return { trigger: false };
}

// ── Ponto de entrada principal ─────────────────────────────────────────────────

/**
 * Executa os 5 checks da Camada 1.
 * @returns {{ shouldScan: boolean, reason: string, triggers: string[] }}
 */
export function layerOneCheck() {
  const checks = [checkC1, checkC2, checkC3, checkC4, checkC5];
  const triggers = [];

  for (const check of checks) {
    try {
      const result = check();
      if (result.trigger) triggers.push(result.reason);
    } catch { /* check individual falhou — não bloquear ciclo */ }
  }

  if (triggers.length === 0) {
    return { shouldScan: false, reason: '[CICLO OK · sem ação]', triggers: [] };
  }

  return { shouldScan: true, reason: triggers.join(' | '), triggers };
}

/**
 * Registra que um scan completo foi executado.
 * Atualiza o timestamp de referência para o check C4.
 */
export function markScanExecutedSync() {
  try {
    writeFileSync(
      CYCLE_STATE,
      JSON.stringify({ lastScanTs: Date.now(), at: new Date().toISOString() }),
      'utf-8'
    );
  } catch { /* silent */ }
}
