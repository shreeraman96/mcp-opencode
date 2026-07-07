/**
 * Per-key mutex implemented as a simple promise chain. Calls queued under the
 * same key run strictly one after another; different keys run concurrently.
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Swallow rejections in the chain itself so one failed call doesn't wedge
    // the queue for calls behind it; the real result/error still propagates
    // to the caller via `result`.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class CwdQueue {
  private readonly mutexes = new Map<string, Mutex>();

  /** Run `fn` serialized against any other call queued under the same `key`
   * (expected to be a canonical/realpath'd cwd). Different keys run in
   * parallel with no cross-blocking. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(key, mutex);
    }
    return mutex.run(fn);
  }
}
