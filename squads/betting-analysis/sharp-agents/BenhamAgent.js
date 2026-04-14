import { BaseAgent } from './BaseAgent.js';

export class BenhamAgent extends BaseAgent {
  constructor() {
    super({
      name: 'Benham',
      promptFile: 'benham.txt',
      role: 'Métricas Avançadas e Value Oculto (Matthew Benham)',
    });
  }
}
