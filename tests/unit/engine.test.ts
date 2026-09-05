import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversionEngine } from '../../src/content/engine';
import { DEFAULT_PREFERENCES, type EffectiveRate, type Preferences } from '../../src/shared/types';

const rate: EffectiveRate = { usdToCad: 1.4, date: '2026-09-04', fetchedAt: Date.now(), source: 'daily', stale: false };
let engine: ConversionEngine;
const text = (selector: string) => document.querySelector(selector)!.textContent!.replace(/\s/g, ' ');
const apply = (preferences: Partial<Preferences> = {}) => engine.apply({ ...DEFAULT_PREFERENCES, ...preferences }, rate);
const settle = async () => { await vi.advanceTimersByTimeAsync(150); };

beforeEach(() => {
  vi.useFakeTimers();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.lang = 'en';
  engine = new ConversionEngine(document);
});
afterEach(() => { engine.dispose(); vi.useRealTimers(); });

describe('page conversion', () => {
  it('replaces prices and preserves the original nodes and event listeners', () => {
    document.body.innerHTML = '<a href="#buy" id="price">US$10.00</a>';
    const link = document.querySelector('a')!;
    const originalNode = link.firstChild;
    const click = vi.fn(); link.addEventListener('click', click);
    expect(apply().count).toBe(1);
    expect(text('#price')).toBe('≈ CAD 14.00');
    expect(link.firstChild).toBe(originalNode);
    link.click(); expect(click).toHaveBeenCalledOnce();
    engine.restore();
    expect(link.textContent).toBe('US$10.00'); expect(link.childNodes).toHaveLength(1);
  });

  it('shows smaller conversions beside each original and restores the exact text', () => {
    document.body.innerHTML = '<p id="prices">Pay $10.00 or $20.00 today.</p>';
    apply({ display: 'beside' });
    expect(text('#prices')).toBe('Pay $10.00 (≈ CAD 14.00) or $20.00 (≈ CAD 28.00) today.');
    expect(document.querySelectorAll('[data-pc-badge]')).toHaveLength(2);
    engine.restore();
    expect(text('#prices')).toBe('Pay $10.00 or $20.00 today.');
    expect(document.querySelector('#prices')!.childNodes).toHaveLength(1);
  });

  it('keeps visible text unchanged in hover mode and provides a keyboard target', () => {
    document.body.innerHTML = '<p id="price">$10.00</p>';
    apply({ display: 'hover' });
    expect(text('#price')).toBe('$10.00');
    const focus = document.querySelector<HTMLElement>('[data-pc-focus]')!;
    expect(focus.tabIndex).toBe(0); expect(focus.getAttribute('aria-label')).toContain('CAD');
    engine.restore(); expect(document.querySelector('[data-pc-focus]')).toBeNull();
  });

  it.each(['replace', 'beside', 'hover'] as const)('supports inline split prices in %s mode', display => {
    document.body.innerHTML = '<p id="price"><span>$</span><b>49</b><sup>.99</sup></p>';
    const original = document.querySelector('#price')!.innerHTML;
    expect(apply({ display }).count).toBe(1);
    engine.restore(); expect(document.querySelector('#price')!.innerHTML).toBe(original);
  });

  it('switches display modes and directions using originals, without duplication', () => {
    document.body.innerHTML = '<p id="price">$10.00</p>';
    apply(); apply(); apply({ display: 'beside' });
    expect(text('#price')).toBe('$10.00 (≈ CAD 14.00)');
    apply({ source: 'CAD', target: 'USD' });
    expect(text('#price')).toBe('≈ USD 7.14');
    engine.restore(); expect(text('#price')).toBe('$10.00');
  });

  it('honors explicit currencies and ignores already-target and unsupported currencies', () => {
    document.body.innerHTML = '<p id="usd">USD 10</p><p id="cad">CAD 10</p><p id="aud">AUD $10</p>';
    expect(apply().count).toBe(1);
    expect(text('#cad')).toBe('CAD 10'); expect(text('#aud')).toBe('AUD $10');
  });

  it('skips ambiguous dollar signs when detection has no evidence', () => {
    document.body.innerHTML = '<p id="price">$10</p>';
    expect(apply({ sourceMode: 'auto' })).toMatchObject({ count: 0, ambiguous: 1, detectedSource: null });
    expect(text('#price')).toBe('$10');
  });

  it('uses page metadata and updates when that metadata changes', async () => {
    document.head.innerHTML = '<meta property="product:price:currency" content="USD">';
    document.body.innerHTML = '<p id="price">$10</p>';
    expect(apply({ sourceMode: 'auto' })).toMatchObject({ count: 1, detectedSource: 'USD' });
    document.querySelector('meta')!.setAttribute('content', 'CAD');
    await settle(); expect(text('#price')).toBe('$10'); expect(engine.status().count).toBe(0);
  });

  it('uses structured price metadata and rejects conflicting metadata', () => {
    document.head.innerHTML = '<script type="application/ld+json">{"offers":{"priceCurrency":"USD"}}</script>';
    document.body.innerHTML = '<p id="price">$10</p>';
    expect(apply({ sourceMode: 'auto' }).count).toBe(1);
    engine.restore();
    document.head.innerHTML += '<meta property="product:price:currency" content="CAD">';
    expect(apply({ sourceMode: 'auto' })).toMatchObject({ count: 0, ambiguous: 1 });
  });

  it('prefers associated metadata on a mixed-currency page', () => {
    document.body.innerHTML = '<div itemscope><meta itemprop="priceCurrency" content="USD"><p id="usd">$10</p></div><div itemscope><meta itemprop="priceCurrency" content="CAD"><p id="cad">$10</p></div>';
    expect(apply({ sourceMode: 'auto' }).count).toBe(1);
    expect(text('#usd')).toBe('≈ CAD 14.00'); expect(text('#cad')).toBe('$10');
  });

  it('uses explicit page labels only when consistent', () => {
    document.body.innerHTML = '<p>USD 10</p><p id="bare">$20</p>';
    expect(apply({ sourceMode: 'auto' }).count).toBe(2);
    engine.restore(); document.body.innerHTML += '<p>CAD 30</p>';
    expect(apply({ sourceMode: 'auto' })).toMatchObject({ count: 1, ambiguous: 1 });
  });

  it('converts newly inserted prices and updated text without observer loops', async () => {
    document.body.innerHTML = '<p id="price">$10</p>';
    apply();
    document.querySelector('#price')!.firstChild!.textContent = '$20';
    document.body.insertAdjacentHTML('beforeend', '<p id="added">$30</p>');
    await settle();
    expect(text('#price')).toBe('≈ CAD 28.00'); expect(text('#added')).toBe('≈ CAD 42.00');
    expect(engine.status().count).toBe(2);
    await vi.advanceTimersByTimeAsync(1000); expect(vi.getTimerCount()).toBe(0);
    engine.restore(); expect(text('#price')).toBe('$20');
  });

  it('does not overwrite a new website value when restoring before the observer runs', () => {
    document.body.innerHTML = '<p id="price">$10</p>';
    apply(); document.querySelector('#price')!.firstChild!.textContent = '$99';
    engine.restore(); expect(text('#price')).toBe('$99');
  });

  it('preserves website edits in text tails created by beside mode', () => {
    document.body.innerHTML = '<p id="price">$10 plus shipping</p>';
    apply({ display: 'beside' });
    const tail = [...document.querySelector('#price')!.childNodes].find(node => node.nodeType === 3 && node.textContent?.includes('shipping'))!;
    tail.textContent = ' with free shipping';
    engine.restore(); expect(text('#price')).toBe('$10 with free shipping');
  });

  it('preserves updated values in a split price', async () => {
    document.body.innerHTML = '<p id="price"><span>$</span><b>49</b><sup>.99</sup></p>';
    apply(); document.querySelector('b')!.firstChild!.textContent = '59';
    await settle(); expect(text('#price')).toBe('≈ CAD 83.99');
    engine.restore(); expect(text('#price')).toBe('$59.99');
  });

  it('ignores hidden, editable, code, form and shadow content, then handles revealed text', async () => {
    document.body.innerHTML = '<div hidden id="hidden">$10</div><div style="display:none">$10</div><pre>$10</pre><code>$10</code><div contenteditable="true"><span>$10</span></div><textarea>$10</textarea><input value="$10"><div id="shadow"></div>';
    document.querySelector('#shadow')!.attachShadow({ mode: 'open' }).innerHTML = '<p>$10</p>';
    expect(apply().count).toBe(0);
    document.querySelector('#hidden')!.removeAttribute('hidden'); await settle();
    expect(text('#hidden')).toBe('≈ CAD 14.00');
    engine.restore(); expect(document.querySelector('textarea')!.value).toBe('$10');
  });

  it('stops observing when restored and drops detached prices from its count', async () => {
    document.body.innerHTML = '<p id="price">$10</p>';
    apply(); document.querySelector('#price')!.remove(); await settle();
    expect(engine.status().count).toBe(0);
    engine.restore(); document.body.innerHTML = '<p id="price">$30</p>'; await settle();
    expect(text('#price')).toBe('$30');
  });
});
