import { describe, expect, it, vi } from 'vitest';
import { NotesService } from '../../src/background/notes';

function setup(initial?: unknown) {
  let value = initial;
  const storage = { read: vi.fn(async () => value), write: vi.fn(async (text: string) => { value = text; }) };
  return { service: new NotesService(storage), storage };
}

describe('shared notes storage', () => {
  it('defaults to an empty note without writing over storage', async () => {
    const { service, storage } = setup();
    expect(await service.get()).toBe('');
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('preserves whitespace, newlines, Unicode and clearing', async () => {
    const { service } = setup();
    const text = '  Budget: $100\nCafé ☕\n\n';
    await service.save(text); expect(await service.get()).toBe(text);
    await service.save(''); expect(await service.get()).toBe('');
  });

  it('serializes rapid saves and waits for them before reading', async () => {
    const { service, storage } = setup();
    let release!: () => void;
    storage.write.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = service.save('a');
    const second = service.save('ab');
    const third = service.save('abc');
    const read = service.get();
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledTimes(1));
    expect(storage.read).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second, third]);
    expect(storage.write.mock.calls).toEqual([['a'], ['ab'], ['abc']]);
    expect(await read).toBe('abc');
  });

  it('reports failed writes, keeps the previous note, and allows retry', async () => {
    const { service, storage } = setup('previous');
    storage.write.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(service.save('draft')).rejects.toThrow('quota exceeded');
    expect(await service.get()).toBe('previous');
    await service.save('draft'); expect(await service.get()).toBe('draft');
  });

  it('reports failed reads and does not erase existing notes', async () => {
    const { service, storage } = setup('previous');
    storage.read.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(service.get()).rejects.toThrow('storage unavailable');
    expect(await service.get()).toBe('previous');
    expect(storage.write).not.toHaveBeenCalled();
  });

  it.each([null, 42, {}, ['note']])('rejects invalid note data: %s', async value => {
    const { service, storage } = setup(value);
    await expect(service.get()).rejects.toThrow('could not be read');
    await expect(service.save(value)).rejects.toThrow('plain text');
    expect(storage.write).not.toHaveBeenCalled();
  });
});
