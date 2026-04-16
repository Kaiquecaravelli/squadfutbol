/**
 * data-cache.js — Cache Inteligente por TTL v1.0.0
 *
 * Elimina chamadas externas repetidas no mesmo ciclo de análise.
 * TTLs calibrados por tipo de dado para equilibrar frescor e velocidade.
 *
 * Ganhos estimados:
 *   → Elimina 40–60% das chamadas externas por rodada
 *   → Redução de 30–50% no tempo total de coleta
 *   → Dados históricos (H2H, médias, coeficientes) reutilizados entre jogos da mesma rodada
 */

// ── TTLs por tipo de dado ──────────────────────────────────────────────────────
export const TTL = {
  H2H_HISTORICO:       24 * 60 * 60_000,   // 24h — histórico H2H últimos 10 jogos
  MEDIA_GOLS_LIGA:      7 * 24 * 60 * 60_000, // 7 dias — média de gols da liga (5 anos)
  WHITELIST_LIGAS:     24 * 60 * 60_000,   // 24h — whitelist de ligas aprovadas
  LAMBDA_LIGA:          7 * 24 * 60 * 60_000, // 7 dias — coeficiente lambda por liga
  BASE_RATES:           7 * 24 * 60 * 60_000, // 7 dias — base rates por liga (1X2)
  ESCALACAO:            3 * 60 * 60_000,   // 3h — escalação confirmada
  ODDS_PRELIVE:         15 * 60_000,        // 15 min — odds pré-live
  FORMA_RECENTE:        6 * 60 * 60_000,   // 6h — dados de forma recente (5j)
  STATS_TIME:           6 * 60 * 60_000,   // 6h — estatísticas de time (btts_pct, over25_pct)
  DADOS_ARBITRO:       24 * 60 * 60_000,   // 24h — dados do árbitro
  PIE_CALIBRACAO:       5 * 60_000,        // 5 min — calibração PIE (já implementado no funnel)
  ANALISE_AGENTE:      25 * 60_000,        // 25 min — análise de agente por jogo (já implementado)
};

// ── CacheStore ─────────────────────────────────────────────────────────────────
class CacheStore {
  constructor() {
    this._store = new Map(); // key → { data, ts, ttlMs, hits }
    this._stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Busca valor no cache. Retorna null se expirado ou ausente.
   * @param {string} key
   * @returns {*|null}
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) { this._stats.misses++; return null; }
    if (Date.now() - entry.ts > entry.ttlMs) {
      this._store.delete(key);
      this._stats.evictions++;
      this._stats.misses++;
      return null;
    }
    entry.hits++;
    this._stats.hits++;
    return entry.data;
  }

  /**
   * Armazena valor com TTL.
   * @param {string} key
   * @param {*}      data
   * @param {number} ttlMs — usar constantes TTL acima
   */
  set(key, data, ttlMs) {
    this._store.set(key, { data, ts: Date.now(), ttlMs, hits: 0 });
  }

  /** Invalida uma chave específica. */
  invalidate(key) { this._store.delete(key); }

  /** Invalida todas as chaves que contêm o prefixo. */
  invalidatePrefix(prefix) {
    for (const k of this._store.keys()) {
      if (k.startsWith(prefix)) this._store.delete(k);
    }
  }

  /** Limpa entradas expiradas (chamada periódica para evitar memory leak). */
  purgeExpired() {
    const now = Date.now();
    let purged = 0;
    for (const [k, v] of this._store.entries()) {
      if (now - v.ts > v.ttlMs) { this._store.delete(k); purged++; }
    }
    return purged;
  }

  /** Estatísticas de eficiência do cache. */
  stats() {
    const total = this._stats.hits + this._stats.misses;
    return {
      ...this._stats,
      entries:    this._store.size,
      hit_rate:   total > 0 ? Math.round(this._stats.hits / total * 100) : 0,
    };
  }
}

// ── Instância global compartilhada ─────────────────────────────────────────────
// Uma única instância por processo Node.js, compartilhada entre todos os módulos.
export const dataCache = new CacheStore();

// Purga periódica: a cada 30 min, limpa entradas expiradas
setInterval(() => {
  const purged = dataCache.purgeExpired();
  if (purged > 0) console.log(`[DataCache] Purga: ${purged} entradas expiradas removidas`);
}, 30 * 60_000).unref(); // .unref() para não bloquear o processo no exit

// ── Helper de acesso com fetch automático ─────────────────────────────────────
/**
 * Busca dado com cache automático. Se expirado ou ausente, chama fetchFn.
 * Padrão fundamental do Módulo 2 de aceleração.
 *
 * @param {string}   key      — chave única do dado (ex: 'h2h:flamengo:botafogo')
 * @param {number}   ttlMs    — TTL em ms (usar constantes TTL acima)
 * @param {Function} fetchFn  — função assíncrona que busca o dado da fonte
 * @returns {Promise<*>}
 *
 * @example
 * const h2h = await withCache(
 *   `h2h:${homeTeam}:${awayTeam}`,
 *   TTL.H2H_HISTORICO,
 *   () => getSofascoreH2H(homeId, awayId)
 * );
 */
export async function withCache(key, ttlMs, fetchFn) {
  const cached = dataCache.get(key);
  if (cached !== null) return cached;

  const data = await fetchFn();
  if (data !== null && data !== undefined) {
    dataCache.set(key, data, ttlMs);
  }
  return data;
}

/**
 * Versão com timeout — aborta fetchFn se demorar mais que timeoutMs.
 * Fallback para cache expirado se disponível; null se não houver.
 *
 * @param {string}   key
 * @param {number}   ttlMs
 * @param {Function} fetchFn
 * @param {number}   timeoutMs — timeout em ms (padrões: academia=4000, sofascore=5000)
 */
export async function withCacheAndTimeout(key, ttlMs, fetchFn, timeoutMs = 5_000) {
  const cached = dataCache.get(key);
  if (cached !== null) return cached;

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`[DataCache] Timeout ${timeoutMs}ms: ${key}`)), timeoutMs);
  });

  try {
    const data = await Promise.race([fetchFn(), timeoutPromise]);
    clearTimeout(timeoutId);
    if (data !== null && data !== undefined) {
      dataCache.set(key, data, ttlMs);
    }
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    // Timeout ou erro: tentar retornar cache expirado se disponível
    const staleEntry = dataCache['_store']?.get(key);
    if (staleEntry) {
      console.warn(`[DataCache] ${err.message} — usando dado expirado (${Math.round((Date.now() - staleEntry.ts) / 60_000)}min)`);
      return staleEntry.data;
    }
    return null;
  }
}

export default { dataCache, withCache, withCacheAndTimeout, TTL };
