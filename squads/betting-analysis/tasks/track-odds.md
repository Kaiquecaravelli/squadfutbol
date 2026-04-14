# Task: track-odds
agent: odds-tracker
elicit: false

## Inputs
- `match_data.json` (inclui odds de abertura do scout — coletadas da Superbet)

## Steps
1. Buscar odds atuais na Superbet (superbet.bet.br — via scraper)
2. Comparar com odds de abertura (do scout):
   - Para cada mercado: calcular variação absoluta e percentual
   - Se variação >= 10%: marcar como steam_move
   - Se variação >= 5%: marcar como shortening/drifting
3. Identificar melhor odd disponível por mercado (best_odds na Superbet)
4. Gerar alerts de steam moves
5. Derivar market_sentiment: sharp_money_home | sharp_against_home | neutral

## Output
```json
{
  "current_odds": { "home_win": 1.95, "draw": 3.50, "away_win": 3.40 },
  "movement": { "home_win": { "change": -0.15, "pct": -7.1, "signal": "steam_move" } },
  "best_odds": { "home_win": { "house": "superbet", "odds": 1.95 } },
  "alerts": [],
  "market_sentiment": "neutral",
  "source": "superbet.bet.br"
}
```

## Error Handling
- Se scraper Superbet falhar: usar odds do scout como current_odds, movement={}
