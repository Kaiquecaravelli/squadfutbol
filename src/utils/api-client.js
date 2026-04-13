import axios from 'axios';

export function createApiClient(baseURL, headers = {}) {
  const client = axios.create({ baseURL, headers, timeout: 10000 });

  client.interceptors.response.use(
    (res) => res.data,
    (err) => {
      const msg = err.response?.data?.message || err.message;
      throw new Error(`API Error [${err.response?.status}]: ${msg}`);
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
