/**
 * morning-message.js — Mensagem diária de bom dia
 *
 * Enviada automaticamente às 05:45 pelo scheduler.
 * Inclui:
 *   - Saudação amigável com data do dia
 *   - Resumo dos resultados de ontem (acertos/erros do PIE)
 *   - Agenda do dia com horários dos sinais
 *   - Mercados cobertos
 *
 * Uso:
 *   node scripts/morning-message.js          → envia agora
 *   node scripts/morning-message.js --dry    → só mostra o texto, sem enviar
 */

import 'dotenv/config';
import axios  from 'axios';
import chalk  from 'chalk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }           from 'path';
import { fileURLToPath }           from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DRY       = process.argv.includes('--dry');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;

// ── Helpers ───────────────────────────────────────────────────────────────────
function diaSemana() {
  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  return dias[new Date().getDay()];
}

function dataHoje() {
  return new Date().toLocaleDateString('pt-BR', {
    day:   '2-digit',
    month: '2-digit',
    year:  'numeric',
    timeZone: 'America/Sao_Paulo',
  });
}

function saudacao() {
  // Usa hour12:false para garantir valor numérico sem "AM"/"PM" em qualquer locale
  const hora = new Date().toLocaleString('pt-BR', {
    hour: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo',
  });
  const h = parseInt(hora, 10);
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

// ── Resumo de ontem ───────────────────────────────────────────────────────────
function buildResumoOntem() {
  try {
    const pendingPath = join(ROOT, 'data/pending-analyses.json');
    const piePath     = join(ROOT, 'data/pie.json');

    // Resultados de ontem (resolvidos nas últimas 24h)
    let greens = 0, reds = 0;
    if (existsSync(pendingPath)) {
      const pending  = JSON.parse(readFileSync(pendingPath, 'utf8'));
      const cutoff   = Date.now() - 48 * 3_600_000; // últimas 48h
      const resolved = pending.filter(e =>
        e.status === 'resolved' &&
        new Date(e.resolvedAt || 0).getTime() > cutoff
      );
      greens = resolved.filter(e => e.acertou === true).length;
      reds   = resolved.filter(e => e.acertou === false).length;
    }

    // Melhores mercados do PIE
    let topMarkets = [];
    if (existsSync(piePath)) {
      const pie = JSON.parse(readFileSync(piePath, 'utf8'));
      topMarkets = Object.entries(pie.calibration || {})
        .filter(([, v]) => v.total >= 30)
        .map(([k, v]) => ({ market: k, acc: Math.round(v.hits / v.total * 100) }))
        .sort((a, b) => b.acc - a.acc)
        .slice(0, 3);
    }

    const total = greens + reds;
    const taxa  = total > 0 ? Math.round((greens / total) * 100) : null;

    return { greens, reds, total, taxa, topMarkets };
  } catch {
    return { greens: 0, reds: 0, total: 0, taxa: null, topMarkets: [] };
  }
}

// ── Monta a mensagem ──────────────────────────────────────────────────────────
export function buildMorningText(ontem = buildResumoOntem()) {
  const dia  = diaSemana();
  const data = dataHoje();
  const { greens, reds, total, taxa, topMarkets } = ontem;

  // Bloco de resumo de ontem
  let resumoOntem;
  if (total === 0) {
    resumoOntem = [
      `  Ainda não temos resultados fechados pra comparar.`,
      `  Os sinais de hoje vão ajudar a calibrar ainda mais. 💪`,
    ].join('\n');
  } else {
    const linhasTaxa = taxa !== null
      ? `  ✅  ${greens} acerto${greens !== 1 ? 's' : ''}   ❌  ${reds} erro${reds !== 1 ? 's' : ''}   📈  ${taxa}% de aproveitamento`
      : `  📊  ${total} sinal${total !== 1 ? 'is' : ''} enviado${total !== 1 ? 's' : ''}`;

    const linhasMercados = topMarkets.length > 0
      ? [
          ``,
          `  Quem mais brilhou:`,
          ...topMarkets.map(m => `  🏅  ${m.market}: ${m.acc}% de acerto`),
        ].join('\n')
      : '';

    resumoOntem = [linhasTaxa, linhasMercados].join('\n');
  }

  // Monta o texto final
  const linhas = [
    `E aí, jogador! ${saudacao()} ☀️`,
    ``,
    `${dia}, ${data} — mais um dia de oportunidade chegando.`,
    `Bora ver o que rolou ontem e o que vem aí hoje 👇`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊  <b>ONTEM — Como foi:</b>`,
    ``,
    resumoOntem,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🎯  <b>HOJE — O que vem aí:</b>`,
    ``,
    `  ⏰  06:00  → Sinais PRÉ-LIVE do dia`,
    `  ⏰  13:00  → Mais sinais da tarde`,
    `  ⏰  Durante os jogos → AO VIVO ativado`,
    `  ⏰  Noite  → SUPER ODDS se pintar combo bom`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🏷️  <b>Mercados cobertos hoje:</b>`,
    ``,
    `  🥅  Gols — Over 1.5 · 2.5 · 3.5`,
    `  ⛳  Escanteios — Over 6.5 · 7.5 · 8.5`,
    `  🟨  Cartões — Over 2.5 · 3.5`,
    `  ⚽  Ambas Marcam — Sim / Não`,
    `  🔄  Dupla Chance — 1X · X2`,
    `  🚀  Super Odds — Combinações do dia`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `💪  Vamos que vamos. Os sinais chegam em breve!`,
    ``,
    `🤖  <i>Betting Analysis Squad</i>`,
  ];

  return linhas.join('\n');
}

// ── Boas-vindas para novo membro ──────────────────────────────────────────────
export function buildWelcomeText(nome = 'jogador') {
  return [
    `E aí, ${nome}! Seja bem-vindo(a) 🙌`,
    ``,
    `Que bom que você chegou! Aqui a gente manda os melhores`,
    `sinais de futebol todo dia — sem enrolação, direto ao ponto.`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `⚽  <b>O que rola por aqui:</b>`,
    ``,
    `  🟢  PRÉ-LIVE  → Sinal antes da bola rolar`,
    `  🔴  AO VIVO   → Oportunidade em tempo real`,
    `  🚀  SUPER ODDS → Combinações com retorno alto`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `⏰  <b>Quando chegam os sinais:</b>`,
    ``,
    `  06:00  → Primeira leva do dia`,
    `  13:00  → Segunda rodada da tarde`,
    `  Durante os jogos → AO VIVO quando pintar chance`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `💡  Fica ligado nas mensagens e bons lucros!`,
    ``,
    `🤖  <i>Betting Analysis Squad</i>`,
  ].join('\n');
}

// ── Lock diário — impede envio duplicado mesmo com múltiplos restarts ────────
const MORNING_LOCK_PATH = join(ROOT, 'data/morning-sent.json');

function _todayStr() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function _wasAlreadySentToday() {
  if (!existsSync(MORNING_LOCK_PATH)) return false;
  try {
    const lock = JSON.parse(readFileSync(MORNING_LOCK_PATH, 'utf8'));
    return lock.date === _todayStr();
  } catch { return false; }
}

function _markSentToday() {
  try {
    writeFileSync(MORNING_LOCK_PATH, JSON.stringify({
      date:    _todayStr(),
      sent_at: new Date().toISOString(),
    }), 'utf8');
  } catch {}
}

// ── Envia ao Telegram ─────────────────────────────────────────────────────────
export async function sendMorningMessage() {
  const text = buildMorningText();

  if (DRY) {
    console.log(chalk.cyan('\n─── PRÉVIA DA MENSAGEM (DRY RUN) ───\n'));
    console.log(text.replace(/<[^>]+>/g, ''));  // strip HTML para leitura no terminal
    console.log(chalk.cyan('\n────────────────────────────────────\n'));
    return;
  }

  if (!TOKEN || !CHAT_ID) {
    console.error(chalk.red('[MorningMessage] TELEGRAM_BOT_TOKEN ou CHAT_ID não configurados'));
    return;
  }

  // Dedup diário — bloqueia reenvio se já foi enviado hoje (protege contra restarts múltiplos)
  if (_wasAlreadySentToday()) {
    console.log(chalk.yellow('[MorningMessage] ⏭  Já enviado hoje — ignorando para evitar duplicata'));
    return;
  }

  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id:                  CHAT_ID,
    text,
    parse_mode:               'HTML',
    disable_web_page_preview: true,
  });

  _markSentToday();
  console.log(chalk.green('[MorningMessage] ✅ Mensagem de bom dia enviada'));
}

// ── Execução direta ───────────────────────────────────────────────────────────
if (process.argv[1]?.includes('morning-message')) {
  await sendMorningMessage();
}
