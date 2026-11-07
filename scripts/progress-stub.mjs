#!/usr/bin/env node
// Scripted, OpenAI-compatible chat-completions server for the progress harness.
//
// It is a model test double with one decision: call node_workspace_push on the
// first request and answer "PROGRESS DONE" once the push result is present.
// Everything else (agent loop, tool dispatch, node transport) is real. The
// harness keeps the fixture large enough that the push is still running while
// the browser screenshots are taken.

import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.STUB_PORT);
const traceFile = process.env.STUB_TRACE;
const pushLocalPath = process.env.STUB_PUSH_LOCAL;
const pushRemotePath = process.env.STUB_PUSH_REMOTE;
const nodeName = process.env.STUB_NODE_NAME ?? "progress-node";

if (!port || !traceFile || !pushLocalPath || !pushRemotePath) {
  console.error("progress-stub: STUB_PORT, STUB_TRACE, STUB_PUSH_LOCAL and STUB_PUSH_REMOTE are required");
  process.exit(2);
}

function trace(event) {
  fs.appendFileSync(traceFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function completedToolCalls(messages) {
  const namesById = new Map();
  const completed = [];
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.id === "string" && typeof call?.function?.name === "string") {
          namesById.set(call.id, call.function.name);
        }
      }
    }
    if (message?.role === "tool") {
      completed.push({
        name: namesById.get(message.tool_call_id) ?? message.name,
        text: toolResultText(message),
      });
    }
  }
  return completed;
}

function toolResultText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  return "";
}

function decide(messages) {
  const completed = completedToolCalls(messages);
  const push = completed.find((entry) => entry.name === "node_workspace_push");
  if (!push) {
    return {
      kind: "tool",
      tool: "node_workspace_push",
      args: { node: nodeName, localPath: pushLocalPath, remotePath: pushRemotePath },
    };
  }
  return { kind: "text", text: "PROGRESS DONE: node_workspace_push returned. " + push.text.slice(0, 120) };
}

function sseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function baseChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-progress",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "progress-scripted",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function respond(res, decision, stream, step) {
  const toolCallId = `call-progress-${step}`;
  if (!stream) {
    const message =
      decision.kind === "tool"
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: { name: decision.tool, arguments: JSON.stringify(decision.args) },
              },
            ],
          }
        : { role: "assistant", content: decision.text };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-progress",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "progress-scripted",
        choices: [{ index: 0, message, finish_reason: decision.kind === "tool" ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sseChunk(res, baseChunk({ role: "assistant", content: "" }));
  if (decision.kind === "tool") {
    sseChunk(res, baseChunk({ content: `step ${step}: ${decision.tool}` }));
    sseChunk(
      res,
      baseChunk({
        tool_calls: [
          {
            index: 0,
            id: toolCallId,
            type: "function",
            function: { name: decision.tool, arguments: JSON.stringify(decision.args) },
          },
        ],
      }),
    );
    sseChunk(res, baseChunk({}, "tool_calls"));
  } else {
    sseChunk(res, baseChunk({ content: decision.text }));
    sseChunk(res, baseChunk({}, "stop"));
  }
  sseChunk(res, {
    id: "chatcmpl-progress",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "progress-scripted",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

let step = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "progress-scripted", object: "model", owned_by: "e2e" }] }));
    return;
  }
  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `unhandled ${req.method} ${url.pathname}` } }));
    return;
  }
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      trace({ kind: "request-invalid", error: String(error) });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }
    step += 1;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const decision = decide(messages);
    trace({
      kind: "request",
      step,
      stream: body.stream === true,
      decision: decision.kind === "tool" ? { tool: decision.tool, args: decision.args } : { text: decision.text },
      toolMessages: messages
        .filter((message) => message?.role === "tool")
        .map((message) => ({ preview: toolResultText(message).slice(0, 300) })),
    });
    respond(res, decision, body.stream === true, step);
  });
});

server.listen(port, "127.0.0.1", () => {
  trace({ kind: "listening", port });
  console.log(`progress-stub listening on ${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
