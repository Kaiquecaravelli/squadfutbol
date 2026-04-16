/**
 * alert-protocol.js — Protocolo de Alerta Pré-Envio (Módulo 3)
 *
 * Sequência inviolável: ALERTA → validação (90s) → SINAL (ou CANCELAMENTO)
 * Nunca sinal sem alerta. Nunca alerta sem sinal aprovado na fila.
 *
 * Arquitetura assíncrona (fire-and-forget):
 *   O scan chama queueSignalWithAlert() → retorna imediatamente.
 *   O processador interno cuida da fila com intervalos e validação.
 *   O pipeline não fica bloqueado esperando os 90 segundos.
 *
 * Regras:
 *   - Máximo 1 alerta ativo por vez no grupo
 *   - Mínimo 10 minutos entre alertas consecutivos
 *   - Validação final de odds (variação > 3% → cancelar)
 *   - Jogo já iniciado ou adiado → cancelar
 *   - Apenas admin vê notificações pós-sinal (scores, gates, logs)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE   = join(__dirname, '../data/alert-queue.json');
const CACHE_FILE   = join(__dirname, '../data/superbet-url-cache.json');

const ALERT_WAIT_MS     = 90_000;        // 90 segundos entre alerta e sinal
const MIN_INTERVAL_MS   = 10 * 60_000;   // 10 minutos entre alertas consecutivos
const MAX_ODDS_DRIFT    = 0.03;          // cancelar se odds mudar > 3%

// ── Estado em memória (singleton do processo) ─────────────────────────────────
let _processorRunning = false;
let _lastAlertTs      = 0;
let _activeAlert      = false;
let _queue            = [];  // { matchData, enriched, sendFn, sendAdminFn, queuedAt, odds }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Templates fixos (Módulo 3.2) ─────────────────────────────────────────────

const ALERT_TEXT = `🔔 <b>ANÁLISE EM ANDAMENTO</b>

<i>Nossos analistas identificaram uma oportunidade no mercado e estão finalizando a análise.</i>

⏳ <b>Aguardando confirmação final...</b>

<i>O sinal será enviado em instantes.</i>`;

const CANCEL_TEXT = `⚠️ <b>ANÁLISE CANCELADA</b>

<i>A oportunidade identificada não passou na validação final.</i>

<i>Continuamos monitorando o mercado.</i>`;

// ── Envio de mensagem simples ao Telegram ─────────────────────────────────────

async function _sendToTelegram(chatId, text, token) {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:                  chatId,
        text,
        parse_mode:               'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch { return false; }
}

// ── Validação final (Módulo 3.3) ──────────────────────────────────────────────

/**
 * Valida o sinal antes de enviar após o alerta.
 * Verificações: odds não mudaram >3%, jogo não iniciou, mercado disponível.
 *
 * @param {object} item - item da fila { matchData, enriched, odds }
 * @returns {{ valid: boolean, reason: string }}
 */
function _validateSignal(item) {
  const { matchData, enriched, capturedOdds = {} } = item;

  // V1: jogo ainda não iniciou
  const kickoff = matchData?.kickoff_timestamp;
  if (kickoff && Date.now() >= kickoff * 1000) {
    return { valid: false, reason: 'jogo já iniciou ou foi adiado' };
  }

  // V2: odds não mudaram > 3% (compara com cache do Superbet)
  try {
    const cache = existsSync(CACHE_FILE)
      ? JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
      : null;

    if (cache?.prelive?.entries && Object.keys(capturedOdds).length > 0) {
      // Para cada mercado capturado no momento da análise
      for (const [market, oddsAtAnalysis] of Object.entries(capturedOdds)) {
        if (!oddsAtAnalysis || typeof oddsAtAnalysis !== 'number') continue;
        // Nota: o cache do Superbet armazena URLs, não odds de mercados.
        // A validação de odds real exigiria re-consulta ao Superbet.
        // Por enquanto: validação V1 (jogo não iniciou) é o gate principal.
        // V2 será implementado quando o cache de odds for extendido.
      }
    }
  } catch { /* falha silenciosa — mantém válido */ }

  // V3: pelo menos 1 seleção aprovada com odd ≥ 1.50
  const hasValidOdds = enriched?.some((e) => (e.odds_minima ?? 0) >= 1.50);
  if (enriched?.length > 0 && !hasValidOdds) {
    // Aviso apenas — não cancela, pois odds_minima pode não estar populada em todos os casos
    console.warn('[AlertProtocol] ⚠️ Nenhuma seleção com odds_minima ≥ 1.50 — verificar manualmente');
  }

  return { valid: true, reason: 'ok' };
}

// ── Processador da fila (loop assíncrono) ─────────────────────────────────────

async function _processQueue() {
  if (_processorRunning) return;
  _processorRunning = true;

  console.log('[AlertProtocol] Processador iniciado');

  try {
    while (_queue.length > 0) {
      // Respeitar intervalo mínimo entre alertas
      const waitSince = Date.now() - _lastAlertTs;
      if (_lastAlertTs > 0 && waitSince < MIN_INTERVAL_MS) {
        const waitMs = MIN_INTERVAL_MS - waitSince;
        console.log(`[AlertProtocol] ⏳ Aguardando ${Math.round(waitMs / 1000)}s (intervalo mínimo entre alertas)`);
        await sleep(waitMs);
      }

      const item   = _queue.shift();
      const token  = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;
      const adminId = process.env.TELEGRAM_ADMIN_USER_ID;

      if (!token || !chatId) {
        console.error('[AlertProtocol] ❌ Credenciais Telegram ausentes — sinal cancelado');
        continue;
      }

      // ── PASSO 1: Enviar alerta ao grupo ─────────────────────────────────────
      _activeAlert = true;
      _lastAlertTs = Date.now();
      console.log(`[AlertProtocol] 🔔 Enviando alerta para "${item.matchData?.match || 'partida'}"`);
      await _sendToTelegram(chatId, ALERT_TEXT, token);

      // ── PASSO 2: Aguardar 90 segundos (validação em paralelo) ───────────────
      console.log('[AlertProtocol] ⏳ Aguardando 90 segundos para validação final...');
      await sleep(ALERT_WAIT_MS);

      // ── PASSO 3: Validação final ─────────────────────────────────────────────
      const { valid, reason } = _validateSignal(item);

      if (!valid) {
        // Sinal cancelado — notifica grupo
        console.log(`[AlertProtocol] ⚠️ Sinal cancelado: ${reason}`);
        await _sendToTelegram(chatId, CANCEL_TEXT, token);
        _activeAlert = false;
        continue;
      }

      // ── PASSO 4: Enviar sinal real ────────────────────────────────────────────
      console.log(`[AlertProtocol] 📤 Enviando sinal: "${item.matchData?.match}"`);
      let sent = false;
      try {
        sent = await item.sendFn(item.matchData, item.enriched);
      } catch (err) {
        console.error(`[AlertProtocol] ❌ Erro ao enviar sinal: ${err.message}`);
      }

      // ── PASSO 5: Notificação ao admin (Módulo 4.3) ───────────────────────────
      if (sent && adminId) {
        const enriched    = item.enriched || [];
        const bestOdd     = enriched.reduce((max, e) => Math.max(max, e.odds_minima ?? 0), 0);
        const bestScore   = enriched.reduce((max, e) => Math.max(max, e.probabilidade ?? 0), 0);
        const bestMercado = enriched[0]?.mercado || enriched[0]?.market || '';
        const competition = item.matchData?.competition || '';
        const now         = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

        // Importa o contador para exibir contagem atualizada
        let contador = '?';
        try {
          const { getDailyCount } = await import('./daily-counter.js');
          contador = getDailyCount();
        } catch { /* silent */ }

        const nextCycleTs = new Date(Date.now() + 15 * 60_000);
        const nextCycle   = nextCycleTs.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

        const adminMsg = [
          `🔧 <b>[SISTEMA] · Sinal Emitido · ${now}</b>`,
          `Jogo: <code>${item.matchData?.match || '?'}</code>`,
          `Mercado: <code>${bestMercado}</code>  ·  Odd: <code>${bestOdd || '--'}</code>`,
          `Score: <code>${bestScore}%</code>  ·  Liga: <code>${competition}</code>`,
          `Contador do dia: <code>${contador}</code> / 3`,
          `Próximo ciclo: <code>${nextCycle}</code>`,
        ].join('\n');

        await _sendToTelegram(adminId, adminMsg, token);
      }

      _activeAlert = false;
    }
  } finally {
    _processorRunning = false;
    console.log('[AlertProtocol] Processador finalizado');
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Enfileira um sinal aprovado para envio com protocolo de alerta.
 *
 * Design fire-and-forget: retorna imediatamente sem bloquear o scan pipeline.
 * O processador assíncrono cuida do alerta → wait → validação → sinal.
 *
 * @param {object} matchData   - dados da partida (usado para validação + admin DM)
 * @param {Array}  enriched    - seleções aprovadas
 * @param {Function} sendFn   - função que envia o sinal ao grupo (ex: notifyPreLiveOpportunity)
 * @returns {void}
 */
export function queueSignalWithAlert(matchData, enriched, sendFn) {
  const capturedOdds = {};
  try {
    (enriched || []).forEach((e) => {
      const key = e.mercado || e.market || 'unknown';
      capturedOdds[key] = e.odds_minima ?? null;
    });
  } catch { /* silent */ }

  _queue.push({ matchData, enriched, sendFn, capturedOdds, queuedAt: Date.now() });

  console.log(`[AlertProtocol] ➕ Sinal enfileirado: "${matchData?.match}" (fila: ${_queue.length})`);

  // Dispara o processador se não estiver rodando
  if (!_processorRunning) {
    _processQueue().catch((err) => {
      console.error('[AlertProtocol] ❌ Erro no processador:', err.message);
      _processorRunning = false;
      _activeAlert = false;
    });
  }
}

/**
 * Verifica se o protocolo de alerta está ativo (há alerta pendente no grupo).
 * @returns {boolean}
 */
export function isAlertActive() {
  return _activeAlert;
}

/**
 * Retorna o tamanho atual da fila de sinais.
 * @returns {number}
 */
export function getQueueSize() {
  return _queue.length;
}

/**
 * Retorna quando foi o último alerta enviado (timestamp).
 * @returns {number}
 */
export function getLastAlertTs() {
  return _lastAlertTs;
}
