export interface Deadline {
  readonly startMs: number;
  readonly totalSec: number;
  remainingSec(nowMs: number): number;
  expired(nowMs: number): boolean;
}

export function createDeadline(totalSec: number, startMs: number): Deadline {
  return {
    startMs,
    totalSec,
    remainingSec(nowMs: number): number {
      return Math.max(0, totalSec - (nowMs - startMs) / 1000);
    },
    expired(nowMs: number): boolean {
      return totalSec - (nowMs - startMs) / 1000 <= 0;
    },
  };
}

export function attemptBudgetSec(args: {
  remainingSec: number;
  hasNextEntry: boolean;
  backendMinSec: number;
  cleanupReserveSec: number;
  minViableNextSec: number;
}): number | null {
  let base = args.remainingSec - args.cleanupReserveSec;
  if (args.hasNextEntry) base -= args.minViableNextSec;

  // Reserve cleanup (including fingerprint settling) and the next attempt
  // before flooring: downstream runners require an integer timeout, and
  // flooring prevents spending fractional seconds that are not available.
  const budget = Math.floor(base);
  return budget < args.backendMinSec ? null : budget;
}
