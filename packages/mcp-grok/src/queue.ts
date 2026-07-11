/** Per-resolved-cwd serialization without blocking unrelated working trees. */
export class CwdQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return current;
  }
}
