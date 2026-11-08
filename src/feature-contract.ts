import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

/** Widget id shared by the browser registration and the backend descriptor. */
export const PROGRESS_WIDGET_ID = "node-workspace-progress";

const transferPhase = Type.Union([
  Type.Literal("scanning"),
  Type.Literal("sending"),
  Type.Literal("publishing"),
  Type.Literal("fetching"),
  Type.Literal("receiving"),
  Type.Literal("applying"),
]);

const transferState = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
  Type.Literal("cancelled"),
]);

export const transferProgressSchema = Type.Object(
  {
    transferId: Type.String({ minLength: 1, maxLength: 128 }),
    kind: Type.Union([Type.Literal("push"), Type.Literal("fetch"), Type.Literal("return")]),
    phase: transferPhase,
    state: transferState,
    filesDone: Type.Integer({ minimum: 0 }),
    filesTotal: Type.Integer({ minimum: 0 }),
    bytesDone: Type.Integer({ minimum: 0 }),
    bytesTotal: Type.Integer({ minimum: 0 }),
    startedAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
    finishedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Machine-readable failure code, for example `path-outside-root`. */
    reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);

export const progressSnapshotInput = Type.Object({}, { additionalProperties: false });

export const progressSnapshotOutput = Type.Object(
  {
    transfers: Type.Array(transferProgressSchema, { maxItems: 16 }),
    observedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/**
 * Browser-safe contract shared by the backend operations and the header
 * accessory. It carries measured counters only: no paths, node names, or
 * command output ever cross this surface.
 */
export const nodeWorkspaceFeatureContract = defineFeatureContract({
  pluginId: "node-workspace",
  operations: {
    "progress.snapshot": {
      kind: "query",
      description: "Measured transfer progress for the current session.",
      input: progressSnapshotInput,
      output: progressSnapshotOutput,
    },
  },
  events: {
    "progress-changed": Type.Object({}, { additionalProperties: false }),
  },
});
