#!/usr/bin/env node
/**
 * Trivial zero-dependency MCP server used to prove Amuse's MCP client.
 * Tools: echo, add, server_info (readOnlyHint on all three).
 * Transports: stdio (default, NDJSON) or streamable HTTP:  node server.mjs --http <port>
 */
import http from "node:http";
import os from "node:os";
import readline from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the given message.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add",
    description: "Add two numbers and return the sum.",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "server_info",
    description: "Describe the machine/process this proof server is running on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

function handle(msg, transport) {
  if (!msg || msg.jsonrpc !== "2.0") return null;
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "amuse-mcp-proof", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const text = (t, isError = false) => ok({ content: [{ type: "text", text: t }], isError });
      if (name === "echo") return text(String(args.message ?? ""));
      if (name === "add") return text(String(Number(args.a ?? 0) + Number(args.b ?? 0)));
      if (name === "server_info")
        return text(JSON.stringify({ server: "amuse-mcp-proof", transport, hostname: os.hostname(), platform: process.platform, node: process.version, pid: process.pid }));
      return text(`Unknown tool ${name}`, true);
    }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

const httpPort = (() => {
  const i = process.argv.indexOf("--http");
  return i >= 0 ? Number(process.argv[i + 1] ?? 8125) : null;
})();

if (httpPort) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
        return;
      }
      const reply = handle(msg, "http");
      if (reply === null) {
        res.writeHead(202).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": "proof-stateless" })
        .end(JSON.stringify(reply));
    });
  });
  server.listen(httpPort, "0.0.0.0", () => console.error(`amuse-mcp-proof http on :${httpPort}`));
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      return;
    }
    const reply = handle(msg, "stdio");
    if (reply !== null) process.stdout.write(JSON.stringify(reply) + "\n");
  });
}
