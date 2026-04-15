import { BaseMarketAgent } from './BaseMarketAgent.js';

/**
 * BTTSAgent — Ambas Marcam (Both Teams To Score)
 * Fonte primária: Academia das Apostas (probabilidade histórica de mercado)
 * Validação: SofaScore (médias de gols, xG)
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
}
