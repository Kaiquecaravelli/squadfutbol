/**
 * feed-loop.js — Sistema de autoalimentação do PIE
 *
 * Lê as lições de confronto acumuladas e:
 *  1. Agrupa por liga + mercado
 *  2. Detecta padrões de erro recorrentes
 *  3. Ajusta lambdaFatores automaticamente (±0.01 por ciclo, cap ±0.25)
 *  4. Envia relatório semanal ao admin (domingo)
 *
 * Limites automáticos:
 *  - Ajuste máximo por ciclo: ±0.01 por liga
 *  - lambdaFator jamais sai do range [0.75, 1.25]
 *  - Gate Under 80% e Kill Zone 71%: NUNCA alterados automaticamente
 *  - Pesos D1–D8: não alterados (sem armazenamento de dimensões por jogo)
 *
 * Ativado: diariamente às 06:00 via scheduler.js
 *          a cada 10 lições novas acumuladas (verificação horária)
 */

import 'dotenv/config';
import {
  getLicoesConfronto,
  marcarLicoesProcessadas,
  getLambdaFator,
  setLambdaFator,
  getStats,
} from '../pie/pie-storage.js';

const ADMIN_ID = process.env.TELEGRAM_ADMIN_USER_ID;
const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;

// ── Envio ao admin ─────────────────────────────────────────────────────────────
async function _notifyAdmin(msg) {
  if (!ADMIN_ID || !TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: ADMIN_ID, text: msg, parse_mode: 'HTML' }),
    });
  } catch { /* silent */ }
}

// ── Agrupamento por liga + mercado ────────────────────────────────────────────
function _agrupar(licoes) {
  const grupos = {};
  for (const l of licoes) {
    const chave = `${l.competition || 'geral'}__${l.market || 'geral'}`;
    if (!grupos[chave]) grupos[chave] = [];
    grupos[chave].push(l);
  }
  return grupos;
}

// ── Detectar causa recorrente num grupo ───────────────────────────────────────
function _causaRecorrente(grupo, causa, minOcorrencias) {
  const erros = grupo.filter(l => !l.acertou && l.confronto?.causa_principal === causa);
  return erros.length >= minOcorrencias;
}

// ── Calcular precisão do grupo ────────────────────────────────────────────────
function _precisao(grupo) {
  const acertos = grupo.filter(l => l.acertou).length;
  return grupo.length > 0 ? acertos / grupo.length : 0;
}

// ── Executar ciclo de autoalimentação ─────────────────────────────────────────
export async function executarFeedLoop(opts = {}) {
  const { verbose = true, forcarRelatorio = false } = opts;

  if (verbose) console.log('\n[FeedLoop] Iniciando ciclo de autoalimentação...');

  // 1. Carregar lições com confronto não processadas (últimos 30 dias)
  const licoes = getLicoesConfronto({ dias: 30, apenasNaoProcessadas: true });

  if (licoes.length === 0) {
    if (verbose) console.log('[FeedLoop] Sem lições novas para processar.');
    return { processadas: 0, ajustes: 0 };
  }

  if (verbose) console.log(`[FeedLoop] ${licoes.length} lição(ões) para processar`);

  // 2. Agrupar por liga + mercado
  const grupos = _agrupar(licoes);
  let ajustes = 0;
  const ajustesLog = [];

  for (const [chave, grupo] of Object.entries(grupos)) {
    const [liga, mercado] = chave.split('__');
    const n = grupo.length;
    const precisaoAtual = _precisao(grupo);

    if (verbose) {
      console.log(
        `[FeedLoop] ${liga} · ${mercado}: n=${n} · precisão=${(precisaoAtual * 100).toFixed(0)}%`
      );
    }

    // 3. Ajuste de lambda só com >= 3 amostras (evitar ruído)
    if (n < 3) continue;

    const fatorAtual = getLambdaFator(liga);
    let novoFator    = fatorAtual;

    // LAMBDA_SUPERESTIMADO recorrente (>=2 em 5): reduzir -0.01
    if (_causaRecorrente(grupo, 'LAMBDA_SUPERESTIMADO', 2)) {
      novoFator = Math.max(0.75, fatorAtual - 0.01);
      if (novoFator !== fatorAtual) {
        ajustesLog.push(`${liga}: λ ${fatorAtual.toFixed(3)} → ${novoFator.toFixed(3)} (superestimado)`);
      }
    }

    // LAMBDA_SUBESTIMADO recorrente (>=2 em 5): aumentar +0.01
    if (_causaRecorrente(grupo, 'LAMBDA_SUBESTIMADO', 2)) {
      novoFator = Math.min(1.25, fatorAtual + 0.01);
      if (novoFator !== fatorAtual) {
        ajustesLog.push(`${liga}: λ ${fatorAtual.toFixed(3)} → ${novoFator.toFixed(3)} (subestimado)`);
      }
    }

    // ALTA_CONFIANCA_FALHOU recorrente (>=2 em 5): reduzir levemente -0.01
    if (_causaRecorrente(grupo, 'ALTA_CONFIANCA_FALHOU', 2)) {
      novoFator = Math.max(0.75, fatorAtual - 0.01);
      if (novoFator !== fatorAtual) {
        ajustesLog.push(`${liga}: λ ${fatorAtual.toFixed(3)} → ${novoFator.toFixed(3)} (alta conf falhou)`);
      }
    }

    if (novoFator !== fatorAtual) {
      setLambdaFator(liga, novoFator);
      ajustes++;
      console.log(`[FeedLoop] λ-fator ${liga}: ${fatorAtual.toFixed(3)} → ${novoFator.toFixed(3)}`);
    }

    // 4. Bloquear liga se precisão < 50% com >= 10 amostras (alerta admin)
    if (precisaoAtual < 0.50 && n >= 10) {
      await _notifyAdmin(
        `⚠️ <b>FeedLoop — Alerta de Liga</b>\n\n` +
        `<b>${liga}</b> · ${mercado}\n` +
        `Precisão: ${(precisaoAtual * 100).toFixed(0)}% (n=${n})\n\n` +
        `<i>Abaixo de 50% em 10+ amostras — revisão manual recomendada.</i>`
      );
    }
  }

  // 5. Marcar lições como processadas
  const ids = licoes.map(l => l.id).filter(Boolean);
  marcarLicoesProcessadas(ids);

  if (verbose) console.log(`[FeedLoop] Concluído: ${licoes.length} lições · ${ajustes} ajuste(s) de λ`);

  // 6. Relatório de domingo (ou forçado)
  const agora     = new Date();
  const domingo   = agora.getDay() === 0;
  const hora6     = agora.getHours() === 6;

  if ((domingo && hora6) || forcarRelatorio) {
    await _enviarRelatorioSemanal(ajustesLog);
  }

  return { processadas: licoes.length, ajustes };
}

// ── Relatório semanal ao admin ─────────────────────────────────────────────────
async function _enviarRelatorioSemanal(ajustesLog) {
  const stats = getStats();
  const precisao = stats.taxaAcerto ? `${stats.taxaAcerto}%` : 'N/D';

  const ajustesTexto = ajustesLog.length > 0
    ? ajustesLog.map(a => `• ${a}`).join('\n')
    : '• Nenhum ajuste necessário esta semana';

  const msg =
    `📈 <b>FeedLoop — Relatório Semanal</b>\n\n` +
    `<b>PIE Global:</b>\n` +
    `• Precisão: <b>${precisao}</b> (${stats.verificaveis} verificáveis)\n` +
    `• Acertos: ${stats.acertos} · Erros: ${stats.erros}\n` +
    `• Lições ativas: ${stats.licoesAtivas}\n\n` +
    `<b>Ajustes de λ aplicados:</b>\n${ajustesTexto}\n\n` +
    `<i>${new Date().toLocaleString('pt-BR')}</i>`;

  await _notifyAdmin(msg);
  console.log('[FeedLoop] Relatório semanal enviado ao admin');
}

// ── Verificação horária (aciona se >= 10 lições pendentes) ───────────────────
export async function verificarFeedLoop() {
  try {
    const licoes = getLicoesConfronto({ dias: 7, apenasNaoProcessadas: true });
    if (licoes.length >= 10) {
      console.log(`[FeedLoop] ${licoes.length} lições acumuladas — acionando ciclo`);
      await executarFeedLoop({ verbose: false });
    }
  } catch (err) {
    console.warn(`[FeedLoop] Erro na verificação: ${err.message}`);
  }
}
