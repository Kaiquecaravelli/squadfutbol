/**
 * confronto-engine.js — Motor de confronto pré-análise vs dados reais
 *
 * Recebe os dados de um jogo finalizado e gera um diagnóstico estruturado:
 *  - Categoria: GREEN ou RED
 *  - Causa principal: por que acertou ou errou
 *  - Erro de lambda: previsão vs gols reais
 *  - Ação recomendada para o PIE
 *
 * Chamado pelo result-checker.js após cada GREEN/RED confirmado.
 * Salva uma lição estruturada via saveConfronto() do pie-storage.
 */

import { saveConfronto, getLambdaFator, setLambdaFator } from '../pie/pie-storage.js';

// ── Classificações de diagnóstico ─────────────────────────────────────────────
const CAUSAS = {
  LAMBDA_PRECISO:              'CALIBRACAO_OK',
  ALTA_CONFIANCA_CONFIRMADA:   'MODELO_CORRETO',
  SCORE_COMPOSTO:              'CALIBRACAO_OK',
  CARTAO_VERMELHO:             'FATOR_IMPREVISIVEL',
  PENALTI_DECISIVO:            'FATOR_IMPREVISIVEL',
  GOL_CONTRA:                  'FATOR_IMPREVISIVEL',
  LAMBDA_SUPERESTIMADO:        'LAMBDA_INCORRETO',
  LAMBDA_SUBESTIMADO:          'LAMBDA_INCORRETO',
  ALTA_CONFIANCA_FALHOU:       'MODELO_OTIMISTA',
  VARIANCIA_NORMAL:            'VARIANCIA',
};

const ACOES_PIE = {
  CALIBRACAO_OK:         'REGISTRAR_ACERTO',
  MODELO_CORRETO:        'REFORCAR_PESOS_CORRETOS',
  FATOR_IMPREVISIVEL:    'REGISTRAR_VARIANCIA',
  LAMBDA_INCORRETO:      'RECALIBRAR_LAMBDA',
  MODELO_OTIMISTA:       'REVISAR_GATE_LIGA',
  VARIANCIA:             'REGISTRAR_VARIANCIA',
};

// ── Diagnóstico principal ─────────────────────────────────────────────────────
export function analisarConfronto(entry, result, piePred) {
  const golsCasa   = Number(result.score?.home ?? 0);
  const golsFora   = Number(result.score?.away ?? 0);
  const golsReais  = golsCasa + golsFora;

  // xG estimado = xg_home + xg_away da predição PIE (modelo Poisson)
  const xgHome = Number(piePred?.xg_home ?? 0);
  const xgAway = Number(piePred?.xg_away ?? 0);
  const lambdaEstimado = (piePred && (xgHome + xgAway) > 0) ? xgHome + xgAway : null;
  const erroLambda     = lambdaEstimado !== null ? lambdaEstimado - golsReais : null;

  const probEstimada = Number(entry.probabilidade) || 0;
  const acertou      = entry.acertou;

  // Stats SofaScore (podem ser null se não disponíveis)
  const stats            = result.stats || {};
  const cartoesVermelhos = (stats.red_cards?.home  || 0) + (stats.red_cards?.away  || 0);
  const cartoesAmarelos  = (stats.yellow_cards?.home || 0) + (stats.yellow_cards?.away || 0);
  const escanteiosTotal  = (stats.corner_kicks?.home || 0) + (stats.corner_kicks?.away || 0);

  let causaPrincipal, licaoTexto;

  if (acertou) {
    // ── GREEN ─────────────────────────────────────────────────────────────────
    if (lambdaEstimado !== null && Math.abs(erroLambda) <= 0.8) {
      causaPrincipal = 'LAMBDA_PRECISO';
      licaoTexto = `Lambda preciso: previsto ${lambdaEstimado.toFixed(2)} vs ${golsReais} reais (erro ${erroLambda > 0 ? '+' : ''}${erroLambda.toFixed(2)}). Manter fator de liga.`;
    } else if (probEstimada >= 80) {
      causaPrincipal = 'ALTA_CONFIANCA_CONFIRMADA';
      licaoTexto = `Alta confiança (${probEstimada}%) confirmada. Padrão estrutural sólido para ${entry.competition}.`;
    } else {
      causaPrincipal = 'SCORE_COMPOSTO';
      licaoTexto = `Modelo correto. Score composto dentro da faixa esperada (prob ${probEstimada}%).`;
    }
  } else {
    // ── RED — ordem de prioridade no diagnóstico ──────────────────────────────
    if (cartoesVermelhos > 0) {
      causaPrincipal = 'CARTAO_VERMELHO';
      licaoTexto = `Cartão(ões) vermelho(s) alterou o jogo. Variância aceita — lambda não ajustado.`;
    } else if (lambdaEstimado !== null && erroLambda > 1.2) {
      causaPrincipal = 'LAMBDA_SUPERESTIMADO';
      licaoTexto = `Lambda superestimado: previsto ${lambdaEstimado.toFixed(2)} vs ${golsReais} gols reais (+${erroLambda.toFixed(2)}). Reduzir fator para ${entry.competition}.`;
    } else if (lambdaEstimado !== null && erroLambda < -1.2) {
      causaPrincipal = 'LAMBDA_SUBESTIMADO';
      licaoTexto = `Lambda subestimado: previsto ${lambdaEstimado.toFixed(2)} vs ${golsReais} gols reais (${erroLambda.toFixed(2)}). Aumentar fator para ${entry.competition}.`;
    } else if (probEstimada >= 85) {
      causaPrincipal = 'ALTA_CONFIANCA_FALHOU';
      licaoTexto = `Alta probabilidade (${probEstimada}%) não confirmada. Verificar condições estruturais da ${entry.competition}.`;
    } else {
      causaPrincipal = 'VARIANCIA_NORMAL';
      licaoTexto = `Resultado adverso dentro da variância (prob ${probEstimada}%). Aceitar — modelo dentro do esperado.`;
    }
  }

  const classificacao = CAUSAS[causaPrincipal] || 'VARIANCIA';
  const acaoPIE       = ACOES_PIE[classificacao] || 'REGISTRAR_VARIANCIA';

  return {
    categoria:          acertou ? 'GREEN' : 'RED',
    causa_principal:    causaPrincipal,
    classificacao,
    licao_texto:        licaoTexto,
    acao_pie:           acaoPIE,
    // Dados quantitativos
    gols_casa:          golsCasa,
    gols_fora:          golsFora,
    gols_reais:         golsReais,
    lambda_estimado:    lambdaEstimado,
    erro_lambda:        erroLambda !== null ? Number(erroLambda.toFixed(3)) : null,
    prob_estimada:      probEstimada,
    escanteios_total:   escanteiosTotal || null,
    cartoes_amarelos:   cartoesAmarelos || null,
    cartoes_vermelhos:  cartoesVermelhos,
  };
}

// ── Processo completo: analisar + salvar lição + recalibrar lambda ─────────────
export async function processarConfronto(entry, result, piePred) {
  try {
    const confronto = analisarConfronto(entry, result, piePred);

    // Salva lição estruturada no PIE
    saveConfronto({
      predictionId: piePred?.id || null,
      matchName:    entry.match,
      competition:  entry.competition || '',
      market:       entry.market,
      acertou:      entry.acertou,
      confronto,
    });

    // Ajuste imediato de lambda (só para erros grandes e confirmados)
    if (confronto.acao_pie === 'RECALIBRAR_LAMBDA' && entry.competition) {
      const fatorAtual = getLambdaFator(entry.competition);
      const ajuste     = confronto.causa_principal === 'LAMBDA_SUPERESTIMADO' ? -0.01 : +0.01;
      const novoFator  = Math.max(0.75, Math.min(1.25, fatorAtual + ajuste));

      if (novoFator !== fatorAtual) {
        setLambdaFator(entry.competition, novoFator);
        console.log(
          `[Confronto] λ-fator ${entry.competition}: ` +
          `${fatorAtual.toFixed(3)} → ${novoFator.toFixed(3)} ` +
          `(${confronto.causa_principal})`
        );
      }
    }

    console.log(
      `[Confronto] ${entry.match} · ${confronto.categoria} · ` +
      `${confronto.causa_principal} · ação=${confronto.acao_pie}`
    );
  } catch (err) {
    console.warn(`[Confronto] Falha ao processar ${entry.match}: ${err.message}`);
  }
}
