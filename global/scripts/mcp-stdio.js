#!/usr/bin/env node
/**
 * Minimal MCP stdio server helper (newline-delimited JSON-RPC 2.0).
 * Zero dependencies. Used by aacp-codec-mcp.js and a2a-registry-mcp.js.
 *
 *   serveMcp({ name, version, tools: { toolName: { description, inputSchema, handler } } })
 */
"use strict";

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function dispatch(req, tools) {
  const { id, method, params } = req;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "", version: "" },
      },
    };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: Object.entries(tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema || { type: "object", properties: {} },
        })),
      },
    };
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = tools[name];
    if (!tool) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true } };
    }
    try {
      const value = await tool.handler(args);
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } };
    } catch (err) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: err.message }], isError: true } };
    }
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

function serveMcp({ name, version = "2.0.0", tools = {} }) {
  const meta = { name, version };
  let buffer = "";
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      let res;
      try {
        res = await dispatch(req, tools);
        if (res && res.result && res.result.serverInfo) res.result.serverInfo = meta;
      } catch (err) {
        res = { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: err.message } };
      }
      if (res) write(res);
    }
  });

  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`${name} MCP server v${version} ready\n`);
}

module.exports = { serveMcp };
