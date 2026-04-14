# Task: analyze-quantitative
agent: quant
elicit: false

## Inputs
- `match_data.json` (home/away goals averages)

## Steps
1. Calcular lambdas (Poisson):
   - λ_home = goals_scored_avg_home × goals_conceded_avg_away × 1.15
   - λ_away = goals_scored_avg_away × goals_conceded_avg_home
2. Construir matriz de placar 7×7
3. Aplicar correção Dixon-Coles (placares 0-0, 1-0, 0-1, 1-1)
4. Calcular probabilidades: home_win, draw, away_win, over_2.5, btts, AH -0.5
5. Para cada odd disponível na Superbet:
   - EV = (true_prob × odds) - 1
   - Se EV >= MIN_EV_THRESHOLD: adicionar em value_bets
6. Calcular odds justas (fair_odds = 1 / true_prob)
7. Ordenar value_bets por EV decrescente

## Output
```json
{
  "lambda_home", "lambda_away",
  "probabilities": { "home_win", "draw", "away_win", "over_2_5", "btts" },
  "fair_odds": { "home_win", "draw", "away_win", "over_2_5" },
  "value_bets": [{ "market", "house", "true_prob", "odds", "ev", "ev_pct", "rating" }],
  "model_confidence": 0.78
}
```
