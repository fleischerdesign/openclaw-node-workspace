#!/usr/bin/env node
// Build the native Control UI bundle without the authoring-metadata path.
//
// This plugin's entry uses a per-call tool factory, so `openclaw plugins build`
// cannot derive static tool metadata for it. The runtime plugin still installs
// from openclaw.plugin.json, and the browser entry is a self-contained ESM
// bundle served from a content-addressed directory.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const source = path.join(root, "src", "control-ui.ts");
const outputRoot = path.join(root, "dist", "control-ui");

const result = await build({
  entryPoints: [source],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  logLevel: "warning",
});

const javascript = Buffer.from(result.outputFiles[0]?.contents ?? new Uint8Array());
const css = result.outputFiles.find((file) => file.path.endsWith(".css"));
if (javascript.length === 0) throw new Error("Control UI bundle is empty");

const hash = crypto.createHash("sha256").update(javascript).digest("hex");
const directory = path.join(outputRoot, hash);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, "index.js"), javascript);

const styles = [];
if (css) {
  fs.writeFileSync(path.join(directory, "index.css"), css.contents);
  styles.push(path.relative(root, path.join(directory, "index.css")).split(path.sep).join("/"));
}

const manifestPath = path.join(root, "openclaw.plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.controlUi = {
  entry: path.relative(root, path.join(directory, "index.js")).split(path.sep).join("/"),
  styles,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// Keep only the revision this manifest advertises.
for (const name of fs.readdirSync(outputRoot)) {
  if (name !== hash) fs.rmSync(path.join(outputRoot, name), { recursive: true, force: true });
}

console.log(`Control UI: ${manifest.controlUi.entry} (${javascript.length} bytes)`);
