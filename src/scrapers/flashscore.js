/**
 * FlashScore Scraper — usa Playwright para coletar:
 * - Partidas do dia / próximas horas
 * - Últimos 5 jogos de cada time (forma recente)
 * - Histórico H2H
 * - Horário, competição, times
 */

import { chromium } from 'playwright';
import chalk from 'chalk';

const BASE = 'https://www.flashscore.com.br';
const TIMEOUT = 15000;
const HEADLESS = process.env.HEADLESS !== 'false'; // padrão: invisível

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserInstance;
}

export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// ─────────────────────────────────────────────
// 1. LISTAR PARTIDAS PRÓXIMAS (próximas N horas)
// ─────────────────────────────────────────────
export async function getUpcomingMatches(hoursAhead = 12) {
  console.log(chalk.cyan(`🌐 [FlashScore] Buscando partidas das próximas ${hoursAhead}h...`));

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });
    await page.goto(`${BASE}/futebol/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

    // Fechar cookie banner se existir
    await page.locator('[id*="onetrust-accept"]').click({ timeout: 3000 }).catch(() => {});

    // Aguardar carregamento dos jogos
    await page.waitForSelector('.event__match', { timeout: TIMEOUT }).catch(() => {});

    const matches = await page.evaluate((hoursAhead) => {
      const now = Date.now();
      const limit = now + hoursAhead * 3600000;
      const results = [];

      document.querySelectorAll('.event__match--twoLine, .event__match').forEach((el) => {
        try {
          const timeEl = el.querySelector('.event__time');
          const homeEl = el.querySelector('.event__participant--home');
          const awayEl = el.querySelector('.event__participant--away');
          const idAttr = el.id || '';

          if (!timeEl || !homeEl || !awayEl) return;

          const timeText = timeEl.textContent.trim();
          if (!timeText.match(/^\d{2}:\d{2}$/)) return; // ignora FT, HT, etc.

          const [h, m] = timeText.split(':').map(Number);
          const matchDate = new Date();
          matchDate.setHours(h, m, 0, 0);
          if (matchDate.getTime() < now) matchDate.setDate(matchDate.getDate() + 1); // amanhã

          if (matchDate.getTime() > limit) return;

          // ID do jogo vem do atributo id do elemento ou do link
          const link = el.querySelector('a');
          const href = link?.href || '';
          const matchId = idAttr.replace('g_1_', '') ||
                          href.match(/\?mid=([^&]+)/)?.[1] || null;

          // Competição vem do header acima
          let competition = 'Desconhecida';
          let prev = el.previousElementSibling;
          while (prev) {
            if (prev.classList.contains('event__header')) {
              competition = prev.querySelector('.event__title--type')?.textContent?.trim() || 'Desconhecida';
              break;
            }
            prev = prev.previousElementSibling;
          }

          results.push({
            match_id: matchId,
            home_team: homeEl.textContent.trim(),
            away_team: awayEl.textContent.trim(),
            match_time: timeText,
            match_date: matchDate.toISOString(),
            competition,
            url: href,
          });
        } catch { /* ignora erros de elemento */ }
      });

      return results;
    }, hoursAhead);

    console.log(chalk.green(`✅ ${matches.length} partidas encontradas.`));
    return matches;
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────
// 2. DETALHES COMPLETOS DE UMA PARTIDA
// ─────────────────────────────────────────────
export async function getMatchDetails(matchUrl) {
  console.log(chalk.cyan(`🌐 [FlashScore] Coletando detalhes: ${matchUrl}`));

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.locator('[id*="onetrust-accept"]').click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Informações básicas da partida
    const matchInfo = await page.evaluate(() => {
      const home = document.querySelector('.duelParticipant__home .participant__participantName')?.textContent?.trim()
                || document.querySelector('.duelParticipant__home')?.textContent?.trim();
      const away = document.querySelector('.duelParticipant__away .participant__participantName')?.textContent?.trim()
                || document.querySelector('.duelParticipant__away')?.textContent?.trim();
      const timeEl = document.querySelector('.duelParticipant__startTime');
      const compEl = document.querySelector('[class*="tournamentHeader__country"]');
      const venueEl = document.querySelector('[class*="stadiumInfo"]') ||
                      document.querySelector('[class*="matchInfoContainer"] span');

      return {
        home_team: home || 'N/A',
        away_team: away || 'N/A',
        match_time: timeEl?.textContent?.trim() || 'N/A',
        competition: compEl?.textContent?.replace(/[:\n]/g, ' ')?.trim() || 'N/A',
        venue: venueEl?.textContent?.trim() || null,
      };
    });

    // Navegar para aba H2H
    const h2hData = await scrapeH2H(page, matchUrl);

    // Forma recente (extraída do H2H — seção de últimos jogos)
    const homeForm = extractFormFromH2H(h2hData.home_last, matchInfo.home_team);
    const awayForm = extractFormFromH2H(h2hData.away_last, matchInfo.away_team);

    return {
      match: `${matchInfo.home_team} vs ${matchInfo.away_team}`,
      date: new Date().toISOString(),
      match_time: matchInfo.match_time,
      competition: matchInfo.competition,
      venue: matchInfo.venue,
      url: matchUrl,
      home: {
        team: matchInfo.home_team,
        form: homeForm.form_string,
        goals_scored_avg: homeForm.goals_scored_avg,
        goals_conceded_avg: homeForm.goals_conceded_avg,
        xg_avg: 0,
        clean_sheets: homeForm.clean_sheets,
        last_matches: h2hData.home_last,
      },
      away: {
        team: matchInfo.away_team,
        form: awayForm.form_string,
        goals_scored_avg: awayForm.goals_scored_avg,
        goals_conceded_avg: awayForm.goals_conceded_avg,
        xg_avg: 0,
        clean_sheets: awayForm.clean_sheets,
        last_matches: h2hData.away_last,
      },
      h2h: h2hData.h2h,
      odds: {}, // odds vêm de outra fonte (OddsAPI ou entrada manual)
      weather: null,
    };
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────
// 3. SCRAPE DA ABA H2H
// ─────────────────────────────────────────────
async function scrapeH2H(page, matchUrl) {
  const h2hUrl = matchUrl.includes('?')
    ? matchUrl.replace(/\?.*/, '') + '#/h2h/overall'
    : matchUrl + '#/h2h/overall';

  try {
    await page.goto(h2hUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // Scroll para carregar conteúdo lazy
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(1000);

    const data = await page.evaluate(() => {
      function parseRows(selector) {
        const rows = [];
        document.querySelectorAll(selector).forEach((row) => {
          try {
            const date = row.querySelector('.h2h__date')?.textContent?.trim() || '';
            const home = row.querySelector('.h2h__homeParticipant')?.textContent?.trim() || '';
            const away = row.querySelector('.h2h__awayParticipant')?.textContent?.trim() || '';
            const scoreEl = row.querySelector('.h2h__result');
            const score = scoreEl?.textContent?.trim()?.replace(/\s+/g, '') || '?-?';
            const [hg, ag] = score.split('-').map(Number);
            rows.push({ date, home, away, home_goals: hg || 0, away_goals: ag || 0, score });
          } catch { /* ignora */ }
        });
        return rows.slice(0, 10);
      }

      return {
        h2h: parseRows('.h2h__section:first-child .h2h__row'),
        home_last: parseRows('.h2h__section:nth-child(2) .h2h__row'),
        away_last: parseRows('.h2h__section:nth-child(3) .h2h__row'),
      };
    });

    return data;
  } catch {
    return { h2h: [], home_last: [], away_last: [] };
  }
}

// ─────────────────────────────────────────────
// 4. CALCULAR FORMA A PARTIR DOS JOGOS
// ─────────────────────────────────────────────
function extractFormFromH2H(matches, teamName) {
  if (!matches?.length) {
    return { form_string: 'N/A', goals_scored_avg: 1.3, goals_conceded_avg: 1.1, clean_sheets: 0 };
  }

  let totalScored = 0, totalConceded = 0, cleanSheets = 0;
  const formChars = [];

  for (const m of matches.slice(0, 5)) {
    const isHome = normalizeTeamName(m.home) === normalizeTeamName(teamName);
    const scored = isHome ? m.home_goals : m.away_goals;
    const conceded = isHome ? m.away_goals : m.home_goals;

    totalScored += scored;
    totalConceded += conceded;
    if (conceded === 0) cleanSheets++;

    if (scored > conceded) formChars.push('W');
    else if (scored === conceded) formChars.push('D');
    else formChars.push('L');
  }

  const n = matches.length;
  return {
    form_string: formChars.join('') || 'N/A',
    goals_scored_avg: Math.round((totalScored / n) * 10) / 10,
    goals_conceded_avg: Math.round((totalConceded / n) * 10) / 10,
    clean_sheets: cleanSheets,
  };
}

function normalizeTeamName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

// ─────────────────────────────────────────────
// 5. BATCH: coletar detalhes de múltiplas partidas
// ─────────────────────────────────────────────
export async function batchGetMatchDetails(matches, maxConcurrent = 2) {
  const results = [];

  for (let i = 0; i < matches.length; i += maxConcurrent) {
    const batch = matches.slice(i, i + maxConcurrent);
    const resolved = await Promise.allSettled(
      batch.map((m) => (m.url ? getMatchDetails(m.url) : Promise.reject(new Error('Sem URL'))))
    );
    for (let j = 0; j < resolved.length; j++) {
      if (resolved[j].status === 'fulfilled') {
        results.push({ ...resolved[j].value, match_time: batch[j].match_time });
      } else {
        console.error(chalk.red(`  ✗ ${batch[j].home_team} vs ${batch[j].away_team}: ${resolved[j].reason?.message}`));
      }
    }
    // Pausa entre batches para não sobrecarregar
    if (i + maxConcurrent < matches.length) await sleep(2000);
  }

  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
