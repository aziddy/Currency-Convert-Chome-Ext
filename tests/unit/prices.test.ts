import { describe, expect, it } from 'vitest';
import { findPrices, formatConversion, parseAmount } from '../../src/content/prices';

describe('price parsing', () => {
  it.each([
    ['$49.99', 49.99, null], ['US$49.99', 49.99, 'USD'], ['USD 49.99', 49.99, 'USD'],
    ['49.99 USD', 49.99, 'USD'], ['CA$49.99', 49.99, 'CAD'], ['C$49.99', 49.99, 'CAD'],
    ['$49.99 CAD', 49.99, 'CAD'], ['49,99 $ CA', 49.99, 'CAD'], ['49,99 $ CAD', 49.99, 'CAD'], ['1 234,56 CAD', 1234.56, 'CAD'],
    ['1\u202f234,56 $', 1234.56, null], ['CAD 1,234.56', 1234.56, 'CAD'], ['USD 1.234,56', 1234.56, 'USD'],
    ['$1,234', 1234, null], ['$1.234', 1234, null], ['$0.00', 0, null], ['-$20.50', -20.5, null],
    ['$-20.50', -20.5, null], ['−20,50 CAD', -20.5, 'CAD'], ['USD $ 12.50', 12.5, 'USD'],
  ])('parses %s', (text, amount, currency) => {
    expect(findPrices(text as string)).toEqual([{ start: 0, end: (text as string).length, text, amount, currency }]);
  });

  it.each(['AUD $10', 'A$10', 'NZ$10', 'HK$10', '€10', '10 EUR', 'JPY 1200', 'US$10 CAD', 'abc$10', 'SKU123USD', '123', '$1,23,45', '$12.3456', '$1.234.56'])('skips %s', text => {
    expect(findPrices(text)).toEqual([]);
  });

  it('finds multiple prices without swallowing surrounding words', () => {
    expect(findPrices('Was $99.99, now USD 79.99. Shipping: 5 CAD.').map(p => [p.text, p.amount, p.currency])).toEqual([
      ['$99.99', 99.99, null], ['USD 79.99', 79.99, 'USD'], ['5 CAD', 5, 'CAD'],
    ]);
  });

  it.each(['12 34', '1,2,3', 'NaN', 'Infinity', '1e9', '1.2345', '9007199254740992'])('rejects malformed or unsafe amount %s', text => expect(parseAmount(text)).toBeNull());

  it('converts both directions, formats clearly, and rounds only the displayed value', () => {
    expect(formatConversion(100, 'USD', 'CAD', 1.38).replace(/\s/g, ' ')).toBe('≈ CAD 138.00');
    expect(formatConversion(138, 'CAD', 'USD', 1.38).replace(/\s/g, ' ')).toBe('≈ USD 100.00');
    expect(formatConversion(19.99, 'USD', 'CAD', 1.38).replace(/\s/g, ' ')).toBe('≈ CAD 27.59');
    expect(formatConversion(10, 'USD', 'CAD', 1.38, 'fr-CA')).toContain('13,80');
  });
});
