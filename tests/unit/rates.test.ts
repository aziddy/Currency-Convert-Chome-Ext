import { afterEach, describe, expect, it, vi } from 'vitest';
import { CACHE_TTL, RateService } from '../../src/background/rates';
import { type RateCache } from '../../src/shared/types';

const now = Date.parse('2026-09-04T15:00:00Z');
const saved: RateCache = { usdToCad: 1.38, date: '2026-09-04', fetchedAt: now };
function setup(cache?: RateCache, body: unknown = { base: 'USD', quote: 'CAD', date: '2026-09-04', rate: 1.4 }) {
  const storage = { read: vi.fn(async () => cache), write: vi.fn(async (next: RateCache) => { cache = next; }) };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
  return { service: new RateService(storage, fetcher, () => now), storage, fetcher };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('exchange rates', () => {
  it('calls the native fetch with its global receiver', async () => {
    const { storage, fetcher } = setup();
    vi.stubGlobal('fetch', fetcher);
    const service = new RateService(storage, undefined, () => now);
    expect(await service.get(null)).toMatchObject({ usdToCad: 1.4 });
    expect(fetcher.mock.contexts).toEqual([globalThis]);
  });

  it('uses a fresh cache without a network request', async () => {
    const { service, fetcher } = setup(saved);
    expect(await service.get(null)).toMatchObject({ usdToCad: 1.38, stale: false, source: 'daily' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches, validates and stores a daily rate', async () => {
    const { service, storage, fetcher } = setup();
    expect(await service.get(null)).toMatchObject({ usdToCad: 1.4, stale: false });
    expect(storage.write).toHaveBeenCalledWith({ ...saved, usdToCad: 1.4 });
    expect(fetcher).toHaveBeenCalledWith('https://api.frankfurter.dev/v2/rate/USD/CAD', expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }));
  });

  it('deduplicates concurrent refreshes', async () => {
    const { service, fetcher } = setup();
    const result = await Promise.all([service.get(null), service.get(null), service.get(null)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.map(r => r.usdToCad)).toEqual([1.4, 1.4, 1.4]);
  });

  it('refreshes on demand even when the cache is fresh', async () => {
    const { service, fetcher } = setup(saved);
    expect((await service.get(null, true)).usdToCad).toBe(1.4);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses a stale cache on network failure', async () => {
    const { service, fetcher } = setup({ ...saved, fetchedAt: now - CACHE_TTL - 1 });
    fetcher.mockRejectedValue(new Error('offline'));
    expect(await service.get(null)).toMatchObject({ usdToCad: 1.38, stale: true });
  });

  it.each([
    { base: 'CAD', quote: 'USD', date: '2026-09-04', rate: 1.4 },
    { base: 'USD', quote: 'CAD', date: 'not-a-date', rate: 1.4 },
    { base: 'USD', quote: 'CAD', date: '2026-09-04', rate: 0 },
    { base: 'USD', quote: 'CAD', date: '2026-09-04', rate: '1.4' },
  ])('rejects invalid API data', async body => {
    const { service, storage } = setup(undefined, body);
    await expect(service.get(null)).rejects.toThrow('Could not load an exchange rate');
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('reports an error without a cache and can retry', async () => {
    const { service, fetcher } = setup();
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(service.get(null)).rejects.toThrow('custom rate');
    expect((await service.get(null)).usdToCad).toBe(1.4);
  });

  it('uses custom rates without fetching', async () => {
    const { service, fetcher, storage } = setup();
    expect(await service.get(1.5, true)).toMatchObject({ usdToCad: 1.5, source: 'custom', stale: false });
    expect(fetcher).not.toHaveBeenCalled(); expect(storage.read).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, Number.MIN_VALUE])('rejects invalid custom rate %s', async value => {
    await expect(setup().service.get(value)).rejects.toThrow('greater than zero');
  });

  it('times out a hanging request after eight seconds', async () => {
    vi.useFakeTimers();
    const { service, fetcher } = setup();
    fetcher.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
    }));
    const promise = expect(service.get(null)).rejects.toThrow('Could not load');
    await vi.advanceTimersByTimeAsync(8_001);
    await promise;
  });
});
