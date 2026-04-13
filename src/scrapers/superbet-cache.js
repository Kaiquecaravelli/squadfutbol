/**
 * superbet-cache.js — Cache de URLs diretas das partidas no Superbet
 *
 * Abre UMA sessão Playwright por tipo (prelive / live) e coleta TODAS as URLs
 * reais das partidas disponíveis no site. Persiste em disco com TTL.
 *
 * Regra: análise só pode ser enviada ao Telegram se `lookupMatchUrl()` retornar
 * uma URL válida. Caso contrário, a análise é descartada.
 *
 * TTL:
 *   prelive → 20 minutos (partidas futuras mudam pouco)
 *   live    →  5 minutos (mercados ao vivo mudam rapidamente)
 *
 * Uso:
 *   import { ensureFresh, lookupMatchUrl } from './superbet-cache.js';
 *   await ensureFresh('prelive');
 *   const url = lookupMatchUrl('Flamengo', 'Palmeiras', 'prelive');
 *   if (!url) { // não enviar }
 */

import { chromium }               from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname }           from 'path';
import { fileURLToPath }           from 'url';
import chalk                       from 'chalk';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, '../../data/superbet-url-cache.json');
const DATA_DIR   = join(__dirname, '../../data');

const TTL = {
  prelive: 20 * 60_000,   // 20 minutos
  live:     5 * 60_000,   //  5 minutos
};

const NAV_TIMEOUT = 35_000;
const SPA_WAIT    = 8_000;   // ms para SPA renderizar

// ── Normalização ───────────────────────────────────────────────────────────────
function _norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

/** Extrai a "primeira palavra significativa" de um slug (≥4 chars) */
function _sigWord(slug) {
  return slug.split('-').find(w => w.length >= 4) ?? slug.slice(0, 5);
}

// ── Cache em disco ─────────────────────────────────────────────────────────────
function _readCache() {
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); }
  catch { return { prelive: { refreshed_at: 0, entries: [] }, live: { refreshed_at: 0, entries: [] } }; }
}

function _writeCache(cache) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.warn(chalk.yellow(`[SuperbetCache] Falha ao salvar cache: ${e.message}`));
  }
}

// ── Scraping de URLs ───────────────────────────────────────────────────────────

/**
 * Extrai TODAS as URLs de partidas de uma página Superbet.
 * Estratégia tripla (ordem de prioridade):
 *   1. DOM (primário): extrai <a href> com padrão de evento — URL confirmada pelo site
 *   2. API JSON (secundário): intercepta /events/by-date e constrói URL a partir do eventId
 *      → Captura partidas de ligas que não aparecem no DOM (ex: Liga Profesional Argentina)
 *   3. Páginas de amanhã: navega à data seguinte para cobrir a janela 6-24h
 */
async function _scrapeMatchUrls(pageUrl, label) {
  let browser = null;
  const entries    = [];          // entradas confirmadas via DOM
  const apiBuilt   = [];          // entradas construídas via API JSON

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
             '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      locale: 'pt-BR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    });

    // ── Intercepta API — constrói URLs diretamente do JSON ─────────────────────
    // A API retorna TODOS os eventos (incluindo ligas que o DOM não renderiza na
    // página principal). O formato da URL é confirmado pelas URLs DOM que temos.
    const apiMatchNames = new Map(); // eventId → matchName
    context.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (!url.includes('/events/by-date') && !url.includes('/events/live')) return;
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const body = await resp.json().catch(() => null);
        if (!body) return;

        const events = body.data || body.liveEvents || body.events || [];
        if (!Array.isArray(events)) return;

        for (const ev of events) {
          const id = String(ev.eventId || ev.offerId || ev.id || '');
          const mn = ev.matchName || ev.name || ev.eventName || '';
          if (!id || !mn) continue;

          apiMatchNames.set(id, mn);

          // Constrói URL diretamente (formato: /odds/futebol/{hSlug}-x-{aSlug}-{id})
          const parts = mn.split('·');
          if (parts.length < 2) continue;
          const hSlug = _norm(parts[0]);
          const aSlug = _norm(parts[1]);
          if (hSlug && aSlug) {
            apiBuilt.push({
              home:     hSlug,
              away:     aSlug,
              url:      `https://superbet.bet.br/odds/futebol/${hSlug}-x-${aSlug}-${id}`,
              altNames: [mn],
              eventId:  id,
            });
          }
        }
      } catch { /* silencioso */ }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    // Aceita cookies se aparecer
    await page.locator('button:has-text("Aceitar"), button:has-text("Concordo"), [id*="accept"]')
      .first().click({ timeout: 4_000 }).catch(() => {});

    // Aguarda SPA carregar os cards de partidas
    await new Promise(r => setTimeout(r, SPA_WAIT));

    // ── DOM: extrai hrefs reais (fonte primária — URL garantidamente correta) ──
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h =>
          /[a-z0-9-]+-x-[a-z0-9-]+-\d+/.test(h) &&
          h.includes('superbet.bet.br')
        )
    );

    const seen = new Set();
    for (const href of hrefs) {
      const m = href.match(/([a-z0-9][a-z0-9-]+)-x-([a-z0-9][a-z0-9-]+)-(\d+)/);
      if (!m) continue;

      const [, hSlug, aSlug, eventId] = m;
      const key = `${hSlug}__${aSlug}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const apiName  = apiMatchNames.get(eventId);
      const altNames = apiName ? [apiName] : [];

      entries.push({ home: hSlug, away: aSlug, url: href, altNames, eventId });
    }

    // ── Merge: adiciona entradas da API que não estão no DOM ──────────────────
    // Cobre ligas que a página principal não renderiza (ex: Argentina, ligas menores)
    const domKeys = new Set(entries.map(e => `${e.home}__${e.away}`));
    const seenApi  = new Set();
    for (const ae of apiBuilt) {
      const key = `${ae.home}__${ae.away}`;
      if (!domKeys.has(key) && !seenApi.has(key)) {
        seenApi.add(key);
        entries.push(ae);
      }
    }

    const domCount = seen.size;
    const apiCount = entries.length - domCount;
    const total    = entries.length;
    if (total > 0) {
      console.log(chalk.green(
        `  [SuperbetCache] ${label}: ${total} partidas indexadas` +
        (apiCount > 0 ? ` (${domCount} DOM + ${apiCount} API)` : '')
      ));
    } else {
      console.log(chalk.yellow(`  [SuperbetCache] ${label}: nenhuma partida encontrada (SPA pode não ter renderizado)`));
    }
  } catch (err) {
    console.log(chalk.gray(`  [SuperbetCache] Erro ao escanear ${label}: ${err.message}`));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return entries;
}

// ── API Pública ────────────────────────────────────────────────────────────────

/**
 * Força refresh do cache para o tipo especificado.
 * @param {'prelive'|'live'} type
 */
export async function refreshCache(type = 'prelive') {
  const pageUrl = type === 'live'
    ? 'https://superbet.bet.br/apostas/ao-vivo'
    : 'https://superbet.bet.br/apostas/futebol';

  const label   = type === 'live' ? 'AO VIVO' : 'PRÉ-LIVE';
  console.log(chalk.cyan(`  [SuperbetCache] Atualizando cache ${label}...`));

  const entries    = await _scrapeMatchUrls(pageUrl, label);
  const cache      = _readCache();
  cache[type]      = { refreshed_at: Date.now(), entries };
  _writeCache(cache);

  return entries.length;
}

/**
 * Garante que o cache está fresco. Só chama refreshCache() se o TTL expirou.
 * @param {'prelive'|'live'} type
 */
export async function ensureFresh(type = 'prelive') {
  const cache   = _readCache();
  const section = cache[type] || { refreshed_at: 0 };
  const age     = Date.now() - (section.refreshed_at || 0);
  const ttl     = TTL[type] ?? TTL.prelive;

  if (age > ttl) {
    await refreshCache(type);
  } else {
    const agoSec = Math.round(age / 1000);
    console.log(chalk.gray(`  [SuperbetCache] Cache ${type} válido (atualizado há ${agoSec}s)`));
  }
}

/**
 * Retorna a URL direta da partida no Superbet, ou null se não encontrada.
 *
 * Algoritmo de matching (3 níveis):
 *   1. Slug exato: home === entry.home && away === entry.away
 *   2. Palavra-chave: primeira palavra ≥4 chars do slug bate em ambos
 *   3. Substring: fragmento de 5 chars do slug está contido na entrada
 *
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {'prelive'|'live'} type
 * @returns {string|null}
 */
export function lookupMatchUrl(homeTeam, awayTeam, type = 'prelive') {
  const cache   = _readCache();
  const entries = cache[type]?.entries ?? [];

  if (!entries.length) return null;

  const hSlug = _norm(homeTeam);
  const aSlug = _norm(awayTeam);

  // Nível 1 — Slug exato
  const exact = entries.find(e => e.home === hSlug && e.away === aSlug);
  if (exact) return exact.url;

  // Nível 2 — Palavra-chave (primeira palavra significativa ≥4 chars)
  const hWord = _sigWord(hSlug);
  const aWord = _sigWord(aSlug);

  const kwMatch = entries.find(e =>
    e.home.startsWith(hWord) && e.away.includes(aWord)
  );
  if (kwMatch) return kwMatch.url;

  // Nível 2b — Também tenta invertendo (palavras-chave mais curtas)
  const kwMatch2 = entries.find(e =>
    e.home.includes(hWord) && e.away.startsWith(aWord)
  );
  if (kwMatch2) return kwMatch2.url;

  // Nível 3 — Fragmento de 5 chars (apelidos: "atletico" vs "atlet", "manchest" vs "man-city")
  const hFrag = hSlug.replace(/-/g, '').slice(0, 6);
  const aFrag = aSlug.replace(/-/g, '').slice(0, 6);

  const fragMatch = entries.find(e => {
    const ek_h = e.home.replace(/-/g, '');
    const ek_a = e.away.replace(/-/g, '');
    return ek_h.startsWith(hFrag) && ek_a.startsWith(aFrag);
  });
  if (fragMatch) return fragMatch.url;

  // Nível 4 — altNames da API (matchName como "Flamengo · Palmeiras")
  const hNorm = homeTeam.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const aNorm = awayTeam.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const altMatch = entries.find(e =>
    e.altNames?.some(n => {
      const nn = n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return nn.includes(hNorm.split(/\s/)[0]) && nn.includes(aNorm.split(/\s/)[0]);
    })
  );
  if (altMatch) return altMatch.url;

  return null;
}

/**
 * Diagnóstico: lista todas as partidas no cache.
 * @param {'prelive'|'live'} type
 */
export function listCachedMatches(type = 'prelive') {
  const cache   = _readCache();
  const section = cache[type] || { refreshed_at: 0, entries: [] };
  const age     = Math.round((Date.now() - section.refreshed_at) / 1000);
  return {
    type,
    refreshed_at: new Date(section.refreshed_at).toISOString(),
    age_seconds:  age,
    count:        section.entries.length,
    entries:      section.entries,
  };
}
