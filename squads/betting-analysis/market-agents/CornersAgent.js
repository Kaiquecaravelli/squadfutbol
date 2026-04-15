import { BaseMarketAgent } from './BaseMarketAgent.js';

/**
 * CornersAgent — Over/Under Escanteios
 * Fonte primária: SofaScore (estatísticas técnicas ao vivo: corners_avg, chutes, pressão)
 * Validação: Academia das Apostas (tendência histórica de mercado)
 */
export class CornersAgent extends BaseMarketAgent {
  constructor() {
    super({
      name:              'Escanteios',
      market:            'Escanteios',
      promptFile:        'corners.txt',
      primaryDataSource: 'sofascore',
    });
  }
}
