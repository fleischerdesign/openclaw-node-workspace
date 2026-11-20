import assert from "node:assert/strict";
import test from "node:test";

import type { ManifestEntry } from "../src/digest.js";
import { buildManagedPlan, type ManagedPlanInput } from "../src/managed-plan.js";
import { resolvePolicy } from "../src/policy.js";

function entry(path: string, sha: string, executable = false, size = sha.length): ManifestEntry {
  return { path, size, sha256: sha.repeat(64).slice(0, 64), executable };
}

const sha = (value: string): string => value.padEnd(64, "0");

function input(overrides: Partial<ManagedPlanInput> = {}): ManagedPlanInput {
  return {
    remotePath: "/srv/work/app",
    localProject: "/home/philipp/work/app",
    baseRevision: 3,
    recordExists: true,
    baseManifest: [],
    localFiles: [],
    localDirectories: [],
    nodeFiles: [],
    nodeDirectories: [],
    policy: resolvePolicy(undefined),
    previousPolicy: resolvePolicy(undefined),
    released: [],
    adopt: false,
    adoptPaths: [],
    restore: [],
    ...overrides,
  };
}

test("the managed plan derives add, change, delete, mode and unchanged entries", () => {
  const plan = buildManagedPlan(
    input({
      baseManifest: [
        entry("same.txt", sha("a")),
        entry("change.txt", sha("b")),
        entry("delete.txt", sha("c")),
        entry("mode.sh", sha("d"), false),
      ],
      localFiles: [
        entry("same.txt", sha("a")),
        entry("change.txt", sha("e")),
        entry("mode.sh", sha("d"), true),
        entry("add.txt", sha("f")),
      ],
      nodeFiles: [
        entry("same.txt", sha("a")),
        entry("change.txt", sha("b")),
        entry("delete.txt", sha("c")),
        entry("mode.sh", sha("d"), false),
      ],
    }),
  );
  assert.deepEqual(
    plan.entries.map((entry) => [entry.kind, entry.path]),
    [
      ["add", "add.txt"],
      ["change", "change.txt"],
      ["delete", "delete.txt"],
      ["mode", "mode.sh"],
    ],
  );
  assert.equal(plan.counts.unchanged, 1);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.safeForRoutine, false, "a delete always requires a pinned preview");
  assert.match(plan.digest, /^[0-9a-f]{64}$/u);
});

test("a node edit that differs from the base blocks the update", () => {
  const plan = buildManagedPlan(
    input({
      baseManifest: [entry("a.txt", sha("a"))],
      localFiles: [entry("a.txt", sha("b"))],
      nodeFiles: [entry("a.txt", sha("c"))],
    }),
  );
  assert.deepEqual(plan.conflicts, [{ path: "a.txt", reason: "node-modified" }]);
  assert.equal(plan.entries.length, 0);
});

test("a converged node edit becomes a verified adopt entry", () => {
  const plan = buildManagedPlan(
    input({
      baseManifest: [entry("a.txt", sha("a"))],
      localFiles: [entry("a.txt", sha("b"))],
      nodeFiles: [entry("a.txt", sha("b"))],
    }),
  );
  assert.deepEqual(plan.entries.map((entry) => [entry.kind, entry.path]), [["adopt", "a.txt"]]);
  assert.equal(plan.counts.unchanged, 0);
  assert.equal(plan.conflicts.length, 0);
});

test("a missing node base file is not restored silently", () => {
  const plan = buildManagedPlan(
    input({
      baseManifest: [entry("a.txt", sha("a"))],
      localFiles: [entry("a.txt", sha("a"))],
      nodeFiles: [],
    }),
  );
  assert.deepEqual(plan.restorable, ["a.txt"]);
  assert.deepEqual(plan.conflicts, [{ path: "a.txt", reason: "node-missing" }]);
  assert.equal(plan.entries.length, 0);
});

test("an explicit restore authorization produces a restore entry", () => {
  const plan = buildManagedPlan(
    input({
      baseManifest: [entry("a.txt", sha("a"))],
      localFiles: [entry("a.txt", sha("a"))],
      nodeFiles: [],
      restore: ["a.txt"],
    }),
  );
  assert.deepEqual(plan.entries.map((entry) => [entry.kind, entry.path]), [["restore", "a.txt"]]);
  assert.equal(plan.conflicts.length, 0);
});

test("a local addition colliding with an untracked node file blocks even with equal bytes", () => {
  const plan = buildManagedPlan(
    input({
      localFiles: [entry("new.txt", sha("a"))],
      nodeFiles: [entry("new.txt", sha("a"))],
    }),
  );
  assert.deepEqual(plan.conflicts, [{ path: "new.txt", reason: "untracked" }]);
  assert.equal(plan.entries.length, 0);
});

test("a file where the node has a directory is a type collision", () => {
  const plan = buildManagedPlan(
    input({
      localFiles: [entry("thing", sha("a"))],
      nodeDirectories: ["thing"],
      nodeFiles: [entry("thing/child.txt", sha("b"))],
    }),
  );
  assert.ok(plan.conflicts.some((conflict) => conflict.reason === "type-collision"));
});

test("a file cannot be added below a node file", () => {
  const plan = buildManagedPlan(
    input({
      localFiles: [entry("parent/child.txt", sha("a"))],
      nodeFiles: [entry("parent", sha("b"))],
    }),
  );
  assert.ok(plan.conflicts.some((conflict) => conflict.path === "parent/child.txt" && conflict.reason === "parent-not-directory"));
});

test("selection narrowing releases management without deleting node files", () => {
  const policy = resolvePolicy({ include: ["kept/**"] });
  const plan = buildManagedPlan(
    input({
      policy,
      previousPolicy: policy,
      baseManifest: [entry("kept/a.txt", sha("a")), entry("dropped/b.txt", sha("b"))],
      localFiles: [entry("kept/a.txt", sha("a"))],
      nodeFiles: [entry("kept/a.txt", sha("a")), entry("dropped/b.txt", sha("b"))],
    }),
  );
  assert.equal(plan.entries.length, 0);
  assert.deepEqual(plan.releasedAfter.map((entry) => entry.path), ["dropped/b.txt"]);
  assert.equal(plan.counts.released, 1);
});

test("a released path cannot be re-included without an explicit adopt path", () => {
  const policy = resolvePolicy(undefined);
  const released = [
    { path: "old.txt", sha256: sha("a"), size: 1, executable: false, releasedAt: "2026-01-01", revision: 1 },
  ];
  const blocked = buildManagedPlan(
    input({
      policy,
      previousPolicy: policy,
      released,
      baseManifest: [],
      localFiles: [entry("old.txt", sha("a"))],
      nodeFiles: [entry("old.txt", sha("a"))],
    }),
  );
  assert.ok(blocked.conflicts.some((conflict) => conflict.reason === "released-path"));
  const adopted = buildManagedPlan(
    input({
      policy,
      previousPolicy: policy,
      released,
      baseManifest: [],
      localFiles: [entry("old.txt", sha("a"))],
      nodeFiles: [entry("old.txt", sha("a"))],
      adoptPaths: ["old.txt"],
    }),
  );
  assert.equal(adopted.conflicts.length, 0);
  assert.equal(adopted.releasedAfter.length, 0);
  assert.deepEqual(adopted.entries.map((entry) => [entry.kind, entry.path]), [["adopt", "old.txt"]], "equal bytes converge without a write");
});

test("an unmanaged directory needs explicit adoption", () => {
  const blocked = buildManagedPlan(
    input({
      recordExists: false,
      baseManifest: undefined,
      localFiles: [entry("a.txt", sha("a"))],
      nodeFiles: [entry("foreign.txt", sha("b"))],
    }),
  );
  assert.equal(blocked.adoptRequired, true);
  assert.ok(blocked.conflicts.some((conflict) => conflict.reason === "adoption-required"));
  const adopted = buildManagedPlan(
    input({
      recordExists: false,
      baseManifest: undefined,
      localFiles: [entry("a.txt", sha("a"))],
      nodeFiles: [entry("foreign.txt", sha("b"))],
      adopt: true,
    }),
  );
  assert.equal(adopted.adoptRequired, false);
  assert.deepEqual(adopted.entries.map((entry) => [entry.kind, entry.path]), [["add", "a.txt"]]);
  assert.equal(adopted.counts.untracked, 1);
});

test("a converged adoption becomes an adopt entry and still needs a preview", () => {
  const plan = buildManagedPlan(
    input({
      recordExists: false,
      baseManifest: undefined,
      localFiles: [entry("a.txt", sha("a"))],
      nodeFiles: [entry("a.txt", sha("a"))],
      adopt: true,
    }),
  );
  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(plan.entries.map((entry) => [entry.kind, entry.path]), [["adopt", "a.txt"]]);
  assert.equal(plan.counts.adopt, 1);
  assert.equal(plan.safeForRoutine, false);
});

test("creation, policy transition and deletion are not routine applies", () => {
  const created = buildManagedPlan(
    input({ recordExists: false, baseManifest: undefined, localFiles: [entry("a.txt", sha("a"))] }),
  );
  assert.equal(created.createRequired, true);
  assert.equal(created.safeForRoutine, false);
  assert.deepEqual(created.entries.map((entry) => [entry.kind, entry.path]), [["add", "a.txt"]]);

  const changedPolicy = buildManagedPlan(
    input({
      previousPolicy: resolvePolicy({ preset: "none" }),
      policy: resolvePolicy({ preset: "node" }),
      baseManifest: [entry("a.txt", sha("a"))],
      localFiles: [entry("a.txt", sha("b"))],
      nodeFiles: [entry("a.txt", sha("a"))],
    }),
  );
  assert.equal(changedPolicy.policyChanged, true);
  assert.equal(changedPolicy.safeForRoutine, false);

  const routine = buildManagedPlan(
    input({
      baseManifest: [entry("a.txt", sha("a"))],
      localFiles: [entry("a.txt", sha("b"))],
      nodeFiles: [entry("a.txt", sha("a"))],
    }),
  );
  assert.equal(routine.safeForRoutine, true);
  assert.deepEqual(routine.entries.map((entry) => [entry.kind, entry.path]), [["change", "a.txt"]]);
});

test("the plan digest is deterministic and sensitive to the base revision", () => {
  const files = { baseManifest: [entry("a.txt", sha("a"))], localFiles: [entry("a.txt", sha("b"))], nodeFiles: [entry("a.txt", sha("a"))] };
  const first = buildManagedPlan(input(files));
  const second = buildManagedPlan(input(files));
  const advanced = buildManagedPlan(input({ ...files, baseRevision: 4 }));
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.digest, advanced.digest);
});
