/**
 * 365scores Scraper
 * Fonte: https://www.365scores.com/pt-br
 * Fornece: escalações, estatísticas detalhadas, forma recente, notícias e probabilidades
 *
 * NOTA: Odds de mercado são coletadas exclusivamente via Superbet (superbet.bet.br/apostas/futebol/hoje)
 * Este scraper é responsável por dados contextuais, não por preços de apostas.
 */

import { chromium } from 'playwright';
import chalk from 'chalk';

const BASE = 'https://www.365scores.com/pt-br';
const TIMEOUT = 15000;

// ── Buscar partidas de futebol do dia ─────────────────────────────────────────
export async function get365Matches(date) {
  const dateStr = date || new Date().toISOString().split('T')[0];
  console.log(chalk.cyan(`  [365scores] Buscando partidas de ${dateStr}...`));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });
    await page.goto(`${BASE}/futebol`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.locator('[class*="cookie"], [id*="accept"]').click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const matches = await page.evaluate(() => {
      const results = [];

      document.querySelectorAll('[class*="game-"], [data-testid*="game"]').forEach((el) => {
        try {
          const homeEl = el.querySelector('[class*="home"] [class*="name"], [class*="team-home"] [class*="team-name"]');
          const awayEl = el.querySelector('[class*="away"] [class*="name"], [class*="team-away"] [class*="team-name"]');
          const timeEl = el.querySelector('[class*="time"], [class*="start-time"]');
          const compEl = el.querySelector('[class*="competition"], [class*="league"]');
          const linkEl = el.querySelector('a');

          if (!homeEl || !awayEl) return;

          const timeText = timeEl?.textContent?.trim() || '';
          if (!timeText.match(/^\d{2}:\d{2}$/)) return;

          results.push({
            home_team: homeEl.textContent.trim(),
            away_team: awayEl.textContent.trim(),
            match_time: timeText,
            competition: compEl?.textContent?.trim() || '',
            url: linkEl?.href || '',
            source: '365scores',
          });
        } catch { /* ignora */ }
      });

      return results;
    });

    return matches;
  } catch (err) {
    console.warn(chalk.yellow(`  [365scores] Erro ao listar: ${err.message}`));
    return [];
  } finally {
    await page.close();
    await browser.close();
  }
}

// ── Detalhes de uma partida específica ───────────────────────────────────────
export async function get365MatchDetails(matchUrl) {
  if (!matchUrl) return null;
  console.log(chalk.cyan(`  [365scores] Coletando detalhes...`));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // Tentar clicar na aba de estatísticas/H2H
    await page.locator('[class*="stats"], [data-type="stats"]').click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      // Stats da partida
      const stats = {};
      document.querySelectorAll('[class*="stat-row"], [class*="statistic-row"]').forEach((row) => {
        const name  = row.querySelector('[class*="name"]')?.textContent?.trim();
        const home  = row.querySelector('[class*="home"]')?.textContent?.trim();
        const away  = row.querySelector('[class*="away"]')?.textContent?.trim();
        if (name && home && away) stats[name] = { home, away };
      });

      // Probabilidades exibidas pelo próprio site (não odds de casa de aposta)
      const probs = {};
      document.querySelectorAll('[class*="prediction"] [class*="value"], [class*="percentage"]').forEach((el) => {
        const label = el.closest('[class*="item"]')?.querySelector('[class*="label"]')?.textContent?.trim();
        if (label) probs[label] = el.textContent?.trim();
      });

      // Forma recente
      const homeForm = [];
      const awayForm = [];
      document.querySelectorAll('[class*="home-form"] [class*="result"]').forEach((el) => homeForm.push(el.textContent?.trim()));
      document.querySelectorAll('[class*="away-form"] [class*="result"]').forEach((el) => awayForm.push(el.textContent?.trim()));

      return { stats, probs, homeForm: homeForm.slice(0, 6), awayForm: awayForm.slice(0, 6) };
    });

    // Tentar clicar na aba H2H
    await page.locator('[class*="h2h"], [data-type="h2h"]').click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const h2hData = await page.evaluate(() => {
      const h2h = [];
      document.querySelectorAll('[class*="h2h"] [class*="game"], [class*="head-to-head"] [class*="match"]').forEach((el) => {
        const home  = el.querySelector('[class*="home"] [class*="name"]')?.textContent?.trim();
        const away  = el.querySelector('[class*="away"] [class*="name"]')?.textContent?.trim();
        const score = el.querySelector('[class*="score"]')?.textContent?.trim()?.replace(/\s/g, '');
        if (home && away && score) h2h.push({ home, away, score });
      });
      return h2h.slice(0, 8);
    });

    return {
      source: '365scores',
      stats: data.stats,
      probabilities: data.probs,  // probabilidades do site, não odds de aposta
      home_form: parseFormArray(data.homeForm),
      away_form: parseFormArray(data.awayForm),
      h2h: h2hData,
    };
  } catch (err) {
    console.warn(chalk.yellow(`  [365scores] Erro nos detalhes: ${err.message}`));
    return null;
  } finally {
    await page.close();
    await browser.close();
  }
}

// ── Buscar escalação das equipes ──────────────────────────────────────────────
export async function get365Lineup(matchUrl) {
  if (!matchUrl) return null;
  console.log(chalk.cyan(`  [365scores] Coletando escalação...`));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage();

  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // Clicar na aba de escalação
    await page.locator('[class*="lineup"], [data-type="lineup"], [href*="lineup"]').click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);

    return await page.evaluate(() => {
      const extractPlayers = (side) => {
        const players = [];
        document.querySelectorAll(`[class*="${side}"] [class*="player-name"], [class*="${side}"] [class*="member-name"]`).forEach((el) => {
          const name = el.textContent?.trim();
          if (name && name.length > 2) players.push(name);
        });
        return players.slice(0, 11);
      };

      const home = extractPlayers('home');
      const away = extractPlayers('away');

      // Formação tática
      const formations = document.querySelectorAll('[class*="formation"]');
      const homeFormation = formations[0]?.textContent?.trim() || null;
      const awayFormation = formations[1]?.textContent?.trim() || null;

      return {
        home_players:    home,
        away_players:    away,
        home_formation:  homeFormation,
        away_formation:  awayFormation,
      };
    });
  } catch (err) {
    console.warn(chalk.yellow(`  [365scores] Erro na escalação: ${err.message}`));
    return null;
  } finally {
    await page.close();
    await browser.close();
  }
}

// ── Buscar notícias e análise pré-jogo ─────────────────────────────────────────
export async function get365News(matchUrl) {
  if (!matchUrl) return null;
  console.log(chalk.cyan(`  [365scores] Coletando notícias...`));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page    = await browser.newPage();

  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(1500);

    return await page.evaluate(() => {
      const news = [];
      document.querySelectorAll('[class*="article"], [class*="news-item"], [class*="preview"]').forEach((el) => {
        const title = el.querySelector('[class*="title"], h1, h2, h3')?.textContent?.trim();
        const body  = el.querySelector('[class*="body"], [class*="content"], p')?.textContent?.trim();
        if (title && title.length > 10) news.push({ title, body: body?.slice(0, 200) || '' });
      });
      return news.slice(0, 5); // máximo 5 notícias
    });
  } catch {
    return null;
  } finally {
    await page.close();
    await browser.close();
  }
}

// ── Buscar probabilidades e estatísticas do site ──────────────────────────────
export async function get365Predictions(matchUrl) {
  if (!matchUrl) return null;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    return await page.evaluate(() => {
      const preds = {};

      // Probabilidades exibidas pelo site (1X2, BTTS, Over/Under)
      document.querySelectorAll('[class*="prediction"] [class*="value"], [class*="percentage"]').forEach((el) => {
        const label = el.closest('[class*="item"]')?.querySelector('[class*="label"]')?.textContent?.trim();
        if (label) preds[label] = el.textContent?.trim();
      });

      // xG esperado pelo site
      const xgEls = document.querySelectorAll('[class*="xg"], [class*="expected-goal"]');
      if (xgEls.length >= 2) {
        preds.xg_home = xgEls[0]?.textContent?.trim();
        preds.xg_away = xgEls[1]?.textContent?.trim();
      }

      // Média de gols dos últimos jogos exibida pelo site
      document.querySelectorAll('[class*="average"] [class*="value"], [class*="stat-average"]').forEach((el) => {
        const label = el.closest('[class*="item"], [class*="row"]')?.querySelector('[class*="label"], [class*="name"]')?.textContent?.trim();
        if (label) preds[`avg_${label}`] = el.textContent?.trim();
      });

      return Object.keys(preds).length ? preds : null;
    });
  } catch {
    return null;
  } finally {
    await page.close();
    await browser.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseFormArray(arr) {
  return arr.map((r) => {
    const u = r?.toUpperCase();
    if (u === 'V' || u === 'W') return 'W';
    if (u === 'E' || u === 'D') return 'D';
    if (u === 'D' || u === 'L') return 'L';
    return null;
  }).filter(Boolean).join('');
}

// NOTA: parseOdds365 foi removida — odds de mercado vêm de superbet.bet.br
// Este scraper fornece: escalações, estatísticas, forma recente, notícias e probabilidades do site
