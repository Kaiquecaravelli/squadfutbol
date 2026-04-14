import { BaseMarketAgent } from './BaseMarketAgent.js';
export class CornersAgent extends BaseMarketAgent {
  constructor() { super({ name: 'Escanteios', market: 'Escanteios', promptFile: 'corners.txt' }); }
}
