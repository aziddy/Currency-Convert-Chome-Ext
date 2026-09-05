import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversionEngine } from '../../src/content/engine';
import { parseSelectedAmount } from '../../src/content/selection';
import { DEFAULT_PREFERENCES, type EffectiveRate, type Preferences } from '../../src/shared/types';

const rate: EffectiveRate = { usdToCad: 1.4, date: '2026-09-04', fetchedAt: Date.now(), source: 'daily', stale: false };
let engine: ConversionEngine;
const text = (selector: string) => document.querySelector(selector)!.textContent!.replace(/\s/g, ' ');
function select(selector: string, start = 0, end?: number): string {
  const element = document.querySelector(selector)!;
  const range = document.createRange();
  if (end === undefined) range.selectNodeContents(element);
  else { range.setStart(element.firstChild!, start); range.setEnd(element.firstChild!, end); }
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  return range.toString();
}
function convert(selector: string, preferences: Partial<Preferences> = {}, value = rate): void {
  const selected = select(selector);
  engine.applySelection(engine.captureSelection(selected), { ...DEFAULT_PREFERENCES, ...preferences }, value);
}
beforeEach(() => {
  vi.useFakeTimers();
  document.head.innerHTML = ''; document.body.innerHTML = '';
  document.documentElement.lang = 'en';
  engine = new ConversionEngine(document);
});
afterEach(() => { engine.dispose(); document.getSelection()?.removeAllRanges(); vi.useRealTimers(); });

describe('selection parsing', () => {
  it.each([
    ['100', 100, null], ['0', 0, null], ['-12.50', -12.5, null], ['1,234.56', 1234.56, null],
    ['1\u202f234,56', 1234.56, null], ['US$50', 50, 'USD'], ['1 234,56 $ CA', 1234.56, 'CAD'],
  ])('accepts one complete amount: %s', (input, amount, currency) => {
    expect(parseSelectedAmount(input)).toEqual({ amount, currency });
  });
  it.each(['', 'five', 'USD 5 and USD 10', '5–10', '100 people', 'AUD $35', '€10', '1.2.3', '9'.repeat(25), 'USD 3 CAD'])('rejects %s', input => {
    expect(() => parseSelectedAmount(input)).toThrow();
  });
});

describe('selected conversions', () => {
  it('changes only the selected number and restores without replacing elements or handlers', () => {
    document.body.innerHTML = '<a id="price">Costs 100 today; USD 50 tomorrow.</a><p id="other">USD 70</p>';
    const element = document.querySelector('a')!;
    const click = vi.fn(); element.addEventListener('click', click);
    const selected = select('#price', 6, 9);
    engine.applySelection(engine.captureSelection(selected), { ...DEFAULT_PREFERENCES, display: 'hover' }, rate);
    expect(text('#price')).toBe('Costs ≈ CAD 140.00 today; USD 50 tomorrow.');
    expect(text('#other')).toBe('USD 70');
    expect(engine.status()).toMatchObject({ count: 0, selectionCount: 1 });
    element.click(); expect(click).toHaveBeenCalledOnce();
    expect(element.querySelector('[data-pc-focus]')?.getAttribute('aria-label')).toContain('Original: 100');
    engine.restore();
    expect(text('#price')).toBe('Costs 100 today; USD 50 tomorrow.');
    expect(document.querySelector('a')).toBe(element);
    expect(engine.status().selectionCount).toBe(0);
  });

  it.each(['$100', 'US$100', 'USD 100', '100 USD', '-$100'])('includes the adjoining marker in %s', value => {
    document.body.innerHTML = `<p id="price">${value}</p>`;
    const start = value.indexOf('100');
    const selected = select('#price', start, start + 3);
    engine.applySelection(engine.captureSelection(selected), DEFAULT_PREFERENCES, rate);
    expect(text('#price')).toBe(value.startsWith('-') ? '≈ -CAD 140.00' : '≈ CAD 140.00');
    engine.restore(); expect(text('#price')).toBe(value);
  });

  it('includes labels across inline elements and restores split markup', () => {
    document.body.innerHTML = '<p id="price"><span>US$</span><strong>89</strong><sup>.99</sup></p>';
    const strong = document.querySelector('strong')!, sup = document.querySelector('sup')!;
    const range = document.createRange(); range.setStart(strong.firstChild!, 0); range.setEnd(sup.firstChild!, 3);
    document.getSelection()!.addRange(range);
    engine.applySelection(engine.captureSelection('89.99'), DEFAULT_PREFERENCES, rate);
    expect(text('#price')).toBe('≈ CAD 125.99');
    expect(document.querySelector('strong')).toBe(strong);
    engine.restore(); expect(text('#price')).toBe('US$89.99');
  });

  it.each(['AUD $100', '€100', 'foo100', '1000', '100.50'])('does not replace an unsupported or partial amount in %s', value => {
    document.body.innerHTML = `<p id="price">${value}</p>`;
    const start = value.indexOf('100');
    const selected = select('#price', start, start + 3);
    expect(() => engine.captureSelection(selected)).toThrow();
    expect(text('#price')).toBe(value);
  });

  it('uses metadata and falls back to the saved direction when automatic detection is uncertain', () => {
    document.body.innerHTML = '<p id="one">100</p><p id="two">100</p><p id="three">USD 100</p>';
    // Explicit USD elsewhere is reliable page evidence even when the saved source is CAD.
    convert('#one', { source: 'CAD', target: 'USD', sourceMode: 'manual' });
    expect(text('#one')).toBe('≈ USD 71.43');
    document.querySelector('#three')!.remove();
    convert('#two', { sourceMode: 'auto' });
    expect(text('#two')).toBe('≈ CAD 140.00');
  });

  it('honors explicit labels, target currency and structured metadata', () => {
    document.head.innerHTML = '<meta property="product:price:currency" content="CAD">';
    document.body.innerHTML = '<p id="bare">140</p><p id="explicit">USD 100</p>';
    convert('#bare', { source: 'CAD', target: 'USD', sourceMode: 'auto' });
    expect(text('#bare')).toBe('≈ USD 100.00');
    expect(() => convert('#explicit', { source: 'CAD', target: 'USD' })).toThrow('already in USD');
    expect(text('#explicit')).toBe('USD 100');
  });

  it('ignores previous conversions as automatic source evidence', () => {
    document.body.innerHTML = '<p id="one">100</p><p id="two">200</p>';
    convert('#one', { sourceMode: 'auto' }); convert('#two', { sourceMode: 'auto' });
    expect(text('#two')).toBe('≈ CAD 280.00');
    expect(engine.status().selectionCount).toBe(2);
  });

  it('formats French amounts and uses custom and cached rates', () => {
    document.documentElement.lang = 'fr-CA';
    document.body.innerHTML = '<p id="price">1 234,56 $ CA</p>';
    convert('#price', { source: 'CAD', target: 'USD' }, { ...rate, source: 'custom', usdToCad: 1.5, stale: true });
    expect(text('#price')).toBe('≈ 823,04 USD');
    expect(document.querySelector('[data-pc-focus]')?.getAttribute('aria-label')).toContain('cached rate');
  });

  it('keeps independent selections and prevents compounding', () => {
    document.body.innerHTML = '<p id="one">100</p><p id="two">200</p>';
    convert('#one'); convert('#two');
    expect(engine.status().selectionCount).toBe(2);
    const selected = select('#one');
    expect(() => engine.captureSelection(selected)).toThrow();
    expect(text('#one')).toBe('≈ CAD 140.00');
    engine.restore(); expect(text('#one')).toBe('100'); expect(text('#two')).toBe('200');
  });

  it('keeps selections frozen through page conversion, rate/mode changes and stopping automation', async () => {
    document.body.innerHTML = '<p id="price">100 and USD 20</p><p id="other">USD 30</p>';
    const selected = select('#price', 0, 3);
    engine.applySelection(engine.captureSelection(selected), DEFAULT_PREFERENCES, rate);
    expect(engine.apply(DEFAULT_PREFERENCES, rate)).toMatchObject({ count: 2, selectionCount: 1 });
    expect(text('#price')).toBe('≈ CAD 140.00 and ≈ CAD 28.00');
    engine.apply({ ...DEFAULT_PREFERENCES, display: 'beside', sourceMode: 'auto' }, { ...rate, usdToCad: 1.5 });
    expect(text('#price')).toBe('≈ CAD 140.00 and USD 20 (≈ CAD 30.00)');
    document.querySelector('#other')!.textContent = 'USD 40';
    await vi.advanceTimersByTimeAsync(150);
    expect(text('#price')).toBe('≈ CAD 140.00 and USD 20 (≈ CAD 30.00)');
    engine.stopPageConversion();
    expect(text('#price')).toBe('≈ CAD 140.00 and USD 20');
    engine.restore(); expect(text('#price')).toBe('100 and USD 20');
  });

  it('does not overwrite a website update when restoring', async () => {
    document.body.innerHTML = '<p id="price">100</p>';
    convert('#price');
    document.querySelector('#price')!.firstChild!.textContent = 'Sale: 50';
    await vi.advanceTimersByTimeAsync(150);
    expect(engine.status().selectionCount).toBe(0);
    engine.restore(); expect(text('#price')).toBe('Sale: 50');
  });

  it.each(['selection', 'text', 'visibility', 'editable', 'detached'])('aborts when %s changes while awaiting the rate', kind => {
    document.body.innerHTML = '<p id="price">100</p><p id="other">200</p>';
    const snapshot = engine.captureSelection(select('#price'));
    const price = document.querySelector('#price')!;
    if (kind === 'selection') select('#other');
    if (kind === 'text') price.firstChild!.textContent = '300';
    if (kind === 'visibility') (price as HTMLElement).hidden = true;
    if (kind === 'editable') price.setAttribute('contenteditable', 'true');
    if (kind === 'detached') price.remove();
    expect(() => engine.applySelection(snapshot, DEFAULT_PREFERENCES, rate)).toThrow();
    expect(engine.status().selectionCount).toBe(0);
    expect(document.body.textContent).not.toContain('≈');
  });

  it.each(['<textarea id="price">100</textarea>', '<pre id="price">100</pre>', '<code id="price">100</code>',
    '<p contenteditable="true" id="price">100</p>', '<p hidden id="price">100</p>',
    '<div><span id="price">100</span></div><style>div { display:none }</style>'])('rejects excluded content: %s', markup => {
    document.body.innerHTML = markup;
    expect(() => engine.captureSelection(select('#price'))).toThrow();
  });

  it('rejects selections spanning blocks or line breaks', () => {
    document.body.innerHTML = '<div id="price"><p>1</p><p>00</p></div>';
    expect(() => engine.captureSelection(select('#price'))).toThrow();
    document.body.innerHTML = '<p id="price">1<br>00</p>';
    expect(() => engine.captureSelection(select('#price'))).toThrow();
  });
});
