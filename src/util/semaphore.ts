import { ToolError } from "./errors.js";

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Bounded concurrency with a bounded queue. Beyond `maxQueued` callers are
 * rejected immediately ("busy") instead of piling up in memory; a queued
 * caller whose signal aborts leaves the queue.
 */
export class Semaphore {
  private running = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly max: number,
    private readonly maxQueued: number,
  ) {}

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new ToolError("Сервер зайнятий, повторіть запит пізніше."));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          reject(signal.reason as Error);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.running--;
      return;
    }
    if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
    next.resolve();
  }
}
