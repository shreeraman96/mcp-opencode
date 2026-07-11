/** Per-resolved-cwd serialization without blocking unrelated working trees. */
export class CwdQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `task` serialized against any other call queued under the same `key`
   * (expected to be a canonical/realpath'd cwd). Different keys run in
   * parallel with no cross-blocking. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Swallow the prior job's rejection in the chain so one failed call doesn't
    // wedge later calls on the same key; the real result/error still propagates
    // to the caller via `current`.
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    // Drop the entry once this is the last queued job for the key, so a
    // long-lived server touching many distinct cwds does not leak Map entries.
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return current;
  }
}
