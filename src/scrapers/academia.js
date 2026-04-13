/**
 * Academia das Apostas Brasil Scraper
 * Fonte: https://www.academiadasapostasbrasil.com/
 * Fornece: estatísticas de times, médias de gols, Over/Under histórico,
 * tendências de mercado, análises de value bet para ligas brasileiras e europeias
 */

import { chromium } from 'playwright';
import chalk from 'chalk';

const BASE = 'https://www.academiadasapostasbrasil.com';
const TIMEOUT = 15000;

// ── Browser singleton — evita abrir/fechar instância por chamada ──────────────
let _browser = null;

async function _getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  return _browser;
}

export async function closeAcademiaBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

async function _withPage(fn) {
  const browser = await _getBrowser();
  const page = await browser.newPage();
  try {
    return await fn(page);
  } catch (err) {
    // Se o browser crashou, reseta o singleton para forçar reconexão
    if (err.message?.includes('Target closed') || err.message?.includes('Protocol error')) {
      _browser = null;
    }
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Buscar estatísticas de um time ────────────────────────────────────────────
export async function getTeamStatsAcademia(teamName, competition) {
  console.log(chalk.cyan(`  [Academia] Buscando stats de "${teamName}"...`));

  try {
    return await _withPage(async (page) => {
      const searchUrl = `${BASE}/stats/teams?search=${encodeURIComponent(teamName)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(2000);

      const stats = await page.evaluate(() => {
        const result = {};

        document.querySelectorAll('table tr').forEach((row) => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            const label = cells[0]?.textContent?.trim();
            const value = cells[1]?.textContent?.trim();
            if (label && value) result[label] = value;
          }
        });

        const goalStats = {};
        document.querySelectorAll('[class*="goal"], [class*="stat"]').forEach((el) => {
          const label = el.querySelector('[class*="label"]')?.textContent?.trim();
          const val   = el.querySelector('[class*="value"]')?.textContent?.trim();
          if (label && val) goalStats[label] = val;
        });

        return { ...result, ...goalStats };
      });

      return parseAcademiaStats(stats, teamName);
    });
  } catch (err) {
    console.warn(chalk.yellow(`  [Academia] Erro em stats: ${err.message}`));
    return null;
  }
}

// ── Buscar análise de uma partida ─────────────────────────────────────────────
export async function getMatchAnalysisAcademia(homeTeam, awayTeam) {
  console.log(chalk.cyan(`  [Academia] Buscando análise: ${homeTeam} vs ${awayTeam}...`));

  try {
    return await _withPage(async (page) => {
      const query = `${homeTeam} ${awayTeam}`.replace(/\s+/g, '+');
      await page.goto(`${BASE}/previsoes?search=${query}`, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT,
      });
      await page.waitForTimeout(2000);

      const analysis = await page.evaluate((home, away) => {
        const normalize = (s) => s?.toLowerCase().replace(/\s+/g, '');
        const result = { found: false };

        document.querySelectorAll('[class*="match"], [class*="game"], [class*="prediction"]').forEach((card) => {
          const text = card.textContent?.toLowerCase() || '';
          if (text.includes(normalize(home)) || text.includes(normalize(away))) {
            result.found = true;
            const tip = card.querySelector('[class*="tip"], [class*="pick"]')?.textContent?.trim();
            if (tip) result.tip = tip;
            const odds = card.querySelector('[class*="odds"], [class*="odd"]')?.textContent?.trim();
            if (odds) result.recommended_odds = odds;
            const confidence = card.querySelector('[class*="confidence"], [class*="rating"]')?.textContent?.trim();
            if (confidence) result.confidence = confidence;
          }
        });

        return result;
      }, homeTeam, awayTeam);

      return analysis.found ? analysis : null;
    });
  } catch (err) {
    console.warn(chalk.yellow(`  [Academia] Erro na análise: ${err.message}`));
    return null;
  }
}

// ── Buscar estatísticas Over/Under histórico de um time ───────────────────────
export async function getOverUnderStats(teamName) {
  try {
    return await _withPage(async (page) => {
      await page.goto(`${BASE}/stats/over-under?team=${encodeURIComponent(teamName)}`, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT,
      });
      await page.waitForTimeout(2000);

      return await page.evaluate(() => {
        const result = {};
        document.querySelectorAll('[class*="over"], [class*="under"]').forEach((el) => {
          const label = el.querySelector('[class*="label"]')?.textContent?.trim();
          const pct   = el.querySelector('[class*="percent"], [class*="value"]')?.textContent?.trim();
          if (label && pct) result[label] = pct;
        });
        return Object.keys(result).length ? result : null;
      });
    });
  } catch {
    return null;
  }
}

// ── Buscar estatísticas BTTS de um time ───────────────────────────────────────
export async function getBTTSStats(teamName) {
  try {
    return await _withPage(async (page) => {
      await page.goto(`${BASE}/stats/btts?team=${encodeURIComponent(teamName)}`, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT,
      });
      await page.waitForTimeout(2000);

      return await page.evaluate(() => {
        const stats = {};
        document.querySelectorAll('[class*="btts"], [class*="both-score"]').forEach((el) => {
          const label = el.querySelector('[class*="label"]')?.textContent?.trim();
          const val   = el.querySelector('[class*="value"], [class*="pct"]')?.textContent?.trim();
          if (label && val) stats[label] = val;
        });
        const pctEl = document.querySelector('[class*="percentage"]');
        if (pctEl) stats['BTTS %'] = pctEl.textContent?.trim();
        return Object.keys(stats).length ? stats : null;
      });
    });
  } catch {
    return null;
  }
}

// ── Buscar ligas/partidas com melhores oportunidades do dia ───────────────────
export async function getDailyValueBets() {
  console.log(chalk.cyan(`  [Academia] Buscando value bets do dia...`));

  try {
    return await _withPage(async (page) => {
      await page.goto(`${BASE}/previsoes`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(2500);

      return await page.evaluate(() => {
        const bets = [];
        document.querySelectorAll('[class*="prediction-card"], [class*="tip-card"], [class*="forecast"]').forEach((card) => {
          try {
            const match = card.querySelector('[class*="match"], [class*="teams"]')?.textContent?.trim();
            const market = card.querySelector('[class*="market"], [class*="type"], [class*="pick"]')?.textContent?.trim();
            const oddsEl = card.querySelector('[class*="odds"], [class*="odd"]');
            const confEl = card.querySelector('[class*="confidence"], [class*="stars"]');
            const timeEl = card.querySelector('[class*="time"], [class*="date"]');

            if (!match) return;
            bets.push({
              match: match.replace(/\s+/g, ' ').trim(),
              market: market || null,
              odds: oddsEl?.textContent?.trim() || null,
              confidence: confEl?.textContent?.trim() || null,
              time: timeEl?.textContent?.trim() || null,
              source: 'academia',
            });
          } catch { /* ignora */ }
        });
        return bets.slice(0, 20);
      });
    });
  } catch (err) {
    console.warn(chalk.yellow(`  [Academia] Erro em value bets: ${err.message}`));
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseAcademiaStats(raw, teamName) {
  if (!raw || !Object.keys(raw).length) return null;

  const find = (keys) => {
    for (const k of keys) {
      const val = Object.entries(raw).find(([key]) => key.toLowerCase().includes(k))?.[1];
      if (val) return parseFloat(val.replace(',', '.'));
    }
    return null;
  };

  return {
    team: teamName,
    source: 'academia',
    goals_scored_avg:   find(['média de gols marc', 'gols por jogo', 'média gols pro']),
    goals_conceded_avg: find(['média de gols sofr', 'gols sofridos por', 'média gols contra']),
    btts_pct:           find(['ambas marcam', 'btts', 'ambos marcam']),
    over_25_pct:        find(['over 2.5', 'mais de 2.5']),
    clean_sheet_pct:    find(['clean sheet', 'sem sofrer']),
    form:               raw['Forma'] || raw['forma'] || null,
  };
}
