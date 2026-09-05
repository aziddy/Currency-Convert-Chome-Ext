import { backgroundRequest, type BackgroundRequest } from '../shared/types';

export type NotesRequest = Extract<BackgroundRequest, { type: 'GET_NOTES' | 'SAVE_NOTES' }>;
type NotesRequester = (request: NotesRequest) => Promise<unknown>;
interface NotesElements {
  textarea: HTMLTextAreaElement;
  status: HTMLElement;
  retry: HTMLButtonElement;
}

export function createNotesEditor(elements: NotesElements, request: NotesRequester = backgroundRequest): {
  ready: Promise<void>;
  dispose(): void;
} {
  const { textarea, status, retry } = elements;
  let loaded = false;
  let disposed = false;
  let revision = 0;

  function show(text: string, failed = false): void {
    if (status.textContent !== text) status.textContent = text;
    status.dataset.kind = failed ? 'error' : 'info';
    retry.hidden = !failed;
  }

  async function load(): Promise<void> {
    const current = ++revision;
    textarea.disabled = true;
    show('Loading notes…');
    try {
      const saved = await request({ type: 'GET_NOTES' });
      if (disposed || current !== revision) return;
      if (typeof saved !== 'string') throw new Error('Invalid saved notes.');
      textarea.value = saved;
      loaded = true;
      textarea.disabled = false;
      show('Saved');
    } catch {
      if (!disposed && current === revision) show('Could not load notes.', true);
    }
  }

  async function save(): Promise<void> {
    if (!loaded || disposed) return;
    const current = ++revision;
    show('Saving…');
    try {
      // Submit on every input. The background worker owns the write queue, so closing
      // this popup does not discard a pending debounce or popup-local queued edit.
      await request({ type: 'SAVE_NOTES', text: textarea.value });
      if (!disposed && current === revision) show('Saved');
    } catch {
      if (!disposed && current === revision) show('Could not save notes. Keep this popup open and retry.', true);
    }
  }

  const onInput = () => { void save(); };
  const onRetry = () => { void (loaded ? save() : load()); };
  textarea.addEventListener('input', onInput);
  retry.addEventListener('click', onRetry);
  return {
    ready: load(),
    dispose() {
      disposed = true;
      revision++;
      textarea.removeEventListener('input', onInput);
      retry.removeEventListener('click', onRetry);
    },
  };
}
