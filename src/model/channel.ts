/**
 * A queue that one side pushes into and the other reads as an async
 * iterable; `fail` ends it with an error, `end` ends it cleanly.
 */
export class Channel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #rejectWaiting: ((error: unknown) => void) | undefined;
  #ended = false;
  #error: { error: Error } | undefined;

  push(item: T): void {
    if (this.#ended) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#clearWaiting();
      waiting({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const waiting = this.#waiting;
    if (waiting && this.#items.length === 0) {
      this.#clearWaiting();
      waiting({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = { error };
    const reject = this.#rejectWaiting;
    if (reject && this.#items.length === 0) {
      this.#clearWaiting();
      reject(error);
    }
  }

  get ended(): boolean {
    return this.#ended;
  }

  #clearWaiting(): void {
    this.#waiting = undefined;
    this.#rejectWaiting = undefined;
  }

  #next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#error) return Promise.reject(this.#error.error);
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiting = resolve;
      this.#rejectWaiting = reject;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.#next() };
  }
}
