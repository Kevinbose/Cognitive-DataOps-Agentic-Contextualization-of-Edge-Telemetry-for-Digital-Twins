/**
 * The compositor touches GPU materials that the real asset packs SHARE across
 * hundreds of meshes, so the properties that matter are about not corrupting
 * them: never edit a shared material, always restore, never leak a clone.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { configureStore } from '@reduxjs/toolkit';
import * as THREE from 'three';

import {
  MaterialTinter,
  TONES,
  computeLayers,
  indexMeshesByName,
} from '../src/features/twin-viewer/scene/highlightCompositor.js';
import twinViewerReducer, {
  FLASH_DURATION_MS,
  flashMesh,
} from '../src/features/twin-viewer/twinViewerSlice.js';

const geometry = new THREE.BoxGeometry(1, 1, 1);
const mesh = (name, material) => {
  const m = new THREE.Mesh(geometry, material);
  m.name = name;
  return m;
};
const none = { selectedMeshName: null, hoveredMeshName: null, highlights: {}, alarmTints: [] };

describe('computeLayers: one winning layer per mesh', () => {
  it('ranks agent over alarm over warn over flash over selection over hover', () => {
    const order = ['hover', 'select', 'flash', 'warn', 'alarm', 'agent'];
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(TONES[order[i]].priority > TONES[order[i - 1]].priority, `${order[i]} > ${order[i - 1]}`);
    }
  });

  it('lets a live alarm outrank selection, hover and a bind flash on the same mesh', () => {
    const layers = computeLayers({
      selectedMeshName: 'pump',
      hoveredMeshName: 'pump',
      highlights: { pump: [{ source: 'flash' }] },
      alarmTints: [['pump', 'alarm']],
    });
    assert.equal(layers.get('pump').tone, 'alarm');
  });

  it('shows the flash over a plain selection, and the selection over hover', () => {
    const flashed = computeLayers({ ...none, selectedMeshName: 'a', highlights: { a: [{ source: 'flash' }] } });
    assert.equal(flashed.get('a').tone, 'flash');

    const selected = computeLayers({ ...none, selectedMeshName: 'a', hoveredMeshName: 'b' });
    assert.equal(selected.get('a').tone, 'select');
    assert.equal(selected.get('b').tone, 'hover');
  });

  it('does not add a hover tint to the mesh that is already selected', () => {
    const layers = computeLayers({ ...none, selectedMeshName: 'a', hoveredMeshName: 'a' });
    assert.equal(layers.get('a').tone, 'select');
    assert.equal(layers.size, 1);
  });

  it('puts the agent above everything, and pulses it', () => {
    const layers = computeLayers({
      ...none,
      alarmTints: [['a', 'alarm']],
      highlights: { a: [{ source: 'agent', pulse: true }] },
    });
    assert.deepEqual(layers.get('a'), { tone: 'agent', pulse: true });
  });

  it('pulses alarm but holds warn steady', () => {
    const layers = computeLayers({ ...none, alarmTints: [['a', 'alarm'], ['b', 'warn']] });
    assert.equal(layers.get('a').pulse, true);
    assert.equal(layers.get('b').pulse, false);
  });

  it('gives nothing for no input', () => {
    assert.equal(computeLayers(none).size, 0);
    assert.equal(computeLayers({}).size, 0);
  });
});

describe('MaterialTinter', () => {
  const layerOf = (tone, pulse = TONES[tone].pulse) => new Map([['a', { tone, pulse }]]);

  it('never edits a SHARED material: only the tinted mesh gets a private clone', () => {
    const shared = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const a = mesh('a', shared);
    const b = mesh('b', shared);
    const tinter = new MaterialTinter(new Map([['a', a], ['b', b]]));

    tinter.apply(layerOf('alarm'));

    assert.notEqual(a.material, shared, 'a wears a clone');
    assert.equal(b.material, shared, 'b is untouched');
    assert.equal(shared.emissive.getHex(), 0x000000, 'the shared material was not recoloured');
    assert.equal(shared.emissiveIntensity, 1);
    assert.equal(a.material.emissive.getHexString(), TONES.alarm.color.slice(1));
  });

  it('gives two meshes that shared a material DIFFERENT colours, independently', () => {
    const shared = new THREE.MeshStandardMaterial();
    const a = mesh('a', shared);
    const b = mesh('b', shared);
    const tinter = new MaterialTinter(new Map([['a', a], ['b', b]]));

    tinter.apply(new Map([['a', { tone: 'alarm', pulse: false }], ['b', { tone: 'flash', pulse: false }]]));

    assert.notEqual(a.material, b.material);
    assert.notEqual(a.material.emissive, b.material.emissive, 'each clone owns its Color');
    assert.equal(a.material.emissive.getHexString(), TONES.alarm.color.slice(1));
    assert.equal(b.material.emissive.getHexString(), TONES.flash.color.slice(1));
  });

  it('respects a multi-material mesh instead of flattening it to the first material', () => {
    const one = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const two = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const m = mesh('a', [one, two]);
    const tinter = new MaterialTinter(new Map([['a', m]]));

    tinter.apply(layerOf('select'));

    assert.ok(Array.isArray(m.material));
    assert.equal(m.material.length, 2);
    for (const clone of m.material) {
      assert.equal(clone.emissive.getHexString(), TONES.select.color.slice(1));
    }
    assert.equal(m.material[0].color.getHex(), 0xff0000, 'each material keeps its own base colour');
    assert.equal(m.material[1].color.getHex(), 0x00ff00);

    tinter.apply(new Map());
    assert.deepEqual(m.material, [one, two]);
  });

  it('restores the original and disposes the clone when no layer remains', () => {
    const original = new THREE.MeshStandardMaterial();
    const m = mesh('a', original);
    const tinter = new MaterialTinter(new Map([['a', m]]));

    tinter.apply(layerOf('alarm'));
    const clone = m.material;
    const dispose = mock.method(clone, 'dispose');

    tinter.apply(new Map());

    assert.equal(m.material, original);
    assert.equal(dispose.mock.callCount(), 1, 'the clone is released');
    assert.equal(tinter.applied.size, 0);
  });

  it('updates in place when the tone changes, without cloning again', () => {
    const original = new THREE.MeshStandardMaterial();
    const clones = mock.method(original, 'clone');
    const m = mesh('a', original);
    const tinter = new MaterialTinter(new Map([['a', m]]));

    tinter.apply(layerOf('hover'));
    const first = m.material;
    tinter.apply(layerOf('select'));
    tinter.apply(layerOf('alarm'));

    assert.equal(m.material, first, 'same clone reused');
    assert.equal(clones.mock.callCount(), 1, 'cloned exactly once');
    assert.equal(first.emissive.getHexString(), TONES.alarm.color.slice(1));
  });

  it('is idempotent: applying the same layers again leaks nothing', () => {
    const original = new THREE.MeshStandardMaterial();
    const clones = mock.method(original, 'clone');
    const m = mesh('a', original);
    const tinter = new MaterialTinter(new Map([['a', m]]));

    for (let i = 0; i < 5; i += 1) tinter.apply(layerOf('select'));
    assert.equal(clones.mock.callCount(), 1);
    assert.equal(tinter.applied.size, 1);
  });

  it('tints a material with no emissive channel through its colour', () => {
    const m = mesh('a', new THREE.MeshBasicMaterial({ color: 0x888888 }));
    const tinter = new MaterialTinter(new Map([['a', m]]));
    tinter.apply(layerOf('flash'));
    assert.equal(m.material.color.getHexString(), TONES.flash.color.slice(1));
  });

  it('ignores a layer for a mesh it does not know', () => {
    const tinter = new MaterialTinter(new Map());
    assert.doesNotThrow(() => tinter.apply(layerOf('alarm')));
    assert.equal(tinter.applied.size, 0);
  });

  it('does not overwrite a material that something else swapped in meanwhile', () => {
    const original = new THREE.MeshStandardMaterial();
    const m = mesh('a', original);
    const tinter = new MaterialTinter(new Map([['a', m]]));
    tinter.apply(layerOf('alarm'));

    const replacement = new THREE.MeshStandardMaterial();
    m.material = replacement;
    tinter.apply(new Map());

    assert.equal(m.material, replacement);
  });

  it('dispose() restores every mesh', () => {
    const originals = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    const meshes = originals.map((material, i) => mesh(`m${i}`, material));
    const tinter = new MaterialTinter(new Map(meshes.map((m) => [m.name, m])));

    tinter.apply(new Map(meshes.map((m) => [m.name, { tone: 'select', pulse: false }])));
    tinter.dispose();

    meshes.forEach((m, i) => assert.equal(m.material, originals[i]));
  });

  describe('pulse', () => {
    it('breathes an alarm between 70 and 100 percent of its intensity', () => {
      const m = mesh('a', new THREE.MeshStandardMaterial());
      const tinter = new MaterialTinter(new Map([['a', m]]));
      tinter.apply(layerOf('alarm'));

      const seen = [];
      for (let t = 0; t < 3; t += 0.05) {
        tinter.tick(t, false);
        seen.push(m.material.emissiveIntensity);
      }
      const base = TONES.alarm.intensity;
      assert.ok(Math.min(...seen) >= base * 0.7 - 1e-9);
      assert.ok(Math.max(...seen) <= base + 1e-9);
      assert.ok(Math.max(...seen) - Math.min(...seen) > 0.1, 'it actually moves');
    });

    it('holds steady at full intensity under reduced motion', () => {
      const m = mesh('a', new THREE.MeshStandardMaterial());
      const tinter = new MaterialTinter(new Map([['a', m]]));
      tinter.apply(layerOf('alarm'));

      for (const t of [0, 0.3, 1.1, 2.7]) {
        tinter.tick(t, true);
        assert.equal(m.material.emissiveIntensity, TONES.alarm.intensity);
      }
    });

    it('does not touch a steady tone, and stops pulsing once the tone changes', () => {
      const m = mesh('a', new THREE.MeshStandardMaterial());
      const tinter = new MaterialTinter(new Map([['a', m]]));

      tinter.apply(layerOf('select'));
      tinter.tick(1.234, false);
      assert.equal(m.material.emissiveIntensity, TONES.select.intensity);

      tinter.apply(layerOf('alarm'));
      assert.equal(tinter.pulsing.size, 1);
      tinter.apply(layerOf('select'));
      assert.equal(tinter.pulsing.size, 0);
    });
  });
});

describe('indexMeshesByName', () => {
  it('keeps the first mesh of a duplicated name and skips unnamed meshes', () => {
    const root = new THREE.Group();
    const first = mesh('dup', new THREE.MeshStandardMaterial());
    const second = mesh('dup', new THREE.MeshStandardMaterial());
    const unnamed = mesh('', new THREE.MeshStandardMaterial());
    root.add(first, second, unnamed, new THREE.Group());

    const map = indexMeshesByName(root);
    assert.equal(map.size, 1);
    assert.equal(map.get('dup'), first);
  });
});

describe('flashMesh', () => {
  const makeStore = () => configureStore({ reducer: { twinViewer: twinViewerReducer } });

  it('adds a flash and removes exactly that flash when its timer fires', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const store = makeStore();
      store.dispatch(flashMesh('pump'));
      assert.equal(store.getState().twinViewer.highlights.pump.length, 1);

      mock.timers.tick(FLASH_DURATION_MS - 1);
      assert.equal(store.getState().twinViewer.highlights.pump.length, 1);
      mock.timers.tick(1);
      assert.equal(store.getState().twinViewer.highlights.pump, undefined);
    } finally {
      mock.timers.reset();
    }
  });

  it('never lets an older flash timer clear a newer flash on the same mesh', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const store = makeStore();
      store.dispatch(flashMesh('pump'));
      mock.timers.tick(1000);
      store.dispatch(flashMesh('pump')); // a second bind 1 s into the first flash

      mock.timers.tick(FLASH_DURATION_MS - 1000); // the FIRST timer fires now
      const remaining = store.getState().twinViewer.highlights.pump;
      assert.equal(remaining?.length, 1, 'the newer flash survives the older timer');

      mock.timers.tick(1000); // the second timer fires
      assert.equal(store.getState().twinViewer.highlights.pump, undefined);
    } finally {
      mock.timers.reset();
    }
  });
});
