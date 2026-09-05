import { isPositiveRate, type EffectiveRate, type RateCache } from '../shared/types';

export const RATE_URL = 'https://api.frankfurter.dev/v2/rate/USD/CAD';
export const CACHE_TTL = 24 * 60 * 60 * 1000;

interface RateStorage {
  read(): Promise<unknown>;
  write(cache: RateCache): Promise<void>;
}

export function validCache(value: unknown): value is RateCache {
  if (!value || typeof value !== 'object') return false;
  const cache = value as RateCache;
  return isPositiveRate(cache.usdToCad) && typeof cache.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(cache.date) && Number.isFinite(Date.parse(cache.date)) &&
    Number.isFinite(cache.fetchedAt) && cache.fetchedAt > 0;
}

export class RateService {
  private pending: Promise<EffectiveRate> | null = null;

  constructor(
    private storage: RateStorage,
    // Native worker fetch requires its global receiver, not this RateService instance.
    private fetcher: typeof fetch = fetch.bind(globalThis),
    private now: () => number = Date.now,
  ) {}

  async get(customRate: number | null, refresh = false): Promise<EffectiveRate> {
    if (customRate !== null) {
      if (!isPositiveRate(customRate)) throw new Error('Enter a rate greater than zero.');
      return { usdToCad: customRate, date: '', fetchedAt: this.now(), source: 'custom', stale: false };
    }
    const stored = await this.storage.read();
    const cache = validCache(stored) ? stored : undefined;
    const age = cache ? this.now() - cache.fetchedAt : Infinity;
    if (!refresh && cache && age >= 0 && age < CACHE_TTL) {
      return { ...cache, source: 'daily', stale: false };
    }
    if (this.pending) return this.pending;
    this.pending = this.fetchRate(cache).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async fetchRate(cache?: RateCache): Promise<EffectiveRate> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetcher(RATE_URL, {
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Rate service returned ${response.status}.`);
      const body = await response.json();
      const next: RateCache = { usdToCad: body.rate, date: body.date, fetchedAt: this.now() };
      if (body.base !== 'USD' || body.quote !== 'CAD' || !validCache(next)) {
        throw new Error('The rate service returned an invalid exchange rate.');
      }
      await this.storage.write(next);
      return { ...next, source: 'daily', stale: false };
    } catch {
      if (cache) return { ...cache, source: 'daily', stale: true };
      throw new Error('Could not load an exchange rate. Retry, or enter a custom rate below.');
    } finally { clearTimeout(timeout); }
  }
}
