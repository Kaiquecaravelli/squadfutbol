/**
 * test-link-validator.js — Valida se as URLs da Superbet são acessíveis
 *
 * Extrai URLs dos mapas live + prematch e faz requisições HTTP para
 * confirmar que retornam 200 (não redirecionam para página de erro).
 *
 * Uso:
 *   node scripts/test-link-validator.js
 */
import 'dotenv/config';
import chalk from 'chalk';
import axios from 'axios';
import { getSuperbetLiveEventMap } from '../src/scrapers/superbet.js';
import { getSuperbetEventMap }     from '../src/scrapers/superbet.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};
const TIMEOUT_MS = 10_000;

/**
 * Verifica se a URL é acessível (HTTP 200-399).
 * Superbet é SPA: retorna 200 para o shell HTML em qualquer path válido.
 * Um 4xx/5xx ou redirect para um domínio diferente indica URL inválida.
 */
async function checkUrl(url) {
  try {
    const res = await axios.head(url, {
      headers: HEADERS,
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true, // não lança erro para nenhum status
    });
    const ok = res.status >= 200 && res.status < 400;
    return { url, status: res.status, ok };
  } catch (err) {
    return { url, status: null, ok: false, error: err.message };
  }
}

async function main() {
  console.log(chalk.bold.cyan('\n═══════════════════════════════════════'));
  console.log(chalk.bold.cyan('  🔗 VALIDADOR DE LINKS — SUPERBET'));
  console.log(chalk.bold.cyan('═══════════════════════════════════════\n'));

  // ── 1. Carrega mapas de eventos ──────────────────────────────────────────────
  console.log(chalk.white('Carregando mapa AO VIVO (apostas/ao-vivo)...'));
  const liveMap = await getSuperbetLiveEventMap().catch(() => new Map());

  console.log(chalk.white('Carregando mapa PRÉ-JOGO (apostas/futebol)...'));
  const prematchMap = await getSuperbetEventMap().catch(() => new Map());

  // ── 2. Coleta URLs únicas (exclui chaves de matchName) ──────────────────────
  const liveUrls    = [...new Set([...liveMap.values()])];
  const prematchUrls = [...new Set([...prematchMap.values()])];

  console.log(chalk.white(`\n  Live URLs:     ${liveUrls.length}`));
  console.log(chalk.white(`  Prematch URLs: ${prematchUrls.length}`));

  // ── 3. Valida amostra: até 10 live + 10 prematch ────────────────────────────
  const sample = [
    ...liveUrls.slice(0, 10),
    ...prematchUrls.slice(0, 10),
  ];

  if (!sample.length) {
    console.log(chalk.yellow('\n⚠  Nenhuma URL para validar. Superbet pode estar fora do ar ou sem jogos.'));
    process.exit(0);
  }

  console.log(chalk.white(`\nValidando ${sample.length} URLs (amostra)...\n`));

  let passed = 0, failed = 0;
  const failedUrls = [];

  for (const url of sample) {
    const { status, ok, error } = await checkUrl(url);
    const icon = ok ? chalk.green('✅') : chalk.red('✖ ');
    const info = ok
      ? chalk.green(`HTTP ${status}`)
      : chalk.red(error ? `ERRO: ${error}` : `HTTP ${status}`);

    // Extrai slug do jogo para leitura fácil
    const slug = url.match(/([a-z0-9-]+-x-[a-z0-9-]+-\d+)/)?.[1] || url;
    console.log(`  ${icon} ${info}  →  ${chalk.gray(slug)}`);

    if (ok) passed++;
    else { failed++; failedUrls.push(url); }
  }

  // ── 4. Resumo ────────────────────────────────────────────────────────────────
  console.log(chalk.bold.white('\n═══════════════════════════════════════'));
  console.log(`  ${chalk.green('✅ ' + passed)} válidas  |  ${chalk.red('✖ ' + failed)} com problema`);
  const pct = Math.round((passed / sample.length) * 100);
  const pctColor = pct >= 90 ? chalk.green : pct >= 70 ? chalk.yellow : chalk.red;
  console.log(`  Taxa de sucesso: ${pctColor(pct + '%')}`);
  console.log(chalk.bold.white('═══════════════════════════════════════\n'));

  if (failedUrls.length) {
    console.log(chalk.red('URLs com falha:'));
    for (const u of failedUrls) console.log(chalk.red(`  - ${u}`));
    console.log('');
  }

  if (pct >= 80) {
    console.log(chalk.green.bold('🟢 Links saudáveis — OK para envio ao Telegram.'));
  } else {
    console.log(chalk.red.bold('🔴 Links com problemas — verifique antes de enviar.'));
    process.exit(1);
  }
}

main().catch(e => {
  console.error(chalk.red(`\nERRO: ${e.message}`));
  process.exit(1);
});
