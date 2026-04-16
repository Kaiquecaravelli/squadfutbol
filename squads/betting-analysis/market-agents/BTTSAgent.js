import { BaseMarketAgent } from './BaseMarketAgent.js';

/**
 * BTTSAgent — Ambas Marcam (Both Teams To Score)
 * Fonte primária: Academia das Apostas (probabilidade histórica de mercado)
 * Validação: SofaScore (médias de gols, xG, sequências)
 *
 * Módulo 4 (2026-04-16): injeta dados de sequência e janelas temporais no payload.
 * Dados calculados em parseTeamForm() do sofascore.js a partir dos placares reais.
 */
export class BTTSAgent extends BaseMarketAgent {
  constructor() {
    super({
      name:              'BTTS',
      market:            'Ambas Marcam',
      promptFile:        'btts.txt',
      primaryDataSource: 'academia',
    });
  }

  /**
   * Injeta dados de sequência BTTS e janelas temporais no payload.
   * O modelo usa estes dados para calcular probabilidade condicional
   * P(BTTS | N jogos sem BTTS) > P(BTTS base).
   */
  _buildAgentExtras(matchData) {
    const h = matchData.home || {};
    const a = matchData.away || {};
    const extras = {};

    // Sequência consecutiva (pressão estatística para ocorrência)
    if (h.sequencia_sem_btts != null) extras.sequencia_sem_btts_casa = h.sequencia_sem_btts;
    if (a.sequencia_sem_btts != null) extras.sequencia_sem_btts_fora = a.sequencia_sem_btts;
    if (h.sequencia_btts != null && h.sequencia_btts > 0) extras.sequencia_btts_casa = h.sequencia_btts;
    if (a.sequencia_btts != null && a.sequencia_btts > 0) extras.sequencia_btts_fora = a.sequencia_btts;

    // Taxas BTTS por janela temporal (5j = tendência recente · 8j = estrutural)
    if (h.btts_pct_5j != null) extras.btts_5j_casa = h.btts_pct_5j;
    if (a.btts_pct_5j != null) extras.btts_5j_fora = a.btts_pct_5j;
    if (h.btts_pct_8j != null) extras.btts_8j_casa = h.btts_pct_8j;
    if (a.btts_pct_8j != null) extras.btts_8j_fora = a.btts_pct_8j;

    // Over 1.5 por janela (proxy de atividade ofensiva recente)
    if (h.over15_pct_5j != null) extras.over15_5j_casa = h.over15_pct_5j;
    if (a.over15_pct_5j != null) extras.over15_5j_fora = a.over15_pct_5j;

    return Object.keys(extras).length ? extras : null;
  }
}
