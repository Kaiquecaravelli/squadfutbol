/**
 * superbet-placer.js — Automação de apostas na Superbet via Playwright
 *
 * Responsabilidades:
 *  1. Gerenciar sessão autenticada (persistência de cookies)
 *  2. Navegar até a partida pelo URL já resolvido
 *  3. Localizar o mercado correto e clicar nos odds
 *  4. Preencher o valor da aposta e confirmar
 *
 * Uso:
 *   import { placeBet, loginSuperbet } from './superbet-placer.js';
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dir         = dirname(fileURLToPath(import.meta.url));
const ROOT          = join(__dir, '../..');
const SESSION_PATH  = join(ROOT, 'data/superbet-session.json');
const SCREENSHOTS   = join(ROOT, 'data/bet-screenshots');
const DATA_DIR      = join(ROOT, 'data');

const BASE_URL      = 'https://superbet.bet.br';
const LOGIN_URL     = `${BASE_URL}/account/login`;
const NAV_TIMEOUT   = 35_000;
const ACTION_TIMEOUT = 8_000;

// ── Mapeamento de nomes de mercado PT-BR (como aparecem no site) ──────────────
// Chave = nosso nome interno, valor = termos buscados na página (ordem de prioridade)
const MARKET_MAP = {
  'Over 1.5':        ['Mais de 1,5', '1,5 Gol', '1.5'],
  'Over 2.5':        ['Mais de 2,5', '2,5 Gol', '2.5'],
  'Over 3.5':        ['Mais de 3,5', '3,5 Gol', '3.5'],
  'Over 4.5':        ['Mais de 4,5', '4,5 Gol', '4.5'],
  'Under 1.5':       ['Menos de 1,5', 'Under 1,5', '1,5'],
  'Under 2.5':       ['Menos de 2,5', 'Under 2,5', '2,5'],
  'Under 3.5':       ['Menos de 3,5', 'Under 3,5', '3,5'],
  'BTTS':            ['Ambas Marcam', 'Ambas as equipes marcam', 'Ambas as equipes'],
  'Ambas Marcam':    ['Ambas Marcam', 'Ambas as equipes marcam'],
  '1X':              ['Dupla Hipótese', '1X', 'Casa ou Empate'],
  'X2':              ['Dupla Hipótese', 'X2', 'Empate ou Fora'],
  '12':              ['12', 'Ambas vencem'],
  'Home Win':        ['Resultado Final', 'Vitória da Casa', '1'],
  'Away Win':        ['Resultado Final', 'Vitória do Visitante', '2'],
  'Draw':            ['Resultado Final', 'Empate', 'X'],
  'Over Corners 6.5': ['Mais de 6,5 Escanteios', 'Over 6,5 Cantos', '6,5'],
  'Over Corners 7.5': ['Mais de 7,5 Escanteios', 'Over 7,5 Cantos', '7,5'],
  'Over Corners 8.5': ['Mais de 8,5 Escanteios', 'Over 8,5 Cantos', '8,5'],
  'Over Corners 9.5': ['Mais de 9,5 Escanteios', 'Over 9,5 Cantos', '9,5'],
};

// Mapeamento de recomendação → qual botão de odds clicar
const RECOMMENDATION_SIDE = {
  'SIM': 'sim',    // BTTS Sim
  'NÃO': 'nao',   // BTTS Não
  'APOSTAR': 'over', // Over/Under — assume Over quando só há uma direção
  'OVER': 'over',
  'UNDER': 'under',
  '1': 'home',
  '2': 'away',
  'X': 'draw',
  '1X': '1x',
  'X2': 'x2',
};

// ── Utilitários ───────────────────────────────────────────────────────────────
function _ensureDirs() {
  [DATA_DIR, SCREENSHOTS].forEach(d => { try { mkdirSync(d, { recursive: true }); } catch {} });
}

function _norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s.,]/g, '').replace(/\s+/g, ' ').trim();
}

async function _screenshot(page, name) {
  try {
    _ensureDirs();
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(SCREENSHOTS, `${name}-${ts}.png`);
    await page.screenshot({ path, fullPage: false });
    return path;
  } catch { return null; }
}

function _userSessionPath() {
  const uid = process.env.SB_USER_ID;
  return uid ? join(DATA_DIR, `superbet-session-${uid}.json`) : SESSION_PATH;
}

function _loadSession() {
  const p = _userSessionPath();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return null; }
}

function _saveSession(state) {
  const p = _userSessionPath();
  try { writeFileSync(p, JSON.stringify(state, null, 2)); }
  catch (e) { console.warn('[Placer] Falha ao salvar sessão:', e.message); }
}

async function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fecha o banner OneTrust que bloqueia todos os cliques na Superbet
async function _dismissCookieBanner(page) {
  try {
    const otBtn = page.locator(
      '#onetrust-accept-btn-handler, button:has-text("Aceitar tudo"), button:has-text("Aceitar Todos")'
    ).first();
    if (await otBtn.count() > 0) {
      await otBtn.click({ timeout: 4000 });
      await _sleep(800);
    }
  } catch {}
  // Fallback: remover via JS se botão não responde
  try {
    await page.evaluate(() => {
      document.getElementById('onetrust-consent-sdk')?.remove();
      document.querySelector('.onetrust-pc-dark-filter')?.remove();
    });
    await _sleep(400);
  } catch {}

  // Fechar modal "AINDA NO JOGO?" (session expiry warning) — bloqueia todos os cliques
  await _dismissSessionModal(page);

  // Aceitar "Permitir" (geolocalização / notificações) — aparece ao acessar o site
  await _dismissPermitModal(page);
}

// Aceita "ATIVE A SUA LOCALIZAÇÃO" → Continuar, e outros prompts de permissão
async function _dismissPermitModal(page) {
  try {
    const btn = page.locator(
      'button:has-text("Continuar"), button:has-text("Permitir"), button:has-text("Allow"), button:has-text("Ativar")'
    ).first();
    if (await btn.count() > 0) {
      const txt = await btn.textContent().catch(() => '');
      await btn.click({ force: true, timeout: 3000 });
      await _sleep(700);
      console.log(chalk.gray(`[Placer] Modal de permissão dispensado ("${txt?.trim()}")`));
    }
  } catch {}

  // Remover modal de localização via JS (inclui variações de classe e texto)
  try {
    await page.evaluate(() => {
      const keywords = ['LOCALIZA', 'localiza', 'location', 'geoloc', 'ATIVE', 'ative'];
      document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="popup"], [class*="dialog"], [class*="backdrop"]').forEach(el => {
        if (keywords.some(k => (el.textContent || '').includes(k))) {
          el.remove();
          console.log('[Placer-JS] Modal de localização removido via JS');
        }
      });
      // Remover body overflow hidden que modais deixam
      document.body.style.overflow = '';
      document.body.style.position = '';
    });
  } catch {}
}

// Fecha modal de expiração de sessão ("AINDA NO JOGO?" / "Volte a jogar")
async function _dismissSessionModal(page) {
  try {
    const modal = page.locator('[code="sessionExpiring"], .modal__overlay[code="sessionExpiring"]');
    if (await modal.count() === 0) return;

    // Clicar no botão "Volte a jogar" (vermelho)
    const playBtn = page.locator(
      'button:has-text("Volte a jogar"), button:has-text("Voltar a jogar"), button:has-text("Continuar"), .modal__overlay[code="sessionExpiring"] button'
    ).first();

    if (await playBtn.count() > 0) {
      await playBtn.click({ force: true, timeout: 5000 });
      await _sleep(1000);
      console.log(chalk.gray('[Placer] Modal "AINDA NO JOGO?" dispensado'));
    } else {
      // Forçar remoção via JS
      await page.evaluate(() => {
        document.querySelector('[code="sessionExpiring"]')?.remove();
        document.querySelector('.modal__overlay')?.remove();
      });
      await _sleep(500);
    }
  } catch {}
}

// ── Lançar browser com sessão persistente ────────────────────────────────────
async function _launchContext() {
  // VPS/servidor: sempre headless. Local com PLAYWRIGHT_HEADED=1: abre janela.
  const isHeaded = process.env.PLAYWRIGHT_HEADED === '1';
  const browser = await chromium.launch({
    headless: !isHeaded,
    slowMo: isHeaded ? 300 : 0,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--disable-dev-shm-usage',   // evita crashes por /dev/shm pequeno em VPS
      '--disable-software-rasterizer',
      '--unsafely-treat-insecure-origin-as-secure=https://superbet.bet.br',
      '--disable-geolocation',
    ],
  });

  const sessionState = _loadSession();

  const context = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    storageState: sessionState || undefined,
    geolocation: { latitude: -23.5505, longitude: -46.6333 }, // São Paulo
    permissions: ['geolocation', 'notifications'],
  });

  // Pré-aprovar geolocalização — elimina diálogo nativo do browser
  await context.grantPermissions(['geolocation'], { origin: 'https://superbet.bet.br' });

  // Auto-aceitar qualquer diálogo nativo do browser (alert, confirm, prompt)
  context.on('page', page => {
    page.on('dialog', async dialog => {
      console.log(chalk.gray(`[Placer] Diálogo nativo auto-aceito: "${dialog.message().slice(0, 60)}"`));
      await dialog.accept().catch(() => {});
    });
  });

  return { browser, context };
}

// Injeta override de geolocalização via CDP na página (mais robusto que context.grantPermissions)
// Simula São Paulo e reseta permissões do site — equivale ao "Redefinir permissões" manual do Chrome
async function _overrideGeolocation(page) {
  try {
    const cdp = await page.context().newCDPSession(page);

    // Emular geolocalização via protocolo DevTools
    await cdp.send('Emulation.setGeolocationOverride', {
      latitude:  -23.5505,
      longitude: -46.6333,
      accuracy:  100,
    });

    // Resetar permissões do site via CDP — equivale ao "Redefinir permissões" do Chrome
    await cdp.send('Browser.resetPermissions').catch(() => {});

    // Conceder permissão de geolocalização diretamente no contexto da página
    await cdp.send('Browser.grantPermissions', {
      permissions: ['geolocation'],
      origin: 'https://superbet.bet.br',
    }).catch(() => {});

    console.log(chalk.gray('[Placer] Geolocalização override via CDP aplicado (São Paulo)'));
  } catch (e) {
    console.log(chalk.gray(`[Placer] CDP geolocation: ${e.message.split('\n')[0]}`));
  }
}

// ── Login na Superbet ─────────────────────────────────────────────────────────
export async function loginSuperbet(email, password) {
  console.log(chalk.cyan('[Placer] Iniciando login na Superbet...'));
  const { browser, context } = await _launchContext();
  const page = await context.newPage();

  try {
    // SPAs como Superbet nunca atingem 'networkidle' — usar 'load' + delay manual
    await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    await _sleep(3000); // aguardar React renderizar os campos

    // ── Fechar banner OneTrust (bloqueia todos os cliques na Superbet) ──────────
    await _dismissCookieBanner(page);

    // Abrir modal de login clicando em "Entrar" no header
    const loginModal = page.locator('input[name="username"]');
    if (await loginModal.count() === 0) {
      const headerBtn = page.locator('button.e2e-login, button[class*="e2e-login"]').first();
      if (await headerBtn.count() > 0) {
        await headerBtn.click({ timeout: ACTION_TIMEOUT });
        await _sleep(2000);
      } else {
        // Fallback: qualquer botão "entrar" visível
        await page.locator('button:has-text("entrar")').first().click({ timeout: ACTION_TIMEOUT });
        await _sleep(2000);
      }
    }

    // Preencher username — usar fill() sem click prévio (label flutua sobre o input na SPA)
    const emailInput = page.locator('input[name="username"]').first();
    await emailInput.waitFor({ state: 'attached', timeout: ACTION_TIMEOUT });
    await emailInput.focus();
    await emailInput.fill(email);
    await _sleep(600);

    // Preencher senha
    const passInput = page.locator('input[name="password"]').first();
    await passInput.focus();
    await passInput.fill(password);
    await _sleep(600);

    // Clicar no botão "Entrar" (type="submit") — usar force para ignorar label overlay
    await page.locator('button[type="submit"]:has-text("Entrar")').first()
      .click({ force: true, timeout: ACTION_TIMEOUT });

    await page.waitForLoadState('load', { timeout: 15_000 });
    await _sleep(3000); // aguardar SPA processar login e carregar saldo

    // Verificar se login foi bem sucedido
    // Quando logado: botão "entrar" some E aparece menu de usuário / saldo
    const loginBtnStillVisible = await page.locator('button:has-text("entrar"), button:has-text("Entrar")').count();
    const isLoggedIn = loginBtnStillVisible === 0;

    if (!isLoggedIn) {
      await _screenshot(page, 'login-failed');
      throw new Error('Login falhou — verifique credenciais ou resolva CAPTCHA manualmente');
    }

    // Persistir sessão
    const state = await context.storageState();
    _saveSession(state);

    console.log(chalk.green('[Placer] ✅ Login realizado com sucesso'));
    return { success: true };

  } finally {
    await browser.close();
  }
}

// ── Colocar aposta ─────────────────────────────────────────────────────────────
/**
 * @param {object} params
 * @param {string} params.url          - URL direta da partida na Superbet
 * @param {string} params.market       - Mercado (ex: "Over 2.5", "BTTS", "1X")
 * @param {string} params.recommendation - Recomendação (ex: "APOSTAR", "SIM", "NÃO")
 * @param {number} params.minOdds      - Odds mínimas aceitáveis
 * @param {number} params.stake        - Valor em BRL a apostar (calculado externamente)
 * @param {boolean} params.dryRun      - true = simular sem confirmar
 * @returns {Promise<{success: boolean, details: object}>}
 */
export async function placeBet({ url, market, recommendation, minOdds, stake, dryRun = true }) {
  _ensureDirs();
  console.log(chalk.cyan(`\n[Placer] Iniciando aposta: ${market} @ mín ${minOdds} | R$${stake.toFixed(2)}${dryRun ? ' [DRY-RUN]' : ''}`));

  const session = _loadSession();
  if (!session) {
    throw new Error('Sessão Superbet não encontrada. Execute loginSuperbet() primeiro.');
  }

  const { browser, context } = await _launchContext();
  const page = await context.newPage();

  let details = { url, market, recommendation, minOdds, stake, dryRun, placedAt: null, oddsObtained: null, error: null };

  try {
    // ── 1. Navegar até a partida ─────────────────────────────────────────────
    console.log(chalk.gray(`[Placer] Navegando para: ${url}`));

    // Override de geolocalização via CDP antes da navegação
    await _overrideGeolocation(page);

    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    await _sleep(4000); // SPA React precisa de tempo para renderizar mercados

    // Reforçar override após navegação (alguns sites resetam após load)
    await _overrideGeolocation(page);

    // ── 2. Fechar modais/banners ─────────────────────────────────────────────
    await _dismissCookieBanner(page);
    for (const sel of ['button:has-text("Fechar")', '[aria-label="fechar"]']) {
      try { await page.locator(sel).first().click({ timeout: 1500 }); await _sleep(300); } catch {}
    }
    // Re-checar modais após dismissal inicial (Superbet pode exibir vários em sequência)
    await _dismissSessionModal(page);
    await _dismissPermitModal(page);

    // ── 3. Limpar bet slip existente + navegar para a aba do mercado ─────────
    await _clearBetSlip(page);
    await _navigateToMarketTab(page, market);

    // ── 4. Localizar o mercado na página ─────────────────────────────────────
    const marketTerms = MARKET_MAP[market] || [market];
    let oddsValue = null;
    let clicked   = false;

    for (const term of marketTerms) {
      const termNorm = _norm(term);
      console.log(chalk.gray(`[Placer] Procurando mercado: "${term}"`));

      // Estratégia A: encontrar seção de mercado pelo texto e clicar no odds correto
      try {
        const result = await _clickMarketOdds(page, term, market, recommendation, minOdds);
        if (result.clicked) {
          oddsValue = result.odds;
          clicked   = true;
          console.log(chalk.green(`[Placer] ✅ Mercado encontrado: "${term}" @ odds ${oddsValue}`));
          break;
        }
      } catch (e) {
        console.log(chalk.gray(`[Placer] Termo "${term}" não encontrou odds clicável: ${e.message}`));
      }
    }

    if (!clicked) {
      await _screenshot(page, 'market-not-found');
      throw new Error(`Mercado "${market}" não encontrado na página. Pode ter sido removido ou título diverge.`);
    }

    details.oddsObtained = oddsValue;

    // ── 5. Verificar odds mínimas ────────────────────────────────────────────
    if (oddsValue && oddsValue < minOdds) {
      throw new Error(`Odds obtidas (${oddsValue}) abaixo do mínimo configurado (${minOdds}). Aposta cancelada.`);
    }

    // Aguardar bet slip renderizar + dispensar modais que possam ter aparecido
    await _sleep(2500);
    await _dismissSessionModal(page);
    await _dismissPermitModal(page);
    await _sleep(500);

    // Screenshot para diagnóstico após clique no odds
    await _screenshot(page, 'after-odds-click');

    // ── 5. Preencher valor no bet slip ───────────────────────────────────────
    // Bet slip Superbet: input de valor usa classe sds-base-input__input dentro do slip
    const stakeInput = page.locator([
      'input[name="stakeInput"]',
      'input[data-testid*="stake"]',
      'input[class*="sds-base-input__input"]',
      'input[class*="stake"]',
      '[class*="bet-slip"] input',
      '[class*="betslip"] input',
      '[class*="ticket"] input[type="number"]',
      '[class*="slip"] input',
      'input[type="number"]',
      'input[placeholder*="valor" i]',
      'input[placeholder*="stake" i]',
      'input[placeholder*="aposta" i]',
    ].join(', ')).first();

    // Tentar waitFor com timeout maior; se falhar, verificar se o odds foi realmente adicionado
    try {
      await stakeInput.waitFor({ state: 'visible', timeout: 12_000 });
    } catch {
      // O bet slip pode não ter aberto — tentar clicar no odds novamente
      console.log(chalk.yellow('[Placer] Stake input não apareceu — re-tentando clique no odds'));
      for (const term of marketTerms.slice(0, 2)) {
        try {
          const r = await _clickMarketOdds(page, term, market, recommendation, minOdds);
          if (r.clicked) {
            console.log(chalk.gray('[Placer] Re-clique no odds OK'));
            break;
          }
        } catch {}
      }
      await _sleep(3000);
      await _dismissSessionModal(page);
      await _dismissPermitModal(page);
      await stakeInput.waitFor({ state: 'visible', timeout: 10_000 });
    }
    await _sleep(500);
    await stakeInput.click({ force: true, timeout: ACTION_TIMEOUT });
    await _sleep(300);
    // Triple-click para selecionar tudo + substituir valor padrão
    await stakeInput.click({ clickCount: 3, force: true, timeout: ACTION_TIMEOUT });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await _sleep(300);
    // Usar type() ao invés de fill() para disparar eventos React corretamente
    await stakeInput.type(stake.toFixed(2), { delay: 80 });
    await _sleep(500);
    // Disparar eventos React que o fill() não dispara
    await page.evaluate((sel) => {
      const input = document.querySelector(sel);
      if (!input) return;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeInputValueSetter?.call(input, input.value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, 'input[class*="sds-base-input__input"], input[name="stakeInput"], input[type="number"]');
    await _sleep(500);
    // Verificar se o valor foi realmente preenchido
    const filledValue = await stakeInput.inputValue().catch(() => '');
    console.log(chalk.gray(`[Placer] Valor preenchido: R$${filledValue || stake.toFixed(2)}`))

    if (dryRun) {
      await _screenshot(page, 'dry-run-ready');
      console.log(chalk.yellow('[Placer] DRY-RUN: aposta pronta mas NÃO confirmada.'));
      details.success = true;
      details.dryRun  = true;
      return { success: true, details };
    }

    // ── 6. Confirmar aposta ──────────────────────────────────────────────────
    const confirmBtn = page.locator([
      'button:has-text("Apostar")',
      'button:has-text("Confirmar")',
      'button:has-text("Fazer aposta")',
      '[data-testid*="place-bet"]',
      '[class*="place-bet"]',
      '[class*="confirm-bet"]',
    ].join(', ')).first();

    // Aguardar botão ficar habilitado (React pode demorar para processar o stake)
    await _sleep(1000);
    await _screenshot(page, 'pre-confirm'); // captura antes de confirmar
    // Tentar clicar normalmente; se disabled usar force
    const confirmLoc = page.locator([
      'button[class*="stake-button"]',
      'button[class*="e2e-betslip-submit"]',
      'button:has-text("Apostar")',
      'button:has-text("Fazer aposta")',
      'button:has-text("Confirmar")',
      '[data-testid*="place-bet"]',
      '[class*="place-bet"]',
    ].join(', ')).first();
    try {
      await confirmLoc.waitFor({ state: 'visible', timeout: 5000 });
      await confirmLoc.click({ timeout: 5000 });
    } catch {
      // Forçar clique mesmo que disabled (React pode reativar via JS)
      console.log(chalk.gray('[Placer] Confirm button disabled — tentando force click'));
      await confirmLoc.click({ force: true, timeout: ACTION_TIMEOUT });
    }

    await _sleep(3000); // aguardar confirmação

    // ── 7. Verificar e fechar modal de confirmação "PARABÉNS" ────────────────
    const cssSuccessEl = await page.locator('[class*="bet-success"], [class*="success"]').count();
    const textSuccessEl = await page.getByText(/Aposta realizada|Aposta aceita|Parabéns|colocada com sucesso/i).count();
    const successEl = cssSuccessEl + textSuccessEl;

    // Clicar em "OK" no modal de parabéns imediatamente
    try {
      const okBtn = page.locator('button:has-text("OK"), button:has-text("Ok")').first();
      if (await okBtn.count() > 0) {
        await okBtn.click({ force: true, timeout: 3000 });
        await _sleep(500);
        console.log(chalk.gray('[Placer] Modal "PARABÉNS" dispensado (OK clicado)'));
      }
    } catch {}

    if (successEl === 0) {
      await _screenshot(page, 'confirm-unknown');
      console.log(chalk.yellow('[Placer] ⚠️ Aposta enviada mas confirmação não detectada visualmente. Verifique manualmente.'));
    } else {
      await _screenshot(page, 'bet-confirmed');
      console.log(chalk.green('[Placer] ✅ Aposta CONFIRMADA com sucesso!'));
    }

    details.placedAt = new Date().toISOString();
    details.confirmed = successEl > 0;

    // Persistir sessão atualizada (saldo mudou)
    const newState = await context.storageState();
    _saveSession(newState);

    return { success: true, details };

  } catch (err) {
    details.error = err.message;
    await _screenshot(page, 'error');
    console.error(chalk.red(`[Placer] ❌ Erro: ${err.message}`));
    return { success: false, details };

  } finally {
    await browser.close();
  }
}

// ── Limpar seleções existentes do bet slip ────────────────────────────────────
// Evita conflito quando o slip já tem itens de testes anteriores
async function _clearBetSlip(page) {
  try {
    // Remover todos os itens via botões de remoção (×, trash, remove)
    const removeBtns = page.locator([
      'button[class*="remove"]',
      'button[class*="delete"]',
      'button[class*="close"][class*="slip"]',
      'button[aria-label*="remover" i]',
      'button[aria-label*="remove" i]',
      '[class*="bet-slip"] button[class*="close"]',
      '[class*="betslip"] button[class*="close"]',
      '[class*="ticket"] button[class*="close"]',
    ].join(', '));

    const count = await removeBtns.count();
    if (count > 0) {
      console.log(chalk.gray(`[Placer] Limpando ${count} seleção(ões) do bet slip`));
      for (let i = 0; i < count; i++) {
        try { await removeBtns.first().click({ force: true, timeout: 2000 }); await _sleep(400); } catch {}
      }
    }

    // Fallback: "Limpar tudo" / "Clear all"
    const clearAll = page.locator('button:has-text("Limpar"), button:has-text("Remover tudo"), button:has-text("Clear all")').first();
    if (await clearAll.count() > 0) {
      await clearAll.click({ force: true, timeout: 2000 });
      await _sleep(500);
    }
  } catch {}
}

// ── Navegar para a aba do mercado correto (Gols, Escanteios, etc.) ────────────
// A Superbet organiza mercados em abas: Popular | Gols | Tempos | Handicap | Escanteios
async function _navigateToMarketTab(page, market) {
  const mkt = _norm(market);

  // Mapeamento mercado → aba (corners/cartões ANTES de over/under para evitar falso match)
  let tabLabel = null;
  if (mkt.includes('corner') || mkt.includes('escanteio') || mkt.includes('canto')) {
    tabLabel = 'Escanteios';
  } else if (mkt.includes('cartao') || mkt.includes('yellow') || mkt.includes('yc')) {
    tabLabel = 'Cartões';
  } else if (mkt.includes('over') || mkt.includes('under') || mkt.includes('mais de') ||
             mkt.includes('menos de') || mkt.includes('btts') || mkt.includes('ambas')) {
    tabLabel = 'Gols';
  }
  // 1X2, Home Win, Away Win, Draw → ficam no Popular (já visível por padrão)

  if (!tabLabel) return; // aba Popular já está ativa por padrão

  try {
    // Dismissar modais antes de tentar clicar na aba
    await _dismissSessionModal(page);
    await _dismissPermitModal(page);

    // Botões de aba da Superbet aparecem como `button` ou `[role="tab"]` com o texto exato
    const tab = page.locator(`button:has-text("${tabLabel}"), [role="tab"]:has-text("${tabLabel}")`).first();
    if (await tab.count() > 0) {
      await tab.click({ force: true, timeout: ACTION_TIMEOUT });
      await _sleep(2500); // aguardar mercados da aba renderizarem
      console.log(chalk.gray(`[Placer] Aba "${tabLabel}" selecionada`));
      // Verificar modais novamente após clique
      await _dismissSessionModal(page);
    } else {
      console.log(chalk.gray(`[Placer] Aba "${tabLabel}" não encontrada — tentando com mercados visíveis`));
    }
  } catch (e) {
    console.log(chalk.gray(`[Placer] Erro ao navegar aba: ${e.message}`));
  }
}

// ── Estratégia específica para mercados de gols (Total de Gols) ──────────────
// Encontra a linha com o valor (ex: "1.5") na tabela "Total de Gols" e clica em MAIS ou MENOS
// NUNCA clica em "Próximo Gol" (Xº Gol) — apenas na tabela Total de Gols
async function _clickGoalsTableMarket(page, line, direction) {
  // "line" = "1.5", "2.5", "3.5"  |  direction = "MAIS" | "MENOS"
  const isMais = direction === 'MAIS';

  // Primeiro: garantir que estamos na seção "Total de Gols" (não "Próximo Gol")
  // Tentar usar evaluate para encontrar a seção exata
  const clicked = await page.evaluate(({ line, isMais }) => {
    // Encontrar header "Total de Gols"
    const headers = Array.from(document.querySelectorAll('*'));
    let totalGoalsContainer = null;
    for (const el of headers) {
      if (el.children.length > 0) continue; // só elementos folha
      if (el.textContent?.trim() === 'Total de Gols') {
        // Subir até o container que tem os botões
        let parent = el.parentElement;
        for (let i = 0; i < 6; i++) {
          if (parent && parent.querySelectorAll('button').length >= 2) {
            totalGoalsContainer = parent;
            break;
          }
          parent = parent?.parentElement;
        }
        if (totalGoalsContainer) break;
      }
    }

    if (!totalGoalsContainer) return false;

    // Dentro do container, encontrar o elemento com o valor da linha (ex: "1.5" ou "1,5")
    const lineVariants = [line, line.replace('.', ','), line.replace(',', '.')];
    for (const variant of lineVariants) {
      const lineEls = totalGoalsContainer.querySelectorAll('*');
      for (const el of lineEls) {
        if (el.children.length > 0) continue;
        if (el.textContent?.trim() !== variant) continue;

        // Encontrar a linha que contém esse elemento
        let row = el.parentElement;
        for (let i = 0; i < 4; i++) {
          const btns = row?.querySelectorAll('button');
          if (btns && btns.length >= 2) {
            // [0] = MAIS, [1] = MENOS
            const btn = btns[isMais ? 0 : 1];
            if (btn && !btn.disabled) {
              btn.click();
              return parseFloat(btn.textContent?.trim().replace(',', '.') || '0');
            }
          }
          row = row?.parentElement;
        }
      }
    }
    return false;
  }, { line, isMais });

  if (clicked) {
    await _sleep(500);
    return { clicked: true, odds: typeof clicked === 'number' ? clicked : null };
  }

  // Fallback: usar locator para encontrar linha com o valor
  // Encontrar o elemento de texto com o valor da linha
  const lineLocators = [
    page.locator(`:text-is("${line}")`).first(),
    page.locator(`span:has-text("${line}")`).first(),
    page.locator(`td:has-text("${line}")`).first(),
  ];

  for (const lineLoc of lineLocators) {
    try {
      const count = await lineLoc.count();
      if (count === 0) continue;

      // Tentar pegar linha-pai (tr, div de linha) e depois os botões
      const row = lineLoc.locator('xpath=ancestor::*[self::tr or self::div][1]').first();
      const btns = row.locator('button[class*="odd"], button[class*="selection"], button[class*="outcome"]');
      const btnCount = await btns.count();

      if (btnCount >= 2) {
        // Estrutura esperada: [0] = MAIS, [1] = MENOS
        const btn = btns.nth(isMais ? 0 : 1);
        const btnText = await btn.textContent().catch(() => '');
        const oddsMatch = (btnText || '').match(/(\d+[.,]\d+)/);
        const oddsNum = oddsMatch ? parseFloat(oddsMatch[1].replace(',', '.')) : null;

        if (oddsNum && !await btn.isDisabled()) {
          await btn.click({ force: true, timeout: ACTION_TIMEOUT });
          return { clicked: true, odds: oddsNum };
        }
      }

      // Fallback: pegar botões irmãos no mesmo parent
      const parent = lineLoc.locator('xpath=ancestor::*[2]').first();
      const siblings = parent.locator('button');
      const sibCount = await siblings.count();
      for (let k = 0; k < sibCount; k++) {
        const btn = siblings.nth(k);
        const btnText = await btn.textContent().catch(() => '');
        const oddsMatch = (btnText || '').match(/(\d+[.,]\d+)/);
        const oddsNum = oddsMatch ? parseFloat(oddsMatch[1].replace(',', '.')) : null;
        if (oddsNum && oddsNum > 1 && !await btn.isDisabled()) {
          if (isMais && k === 0) {
            await btn.click({ force: true, timeout: ACTION_TIMEOUT });
            return { clicked: true, odds: oddsNum };
          } else if (!isMais && k === 1) {
            await btn.click({ force: true, timeout: ACTION_TIMEOUT });
            return { clicked: true, odds: oddsNum };
          }
        }
      }
    } catch {}
  }
  return { clicked: false, odds: null };
}

// ── Estratégia específica para BTTS ──────────────────────────────────────────
async function _clickBttsMarket(page, recommendation) {
  const isSim = !recommendation.includes('NÃO') && !recommendation.includes('NAO');

  // Encontrar header "Ambas as Equipes Marcam" e pegar botão correto (Sim=0, Não=1)
  const headerTexts = ['Ambas as Equipes Marcam', 'Ambas Marcam', 'Ambas as equipes marcam'];

  for (const headerText of headerTexts) {
    try {
      const header = page.locator(`:text-is("${headerText}"), :text("${headerText}")`).first();
      if (await header.count() === 0) continue;

      // Pegar container pai do header e buscar botões dentro
      const container = header.locator('xpath=ancestor::*[3]').first();
      const btns = container.locator('button[class*="odd"], button[class*="selection"], button[class*="outcome"]');
      const btnCount = await btns.count();

      if (btnCount >= 1) {
        const btn = btns.nth(isSim ? 0 : 1);
        const btnText = await btn.textContent().catch(() => '');
        const oddsMatch = (btnText || '').match(/(\d+[.,]\d+)/);
        const oddsNum = oddsMatch ? parseFloat(oddsMatch[1].replace(',', '.')) : null;
        if (oddsNum && !await btn.isDisabled()) {
          await btn.click({ force: true, timeout: ACTION_TIMEOUT });
          console.log(chalk.green(`[Placer] BTTS ${isSim ? 'Sim' : 'Não'} clicado @ ${oddsNum}`));
          return { clicked: true, odds: oddsNum };
        }
      }
    } catch {}
  }
  return { clicked: false, odds: null };
}

// ── Estratégia de clique no odds correto ─────────────────────────────────────
async function _clickMarketOdds(page, marketTerm, marketName, recommendation, minOdds) {
  const normTerm = _norm(marketTerm);
  const rec      = (recommendation || '').toUpperCase().trim();
  const mktNorm  = _norm(marketName);

  // Verificar se é mercado de corners/cartões ANTES de checar over/under de gols
  const isCorners = mktNorm.includes('corner') || mktNorm.includes('escanteio') || mktNorm.includes('canto');
  const isCards   = mktNorm.includes('yc') || mktNorm.includes('cartao') || mktNorm.includes('yellow');

  // ── Estratégia específica: mercados de gols Over/Under (apenas gols, não corners/cartões) ──
  if (!isCorners && !isCards) {
    const overMatch  = mktNorm.match(/over\s+([\d.]+)/);
    const underMatch = mktNorm.match(/under\s+([\d.]+)/);
    const maisMatch  = mktNorm.match(/mais de\s+([\d.]+)/);
    const menosMatch = mktNorm.match(/menos de\s+([\d.]+)/);

    if (overMatch || maisMatch) {
      const line = (overMatch || maisMatch)[1].replace('.', ',');
      const r = await _clickGoalsTableMarket(page, line, 'MAIS');
      if (r.clicked) return r;
      const r2 = await _clickGoalsTableMarket(page, (overMatch || maisMatch)[1], 'MAIS');
      if (r2.clicked) return r2;
    }

    if (underMatch || menosMatch) {
      const line = (underMatch || menosMatch)[1].replace('.', ',');
      const r = await _clickGoalsTableMarket(page, line, 'MENOS');
      if (r.clicked) return r;
      const r2 = await _clickGoalsTableMarket(page, (underMatch || menosMatch)[1], 'MENOS');
      if (r2.clicked) return r2;
    }
  }

  // ── Estratégia específica: BTTS ────────────────────────────────────────────
  if (mktNorm.includes('btts') || mktNorm.includes('ambas')) {
    const r = await _clickBttsMarket(page, rec);
    if (r.clicked) return r;
  }

  // ── Estratégia genérica: busca por seções ─────────────────────────────────
  // Encontrar todos os botões de odds na página
  // Superbet usa botões com classe que contém 'odds' ou 'selection'
  const oddsButtons = page.locator([
    'button[class*="odd"]',
    'button[class*="selection"]',
    'button[class*="outcome"]',
    '[class*="event-market"] button',
    '[data-testid*="odds"] button',
    '[data-testid*="outcome"]',
  ].join(', '));

  const count = await oddsButtons.count();
  if (count === 0) throw new Error('Nenhum botão de odds encontrado na página');

  // Estratégia: percorrer regiões de mercado e procurar pelo título
  // Superbet organiza: [market-title] → [odds-buttons]
  const marketSections = page.locator([
    '[class*="market"]',
    '[class*="bet-market"]',
    '[data-testid*="market"]',
    'section',
    'div[class*="accordion"]',
  ].join(', '));

  const sectionCount = await marketSections.count();

  for (let i = 0; i < sectionCount; i++) {
    const section    = marketSections.nth(i);
    const sectionText = _norm(await section.textContent().catch(() => ''));

    if (!sectionText.includes(normTerm)) continue;

    // Seção encontrada — agora clicar no odds correto baseado na recomendação
    const btns = section.locator('button');
    const btnCount = await btns.count();

    for (let j = 0; j < btnCount; j++) {
      const btn     = btns.nth(j);
      const btnText = _norm(await btn.textContent().catch(() => ''));

      // Extrair valor de odds do texto do botão (ex: "2.10", "1.85")
      const oddsMatch = btnText.match(/(\d+[,.]?\d*)/);
      const oddsNum   = oddsMatch ? parseFloat(oddsMatch[1].replace(',', '.')) : null;

      if (!oddsNum || oddsNum < 1.01 || oddsNum > 50) continue; // não é odds
      if (minOdds && oddsNum < minOdds) continue;               // abaixo do mínimo

      // Verificar se este botão corresponde à recomendação
      const isCorrect = _isCorrectOddsButton(btnText, sectionText, rec, marketName);
      if (!isCorrect) continue;

      const isDisabled = await btn.isDisabled();
      if (isDisabled) throw new Error(`Botão de odds desabilitado (mercado fechado?)`);

      await btn.click({ force: true, timeout: ACTION_TIMEOUT });
      return { clicked: true, odds: oddsNum };
    }
  }

  // Fallback A: busca global pelo texto do mercado + primeiro odds ≥ minOdds
  const allText = page.locator(`text="${marketTerm}"`).first();
  if (await allText.count() > 0) {
    // Tentar parent → sibling buttons
    const parent = allText.locator('..').first();
    const sibling = parent.locator('button').first();
    if (await sibling.count() > 0) {
      const btnText  = _norm(await sibling.textContent().catch(() => ''));
      const oddsMatch = btnText.match(/(\d+[,.]?\d*)/);
      const oddsNum   = oddsMatch ? parseFloat(oddsMatch[1].replace(',', '.')) : null;
      if (oddsNum && oddsNum >= 1.01) {
        await sibling.click({ force: true, timeout: ACTION_TIMEOUT });
        return { clicked: true, odds: oddsNum };
      }
    }
  }

  // Fallback B: scan global de todos os botões — Superbet concatena label+odds no texto
  // Ex: "21.30" = label "2" (away) + odds "1.30", "X4.40" = draw + odds "4.40"
  const recFallback = (recommendation || '').toUpperCase().trim();
  const allButtons = await page.evaluate(({ normTerm, rec, minOdds }) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const candidates = [];

    for (const btn of buttons) {
      if (btn.disabled) continue;
      const txt = (btn.textContent || '').trim();
      if (!txt || txt.length > 80) continue;

      // Extrair valor de odds do final do texto (ex: "21.30" → 1.30, "X4.40" → 4.40)
      const oddsMatch = txt.match(/(\d+[.,]\d+)\s*$/) || txt.match(/^.*?(\d+[.,]\d+)/);
      if (!oddsMatch) continue;
      const odds = parseFloat(oddsMatch[1].replace(',', '.'));
      if (!odds || odds < 1.01 || odds > 50) continue;
      if (minOdds && odds < minOdds) continue;

      candidates.push({
        text: txt,
        odds,
        // Se o texto do span próximo contém o marketTerm
        nearbyText: (btn.closest('[class]')?.textContent || '').toLowerCase(),
      });
    }

    return candidates;
  }, { normTerm, rec: recFallback, minOdds });

  // Priorizar botões cujo contexto próximo contém o termo do mercado
  const scored = allButtons.map(b => ({
    ...b,
    score: b.nearbyText.includes(normTerm) ? 2 :
           (normTerm.includes('1.5') && b.nearbyText.includes('1.5')) ? 1 :
           (normTerm.includes('2.5') && b.nearbyText.includes('2.5')) ? 1 : 0,
  })).sort((a, b) => b.score - a.score || a.odds - b.odds);

  for (const cand of scored.filter(c => c.score > 0)) {
    // Tentar clicar via evaluate (mais robusto que locator para botões embutidos)
    const clicked = await page.evaluate(({ text, odds }) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        if (btn.disabled) continue;
        const txt = (btn.textContent || '').trim();
        const oddsMatch = txt.match(/(\d+[.,]\d+)\s*$/);
        if (!oddsMatch) continue;
        const btnOdds = parseFloat(oddsMatch[1].replace(',', '.'));
        if (Math.abs(btnOdds - odds) < 0.01 && txt === text) {
          btn.click();
          return true;
        }
      }
      return false;
    }, { text: cand.text, odds: cand.odds });

    if (clicked) {
      await _sleep(500);
      return { clicked: true, odds: cand.odds };
    }
  }

  return { clicked: false, odds: null };
}

// Decide se o botão de odds é o correto baseado na recomendação
// btnText é normalizado (lowercase, sem acentos, apenas [a-z0-9 .,])
function _isCorrectOddsButton(btnText, sectionText, rec, marketName) {
  const mkt = _norm(marketName);
  const inResultado = sectionText.includes('resultado') || sectionText.includes('resultado final');

  // BTTS: "SIM" → primeiro botão (sim), "NÃO" → segundo
  if (mkt.includes('btts') || mkt.includes('ambas marcam') || mkt.includes('ambas as equipes')) {
    if (rec === 'SIM') return !btnText.includes('nao') && !btnText.includes('não');
    if (rec === 'NÃO' || rec === 'NAO') return btnText.includes('nao') || btnText.includes('não');
    return true;
  }

  // Over/Under: rec "APOSTAR" assume Over; verifica pelo texto da seção
  if (mkt.includes('over') || mkt.includes('mais de') || mkt.includes('under') || mkt.includes('menos de')) {
    if (rec === 'APOSTAR' || rec === 'OVER') {
      // Na seção "mais de X.X" há apenas 1 botão relevante — aceitar qualquer
      return true;
    }
    if (rec === 'UNDER') {
      return btnText.includes('under') || btnText.includes('menos');
    }
    return true;
  }

  // Dupla chance: 1X, X2, 12
  if (rec === '1X') return btnText.includes('1x') || sectionText.includes('1x');
  if (rec === 'X2') return btnText.includes('x2') || sectionText.includes('x2');
  if (rec === '12') return btnText.includes('12');

  // Resultado Final (1X2) — Superbet mostra "19.50" / "X4.40" / "21.30" (label+odds concat)
  if (rec === '1' || rec === 'CASA' || rec === 'HOME WIN') {
    // Botão 1 geralmente não tem prefixo alfabético — começa direto com dígito sem "2" ou "x"
    if (inResultado) return !btnText.match(/^[x2]/) && !btnText.includes('empate');
    return !btnText.includes('empate') && !btnText.includes('fora') && !btnText.includes('visitante');
  }
  if (rec === '2' || rec === 'FORA' || rec === 'AWAY WIN' || rec === 'APOSTAR') {
    // Botão Away: texto começa com "2" (ex: "21.30") OU contém "visitante"/"fora"
    if (inResultado) return btnText.startsWith('2') || btnText.includes('fora') || btnText.includes('visitante');
    return btnText.includes('fora') || btnText.includes('visitante') || btnText.startsWith('2');
  }
  if (rec === 'X' || rec === 'EMPATE') {
    return btnText.startsWith('x') || btnText.includes('empate') || btnText.includes('draw');
  }

  return true; // rec não reconhecida → aceitar qualquer botão
}

/**
 * Encontra a URL de um jogo ao vivo navegando pela página de ao vivo da Superbet.
 * Usado como fallback quando o jogo não está no cache.
 *
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @returns {Promise<string|null>}  URL do jogo ou null se não encontrado
 */
export async function findGameOnLivePage(homeTeam, awayTeam) {
  const session = _loadSession();
  if (!session) throw new Error('Sessão não encontrada. Faça login primeiro.');

  const { browser, context } = await _launchContext();
  const page = await context.newPage();

  // Interceptar navegação para capturar URL final do jogo
  let foundUrl = null;

  try {
    // ── 1. Navegar para a página AO VIVO de futebol ───────────────────────────
    const liveUrl = `${BASE_URL}/apostas/futebol/ao-vivo`;
    console.log(chalk.gray(`[Placer] Buscando jogo na página ao vivo: ${homeTeam} vs ${awayTeam}`));
    await page.goto(liveUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    await _sleep(5000);
    await _dismissCookieBanner(page);
    await _sleep(2000);

    // ── 2. Normalizar nomes para comparação ───────────────────────────────────
    const homeWords = homeTeam.toLowerCase().split(/[\s-]+/).filter(w => w.length >= 3);
    const awayWords = awayTeam.toLowerCase().split(/[\s-]+/).filter(w => w.length >= 3);

    // ── 3. Buscar link do jogo na página via DOM ──────────────────────────────
    const matchData = await page.evaluate(({ homeWords, awayWords }) => {
      // Pegar todos os links que parecem jogos: /odds/futebol/...
      const links = Array.from(document.querySelectorAll('a[href*="/odds/futebol/"], a[href*="/apostas/futebol/"]'));
      for (const link of links) {
        const text = (link.textContent || link.getAttribute('href') || '').toLowerCase();
        const href = link.getAttribute('href') || '';
        if (!href.includes('futebol')) continue;

        const matchesHome = homeWords.some(w => text.includes(w) || href.includes(w));
        const matchesAway = awayWords.some(w => text.includes(w) || href.includes(w));

        if (matchesHome && matchesAway) {
          return { href: href.startsWith('http') ? href : `https://superbet.bet.br${href}`, text: text.slice(0, 100) };
        }
      }
      return null;
    }, { homeWords, awayWords });

    if (matchData) {
      foundUrl = matchData.href;
      console.log(chalk.green(`[Placer] ✅ Jogo encontrado na página ao vivo: ${foundUrl}`));
      return foundUrl;
    }

    // ── 4. Fallback: tentar navegar pelos scores/eventos via Playwright locator ─
    console.log(chalk.gray('[Placer] Tentativa por locator...'));
    const homeShort = homeWords[0] || homeTeam.slice(0, 5);
    const awayShort = awayWords[0] || awayTeam.slice(0, 5);

    // Procurar por elementos de texto que contenham o time
    const teamEl = page.locator(`text="${homeTeam}", :text("${homeShort}")`).first();
    if (await teamEl.count() > 0) {
      const parent = teamEl.locator('xpath=ancestor::a[contains(@href,"futebol")]').first();
      if (await parent.count() > 0) {
        const href = await parent.getAttribute('href');
        if (href) {
          foundUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          console.log(chalk.green(`[Placer] ✅ Jogo encontrado via locator: ${foundUrl}`));
          return foundUrl;
        }
      }
    }

    console.log(chalk.yellow(`[Placer] Jogo não encontrado na página ao vivo (${homeTeam} vs ${awayTeam})`));
    return null;

  } catch (err) {
    console.error(chalk.red(`[Placer] Erro ao buscar jogo: ${err.message}`));
    return null;
  } finally {
    await browser.close();
  }
}

// ── Verificar se está logado ─────────────────────────────────────────────────
export async function checkSession() {
  const session = _loadSession();
  if (!session) return false;

  const { browser, context } = await _launchContext();
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/minhas-apostas/abertos`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await _sleep(2000);
    const loggedIn = await page.locator('[class*="balance"], [class*="user-menu"], [class*="my-bets"]').count() > 0;
    return loggedIn;
  } catch { return false; }
  finally { await browser.close(); }
}

// ── Raspar saldo da conta Superbet ───────────────────────────────────────────
// Converte texto de saldo em número — suporta formato BR (3,50 / 1.234,56)
// e formato internacional (3.25 / 325.00) sem confundir separadores
function _parseBRL(text) {
  const s = (text || '').replace(/R\$\s*/gi, '').replace(/\s/g, '').trim();
  if (!s) return NaN;
  // Formato brasileiro: tem vírgula → vírgula é decimal, pontos são milhar
  if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  // Formato internacional: ponto é decimal (ex: "3.25", "325.00")
  return parseFloat(s.replace(/[^\d.]/g, ''));
}

export async function scrapeBalance() {
  let session = _loadSession();

  // Auto-login quando credenciais passadas via env (modo por usuário)
  if (!session && process.env.SUPERBET_EMAIL && process.env.SUPERBET_PASSWORD) {
    console.log(chalk.cyan('[Balance] Sessão não encontrada — fazendo login automático...'));
    const r = await loginSuperbet(process.env.SUPERBET_EMAIL, process.env.SUPERBET_PASSWORD);
    if (!r.success) return { error: r.error || 'Login automático falhou' };
    session = _loadSession();
  }

  if (!session) return { error: 'Sessão não encontrada. Faça login primeiro.' };

  const { browser, context } = await _launchContext();
  const page = await context.newPage();

  // ── Intercepção de rede: captura resposta JSON com saldo antes do DOM ─────
  let balanceFromAPI = null;
  page.on('response', async (response) => {
    try {
      const url = response.url();
      const ct  = (response.headers()['content-type'] || '');
      if (!ct.includes('json')) return;
      // URLs da Superbet que podem conter saldo
      if (!/balance|wallet|account|player|user|member/i.test(url)) return;
      const j = await response.json().catch(() => null);
      if (!j) return;
      // Procura campo de saldo em respostas comuns
      const candidates = [
        j?.balance, j?.data?.balance,
        j?.availableBalance, j?.data?.availableBalance,
        j?.realBalance, j?.data?.realBalance,
        j?.cashBalance, j?.wallet?.balance,
        j?.result?.balance, j?.player?.balance,
        j?.balances?.real, j?.balances?.available,
      ];
      for (const c of candidates) {
        if (c != null && !isNaN(parseFloat(c))) {
          balanceFromAPI = parseFloat(c);
          console.log(chalk.cyan(`[Balance] API interceptada: ${url} → ${balanceFromAPI}`));
          break;
        }
      }
    } catch {}
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await _sleep(4000);
    await _dismissCookieBanner(page);
    await _sleep(2000);

    // Salva screenshot para diagnóstico
    await _screenshot(page, 'balance-page');

    // ── Se a API retornou saldo, usa diretamente ─────────────────────────────
    if (balanceFromAPI != null) {
      const result = {
        balance: balanceFromAPI,
        balanceText: `R$ ${balanceFromAPI.toFixed(2).replace('.', ',')}`,
        source: 'api',
        scrapedAt: new Date().toISOString(),
      };
      const _balOut = process.env.SB_USER_ID ? join(DATA_DIR, `superbet-user-${process.env.SB_USER_ID}-balance.json`) : join(DATA_DIR, 'superbet-balance.json');
      writeFileSync(_balOut, JSON.stringify(result, null, 2));
      console.log(chalk.green(`[Balance] Via API: R$${balanceFromAPI}`));
      return result;
    }

    // ── Fallback DOM: tenta vários seletores do header da Superbet ───────────
    const selectors = [
      // Superbet usa esses nomes de classe tipicamente
      '[class*="HeaderBalance"]',
      '[class*="header-balance"]',
      '[class*="userBalance"]',
      '[class*="UserBalance"]',
      '[class*="balance__value"]',
      '[class*="wallet__amount"]',
      '[data-testid*="balance"]',
      '[class*="balance"]:not([class*="progress"]):not([class*="bar"]):not([class*="bonus"])',
      // fallback genérico
      'header [class*="amount"]',
      'nav [class*="amount"]',
    ];

    let balanceText = null;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          const txt = (await el.textContent({ timeout: 2000 }) || '').trim();
          // Deve conter dígitos e parecer um valor monetário
          if (txt && /\d/.test(txt) && txt.length < 30) {
            balanceText = txt;
            console.log(chalk.cyan(`[Balance] DOM seletor "${sel}" → "${txt}"`));
            break;
          }
        }
      } catch {}
    }

    // Último fallback: scan completo do DOM buscando padrão monetário no header
    if (!balanceText) {
      balanceText = await page.evaluate(() => {
        // Prioriza elementos no header/nav
        const areas = [...document.querySelectorAll('header, nav, [class*="header"], [class*="topbar"]')];
        const search = (root) => {
          const els = root.querySelectorAll('*');
          for (const el of els) {
            if (el.children.length > 0) continue; // só folhas de texto
            const txt = el.textContent.trim();
            if (/^R\$\s*[\d.,]+$/.test(txt) || /^\d{1,4}[,.]?\d{2}$/.test(txt)) return txt;
          }
          return null;
        };
        for (const area of areas) {
          const found = search(area);
          if (found) return found;
        }
        // DOM inteiro como último recurso
        return search(document.body);
      });
      if (balanceText) console.log(chalk.cyan(`[Balance] DOM scan → "${balanceText}"`));
    }

    if (!balanceText) {
      return { error: 'Saldo não encontrado. Verifique screenshot em data/bet-screenshots/balance-page-*.png' };
    }

    const balance = _parseBRL(balanceText);
    if (isNaN(balance)) return { error: `Não foi possível converter "${balanceText}" em número` };

    const result = {
      balance,
      balanceText: balanceText.trim(),
      source: 'dom',
      scrapedAt: new Date().toISOString(),
    };
    const _balOut2 = process.env.SB_USER_ID ? join(DATA_DIR, `superbet-user-${process.env.SB_USER_ID}-balance.json`) : join(DATA_DIR, 'superbet-balance.json');
    writeFileSync(_balOut2, JSON.stringify(result, null, 2));
    console.log(chalk.green(`[Balance] Via DOM: "${balanceText}" → R$${balance}`));
    return result;

  } catch (e) {
    await _screenshot(page, 'balance-error').catch(() => {});
    return { error: e.message };
  } finally {
    await browser.close();
  }
}

// ── Raspar histórico de apostas da Superbet ──────────────────────────────────
// Tenta extrair apostas de um card DOM com estratégia multi-seletor
function _extractBetFromCard(card) {
  const g = (sel) => (card.querySelector(sel)?.textContent || '').trim();
  const gAll = (sels) => { for (const s of sels) { const v = g(s); if (v) return v; } return ''; };

  const match = gAll([
    '[class*="event-name"]','[class*="eventName"]','[class*="match-name"]',
    '[class*="matchName"]','[class*="event"]','[class*="fixture"]',
    '[class*="teams"]','[class*="game-name"]',
  ]);
  const market = gAll([
    '[class*="market-name"]','[class*="marketName"]','[class*="selection-name"]',
    '[class*="selectionName"]','[class*="bet-type"]','[class*="betType"]',
    '[class*="outcome-name"]','[class*="outcomeName"]',
  ]);
  const oddsRaw = gAll([
    '[class*="odds-value"]','[class*="oddsValue"]','[class*="coefficient"]',
    '[class*="price"]','[class*="odd-value"]','[class*="rate"]',
  ]);
  const stakeRaw = gAll([
    '[class*="stake"]','[class*="wager"]','[class*="bet-amount"]',
    '[class*="betAmount"]','[class*="placed-amount"]',
  ]);
  const returnRaw = gAll([
    '[class*="potential-win"]','[class*="potentialWin"]','[class*="payout"]',
    '[class*="return"]','[class*="winning"]','[class*="profit"]',
  ]);
  const dateRaw = gAll([
    'time','[class*="date"]','[class*="time"]','[class*="placed-at"]',
  ]);
  const statusRaw = (gAll([
    '[class*="status"]','[class*="result"]','[class*="outcome-status"]','[class*="badge"]',
  ]) || card.textContent || '').toLowerCase();

  let result = 'pending';
  if (/ganhou|won|venceu|win|ganha/i.test(statusRaw))               result = 'won';
  else if (/perdeu|lost|lose|perda|derrota/i.test(statusRaw))        result = 'lost';
  else if (/devolvida|void|cancel|nulo|reembolso/i.test(statusRaw))  result = 'void';

  const odds  = parseFloat((oddsRaw || '').replace(',', '.')) || null;
  const stake = parseFloat((stakeRaw || '').replace(/[^0-9,.]/, '').replace('.', '').replace(',', '.')) || null;
  const ret   = parseFloat((returnRaw || '').replace(/[^0-9,.]/, '').replace('.', '').replace(',', '.')) || null;

  return { match, market, odds, stake, potentialReturn: ret, result, dateText: dateRaw };
}

export async function scrapeBetHistory({ maxPages = 3 } = {}) {
  let session = _loadSession();

  if (!session && process.env.SUPERBET_EMAIL && process.env.SUPERBET_PASSWORD) {
    console.log(chalk.cyan('[BetHistory] Sessão não encontrada — fazendo login automático...'));
    const r = await loginSuperbet(process.env.SUPERBET_EMAIL, process.env.SUPERBET_PASSWORD);
    if (!r.success) return { error: r.error || 'Login automático falhou' };
    session = _loadSession();
  }

  if (!session) return { error: 'Sessão não encontrada. Faça login primeiro.' };

  const { browser, context } = await _launchContext();
  const page = await context.newPage();

  // ── Intercepção de rede para apostas ────────────────────────────────────────
  const apiOpenBets   = [];
  const apiClosedBets = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      if (!/bet|ticket|wager|my-bet|aposta/i.test(url)) return;

      const j = await response.json().catch(() => null);
      if (!j) return;

      // Tenta extrair lista de apostas de estruturas comuns
      const list = j?.data?.bets || j?.bets || j?.data?.tickets || j?.tickets
                || j?.data?.wagers || j?.data?.items || j?.items || j?.data || [];

      if (!Array.isArray(list) || !list.length) return;

      console.log(chalk.cyan(`[BetHistory] API interceptada: ${url} → ${list.length} itens`));

      for (const item of list) {
        const isOpen = /open|pending|active|running/i.test(item?.status || item?.state || '');
        const bet = {
          match:           item?.eventName || item?.event?.name || item?.matchName || item?.fixture?.name || '—',
          market:          item?.marketName || item?.market?.name || item?.selectionName || item?.betType || '—',
          odds:            parseFloat(item?.odds || item?.price || item?.coefficient || 0) || null,
          stake:           parseFloat(item?.stake || item?.amount || item?.betAmount || 0) || null,
          potentialReturn: parseFloat(item?.potentialReturn || item?.possibleWin || item?.maxWin || 0) || null,
          result:          isOpen ? 'pending' : (/won|win|cash/i.test(item?.status || '') ? 'won' : /lost|lose/i.test(item?.status || '') ? 'lost' : 'pending'),
          dateText:        item?.createdAt || item?.placedAt || item?.date || '',
          betStatus:       isOpen ? 'open' : 'closed',
          _fromAPI:        true,
        };
        if (bet.match !== '—' || bet.market !== '—') {
          isOpen ? apiOpenBets.push(bet) : apiClosedBets.push(bet);
        }
      }
    } catch {}
  });

  const rawBets = [];

  try {
    // Apostas fechadas (resultadas)
    await page.goto(`${BASE_URL}/minhas-apostas/fechadas`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await _sleep(3000);
    await _dismissCookieBanner(page);
    await _sleep(1500);

    // ── Scraping de apostas FECHADAS ─────────────────────────────────────────
    await _screenshot(page, 'bets-fechadas');

    for (let pg = 0; pg < maxPages; pg++) {
      // Espera qualquer conteúdo carregar (timeout permissivo)
      await page.waitForSelector('main, [class*="content"], [class*="page"]', { timeout: 6000 }).catch(() => {});
      await _sleep(1500);

      const pageBets = await page.evaluate(_domExtractBets);
      rawBets.push(...pageBets.map(b => ({ ...b, betStatus: 'closed' })));
      console.log(chalk.cyan(`[BetHistory] Fechadas pg${pg+1}: ${pageBets.length} cards`));

      // Próxima página
      if (pg < maxPages - 1) {
        const nextBtn = page.locator(
          'button[aria-label*="próxima"], button[aria-label*="next"], [class*="pagination"] button:last-child, [class*="next-page"], [class*="loadMore"], button:has-text("Carregar mais")'
        ).first();
        if (await nextBtn.count() > 0 && await nextBtn.isEnabled()) {
          await nextBtn.click();
          await _sleep(2000);
        } else break;
      }
    }

    // ── Scraping de apostas ABERTAS ─────────────────────────────────────────
    await page.goto(`${BASE_URL}/minhas-apostas/abertos`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await _sleep(3000);
    await _screenshot(page, 'bets-abertas');

    const openDomBets = await page.evaluate(_domExtractBets);
    rawBets.push(...openDomBets.map(b => ({ ...b, betStatus: 'open', result: 'pending' })));
    console.log(chalk.cyan(`[BetHistory] Abertas DOM: ${openDomBets.length} cards`));

    // ── Combina: API tem prioridade sobre DOM ────────────────────────────────
    // Aguarda mais um pouco para eventos de rede pendentes
    await _sleep(1500);

    const fromAPI  = [...apiOpenBets, ...apiClosedBets];
    const fromDOM  = rawBets.filter(b => b.match || b.market);

    // Se a API capturou dados, usa eles; senão usa DOM
    const source   = fromAPI.length > 0 ? fromAPI : fromDOM;
    console.log(chalk.green(`[BetHistory] Fonte: ${fromAPI.length > 0 ? 'API' : 'DOM'} · ${source.length} apostas totais`));

    const ts = Date.now();
    const normalized = source.map((b, i) => {
      let placedAt = new Date().toISOString();
      if (b.dateText) {
        const d = new Date(b.dateText);
        if (!isNaN(d.getTime())) placedAt = d.toISOString();
      }
      return {
        id:              `sb-${ts}-${i}`,
        source:          'superbet-import',
        match:           b.match || '—',
        market:          b.market || '—',
        odds:            b.odds   || null,
        stake:           b.stake  || null,
        potentialReturn: b.potentialReturn || null,
        result:          b.result || 'pending',
        betStatus:       b.betStatus || (b.result === 'pending' ? 'open' : 'closed'),
        placedAt,
        importedAt: new Date().toISOString(),
      };
    });

    const open   = normalized.filter(b => b.betStatus === 'open');
    const closed = normalized.filter(b => b.betStatus !== 'open');
    const importResult = { total: normalized.length, bets: normalized, open, closed, scrapedAt: new Date().toISOString() };

    const _betsOut = process.env.SB_USER_ID ? join(DATA_DIR, `superbet-user-${process.env.SB_USER_ID}-bets.json`) : join(DATA_DIR, 'superbet-history.json');
    writeFileSync(_betsOut, JSON.stringify(importResult, null, 2), 'utf8');
    console.log(chalk.green(`[BetHistory] Salvo: ${open.length} abertas · ${closed.length} fechadas`));
    return importResult;

  } catch (e) {
    await _screenshot(page, 'bets-error').catch(() => {});
    return { error: e.message };
  } finally {
    await browser.close();
  }
}

// Função serializada para page.evaluate — extrai cards de aposta do DOM atual
function _domExtractBets() {
  // Seletores amplos — cobre classes compiladas (hash) que a Superbet usa
  const CARD_SELS = [
    '[class*="BetItem"]','[class*="bet-item"]','[class*="betItem"]',
    '[class*="TicketItem"]','[class*="ticket-item"]','[class*="ticketItem"]',
    '[class*="MyBet"]','[class*="my-bet"]','[class*="myBet"]',
    '[class*="BetCard"]','[class*="bet-card"]','[class*="betCard"]',
    '[class*="CouponItem"]','[class*="coupon-item"]',
    // Superbet usa às vezes li com atributo de aposta
    'li[data-id]','li[data-bet-id]','article[class*="bet"]',
  ];

  const seen  = new Set();
  const items = [];

  for (const sel of CARD_SELS) {
    const cards = document.querySelectorAll(sel);
    cards.forEach(card => {
      if (seen.has(card)) return;
      seen.add(card);

      const g = (sels) => {
        for (const s of sels) {
          const el = card.querySelector(s);
          const t  = el?.textContent?.trim();
          if (t) return t;
        }
        return '';
      };

      const match = g([
        '[class*="EventName"]','[class*="event-name"]','[class*="eventName"]',
        '[class*="MatchName"]','[class*="match-name"]','[class*="matchName"]',
        '[class*="Teams"]','[class*="teams"]','[class*="fixture"]',
        '[class*="event"]','[class*="match"]','[class*="game"]',
      ]);
      const market = g([
        '[class*="MarketName"]','[class*="market-name"]','[class*="marketName"]',
        '[class*="SelectionName"]','[class*="selection-name"]','[class*="selectionName"]',
        '[class*="BetType"]','[class*="bet-type"]','[class*="betType"]',
        '[class*="OutcomeName"]','[class*="outcome-name"]',
        '[class*="selection"]','[class*="market"]','[class*="bet-name"]',
      ]);
      const oddsRaw = g([
        '[class*="OddsValue"]','[class*="odds-value"]','[class*="oddsValue"]',
        '[class*="Coefficient"]','[class*="coefficient"]',
        '[class*="Price"]','[class*="price"]','[class*="odds"]',
      ]);
      const stakeRaw = g([
        '[class*="StakeAmount"]','[class*="stake-amount"]','[class*="stakeAmount"]',
        '[class*="BetAmount"]','[class*="bet-amount"]','[class*="betAmount"]',
        '[class*="stake"]','[class*="wager"]','[class*="amount"]',
      ]);
      const returnRaw = g([
        '[class*="PotentialWin"]','[class*="potential-win"]','[class*="potentialWin"]',
        '[class*="PossibleReturn"]','[class*="possible-return"]',
        '[class*="Payout"]','[class*="payout"]','[class*="return"]','[class*="winning"]',
      ]);
      const dateRaw = g(['time','[class*="Date"]','[class*="date"]','[class*="Time"]','[class*="time"]']);
      const statusRaw = (g(['[class*="Status"]','[class*="status"]','[class*="Result"]','[class*="result"]','[class*="Badge"]']) || card.textContent || '').toLowerCase();

      let result = 'pending';
      if (/ganhou|won|venceu|win|ganha|cash/i.test(statusRaw))         result = 'won';
      else if (/perdeu|lost|lose|perda|derrota/i.test(statusRaw))       result = 'lost';
      else if (/devolvida|void|cancel|nulo|reembolso/i.test(statusRaw)) result = 'void';

      const odds  = parseFloat((oddsRaw  || '').replace(',', '.'))  || null;
      const clean = (s) => parseFloat((s||'').replace(/[^0-9,]/g,'').replace(',','.')) || null;
      const stake = clean(stakeRaw);
      const ret   = clean(returnRaw);

      if (match || market) {
        items.push({ match, market, odds, stake, potentialReturn: ret, result, dateText: dateRaw, raw: card.textContent.trim().slice(0,150) });
      }
    });
    if (items.length > 0) break; // Se achou com esse seletor, não precisa tentar os próximos
  }
  return items;
}
