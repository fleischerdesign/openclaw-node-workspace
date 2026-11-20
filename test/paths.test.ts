import assert from "node:assert/strict";
import test from "node:test";

import { NodeWorkspaceError } from "../src/errors.js";
import {
  assertSafeRelativePath,
  isWithin,
  normalizeAbsolutePosixPath,
} from "../src/paths.js";

test("normalizeAbsolutePosixPath accepts a normalized absolute path", () => {
  assert.equal(normalizeAbsolutePosixPath("/srv/workspace"), "/srv/workspace");
  assert.equal(normalizeAbsolutePosixPath("/"), "/");
});

test("normalizeAbsolutePosixPath rejects relative, non-normalized, and NUL paths", () => {
  for (const value of ["srv/workspace", "/srv/../workspace", "/srv//workspace", "/srv/workspace/", "/a\0b"]) {
    assert.throws(() => normalizeAbsolutePosixPath(value), NodeWorkspaceError);
  }
});

test("isWithin respects component boundaries", () => {
  assert.equal(isWithin("/srv/work", "/srv/work"), true);
  assert.equal(isWithin("/srv/work", "/srv/work/a"), true);
  assert.equal(isWithin("/srv/work", "/srv/workspace"), false);
  assert.equal(isWithin("/srv/work", "/srv/work-2/a"), false);
});

test("assertSafeRelativePath rejects traversal, absolute paths, backslashes, and the marker", () => {
  for (const value of ["../escape", "a/../../escape", "/etc/passwd", "a\\b", "", "a//b", "./a"]) {
    assert.throws(() => assertSafeRelativePath(value), NodeWorkspaceError);
  }
  assert.equal(assertSafeRelativePath("a/b.txt"), "a/b.txt");
});

