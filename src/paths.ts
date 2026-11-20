import path from "node:path";

import { NodeWorkspaceError } from "./errors.js";

export const MAX_PATH_BYTES = 4096;
export const MAX_COMPONENT_BYTES = 255;

function invalid(message: string): never {
  throw new NodeWorkspaceError("path-invalid", message);
}

/**
 * Normalize an absolute POSIX path and require the input to already be in
 * normalized form. Two spellings of the same path would otherwise escape
 * identity checks that compare strings.
 */
export function normalizeAbsolutePosixPath(value: string): string {
  if (typeof value !== "string" || value.length === 0) invalid("path must be a non-empty string");
  if (value.includes("\0")) invalid("path must not contain a NUL byte");
  if (!value.startsWith("/")) invalid(`path must be absolute: ${JSON.stringify(value)}`);
  if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) invalid("path is too long");
  const normalized = path.posix.normalize(value);
  if (normalized !== value) invalid(`path is not in normalized form: ${JSON.stringify(value)}`);
  if (normalized === "/") return normalized;
  if (normalized.endsWith("/")) invalid("path must not end with a separator");
  return normalized;
}

/** True when `child` is `root` itself or lies below it. */
export function isWithin(root: string, child: string): boolean {
  if (child === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return child.startsWith(prefix);
}

/**
 * Validate a manifest-relative path. The returned value is safe to join to a
 * staging directory on a POSIX filesystem.
 */
export function assertSafeRelativePath(value: string, label = "path"): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${label} must be a non-empty string`);
  if (value.includes("\0")) invalid(`${label} must not contain a NUL byte`);
  if (value.includes("\\")) invalid(`${label} must not contain a backslash: ${JSON.stringify(value)}`);
  if (value.startsWith("/")) invalid(`${label} must be relative: ${JSON.stringify(value)}`);
  if (value.endsWith("/")) invalid(`${label} must not end with a separator: ${JSON.stringify(value)}`);
  if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) invalid(`${label} is too long`);

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment.length === 0) invalid(`${label} contains an empty segment: ${JSON.stringify(value)}`);
    if (segment === "." || segment === "..") {
      invalid(`${label} contains a traversal segment: ${JSON.stringify(value)}`);
    }
    if (Buffer.byteLength(segment, "utf8") > MAX_COMPONENT_BYTES) {
      invalid(`${label} contains a component longer than ${MAX_COMPONENT_BYTES} bytes`);
    }
  }
  return value;
}
