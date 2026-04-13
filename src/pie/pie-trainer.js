/**
 * PIE Trainer — Sistema de Treinamento dos Analistas
 *
 * Injeta nos agentes:
 *  1. Calibração histórica (acurácia real por faixa de probabilidade)
 *  2. Padrões por competição
 *  3. Lições aprendidas priorizadas por peso
 *
 * O objetivo é transformar cada agente em um especialista que aprende com
 * seus próprios erros e acertos ao longo do tempo.
 */

import { getAgentCalibration, getActiveLessons, getAllActiveLessons, getPositivePatterns } from './pie-storage.js';

// ── Contexto de expertise para injetar no prompt do agente ────────────────────
export function getExpertiseContext(market, competition) {
  const lines  = [];
  const calib  = getAgentCalibration(market);
  const lessons = getActiveLessons(market, competition);

  // ── 1. Calibração histórica ──────────────────────────────────────────────
  if (calib && calib.samples >= 5) {
    const acc     = Number(calib.overall);
    // Baseline dinâmico: média das probabilidades declaradas seria o esperado.
    // Sem esse dado, usamos 75% como baseline conservador (melhor que fixar 82.5%)
    const baseline = _getDynamicBaseline(market);
    const bias    = _classifyBias(acc, baseline);
    const biasMsg = bias === 'over'
      ? `⚠️ VIÉS DETECTADO: Você tende a SUPERESTIMAR probabilidades neste mercado (acurácia real ${acc}% vs baseline esperado ${baseline}%). Seja mais conservador.`
      : bias === 'under'
        ? `⚠️ VIÉS DETECTADO: Você tende a SUBESTIMAR neste mercado (acurácia real ${acc}% acima do baseline ${baseline}%). Pode ser mais assertivo.`
        : `✅ CALIBRAÇÃO OK: Acurácia histórica ${acc}% em ${calib.samples} predições (baseline: ${baseline}%).`;

    lines.push(`[CALIBRAÇÃO DO ANALISTA — ${market.toUpperCase()}]`);
    lines.push(biasMsg);

    // Por faixa de probabilidade
    if (calib.ranges.length) {
      lines.push(`Desempenho por faixa de probabilidade declarada:`);
      for (const r of calib.ranges) {
        const accR  = Number(r.accuracy);
        const delta = (accR - baseline).toFixed(1);
        const sign  = Number(delta) >= 0 ? '+' : '';
        lines.push(`  • Faixa ${r.range}%: acertou ${r.accuracy}% (${r.samples} amostras) [${sign}${delta}% vs baseline]`);
      }
    }

    // Por competição
    if (calib.competitions.length) {
      lines.push(`Desempenho por competição:`);
      for (const c of calib.competitions) {
        const accC = Number(c.accuracy);
        const flag = accC >= 70 ? '✅' : accC >= 50 ? '⚠️' : '❌';
        lines.push(`  ${flag} ${c.comp}: ${c.accuracy}% (${c.samples} amostras)`);
      }
    }
  }

  // ── 2. Lições aprendidas (erros) ─────────────────────────────────────────
  if (lessons.length) {
    lines.push(`\n[LIÇÕES APRENDIDAS — aplicar obrigatoriamente]`);
    lessons.forEach((l, i) => {
      const prioridade = (l.weight || 1) >= 2 ? '🔴 CRÍTICO' : '🟡 ATENÇÃO';
      lines.push(`${i + 1}. ${prioridade} — ${l.directive}`);
      if (l.applied_count > 0) lines.push(`   (Padrão observado ${l.applied_count + 1}x)`);
    });
  }

  // ── 3. Padrões positivos (reforços) ──────────────────────────────────────
  const positives = getPositivePatterns(market);
  if (positives.length) {
    lines.push(`\n[PADRÕES QUE FUNCIONAM — manter e reforçar]`);
    positives.forEach((p, i) => {
      const confirmacoes = p.confirmed_count > 0 ? ` (confirmado ${p.confirmed_count + 1}x)` : '';
      lines.push(`${i + 1}. ${p.directive}${confirmacoes}`);
    });
  }

  return lines.length ? lines.join('\n') : '';
}

// ── Baseline por mercado — reflete a dificuldade real de cada mercado ─────────
function _getDynamicBaseline(market) {
  const mu = (market || '').toUpperCase();
  // Placar exato é muito mais difícil — baseline mais baixo
  if (mu.includes('PLACAR') || mu.includes('EXATO')) return 25;
  // Escanteios e cartões têm maior variância
  if (mu.includes('ESCANTEIO') || mu.includes('CORNER') || mu.includes('CANTO')) return 60;
  if (mu.includes('CARTÃO') || mu.includes('CARTAO') || mu.includes('AMARELO')) return 58;
  // BTTS e Over/Under têm baseline próximo de 50% (evento binário)
  if (mu.includes('BTTS') || mu.includes('AMBAS')) return 55;
  if (mu.includes('OVER') || mu.includes('UNDER') || mu.includes('GOLS')) return 60;
  if (mu.includes('DUPLA') || mu.includes('CHANCE')) return 70;
  return 65; // default conservador
}

// ── Classificação de viés do agente ──────────────────────────────────────────
function _classifyBias(accuracy, baseline) {
  const base = baseline || 65;
  // Se acurácia real < (baseline - 15pp), há superestimação sistemática
  if (accuracy < base - 15) return 'over';
  // Se acurácia > (baseline + 15pp), pode estar subestimando
  if (accuracy > base + 15) return 'under';
  return 'calibrated';
}

// ── Relatório de treinamento — para log interno ───────────────────────────────
export function generateTrainingReport() {
  const markets = [
    'BTTS', 'Over 1.5', 'Over 2.5', 'Over 3.5', 'Under 2.5',
    'Over 8.5', 'Over 9.5', 'Over 10.5',
    'Over 3.5 cartões', 'Over 4.5 cartões',
    'Dupla Chance', 'Placar Exato',
  ];

  const report = [];
  for (const market of markets) {
    const calib = getAgentCalibration(market);
    if (!calib) continue;
    const baseline = _getDynamicBaseline(market);
    report.push({
      market,
      acuracia:   `${calib.overall}%`,
      amostras:   calib.samples,
      bias:       _classifyBias(Number(calib.overall), baseline),
      baseline:   `${baseline}%`,
      byRange:    calib.ranges,
    });
  }

  return report;
}

// ── Resumo de expertise para log no console ───────────────────────────────────
export function logExpertiseSummary() {
  const report = generateTrainingReport();
  if (!report.length) return;
  console.log('\n📚 [PIE Trainer] Calibração dos Analistas:');
  for (const r of report) {
    const biasIcon = r.bias === 'over' ? '⚠️ ' : r.bias === 'under' ? '📈' : '✅';
    console.log(`  ${biasIcon} ${r.market.padEnd(20)} ${r.acuracia.padEnd(6)} (${r.amostras} amostras)`);
  }
}
