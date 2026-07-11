import { describe, it, expect } from "vitest";
import { CwdQueue } from "../src/queue.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("CwdQueue", () => {
  it("serializes calls under the same key, in submission order", async () => {
    const queue = new CwdQueue();
    const order: number[] = [];

    const p1 = queue.run("/same/cwd", async () => {
      await delay(30);
      order.push(1);
    });
    const p2 = queue.run("/same/cwd", async () => {
      await delay(10);
      order.push(2);
    });
    const p3 = queue.run("/same/cwd", async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs calls under different keys concurrently, not blocking each other", async () => {
    const queue = new CwdQueue();
    const events: string[] = [];

    const slow = queue.run("/cwd/a", async () => {
      events.push("a-start");
      await delay(50);
      events.push("a-end");
    });
    const fast = queue.run("/cwd/b", async () => {
      events.push("b-start");
      await delay(5);
      events.push("b-end");
    });

    await Promise.all([slow, fast]);
    // b should fully finish before a, proving they ran in parallel rather than
    // b waiting behind a in a shared queue.
    expect(events.indexOf("b-end")).toBeLessThan(events.indexOf("a-end"));
    expect(events[0]).toBe("a-start");
    expect(events[1]).toBe("b-start");
  });

  it("continues processing the queue for a key even if an earlier call rejects", async () => {
    const queue = new CwdQueue();
    const order: string[] = [];

    const p1 = queue
      .run("/same/cwd", async () => {
        order.push("first");
        throw new Error("boom");
      })
      .catch(() => {
        order.push("first-caught");
      });

    const p2 = queue.run("/same/cwd", async () => {
      order.push("second");
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(["first", "first-caught", "second"]);
  });
});
