import { describe, expect, it } from "vitest";
import { CwdQueue } from "../src/queue.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Grok CwdQueue", () => {
  it("serializes same-cwd work in submission order", async () => {
    const queue = new CwdQueue();
    const order: number[] = [];
    const first = queue.run("/same", async () => {
      await delay(25);
      order.push(1);
    });
    const second = queue.run("/same", async () => {
      order.push(2);
    });
    const third = queue.run("/same", async () => {
      order.push(3);
    });

    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("runs different cwds concurrently", async () => {
    const queue = new CwdQueue();
    const events: string[] = [];
    const slow = queue.run("/a", async () => {
      events.push("a-start");
      await delay(45);
      events.push("a-end");
    });
    const fast = queue.run("/b", async () => {
      events.push("b-start");
      await delay(5);
      events.push("b-end");
    });

    await Promise.all([slow, fast]);
    expect(events.slice(0, 2)).toEqual(["a-start", "b-start"]);
    expect(events.indexOf("b-end")).toBeLessThan(events.indexOf("a-end"));
  });

  it("does not wedge a key after a rejected task", async () => {
    const queue = new CwdQueue();
    const order: string[] = [];
    const first = queue
      .run("/same", async () => {
        order.push("first");
        throw new Error("boom");
      })
      .catch(() => order.push("caught"));
    const second = queue.run("/same", async () => order.push("second"));

    await Promise.all([first, second]);
    expect(order).toEqual(["first", "caught", "second"]);
  });
});
