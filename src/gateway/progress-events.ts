/**
 * Coalesces progress notifications to one event per interval while preserving
 * an immediate terminal delivery. Event payloads stay empty; this only bounds
 * broadcast frequency, not the measured snapshot.
 */
export class ProgressEventCoalescer {
  readonly #emit: () => void;
  readonly #intervalMs: number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending = false;
  #lastEmit = 0;

  constructor(emit: () => void, intervalMs = 250, now: () => number = () => Date.now()) {
    this.#emit = emit;
    this.#intervalMs = intervalMs;
    this.#now = now;
  }

  notify(terminal = false): void {
    this.#pending = true;
    if (terminal) {
      this.#flush();
      return;
    }
    const elapsed = this.#now() - this.#lastEmit;
    if (elapsed >= this.#intervalMs) {
      this.#flush();
      return;
    }
    if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#flush();
      }, Math.max(0, this.#intervalMs - elapsed));
      (this.#timer as { unref?: () => void }).unref?.();
    }
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = false;
  }

  #flush(): void {
    if (!this.#pending) return;
    this.#pending = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#lastEmit = this.#now();
    this.#emit();
  }
}
