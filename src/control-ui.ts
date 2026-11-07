import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";

import { nodeWorkspaceFeatureContract } from "./feature-contract.js";

type Transfer = {
  transferId: string;
  kind: "push" | "fetch" | "return";
  phase: "scanning" | "sending" | "publishing" | "fetching" | "receiving" | "applying";
  state: "running" | "completed" | "failed" | "unknown" | "cancelled";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
};

type Snapshot = { transfers: readonly Transfer[]; observedAt: number };

const MAX_ROWS = 3;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function fraction(entry: Transfer): number {
  if (entry.bytesTotal > 0) return Math.min(1, entry.bytesDone / entry.bytesTotal);
  if (entry.filesTotal > 0) return Math.min(1, entry.filesDone / entry.filesTotal);
  return 0;
}

function rowText(entry: Transfer): string {
  const files = entry.filesTotal > 0 ? `${entry.filesDone}/${entry.filesTotal}` : `${entry.filesDone}`;
  const bytes = `${formatBytes(entry.bytesDone)} / ${formatBytes(entry.bytesTotal)}`;
  if (entry.state === "running") {
    if (entry.kind === "fetch") return `fetching ${bytes}`;
    if (entry.kind === "return") return `returning ${files} · ${formatBytes(entry.bytesDone)}`;
    if (entry.phase === "scanning" && entry.filesTotal === 0) return "scanning";
    if (entry.phase === "publishing") return `publishing ${files} · ${formatBytes(entry.bytesTotal)}`;
    return `${entry.phase} ${files} · ${formatBytes(entry.bytesDone)}`;
  }
  if (entry.state === "completed") {
    return `✓ ${entry.filesTotal > 0 ? `${entry.filesTotal} files · ` : ""}${formatBytes(entry.bytesTotal > 0 ? entry.bytesTotal : entry.bytesDone)}`;
  }
  if (entry.state === "unknown") return "unknown outcome";
  if (entry.state === "cancelled") return "cancelled";
  return "failed";
}

function rowLabel(entry: Transfer): string {
  if (entry.kind === "push") return "Publish";
  return entry.kind === "fetch" ? "Fetch" : "Return";
}

function makeRow(document: Document, entry: Transfer): { row: HTMLElement; label: HTMLElement; bar: HTMLElement } {
  const row = document.createElement("div");
  row.dataset.nodewsRow = entry.transferId;
  row.style.cssText =
    "display:flex;align-items:center;gap:6px;min-width:0;font:inherit;font-size:11px;line-height:16px;white-space:nowrap;";

  const label = document.createElement("span");
  label.textContent = `${rowLabel(entry)} ${rowText(entry)}`;
  label.style.cssText = "overflow:hidden;text-overflow:ellipsis;color:inherit;";

  const value = Math.round(fraction(entry) * 1000);
  const bar = document.createElement("div");
  bar.dataset.nodewsBar = "";
  bar.dataset.value = String(value);
  bar.dataset.max = "1000";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "1000");
  bar.setAttribute("aria-valuenow", String(value));
  bar.setAttribute("aria-label", rowLabel(entry));
  bar.style.cssText =
    "width:64px;height:5px;border-radius:3px;overflow:hidden;flex:none;background:color-mix(in srgb,currentColor 22%,transparent);";

  const fill = document.createElement("div");
  fill.style.cssText = "height:100%;border-radius:3px;background:currentColor;transition:width .15s linear;";
  fill.style.width = `${Math.max(0, Math.min(100, value / 10))}%`;
  bar.append(fill);

  row.append(bar, label);
  return { row, label, bar };
}

export default defineControlUiPlugin({
  id: "node-workspace",
  activate(host) {
    return host.ui.registerAccessory({
      id: "node-workspace.transfer-progress",
      placement: "session-header",
      mount(container, context) {
        const document = container.ownerDocument;
        const root = document.createElement("div");
        root.dataset.nodeWorkspaceProgress = "";
        root.setAttribute("role", "status");
        root.setAttribute("aria-live", "polite");
        root.style.cssText =
          "display:none;flex-direction:column;gap:2px;max-width:380px;color:inherit;font:inherit;padding:0 2px;";

        let sessionKey = "";
        let agentId: string | undefined;
        let stopWatch: (() => void) | undefined;
        let last: Snapshot | undefined;
        let errorText: string | undefined;

        const feature = createFeatureClient(nodeWorkspaceFeatureContract, context.host);

        const render = (): void => {
          const transfers = last?.transfers ?? [];
          if (errorText) {
            root.replaceChildren();
            const error = document.createElement("span");
            error.textContent = "progress unavailable";
            error.style.cssText = "font:inherit;font-size:11px;color:inherit;opacity:.7;";
            root.append(error);
            root.style.display = "flex";
            return;
          }
          if (transfers.length === 0) {
            root.replaceChildren();
            root.style.display = "none";
            return;
          }
          root.replaceChildren();
          const shown = transfers.slice(-MAX_ROWS);
          if (transfers.length > MAX_ROWS) {
            const more = document.createElement("span");
            more.textContent = `+${transfers.length - MAX_ROWS} more transfers`;
            more.style.cssText = "font:inherit;font-size:11px;opacity:.75;";
            root.append(more);
          }
          for (const entry of shown) {
            const { row } = makeRow(document, entry);
            root.append(row);
          }
          root.style.display = "flex";
        };

        const restart = (): void => {
          stopWatch?.();
          stopWatch = undefined;
          last = undefined;
          errorText = undefined;
          render();
          if (!sessionKey) return;
          stopWatch = feature.watch("progress.snapshot", {}, {
            sessionKey,
            ...(agentId ? { agentId } : {}),
            events: ["progress-changed"],
            onChange: (snapshot) => {
              last = snapshot as Snapshot;
              errorText = undefined;
              render();
            },
            onError: (error) => {
              // Keep the last measured snapshot during a reconnect; the host
              // refreshes it when the connection returns.
              errorText = error.message;
              render();
            },
          });
        };

        const applyProps = (next: { sessionKey?: string; agentId?: string }): void => {
          const nextKey = typeof next.sessionKey === "string" ? next.sessionKey : "";
          const nextAgent = typeof next.agentId === "string" ? next.agentId : undefined;
          if (nextKey === sessionKey && nextAgent === agentId) return;
          sessionKey = nextKey;
          agentId = nextAgent;
          restart();
        };

        container.replaceChildren(root);
        applyProps(context.props as { sessionKey?: string; agentId?: string });

        return {
          update(next) {
            applyProps(next.props as { sessionKey?: string; agentId?: string });
          },
          dispose() {
            stopWatch?.();
            stopWatch = undefined;
            root.remove();
          },
        };
      },
    });
  },
});
