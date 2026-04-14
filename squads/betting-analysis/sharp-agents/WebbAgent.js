import { BaseAgent } from './BaseAgent.js';

export class WebbAgent extends BaseAgent {
  constructor() {
    super({
      name: 'Webb',
      promptFile: 'webb.txt',
      role: 'Scalping e Microestrutura de Mercado (Peter Webb)',
    });
  }
}
