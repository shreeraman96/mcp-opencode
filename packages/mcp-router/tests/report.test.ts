import { describe, it, expect } from "vitest";

import { coarseReason, formatRouteResult } from "../src/report.js";
import type { RouteResult } from "../src/types.js";

describe("coarseReason", () => {
  it("collapses capacity/auth/transport into unavailable", () => {
    expect(coarseReason("capacity")).toBe("unavailable");
    expect(coarseReason("auth")).toBe("unavailable");
    expect(coarseReason("transport")).toBe("unavailable");
  });

  it("maps timeout and empty 1:1", () => {
    expect(coarseReason("timeout")).toBe("timeout");
    expect(coarseReason("empty")).toBe("empty");
  });

  it("maps undefined to ok", () => {
    expect(coarseReason(undefined)).toBe("ok");
  });

  it("aborted and notInstalled flags take precedence", () => {
    expect(coarseReason("task", { aborted: true })).toBe("aborted");
    expect(coarseReason("capacity", { notInstalled: true })).toBe("not-installed");
  });
});

describe("formatRouteResult leak boundary", () => {
  it("does not surface provenance (spawn/inferred/stream) in the response text", () => {
    const result: RouteResult = {
      ok: false,
      servedBy: undefined,
      text: "partial output",
      trace: [
        {
          entry: "standard",
          reason: "not-installed",
          provenance: "spawn",
          elapsedSec: 0.2,
          editedTree: false,
        },
      ],
    };

    const body = formatRouteResult(result);

    expect(body).not.toContain("spawn");
    expect(body).not.toContain("inferred");
    expect(body).not.toContain("stream");
    expect(body).toContain("attempt: standard · not-installed");
    expect(body).toContain("editedTree=false");
  });

  it("renders an unmeasured (undefined) editedTree as \"unknown\", not \"undefined\"", () => {
    const result: RouteResult = {
      ok: true,
      servedBy: { name: "standard", cooldownKey: "k", backend: "opencode", provider: "prov", model: "prov/m", advisory: false },
      text: "ok",
      trace: [{ entry: "standard", reason: "ok", provenance: "exit", elapsedSec: 1.2, editedTree: undefined }],
    };

    const body = formatRouteResult(result);

    expect(body).toContain("editedTree=unknown");
    expect(body).not.toContain("editedTree=undefined");
  });
});
