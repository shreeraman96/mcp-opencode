import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_TIMEOUT_SEC = 900;
export const DEFAULT_MAX_TURNS = 8;
export const MIN_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 3600;
export const MAX_TURNS = 100;

/** Colon-separated roots allowed for Grok tool calls. */
export function getConfiguredRoots(): string[] {
  const raw = process.env.GROK_MCP_ROOTS;
  if (raw && raw.trim().length > 0) {
    return raw
      .split(":")
      .map((root) => root.trim())
      .filter((root) => root.length > 0);
  }
  return [path.join(homedir(), "Projects")];
}

/** Grok model IDs are simple names in addition to namespaced IDs. */
export const MODEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:+@/-]*[A-Za-z0-9])?$/;

/** Grok Build session IDs observed in v0.2.93 are canonical UUIDv4 values. */
export const SESSION_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CwdValidationResult {
  ok: boolean;
  resolved?: string;
  error?: string;
}

/**
 * Resolve both sides of the roots check so a symlink inside an allowed root
 * cannot escape it. A cwd must also be a directory because it will be passed
 * as the child process cwd.
 *
 * Residual TOCTOU: the realpath'd string is handed to spawn, so a path component
 * swapped to an out-of-root symlink between this check and spawn could escape.
 * That requires write access to a component of an allowed root, i.e. a same-user
 * local actor -- the same trust boundary that could invoke this MCP server
 * directly -- so it is an accepted limitation rather than a closed hole.
 */
export async function validateCwd(cwd: string): Promise<CwdValidationResult> {
  const configuredRoots = getConfiguredRoots();
  let resolvedCwd: string;

  try {
    resolvedCwd = await realpath(cwd);
    if (!(await stat(resolvedCwd)).isDirectory()) {
      return { ok: false, error: `cwd is not a directory: ${cwd}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: `cwd does not exist or is not accessible: ${cwd} (${(err as Error).message})`,
    };
  }

  const resolvedRoots: string[] = [];
  for (const root of configuredRoots) {
    try {
      if ((await stat(root)).isDirectory()) {
        resolvedRoots.push(await realpath(root));
      }
    } catch {
      // A missing configured root cannot authorize a request.
    }
  }

  if (resolvedRoots.length === 0) {
    return {
      ok: false,
      error: `no configured root directories exist on disk (GROK_MCP_ROOTS=${configuredRoots.join(":")})`,
    };
  }

  const inside = resolvedRoots.some((root) => {
    if (resolvedCwd === root) return true;
    const withSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return resolvedCwd.startsWith(withSeparator);
  });

  if (!inside) {
    return {
      ok: false,
      error: `cwd "${cwd}" (resolved: ${resolvedCwd}) is outside the allowed roots: ${resolvedRoots.join(", ")}. Set GROK_MCP_ROOTS to widen access.`,
    };
  }

  return { ok: true, resolved: resolvedCwd };
}

const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact credentials and sensitive local paths before returning diagnostics.
 * The patterns cover xAI/Grok key shapes plus the obvious generic forms used
 * by CLIs. This is intentionally applied to stderr, parser error events, and
 * assistant text returned by the MCP adapter.
 */
export function redact(text: string): string {
  let out = stripAnsi(text);

  const patterns: RegExp[] = [
    // PEM private-key blocks (RSA/EC/OPENSSH/etc.) -- redact the whole block.
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    /\bxai[-_][A-Za-z0-9._-]{8,}\b/gi,
    /\b(?:xai|grok)[-_](?:api[_-]?key|token|secret|key)[-_]?[A-Za-z0-9._-]{8,}\b/gi,
    /\bgrok_[A-Za-z0-9._-]{16,}\b/gi,
    /\b(?:sk|sk-proj)-[A-Za-z0-9_-]{8,}\b/g,
    // AWS access key IDs (AKIA/ASIA/AGPA/...) and GitHub tokens.
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{12,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    /(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi,
    /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret)=)[^&\s]+/gi,
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,
  ];

  for (const pattern of patterns) {
    if (pattern.source.startsWith("(")) {
      out = out.replace(pattern, "$1[REDACTED]");
    } else {
      out = out.replace(pattern, "[REDACTED]");
    }
  }

  const home = homedir();
  if (home.length > 1) {
    out = out.replace(new RegExp(escapeRegExp(home), "g"), "~");
  }
  out = out.replace(
    /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.grok\/sessions\/[^\s"')]+/g,
    "~/.grok/sessions/[REDACTED]",
  );
  out = out.replace(
    /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.grok\/(?!sessions\/)[^\s"')]+/g,
    "~/.grok/[REDACTED]",
  );
  return out;
}

export function boundText(text: string, cap = 12_000): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap / 2);
  const tail = cap - head;
  return `${text.slice(0, head)}\n…[diagnostic truncated]…\n${text.slice(-tail)}`;
}

export function validateTimeoutSec(timeoutSec: number): void {
  if (!Number.isInteger(timeoutSec) || timeoutSec < MIN_TIMEOUT_SEC || timeoutSec > MAX_TIMEOUT_SEC) {
    throw new RangeError(`timeoutSec must be an integer from ${MIN_TIMEOUT_SEC} to ${MAX_TIMEOUT_SEC}`);
  }
}

export function validateMaxTurns(maxTurns: number): void {
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURNS) {
    throw new RangeError(`maxTurns must be an integer from 1 to ${MAX_TURNS}`);
  }
}

export function isEmptyResult(args: {
  hasText: boolean;
  hasError: boolean;
  hasChanges: boolean;
}): boolean {
  return !args.hasText && !args.hasError && !args.hasChanges;
}

/** Convert safely observable Grok failures into actionable MCP errors. */
export function classifyError(diagnostic: string, model: string): string | undefined {
  // Only a spawn-level ENOENT means the `grok` binary is missing. A bare ENOENT
  // in the diagnostic is usually a file the agent's own tooling could not open,
  // which must not be reported as "CLI not found".
  if (/spawn\s+grok\s+ENOENT|grok(?: build)? cli[^\n]*not found|\bcommand not found:\s*grok\b/i.test(diagnostic)) {
    return "Grok CLI not found on PATH. Install Grok Build CLI and ensure `grok` is available.";
  }
  if (
    /No auth credentials for cli-chat-proxy|auth\.x\.ai|not logged in|unauthoriz|authentication|credential|\b401\b|api key/i.test(
      diagnostic,
    )
  ) {
    return "Grok authentication is unavailable. Run `grok login` (or configure the CLI credentials), then retry.";
  }
  if (
    /model[^\n]*(?:not found|unknown|unavailable|invalid)|not in available models|no auth-visible selectable model|model_id/i.test(
      diagnostic,
    )
  ) {
    return `Grok model not found or unavailable: ${model}. Run grok_models to list available models.`;
  }
  if (/FS_PERMISSION_DENIED|permission denied|operation not permitted/i.test(diagnostic)) {
    return "Grok could not access its session or working directory; verify filesystem permissions and the configured cwd.";
  }
  return undefined;
}
