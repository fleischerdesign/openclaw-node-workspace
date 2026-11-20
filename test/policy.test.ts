import assert from "node:assert/strict";
import test from "node:test";

import {
  ALWAYS_EXCLUDED,
  DEFAULT_PROTECTED,
  isExcluded,
  isProtected,
  isSelected,
  resolvePolicy,
} from "../src/policy.js";

test("cache exclusions apply at any depth and before traversal", () => {
  const policy = resolvePolicy(undefined);
  assert.deepEqual([...ALWAYS_EXCLUDED], ["node_modules", "target", ".git"]);
  assert.equal(isExcluded("node_modules/react/index.js", policy), true);
  assert.equal(isExcluded("packages/app/node_modules/x", policy), true);
  assert.equal(isExcluded("crates/core/target/debug/app", policy), true);
  assert.equal(isExcluded(".git/objects/aa", policy), true);
  assert.equal(isExcluded("src/index.ts", policy), false);
  assert.equal(isExcluded("dist/index.js", policy), false);
});

test("a preset adds cache directories without making every dist disposable", () => {
  const node = resolvePolicy({ preset: "node" });
  assert.equal(isExcluded("dist/index.js", node), true);
  assert.equal(isExcluded("coverage/lcov.info", node), true);
  assert.equal(isExcluded("src/index.ts", node), false);
  const rust = resolvePolicy({ preset: "rust" });
  assert.equal(isExcluded("debug/app", rust), true);
  assert.equal(isExcluded("incremental/x", rust), true);
  assert.equal(isExcluded("dist/index.js", rust), false);
});

test("default protected patterns match secret-like paths at any depth", () => {
  const policy = resolvePolicy(undefined);
  for (const candidate of [
    ".env",
    "apps/web/.env.production",
    ".npmrc",
    "nested/.ssh/id_rsa",
    ".aws/credentials",
    ".gnupg/private-keys-v1.d/x.key",
    "certs/server.pem",
    "certs/server.key",
  ]) {
    assert.equal(isProtected(candidate, policy), true, candidate);
  }
  assert.equal(isProtected("src/index.ts", policy), false);
  assert.match(DEFAULT_PROTECTED.join(","), /\.env/);
});

test("explicit protect and exclude arrays extend the defaults", () => {
  const policy = resolvePolicy({ protect: ["secrets/**"], exclude: ["generated"] });
  assert.equal(isProtected("secrets/token.txt", policy), true);
  assert.equal(isProtected(".env", policy), true);
  assert.equal(isExcluded("generated/api.ts", policy), true);
});

test("selection narrowing is include then exclude, never a grant", () => {
  const policy = resolvePolicy({ include: ["src/**"], exclude: ["src/generated/**"] });
  assert.equal(isSelected("src/index.ts", policy), true);
  assert.equal(isSelected("src/generated/api.ts", policy), false);
  assert.equal(isSelected("docs/readme.md", policy), false);
  const all = resolvePolicy({});
  assert.equal(isSelected("docs/readme.md", all), true);
});

test("invalid policy input fails closed", () => {
  assert.throws(() => resolvePolicy({ preset: "everything" as never }), /policy\.preset/);
  assert.throws(() => resolvePolicy({ exclude: [""] }), /must be a non-empty string/);
  assert.throws(() => resolvePolicy({ protect: ["a\0b"] }), /NUL/);
});
