import { type Currency } from '../shared/types';

export interface PriceMatch {
  start: number;
  end: number;
  text: string;
  amount: number;
  currency: Currency | null;
}

const CODES = 'USD|CAD|AUD|NZD|HKD|MXN|SGD|TWD|EUR|GBP|JPY|CNY|RMB|INR|KRW|CHF|SEK|NOK|DKK|BRL|ZAR|ARS|CLP|COP|PHP';
export const CURRENCY_MARKER = `(?:(?:${CODES})\\b(?:\\s*\\$)?|(?:US|CA|AU|NZ|HK|MX|SG|NT|C|A|S|R)\\s*\\$|\\$(?:\\s*(?:${CODES}|US|CA)\\b)?|[€£¥₹₩₽])`;
const MARKER = CURRENCY_MARKER;
const NUMBER = '(?:\\d{1,3}(?:[., \\u00a0\\u202f]\\d{3})+|\\d+)(?:[.,]\\d{1,2})?';
const SIGNED = `(?:[-−+]\\s*)?${NUMBER}`;
const pattern = () => new RegExp(
  `(?<![\\p{L}\\p{N}_$])(?:([-−+]?)(${MARKER})\\s*(${SIGNED})(?:[ \\u00a0\\u202f]*(${MARKER}))?|(${SIGNED})[ \\u00a0\\u202f]*(${MARKER}))(?![\\p{L}\\p{N}_]|[.,]\\d)`,
  'giu',
);

export function markerCurrency(marker: string): Currency | null | 'unsupported' {
  const normalized = marker.toUpperCase().replace(/\s/g, '');
  if (['USD', 'USD$', 'US$', '$US', '$USD'].includes(normalized)) return 'USD';
  if (['CAD', 'CAD$', 'CA$', 'C$', '$CA', '$CAD'].includes(normalized)) return 'CAD';
  if (normalized === '$') return null;
  return 'unsupported';
}

export function parseAmount(raw: string): number | null {
  let value = raw.trim().replace('−', '-');
  const sign = value.startsWith('-') ? -1 : 1;
  value = value.replace(/^[-+]\s*/, '');
  if (/[ \u00a0\u202f]/.test(value)) {
    if (!/^\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?$/.test(value)) return null;
    value = value.replace(/[ \u00a0\u202f]/g, '');
  }
  if (value.includes(',') && value.includes('.')) {
    const decimal = value.lastIndexOf(',') > value.lastIndexOf('.') ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    const valid = new RegExp(`^\\d{1,3}(?:\\${group}\\d{3})+\\${decimal}\\d{1,2}$`);
    if (!valid.test(value)) return null;
    value = value.split(group).join('').replace(decimal, '.');
  } else if (/[.,]/.test(value)) {
    const separator = value.includes(',') ? ',' : '.';
    if (new RegExp(`^\\d{1,3}(?:\\${separator}\\d{3})+$`).test(value)) value = value.split(separator).join('');
    else if (new RegExp(`^\\d+\\${separator}\\d{1,2}$`).test(value)) value = value.replace(separator, '.');
    else return null;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value) * sign;
  return Number.isFinite(amount) && Math.abs(amount) <= Number.MAX_SAFE_INTEGER / 100 ? amount : null;
}

export function findPrices(text: string): PriceMatch[] {
  const prices: PriceMatch[] = [];
  for (const match of text.matchAll(pattern())) {
    const markers = [match[2], match[4], match[6]].filter((v): v is string => Boolean(v));
    const currencies = markers.map(markerCurrency);
    if (currencies.includes('unsupported')) continue;
    const explicit = new Set(currencies.filter((c): c is Currency => c === 'USD' || c === 'CAD'));
    if (explicit.size > 1) continue;
    const amount = parseAmount(`${match[1] ?? ''}${match[3] ?? match[5] ?? ''}`);
    if (amount === null) continue;
    prices.push({ start: match.index!, end: match.index! + match[0].length, text: match[0], amount, currency: [...explicit][0] ?? null });
  }
  return prices;
}

export function formatConversion(amount: number, source: Currency, target: Currency, usdToCad: number, locale = 'en-CA'): string {
  const converted = source === target ? amount : source === 'USD' ? amount * usdToCad : amount / usdToCad;
  if (!Number.isFinite(converted) || Math.abs(converted) > Number.MAX_SAFE_INTEGER / 100) throw new Error('This price is too large to convert reliably.');
  return `≈ ${new Intl.NumberFormat(locale, { style: 'currency', currency: target, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(converted)}`;
}
