export type Currency = 'USD' | 'CAD';
export type DisplayMode = 'replace' | 'beside' | 'hover';
export type SourceMode = 'manual' | 'auto';

export interface Preferences {
  source: Currency;
  target: Currency;
  sourceMode: SourceMode;
  display: DisplayMode;
}

export interface Settings {
  preferences: Preferences;
  sites: Record<string, Preferences>;
  customRate: number | null;
}

export interface RateCache {
  usdToCad: number;
  date: string;
  fetchedAt: number;
}

export interface EffectiveRate extends RateCache {
  source: 'daily' | 'custom';
  stale: boolean;
}

export interface PageStatus {
  active: boolean;
  automatic: boolean;
  count: number;
  selectionCount: number;
  ambiguous: number;
  detectedSource: Currency | null;
  preferences: Preferences | null;
  rate: EffectiveRate | null;
  error: string | null;
}

export type BackgroundRequest =
  | { type: 'GET_SETTINGS' }
  | { type: 'GET_NOTES' }
  | { type: 'SAVE_NOTES'; text: string }
  | { type: 'SAVE_PREFERENCES'; preferences: Preferences; hostname: string | null }
  | { type: 'SET_SITE'; hostname: string; enabled: boolean; preferences: Preferences }
  | { type: 'SET_CUSTOM_RATE'; rate: number | null }
  | { type: 'GET_RATE'; refresh?: boolean };

export type ContentRequest =
  | { type: 'APPLY'; preferences: Preferences; automatic: boolean }
  | { type: 'CONVERT_SELECTION'; selectionText: string; preferences: Preferences }
  | { type: 'SELECTION_ERROR'; error: string }
  | { type: 'RESTORE' }
  | { type: 'STOP_PAGE' }
  | { type: 'STATUS' };

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export const CHANNEL = 'usd-cad-price-converter';
export const selectionErrorKey = (tabId: number): string => `selection-error:${tabId}`;

export const DEFAULT_PREFERENCES: Preferences = {
  source: 'USD', target: 'CAD', sourceMode: 'manual', display: 'replace',
};

export const DEFAULT_SETTINGS: Settings = {
  preferences: DEFAULT_PREFERENCES, sites: {}, customRate: null,
};

export const otherCurrency = (currency: Currency): Currency => currency === 'USD' ? 'CAD' : 'USD';
export const isCurrency = (value: unknown): value is Currency => value === 'USD' || value === 'CAD';
export const isPositiveRate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isFinite(1 / value);

export function validPreferences(value: unknown): value is Preferences {
  if (!value || typeof value !== 'object') return false;
  const p = value as Preferences;
  return isCurrency(p.source) && isCurrency(p.target) && p.source !== p.target &&
    ['manual', 'auto'].includes(p.sourceMode) && ['replace', 'beside', 'hover'].includes(p.display);
}

export function sitePattern(hostname: string): string {
  if (!hostname || new URL(`https://${hostname}`).hostname !== hostname || /[/*?#@]/.test(hostname)) {
    throw new Error('This website address is not supported.');
  }
  return `*://${hostname}/*`;
}

export function websiteHostname(url?: string): string | null {
  try {
    const parsed = new URL(url ?? '');
    if (!['http:', 'https:'].includes(parsed.protocol) ||
        parsed.hostname === 'chromewebstore.google.com' ||
        (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))) return null;
    return parsed.hostname;
  } catch { return null; }
}

export async function backgroundRequest<T>(request: BackgroundRequest): Promise<T> {
  const result = await chrome.runtime.sendMessage({ channel: CHANNEL, ...request }) as Reply<T>;
  if (!result?.ok) throw new Error(result?.error ?? 'The extension could not respond. Try reopening it.');
  return result.value;
}
