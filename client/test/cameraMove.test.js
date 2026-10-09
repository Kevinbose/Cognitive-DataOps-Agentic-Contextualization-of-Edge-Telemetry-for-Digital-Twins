/**
 * The animated camera's math: framing a part, choosing the object to frame,
 * easing, and how long a move takes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as THREE from 'three';

import { easeInOutCubic, focusSubject, moveDurationMs, planFocus } from '../src/lib/three-helpers.js';

describe('planFocus', () => {
  const base = {
    cameraPosition: new THREE.Vector3(100, 60, 100),
    orbitTarget: new THREE.Vector3(0, 0, 0),
    fovDeg: 45,
    aspect: 16 / 9,
  };

  it('keeps the viewing direction, pivots on the part and fits it in view', () => {
    const sphere = new THREE.Sphere(new THREE.Vector3(10, 1, -5), 0.5);
    const { position, target, distance } = planFocus({ ...base, sphere });
    assert.deepEqual(target.toArray(), [10, 1, -5]);
    const before = base.cameraPosition.clone().sub(base.orbitTarget).normalize();
    const after = position.clone().sub(target).normalize();
    assert.ok(before.distanceTo(after) < 1e-9, 'same direction');
    // the sphere fits the 45 degree vertical view: r / sin(22.5 deg) * 1.4
    assert.ok(Math.abs(distance - (0.5 / Math.sin(Math.PI / 8)) * 1.4) < 1e-9);
  });

  it('uses the narrower horizontal view on a tall viewport and respects the orbit limits', () => {
    const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
    const wide = planFocus({ ...base, sphere, aspect: 2 }).distance;
    const tall = planFocus({ ...base, sphere, aspect: 0.5 }).distance;
    assert.ok(tall > wide, 'backs off further when the view is narrow');
    assert.equal(planFocus({ ...base, sphere, minDistance: 50 }).distance, 50);
    assert.equal(planFocus({ ...base, sphere: new THREE.Sphere(new THREE.Vector3(), 500), maxDistance: 900 }).distance, 900);
  });
});

describe('focusSubject', () => {
  it('frames the whole node when a multi-material part loads as a group of primitives', () => {
    const group = new THREE.Group();
    group.name = 'PRESS_LUBE_FILTER';
    const piece = new THREE.Mesh();
    piece.name = 'PRESS_LUBE_FILTER_1';
    group.add(piece);
    assert.equal(focusSubject(piece), group);

    const single = new THREE.Mesh();
    single.name = 'PRESS_MAIN_MOTOR';
    new THREE.Group().add(single);
    assert.equal(focusSubject(single), single);
    assert.equal(focusSubject(undefined), undefined);
  });
});

describe('easing and duration', () => {
  it('eases from 0 to 1, slow at both ends', () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(1), 1);
    assert.equal(easeInOutCubic(0.5), 0.5);
    assert.ok(easeInOutCubic(0.1) < 0.1 && easeInOutCubic(0.9) > 0.9);
    assert.equal(easeInOutCubic(2), 1);
  });

  it('takes longer for a longer trip, between 450 and 1200 ms', () => {
    assert.equal(moveDurationMs(0, 100), 450);
    assert.ok(moveDurationMs(50, 100) > moveDurationMs(5, 100));
    assert.equal(moveDurationMs(10_000, 1), 1200);
  });
});
