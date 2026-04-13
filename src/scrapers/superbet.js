/**
 * Superbet Scraper — superbet.bet.br
 *
 * Responsabilidades:
 *  1. Filtrar jogos ao vivo por competição (whitelist + bloqueio de ligas menores)
 *  2. Buscar odds pré-jogo via Playwright para análises pré-live
 *
 * Estratégia de filtro LIVE (duas camadas, sem dependência de browser):
 *  Camada 1 — BLOQUEIO por padrão de nome (imediato):
 *    "reserves", "sub-17", "u21", "amador", etc. → sempre bloqueado
 *  Camada 2 — WHITELIST de competições conhecidas na Superbet:
 *    Apenas ligas que a Superbet oferece ao vivo → liberado
 *    Tudo fora da whitelist → bloqueado (fail-closed)
 */

import { chromium } from 'playwright';
import chalk from 'chalk';

const BASE_URL    = 'https://superbet.bet.br';
const SPORT_URL   = `${BASE_URL}/apostas-esportivas/futebol`;
const TIMEOUT     = 20_000;
const NAV_TIMEOUT = 30_000;

// ── Helper de normalização ─────────────────────────────────────────────────────
function _norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Camada 1: Padrões que BLOQUEIAM imediatamente ─────────────────────────────
// Qualquer competição cujo nome contenha estes termos é bloqueada
const BLOCK_PATTERNS = [
  'reserve', 'reserva', 'reservas',
  'sub-', ' sub ', 'sub17', 'sub18', 'sub19', 'sub20', 'sub21', 'sub23',
  'u17', 'u18', 'u19', 'u20', 'u21', 'u23',
  'youth', 'juvenil', 'junior', 'junior',
  'amateur', 'amador', 'amadora',
  'regional', 'division 3', 'division 4', 'div 3', 'div 4',
  '3rd division', '4th division', 'terceira', 'quarta divisao',
  'friendly', 'amistoso', 'copa regional',
  'segunda divisao b', 'terceira liga',
];

// ── Camada 2: Whitelist de competições disponíveis na Superbet ────────────────
// Baseado no catálogo oficial do site — atualizar conforme necessário
const SUPERBET_COMPETITIONS = [
  // ── Brasil ────────────────────────────────────────────────────────────────
  'brasileirao', 'serie a', 'serie b', 'serie c',
  'copa do brasil', 'campeonato brasileiro',
  'campeonato carioca', 'campeonato paulista', 'campeonato mineiro',
  'campeonato gaucho', 'campeonato pernambucano', 'campeonato baiano',
  'supercopa do brasil',
  // ── Europa — Top 5 ────────────────────────────────────────────────────────
  'premier league', 'english premier league',
  'la liga', 'primera division', 'laliga',
  'bundesliga', '2 bundesliga', '2. bundesliga',
  'serie a', 'serie b',   // Italy
  'ligue 1', 'ligue 2',
  // ── Europa — Copas ────────────────────────────────────────────────────────
  'champions league', 'uefa champions league',
  'europa league', 'uefa europa league',
  'conference league', 'uefa conference league',
  // ── Europa — Outros ───────────────────────────────────────────────────────
  'liga portugal', 'primeira liga', 'liga nos', 'liga bwin',
  'eredivisie',
  'super lig', 'turkish super lig',
  'scottish premiership',
  'jupiler pro league', 'belgian pro league',
  'championship', 'english championship',
  'swiss super league',
  'austrian bundesliga',
  'danish superliga',
  'norwegian eliteserien',
  'swedish allsvenskan',
  'portuguese primera liga',
  'greek super league',
  'romanian liga 1',
  'czech first league',
  'russian premier league', 'rpl',
  'ukrainian premier league',
  'polish ekstraklasa',
  'croatian primeira liga', 'hnl',
  'serbian superliga',
  'slovenian prvaliga',
  // ── América do Sul ────────────────────────────────────────────────────────
  'copa libertadores', 'conmebol libertadores',
  'copa sudamericana', 'conmebol sudamericana',
  'recopa sudamericana',
  'superliga argentina', 'liga profesional argentina',
  'primera division argentina',
  'torneo betano', 'clausura', 'apertura',
  'uruguayan primera', 'primera division uruguaya',
  'chilean primera division', 'primera division chile',
  'colombian primera a', 'liga betplay',
  'ecuadorian liga pro', 'liga pro',
  'peruvian liga 1',
  'bolivian division profesional',
  'paraguayan division profesional',
  'venezuelan primera division',
  // ── América do Norte e Central ────────────────────────────────────────────
  'mls', 'major league soccer',
  'liga mx', 'liga bbva mx',
  'concacaf champions cup', 'concacaf champions league',
  'concacaf league',
  'canadian premier league',
  // ── Ásia / Oriente Médio ──────────────────────────────────────────────────
  'saudi pro league', 'saudi professional league', 'roshn saudi league',
  'j1 league', 'j league',
  'k league', 'k league 1',
  'chinese super league',
  'a-league', 'australian a-league',
  'indian super league', 'isl',
  // ── Competições Internacionais ────────────────────────────────────────────
  'world cup', 'copa do mundo', 'fifa world cup',
  'euro', 'uefa euro',
  'copa america', 'conmebol copa america',
  'nations league', 'uefa nations league',
  'africa cup', 'afcon',
  'asian cup',
];

/**
 * Verifica se um jogo ao vivo deve ser analisado (está disponível na Superbet).
 * Não requer browser — usa apenas nome da competição.
 *
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {string} competition — nome da competição/liga
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkSuperbetLiveEligibility(homeTeam, awayTeam, competition) {
  const compNorm = _norm(competition || '');

  // Camada 1: Bloqueio imediato por padrão
  for (const pattern of BLOCK_PATTERNS) {
    if (compNorm.includes(pattern)) {
      return { allowed: false, reason: `liga bloqueada (${pattern})` };
    }
  }

  // Camada 2: Verifica whitelist
  const onWhitelist = SUPERBET_COMPETITIONS.some((comp) => {
    const compW = _norm(comp);
    return compNorm.includes(compW) || compW.includes(compNorm.split(' ')[0]);
  });

  if (onWhitelist) {
    return { allowed: true, reason: 'competição na whitelist Superbet' };
  }

  // Fora da whitelist → bloqueado (fail-closed)
  return { allowed: false, reason: `competição não cadastrada na Superbet (${competition || 'desconhecida'})` };
}

/**
 * Compatibilidade retroativa — aceita array de matches do cache antigo.
 * Agora delega para checkSuperbetLiveEligibility usando o campo competition.
 */
export function isMatchOnSuperbet(homeTeam, awayTeam, superbetMatches, competition) {
  const result = checkSuperbetLiveEligibility(homeTeam, awayTeam, competition);
  return result.allowed;
}

/**
 * Stub de compatibilidade — já não é necessário abrir browser para filtro live.
 * Retorna array vazio (o filtro agora é feito por competição, não por scraping).
 */
export async function getLiveSuperbetMatches() {
  return [];
}

// ── Mapa completo de eventos Superbet (1 sessão Playwright) ──────────────────
/**
 * Abre UMA sessão Playwright, intercepta a resposta da API `by-date` e devolve
 * um Map com todas as partidas disponíveis: chave = "homeSlug-awaySlug", valor = URL.
 *
 * Use para enriquecer múltiplas pernas de parlay de uma vez.
 *
 * @returns {Promise<Map<string,string>>}
 */
export async function getSuperbetEventMap() {
  let browser = null;
  const eventMap = new Map();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      locale: 'pt-BR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    let resolved = false;
    const done = new Promise((res) => {
      context.on('response', async (resp) => {
        try {
          if (!resp.url().includes('/events/by-date')) return;
          const ct = resp.headers()['content-type'] || '';
          if (!ct.includes('json')) return;
          const body = await resp.json().catch(() => null);
          if (!body?.data?.length) return;

          for (const ev of body.data) {
            const id    = ev.eventId || ev.offerId;
            const mn    = ev.matchName || '';
            const parts = mn.split('·');
            if (parts.length < 2 || !id) continue;
            const hSlug = _teamSlug(parts[0]);
            const aSlug = _teamSlug(parts[1]);
            const url   = `https://superbet.bet.br/odds/futebol/${hSlug}-x-${aSlug}-${id}`;
            eventMap.set(`${hSlug}-${aSlug}`, url);
            eventMap.set(mn.toLowerCase(), url); // índice extra por matchName
          }
          if (!resolved) { resolved = true; res(); }
        } catch {}
      });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    await page.goto('https://superbet.bet.br/apostas/futebol', {
      waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT,
    });
    await page.locator('button:has-text("Aceitar"), [id*="accept"]')
      .first().click({ timeout: 4_000 }).catch(() => {});

    await Promise.race([done, new Promise((r) => setTimeout(r, 10_000))]);

    console.log(chalk.green(`  [Superbet] Mapa: ${eventMap.size / 2} partidas indexadas`));
  } catch (err) {
    console.log(chalk.gray(`  [Superbet] Erro no mapa: ${err.message}`));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return eventMap;
}

/**
 * Busca URL de uma partida específica no mapa de eventos.
 * @param {Map<string,string>} eventMap  - Resultado de getSuperbetEventMap()
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @returns {string|null}
 */
export function findUrlInEventMap(eventMap, homeTeam, awayTeam) {
  const hSlug = _teamSlug(homeTeam);
  const aSlug = _teamSlug(awayTeam);
  return eventMap.get(`${hSlug}-${aSlug}`) || null;
}

// ── Mapa completo de eventos AO VIVO no Superbet ─────────────────────────────

const LIVE_PAGE_URL = 'https://superbet.bet.br/apostas/ao-vivo';

/**
 * Abre UMA sessão Playwright em apostas/ao-vivo e constrói um Map com TODOS
 * os jogos ao vivo disponíveis usando URLs reais extraídas do DOM.
 *
 * Estratégia (ordem de prioridade):
 *  1. DOM principal: extrai <a href> reais renderizados pelo SPA — URL autoritativa
 *  2. API (secundária): enriquece com matchNames alternativos para melhor lookup
 *     ⚠️  URLs construídas via API NÃO são usadas — o formato correto só existe no DOM
 *
 * @returns {Promise<Map<string,string>>}  chave = "homeSlug-awaySlug" | matchName, valor = URL direta
 */
export async function getSuperbetLiveEventMap() {
  let browser = null;
  const eventMap = new Map();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      locale: 'pt-BR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    // ── Intercepta API apenas para enriquecer matchNames (NÃO gera URLs) ─────────
    // Mapa auxiliar: eventId → { hSlug, aSlug, matchName }
    const apiNames = new Map();
    context.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('json')) return;

        const body = await resp.json().catch(() => null);
        if (!body) return;

        const events = Array.isArray(body) ? body
          : (body.data || body.events || body.liveEvents || body.matches || []);
        if (!Array.isArray(events) || events.length < 2) return;

        for (const ev of events) {
          const id   = String(ev.eventId || ev.offerId || ev.id || '');
          const mn   = ev.matchName || ev.name || ev.eventName || '';
          if (!id || !mn) continue;

          const parts = mn.split('·');
          if (parts.length < 2) continue;

          const hSlug = _teamSlug(parts[0]);
          const aSlug = _teamSlug(parts[1]);
          if (!hSlug || !aSlug) continue;

          apiNames.set(id, { hSlug, aSlug, matchName: mn });
        }
      } catch {}
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    await page.goto(LIVE_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.locator('button:has-text("Aceitar"), [id*="accept"]')
      .first().click({ timeout: 4_000 }).catch(() => {});

    // Aguarda SPA renderizar completamente (~10s para carregar jogos ao vivo)
    await new Promise((r) => setTimeout(r, 10_000));

    // ── PRIMÁRIO: extrai hrefs reais do DOM (único formato garantido correto) ─────
    const domLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.href)
        .filter((h) => /[a-z0-9-]+-x-[a-z0-9-]+-\d+/.test(h))
    );

    let added = 0;
    for (const href of domLinks) {
      const m = href.match(/([a-z0-9-]+)-x-([a-z0-9-]+)-(\d+)/);
      if (!m) continue;
      const [, hSlug, aSlug, id] = m;
      const key = `${hSlug}-${aSlug}`;

      if (eventMap.has(key)) continue; // já mapeado (evita duplicatas)
      eventMap.set(key, href);

      // Enriquece com matchName da API se disponível (chave alternativa de lookup)
      const apiInfo = apiNames.get(id);
      if (apiInfo?.matchName) {
        eventMap.set(apiInfo.matchName.toLowerCase(), href);
      }
      added++;
    }

    if (added === 0) {
      console.log(chalk.yellow('  [Superbet Live] Nenhum link DOM encontrado — SPA pode não ter renderizado'));
    } else {
      console.log(chalk.green(`  [Superbet Live] ${added} partidas ao vivo mapeadas (${eventMap.size} entradas totais)`));
    }

  } catch (err) {
    console.log(chalk.gray(`  [Superbet Live] Erro no mapa: ${err.message}`));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return eventMap;
}

/**
 * Busca URL ao vivo de uma partida específica no mapa live.
 * Usa a mesma lógica de slug que findUrlInEventMap.
 * @param {Map<string,string>} liveMap - Resultado de getSuperbetLiveEventMap()
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @returns {string|null}
 */
export function findUrlInLiveMap(liveMap, homeTeam, awayTeam) {
  const hSlug = _teamSlug(homeTeam);
  const aSlug = _teamSlug(awayTeam);

  // 1. Correspondência exata (chave = hSlug + aSlug combinados)
  const exact = liveMap.get(`${hSlug}-${aSlug}`);
  if (exact) return exact;

  // 2. Fuzzy — Superbet usa abreviações (ex: "atletico-mg" vs "atletico-mineiro", "new-york-rb" vs "new-york-red-bulls")
  // Extrai a primeira palavra significativa de cada slug (≥4 chars) para matching parcial
  const hWord = hSlug.split('-').find(w => w.length >= 4) ?? hSlug.slice(0, 5);
  const aWord = aSlug.split('-').find(w => w.length >= 4) ?? aSlug.slice(0, 5);

  for (const [key, url] of liveMap) {
    // Só testa chaves no formato slug (sem barra) — exclui matchNames da API
    if (key.includes('/') || key.includes('·')) continue;
    // Chave começa com hWord E contém aWord → match parcial
    if (key.startsWith(hWord) && key.includes(aWord)) return url;
  }

  return null;
}

// ── Buscar URL direta de uma partida no Superbet ─────────────────────────────

/** Converte nome de time para slug de URL (ex: "Atlético Mineiro" → "atletico-mineiro") */
function _teamSlug(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // remove acentos
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

/**
 * Retorna a URL direta da partida no superbet.bet.br.
 * Usa Playwright para interceptar a API `by-date` que o próprio site chama,
 * extrai o eventId pelo matchName e constrói a URL.
 *
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @returns {Promise<string|null>}
 */
export async function getSuperbetMatchDirectUrl(homeTeam, awayTeam) {
  const norm = (s) => _norm(s || '');
  const homeN = norm(homeTeam);
  const awayN = norm(awayTeam);

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      locale: 'pt-BR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    // ── Estratégia 1: interceptar API by-date ────────────────────────────────
    let resolveEvent = null;
    const eventPromise = new Promise((res) => { resolveEvent = res; });

    context.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (!url.includes('/events/by-date') && !url.includes('/events/top-list')) return;
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const body = await resp.json().catch(() => null);
        if (!body) return;

        const events = body.data || body.topMatches || [];
        // top-list retorna array de IDs; by-date retorna array de objetos
        if (Array.isArray(events) && typeof events[0] === 'number') return; // top-list — pula

        const match = events.find((e) => {
          const mn = norm(e.matchName || '');
          return mn.includes(homeN.split(' ')[0]) && mn.includes(awayN.split(' ')[0]);
        });
        if (match) resolveEvent(match);
      } catch {}
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // Navega para a página de futebol de hoje E amanhã (garante ambos os dias)
    await page.goto('https://superbet.bet.br/apostas/futebol', {
      waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT,
    });
    await page.locator('button:has-text("Aceitar"), [id*="accept"]')
      .first().click({ timeout: 4_000 }).catch(() => {});

    // Espera até 8s pelo evento correto via interceptação de API
    const foundEvent = await Promise.race([
      eventPromise,
      new Promise((res) => setTimeout(() => res(null), 8_000)),
    ]);

    if (foundEvent) {
      const id       = foundEvent.eventId || foundEvent.offerId;
      const mn       = foundEvent.matchName || '';
      const parts    = mn.split('·');
      const hSlug    = _teamSlug(parts[0] || homeTeam);
      const aSlug    = _teamSlug(parts[1] || awayTeam);
      const matchUrl = `https://superbet.bet.br/odds/futebol/${hSlug}-x-${aSlug}-${id}`;
      console.log(chalk.green(`  [Superbet] Link direto (API): ${matchUrl}`));
      return matchUrl;
    }

    // ── Estratégia 2: varredura de links na página ───────────────────────────
    await page.waitForTimeout(3_000);
    const linkUrl = await _findMatchUrl(page, homeTeam, awayTeam);
    if (linkUrl) {
      console.log(chalk.green(`  [Superbet] Link direto (DOM): ${linkUrl}`));
      return linkUrl;
    }

    console.log(chalk.gray(`  [Superbet] Link não encontrado para ${homeTeam} vs ${awayTeam}`));
    return null;
  } catch (err) {
    console.log(chalk.gray(`  [Superbet] Erro ao buscar link: ${err.message}`));
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Buscar odds pré-jogo via Playwright ───────────────────────────────────────
/**
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {string} [matchDate]
 * @returns {object} odds{}
 */
export async function getSuperbetOdds(homeTeam, awayTeam, matchDate = null) {
  const label = `${homeTeam} vs ${awayTeam}`;
  console.log(chalk.cyan(`  [Superbet] Buscando odds: ${label}...`));

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      locale: 'pt-BR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    await page.goto(SPORT_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await page.locator('button:has-text("Aceitar"), button:has-text("Concordo"), [id*="accept"], [class*="accept-cookie"]')
      .first().click({ timeout: 4_000 }).catch(() => {});

    await page.waitForTimeout(2_000);

    const matchUrl = await _findMatchUrl(page, homeTeam, awayTeam);
    if (!matchUrl) {
      console.log(chalk.gray(`  [Superbet] Partida não encontrada: ${label}`));
      return {};
    }

    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(2_500);

    const odds = await _collectOdds(page);

    if (Object.keys(odds).length) {
      console.log(chalk.green(`  [Superbet] ✅ Odds coletadas: ${Object.keys(odds).join(', ')}`));
    }

    return odds;
  } catch (err) {
    console.log(chalk.gray(`  [Superbet] Erro ao buscar odds: ${err.message}`));
    return {};
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Buscar odds em lote ───────────────────────────────────────────────────────
export async function getSuperbetOddsBatch(matches) {
  if (!matches?.length) return new Map();

  const results = new Map();
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      locale: 'pt-BR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    await page.goto(SPORT_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.locator('button:has-text("Aceitar"), [id*="accept"]')
      .first().click({ timeout: 4_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    for (const match of matches) {
      const { home_team, away_team } = match;
      const key = `${home_team}_${away_team}`;
      try {
        const matchUrl = await _findMatchUrl(page, home_team, away_team);
        if (!matchUrl) { results.set(key, {}); continue; }

        await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(1_500);

        const odds = await _collectOdds(page);
        results.set(key, odds);

        if (Object.keys(odds).length) {
          console.log(chalk.green(`  [Superbet] ✅ ${home_team} vs ${away_team}: ${Object.keys(odds).length} mercados`));
        }

        await page.goto(SPORT_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
        await page.waitForTimeout(1_000);
      } catch {
        results.set(key, {});
      }
    }
  } catch (err) {
    console.log(chalk.red(`  [Superbet] Erro no browser batch: ${err.message}`));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return results;
}

// ── Helpers internos ──────────────────────────────────────────────────────────
async function _findMatchUrl(page, homeTeam, awayTeam) {
  try {
    await page.waitForSelector('[class*="event"], [class*="match"], [class*="game"]', { timeout: 8_000 }).catch(() => {});

    return await page.evaluate(([home, away]) => {
      const norm = (s) => (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '').trim();

      const homeN = norm(home);
      const awayN = norm(away);

      const links = Array.from(document.querySelectorAll('a[href*="futebol"], a[href*="evento"], a[href*="event"]'));
      for (const link of links) {
        const text = norm(link.textContent || '');
        const homeHit = homeN.split(' ').some((w) => w.length > 3 && text.includes(w));
        const awayHit = awayN.split(' ').some((w) => w.length > 3 && text.includes(w));
        if (homeHit && awayHit) return link.href;
      }

      const allEls = Array.from(document.querySelectorAll('[class*="event-name"], [class*="match-name"], [class*="teams"]'));
      for (const el of allEls) {
        const text = norm(el.textContent || '');
        const homeHit = homeN.split(' ').some((w) => w.length > 3 && text.includes(w));
        const awayHit = awayN.split(' ').some((w) => w.length > 3 && text.includes(w));
        if (homeHit && awayHit) {
          const parentLink = el.closest('a');
          if (parentLink?.href) return parentLink.href;
        }
      }
      return null;
    }, [homeTeam, awayTeam]);
  } catch {
    return null;
  }
}

async function _collectOdds(page) {
  try {
    await page.waitForSelector('[class*="odd"], [class*="bet-button"], [class*="market"]', { timeout: 8_000 }).catch(() => {});

    return await page.evaluate(() => {
      const result = {};
      const norm = (s) => (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ').trim();
      const toFloat = (s) => {
        const n = parseFloat((s || '').replace(',', '.'));
        return isNaN(n) || n < 1.01 ? null : Math.round(n * 100) / 100;
      };

      const marketBlocks = Array.from(document.querySelectorAll(
        '[class*="market"], [class*="betting-market"], [class*="offer-group"], [class*="section"]'
      ));

      for (const block of marketBlocks) {
        const title = norm(block.querySelector('[class*="title"], [class*="header"], [class*="name"]')?.textContent || '');
        if (!title) continue;

        const buttons = Array.from(block.querySelectorAll(
          '[class*="odd"], [class*="bet-button"], [class*="selection"], button[class*="pick"]'
        ));

        const labelOdds = buttons.map((btn) => {
          const labelEl = btn.querySelector('[class*="label"], [class*="name"], span:first-child') || btn;
          const oddEl   = btn.querySelector('[class*="odd"], [class*="price"], [class*="value"], span:last-child') || btn;
          return { label: norm(labelEl.textContent || ''), odd: toFloat(oddEl.textContent) };
        }).filter((o) => o.odd !== null);

        if (title.includes('resultado final') || title.includes('1x2')) {
          for (const { label, odd } of labelOdds) {
            if (label === '1') result.home_win = odd;
            else if (label === 'x') result.draw = odd;
            else if (label === '2') result.away_win = odd;
          }
        }
        if (title.includes('dupla chance')) {
          for (const { label, odd } of labelOdds) {
            if (label === '1x') result.double_chance_1x = odd;
            else if (label === 'x2') result.double_chance_x2 = odd;
            else if (label === '12') result.double_chance_12 = odd;
          }
        }
        if (title.includes('total de gols') || title.includes('over') || title.includes('gols na partida')) {
          for (const { label, odd } of labelOdds) {
            if (label.includes('0.5')) { label.includes('mais') ? result.over_05  = odd : result.under_05  = odd; }
            else if (label.includes('1.5')) { label.includes('mais') ? result.over_15 = odd : result.under_15 = odd; }
            else if (label.includes('2.5')) { label.includes('mais') ? result.over_25 = odd : result.under_25 = odd; }
            else if (label.includes('3.5')) { label.includes('mais') ? result.over_35 = odd : result.under_35 = odd; }
            else if (label.includes('4.5')) { label.includes('mais') ? result.over_45 = odd : result.under_45 = odd; }
          }
        }
        if (title.includes('ambas marcam') || title.includes('ambos marcam') || title.includes('btts')) {
          for (const { label, odd } of labelOdds) {
            if (label === 'sim') result.btts_yes = odd;
            else if (label === 'nao') result.btts_no = odd;
          }
        }
      }
      return result;
    });
  } catch {
    return {};
  }
}
