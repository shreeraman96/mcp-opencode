// Best-effort model discovery for the wizard's pick-list. IMPORTANT: this
// output is UNTRUSTED. A backend CLI's stdout is not a security boundary --
// treat it like any other external input, sanitize hard, and never let it
// drive anything but a list the user still has to pick from and confirm
// (validateSpec re-checks whatever they end up choosing). Never throws: any
// failure degrades to `{ error }` so the caller can fall back to free text.

import { execFile as execFileCallback, type ExecFileException } from "node:child_process";

import type { SpawnableName } from "../backends/registry.js";

export type ExecFileImpl = (
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFileImpl: ExecFileImpl = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFileCallback(cmd, args, { ...opts, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(error as ExecFileException);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

/** Best-known non-interactive "list models" invocation per backend. Confidence
 * varies by backend (see the exported comment on each entry) — this is a
 * pick-list seed, not an authority, so an outdated or wrong command just
 * degrades to the free-text path rather than corrupting anything. A backend
 * absent from this map has no known list command. */
const LIST_COMMANDS: Partial<Record<SpawnableName, { cmd: string; args: string[] }>> = {
  // High confidence: mirrors packages/mcp-opencode's own `opencode_models` tool.
  opencode: { cmd: "opencode", args: ["models"] },
  // High confidence: mirrors packages/mcp-grok's own `grok_models` tool
  // (minus --leader-socket, which only matters for concurrent grok sessions).
  grok: { cmd: "grok", args: ["--no-auto-update", "models"] },
  // No known non-interactive list command for codex; omitted on purpose so
  // discovery cleanly falls back to free text instead of guessing a command.
};

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BUFFER_BYTES = 1024 * 1024; // 1 MiB cap on child stdout/stderr.
const MAX_MODELS = 200;

// Conservative model-id charset: letters, digits, and the separators real
// model ids use ("provider/model-name.v2:tag"). Anything else in a line is
// untrusted CLI chrome (banners, ANSI-stripped table borders, etc.), not a
// model id, and is dropped rather than guessed at.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;

const CONTROL_OR_ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitizeLine(line: string): string {
  return line.replace(CONTROL_OR_ANSI_RE, "").trim();
}

/**
 * Extract candidate model ids from raw CLI stdout. Strips ANSI/control
 * sequences, splits on lines and whitespace-separated tokens (covers both
 * "one model per line" and simple table output), keeps only tokens matching
 * the conservative model-id charset, dedupes, and caps to MAX_MODELS.
 */
function extractModelIds(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = sanitizeLine(rawLine);
    if (line.length === 0) continue;
    for (const token of line.split(/\s+/)) {
      if (!MODEL_ID_RE.test(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(token);
      if (out.length >= MAX_MODELS) return out;
    }
  }
  return out;
}

export async function discoverModels(
  backend: SpawnableName,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; execFileImpl?: ExecFileImpl } = {},
): Promise<{ models: string[] } | { error: string }> {
  const known = LIST_COMMANDS[backend];
  if (!known) return { error: `no known model-list command for '${backend}'` };

  const execFileImpl = opts.execFileImpl ?? defaultExecFileImpl;
  // Controlled/empty-ish env: enough for the CLI to find itself (PATH/HOME) but
  // nothing else — discovery must not hand ambient secrets to a child whose
  // output we then treat as hostile anyway.
  const env: NodeJS.ProcessEnv = opts.env ?? {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  };

  try {
    const { stdout } = await execFileImpl(known.cmd, known.args, {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env,
    });
    const models = extractModelIds(stdout);
    if (models.length === 0) return { error: `'${known.cmd} ${known.args.join(" ")}' returned no parseable model ids` };
    return { models };
  } catch (error) {
    return { error: `failed to list ${backend} models: ${(error as Error).message ?? String(error)}` };
  }
}
