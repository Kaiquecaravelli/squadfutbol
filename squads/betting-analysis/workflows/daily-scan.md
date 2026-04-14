# Workflow: Daily Scan
id: daily-scan
trigger: scheduled (every day at 08:00)
lead_agent: betting-master

## Descrição
Varredura automática matinal de todas as partidas do dia. Filtra jogos com potencial de valor e prioriza os mais promissores para análise completa.

## Fases

### FASE 1 — Listar Partidas do Dia
```yaml
agent: scout
action: collect-bulk
inputs:
  - date: today
  - leagues: [Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, Brasileirão]
outputs:
  - matches_today.json
```

### FASE 2 — Triagem Rápida
Para cada partida, executar análise rápida de EV:
```yaml
agent: quant
action: quick-ev-scan
threshold_ev: 0.05   # Mínimo 5% de edge para continuar
outputs:
  - shortlisted_matches.json
```

### FASE 3 — Análise Completa das Shortlistadas
Para cada partida na shortlist (máx. 5):
```yaml
workflow: full-match-analysis
```

### FASE 4 — Relatório Diário
```yaml
agent: reporter
action: daily-report
outputs:
  - daily_report.md
```

## Saída Esperada
- Lista de partidas com alto EV do dia
- Top 3 recomendações priorizadas
- Stake sugerida para cada uma
- Resumo de exposição total do dia
