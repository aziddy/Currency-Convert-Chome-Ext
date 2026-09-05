import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL, type BackgroundRequest } from '../../src/shared/types';

type Listener = (message: unknown, sender: { url: string }, respond: (response: unknown) => void) => boolean | undefined;
let listener: Listener;
let stored: Record<string, unknown>;
let set: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  stored = { notes: 'Private note', settings: { customRate: 1.5 }, rateCache: { usdToCad: 1.4 } };
  set = vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); });
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (callback: Listener) => { listener = callback; } },
      onInstalled: event(), onStartup: event() },
    storage: { local: { get: vi.fn(async (key: string) => ({ [key]: stored[key] })), set } },
    permissions: { onRemoved: event() }, contextMenus: { onClicked: event() },
    tabs: { onUpdated: event(), onRemoved: event() },
  });
  await import('../../src/background/index');
});
afterEach(() => vi.unstubAllGlobals());

function send(request: BackgroundRequest, url = 'chrome-extension://test/popup.html'): Promise<unknown> {
  return new Promise(resolve => { listener({ channel: CHANNEL, ...request }, { url }, resolve); });
}

describe('notes message permissions', () => {
  it('allows the popup to read and save notes without modifying rates or preferences', async () => {
    expect(await send({ type: 'GET_NOTES' })).toEqual({ ok: true, value: 'Private note' });
    expect(await send({ type: 'SAVE_NOTES', text: 'Updated note' })).toEqual({ ok: true, value: null });
    expect(set).toHaveBeenCalledWith({ notes: 'Updated note' });
    expect(stored.settings).toEqual({ customRate: 1.5 });
    expect(stored.rateCache).toEqual({ usdToCad: 1.4 });
  });

  it.each(['GET_NOTES', 'SAVE_NOTES'] as const)('rejects %s from webpage content scripts', async type => {
    const request: BackgroundRequest = type === 'GET_NOTES' ? { type } : { type, text: 'overwrite' };
    expect(await send(request, 'https://shop.example.com')).toEqual({ ok: false, error: 'This request must come from the extension popup.' });
    expect(stored.notes).toBe('Private note');
    expect(set).not.toHaveBeenCalled();
  });
});
