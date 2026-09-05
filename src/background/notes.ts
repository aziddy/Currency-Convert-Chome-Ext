interface NotesStorage {
  read(): Promise<unknown>;
  write(text: string): Promise<void>;
}

export class NotesService {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private storage: NotesStorage) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  get(): Promise<string> {
    return this.serial(async () => {
      const stored = await this.storage.read();
      if (stored === undefined) return '';
      if (typeof stored !== 'string') throw new Error('Saved notes could not be read.');
      return stored;
    });
  }

  async save(text: unknown): Promise<void> {
    if (typeof text !== 'string') throw new Error('Notes must be plain text.');
    await this.serial(() => this.storage.write(text));
  }
}
