/**
 * groq-key-manager.js — Pool de Chaves Groq com Rotação Automática
 *
 * Groq free tier (por chave):
 *   llama-3.1-8b-instant    → 30 RPM | 20,000 TPM
 *   llama-3.3-70b-versatile → 30 RPM | 6,000 TPM
 *
 * Com 6 chaves (llama-3.1-8b-instant):
 *   180 RPM combinado | 120,000 TPM combinado
 *
 * Rotação:
 *   - Round-robin entre chaves (distribui carga automaticamente)
 *   - 429 → marca chave em cooldown (retry-after ou 65s) → rotaciona
 *   - Todas em cooldown → aguarda a mais próxima recuperar
 *
 * Configuração (.env):
 *   GROQ_KEYS=chave1,chave2,...chave6
 *   GROQ_MODEL=llama-3.1-8b-instant  (padrão)
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir      = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dir, '../../data/groq-key-state.json');

// ── Carrega pool de chaves Groq ────────────────────────────────────────────────
function loadKeys() {
  const fromPool   = process.env.GROQ_KEYS?.split(',').map(k => k.trim()).filter(Boolean) || [];
  const fromSingle = process.env.GROQ_API_KEY?.trim();
  const all = [...new Set([...fromPool, fromSingle].filter(Boolean))];
  if (!all.length) throw new Error('Nenhuma chave Groq configurada. Defina GROQ_KEYS no .env');
  return all;
}

// ── Estado persistente ─────────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return { cooldowns: {}, currentIdx: 0, rotations: 0 };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { cooldowns: {}, currentIdx: 0, rotations: 0 }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch {}
}

// ── Classe GroqKeyManager ──────────────────────────────────────────────────────
class GroqKeyManager {
  constructor() {
    this.keys  = loadKeys();
    this.state = loadState();
    this._clearExpired();
    const activeIdx = (this.state.currentIdx ?? 0) % this.keys.length;
    console.log(`[GroqPool] Pool iniciado: ${this.keys.length} chave(s) | ativa: #${activeIdx + 1}`);
  }

  /**
   * Round-robin: cada chamada avança o ponteiro para a próxima chave disponível.
   * Em Node.js (single-thread), chamadas simultâneas são sequenciadas → distribui carga.
   */
  getNextKey() {
    this._clearExpired();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.state.currentIdx + i) % this.keys.length;
      const k   = this.keys[idx];
      if (k && !this._isCooling(k)) {
        this.state.currentIdx = (idx + 1) % this.keys.length;
        return k;
      }
    }
    return null; // todas em cooldown
  }

  // Alias para compatibilidade com código legado
  getKey() { return this.getNextKey(); }

  /**
   * Reporta 429 — marca chave em cooldown e rotaciona.
   * @param {string} key           - a chave que recebeu 429
   * @param {number} retryAfterSec - valor do header retry-after (0 = usa padrão 65s)
   */
  reportRateLimit(key, retryAfterSec = 0) {
    const cooldownMs = retryAfterSec > 0 ? retryAfterSec * 1_000 : 65_000;
    this.state.cooldowns[key] = Date.now() + cooldownMs;
    this.state.rotations      = (this.state.rotations || 0) + 1;

    const keyShort = `...${key.slice(-6)}`;
    const resetStr = new Date(this.state.cooldowns[key]).toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    });
    console.warn(`[GroqPool] ⚠️  Chave ${keyShort} em cooldown → disponível às ${resetStr}`);
    saveState(this.state);

    return this.getNextKey();
  }

  // Compat: reportRPD → reportRateLimit
  reportRPD(key) { return this.reportRateLimit(key); }

  // Milissegundos até a chave mais próxima sair do cooldown (0 = alguma disponível)
  timeUntilNextKey() {
    const now = Date.now();
    const waits = Object.values(this.state.cooldowns)
      .map(t => t - now)
      .filter(t => t > 0)
      .sort((a, b) => a - b);
    return waits[0] ?? 0;
  }

  // Número de chaves disponíveis agora
  availableCount() {
    this._clearExpired();
    return this.keys.filter(k => !this._isCooling(k)).length;
  }

  // Status completo para diagnóstico
  status() {
    this._clearExpired();
    return this.keys.map((k, i) => {
      const cooling  = this._isCooling(k);
      const until    = this.state.cooldowns[k];
      const resetStr = until
        ? new Date(until).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
        : null;
      return { index: i + 1, key: `...${k.slice(-6)}`, active: !cooling, cooling, availableAt: resetStr };
    });
  }

  _isCooling(key) {
    const until = this.state.cooldowns?.[key];
    return !!until && Date.now() < until;
  }

  _clearExpired() {
    const now = Date.now();
    let changed = false;
    for (const [key, until] of Object.entries(this.state.cooldowns || {})) {
      if (now >= until) {
        delete this.state.cooldowns[key];
        changed = true;
        console.log(`[GroqPool] ✅ Chave ...${key.slice(-6)} disponível novamente`);
      }
    }
    if (changed) saveState(this.state);
  }
}

// ── Singleton global ───────────────────────────────────────────────────────────
export const groqKeyManager = new GroqKeyManager();

// ── triggerGroqCooldown: mantido para compatibilidade ─────────────────────────
export function triggerGroqCooldown() {
  // Cooldown tratado automaticamente dentro de callGroqWithRotation
}

// ── Semáforo de concorrência: máx 4 requests simultâneas ─────────────────────
// Com 6 chaves × 20k TPM, limitar a 4 concurrent previne burst de tokens
let _activeRequests = 0;
const MAX_CONCURRENT = 4;

async function _acquireSlot() {
  while (_activeRequests >= MAX_CONCURRENT) await sleep(250);
  _activeRequests++;
}
function _releaseSlot() { _activeRequests = Math.max(0, _activeRequests - 1); }

// ── callGroqWithRotation — chama Groq com rotação de chaves ───────────────────
/**
 * Executa uma chamada à API Groq com rotação automática de chaves e retry em 429.
 *
 * @param {Function} callFn      - async (apiKey: string) => string
 * @param {string}   agentName
 * @param {number}   maxAttempts
 */
export async function callGroqWithRotation(callFn, agentName = 'Agent', maxAttempts = 18) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let key = groqKeyManager.getNextKey();

    // Todas as chaves em cooldown → aguarda a mais próxima
    if (!key) {
      const waitMs = groqKeyManager.timeUntilNextKey() + 500;
      if (waitMs > 0 && waitMs < 120_000) {
        console.warn(`  [${agentName}] ⏳ Todas as chaves em cooldown — aguardando ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
        key = groqKeyManager.getNextKey();
      }
      if (!key) {
        throw Object.assign(
          new Error(`[${agentName}] Todas as chaves Groq em cooldown — aguarde`),
          { isQuotaError: true }
        );
      }
    }

    await _acquireSlot();
    try {
      return await callFn(key);
    } catch (err) {
      const status = err.response?.status;

      // 429 Rate Limit → rotaciona chave imediatamente
      if (status === 429) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
        groqKeyManager.reportRateLimit(key, retryAfter);
        console.warn(`  [${agentName}] 429 → rotacionando chave (tentativa ${attempt}/${maxAttempts})`);
        if (attempt < maxAttempts) continue;
      }

      // 401 Chave inválida → descarta por 1h
      if (status === 401) {
        console.error(`  [${agentName}] ❌ Chave inválida: ...${key.slice(-6)} — descartando por 1h`);
        groqKeyManager.reportRateLimit(key, 3600);
        if (attempt < maxAttempts) continue;
      }

      // 500/503 Erro temporário → retry com backoff
      if ((status === 503 || status === 500) && attempt < maxAttempts) {
        await sleep(Math.min(attempt * 2_000, 10_000));
        continue;
      }

      throw err;
    } finally {
      _releaseSlot();
    }
  }

  throw new Error(`[${agentName}] Máximo de tentativas atingido (${maxAttempts})`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CLI de diagnóstico: node src/utils/groq-key-manager.js ───────────────────
if (process.argv[1]?.endsWith('groq-key-manager.js')) {
  await import('dotenv/config').catch(() => {});
  await new Promise(r => setTimeout(r, 100));

  console.log('\n🔑 Pool de Chaves Groq\n');
  const status = groqKeyManager.status();
  for (const s of status) {
    const icon = s.active ? '✅ ATIVA' : `❌ COOLDOWN (disponível: ${s.availableAt})`;
    console.log(`  Chave #${s.index} (${s.key}) → ${icon}`);
  }
  console.log(`\n  Disponíveis: ${groqKeyManager.availableCount()}/${status.length}`);
  console.log(`  Rotações: ${groqKeyManager.state.rotations || 0}\n`);
}
