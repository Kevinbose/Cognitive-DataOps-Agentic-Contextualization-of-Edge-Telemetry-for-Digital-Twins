/**
 * @file Thin HTTP adapters for investigations, reports and the assistant.
 *
 * @module controllers/agent.controller
 */

import * as assistantService from '../services/assistant.service.js';
import * as investigationService from '../services/investigation.service.js';
import { sendOk } from '../utils/ApiResponse.js';

export async function getStatus(_req, res) {
  return sendOk(res, await assistantService.getAgentStatus(), 'Agent status');
}

export async function listInvestigations(req, res) {
  const { assetId, active, limit } = req.query;
  const items = await investigationService.listInvestigations({ assetId: assetId ?? null, activeOnly: active, limit });
  return sendOk(res, items, 'Investigations retrieved');
}

export async function listReports(req, res) {
  const { assetId, machineId, limit } = req.query;
  const items = await investigationService.listReports({ assetId: assetId ?? null, machineId: machineId ?? null, limit });
  return sendOk(res, items, 'Reports retrieved');
}

export async function getReport(req, res) {
  return sendOk(res, await investigationService.getReportOrThrow(req.params.reportId), 'Report retrieved');
}

export async function chat(req, res) {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  await assistantService.streamChat(req.body, {
    open(status) {
      res.status(status);
      res.set({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders();
    },
    write: (text) => res.write(text),
    close: () => res.end(),
    signal: controller.signal,
  });
}

export async function getThread(req, res) {
  return sendOk(res, await assistantService.getConversation(req.params.threadId), 'Conversation retrieved');
}

export default { getStatus, listInvestigations, listReports, getReport, chat, getThread };
