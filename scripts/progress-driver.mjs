#!/usr/bin/env node
// Drives the real Control UI in headless Chromium for the progress harness.
//
// The page is the same Control UI a user opens; the message is typed into the
// same composer. The only non-user part is the prompt text. The driver records
// what the page actually shows while a real node_workspace_push is running and
// fails when no in-flight progress text became visible.

import fs from "node:fs";
import path from "node:path";
import pw from "playwright-core";

const { chromium } = pw;

const [portArg, outDirArg, readyFile] = process.argv.slice(2);
if (!portArg || !outDirArg || !readyFile) {
  console.error("usage: progress-driver.mjs <port> <out-dir> <ready-file>");
  process.exit(2);
}
const port = Number(portArg);
const outDir = path.resolve(outDirArg);
fs.mkdirSync(outDir, { recursive: true });

const chromiumPath = process.env.PROGRESS_CHROMIUM;
if (!chromiumPath) {
  console.error("PROGRESS_CHROMIUM must name a Chromium/Chrome executable");
  process.exit(2);
}

const prompt =
  process.env.PROGRESS_PROMPT ??
  "Publish the progress fixture directory to the progress-node with node_workspace_push. Do not do anything else.";

const progressLine = /Node workspace (scanning|sending|publishing):\s*(?:(\d+)\/(\d+) files,\s*)?([\d.]+) MiB/u;
const consoleErrors = [];
const samples = [];
const screenshots = [];
const allSamples = [];
const wsEvents = [];

function readProgress(text) {
  const matches = [];
  for (const line of text.split("\n")) {
    const match = progressLine.exec(line.trim());
    if (!match) continue;
    matches.push({
      line: line.trim(),
      phase: match[1],
      filesDone: match[2] === undefined ? null : Number(match[2]),
      filesTotal: match[3] === undefined ? null : Number(match[3]),
      bytesDone: Number(match[4]),
    });
  }
  return matches;
}

const browser = await chromium.launch({
  executablePath: chromiumPath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
const page = await context.newPage();
page.on("websocket", (socket) => {
  socket.on("framereceived", (frame) => {
    if (process.env.PROGRESS_CAPTURE_WS !== "1") return;
    const payload = typeof frame.payload === "string" ? frame.payload : "";
    if (!payload) return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const text = JSON.stringify(parsed);
    if (!/progressText|tool_execution|"item"|"tool"/u.test(text)) return;
    wsEvents.push({ atMs: Date.now(), text: text.slice(0, 4000) });
  });
});
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500));
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 500)}`));

let failure;
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const composer = page.locator("textarea").first();
  await composer.waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForFunction(
    () => {
      const area = document.querySelector("textarea");
      return !!area && !area.disabled && (area.getAttribute("placeholder") ?? "").length > 0;
    },
    undefined,
    { timeout: 90_000 },
  );
  fs.writeFileSync(readyFile, "ready\n");

  await composer.fill(prompt);
  await composer.press("Enter");

  const startedAt = Date.now();
  const deadline = startedAt + Number(process.env.PROGRESS_TIMEOUT_MS ?? 240_000);
  let lastShotAt = 0;
  let lastAnyShotAt = 0;
  let done = false;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText({ timeout: 10_000 });
    const elapsedMs = Date.now() - startedAt;
    const progress = readProgress(text);
    const progressBars = await page.locator('[role="progressbar"]').count().catch(() => 0);
    allSamples.push({ elapsedMs, progressBars, textTail: text.slice(-1800) });
    if (progress.length > 0) {
      samples.push({ elapsedMs, progress, textTail: text.slice(-1200) });
      if (elapsedMs - lastShotAt >= 400) {
        const file = path.join(outDir, `progress-${String(screenshots.length).padStart(2, "0")}-${elapsedMs}ms.png`);
        await page.screenshot({ path: file, fullPage: false });
        screenshots.push({ file, elapsedMs, visibleProgress: progress.map((entry) => entry.line) });
        lastShotAt = elapsedMs;
      }
    }
    if (process.env.PROGRESS_CAPTURE_ALL === "1" && elapsedMs - lastAnyShotAt >= 500 && elapsedMs < 60_000 && screenshots.length < 70) {
      const file = path.join(outDir, `frame-${String(screenshots.length).padStart(2, "0")}-${elapsedMs}ms.png`);
      await page.screenshot({ path: file, fullPage: false, timeout: 15_000 });
      screenshots.push({ file, elapsedMs, visibleProgress: progress.map((entry) => entry.line), generic: true });
      lastAnyShotAt = elapsedMs;
    }
    const doneToken = process.env.PROGRESS_DONE_TOKEN;
    if ((text.includes("PROGRESS DONE") && (!doneToken || text.includes(doneToken))) || (!doneToken && text.includes("published:"))) {
      done = true;
      await page.waitForTimeout(600);
      break;
    }
    await page.waitForTimeout(120);
  }

  const finalText = await page.locator("body").innerText({ timeout: 10_000 });
  const finalShot = path.join(outDir, "final.png");
  await page.screenshot({ path: finalShot, fullPage: false, timeout: 15_000 });
  screenshots.push({ file: finalShot, elapsedMs: Date.now() - startedAt, final: true });

  const distinct = new Map();
  for (const sample of samples) {
    for (const entry of sample.progress) distinct.set(entry.line, entry);
  }
  const ordered = [...distinct.values()];
  const sending = ordered.filter((entry) => entry.phase === "sending" && entry.filesTotal);
  const maxFiles = Math.max(0, ...sending.map((entry) => entry.filesDone ?? 0));
  const maxBytes = Math.max(0, ...sending.map((entry) => entry.bytesDone));
  const visibleDuringTransfer = screenshots.filter((shot) => shot.visibleProgress && shot.visibleProgress.length > 0);

  const report = {
    ok: false,
    done,
    elapsedMs: Date.now() - startedAt,
    distinctProgressLines: ordered.map((entry) => entry.line),
    maxFilesDone: maxFiles,
    maxMiB: maxBytes,
    samples: samples.map((sample) => ({ elapsedMs: sample.elapsedMs, progress: sample.progress.map((entry) => entry.line) })),
    allSamples: allSamples.filter((sample, index) => index % 5 === 0 || sample.progressBars > 0).slice(0, 200),
    wsEvents: wsEvents.slice(0, 200),
    screenshots,
    visibleDuringTransfer: visibleDuringTransfer.map((shot) => shot.file),
    consoleErrors,
    finalExcerpt: finalText.slice(-2500),
  };

  const problems = [];
  if (!done) problems.push("the turn did not report completion before the deadline");
  if (ordered.length < 2) problems.push(`saw ${ordered.length} distinct progress line(s); expected at least 2 during the push`);
  if (maxFiles < 1) problems.push("no progress line reported a non-zero file count");
  if (maxBytes <= 0) problems.push("no progress line reported transferred bytes");
  if (visibleDuringTransfer.length === 0) problems.push("no screenshot captured progress while the transfer was in flight");
  if (!finalText.includes("PROGRESS DONE")) problems.push("the final assistant message was not visible");
  if (problems.length > 0) {
    report.problems = problems;
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    failure = problems.join("; ");
  } else {
    report.ok = true;
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  }
} catch (error) {
  failure = String(error);
  try {
    const finalShot = path.join(outDir, "failure.png");
    await page.screenshot({ path: finalShot, fullPage: false });
    fs.writeFileSync(
      path.join(outDir, "report.json"),
      JSON.stringify({ ok: false, failure, consoleErrors, screenshots }, null, 2),
    );
  } catch {
    // The browser may already be gone.
  }
} finally {
  await browser.close().catch(() => undefined);
}

if (failure) {
  console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, report: path.join(outDir, "report.json") }, null, 2));
