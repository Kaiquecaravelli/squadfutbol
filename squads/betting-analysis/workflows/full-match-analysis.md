# Workflow: Full Match Analysis
id: full-match-analysis
trigger: manual | scheduled
lead_agent: betting-master

## Descrição
Pipeline completo de análise de uma partida. Executa coleta de dados, análise paralela por múltiplos agentes e gera recomendação final com score de confiança.

## Fases

### FASE 1 — Coleta de Dados (scout)
```yaml
task: collect-data
agent: scout
inputs:
  - match_id
  - date
outputs:
  - match_data.json
blocking: true   # Demais fases dependem desta
```

### FASE 2 — Análise Paralela (simultânea)
Executar em paralelo assim que a Fase 1 completar:

```yaml
parallel:
  - task: fetch-news
    agent: news-analyst
    inputs: [match_data.json]
    outputs: [news_analysis.json]

  - task: analyze-tactical
    agent: tactician
    inputs: [match_data.json]
    outputs: [tactical_analysis.json]

  - task: analyze-quantitative
    agent: quant
    inputs: [match_data.json]
    outputs: [quant_analysis.json]

  - task: track-odds
    agent: odds-tracker
    inputs: [match_data.json]
    outputs: [odds_analysis.json]
```

### FASE 3 — Gestão de Risco (risk-manager)
```yaml
task: assess-risk
agent: risk-manager
inputs:
  - quant_analysis.json   # EV e probabilidades
  - odds_analysis.json    # Melhor odd disponível
  - bankroll: ${USER_BANKROLL}
outputs:
  - risk_assessment.json
blocking: true
```

### FASE 4 — Relatório Final (reporter + betting-master)
```yaml
task: generate-report
agent: reporter
inputs:
  - match_data.json
  - news_analysis.json
  - tactical_analysis.json
  - quant_analysis.json
  - odds_analysis.json
  - risk_assessment.json
outputs:
  - final_report.md
  - recommendation.json
```

## Score de Confiança Final
Calculado pelo betting-master consolidando:
- Quant confidence: peso 35%
- Tactical score: peso 25%
- News impact: peso 15%
- Odds movement signal: peso 15%
- Risk level: peso 10%

## Decisão Final
```
if score >= 80 → ✅ APOSTAR
if score 60-79 → ⚡ CONSIDERAR (stake reduzida)
if score 40-59 → ⚠️ AGUARDAR
if score < 40  → ❌ IGNORAR
```
