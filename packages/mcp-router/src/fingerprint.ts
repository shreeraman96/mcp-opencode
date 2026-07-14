import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const MAX_UNTRACKED_FILES = 5_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface Fingerprint {
  readonly gitTracked: boolean;
  readonly reliable: boolean;
  readonly value: string;
}

interface GitOutput {
  readonly output: Buffer;
  readonly digest: Buffer;
  readonly reliable: boolean;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  expectedNonZeroExit = false,
): Promise<GitOutput> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const outputHash = createHash("sha256");
    let timedOut = false;
    let spawnError = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    timer.unref();
    const stdout = child.stdout;
    if (stdout === null) {
      spawnError = true;
    } else {
      stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        outputHash.update(chunk);
      });
    }
    child.once("error", () => {
      spawnError = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      resolve({
        output,
        digest: outputHash.digest(),
        reliable: !timedOut && !spawnError && (code === 0 || (expectedNonZeroExit && code === 1)),
      });
    });
  });
}

function addPart(hash: ReturnType<typeof createHash>, value: Buffer): void {
  // Length-prefixing keeps adjacent fields unambiguous while retaining a
  // deterministic byte concatenation for the overall digest.
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}

async function hashFile(cwd: string, relativePath: string): Promise<string> {
  let file;
  try {
    file = await stat(join(cwd, relativePath));
  } catch {
    return "<unreadable>";
  }
  const markerSuffix = `${file.size}:${file.mtimeMs}`;
  if (file.size > MAX_FILE_BYTES) return `<oversized:${markerSuffix}>`;
  try {
    return createHash("sha256").update(await readFile(join(cwd, relativePath))).digest("hex");
  } catch {
    return `<unreadable:${markerSuffix}>`;
  }
}

export async function computeFingerprint(cwd: string): Promise<Fingerprint> {
  const workTreeCheck = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!workTreeCheck.reliable || workTreeCheck.output.toString("utf8").trim() !== "true") {
    return { gitTracked: false, reliable: true, value: "" };
  }

  const [status, unstaged, staged, head, branch, origHead, untracked] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v1", "-z"]),
    runGit(cwd, ["diff", "--binary"]),
    runGit(cwd, ["diff", "--cached", "--binary"]),
    // `-q --verify` so an UNBORN HEAD (fresh repo, no commits) exits 1 with
    // empty output -- a reliable "no HEAD yet" dimension -- instead of the
    // bare `rev-parse HEAD` which exits 128 and would mark the whole
    // fingerprint unreliable (blocking all fallback before the first commit).
    runGit(cwd, ["rev-parse", "-q", "--verify", "HEAD"], true),
    runGit(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], true),
    runGit(cwd, ["rev-parse", "-q", "--verify", "ORIG_HEAD"], true),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const reliable = [status, unstaged, staged, head, branch, origHead, untracked].every(
    (result) => result.reliable,
  );

  const allPaths = untracked.output
    .toString("utf8")
    .split("\0")
    .filter((path): path is string => path.length > 0);
  // Edits to a specific untracked file beyond index 5000 can remain undetected
  // if they do not change the file set; this is an accepted pathological bound.
  const paths = allPaths.slice(0, MAX_UNTRACKED_FILES);
  const filePairs = await Promise.all(
    paths.map(async (path): Promise<string> => `${path}\0${await hashFile(cwd, path)}`),
  );
  filePairs.sort();

  const digest = createHash("sha256");
  for (const result of [status, unstaged, staged, head, branch, origHead]) addPart(digest, result.digest);
  addPart(digest, Buffer.from(`untracked-count:${allPaths.length}`, "utf8"));
  for (const pair of filePairs) addPart(digest, Buffer.from(pair, "utf8"));
  return { gitTracked: true, reliable, value: digest.digest("hex") };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export async function settleFingerprint(
  cwd: string,
  opts: { readonly stabilityMs: number; readonly maxWaitMs: number },
): Promise<{ settled: boolean; fingerprint: Fingerprint }> {
  // Core's process-group killer resolves on a 5s timer, not on confirmed
  // child death. Detached tool grandchildren can therefore keep writing after
  // the backend resolves, while core does not expose the group id to poll.
  // Prove quiescence backend-agnostically with a quiet, byte-identical window.
  // If it never stabilizes, refuse to certify the tree; the caller must treat
  // the attempt as terminal.
  const start = Date.now();
  let previous = await computeFingerprint(cwd);
  if (!previous.gitTracked) return { settled: true, fingerprint: previous };
  if (!previous.reliable) return { settled: false, fingerprint: previous };

  const stabilityMs = Math.max(1, Math.floor(opts.stabilityMs));
  while (Date.now() - start < opts.maxWaitMs) {
    await delay(Math.min(stabilityMs, Math.max(0, opts.maxWaitMs - (Date.now() - start))));
    if (Date.now() - start >= opts.maxWaitMs) break;
    const next = await computeFingerprint(cwd);
    if (!next.reliable) return { settled: false, fingerprint: next };
    if (fingerprintsEqual(previous, next)) return { settled: true, fingerprint: next };
    previous = next;
  }
  return { settled: false, fingerprint: previous };
}

export function fingerprintsEqual(a: Fingerprint, b: Fingerprint): boolean {
  return a.reliable && b.reliable && a.gitTracked === b.gitTracked && a.value === b.value;
}
