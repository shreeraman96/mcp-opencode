// Hardened WRITE path for the init wizard. config.ts's readHardenedFile covers
// reads; nothing there covers writing a new config or the pending file this
// module introduces, so every write here gets the same care: no symlink
// follows, atomic same-filesystem rename, fsynced bytes, tight perms, and a
// parent-directory check mirroring config.ts's.

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { readHardenedFile, validateConfigObject } from "../config.js";
import type { RouterConfig, TierName } from "../types.js";
import { CAPABILITIES, TIER_NAMES } from "../types.js";
import type { Entry } from "../types.js";

export function pendingPathFor(configPath: string): string {
  return `${configPath}.pending`;
}

/**
 * Ensure the config's parent directory exists at 0700 and, if it already
 * existed, is not group/world-writable. Mirrors config.ts's parent check on
 * the read path so a write can never land in a directory the read path would
 * then refuse to trust.
 */
export function ensureConfigDir(configPath: string, _env: NodeJS.ProcessEnv = process.env): void {
  const dir = path.dirname(configPath);
  let existing: Stats | undefined;
  try {
    existing = statSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot inspect config directory ${dir}: ${(error as Error).message}`);
    }
  }
  if (!existing) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's `mode` can be masked by umask; force the final directory to 0700.
    chmodSync(dir, 0o700);
    return;
  }
  if (!existing.isDirectory()) {
    throw new Error(`config parent exists and is not a directory: ${dir}`);
  }
  if ((existing.mode & 0o022) !== 0) {
    throw new Error(`config parent directory is group- or world-writable: ${dir}`);
  }
}

/**
 * Atomic hardened write: write to a same-directory temp file opened
 * O_CREAT|O_EXCL|O_NOFOLLOW at 0600, fsync it, rename it over the target
 * (atomic on the same filesystem), then fsync the directory so the rename is
 * durable. Never follows a symlink at either path. On any failure the stale
 * temp file is unlinked and the target is left untouched.
 */
export function writeConfigFile(targetPath: string, json: string): void {
  const dir = path.dirname(targetPath);
  // Unpredictable temp name so a co-resident writer (necessarily the same uid,
  // since the parent dir is 0700/owner-only) cannot pre-create the exact name
  // to grief the O_EXCL open.
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    // The open SUCCEEDED, so we own this temp file and are responsible for
    // cleaning it up on any later failure. Set this only after open returns so
    // an EEXIST (someone else's file at this path) never leads us to unlink a
    // file we did not create.
    created = true;
    // Belt-and-suspenders: force perms explicitly rather than trusting the
    // open() mode argument, which umask can still weaken.
    fchmodSync(fd, 0o600);
    writeSync(fd, json, null, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already invalid; nothing to clean up on this fd.
      }
    }
    if (created) {
      try {
        unlinkSync(tempPath);
      } catch {
        // rename may already have consumed it; nothing left to remove.
      }
    }
    throw error;
  }
  // fsync the directory entry so the rename survives a crash, not just a
  // process exit.
  const dirFd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Write a candidate config to `<configPath>.pending` for a later, separately
 * authorized `commitPending`. Never touches the live config. */
export function writePending(configPath: string, json: string, env: NodeJS.ProcessEnv = process.env): string {
  ensureConfigDir(configPath, env);
  const pendingPath = pendingPathFor(configPath);
  writeConfigFile(pendingPath, json);
  return pendingPath;
}

/** Read `<configPath>.pending` through the SAME hardening as the live config
 * read path (perms, ownership, parent dir). Throws if there is no pending
 * file — callers treat that as "nothing to accept". */
export function readPending(configPath: string, _env: NodeJS.ProcessEnv = process.env): string {
  const pendingPath = pendingPathFor(configPath);
  const content = readHardenedFile(pendingPath);
  if (content === undefined) throw new Error(`no pending config at ${pendingPath}`);
  return content;
}

/**
 * Promote the pending config to live. Validates through the EXACT server path
 * (validateConfigObject) before touching anything: a rejected pending file
 * rolls back cleanly — the live config is never partially overwritten, and
 * the pending file is left in place so the operator can inspect or fix it.
 * Only on a successful validate does this atomically overwrite the live
 * config and then delete the pending file.
 */
export function commitPending(configPath: string, env: NodeJS.ProcessEnv = process.env): { config: RouterConfig } {
  const pendingPath = pendingPathFor(configPath);
  const raw = readPending(configPath, env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in pending config ${pendingPath}: ${(error as Error).message}`);
  }
  const config = validateConfigObject(parsed);
  writeConfigFile(configPath, raw);
  unlinkSync(pendingPath);
  return { config };
}

function describeEntry(entry: Entry | undefined): string {
  if (!entry) return "(unconfigured)";
  return entry.advisory ? `${entry.backend} (advisory)` : `${entry.backend} · ${entry.model}`;
}

function describeTierList(list: Entry[]): string {
  if (list.length === 0) return "(unconfigured)";
  return list.map((entry) => describeEntry(entry)).join(", ");
}

/** Human-readable per-tier + flags diff, mirroring check.ts's plain,
 * greppable report style (e.g. `heavy: (unconfigured) -> codex · gpt-5.6-terra`). */
export function diffConfigs(current: RouterConfig | null, next: RouterConfig): string {
  const lines: string[] = [];

  for (const tier of TIER_NAMES as readonly TierName[]) {
    const before = describeTierList(current?.tiers[tier] ?? []);
    const after = describeTierList(next.tiers[tier]);
    if (before !== after) lines.push(`  ${tier}: ${before} -> ${after}`);
  }

  for (const cap of CAPABILITIES) {
    const before = describeEntry(current?.capabilities[cap]);
    const after = describeEntry(next.capabilities[cap]);
    if (before !== after) lines.push(`  ${cap}: ${before} -> ${after}`);
  }

  for (const tier of TIER_NAMES as readonly TierName[]) {
    const before = current?.fallbacks[tier];
    const after = next.fallbacks[tier];
    if (before !== after) lines.push(`  fallbacks.${tier}: ${before ?? "(none)"} -> ${after ?? "(none)"}`);
  }

  const beforeFlag = current?.allowCrossProviderFallback ?? false;
  if (beforeFlag !== next.allowCrossProviderFallback) {
    lines.push(`  allowCrossProviderFallback: ${beforeFlag} -> ${next.allowCrossProviderFallback}`);
  }

  if (lines.length === 0) return "no changes.";
  return ["config changes:", ...lines].join("\n");
}
