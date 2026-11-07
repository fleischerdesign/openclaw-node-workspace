#!/usr/bin/env node
// Scripted, OpenAI-compatible chat-completions server for the isolated
// end-to-end test. It is a test double for the model, not a model: every
// response is fixed by the conversation state recorded in the request.
//
// The script it plays is the one the plugin's README promises:
//   1. node_workspace_push  -> publish a Gateway directory to the node
//   2. exec (host=node)     -> run a command in the returned cwd
//   3. node_workspace_artifact -> fetch the produced file back
//   4. final assistant text
//
// Every request and response is appended to TRACE_FILE as JSON lines so the
// shell harness can assert what actually crossed the wire.

import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.STUB_PORT);
const traceFile = process.env.STUB_TRACE;
const pushLocalPath = process.env.STUB_PUSH_LOCAL;
const pushRemotePath = process.env.STUB_PUSH_REMOTE;
const nodeName = process.env.STUB_NODE_NAME ?? "e2e-node";
const artifactRemotePath = process.env.STUB_ARTIFACT_REMOTE;
const artifactLocalPath = process.env.STUB_ARTIFACT_LOCAL;
const execCommand = process.env.STUB_EXEC_COMMAND ?? "pwd && cat hello.txt && printf 'from node exec\\n' > exec-result.txt";

if (!port || !traceFile || !pushLocalPath || !pushRemotePath || !artifactRemotePath || !artifactLocalPath) {
  console.error("model-stub: STUB_PORT, STUB_TRACE, STUB_PUSH_LOCAL, STUB_PUSH_REMOTE, STUB_ARTIFACT_REMOTE and STUB_ARTIFACT_LOCAL are required");
  process.exit(2);
}

function trace(event) {
  fs.appendFileSync(traceFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => tool?.function?.name ?? tool?.name).filter((name) => typeof name === "string");
}

// Tool results arrive as role "tool" with the call id; the name lives on the
// assistant message that requested the call. Rebuild the pair so the script
// works against any provider-shaped transcript.
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
        callId: message.tool_call_id,
        message,
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

// The model's memory between calls: the push result carries the cwd the exec
// must use, so the stub reads it back from the tool message instead of
// guessing.
function pushCwdFromMessages(completed) {
  for (const entry of completed) {
    if (entry.name !== "node_workspace_push") continue;
    const text = toolResultText(entry.message);
    const match = /at (\S+) on node /.exec(text);
    if (match) return match[1];
  }
  return undefined;
}

function decideStep(messages) {
  const completed = completedToolCalls(messages);
  const names = completed.map((entry) => entry.name).filter(Boolean);
  const pushEntry = completed.find((entry) => entry.name === "node_workspace_push");
  const pushFailed = pushEntry
    ? !/^(published|already present):/.test(toolResultText(pushEntry.message))
    : false;
  if (!names.includes("node_workspace_push") || pushFailed) {
    return {
      kind: "tool",
      tool: "node_workspace_push",
      args: { node: nodeName, localPath: pushLocalPath, remotePath: pushRemotePath },
    };
  }
  const cwd = pushCwdFromMessages(completed);
  if (!names.includes("exec")) {
    if (!cwd) return { kind: "text", text: "push result did not contain a cwd; cannot continue" };
    return {
      kind: "tool",
      tool: "exec",
      args: { host: "node", node: nodeName, workdir: cwd, command: execCommand },
    };
  }
  if (!names.includes("node_workspace_artifact")) {
    return {
      kind: "tool",
      tool: "node_workspace_artifact",
      args: { node: nodeName, remotePath: artifactRemotePath, localPath: artifactLocalPath },
    };
  }
  const artifact = completed.find((entry) => entry.name === "node_workspace_artifact");
  return {
    kind: "text",
    text: `E2E complete: pushed ${pushRemotePath}, executed in ${cwd}, fetched ${artifactRemotePath}. ${toolResultText(artifact?.message)}`.trim(),
  };
}

function sseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function baseChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "scripted-e2e",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function respond(res, decision, stream, summary) {
  const toolCallId = `call-e2e-${summary.step}`;
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
    const body = {
      id: "chatcmpl-e2e",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "scripted-e2e",
      choices: [{ index: 0, message, finish_reason: decision.kind === "tool" ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sseChunk(res, baseChunk({ role: "assistant", content: "" }));
  if (decision.kind === "tool") {
    sseChunk(res, baseChunk({ content: `step ${summary.step}: ${decision.tool}` }));
    sseChunk(res, baseChunk({ content: null }));
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
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "scripted-e2e",
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
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "scripted-e2e", object: "model", owned_by: "e2e" }],
      }),
    );
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
      trace({ kind: "request-invalid", error: String(error), raw: raw.slice(0, 2000) });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }
    step += 1;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = toolNames(body.tools);
    const roles = messages.map((message) => message.role);
    const toolMessages = messages
      .filter((message) => message?.role === "tool")
      .map((message) => ({
        callId: message.tool_call_id,
        preview: toolResultText(message).slice(0, 300),
      }));
    const hasTools = tools.length > 0;
    const decision = hasTools
      ? decideStep(messages)
      : { kind: "text", text: "scripted assistant reply" };
    trace({
      kind: "request",
      step,
      stream: body.stream === true,
      tools,
      roles,
      toolMessages,
      systemPreview: typeof messages[0]?.content === "string" ? messages[0].content.slice(0, 200) : undefined,
      decision: decision.kind === "tool" ? { tool: decision.tool, args: decision.args } : { text: decision.text },
    });
    respond(res, decision, body.stream === true, { step });
  });
});

server.listen(port, "127.0.0.1", () => {
  trace({ kind: "listening", port });
  console.log(`model-stub listening on ${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
