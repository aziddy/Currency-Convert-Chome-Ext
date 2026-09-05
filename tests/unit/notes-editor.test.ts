import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotesEditor, type NotesRequest } from '../../src/popup/notes';

let elements: { textarea: HTMLTextAreaElement; status: HTMLParagraphElement; retry: HTMLButtonElement };
let editor: ReturnType<typeof createNotesEditor>;
const request = vi.fn<(request: NotesRequest) => Promise<unknown>>();
function input(value: string): void {
  elements.textarea.value = value;
  elements.textarea.dispatchEvent(new Event('input'));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  document.body.innerHTML = '<textarea></textarea><p></p><button>Retry</button>';
  elements = { textarea: document.querySelector('textarea')!, status: document.querySelector('p')!, retry: document.querySelector('button')! };
  request.mockReset(); request.mockResolvedValue('');
});
afterEach(() => editor?.dispose());

describe('notes editor', () => {
  it('loads before enabling typing and does not save during initialization', async () => {
    const load = deferred<string>(); request.mockReturnValueOnce(load.promise);
    editor = createNotesEditor(elements, request);
    expect(elements.textarea.disabled).toBe(true);
    expect(elements.status.textContent).toBe('Loading notes…');
    load.resolve('Saved note\n☕'); await editor.ready;
    expect(elements.textarea.value).toBe('Saved note\n☕');
    expect(elements.textarea.disabled).toBe(false);
    expect(elements.status.textContent).toBe('Saved');
    expect(elements.retry.hidden).toBe(true);
    expect(request.mock.calls).toEqual([[{ type: 'GET_NOTES' }]]);
  });

  it('submits every edit immediately, including deletion', async () => {
    editor = createNotesEditor(elements, request); await editor.ready;
    input('a'); input('ab\n☕'); input('');
    expect(request.mock.calls.slice(1)).toEqual([
      [{ type: 'SAVE_NOTES', text: 'a' }], [{ type: 'SAVE_NOTES', text: 'ab\n☕' }], [{ type: 'SAVE_NOTES', text: '' }],
    ]);
    expect(elements.status.textContent).toBe('Saving…');
    await vi.waitFor(() => expect(elements.status.textContent).toBe('Saved'));
  });

  it('does not mark newer edits saved when an older request completes', async () => {
    editor = createNotesEditor(elements, request); await editor.ready;
    const older = deferred<null>(), newer = deferred<null>();
    request.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    input('a'); input('ab');
    older.resolve(null); await older.promise;
    expect(elements.status.textContent).toBe('Saving…');
    newer.resolve(null);
    await vi.waitFor(() => expect(elements.status.textContent).toBe('Saved'));
    expect(elements.textarea.value).toBe('ab');
  });

  it('ignores an outdated failure after a newer save succeeds', async () => {
    editor = createNotesEditor(elements, request); await editor.ready;
    const older = deferred<null>();
    request.mockReturnValueOnce(older.promise).mockResolvedValueOnce(null);
    input('a'); input('ab');
    await vi.waitFor(() => expect(elements.status.textContent).toBe('Saved'));
    older.reject(new Error('old write failed'));
    await vi.waitFor(() => expect(elements.retry.hidden).toBe(true));
    expect(elements.status.textContent).toBe('Saved');
  });

  it('keeps a failed save draft and retries without reloading or clearing it', async () => {
    editor = createNotesEditor(elements, request); await editor.ready;
    request.mockRejectedValueOnce(new Error('full'));
    input('Unsaved draft');
    await vi.waitFor(() => expect(elements.retry.hidden).toBe(false));
    expect(elements.status.textContent).toContain('Could not save');
    expect(elements.textarea.value).toBe('Unsaved draft');
    expect(elements.textarea.disabled).toBe(false);
    elements.retry.click();
    await vi.waitFor(() => expect(elements.status.textContent).toBe('Saved'));
    expect(request).toHaveBeenLastCalledWith({ type: 'SAVE_NOTES', text: 'Unsaved draft' });
  });

  it('keeps load failures disabled and retries the read without writing', async () => {
    request.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce('Existing note');
    editor = createNotesEditor(elements, request); await editor.ready;
    expect(elements.status.textContent).toBe('Could not load notes.');
    expect(elements.textarea.disabled).toBe(true);
    expect(elements.retry.hidden).toBe(false);
    elements.retry.click();
    await vi.waitFor(() => expect(elements.textarea.value).toBe('Existing note'));
    expect(request.mock.calls).toEqual([[{ type: 'GET_NOTES' }], [{ type: 'GET_NOTES' }]]);
  });

  it('does not apply a load result after disposal', async () => {
    const pending = deferred<string>(); request.mockReturnValueOnce(pending.promise);
    editor = createNotesEditor(elements, request);
    editor.dispose(); pending.resolve('late'); await editor.ready;
    expect(elements.textarea.value).toBe('');
    expect(elements.textarea.disabled).toBe(true);
  });

  it('has already submitted the latest text when the popup closes', async () => {
    editor = createNotesEditor(elements, request); await editor.ready;
    const save = deferred<null>(); request.mockReturnValueOnce(save.promise);
    input('Last keystroke'); editor.dispose();
    expect(request).toHaveBeenLastCalledWith({ type: 'SAVE_NOTES', text: 'Last keystroke' });
    save.resolve(null); await save.promise;
  });
});
