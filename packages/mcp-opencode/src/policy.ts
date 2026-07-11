import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Roots allowlist
 * ----------------
 * OPENCODE_MCP_ROOTS is a colon-separated list of directories. A cwd passed to
 * a tool call must resolve (via fs.realpath, so symlinks are followed) to a
 * path inside one of these roots (also realpath'd). Default: $HOME/Projects.
 */
export function getConfiguredRoots(): string[] {
  const raw = process.env.OPENCODE_MCP_ROOTS;
  if (raw && raw.trim().length > 0) {
    return raw
      .split(":")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  return [path.join(homedir(), "Projects")];
}

/**
 * provider/model — the model path may itself contain slashes, e.g.
 * `fireworks-ai/accounts/fireworks/models/glm-5p2`. Shape guard only; real
 * validation is the runtime ProviderModelNotFoundError.
 */
export const MODEL_RE = /^[\w.-]+\/[\w./@:+-]+$/;
export const SESSION_RE = /^ses_[A-Za-z0-9]+$/;

export interface CwdValidationResult {
  ok: boolean;
  resolved?: string;
  error?: string;
}

/**
 * Validate that `cwd` is inside one of the allowed roots. Both the roots and
 * the candidate cwd are resolved with fs.realpath so that symlink escapes are
 * caught (e.g. a symlink inside an allowed root pointing outside of it). A
 * cwd must also be a directory because it will be passed as the child process
 * cwd.
 *
 * Residual TOCTOU: the realpath'd string is handed to spawn, so a path component
 * swapped to an out-of-root symlink between this check and spawn could escape.
 * That requires write access to a component of an allowed root, i.e. a same-user
 * local actor -- the same trust boundary that could invoke this MCP server
 * directly -- so it is an accepted limitation rather than a closed hole.
 */
export async function validateCwd(cwd: string): Promise<CwdValidationResult> {
  const roots = getConfiguredRoots();

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
  for (const root of roots) {
    try {
      resolvedRoots.push(await realpath(root));
    } catch {
      // Root itself doesn't exist on disk; skip it as a valid allowlist entry.
    }
  }

  if (resolvedRoots.length === 0) {
    return {
      ok: false,
      error: `no configured root directories exist on disk (OPENCODE_MCP_ROOTS=${roots.join(":")})`,
    };
  }

  const inside = resolvedRoots.some((root) => {
    if (resolvedCwd === root) return true;
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    return resolvedCwd.startsWith(withSep);
  });

  if (!inside) {
    return {
      ok: false,
      error: `cwd "${cwd}" (resolved: ${resolvedCwd}) is outside the allowed roots: ${resolvedRoots.join(", ")}. Set OPENCODE_MCP_ROOTS to widen access.`,
    };
  }

  return { ok: true, resolved: resolvedCwd };
}

const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redaction
 * ----------------
 * Strip obvious secrets out of any text we might echo back (stderr tails,
 * error messages, etc). Provider-agnostic: this server passes an arbitrary
 * provider/model string through to opencode, so the patterns below cover
 * generic credential shapes (PEM keys, AWS/GitHub tokens, bearer/auth headers,
 * key=value assignments) rather than any single provider's key format.
 */
const REDACTION_PATTERNS: RegExp[] = [
  // PEM private-key blocks (RSA/EC/OPENSSH/etc.) -- redact the whole block.
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  // Bearer/base64 tokens include + / = ~; stopping short of them leaks the tail.
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // AWS access key IDs (AKIA/ASIA/AGPA/...) and GitHub tokens.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi,
  // Assignment forms; the value may be quoted and contain spaces.
  /\b(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"']+)/gi,
];

export function redact(text: string): string {
  let out = stripAnsi(text);
  for (const pattern of REDACTION_PATTERNS) {
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
  return out;
}

export function boundText(text: string, cap = 12_000): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap / 2);
  const tail = cap - head;
  return `${text.slice(0, head)}\n…[diagnostic truncated]…\n${text.slice(-tail)}`;
}

/**
 * Permissions
 * ----------------
 * SPEC DEVIATION (documented, per the spec's own contingency clause):
 *
 * The spec's primary plan was to generate a temp opencode config JSON with a
 * `permission` block and pass it via the OPENCODE_CONFIG env var. Live testing
 * (see README "Permission model") showed that supplying *any* custom
 * `permission` config via OPENCODE_CONFIG causes `opencode run` to hang
 * indefinitely in this non-TTY environment — reproduced twice, with both an
 * object-shaped permission block and a bare `"permission": "allow"` action
 * config. This is presumably an `ask` prompt with no TTY to answer it, on some
 * permission category the config implicitly touches.
 *
 * Per the spec's stated CONTINGENCY, we do not use OPENCODE_CONFIG at all.
 * Instead:
 *   - By default (no config, no --auto) we rely on opencode's own built-in
 *     agent-level defaults, which were verified live to behave safely:
 *       - agent=build: edit/bash/webfetch tool calls are allowed and complete
 *         without any prompt or hang.
 *       - agent=plan: edits are refused by the agent itself (it explains it's
 *         in read-only "Plan Mode") -- no permission prompt, no hang.
 *   - Only if the caller explicitly opts in via OPENCODE_MCP_ALLOW_AUTO=1 AND
 *     agent === 'build' do we additionally pass `--auto` (auto-approve
 *     permissions not explicitly denied). This is off by default because
 *     --auto is documented by the CLI itself as "dangerous".
 */
export function extraPermissionArgs(agent: "build" | "plan"): string[] {
  if (agent === "build" && process.env.OPENCODE_MCP_ALLOW_AUTO === "1") {
    return ["--auto"];
  }
  return [];
}

/**
 * Result emptiness decision
 * ----------------
 * On a clean (exit 0) run, decide whether the result is genuinely empty. A
 * build run can legitimately edit files and emit no final text event (the known
 * missing-step_finish upstream bug), so on-disk changes count as a real result.
 */
export function isEmptyResult(args: {
  hasText: boolean;
  hasError: boolean;
  hasChanges: boolean;
}): boolean {
  return !args.hasText && !args.hasError && !args.hasChanges;
}

/**
 * Error classification
 * ----------------
 * Best-effort decoration of failures based on stderr content. Never the sole
 * mechanism for detecting failure -- exit code is authoritative.
 */
export function classifyError(stderr: string, model: string): string | undefined {
  if (/ProviderModelNotFoundError/.test(stderr)) {
    return `Model not found: ${model}. Run opencode_models to list available models.`;
  }
  if (/unauthorized|401|credential|auth/i.test(stderr)) {
    return "Provider not authenticated. Run `opencode auth login` for this provider.";
  }
  return undefined;
}
