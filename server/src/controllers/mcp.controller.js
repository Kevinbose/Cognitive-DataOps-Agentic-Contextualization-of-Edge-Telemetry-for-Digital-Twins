/**
 * @file Hands one HTTP request to a fresh, stateless MCP server.
 *
 * @module controllers/mcp.controller
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createMcpServer } from '../mcp/server.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * `POST /mcp`: one JSON-RPC exchange.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleMcp(req, res) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/** `GET` and `DELETE /mcp`: sessions and server-sent streams are not offered. */
export function mcpMethodNotAllowed(_req, _res, next) {
  next(new ApiError(405, 'This MCP endpoint is stateless: POST JSON-RPC requests only'));
}

export default { handleMcp, mcpMethodNotAllowed };
