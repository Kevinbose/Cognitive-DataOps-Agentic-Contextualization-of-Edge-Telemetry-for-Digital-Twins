/**
 * @file The mesh names a twin's `.glb` really contains, and their labels.
 *
 * The agent may only point at meshes that exist, so every name it emits is
 * checked here. Only the GLB's JSON chunk is read (a few hundred kilobytes for
 * a 24 MB plant), never the binary geometry. Names are normalised exactly the
 * way three.js's GLTFLoader names objects, because the viewer binds and tints
 * by those names. Labels come from the node extras (`cdo_label`, `cdo_tags`)
 * that the factory builder writes, which is how "the lubrication unit"
 * resolves to `PRESS_LUBE_UNIT`.
 *
 * The backend still never parses geometry: this is metadata only.
 *
 * @module services/glbIndex.service
 */

import fs from 'node:fs/promises';

import { resolveAbsolutePath } from './storage.service.js';
import { Asset } from '../models/Asset.model.js';

/**
 * three.js `PropertyBinding.sanitizeNodeName`: whitespace to underscores, and
 * the reserved characters `[ ] . : /` removed.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeNodeName(name) {
  return String(name ?? '').replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

/**
 * Read the JSON chunk of a binary glTF.
 *
 * @param {string} absolutePath
 * @returns {Promise<any>}
 */
export async function readGlbJson(absolutePath) {
  const handle = await fs.open(absolutePath, 'r');
  try {
    const header = Buffer.alloc(20);
    await handle.read(header, 0, 20, 0);
    if (header.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a binary glTF');
    const chunkLength = header.readUInt32LE(12);
    const chunkType = header.toString('ascii', 16, 20);
    if (chunkType !== 'JSON') throw new Error('first chunk is not JSON');
    if (chunkLength > 64 * 1024 * 1024) throw new Error('JSON chunk too large');
    const body = Buffer.alloc(chunkLength);
    await handle.read(body, 0, chunkLength, 20);
    return JSON.parse(body.toString('utf8'));
  } finally {
    await handle.close();
  }
}

/**
 * Build the index from a parsed glTF document.
 *
 * @param {any} json
 * @returns {{names: Set<string>, nodes: Array<{meshName: string, label: string|null, zone: string|null,
 *   machineId: string|null, role: string|null, tags: string[], suggestedChannel: string|null}>}}
 */
export function buildIndex(json) {
  const names = new Set();
  const nodes = [];
  const meshes = json.meshes ?? [];
  const meshBaseNames = new Set();

  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined) continue;
    const meshName = sanitizeNodeName(node.name ?? '');
    if (!meshName) continue;
    names.add(meshName);
    const extras = node.extras ?? {};
    nodes.push({
      meshName,
      label: typeof extras.cdo_label === 'string' ? extras.cdo_label : null,
      zone: typeof extras.cdo_zone === 'string' ? extras.cdo_zone : null,
      machineId: typeof extras.cdo_machine === 'string' ? extras.cdo_machine : null,
      role: typeof extras.cdo_role === 'string' ? extras.cdo_role : null,
      tags: typeof extras.cdo_tags === 'string' ? extras.cdo_tags.split(',').filter(Boolean) : [],
      suggestedChannel: typeof extras.cdo_suggested_channel === 'string' ? extras.cdo_suggested_channel : null,
    });
    // A multi-material mesh becomes a group whose child meshes are named after
    // the mesh, with _1, _2 for later primitives (GLTFLoader.createUniqueName).
    const mesh = meshes[node.mesh];
    if (mesh && (mesh.primitives?.length ?? 1) > 1) {
      const base = sanitizeNodeName(mesh.name ?? `mesh_${node.mesh}`);
      meshBaseNames.add(base);
      names.add(base);
    }
  }
  return { names, nodes, meshBaseNames };
}

/** @type {Map<string, {checksum: string, index: ReturnType<typeof buildIndex>}>} */
const cache = new Map();

/**
 * The index for an asset's converted `.glb`, cached until the file changes.
 *
 * @param {string} assetId
 * @returns {Promise<ReturnType<typeof buildIndex>|null>} `null` when the asset has no `.glb`.
 */
export async function getGlbIndex(assetId) {
  const asset = await Asset.findById(assetId).select('convertedFile isDeleted').lean();
  if (!asset || asset.isDeleted || !asset.convertedFile?.storageKey) return null;
  const checksum = asset.convertedFile.checksum ?? asset.convertedFile.storageKey;
  const hit = cache.get(String(assetId));
  if (hit && hit.checksum === checksum) return hit.index;
  const json = await readGlbJson(resolveAbsolutePath(asset.convertedFile.storageKey));
  const index = buildIndex(json);
  cache.set(String(assetId), { checksum, index });
  return index;
}

/**
 * Whether a mesh name exists in the twin as the viewer will name it.
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} meshName
 * @returns {boolean}
 */
export function hasMesh(index, meshName) {
  if (index.names.has(meshName)) return true;
  const m = /^(.+)_(\d+)$/.exec(meshName);
  return Boolean(m && index.meshBaseNames.has(m[1]));
}

export function resetGlbIndexForTests() {
  cache.clear();
}

export default { getGlbIndex, hasMesh, buildIndex, readGlbJson, sanitizeNodeName, resetGlbIndexForTests };
