import { CONVERTER_UI } from './selection';

const dismissals = new WeakMap<Document, () => void>();
export function clearSelectionNotice(document: Document): void { dismissals.get(document)?.(); }

export function selectionNotice(document: Document, text: string): void {
  clearSelectionNotice(document);
  const notice = document.createElement('div');
  notice.setAttribute(CONVERTER_UI, '');
  notice.setAttribute('data-pc-notice', '');
  notice.setAttribute('role', 'alert');
  const message = document.createElement('span');
  message.textContent = text;
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = 'Dismiss';
  const dismiss = () => { notice.remove(); document.removeEventListener('keydown', escape); dismissals.delete(document); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', escape);
  dismissals.set(document, dismiss);
  notice.append(message, close);
  document.documentElement.append(notice);
}
