import { BaseMarketAgent } from './BaseMarketAgent.js';

/**
 * DoubleChanceAgent — Dupla Chance (1X / X2 / 12)
 * Fonte primária: Academia das Apostas (probabilidade histórica de mercado)
 * Validação: SofaScore (forma recente, H2H)
 */
export class DoubleChanceAgent extends BaseMarketAgent {
  constructor() {
    super({
      name:              'Dupla Chance',
      market:            'Dupla Chance',
      promptFile:        'double-chance.txt',
      primaryDataSource: 'academia',
    });
  }
}
