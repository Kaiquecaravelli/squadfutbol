/**
 * PIE Analyzer — Camada de Feedback, Memória e Treino
 * Compara predição vs resultado real, atualiza calibração e gera diretivas.
 */

import { saveResult, saveLesson, savePositiveLesson } from './pie-storage.js';

// ── Análise pós-evento ────────────────────────────────────────────────────────
export function analyzeResult(prediction, placar, extraData = {}) {
  const parts         = placar.split(/[-x×:]/i).map((s) => parseInt(s.trim()));
  const homeGoals     = isNaN(parts[0]) ? 0 : parts[0];
  const awayGoals     = isNaN(parts[1]) ? 0 : parts[1];
  const totalGols     = homeGoals + awayGoals;
  const ambosMarcaram = homeGoals > 0 && awayGoals > 0;

  // Dados extras opcionais (escanteios, cartões — quando informados via /resultado)
  const totalCantos   = extraData.corners ?? null;
  const totalCartoes  = extraData.cards   ?? null;

  const marketOutcomes = [];
  const newLessons     = [];

  for (const m of prediction.markets) {
    const { market: mercado, recommendation: rec, probabilidade } = m;
    const mu = (mercado || '').toUpperCase();
    const ru = (rec     || '').toUpperCase();

    let acertou   = null;
    let errorType = null;
    let errorDetail = '';

    // ── BTTS ────────────────────────────────────────────────────────────────
    if (mu.includes('BTTS') || mu.includes('AMBAS')) {
      const prevSim = ru === 'SIM' || ru === 'APOSTAR';
      acertou    = prevSim ? ambosMarcaram : !ambosMarcaram;
      errorDetail = `Resultado: ${homeGoals}-${awayGoals} (BTTS: ${ambosMarcaram ? 'SIM' : 'NÃO'})`;

    // ── GOLS OVER/UNDER ──────────────────────────────────────────────────────
    } else if (mu.includes('OVER') || mu.includes('UNDER') ||
               mu.includes('GOLS') || mu.includes('TOTAL')) {
      const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? ru.match(/[\d.]+/)?.[0] ?? '2.5');
      const isOver = ru.includes('OVER') || ru.includes('MAIS') || ru === 'SIM' || ru === 'APOSTAR';
      acertou    = isOver ? totalGols > linha : totalGols < linha;
      errorDetail = `Total de gols: ${totalGols} (linha: ${linha})`;

    // ── ESCANTEIOS ───────────────────────────────────────────────────────────
    } else if (mu.includes('ESCANTEIO') || mu.includes('CANTO') || mu.includes('CORNER')) {
      if (totalCantos !== null) {
        const linha  = parseFloat(mu.match(/[\d.]+/)?.[0] ?? ru.match(/[\d.]+/)?.[0] ?? '9.5');
        const isOver = ru.includes('OVER') || ru.includes('MAIS') || ru === 'APOSTAR';
        acertou    = isOver ? totalCantos > linha : totalCantos < linha;
        errorDetail = `Total de escanteios: ${totalCantos} (linha: ${linha})`;
      }
      // null = não verificável se não informado

    // ── CARTÕES ─────────────────────────────────────────────────────────────
    } else if (mu.includes('CARTÃO') || mu.includes('CARTAO') || mu.includes('AMARELO')) {
      if (totalCartoes !== null) {
        const linha  = parseFloat(mu.match(/[\d.]+/)?.[0] ?? ru.match(/[\d.]+/)?.[0] ?? '3.5');
        const isOver = ru.includes('OVER') || ru.includes('MAIS') || ru === 'APOSTAR';
        acertou    = isOver ? totalCartoes > linha : totalCartoes < linha;
        errorDetail = `Total de cartões: ${totalCartoes} (linha: ${linha})`;
      }

    // ── DUPLA CHANCE ─────────────────────────────────────────────────────────
    } else if (mu.includes('DUPLA') || mu.includes('CHANCE') ||
               mu === '1X' || mu === 'X2' || mu === '12') {
      const sel = mu.includes('1X') || ru === '1X' ? '1X'
                : mu.includes('X2') || ru === 'X2' ? 'X2'
                : mu.includes('12') || ru === '12' ? '12' : ru;
      if      (sel === '1X') acertou = homeGoals >= awayGoals;
      else if (sel === 'X2') acertou = awayGoals >= homeGoals;
      else if (sel === '12') acertou = homeGoals !== awayGoals;
      errorDetail = `Placar: ${homeGoals}-${awayGoals} (${homeGoals > awayGoals ? 'Mandante' : awayGoals > homeGoals ? 'Visitante' : 'Empate'})`;

    // ── PLACAR EXATO ─────────────────────────────────────────────────────────
    } else if (mu.includes('PLACAR') || mu.includes('EXATO')) {
      const match = (rec || '').match(/(\d+)\s*[x×\-:]\s*(\d+)/i);
      if (match) {
        acertou    = parseInt(match[1]) === homeGoals && parseInt(match[2]) === awayGoals;
        errorDetail = `Previsto: ${match[1]}-${match[2]} | Real: ${homeGoals}-${awayGoals}`;
      }
    }

    // ── Classificação e geração de diretiva ──────────────────────────────────
    if (acertou === false) {
      const prob = Number(probabilidade) || 0;
      errorType = prob >= 90 ? 'overconfidence' : prob >= 85 ? 'model_failure' : 'noise';
      const directive = _generateDirective(mercado, rec, {
        homeGoals, awayGoals, totalGols, ambosMarcaram,
        totalCantos, totalCartoes, errorDetail, probabilidade,
      }, errorType);
      if (directive) {
        newLessons.push({
          market: mercado, competition: prediction.competition,
          directive, errorType, predictionId: prediction.id,
        });
      }
    } else if (acertou === true && Number(probabilidade) >= 85) {
      // Lição positiva — reforça padrões que funcionaram com alta confiança
      const positiveDirective = _generatePositiveDirective(mercado, rec, {
        homeGoals, awayGoals, totalGols, ambosMarcaram,
        totalCantos, totalCartoes, probabilidade,
      });
      if (positiveDirective) {
        newLessons.push({
          market: mercado, competition: prediction.competition,
          directive: positiveDirective, errorType: 'positive_reinforcement',
          predictionId: prediction.id, isPositive: true,
        });
      }
    }

    marketOutcomes.push({ market: mercado, recommendation: rec, probabilidade, acertou, error_type: errorType });
  }

  // Persistir resultado e lições
  saveResult({ predictionId: prediction.id, matchName: prediction.match_name, placarReal: placar, marketOutcomes });
  for (const l of newLessons) {
    if (l.isPositive) savePositiveLesson(l);
    else saveLesson(l);
  }

  return { marketOutcomes, newLessons, homeGoals, awayGoals, totalGols, ambosMarcaram };
}

// ── Geração de diretivas positivas — reforça o que funcionou ─────────────────
function _generatePositiveDirective(mercado, rec, ctx) {
  const mu  = (mercado || '').toUpperCase();
  const ru  = (rec     || '').toUpperCase();
  const { homeGoals, awayGoals, totalGols, ambosMarcaram, totalCantos, totalCartoes, probabilidade } = ctx;
  const prob = Number(probabilidade) || 0;

  if (mu.includes('BTTS') || mu.includes('AMBAS')) {
    if (ambosMarcaram && (ru === 'SIM' || ru === 'APOSTAR'))
      return `✅ ACERTO BTTS SIM — Placar ${homeGoals}-${awayGoals}. Padrão validado com ${prob}% de confiança. Continuar priorizando quando ambos têm média > 1.2 gols/jogo.`;
    if (!ambosMarcaram && ru === 'NÃO')
      return `✅ ACERTO BTTS NÃO — Clean sheet confirmado (${homeGoals}-${awayGoals}). Padrão válido: time com clean sheet > 40% + adversário com baixo xG.`;
  }

  if (mu.includes('OVER') || (mu.includes('GOLS') && (ru.includes('OVER') || ru === 'APOSTAR'))) {
    const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? '2.5');
    if (totalGols > linha)
      return `✅ ACERTO Over ${linha} — ${totalGols} gols. Padrão validado com ${prob}%. Manter confiança em jogos com xG total > ${(linha * 0.8).toFixed(1)}.`;
  }

  if (mu.includes('UNDER') || (mu.includes('GOLS') && ru.includes('UNDER'))) {
    const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? '2.5');
    if (totalGols < linha)
      return `✅ ACERTO Under ${linha} — Apenas ${totalGols} gols. Continuar aplicando Under em equipes defensivas (< 1.2 gols/jogo).`;
  }

  if (mu.includes('DUPLA') || mu.includes('CHANCE') || mu === '1X' || mu === 'X2' || mu === '12') {
    return `✅ ACERTO Dupla Chance — Resultado confirmado (${homeGoals}-${awayGoals}). Modelo calibrado corretamente neste cenário.`;
  }

  return null;
}

// ── Geração de diretivas de aprendizado — específicas e acionáveis ────────────
function _generateDirective(mercado, rec, ctx, errorType) {
  const mu  = (mercado || '').toUpperCase();
  const ru  = (rec     || '').toUpperCase();
  const { homeGoals, awayGoals, totalGols, ambosMarcaram, totalCantos, totalCartoes,
          errorDetail, probabilidade } = ctx;
  const nivel = errorType === 'overconfidence' ? '🚨 SUPERCONFIANÇA' : errorType === 'model_failure' ? '🔴 FALHA DE MODELO' : '🟡 RUÍDO';
  const prob  = Number(probabilidade) || 0;

  // ── BTTS ──────────────────────────────────────────────────────────────────
  if (mu.includes('BTTS') || mu.includes('AMBAS')) {
    if (!ambosMarcaram && (ru === 'SIM' || ru === 'APOSTAR')) {
      const gols0 = homeGoals === 0 || awayGoals === 0;
      if (gols0 && prob >= 85)
        return `${nivel} BTTS SIM — Time sem marcar (${homeGoals}-${awayGoals}). Regra: penalizar equipes com clean sheet > 40% nas últimas 5. xG < 0.7 por jogo é sinal de BTTS NÃO mesmo com histórico positivo.`;
      return `${nivel} BTTS SIM — ${errorDetail}. Elevar peso do clean-sheet histórico. Confrontos com alta pressão defensiva (copa eliminatória) tendem ao NÃO.`;
    }
    if (ambosMarcaram && ru === 'NÃO')
      return `${nivel} BTTS NÃO — Ambos marcaram (${homeGoals}-${awayGoals}). Times com ataque acima de 1.5 gols/jogo raramente fecham o placar. Revisar visitantes ofensivos fora de casa.`;
  }

  // ── OVER GOLS ─────────────────────────────────────────────────────────────
  if ((mu.includes('OVER') || (mu.includes('GOLS') && (ru.includes('OVER') || ru === 'APOSTAR')))) {
    const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? ru.match(/[\d.]+/)?.[0] ?? '2.5');
    if (totalGols <= linha) {
      if (prob >= 90)
        return `${nivel} Over ${linha} — Apenas ${totalGols} gols (alta confiança foi erro grave). Verificar motivação: times sem necessidade de resultado frequentemente bloqueiam o jogo. Reduzir confiança em jogos de oitavas/quartas com mandante favorito.`;
      return `${nivel} Over ${linha} — ${totalGols} gols. Ajustar lambda considerando jogos decisivos: times em vantagem no agregado tendem ao recuo defensivo.`;
    }
  }

  // ── UNDER GOLS ────────────────────────────────────────────────────────────
  if (mu.includes('UNDER') || (mu.includes('GOLS') && ru.includes('UNDER'))) {
    const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? ru.match(/[\d.]+/)?.[0] ?? '2.5');
    if (totalGols > linha)
      return `${nivel} Under ${linha} — ${totalGols} gols (acima da linha). Verificar desfalques defensivos e motivação das equipes. Times pressionados por rebaixamento atacam mais independente do histórico.`;
  }

  // ── ESCANTEIOS ────────────────────────────────────────────────────────────
  if (mu.includes('ESCANTEIO') || mu.includes('CANTO') || mu.includes('CORNER')) {
    if (totalCantos !== null) {
      const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? '9.5');
      const isOver = ru.includes('OVER') || ru === 'APOSTAR';
      if (isOver && totalCantos <= linha)
        return `${nivel} Escanteios Over ${linha} — Apenas ${totalCantos} escanteios. Jogos com pressão de tabela (equipe necessitando ponto) geram mais escanteios. Revisar posse de bola dominante do favorito como preditor.`;
      if (!isOver && totalCantos > linha)
        return `${nivel} Escanteios Under ${linha} — ${totalCantos} escanteios. Reduzir Under em confrontos equilibrados — bola disputada gera mais saídas pela linha de fundo.`;
    }
    return `${nivel} Escanteios — Mercado não verificado pelo placar. Registre total de escanteios com /resultado para treinar este analista.`;
  }

  // ── CARTÕES ───────────────────────────────────────────────────────────────
  if (mu.includes('CARTÃO') || mu.includes('CARTAO') || mu.includes('AMARELO')) {
    if (totalCartoes !== null) {
      const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? '3.5');
      const isOver = ru.includes('OVER') || ru === 'APOSTAR';
      if (isOver && totalCartoes <= linha)
        return `${nivel} Cartões Over ${linha} — Apenas ${totalCartoes} cartões. Árbitros permissivos ou jogos com pouca rivalidade geram menos cartões. Incluir histórico do árbitro como variável.`;
      if (!isOver && totalCartoes > linha)
        return `${nivel} Cartões Under ${linha} — ${totalCartoes} cartões. Confrontos diretos por rebaixamento ou decisivos têm 40% mais cartões em média.`;
    }
    return `${nivel} Cartões — Mercado não verificado. Registre total de cartões com /resultado para treinar este analista.`;
  }

  // ── DUPLA CHANCE ──────────────────────────────────────────────────────────
  if (mu.includes('DUPLA') || mu.includes('CHANCE') || mu === '1X' || mu === 'X2' || mu === '12') {
    const sel = mu === '1X' || ru === '1X' ? '1X' : mu === 'X2' || ru === 'X2' ? 'X2' : '12';
    if (sel === '1X' && awayGoals > homeGoals)
      return `${nivel} Dupla Chance 1X — Visitante venceu (${homeGoals}-${awayGoals}). Mandante em má fase (< 40% aproveitamento em casa) perde o fator casa. Manter 1X apenas se mandante > 50% aproveitamento.`;
    if (sel === 'X2' && homeGoals > awayGoals)
      return `${nivel} Dupla Chance X2 — Mandante venceu (${homeGoals}-${awayGoals}). Time da casa motivado (luta por título/contra rebaixamento) amplifica vantagem de campo. Reduzir X2 em clássicos.`;
    if (sel === '12' && homeGoals === awayGoals)
      return `${nivel} Dupla Chance 12 — Empate (${homeGoals}-${awayGoals}). Empates mais frequentes em jogos com pressão mútua. Considerar BTTS + Over como alternativa.`;
  }

  // ── PLACAR EXATO ─────────────────────────────────────────────────────────
  if (mu.includes('PLACAR') || mu.includes('EXATO'))
    return `${nivel} Placar Exato — ${errorDetail}. Exigir probabilidade ≥ 90% e confiança ≥ 85% para este mercado. Usar apenas como aposta complementar.`;

  return null;
}
