import { BaseMarketAgent } from './BaseMarketAgent.js';

/**
 * GoalsAgent — Over/Under Gols
 * Fonte primária: Academia das Apostas (probabilidade histórica de mercado)
 * Validação: SofaScore (xG técnico, janelas temporais)
 *
 * Módulo 4 (2026-04-16): injeta taxas Over 1.5 por janela e sinais de divergência.
 * Divergência 5j vs 8j > 25pp → flag "TENDÊNCIA EM MUDANÇA" → reduz confiança -5pp.
 */
export class GoalsAgent extends BaseMarketAgent {
  constructor() {
    super({
      name:              'Gols',
      market:            'Total de Gols',
      promptFile:        'goals.txt',
      primaryDataSource: 'academia',
    });
  }

  /**
   * Injeta taxas Over 1.5 por janela e divergência de tendência.
   * Divergência entre janela curta (5j) e longa (8j) sinaliza mudança de padrão.
   */
  _buildAgentExtras(matchData) {
    const h = matchData.home || {};
    const a = matchData.away || {};
    const extras = {};

    // Taxas Over 1.5 por janela temporal
    if (h.over15_pct_5j != null) extras.over15_5j_casa = h.over15_pct_5j;
    if (h.over15_pct_8j != null) extras.over15_8j_casa = h.over15_pct_8j;
    if (a.over15_pct_5j != null) extras.over15_5j_fora = a.over15_pct_5j;
    if (a.over15_pct_8j != null) extras.over15_8j_fora = a.over15_pct_8j;

    // Divergência entre janelas — sinal de tendência em mudança
    // > 25pp = padrão estrutural e recente divergem → reduzir confiança -5pp
    if (h.over15_pct_5j != null && h.over15_pct_8j != null) {
      const div = Math.abs(h.over15_pct_5j - h.over15_pct_8j);
      if (div > 0) extras.divergencia_over15_casa = div;
    }
    if (a.over15_pct_5j != null && a.over15_pct_8j != null) {
      const div = Math.abs(a.over15_pct_5j - a.over15_pct_8j);
      if (div > 0) extras.divergencia_over15_fora = div;
    }

    return Object.keys(extras).length ? extras : null;
  }
}
