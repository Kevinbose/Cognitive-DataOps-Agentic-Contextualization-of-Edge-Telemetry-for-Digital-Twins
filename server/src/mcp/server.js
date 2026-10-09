/**
 * @file The MCP server: the tool catalogue over Streamable HTTP, stateless.
 *
 * A fresh server and transport per request (the SDK's stateless pattern):
 * nothing is held between calls, so a restart of either side needs no session
 * recovery. Each tool call is rate limited per tool, its result has `sim`
 * stripped, and an error comes back as an MCP error result the model can read,
 * never as a stack trace.
 *
 * @module mcp/server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { stripSim, TOOLS } from './tools.js';

const CALLS_PER_MINUTE = 120;
/** @type {Map<string, number[]>} */
const recent = new Map();

function allow(tool) {
  const now = Date.now();
  const list = (recent.get(tool) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= CALLS_PER_MINUTE) {
    recent.set(tool, list);
    return false;
  }
  list.push(now);
  recent.set(tool, list);
  return true;
}

/**
 * Build a server with every tool registered.
 *
 * @returns {McpServer}
 */
export function createMcpServer() {
  const server = new McpServer({ name: 'cognitive-dataops', version: '1.0.0' });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input },
      async (args) => {
        if (!allow(tool.name)) {
          return { isError: true, content: [{ type: 'text', text: `rate limit: ${tool.name} allows ${CALLS_PER_MINUTE} calls a minute` }] };
        }
        try {
          const data = stripSim(await tool.handler(args ?? {}));
          return { content: [{ type: 'text', text: JSON.stringify(data) }] };
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: `${tool.name} failed: ${error.message}` }] };
        }
      },
    );
  }
  return server;
}

export function resetMcpRateLimitsForTests() {
  recent.clear();
}

export default { createMcpServer, resetMcpRateLimitsForTests };
