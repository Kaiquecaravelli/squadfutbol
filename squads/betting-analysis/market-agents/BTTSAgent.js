import { BaseMarketAgent } from './BaseMarketAgent.js';
export class BTTSAgent extends BaseMarketAgent {
  constructor() { super({ name: 'BTTS', market: 'Ambas Marcam', promptFile: 'btts.txt' }); }
}
