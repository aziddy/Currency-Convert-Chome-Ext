import { isCurrency, type Currency } from '../shared/types';

const currencyValue = (element: Element): string =>
  (element.getAttribute('content') ?? element.getAttribute('value') ?? element.textContent ?? '').trim().toUpperCase();

function collectJsonCurrency(value: unknown, currencies: Set<string>, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 20) return;
  if (Array.isArray(value)) { for (const item of value) collectJsonCurrency(item, currencies, depth + 1); return; }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'priceCurrency' && typeof item === 'string') currencies.add(item.trim().toUpperCase());
    else if (typeof item === 'object') collectJsonCurrency(item, currencies, depth + 1);
  }
}

export function metadataCurrencies(root: Document | Element): Set<string> {
  const result = new Set<string>();
  for (const element of root.querySelectorAll('[itemprop~="priceCurrency"], meta[property="product:price:currency"], meta[property="og:price:currency"]')) {
    const value = currencyValue(element);
    if (/^[A-Z]{3}$/.test(value)) result.add(value);
  }
  for (const element of root.querySelectorAll('script[type="application/ld+json"]')) {
    if ((element.textContent?.length ?? 0) > 200_000) continue;
    try { collectJsonCurrency(JSON.parse(element.textContent ?? ''), result); } catch { /* Malformed site metadata is not authoritative. */ }
  }
  return result;
}

export function uniqueCurrency(currencies: Set<string>): Currency | null {
  const [currency] = currencies;
  return currencies.size === 1 && isCurrency(currency) ? currency : null;
}

export function associatedCurrency(element: Element): Currency | 'unknown' | null {
  const scope = element.closest('[itemscope]');
  if (!scope) return null;
  const values = new Set<string>();
  for (const item of scope.querySelectorAll('[itemprop~="priceCurrency"]')) {
    if (item.closest('[itemscope]') === scope) values.add(currencyValue(item));
  }
  return values.size ? uniqueCurrency(values) ?? 'unknown' : null;
}
