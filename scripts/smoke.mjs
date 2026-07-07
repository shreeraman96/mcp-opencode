#!/usr/bin/env node
// Live smoke test against the real opencode CLI. Not run in CI; run manually
// or via `npm run smoke`. Exercises the actual spawn/parse/policy path
// end-to-end using a free opencode-zen model.
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

process.env.OPENCODE_MCP_ROOTS = process.env.OPENCODE_MCP_ROOTS || path.join(homedir(), "Projects");

const { runOpencode } = await import("../dist/run.js");
const { validateCwd } = await import("../dist/policy.js");

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function main() {
  const smokeRoot = path.join(homedir(), "Projects", "mcp-opencode", ".smoke");
  mkdirSync(smokeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(smokeRoot, "run-"));
  console.log(`smoke workdir: ${dir}`);

  const validation = await validateCwd(dir);
  assert(validation.ok, "smoke workdir passes roots validation");

  console.log("\n--- smoke 1: opencode_run-equivalent happy path ---");
  const outcome = await runOpencode({
    model: "opencode/big-pickle",
    cwd: validation.resolved ?? dir,
    agent: "build",
    prompt: "Create a file hello.txt containing exactly: hi",
    timeoutSec: 120,
  });

  console.log(`reason=${outcome.reason} exitCode=${outcome.exitCode} elapsed=${outcome.elapsedSec.toFixed(1)}s`);
  console.log(`sessionID=${outcome.parsed.sessionID}`);
  console.log(`text=${JSON.stringify(outcome.parsed.text).slice(0, 300)}`);

  assert(outcome.reason === "exit", "run 1 settled via normal exit");
  assert(outcome.exitCode === 0, "run 1 exited 0");
  assert(!!outcome.parsed.sessionID, "run 1 captured a sessionID");

  const helloPath = path.join(dir, "hello.txt");
  const created = existsSync(helloPath);
  assert(created, "run 1 created hello.txt");
  if (created) {
    const content = readFileSync(helloPath, "utf8").trim();
    assert(content === "hi", `hello.txt content is exactly "hi" (got ${JSON.stringify(content)})`);
  }

  console.log("\n--- smoke 2: bad model classification ---");
  const badOutcome = await runOpencode({
    model: "nonexistent/fake",
    cwd: validation.resolved ?? dir,
    agent: "build",
    prompt: "irrelevant",
    timeoutSec: 60,
  });
  console.log(`reason=${badOutcome.reason} exitCode=${badOutcome.exitCode}`);
  console.log(`stderrTail=${badOutcome.stderrTail.slice(0, 500)}`);
  assert(badOutcome.reason === "exit", "run 2 (bad model) settled via normal exit, not hang/timeout");
  assert(badOutcome.exitCode !== 0, "run 2 (bad model) exited non-zero");
  assert(
    /ProviderModelNotFoundError/.test(badOutcome.stderrTail),
    "run 2 stderr contains ProviderModelNotFoundError for classification",
  );

  rmSync(dir, { recursive: true, force: true });

  console.log(process.exitCode === 1 ? "\nSMOKE: FAILED" : "\nSMOKE: PASSED");
}

await main();
