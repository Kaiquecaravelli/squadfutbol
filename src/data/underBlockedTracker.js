/**
 * underBlockedTracker.js — Registro e Monitoramento de Under Bloqueados
 *
 * Todo Under bloqueado na faixa 62–79% (antes do gate v3) ou 80–99% (gate atual)
 * é registrado para análise posterior.
 *
 * Permite medir se o gate de 80% está calibrado corretamente:
 *   · SE Under bloqueados teriam acertado ≥ 80%: gate possivelmente alto → revisar
 *   · SE Under bloqueados teriam acertado < 80%: gate correto → bloqueios válidos
 *
 * Exporta:
 *   registrarUnderBloqueado(matchData, mercado, prob, confianca, motivo) → void
 *   atualizarResultadoUnderBloqueado(id, gols_total)                    → void
 *   gerarRelatorioUnderBloqueados()                                      → string (HTML Telegram)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILE   = join(__dirname, '../../data/under-blocked.json');

// ── Persistência ──────────────────────────────────────────────────────────────
function _load() {
  try {
    if (existsSync(DB_FILE)) return JSON.parse(readFileSync(DB_FILE, 'utf-8'));
  } catch {}
  return { entries: [] };
}

function _save(db) {
  try { writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8'); }
  catch (e) { console.error('[UnderBlockedTracker] Falha ao salvar:', e.message); }
}

// ── Registro ──────────────────────────────────────────────────────────────────

/**
 * registrarUnderBloqueado — salva um Under que foi bloqueado pelo gate 80%.
 * Chamado sempre que um Under é reprovado na dupla validação.
 */
export function registrarUnderBloqueado(matchData, mercado, prob, confianca, motivo) {
  const match  = matchData?.match || `${matchData?.home_team} vs ${matchData?.away_team}`;
  const liga   = matchData?.competition || matchData?.league || '';
  const probPct  = prob   <= 1 ? Math.round(prob   * 100) : prob;
  const confPct  = confianca <= 1 ? Math.round(confianca * 100) : confianca;

  // Só registra faixa relevante (abaixo do gate) para não poluir DB com < 62%
  if (probPct < 62) return;

  const db = _load();
  const entrada = {
    id:              `under_bloq_${Date.now()}_${String(match).replace(/\s+/g, '_').substring(0, 30)}`,
    tipo:            'UNDER_BLOQUEADO_GATE_80',
    jogo:            match,
    liga,
    mercado,
    prob:            probPct,
    confianca:       confPct,
    gate_aplicado:   80,
    motivo,
    timestamp:       new Date().toISOString(),
    resultado_real:  null,
  };

  db.entries.push(entrada);

  // Manter apenas últimas 500 entradas (evita crescimento ilimitado)
  if (db.entries.length > 500) db.entries = db.entries.slice(-500);

  _save(db);
  console.log(`[UnderBlockedTracker] Registrado: ${match} · ${mercado} · prob ${probPct}% · conf ${confPct}%`);
}

/**
 * atualizarResultadoUnderBloqueado — preenche resultado real após o jogo.
 * Chamado pelo backfill quando o placar final é conhecido.
 */
export function atualizarResultadoUnderBloqueado(jogoNome, golsTotal) {
  const db = _load();
  let atualizados = 0;

  for (const e of db.entries) {
    if (e.resultado_real) continue;
    if (!e.jogo.toLowerCase().includes(jogoNome.toLowerCase().substring(0, 10))) continue;

    e.resultado_real = {
      gols_total:          golsTotal,
      under15_ocorreu:     golsTotal <= 1,
      under25_ocorreu:     golsTotal <= 2,
      timestamp_resultado: new Date().toISOString(),
    };
    atualizados++;
  }

  if (atualizados) {
    _save(db);
    console.log(`[UnderBlockedTracker] Atualizado: ${atualizados} entradas com gols_total=${golsTotal}`);
  }
}

// ── Relatório semanal ─────────────────────────────────────────────────────────

/**
 * gerarRelatorioUnderBloqueados — gera texto HTML para DM do admin.
 * Chamado todo domingo no scheduler.
 *
 * @returns {string} mensagem HTML para Telegram
 */
export function gerarRelatorioUnderBloqueados() {
  const db = _load();
  const agora = Date.now();
  const semana = 7 * 24 * 60 * 60_000;

  const bloqueados   = db.entries.filter(e => agora - new Date(e.timestamp).getTime() < semana);
  const comResultado = bloqueados.filter(e => e.resultado_real);

  const teriam_acertado = comResultado.filter(e => {
    const r = e.resultado_real;
    return (e.mercado === 'Under 1.5' && r.under15_ocorreu) ||
           (e.mercado === 'Under 2.5' && r.under25_ocorreu);
  });

  const pctAcerto = comResultado.length > 0
    ? (teriam_acertado.length / comResultado.length * 100).toFixed(1)
    : '0.0';

  const faixas = {
    '62-69%': bloqueados.filter(e => e.prob >= 62 && e.prob < 70).length,
    '70-74%': bloqueados.filter(e => e.prob >= 70 && e.prob < 75).length,
    '75-79%': bloqueados.filter(e => e.prob >= 75 && e.prob < 80).length,
  };

  const interpretacao = parseFloat(pctAcerto) >= 80
    ? `<i>Gate 80% possivelmente alto — verificar dados com n≥30</i>`
    : `<i>Gate 80% correto — bloqueios protegeram de erros</i>`;

  const data = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

  return [
    `📊 <b>Under Bloqueados — Semana ${data}</b>`,
    `════════════════════════════════════`,
    `Total bloqueados: <code>${bloqueados.length}</code>`,
    `Com resultado:    <code>${comResultado.length}</code>`,
    `Teriam acertado:  <code>${teriam_acertado.length}</code> (<code>${pctAcerto}%</code>)`,
    `————————————————————————————————————`,
    `<b>Por faixa de probabilidade:</b>`,
    `62–69%: <code>${faixas['62-69%']}</code> jogos`,
    `70–74%: <code>${faixas['70-74%']}</code> jogos`,
    `75–79%: <code>${faixas['75-79%']}</code> jogos`,
    `————————————————————————————————————`,
    interpretacao,
    `════════════════════════════════════`,
  ].join('\n');
}
