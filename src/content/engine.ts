import { type Currency, type DisplayMode, type EffectiveRate, type Preferences } from '../shared/types';
import { associatedCurrency, metadataCurrencies, uniqueCurrency } from './detection';
import { findPrices, formatConversion, type PriceMatch } from './prices';
import { captureSelection, CONVERTER_UI, EXCLUDED_CONTENT, selectionSource, validateSelection, type SelectionSnapshot } from './selection';

const UI = CONVERTER_UI;
const EXCLUDED = EXCLUDED_CONTENT;
const INLINE = new Set(['SPAN', 'B', 'STRONG', 'EM', 'I', 'SMALL', 'SUP', 'SUB']);

interface TextPatch { node: Text; original: string; written: string; segments: Text[] }
interface Region { range: Range; label: string; focus: HTMLElement }
interface Run { nodes: Text[]; element: Element; text: string; matches: PriceMatch[] }
interface RecordEntry { patches: TextPatch[]; extras: Node[]; regions: Region[]; count: number; kind: 'page' | 'selection' }
export interface ScanStatus { count: number; selectionCount: number; ambiguous: number; detectedSource: Currency | null }

export class ConversionEngine {
  private entries = new Set<RecordEntry>();
  private owned = new WeakSet<Node>();
  private observer: MutationObserver;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = new Set<Node>();
  private needsFullScan = false;
  private preferences: Preferences | null = null;
  private rate: EffectiveRate | null = null;
  private detectedSource: Currency | null = null;
  private ambiguity = new Map<Text, number>();
  private tooltip: HTMLDivElement;
  private hovering: Region | null = null;
  private disposed = false;

  constructor(private document: Document, private onStatus: (status: ScanStatus) => void = () => {}) {
    this.observer = new MutationObserver((changes) => this.schedule(changes));
    this.tooltip = document.createElement('div');
    this.tooltip.setAttribute(UI, '');
    this.tooltip.setAttribute('data-pc-tooltip', '');
    this.tooltip.setAttribute('role', 'tooltip');
    this.tooltip.hidden = true;
    document.addEventListener('pointermove', this.pointerMove, { passive: true });
    document.addEventListener('focusin', this.focusIn);
    document.addEventListener('focusout', this.hideTooltip);
    document.addEventListener('scroll', this.hideTooltip, true);
    document.addEventListener('keydown', this.keyDown);
  }

  apply(preferences: Preferences, rate: EffectiveRate): ScanStatus {
    this.stopObserving();
    this.pruneSelections();
    this.restoreEntries('page');
    this.preferences = preferences;
    this.rate = rate;
    this.ambiguity.clear();
    this.scan(this.document.body, true);
    this.observe();
    return this.status();
  }

  restore(): ScanStatus {
    this.stopObserving();
    this.preferences = null;
    this.restoreEntries();
    this.ambiguity.clear();
    this.detectedSource = null;
    this.tooltip.remove();
    return this.status();
  }

  stopPageConversion(): ScanStatus {
    this.stopObserving();
    this.preferences = null;
    this.restoreEntries('page');
    this.ambiguity.clear();
    this.detectedSource = null;
    this.observe();
    return this.status();
  }

  captureSelection(expectedText: string): SelectionSnapshot {
    this.schedule(this.observer.takeRecords());
    if (this.timer) this.flush();
    return captureSelection(this.document, expectedText, node => this.owned.has(node));
  }

  applySelection(snapshot: SelectionSnapshot, preferences: Preferences, rate: EffectiveRate): ScanStatus {
    this.schedule(this.observer.takeRecords());
    if (this.timer) this.flush();
    validateSelection(snapshot);
    // Recheck visibility, ownership, and eligibility after the asynchronous rate request.
    const current = captureSelection(this.document, snapshot.selectedText, node => this.owned.has(node));
    if (current.text !== snapshot.text || current.parts.length !== snapshot.parts.length ||
        current.parts.some((part, i) => part.node !== snapshot.parts[i]!.node || part.start !== snapshot.parts[i]!.start || part.end !== snapshot.parts[i]!.end)) {
      throw new Error('The selection changed. Select the amount again and retry.');
    }
    const source = selectionSource(current, preferences, () => new Set(this.runs(this.document.body)
      .flatMap(run => run.matches.flatMap(match => match.currency ? [match.currency] : []))));
    if (source === preferences.target) throw new Error(`This amount is already in ${preferences.target}. Change the target currency to convert it.`);
    const converted = formatConversion(snapshot.amount, source, preferences.target, rate.usdToCad,
      this.document.documentElement.lang.toLowerCase().startsWith('fr') ? 'fr-CA' : 'en-CA');
    this.stopObserving();
    // Split only boundary text nodes. Elements and their event listeners remain in place.
    const nodes = snapshot.parts.map(part => {
      if (part.end < part.node.length) part.node.splitText(part.end);
      return part.start ? part.node.splitText(part.start) : part.node;
    });
    const match: PriceMatch = { start: 0, end: snapshot.text.length, text: snapshot.text, amount: snapshot.amount, currency: source };
    this.render({ nodes, element: snapshot.element, text: snapshot.text, matches: [match] },
      [{ match, converted }], 'replace', 'selection', rate);
    this.observe();
    return this.status();
  }

  dispose(): void {
    this.restore();
    this.disposed = true;
    this.document.removeEventListener('pointermove', this.pointerMove);
    this.document.removeEventListener('focusin', this.focusIn);
    this.document.removeEventListener('focusout', this.hideTooltip);
    this.document.removeEventListener('scroll', this.hideTooltip, true);
    this.document.removeEventListener('keydown', this.keyDown);
  }

  status(): ScanStatus {
    let count = 0, selectionCount = 0, ambiguous = 0;
    this.pruneSelections();
    for (const entry of this.entries) if (entry.patches.some(patch => patch.node.isConnected)) {
      if (entry.kind === 'selection') selectionCount += entry.count;
      else count += entry.count;
    }
    for (const [node, number] of this.ambiguity) {
      if (node.isConnected) ambiguous += number;
      else this.ambiguity.delete(node);
    }
    const status = { count, selectionCount, ambiguous, detectedSource: this.detectedSource };
    this.onStatus(status);
    return status;
  }

  private stopObserving(): void {
    this.observer.disconnect();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
    this.needsFullScan = false;
  }

  private observe(): void {
    if (!this.disposed && (this.preferences || this.entries.size)) this.observer.observe(this.document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['content', 'value', 'itemprop', 'itemscope', 'hidden', 'aria-hidden', 'class', 'style', 'contenteditable'],
    });
  }

  private schedule(changes: MutationRecord[]): void {
    for (const change of changes) {
      if (change.type === 'childList' && [...change.addedNodes, ...change.removedNodes].length &&
          [...change.addedNodes, ...change.removedNodes].every(node => node.nodeType === 1 && (node as Element).hasAttribute(UI))) continue;
      const element = change.target.nodeType === 1 ? change.target as Element : change.target.parentElement;
      if (element?.closest(`[${UI}]`)) continue;
      if (this.preferences?.sourceMode === 'auto') this.needsFullScan = true;
      this.dirty.add(element ?? this.document.body);
    }
    if (!this.dirty.size || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 100);
  }

  private flush(): void {
    this.timer = null;
    this.schedule(this.observer.takeRecords());
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.observer.disconnect();
    this.hideTooltip();
    this.pruneSelections();
    const roots = [...this.dirty].filter(node => node.isConnected);
    this.dirty.clear();
    const full = this.needsFullScan;
    this.needsFullScan = false;
    if (!this.preferences) { this.observe(); this.status(); return; }
    if (full) {
      this.restoreEntries('page');
      this.ambiguity.clear();
      this.scan(this.document.body, true);
    } else {
      // Restore affected runs before rescanning; unchanged branches retain their conversions.
      for (const entry of this.entries) {
        if (entry.kind === 'selection') continue;
        if (entry.patches.some(patch => !patch.node.isConnected || roots.some(root => root.contains(patch.node)))) {
          this.restoreEntry(entry);
          this.entries.delete(entry);
        }
      }
      const outerRoots = roots.filter(root => !roots.some(other => other !== root && other.contains(root)));
      for (const root of outerRoots) {
        for (const node of this.ambiguity.keys()) if (root.contains(node)) this.ambiguity.delete(node);
        this.scan(root, false);
      }
    }
    this.observe();
    this.status();
  }

  private eligible(node: Text): boolean {
    const parent = node.parentElement;
    if (!parent || !node.data.trim() || this.owned.has(node) || parent.closest(EXCLUDED)) return false;
    // Ancestor visibility matters even when the price itself has no styles.
    for (let element: Element | null = parent; element; element = element.parentElement) {
      const style = this.document.defaultView!.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }

  private runs(root: Node): Run[] {
    const walker = this.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) if (this.eligible(node as Text)) nodes.push(node as Text);
    const used = new Set<Text>();
    const result: Run[] = [];
    for (const textNode of nodes) {
      if (used.has(textNode)) continue;
      let group = [textNode];
      let element: Element = textNode.parentElement!;
      // Combine only compact, price-only inline markup; never flatten a product card.
      let candidate: Element | null = element;
      for (let depth = 0; candidate && depth < 3; depth++, candidate = candidate.parentElement) {
        const text = candidate.textContent ?? '';
        if (text.length > 160 || candidate.closest(EXCLUDED) || candidate.querySelector(EXCLUDED)) break;
        if ([...candidate.querySelectorAll('*')].some(child => !INLINE.has(child.tagName))) break;
        const matches = findPrices(text);
        if (matches.length === 1 && text.trim() === matches[0]!.text.trim()) {
          const groupWalker = this.document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
          const parts: Text[] = [];
          while ((node = groupWalker.nextNode())) parts.push(node as Text);
          if (parts.every(part => !used.has(part) && !this.owned.has(part) && (!part.data.trim() || this.eligible(part)))) {
            group = parts; element = candidate;
          }
        }
      }
      group.forEach(part => used.add(part));
      const text = group.map(part => part.data).join('');
      const matches = findPrices(text);
      if (matches.length) result.push({ nodes: group, element, text, matches });
    }
    return result;
  }

  private scan(root: Node | null, detect: boolean): void {
    if (!root || !this.preferences || !this.rate) return;
    const runs = this.runs(root);
    if (detect) {
      const metadata = metadataCurrencies(this.document);
      const labels = new Set<string>();
      for (const run of runs) for (const match of run.matches) if (match.currency) labels.add(match.currency);
      this.detectedSource = uniqueCurrency(metadata.size ? metadata : labels);
    }
    for (const run of runs) {
      const selected: Array<{ match: PriceMatch; converted: string }> = [];
      let ambiguous = 0;
      for (const match of run.matches) {
        let source = match.currency;
        if (!source && this.preferences.sourceMode === 'manual') source = this.preferences.source;
        else if (!source) {
          const associated = associatedCurrency(run.element);
          source = associated === 'unknown' ? null : associated ?? this.detectedSource;
        }
        if (!source) { ambiguous++; continue; }
        if (source === this.preferences.target) continue;
        try {
          selected.push({ match, converted: formatConversion(match.amount, source, this.preferences.target, this.rate.usdToCad, this.document.documentElement.lang.toLowerCase().startsWith('fr') ? 'fr-CA' : 'en-CA') });
        } catch { /* Skip amounts outside safe numeric precision. */ }
      }
      if (ambiguous && run.nodes[0]) this.ambiguity.set(run.nodes[0], ambiguous);
      if (selected.length) this.render(run, selected);
    }
  }

  private render(run: Run, prices: Array<{ match: PriceMatch; converted: string }>, display: DisplayMode = this.preferences!.display,
    kind: RecordEntry['kind'] = 'page', rate: EffectiveRate = this.rate!): void {
    const entry: RecordEntry = { patches: run.nodes.map(node => ({ node, original: node.data, written: node.data, segments: [node] })), extras: [], regions: [], count: prices.length, kind };
    const offsets: number[] = [];
    let cursor = 0;
    for (const patch of entry.patches) { offsets.push(cursor); cursor += patch.original.length; this.owned.add(patch.node); }
    const position = (offset: number, end = false) => {
      for (let i = 0; i < entry.patches.length; i++) {
        const patch = entry.patches[i]!;
        if (offset < offsets[i]! + patch.original.length || end && offset === offsets[i]! + patch.original.length || i === entry.patches.length - 1) return { index: i, offset: offset - offsets[i]! };
      }
      return { index: 0, offset: 0 };
    };
    const label = (price: typeof prices[number]) => `Original: ${price.match.text.trim()} · ${price.converted}${rate?.stale ? ' · cached rate' : ''}`;
    if (display === 'replace') {
      for (let i = 0; i < entry.patches.length; i++) {
        const patch = entry.patches[i]!;
        const start = offsets[i]!, end = start + patch.original.length;
        let output = '', offset = 0;
        const regions: Array<{ start: number; end: number; label: string }> = [];
        for (const price of prices) {
          if (price.match.end <= start || price.match.start >= end) continue;
          const localStart = Math.max(price.match.start - start, 0), localEnd = Math.min(price.match.end - start, patch.original.length);
          output += patch.original.slice(offset, localStart);
          if (price.match.start >= start) {
            const regionStart = output.length;
            output += price.converted;
            regions.push({ start: regionStart, end: output.length, label: label(price) });
          }
          offset = localEnd;
        }
        output += patch.original.slice(offset);
        patch.node.data = output;
        patch.written = output;
        for (const region of regions) {
          const range = this.document.createRange();
          range.setStart(patch.node, region.start); range.setEnd(patch.node, region.end);
          this.addRegion(entry, range, region.label);
        }
      }
    } else if (display === 'beside') {
      // Splits retain the site's original Text node. Restoration rejoins our own tails.
      for (const price of [...prices].reverse()) {
        const end = position(price.match.end, true);
        const patch = entry.patches[end.index]!;
        const tail = patch.node.splitText(end.offset);
        patch.segments.splice(1, 0, tail);
        entry.extras.push(tail);
        this.owned.add(tail);
        const badge = this.document.createElement('span');
        badge.setAttribute(UI, ''); badge.setAttribute('data-pc-badge', '');
        badge.textContent = ` (${price.converted})`;
        patch.node.parentNode!.insertBefore(badge, tail);
        entry.extras.push(badge);
        const range = this.document.createRange(); range.selectNodeContents(badge);
        this.addRegion(entry, range, label(price));
      }
      for (const patch of entry.patches) patch.written = patch.node.data;
    } else {
      for (const price of prices) {
        const start = position(price.match.start), end = position(price.match.end, true);
        const range = this.document.createRange();
        range.setStart(entry.patches[start.index]!.node, start.offset);
        range.setEnd(entry.patches[end.index]!.node, end.offset);
        this.addRegion(entry, range, label(price));
      }
    }
    this.entries.add(entry);
  }

  private addRegion(entry: RecordEntry, range: Range, label: string): void {
    const focus = this.document.createElement('span');
    focus.setAttribute(UI, ''); focus.setAttribute('data-pc-focus', '');
    focus.tabIndex = 0; focus.setAttribute('role', 'note'); focus.setAttribute('aria-label', label);
    const anchor = range.endContainer;
    anchor.parentNode?.insertBefore(focus, anchor.nextSibling);
    entry.extras.push(focus);
    entry.regions.push({ range, label, focus });
  }

  private restoreEntry(entry: RecordEntry): void {
    for (const patch of entry.patches) {
      if (patch.node.isConnected && patch.node.data === patch.written) {
        patch.node.data = patch.segments.length > 1
          ? patch.segments.filter(segment => segment.isConnected).map(segment => segment.data).join('')
          : patch.original;
      }
      this.owned.delete(patch.node);
    }
    for (const extra of entry.extras) { extra.parentNode?.removeChild(extra); this.owned.delete(extra); }
  }

  private pruneSelections(): void {
    for (const entry of this.entries) {
      if (entry.kind !== 'selection' || entry.patches.every(patch => patch.node.isConnected && patch.node.data === patch.written)) continue;
      // A site's newer text wins. Discard stale undo data without rewriting any of it.
      for (const patch of entry.patches) this.owned.delete(patch.node);
      for (const extra of entry.extras) extra.parentNode?.removeChild(extra);
      if (entry.regions.includes(this.hovering!)) this.hideTooltip();
      this.entries.delete(entry);
    }
  }

  private restoreEntries(kind?: RecordEntry['kind']): void {
    this.hideTooltip();
    this.pruneSelections();
    for (const entry of this.entries) {
      if (kind && entry.kind !== kind) continue;
      this.restoreEntry(entry);
      this.entries.delete(entry);
    }
  }

  private pointerMove = (event: PointerEvent): void => {
    for (const entry of this.entries) {
      if (!(event.target instanceof Node) || !entry.patches.some(patch => patch.node.parentElement?.contains(event.target as Node)) &&
          !entry.extras.some(extra => extra.contains(event.target as Node))) continue;
      for (const region of entry.regions) {
      if (![...region.range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) continue;
      this.showTooltip(region); return;
      }
    }
    this.hideTooltip();
  };

  private focusIn = (event: FocusEvent): void => {
    for (const entry of this.entries) for (const region of entry.regions) {
      if (region.focus === event.target) { this.showTooltip(region); return; }
    }
    this.hideTooltip();
  };

  private showTooltip(region: Region): void {
    if (this.hovering === region) return;
    this.hovering = region;
    if (!this.tooltip.isConnected) this.document.documentElement.append(this.tooltip);
    this.tooltip.textContent = region.label;
    this.tooltip.hidden = false;
    const rect = region.range.getBoundingClientRect();
    const view = this.document.defaultView!;
    this.tooltip.style.left = `${Math.max(8, Math.min(rect.left, view.innerWidth - 328))}px`;
    this.tooltip.style.top = `${Math.max(8, Math.min(rect.bottom + 8, view.innerHeight - this.tooltip.offsetHeight - 8))}px`;
  }

  private hideTooltip = (): void => { this.tooltip.hidden = true; this.hovering = null; };
  private keyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') this.hideTooltip(); };
}
