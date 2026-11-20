import { minimatch } from "minimatch";

import { NodeWorkspaceError } from "./errors.js";

export type PolicyPreset = "none" | "node" | "rust";

/**
 * Paths that are persistent node-local state, never managed source.
 *
 * They are matched at any depth and are skipped before traversal, so a large
 * dependency tree is never read, hashed, moved, or counted as transfer bytes.
 */
export const ALWAYS_EXCLUDED = ["node_modules", "target", ".git"] as const;

/**
 * Cache-oriented additions selected by a preset.
 *
 * `none` deliberately means that only ALWAYS_EXCLUDED applies. The plugin does
 * not assume that every `dist` directory is disposable.
 */
const PRESET_EXCLUDES: Record<PolicyPreset, readonly string[]> = {
  none: [],
  node: [".next", ".nuxt", ".cache", ".pnpm-store", ".turbo", ".parcel-cache", "coverage", "dist"],
  rust: [".cargo", ".rustup", "debug", "incremental"],
};

/**
 * Default protected patterns, relative to the project root, matching at any
 * depth. This intentionally protects some harmless example/config files; the
 * alternative is guessing which secret-looking path is safe to transfer.
 */
export const DEFAULT_PROTECTED = [
  ".env",
  ".env.*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".ssh/**",
  ".aws/**",
  ".gnupg/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
] as const;

export interface PolicyInput {
  readonly preset?: PolicyPreset | undefined;
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly protect?: readonly string[] | undefined;
}

export interface ResolvedPolicy {
  readonly preset: PolicyPreset;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly protect: readonly string[];
}

const MAX_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 1024;

function validatePatterns(value: readonly string[] | undefined, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PATTERNS) {
    throw new NodeWorkspaceError("config-invalid", `${label} must be an array of at most ${MAX_PATTERNS} patterns`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_PATTERN_LENGTH) {
      throw new NodeWorkspaceError(
        "config-invalid",
        `${label}[${index}] must be a non-empty string of at most ${MAX_PATTERN_LENGTH} characters`,
      );
    }
    if (entry.includes("\0")) {
      throw new NodeWorkspaceError("config-invalid", `${label}[${index}] must not contain a NUL byte`);
    }
    return entry;
  });
}

/** Resolve one policy input into the persisted form. */
export function resolvePolicy(input: PolicyInput | undefined): ResolvedPolicy {
  const raw = input ?? {};
  const preset = raw.preset ?? "none";
  if (preset !== "none" && preset !== "node" && preset !== "rust") {
    throw new NodeWorkspaceError("config-invalid", 'policy.preset must be "none", "node" or "rust"');
  }
  return {
    preset,
    include: validatePatterns(raw.include, "policy.include"),
    exclude: validatePatterns(raw.exclude, "policy.exclude"),
    protect: validatePatterns(raw.protect, "policy.protect"),
  };
}

export function policyEquals(left: ResolvedPolicy, right: ResolvedPolicy): boolean {
  return (
    left.preset === right.preset &&
    left.include.join("\0") === right.include.join("\0") &&
    left.exclude.join("\0") === right.exclude.join("\0") &&
    left.protect.join("\0") === right.protect.join("\0")
  );
}

function normalized(pattern: string): string {
  return pattern.replace(/^\.\//u, "").replace(/\/+$/u, "");
}

/**
 * Match one relative path against patterns that apply at any depth.
 *
 * A pattern matches the path itself, everything below it, or the same relative
 * suffix of a deeper path (`node_modules` matches `a/b/node_modules/x`).
 */
export function matchesPattern(patterns: readonly string[], relativePath: string): boolean {
  if (patterns.length === 0) return false;
  const segments = relativePath.split("/");
  for (const raw of patterns) {
    const pattern = normalized(raw);
    if (pattern.length === 0) continue;
    for (let index = 0; index < segments.length; index += 1) {
      const candidate = segments.slice(index).join("/");
      if (minimatch(candidate, pattern, { dot: true })) return true;
      if (minimatch(candidate, `${pattern}/**`, { dot: true })) return true;
    }
  }
  return false;
}

/** True before traversal: the entry and its whole subtree are persistent node state. */
export function isExcluded(relativePath: string, policy: ResolvedPolicy): boolean {
  return (
    matchesPattern(ALWAYS_EXCLUDED, relativePath) ||
    matchesPattern(PRESET_EXCLUDES[policy.preset], relativePath) ||
    matchesPattern(policy.exclude, relativePath)
  );
}

/** True when the path must never cross the channel or enter a managed manifest. */
export function isProtected(relativePath: string, policy: ResolvedPolicy): boolean {
  return matchesPattern(DEFAULT_PROTECTED, relativePath) || matchesPattern(policy.protect, relativePath);
}

/** Selection narrowing. It never grants access; it only chooses among scanned paths. */
export function isSelected(relativePath: string, policy: ResolvedPolicy): boolean {
  if (policy.include.length > 0 && !matchesPattern(policy.include, relativePath)) return false;
  if (matchesPattern(policy.exclude, relativePath)) return false;
  return true;
}
