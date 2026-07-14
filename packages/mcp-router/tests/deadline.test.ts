import { describe, it, expect } from "vitest";

import { createDeadline, attemptBudgetSec } from "../src/deadline.js";

describe("createDeadline", () => {
  it("remainingSec tracks elapsed time and clamps at 0 after expiry", () => {
    const d = createDeadline(900, 1000);
    expect(d.remainingSec(1000)).toBe(900);
    expect(d.remainingSec(1000 + 450_000)).toBe(450);
    expect(d.remainingSec(1000 + 900_000)).toBe(0);
    expect(d.remainingSec(1000 + 900_001)).toBe(0);
    expect(d.expired(1000 + 900_000)).toBe(true);
    expect(d.expired(1000 + 900_001)).toBe(true);
    expect(d.expired(1000)).toBe(false);
  });
});

describe("attemptBudgetSec", () => {
  it("with hasNextEntry=false returns floor(remaining - cleanupReserve)", () => {
    const budget = attemptBudgetSec({
      remainingSec: 100.7,
      hasNextEntry: false,
      backendMinSec: 10,
      cleanupReserveSec: 5,
      minViableNextSec: 20,
    });
    expect(budget).toBe(Math.floor(100.7 - 5));
    expect(Number.isInteger(budget)).toBe(true);
  });

  it("with hasNextEntry=true also subtracts minViableNextSec", () => {
    const budget = attemptBudgetSec({
      remainingSec: 100,
      hasNextEntry: true,
      backendMinSec: 10,
      cleanupReserveSec: 5,
      minViableNextSec: 20,
    });
    expect(budget).toBe(Math.floor(100 - 5 - 20));
    expect(Number.isInteger(budget)).toBe(true);
  });

  it("returns an integer budget", () => {
    const budget = attemptBudgetSec({
      remainingSec: 55.9,
      hasNextEntry: false,
      backendMinSec: 1,
      cleanupReserveSec: 0.3,
      minViableNextSec: 0,
    });
    expect(budget).not.toBeNull();
    expect(Number.isInteger(budget)).toBe(true);
  });

  it("returns null when computed budget < backendMinSec", () => {
    const budget = attemptBudgetSec({
      remainingSec: 30,
      hasNextEntry: true,
      backendMinSec: 20,
      cleanupReserveSec: 5,
      minViableNextSec: 10,
    });
    // floor(30 - 5 - 10) = 15 < 20
    expect(budget).toBeNull();
  });
});
