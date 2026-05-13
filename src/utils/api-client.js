import axios from 'axios';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;

export function createApiClient(baseURL, headers = {}, options = {}) {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = axios.create({ baseURL, headers, timeout: options.timeout ?? 10000 });

  client.interceptors.response.use(
    (res) => res.data,
    async (err) => {
      const config = err.config;
      const status = err.response?.status;

      // Só faz retry para erros retornáveis (5xx, 429, timeout)
      const isRetryable = !status || status >= 500 || status === 429 || err.code === 'ECONNABORTED';

      if (!config || !isRetryable || config.__retryCount >= maxRetries) {
        const msg = err.response?.data?.message || err.message;
        throw new Error(`API Error [${status}]: ${msg}`);
      }

      config.__retryCount = config.__retryCount || 0;
      config.__retryCount++;

      // Exponential backoff: 1s, 2s, 4s (max 10s)
      const delay = Math.min(DEFAULT_RETRY_DELAY * Math.pow(2, config.__retryCount - 1), 10000);
      console.log(`[API Client] Retry ${config.__retryCount}/${maxRetries} após ${delay}ms...`);

      await new Promise(r => setTimeout(r, delay));
      return client(config);
    }
  );

  return client;
}

export const footballApi = createApiClient('https://v3.football.api-sports.io', {
  'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
  'x-rapidapi-host': 'v3.football.api-sports.io',
});

export const newsApi = createApiClient('https://newsapi.org/v2');

export const weatherApi = createApiClient('https://api.openweathermap.org/data/2.5');

export const oddsApi = createApiClient('https://api.the-odds-api.com/v4');
