/**
 * Named camera presets carried inside a model (VIEW_<NAME> and its _TARGET),
 * which the twin viewer uses as the starting view when present.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as THREE from 'three';

import { computeFramingForObject, findNamedView } from '../src/lib/three-helpers.js';

function node(name, x, y, z) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

describe('findNamedView', () => {
  it('returns the world positions of VIEW_HOME and VIEW_HOME_TARGET', () => {
    const root = new THREE.Group();
    const parent = new THREE.Group();
    parent.position.set(10, 0, 0);
    root.add(parent);
    parent.add(node('VIEW_HOME', 1, 2, 3));
    root.add(node('VIEW_HOME_TARGET', 0, 0, -5));

    const view = findNamedView(root);
    assert.deepEqual(view.position.toArray(), [11, 2, 3], 'parent transforms are applied');
    assert.deepEqual(view.target.toArray(), [0, 0, -5]);
  });

  it('finds other presets by name', () => {
    const root = new THREE.Group();
    root.add(node('VIEW_PRESS_STAMP_01', 4, 5, 6), node('VIEW_PRESS_STAMP_01_TARGET', 1, 1, 1));
    assert.deepEqual(findNamedView(root, 'PRESS_STAMP_01').position.toArray(), [4, 5, 6]);
    assert.equal(findNamedView(root), null, 'no HOME preset in this model');
  });

  it('returns null unless both the eye and its target exist', () => {
    const root = new THREE.Group();
    root.add(node('VIEW_HOME', 1, 1, 1));
    assert.equal(findNamedView(root), null);
  });

  it('does not let the empty preset nodes change the default framing', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)));
    const camera = new THREE.PerspectiveCamera(45, 1.6, 0.1, 1000);
    const before = computeFramingForObject(root, camera);
    root.add(node('VIEW_HOME', 500, 500, 500), node('VIEW_HOME_TARGET', -500, 0, 0));
    const after = computeFramingForObject(root, camera);
    assert.ok(before.position.equals(after.position), 'empties carry no geometry, so the bounds are unchanged');
  });
});
