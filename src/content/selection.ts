import { type Currency, type Preferences } from '../shared/types';
import { associatedCurrency, metadataCurrencies, uniqueCurrency } from './detection';
import { CURRENCY_MARKER, findPrices, parseAmount } from './prices';

export const CONVERTER_UI = 'data-price-converter-ui';
export const EXCLUDED_CONTENT = `script, style, noscript, textarea, input, select, option, pre, code, kbd, samp, svg, math, [contenteditable]:not([contenteditable="false"]), [hidden], [aria-hidden="true"], [${CONVERTER_UI}]`;
const INLINE = new Set(['SPAN', 'A', 'B', 'STRONG', 'EM', 'I', 'SMALL', 'SUP', 'SUB', 'U', 'S', 'MARK']);
const whitespace = (value: string) => value.trim().replace(/\s+/g, ' ');
const changed = () => new Error('The selection changed. Select the amount again and retry.');

export interface SelectionPart { node: Text; start: number; end: number; original: string }
export interface SelectionSnapshot {
  range: Range;
  startNode: Node;
  startOffset: number;
  endNode: Node;
  endOffset: number;
  selectedText: string;
  parts: SelectionPart[];
  text: string;
  amount: number;
  currency: Currency | null;
  element: Element;
}

export function parseSelectedAmount(text: string): { amount: number; currency: Currency | null } {
  const value = text.trim();
  if (!value || value.length > 160) throw new Error('Select one number or one USD/CAD price to convert.');
  const amount = parseAmount(value);
  if (amount !== null) return { amount, currency: null };
  const prices = findPrices(value);
  if (prices.length !== 1 || prices[0]!.text !== value) {
    throw new Error('Select one complete number or USD/CAD price, without other text.');
  }
  return { amount: prices[0]!.amount, currency: prices[0]!.currency };
}

function blockFor(element: Element): Element {
  for (let current = element; current.parentElement; current = current.parentElement) {
    const display = current.ownerDocument.defaultView!.getComputedStyle(current).display;
    if (display ? !['inline', 'contents'].includes(display) : !INLINE.has(current.tagName)) return current;
  }
  return element.ownerDocument.body;
}

function textNodes(root: Node): Text[] {
  if (root.nodeType === Node.TEXT_NODE) return [root as Text];
  const nodes: Text[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  return nodes;
}

function eligible(node: Text, owned: (node: Node) => boolean): void {
  if (owned(node)) throw new Error('This text already contains a conversion. Restore originals before converting it again.');
  if (!node.parentElement || node.parentElement.closest(EXCLUDED_CONTENT)) {
    throw new Error('Select displayed page text, outside forms, code, or extension controls.');
  }
  for (let element: Element | null = node.parentElement; element; element = element.parentElement) {
    const style = node.ownerDocument.defaultView!.getComputedStyle(element);
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) {
      throw new Error('Only visible page text can be converted.');
    }
  }
}

export function captureSelection(document: Document, expectedText: string, owned: (node: Node) => boolean): SelectionSnapshot {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) throw changed();
  const range = selection.getRangeAt(0).cloneRange();
  const selectedText = range.toString();
  if (whitespace(selectedText) !== whitespace(expectedText)) throw changed();
  // Validate before walking any surrounding markup or requesting a rate.
  parseSelectedAmount(selectedText);
  if (range.startContainer.getRootNode() !== document || range.endContainer.getRootNode() !== document ||
      document.defaultView?.top !== document.defaultView || document.contentType === 'application/pdf') {
    throw new Error('Selection conversion supports ordinary top-level webpages only.');
  }
  if (range.cloneContents().querySelector(`br, hr, ${EXCLUDED_CONTENT}`)) {
    throw new Error('Select one amount in ordinary page text.');
  }
  const selected = textNodes(range.commonAncestorContainer).filter(node => range.intersectsNode(node) &&
    (node !== range.startContainer || range.startOffset < node.length) &&
    (node !== range.endContainer || range.endOffset > 0));
  if (!selected.length) throw changed();
  selected.forEach(node => eligible(node, owned));
  const block = blockFor(selected[0]!.parentElement!);
  if (selected.some(node => blockFor(node.parentElement!) !== block)) {
    throw new Error('Select one amount within a single line of page content.');
  }

  // Include adjoining labels across simple inline markup, without searching elsewhere on the page.
  const common = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement!;
  let context = common;
  while (context !== block && context.parentElement && (context.parentElement.textContent?.length ?? 0) <= 4096) {
    context = context.parentElement;
  }
  const nodes = textNodes(context);
  const text = nodes.map(node => node.data).join('');
  let offset = 0, start = -1, end = -1;
  for (const node of nodes) {
    if (node === selected[0]) start = offset + (node === range.startContainer ? range.startOffset : 0);
    if (node === selected.at(-1)) end = offset + (node === range.endContainer ? range.endOffset : node.length);
    offset += node.length;
  }
  if (start < 0 || end < start) throw changed();
  start += text.slice(start, end).length - text.slice(start, end).trimStart().length;
  end -= text.slice(start, end).length - text.slice(start, end).trimEnd().length;
  const prefix = text.slice(Math.max(0, start - 32), start).match(
    new RegExp(`(?<![\\p{L}\\p{N}_$])(?:[-−+]?${CURRENCY_MARKER})[ \\u00a0\\u202f]*$`, 'iu'),
  );
  const suffix = text.slice(end, end + 32).match(new RegExp(`^[ \\u00a0\\u202f]*${CURRENCY_MARKER}`, 'iu'));
  if (prefix) start -= prefix[0].length;
  if (suffix) end += suffix[0].length;
  // Never replace a substring of a larger number or currency identifier.
  if (/[\p{L}\p{N}_$−+\-]$/u.test(text.slice(0, start)) || /^[\p{L}\p{N}_]/u.test(text.slice(end)) ||
      /\d[.,]$/.test(text.slice(0, start)) || /^[.,]\d/.test(text.slice(end))) {
    throw new Error('Select the complete amount, including all its digits.');
  }
  const expandedText = text.slice(start, end);
  const parsed = parseSelectedAmount(expandedText);
  const parts: SelectionPart[] = [];
  offset = 0;
  for (const node of nodes) {
    const localStart = Math.max(0, start - offset), localEnd = Math.min(node.length, end - offset);
    if (localStart < localEnd) {
      eligible(node, owned);
      if (blockFor(node.parentElement!) !== block) throw new Error('Select one amount in ordinary page text.');
      parts.push({ node, start: localStart, end: localEnd, original: node.data });
    }
    offset += node.length;
  }
  // Prevent expansion through a line break or another excluded element with no text nodes.
  const expanded = document.createRange();
  expanded.setStart(parts[0]!.node, parts[0]!.start);
  expanded.setEnd(parts.at(-1)!.node, parts.at(-1)!.end);
  if (expanded.cloneContents().querySelector(`br, hr, ${EXCLUDED_CONTENT}`)) {
    throw new Error('Select one amount in ordinary page text.');
  }
  return { range, startNode: range.startContainer, startOffset: range.startOffset,
    endNode: range.endContainer, endOffset: range.endOffset, selectedText, parts,
    text: expandedText, ...parsed, element: parts[0]!.node.parentElement! };
}

export function validateSelection(snapshot: SelectionSnapshot): void {
  const current = snapshot.element.ownerDocument.getSelection();
  const range = current?.rangeCount === 1 ? current.getRangeAt(0) : null;
  if (!range || range.startContainer !== snapshot.startNode || range.startOffset !== snapshot.startOffset ||
      range.endContainer !== snapshot.endNode || range.endOffset !== snapshot.endOffset ||
      range.toString() !== snapshot.selectedText || snapshot.parts.some(part => !part.node.isConnected || part.node.data !== part.original)) {
    throw changed();
  }
}

export function selectionSource(snapshot: SelectionSnapshot, preferences: Preferences, pageLabels: () => Set<Currency>): Currency {
  if (snapshot.currency) return snapshot.currency;
  if (preferences.sourceMode === 'auto') {
    const associated = associatedCurrency(snapshot.element);
    if (associated && associated !== 'unknown') return associated;
    if (associated !== 'unknown') {
      const metadata = metadataCurrencies(snapshot.element.ownerDocument);
      const detected = uniqueCurrency(metadata.size ? metadata : pageLabels());
      if (detected) return detected;
    }
  }
  return preferences.source;
}
