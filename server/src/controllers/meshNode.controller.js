/**
 * @file Mesh-node HTTP controllers.
 *
 * @module controllers/meshNode.controller
 */

import * as meshNodeService from '../services/meshNode.service.js';
import { sendCreated, sendOk } from '../utils/ApiResponse.js';

/**
 * `GET /api/v1/assets/:assetId/mesh-nodes` — list registered nodes.
 *
 * @type {import('express').RequestHandler}
 */
export async function listMeshNodes(req, res) {
  const meshNodes = await meshNodeService.listMeshNodes(req.params.assetId, {
    mappedOnly: req.query.mappedOnly,
  });

  return sendOk(res, meshNodes, 'Mesh nodes retrieved');
}

/**
 * `POST /api/v1/assets/:assetId/mesh-nodes` — register a node without binding.
 *
 * @type {import('express').RequestHandler}
 */
export async function registerMeshNode(req, res) {
  const meshNode = await meshNodeService.registerMeshNode({
    assetId: req.params.assetId,
    meshName: req.body.meshName,
    displayName: req.body.displayName,
    nodePath: req.body.nodePath,
    objectType: req.body.objectType,
    createdBy: req.body.createdBy,
  });

  return sendCreated(res, meshNode, 'Mesh node registered');
}

/**
 * `PATCH /api/v1/mesh-nodes/:meshNodeId` — update node labels.
 *
 * @type {import('express').RequestHandler}
 */
export async function updateMeshNode(req, res) {
  const meshNode = await meshNodeService.updateMeshNode(req.params.meshNodeId, req.body);
  return sendOk(res, meshNode, 'Mesh node updated');
}

/**
 * `DELETE /api/v1/mesh-nodes/:meshNodeId` — soft delete and unbind.
 *
 * @type {import('express').RequestHandler}
 */
export async function deleteMeshNode(req, res) {
  const summary = await meshNodeService.softDeleteMeshNode(req.params.meshNodeId);
  return sendOk(res, summary, 'Mesh node deleted');
}

export default { listMeshNodes, registerMeshNode, updateMeshNode, deleteMeshNode };
