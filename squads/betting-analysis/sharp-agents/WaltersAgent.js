import { BaseAgent } from './BaseAgent.js';

export class WaltersAgent extends BaseAgent {
  constructor() {
    super({
      name: 'Walters',
      promptFile: 'walters.txt',
      role: 'Sharp Money e Timing de Mercado (Billy Walters)',
    });
  }
}
