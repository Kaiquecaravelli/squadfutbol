/**
 * gemini-key-manager.js — Pool de Chaves Gemini com Rotação Automática
 *
 * Problema: uma única chave esgota a cota diária (RPD) e as análises param.
 * Solução: pool de N chaves, rotação automática ao detectar quota esgotada.
 *
 * Comportamento:
 *  - RPM (429 rate-limit por minuto) → backoff + retry na MESMA chave
 *  - RPD (429 quota diária esgotada) → marca chave como exausta + rotaciona para próxima
 *  - Todas exaustas                  → avisa Telegram + aguarda reset (meia-noite UTC)
 *  - Reset diário                    → chaves liberam às 00:00 UTC (+ 5min buffer)
 *
 * Configuração (.env):
 *   GEMINI_KEYS=chave1,chave2,chave3   ← preferencial (pool completo)
 *   GEMINI_API_KEY=chave1              ← fallback compatível (1 chave)
 *
 * Uso:
 *   import { geminiKeyManager } from '../utils/gemini-key-manager.js';
 *   const key = geminiKeyManager.getKey();         // chave ativa atual
 *   geminiKeyManager.reportRPD(key);               // marca como exausta
 *   geminiKeyManager.reportRPM(key);               // apenas incrementa contador
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath }  from 'url';

const __dir       = dirname(fileURLToPath(import.meta.url));
const STATE_FILE  = join(__dir, '../../data/gemini-key-state.json');

// ── Carrega pool de chaves ────────────────────────────────────────────────────
function loadKeys() {
  const fromPool   = process.env.GEMINI_KEYS?.split(',').map(k => k.trim()).filter(Boolean) || [];
  const fromSingle = process.env.GEMINI_API_KEY?.trim();

  // Mescla, removendo duplicatas
  const all = [...new Set([...fromPool, fromSingle].filter(Boolean))];

  if (!all.length) throw new Error('Nenhuma chave Gemini configurada. Defina GEMINI_KEYS no .env');
  return all;
}

// ── Estado persistente ────────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return { exhausted: {}, currentIdx: 0, rotations: 0 };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch { return { exhausted: {}, currentIdx: 0, rotations: 0 }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch { /* silencioso */ }
}

// ── Reset diário: chaves voltam às 00:05 UTC (5min buffer pós-meia-noite) ────
function nextResetMs() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0));
  return next.getTime();
}

// ── Classe GeminiKeyManager ────────────────────────────────────────────────────
class GeminiKeyManager {
  constructor() {
    this.keys    = loadKeys();
    this.state   = loadState();
    this._notify = null; // injetado depois (evita circular dependency)

    // Limpa chaves exaustas que já passaram do reset diário
    this._clearExpired();

    console.log(`[GeminiPool] Pool iniciado: ${this.keys.length} chave(s) | ativa: #${this.state.currentIdx + 1}`);
  }

  // Injeta função de notificação Telegram (chamada externamente para evitar import circular)
  setNotifier(fn) { this._notify = fn; }

  // ── Retorna a chave ativa ──────────────────────────────────────────────────
  getKey() {
    this._clearExpired();

    // Verifica se a chave atual está disponível
    const key = this.keys[this.state.currentIdx];
    if (key && !this._isExhausted(key)) return key;

    // Procura a próxima chave disponível
    for (let i = 0; i < this.keys.length; i++) {
      const idx  = (this.state.currentIdx + i) % this.keys.length;
      const k    = this.keys[idx];
      if (k && !this._isExhausted(k)) {
        this.state.currentIdx = idx;
        saveState(this.state);
        return k;
      }
    }

    // Todas exaustas
    return null;
  }

  // ── Reporta quota diária esgotada (RPD) para uma chave ────────────────────
  reportRPD(key) {
    const resetAt = nextResetMs();
    this.state.exhausted[key] = resetAt;
    this.state.rotations      = (this.state.rotations || 0) + 1;

    const resetHour = new Date(resetAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const keyShort  = `...${key.slice(-6)}`;

    console.warn(`[GeminiPool] ⚠️  Chave ${keyShort} esgotada (RPD) → reset às ${resetHour} BRT`);

    // Tenta rotacionar para a próxima
    const next = this._rotateToNext(key);
    if (next) {
      console.log(`[GeminiPool] 🔄 Rotacionando para chave ...${next.slice(-6)}`);
      // Rotação silenciosa — sem alerta ao usuário final
    } else {
      console.error(`[GeminiPool] ❌ TODAS as chaves esgotadas! Reset às ${resetHour} BRT`);
      this._sendAlert(
        `🤖 <b>Agentes em monitoramento</b>\n\nNossos agentes estão analisando o mercado e aguardando novas oportunidades.\n\nAssim que identificarmos entradas de valor, você receberá a análise aqui. 📊`
      );
    }

    saveState(this.state);
    return next;
  }

  // ── Rotaciona para a próxima chave disponível ──────────────────────────────
  _rotateToNext(exhaustedKey) {
    for (let i = 1; i <= this.keys.length; i++) {
      const idx = (this.state.currentIdx + i) % this.keys.length;
      const k   = this.keys[idx];
      if (k && k !== exhaustedKey && !this._isExhausted(k)) {
        this.state.currentIdx = idx;
        return k;
      }
    }
    return null; // todas esgotadas
  }

  // ── Verifica se uma chave está exausta (e não resetou ainda) ──────────────
  _isExhausted(key) {
    const resetAt = this.state.exhausted[key];
    if (!resetAt) return false;
    return Date.now() < resetAt;
  }

  // ── Limpa chaves cujo reset já passou ─────────────────────────────────────
  _clearExpired() {
    const now = Date.now();
    let changed = false;
    for (const [key, resetAt] of Object.entries(this.state.exhausted || {})) {
      if (now >= resetAt) {
        delete this.state.exhausted[key];
        changed = true;
        console.log(`[GeminiPool] ✅ Chave ...${key.slice(-6)} liberada (reset diário)`);
      }
    }
    if (changed) saveState(this.state);
  }

  // ── Status do pool (para diagnóstico) ─────────────────────────────────────
  status() {
    this._clearExpired();
    return this.keys.map((k, i) => {
      const exhausted = this._isExhausted(k);
      const resetAt   = this.state.exhausted[k];
      const resetStr  = resetAt
        ? new Date(resetAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
        : null;
      return {
        index:   i + 1,
        key:     `...${k.slice(-6)}`,
        active:  i === this.state.currentIdx && !exhausted,
        exhausted,
        resetAt: resetStr,
      };
    });
  }

  // ── Quantas chaves disponíveis ─────────────────────────────────────────────
  availableCount() {
    this._clearExpired();
    return this.keys.filter(k => !this._isExhausted(k)).length;
  }

  // ── Envia alerta Telegram (não-bloqueante) ─────────────────────────────────
  _sendAlert(msg) {
    if (this._notify) {
      this._notify(msg).catch(() => {});
    }
  }
}

// ── Singleton global ───────────────────────────────────────────────────────────
export const geminiKeyManager = new GeminiKeyManager();

// ── Injeta notificador Telegram de forma lazy (evita circular dependency) ─────
setTimeout(async () => {
  try {
    const { notifyGeminiKeyAlert } = await import('./telegram.js');
    geminiKeyManager.setNotifier(msg => notifyGeminiKeyAlert(msg).catch(() => {}));
  } catch { /* telegram pode não estar configurado */ }
}, 0);

// ── Helper: executa chamada com rotação automática de chave ───────────────────
/**
 * Wrapper que substitui _callGemini() nos agentes.
 * Trata RPM com backoff e RPD com rotação de chave.
 *
 * @param {Function} callFn  - fn(apiKey) → Promise<string>  (faz a chamada HTTP)
 * @param {string}   agentName
 * @param {number}   maxAttempts
 */
export async function callGeminiWithRotation(callFn, agentName = 'Agent', maxAttempts = 12) {
  const BACKOFFS_RPM = [15_000, 30_000, 60_000, 90_000]; // retry RPM

  let rpmAttempts  = 0;
  let lastKey      = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const key = geminiKeyManager.getKey();

    if (!key) {
      // Todas as chaves esgotadas — calcula tempo até reset
      const minUntilReset = Object.values(geminiKeyManager.state.exhausted || {})
        .map(t => Math.ceil((t - Date.now()) / 60_000))
        .sort((a, b) => a - b)[0] || 60;

      throw Object.assign(
        new Error(`Agentes em monitoramento — aguardando próxima janela de análise`),
        { isQuotaError: true, allKeysExhausted: true, silent: true }
      );
    }

    lastKey = key;

    try {
      return await callFn(key);
    } catch (err) {
      const status  = err.response?.status;
      const errBody = JSON.stringify(err.response?.data || err.message || '');

      // ── RPD: quota diária — rotaciona chave ─────────────────────────────
      const isRPD = status === 429 && !errBody.includes('RATE_LIMIT_EXCEEDED') && (
        errBody.includes('billing') ||
        errBody.includes('current quota') ||
        errBody.includes('QUOTA_EXCEEDED') ||
        errBody.includes('exceeded your') ||
        errBody.includes('quota')
      );

      if (isRPD) {
        geminiKeyManager.reportRPD(key);
        console.warn(`  [${agentName}] RPD detectado — tentando próxima chave (tentativa ${attempt})`);
        continue; // tenta de novo com nova chave
      }

      // ── RPM: rate limit por minuto — backoff na mesma chave ─────────────
      const isRPM = status === 429;
      if (isRPM && rpmAttempts < BACKOFFS_RPM.length) {
        const delay = BACKOFFS_RPM[rpmAttempts++];
        console.warn(`  [${agentName}] RPM 429 — aguardando ${delay / 1000}s... (retry ${rpmAttempts})`);
        await sleep(delay);
        attempt--; // não conta como tentativa da rotação
        continue;
      }

      // ── 503 / 500 — erro temporário do servidor ──────────────────────────
      if ((status === 503 || status === 500) && attempt < maxAttempts) {
        await sleep(attempt * 4000);
        continue;
      }

      throw err;
    }
  }

  throw new Error(`[${agentName}] Máximo de tentativas atingido após rotação de chaves`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CLI de diagnóstico: node src/utils/gemini-key-manager.js ─────────────────
if (process.argv[1]?.endsWith('gemini-key-manager.js')) {
  import('dotenv/config').catch(() => {});
  await new Promise(r => setTimeout(r, 100)); // aguarda lazy imports

  console.log('\n🔑 Pool de Chaves Gemini\n');
  const status = geminiKeyManager.status();
  for (const s of status) {
    const icon  = s.active ? '✅ ATIVA' : s.exhausted ? `❌ EXAUSTA (reset: ${s.resetAt})` : '⏸  STANDBY';
    console.log(`  Chave #${s.index} (${s.key}) → ${icon}`);
  }
  console.log(`\n  Disponíveis: ${geminiKeyManager.availableCount()}/${status.length}`);
  console.log(`  Rotações hoje: ${geminiKeyManager.state.rotations || 0}\n`);
}
