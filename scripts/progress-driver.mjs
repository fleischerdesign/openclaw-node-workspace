#!/usr/bin/env node
// Drives the real Control UI in headless Chromium and verifies the native
// session-header accessory against a live node_workspace_push.
//
// The page is the same Control UI a user opens; the message is typed into the
// same composer. The accessory is a native plugin contribution, so this also
// proves the Custom plugin UI lab path, the session-scoped query, event-driven
// refresh, and snapshot recovery after a browser reload. The transcript's own
// progress gap is recorded separately and is not used for the assertion.

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
const reconnect = process.env.PROGRESS_RECONNECT === "1";
const doneToken = process.env.PROGRESS_DONE_TOKEN;
const globalDeadlineMs = Number(process.env.PROGRESS_TIMEOUT_MS ?? 240_000);

const progressLine = /Node workspace (scanning|sending|publishing):\s*(?:(\d+)\/(\d+) files,\s*)?([\d.]+) MiB/u;
const counterLine = /(\d+)\/(\d+)/u;

const consoleErrors = [];
const transcriptSamples = [];
const accessorySamples = [];
const screenshots = [];

function readTranscriptProgress(text) {
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
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500));
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 500)}`));

async function openComposer() {
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
  return composer;
}

async function readAccessory() {
  const accessory = page.locator("[data-node-workspace-progress]").first();
  if ((await accessory.count()) === 0) return undefined;
  if (!(await accessory.isVisible().catch(() => false))) return undefined;
  const text = (await accessory.innerText().catch(() => "")).trim();
  if (!text) return undefined;
  const bars = await accessory
    .locator("[data-nodews-bar]")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        value: Number(node.getAttribute("data-value")),
        max: Number(node.getAttribute("data-max")),
      })),
    )
    .catch(() => []);
  const match = counterLine.exec(text);
  return {
    text,
    filesDone: match ? Number(match[1]) : null,
    filesTotal: match ? Number(match[2]) : null,
    bars,
  };
}

let failure;
try {
  const composer = await openComposer();
  fs.writeFileSync(readyFile, "ready\n");
  await composer.fill(prompt);
  await composer.press("Enter");

  const startedAt = Date.now();
  const deadline = startedAt + globalDeadlineMs;
  let lastShotAt = 0;
  let lastCount = "";
  let done = false;
  let reloaded = false;
  let sawReconnectCount = false;

  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText({ timeout: 10_000 });
    const elapsedMs = Date.now() - startedAt;

    const transcript = readTranscriptProgress(text);
    if (transcript.length > 0) {
      transcriptSamples.push({ elapsedMs, progress: transcript.map((entry) => entry.line) });
    }

    const accessory = await readAccessory();
    if (accessory) {
      accessorySamples.push({ elapsedMs, ...accessory, afterReconnect: reloaded });
      if (reloaded && accessory.filesDone !== null && accessory.filesDone > 0) sawReconnectCount = true;
      const countKey = `${accessory.filesDone}/${accessory.filesTotal}|${accessory.bars.map((bar) => bar.value).join(",")}`;
      if (countKey !== lastCount && elapsedMs - lastShotAt >= 300) {
        const file = path.join(outDir, `accessory-${String(screenshots.length).padStart(2, "0")}-${elapsedMs}ms.png`);
        await page.screenshot({ path: file, fullPage: false, timeout: 15_000 });
        screenshots.push({ file, elapsedMs, accessory: accessory.text, afterReconnect: reloaded });
        lastShotAt = elapsedMs;
        lastCount = countKey;
      }
    }

    if (reconnect && !reloaded) {
      const distinct = new Set(
        accessorySamples
          .filter((sample) => sample.filesDone !== null)
          .map((sample) => `${sample.filesDone}/${sample.filesTotal}`),
      );
      if (distinct.size >= 2) {
        const before = accessorySamples.at(-1);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => undefined);
        await openComposer();
        reloaded = true;
        accessorySamples.push({
          elapsedMs: Date.now() - startedAt,
          text: "__reconnect__",
          filesDone: null,
          filesTotal: null,
          bars: [],
          afterReconnect: true,
          beforeReload: before?.text,
        });
        continue;
      }
    }

    if ((text.includes("PROGRESS DONE") && (!doneToken || text.includes(doneToken))) || (!doneToken && text.includes("published:"))) {
      done = true;
      await page.waitForTimeout(600);
      break;
    }
    await page.waitForTimeout(120);
  }

  await page.waitForTimeout(1000);
  const terminalAccessory = await readAccessory();
  const finalText = await page.locator("body").innerText({ timeout: 10_000 });
  const finalShot = path.join(outDir, "final.png");
  await page.screenshot({ path: finalShot, fullPage: false, timeout: 15_000 });
  screenshots.push({ file: finalShot, elapsedMs: Date.now() - startedAt, final: true });

  const distinctCounts = new Map();
  for (const sample of accessorySamples) {
    if (sample.filesDone === null) continue;
    const key = `${sample.filesDone}/${sample.filesTotal}`;
    if (!distinctCounts.has(key)) distinctCounts.set(key, sample);
  }
  const orderedCounts = [...distinctCounts.values()];
  const distinctBarValues = new Set(
    accessorySamples.flatMap((sample) => sample.bars.map((bar) => bar.value)),
  );
  const progressScreenshots = screenshots.filter((shot) => shot.accessory);

  const report = {
    ok: false,
    done,
    reloaded,
    sawReconnectCount,
    terminalAccessory,
    elapsedMs: Date.now() - startedAt,
    distinctAccessoryCounts: orderedCounts.map((sample) => ({ text: sample.text, filesDone: sample.filesDone, filesTotal: sample.filesTotal })),
    distinctBarValues: [...distinctBarValues],
    accessorySamples: accessorySamples.slice(0, 400),
    transcriptProgressLines: [...new Set(transcriptSamples.flatMap((sample) => sample.progress))],
    screenshots,
    consoleErrors,
    finalExcerpt: finalText.slice(-2500),
  };

  const problems = [];
  if (!done) problems.push("the turn did not report completion before the deadline");
  if (orderedCounts.length < 2) {
    problems.push(`the accessory showed ${orderedCounts.length} distinct file count(s); expected at least 2`);
  }
  if (distinctBarValues.size < 2) problems.push("the accessory bar value never changed");
  if (progressScreenshots.length < 2) problems.push("fewer than two screenshots captured the accessory");
  if (reconnect && !reloaded) problems.push("the browser was never reloaded for the reconnect check");
  if (reconnect && !sawReconnectCount) problems.push("the accessory did not show a positive count after reload");
  if (done && !terminalAccessory?.text.includes("✓")) {
    problems.push("the accessory did not show a terminal completion state after the turn ended");
  }
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
    await page.screenshot({ path: finalShot, fullPage: false, timeout: 15_000 });
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
