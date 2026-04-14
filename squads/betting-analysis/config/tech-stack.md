# Tech Stack — Betting Analysis Squad

## APIs Externas

### Dados Esportivos
| API | Uso | Tier Gratuito |
|-----|-----|---------------|
| API-Football (RapidAPI) | Stats, lineups, fixtures | 100 req/dia |
| SofaScore (web scraping) | Ratings avançados | — |
| OpenWeatherMap | Clima do jogo | 1.000 req/dia |

### Notícias
| API | Uso | Tier Gratuito |
|-----|-----|---------------|
| **NewsAPI** (`newsapi.org`) | Notícias esportivas em PT/EN/ES | 100 req/dia |
| Google News RSS | Backup de notícias | Ilimitado |
| ESPN RSS | Cobertura internacional | Ilimitado |

### Odds
| Fonte | Cobertura |
|-------|-----------|
| Superbet (superbet.bet.br) | Grade de jogos, odds 1X2, Over/Under, BTTS, Handicap |

## Variáveis de Ambiente Necessárias
```env
NEWSAPI_KEY=sua_chave_aqui
API_FOOTBALL_KEY=sua_chave_aqui
OPENWEATHER_KEY=sua_chave_aqui
USER_BANKROLL=1000
```

## Stack de Desenvolvimento (sugerida)
- **Runtime:** Node.js 18+ ou Python 3.11+
- **HTTP Client:** axios (Node) / httpx (Python)
- **Parsing:** cheerio (scraping) / BeautifulSoup (Python)
- **Storage:** SQLite (local) ou Supabase (cloud)
- **Scheduler:** node-cron (daily-scan automático)
- **Notificações:** Telegram Bot API (alertas de apostas)
