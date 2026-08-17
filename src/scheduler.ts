interface QueueItem<T> {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
}

export class RequestScheduler {
  readonly #maxConcurrency: number;
  readonly #minIntervalMs: number;
  readonly #queue: Array<QueueItem<unknown>> = [];
  #active = 0;
  #lastStartAt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(maxConcurrency: number, minIntervalMs: number) {
    this.#maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
    this.#minIntervalMs = Math.max(0, Math.floor(minIntervalMs));
  }

  public schedule<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = { task, resolve, reject };
      if (signal) item.signal = signal;
      this.#queue.push(item as QueueItem<unknown>);
      this.#drain();
    });
  }

  public get active(): number {
    return this.#active;
  }

  public get pending(): number {
    return this.#queue.length;
  }

  #drain(): void {
    if (this.#timer !== null) return;
    while (this.#active < this.#maxConcurrency && this.#queue.length > 0) {
      const waitMs = Math.max(0, this.#lastStartAt + this.#minIntervalMs - Date.now());
      if (waitMs > 0) {
        this.#timer = setTimeout(() => {
          this.#timer = null;
          this.#drain();
        }, waitMs);
        return;
      }

      const item = this.#queue.shift();
      if (!item) return;
      if (item.signal?.aborted) {
        item.reject(item.signal.reason ?? new Error("Aborted"));
        continue;
      }

      this.#active += 1;
      this.#lastStartAt = Date.now();
      void item
        .task()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.#active -= 1;
          this.#drain();
        });
    }
  }
}
