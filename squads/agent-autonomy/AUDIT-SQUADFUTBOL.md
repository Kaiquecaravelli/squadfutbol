# Autonomy Audit Report — Squadfutbol Pipeline
**Executado por:** AutonomyAuditor (AA-T001)  
**Framework:** Weng's 3 Pillars + 4 Failure Modes + Knight Institute L1-L5  
**Data:** 2026-04-14  
**Agentes auditados:** quant, parlay-builder, tactician, scout, news-analyst, risk-manager, scan-health-agent

---

## 1. Sumário Executivo

O squadfutbol é um **pipeline de análise de apostas esportivas** composto por 7 agentes JavaScript especializados. A arquitetura é bem segmentada (cada agente com responsabilidade única), mas os agentes são **functions puras** (input → output), sem loop ReAct, sem auto-reflexão e sem memória cross-session própria. O PIE (Performance Intelligence Engine) atua como memória compartilhada passiva. O sistema opera atualmente no nível **L3 — Consultant**, com potencial claro para L4 mediante ajustes em self-reflection, halt conditions e error recovery.

**Score Geral do Pipeline: 5.8 / 10**

---

## 2. Scores por Pilar — Pipeline Geral

| Pilar | Score | Peso | Weighted |
|-------|-------|------|----------|
| Planning | 5.0/10 | 0.35 | 1.75 |
| Memory | 6.5/10 | 0.30 | 1.95 |
| Tool Use | 5.8/10 | 0.35 | 2.03 |
| **TOTAL** | | | **5.73/10** |

**Nível classificado: L3 — Consultant**  
Agente executa por períodos, pipeline autônomo em 80%+ dos casos, mas pede guidance implícito (falha silenciosa = sem análise enviada, sem escalation ativa ao operador).

---

## 3. Auditoria Individual por Agente

### 3.1 — quant.js (Analisador Quantitativo)

**Função:** Modelos Poisson + Dixon-Coles → probabilidades calibradas por mercado

#### Planning
| Critério | Evidência | Score |
|----------|-----------|-------|
| P1 — Task Decomposition | Decompõe em: lambda_home/away → Poisson → DixonColes → PIE corrections → EV. Pipeline claro, 5 etapas bem definidas. | **8/10** |
| P2 — Self-Reflection | ❌ Sem auto-avaliação. Calcula probabilidade mas não verifica se está calibrada vs histórico real-time. | **3/10** |
| P3 — Goal Persistence | Funções puras — sem estado entre chamadas. Goal = calcular probabilidade = sempre completo em 1 call. | **6/10** |

#### Memory
| Critério | Evidência | Score |
|----------|-----------|-------|
| M1 — Working Memory | Não acumula contexto — opera call-by-call. Sem saturação. | **8/10** |
| M2 — Long-Term Memory | ✅ Usa `loadDB()` do PIE — aproveita 4.700+ amostras históricas para calibrar lambdas. | **7/10** |
| M3 — Cross-Agent Memory | ✅ Retorna `quantAnalysis` consumido por tactician, parlay-builder, risk-manager. Handoff por objeto JS. | **6/10** |

#### Tool Use
| Critério | Evidência | Score |
|----------|-----------|-------|
| T1 — Tool Coverage | Tools: PIE rules, calibração por liga. Falta: odds em tempo real (não coleta diretamente). | **6/10** |
| T2 — Tool Quality (ACI) | `analyzeQuantitative(matchData)` — single-responsibility, retorno bem definido. Falta: documentação de edge cases. | **7/10** |
| T3 — Error Recovery | ❌ `matchData` ausente causa crash sem fallback. Sem valores default robustos para campos opcionais. | **3/10** |

**Score quant.js: 5.8/10 → L3**

---

### 3.2 — parlay-builder.js (Construtor de Parlay)

**Função:** Montar acumuladores com correlação cruzada + Kelly ajustado

#### Planning
| Critério | Evidência | Score |
|----------|-----------|-------|
| P1 — Task Decomposition | Decompõe em: buildLegsFromAnalyses → calcCrossCorrelationPenalty → buildParlayOptions → formatParlayReport. Bem segmentado. | **8/10** |
| P2 — Self-Reflection | ❌ Não verifica se o parlay gerado tem odds realistas vs histórico do PIE. | **2/10** |
| P3 — Goal Persistence | Executa pipeline completo em 1 run. Goal único e claro. | **7/10** |

#### Memory
| M1 — Working Memory | Stateless. Sem acúmulo de contexto. | **8/10** |
| M2 — Long-Term Memory | ✅ Usa PIE para `pie_accuracy` por mercado. Correlações hardcoded (não aprendem). | **5/10** |
| M3 — Cross-Agent Memory | Recebe `preLiveResults` do funil — handoff funcional. Não passa estado para próximos agentes. | **5/10** |

#### Tool Use
| T1 — Tool Coverage | Tools: PIE calibration. Falta: verificação de odds disponíveis no Superbet antes de montar perna. | **5/10** |
| T2 — Tool Quality (ACI) | Funções bem separadas. Parâmetros claros. `buildLegsFromAnalyses` não valida input. | **6/10** |
| T3 — Error Recovery | ❌ Se uma análise for malformada, derruba perna silenciosamente. Sem alerta ao operador. | **4/10** |

**Score parlay-builder.js: 5.6/10 → L3**

---

### 3.3 — tactician.js (Análise Tática)

**Função:** Integrar xG + lesões + H2H → score tático e edge

#### Planning
| P1 — Task Decomposition | Decompõe em: teamScore → injury signals → H2H → key factors → risk flags → style. 6 módulos claros. | **8/10** |
| P2 — Self-Reflection | ❌ Sem validação se `tactical_edge` bate com probabilidades do quant. | **2/10** |
| P3 — Goal Persistence | Função pura de 1 call. | **7/10** |

#### Memory
| M1 — Working Memory | Stateless. | **8/10** |
| M2 — Long-Term Memory | ❌ Não usa PIE. Não aprende com resultados táticos históricos. | **2/10** |
| M3 — Cross-Agent Memory | Recebe `quantAnalysis` e `newsAnalysis`. Retorna estrutura rica para funil. | **6/10** |

#### Tool Use
| T1 — Tool Coverage | ❌ Falta dados de formação/escalação em tempo real (apenas form histórica). | **4/10** |
| T2 — Tool Quality (ACI) | `analyzeTactical(matchData, { quantAnalysis, newsAnalysis })` — interface clara. Falta: schema validation. | **6/10** |
| T3 — Error Recovery | ❌ Se `quantAnalysis.lambda_home` for null, score tático fica comprometido sem aviso. | **3/10** |

**Score tactician.js: 5.1/10 → L3**

---

### 3.4 — scout.js (Coletor de Dados)

**Função:** Coletar fixture, stats, H2H, weather de APIs externas

#### Planning
| P1 — Task Decomposition | Decompõe coleta por tipo (fixture, stats, H2H, weather). Funções separadas. | **7/10** |
| P2 — Self-Reflection | ❌ Não verifica se dados coletados estão completos antes de retornar. | **2/10** |
| P3 — Goal Persistence | Meta clara: retornar `matchData` completo. Sem estados intermediários. | **7/10** |

#### Memory
| M1 — Working Memory | Stateless — sem cache local. Toda requisição vai à API. | **4/10** |
| M2 — Long-Term Memory | ❌ Sem cache de dados de times. Re-busca stats toda execução (custo, latência). | **2/10** |
| M3 — Cross-Agent Memory | ✅ Retorna `matchData` padronizado consumido por todos os outros agentes. | **7/10** |

#### Tool Use
| T1 — Tool Coverage | Cobre: fixture, stats, H2H, weather. Falta: dados de escalação, mercados de odds diretos. | **6/10** |
| T2 — Tool Quality (ACI) | `collectMatchData(matchId)` — interface limpa. Dependência de `api-client.js` não documentada aqui. | **5/10** |
| T3 — Error Recovery | ❌ Falha na API de weather não bloqueia, mas falha na football API sim. Sem retry automático. | **3/10** |

**Score scout.js: 4.8/10 → L2**

---

### 3.5 — news-analyst.js (Analisador de Notícias)

**Função:** Notícias de lesões/crises → impact score por time

#### Planning
| P1 — Task Decomposition | Decompõe em: fetch → parse → apply impact rules → return analysis. | **7/10** |
| P2 — Self-Reflection | ❌ Sem verificação de qualidade das notícias encontradas (ex: notícia de 6 meses como "urgente"). | **2/10** |
| P3 — Goal Persistence | Objetivo único por time. Fallback pt→en quando falha. | **6/10** |

#### Memory
| M1 — Working Memory | Stateless. | **7/10** |
| M2 — Long-Term Memory | ❌ Não armazena notícias já processadas. Re-busca toda vez. | **2/10** |
| M3 — Cross-Agent Memory | Retorna estrutura consumida pelo tactician. | **6/10** |

#### Tool Use
| T1 — Tool Coverage | Tools: NewsAPI. Falta: fontes pt-BR específicas (GloboEsporte, UOL Esporte), APIs de escalação oficial. | **4/10** |
| T2 — Tool Quality (ACI) | 13 impact rules bem definidas. `fetchTeamNews()` tem interface clara. | **7/10** |
| T3 — Error Recovery | ✅ Fallback pt→en. Se ambos falharem, retorna impacto zero (não bloqueia pipeline). | **7/10** |

**Score news-analyst.js: 5.3/10 → L3**

---

### 3.6 — risk-manager.js (Gestão de Risco)

**Função:** Kelly adaptativo + stop-loss + stake calculation

#### Planning
| P1 — Task Decomposition | Decompõe em: check stop-loss → get PIE accuracy → apply streak penalty → calc Kelly → return stake. | **8/10** |
| P2 — Self-Reflection | ❌ Não verifica se stake recomendado bate com histórico de stakes (pode crescer sem limite). | **3/10** |
| P3 — Goal Persistence | Único objetivo: retornar stake seguro. Bem contido. | **8/10** |

#### Memory
| M1 — Working Memory | Stateless. | **8/10** |
| M2 — Long-Term Memory | ✅ Usa PIE calibration para acurácia por mercado. ✅ Stop-loss baseado em `consecutive_losses` do estado. | **7/10** |
| M3 — Cross-Agent Memory | Recebe `quantAnalysis` do quant. Resultado é consumido pelo pipeline de envio. | **6/10** |

#### Tool Use
| T1 — Tool Coverage | ✅ Kelly + stop-loss + streak penalty + parlay adjustment. Bem coberto para gestão de risco. | **8/10** |
| T2 — Tool Quality (ACI) | `assessRisk({ quantAnalysis, oddsAnalysis, bankroll, dailyExposure, parlay_legs })` — interface clara, env vars documentadas. | **7/10** |
| T3 — Error Recovery | ❌ Se `loadDB()` falhar, Kelly não tem accuracy → usa valor default sem alertar. | **4/10** |

**Score risk-manager.js: 6.6/10 → L3**

---

### 3.7 — scan-health-agent.js (Monitor de Saúde)

**Função:** Métricas do pipeline + alertas ao admin via Telegram DM

#### Planning
| P1 — Task Decomposition | Lifecycle claro: startRun → recordMatch/Error → finishRun → generateReport → sendAlert. | **9/10** |
| P2 — Self-Reflection | ✅ Analisa histórico de runs e detecta padrões (sem oportunidades em 10 runs, cache rate < 30%). | **7/10** |
| P3 — Goal Persistence | Goal de monitoramento contínuo. Persiste entre execuções via `pipeline-health.json`. | **8/10** |

#### Memory
| M1 — Working Memory | Gerencia estado de run ativo em memória. Limpa entre runs. | **8/10** |
| M2 — Long-Term Memory | ✅ Histórico de 200 runs em `pipeline-health.json`. Análise de tendências. | **8/10** |
| M3 — Cross-Agent Memory | Recebe métricas de todos os agentes do pipeline. Centraliza visibilidade. | **7/10** |

#### Tool Use
| T1 — Tool Coverage | ✅ Telegram DM, file persistence, threshold checks. Cobre necessidades de monitoramento. | **8/10** |
| T2 — Tool Quality (ACI) | Classe bem encapsulada. Interface de métricas clara. Limiares configuráveis. | **7/10** |
| T3 — Error Recovery | ✅ Falha no envio Telegram não derruba pipeline (try/catch). | **7/10** |

**Score scan-health-agent.js: 7.8/10 → L4**  
⭐ **Agente mais maduro do pipeline**

---

## 4. Failure Modes Detectados

### FM-1 — Context Saturation: 🟡 BAIXO RISCO
- Pipeline é stateless por design — cada agente opera em 1 call
- Risco real: no funil pré-live, se **Groq/Gemini receber contexto grande com stats de 10+ jogos**, pode haver degradação
- **Ação:** Adicionar `context_budget` no aggregator — limitar stats enviadas ao LLM a máx 3 jogos recentes + summary

### FM-2 — Tool Brittleness: 🔴 CRÍTICO
- **scout.js**: falha na API football não tem retry → pipeline trava silenciosamente
- **parlay-builder.js**: URL de Superbet ausente → perna incluída sem link → regra de negócio violada
- **quant.js**: `matchData` malformado → crash sem recovery
- **Ação:** Implementar retry exponencial em scout.js + schema validation em quant.js + validação pré-parlay

### FM-3 — Reasoning Drift: 🟡 MODERADO
- Agentes são funções puras — sem loop que possa "derivar"
- Risco real: **Groq como reasoning engine** no funil pode seguir tangentes quando contexto é ambíguo
- **Ação:** Adicionar instrução de escopo explícito nos prompts: "Responda APENAS sobre {mercado} — ignore outros mercados"

### FM-4 — Evaluator Absence: 🔴 CRÍTICO
- **Nenhum agente verifica se seu output é válido** antes de passar ao próximo
- `quant.js` retorna probabilidades — não verifica se somam ~100%
- `tactician.js` retorna `tactical_edge` — não verifica se bate com quant
- `parlay-builder.js` monta pernas — não verifica se todas têm URL Superbet válida
- **Ação:** Adicionar `validateOutput()` em cada agente + quality gate no funil antes de enviar Telegram

---

## 5. Análise Det vs Prob

| Operação | Atual | Ideal | Status |
|----------|-------|-------|--------|
| Cálculo Poisson/Dixon-Coles | Código (det) | Código (det) | ✅ Correto |
| Calibração PIE | Código (det) | Código (det) | ✅ Correto |
| Análise de notícias/impacto | LLM via Groq | LLM (prob) | ✅ Correto |
| Seleção de mercado para aposta | LLM via Groq | LLM → código executa | ⚠️ Parcial — LLM executa também |
| Parsing de resposta do LLM | Regex (det) | Código (det) | ✅ Correto |
| Cálculo de stake/Kelly | Código (det) | Código (det) | ✅ Correto |
| Classificação de risco (riskLevel) | Código (det) | Código (det) | ✅ Correto |
| Routing de mercado no funil | LLM | Código (det) | ❌ LLM decide O QUÊ analisar — deveria ser regra det |

**Red Flag:** O funil Groq decide quais mercados analisar via prompt. Isso é probabilístico onde deveria ser determinístico. Mercados devem ser selecionados por regra (PIE accuracy >= X% + EV >= Y%) — não por LLM.

---

## 6. Scores Consolidados

| Agente | Planning | Memory | Tool Use | **Score** | **Nível** |
|--------|----------|--------|----------|-----------|-----------|
| quant.js | 5.7 | 7.0 | 5.3 | **5.8** | L3 |
| parlay-builder.js | 5.7 | 6.0 | 5.0 | **5.6** | L3 |
| tactician.js | 5.7 | 5.3 | 4.3 | **5.1** | L3 |
| scout.js | 5.3 | 4.3 | 4.7 | **4.8** | L2 |
| news-analyst.js | 5.0 | 5.0 | 6.0 | **5.3** | L3 |
| risk-manager.js | 6.3 | 7.0 | 6.3 | **6.6** | L3 |
| scan-health-agent.js | 8.0 | 7.7 | 7.3 | **7.8** | L4 |
| **PIPELINE MÉDIO** | **5.1** | **6.0** | **5.6** | **5.7** | **L3** |

---

## 7. Checklist Autonomy (18 items)

| # | Item | Status |
|---|------|--------|
| P1 | Task Decomposition | ✅ |
| P2 | Self-Reflection | ❌ |
| P3 | Goal Persistence | ✅ |
| M1 | Working Memory | ✅ |
| M2 | Long-Term Memory | ⚠️ Parcial (só PIE) |
| M3 | Cross-Agent Memory | ✅ |
| T1 | Tool Coverage | ⚠️ Parcial |
| T2 | Tool Quality (ACI) | ✅ |
| T3 | Error Recovery | ❌ |
| FM-1 | Sem Context Saturation | ✅ |
| FM-2 | Sem Tool Brittleness | ❌ |
| FM-3 | Sem Reasoning Drift | ⚠️ Parcial |
| FM-4 | Sem Evaluator Absence | ❌ |
| AG-1 | 80%+ tasks sem intervenção | ✅ |
| AG-2 | Det vs Prob separados | ⚠️ Parcial |
| AG-3 | Halt condition definida | ⚠️ Parcial (scan-health tem, outros não) |
| AG-4 | Escalation criteria | ❌ Falha silenciosa, sem escalation ativa |
| AG-5 | Security (lethal trifecta < 3) | ✅ Sem escrita destrutiva, sem execução arbitrária |

**Items passados: 9/18 → Limiar L3 (13/18) ainda não atingido formalmente**

---

## 8. Recomendações Priorizadas

### P1 — CRÍTICO: Adicionar `validateOutput()` em cada agente
**Impacto estimado:** +1.5 pontos (FM-4 eliminado)  
**Agente responsável:** tool-smith  
**Ação:**
```js
// Em quant.js — após calcular probabilidades
function validateQuantOutput(result) {
  const homeWin = result.home_win ?? 0;
  const draw = result.draw ?? 0;
  const awayWin = result.away_win ?? 0;
  const sum = homeWin + draw + awayWin;
  if (sum < 0.85 || sum > 1.15) {
    console.warn(`[Quant] AVISO: probabilidades não somam 1 (soma=${sum.toFixed(2)})`);
  }
  return result;
}
```

### P2 — CRÍTICO: Retry + schema validation em scout.js
**Impacto estimado:** +1.2 pontos (FM-2 reduzido)  
**Agente responsável:** tool-smith  
**Ação:** Wrapping de `collectMatchData` com retry exponencial (3 tentativas, backoff 2s) e validação de campos obrigatórios antes de retornar.

### P3 — ALTO: Mover routing de mercado de LLM para código
**Impacto estimado:** +0.8 pontos (det vs prob corrigido)  
**Agente responsável:** agent-architect  
**Ação:** Substituir a decisão do Groq sobre "quais mercados analisar" por regra determinística:
```js
const eligibleMarkets = Object.entries(pieDb.calibration)
  .filter(([, c]) => c.total >= 30 && (c.hits/c.total) >= 0.70)
  .filter(([market]) => ev[market] >= 0.08)
  .map(([market]) => market);
```

### P4 — MÉDIO: Cache de dados de times em scout.js
**Impacto estimado:** +0.6 pontos (M2 melhorado, latência reduzida)  
**Agente responsável:** agent-architect  
**Ação:** Adicionar cache `data/team-stats-cache.json` com TTL de 4h para stats de times — evita re-fetch em cada rodada do pipeline.

### P5 — MÉDIO: Escalation ativa no scan-health-agent
**Impacto estimado:** +0.5 pontos (AG-4 corrigido)  
**Agente responsável:** tool-smith  
**Ação:** Se pipeline completou sem enviar nenhuma análise por 3 runs consecutivos, enviar DM ao admin com resumo de diagnóstico (quais gates bloquearam e por quê), não apenas silêncio.

---

## 9. Prompt Engineering — Análise Específica

Com base no framework IMPACT (swyx) e análise dos prompts nos funnels:

| Elemento IMPACT | Status Atual | Recomendação |
|-----------------|-------------|--------------|
| **Intent** (objetivo claro) | ✅ Prompts têm objetivo bem definido | Manter |
| **Memory** (contexto relevante) | ⚠️ PIE passado como texto bruto | Estruturar como JSON compacto |
| **Planning** (decomposição no prompt) | ⚠️ LLM decide sub-steps | Adicionar `PASSO 1... PASSO 2...` nos prompts |
| **Control Flow** (if/else no prompt) | ❌ Lógica de roteamento no prompt | Mover para código JS |
| **Authority** (quem pode fazer o quê) | ✅ Agentes com responsabilidade única | Manter |
| **Tools** (tools disponíveis) | ⚠️ Não documentadas no prompt do LLM | Adicionar lista de tools disponíveis |

**3 melhorias de prompt priorizadas:**

1. **Adicionar `Output Schema` obrigatório** em todo prompt que retorna JSON:
   ```
   RETORNE APENAS JSON VÁLIDO no formato:
   { "mercado": "string", "recomendacao": "APOSTAR|NAO_APOSTAR", "probabilidade": number, "confianca": number }
   ```

2. **Reduzir contexto passado ao LLM** — atualmente stats de múltiplos jogos são passadas integralmente. Comprimir para:
   ```
   Forma recente: W-W-L-D-W (5 jogos) | Média gols: 1.8 | Média sofridos: 1.1
   ```
   Em vez de objeto inteiro com 20 campos.

3. **Separar prompts por mercado** — prompt único de "analise todos os mercados" gera reasoning drift. Usar prompt especializado por mercado:
   - `prompts/btts.md`
   - `prompts/over-under.md`  
   - `prompts/corners.md`

---

## 10. Handoff Recomendado

| Resultado | Agente Responsável | Prioridade |
|-----------|-------------------|-----------|
| Implementar `validateOutput()` em todos os agentes | tool-smith | 🔴 CRÍTICO |
| Retry + schema validation no scout.js | tool-smith | 🔴 CRÍTICO |
| Mover routing de mercado para código | agent-architect | 🟠 ALTO |
| Separar prompts por mercado (btts, over, corners) | reasoning-engineer | 🟠 ALTO |
| Cache de team stats no scout | agent-architect | 🟡 MÉDIO |
| Escalation ativa no scan-health-agent | tool-smith | 🟡 MÉDIO |

---

## 11. Diagnóstico: Det vs Prob por Agente

| Agente | Operações Det | Operações Prob | Separação |
|--------|--------------|----------------|-----------|
| quant.js | Poisson, Kelly, calibração | — | ✅ 100% det (correto) |
| risk-manager.js | Kelly, stop-loss, streak | — | ✅ 100% det (correto) |
| parlay-builder.js | Correlação, combinatória | — | ✅ 100% det (correto) |
| news-analyst.js | Impact rules, scoring | Fetch NewsAPI | ✅ Bem separado |
| tactician.js | Score tático | Interpretação de lesões | ✅ Bem separado |
| scout.js | Parsing, formatação | — | ✅ 100% det (correto) |
| Funil (Groq/Gemini) | Parsing de resposta | Análise de mercado, routing | ❌ Routing deveria ser det |

---

*Relatório gerado automaticamente pelo Agent Autonomy Squad v1.0.1*  
*Próxima auditoria recomendada: após implementação das 5 recomendações acima*
