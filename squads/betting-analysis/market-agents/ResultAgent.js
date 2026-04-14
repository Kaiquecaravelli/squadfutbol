import { BaseMarketAgent } from './BaseMarketAgent.js';
export class ResultAgent extends BaseMarketAgent {
  constructor() { super({ name: 'Resultado', market: 'Resultado Final', promptFile: 'result.txt' }); }
}
