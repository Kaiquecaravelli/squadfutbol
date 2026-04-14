import { BaseAgent } from './BaseAgent.js';

export class VoulgarisAgent extends BaseAgent {
  constructor() {
    super({
      name: 'Voulgaris',
      promptFile: 'voulgaris.txt',
      role: 'Modelagem Contextual e Closing Line Value (Haralabos Voulgaris)',
    });
  }
}
