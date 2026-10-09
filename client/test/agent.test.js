/**
 * The assistant's browser state: the event-stream parser, the chat thread
 * reducer, and the agent's commands reaching the 3D view (only on its twin).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { combineReducers, configureStore } from '@reduxjs/toolkit';

import agentReducer, {
  alertReceived,
  reportOpened,
  streamEnded,
  streamEvent,
  threadHydrated,
  twinOpened,
  userAsked,
} from '../src/features/agent/agentSlice.js';
import { scopeKeyOf } from '../src/features/agent/session.js';
import { parseSseChunk } from '../src/features/agent/sse.js';
import { applyUiCommands, clearAgentHighlights } from '../src/features/agent/uiCommands.js';
import twinViewerReducer, { selectMesh } from '../src/features/twin-viewer/twinViewerSlice.js';

function store() {
  return configureStore({ reducer: combineReducers({ agent: agentReducer, twinViewer: twinViewerReducer }) });
}

describe('event-stream parser', () => {
  it('splits complete events and keeps the partial tail for the next chunk', () => {
    const { events, rest } = parseSseChunk('event: token\ndata: {"text":"Lube "}\n\nevent: token\ndata: {"text":"oil"}\n\nevent: do');
    assert.deepEqual(events, [
      { event: 'token', data: { text: 'Lube ' } },
      { event: 'token', data: { text: 'oil' } },
    ]);
    assert.equal(rest, 'event: do');
  });

  it('accepts CRLF line ends', () => {
    const { events } = parseSseChunk('event: done\r\ndata: {}\r\n\r\n');
    assert.deepEqual(events, [{ event: 'done', data: {} }]);
  });
});

describe('chat threads', () => {
  const key = scopeKeyOf('twin', '65f0c0ffee0000000000abcd');

  it('keeps one conversation per scope', () => {
    assert.equal(scopeKeyOf('plant', 'x'), 'plant');
    assert.equal(key, 'twin-65f0c0ffee0000000000abcd');
  });

  it('fills an answer from streamed events: steps, text, sources, offline flag', () => {
    const s = store();
    s.dispatch(userAsked({ key, threadId: 'chat-t-1', id: 'm1', text: 'Why is the pressure low?', scopeName: 'Car factory', partLabel: null }));
    const ev = (event, data) => s.dispatch(streamEvent({ key, id: 'm1', event, data }));
    ev('status', { text: 'Reading the twin' });
    ev('step', { id: 's1', kind: 'context', label: 'Reading the twin', state: 'start' });
    ev('step', { id: 's1', kind: 'context', label: 'Reading the twin', state: 'done', detail: '2 machines on this twin', ms: 40 });
    ev('step', { id: 's2', kind: 'tool', label: 'Searching the manuals', state: 'start', detail: 'F01 signature' });
    ev('step', { id: 's2', kind: 'tool', label: 'Searching the manuals', state: 'done', sources: [{ ref: 'S1', document: 'Failure modes', page: 6 }] });
    ev('token', { text: 'Most likely F01 ' });
    ev('token', { text: 'CLOGGED_FILTER [S1].' });
    ev('citations', { items: [{ chunkId: 'press-stamp-01:02:005', ref: 'S1', document: 'Failure modes', page: 6 }] });
    ev('meta', { degraded: true, model: null });
    ev('done', {});
    s.dispatch(streamEnded({ key, id: 'm1' }));

    const thread = s.getState().agent.threads[key];
    assert.equal(thread.busy, false);
    const [user, answer] = thread.messages;
    assert.equal(user.scopeName, 'Car factory');
    assert.equal(answer.text, 'Most likely F01 CLOGGED_FILTER [S1].');
    assert.equal(answer.status, 'done');
    assert.deepEqual(answer.steps.map((x) => [x.id, x.state]), [['s1', 'done'], ['s2', 'done']]);
    assert.equal(answer.steps[0].detail, '2 machines on this twin');
    assert.equal(answer.steps[1].sources[0].document, 'Failure modes');
    assert.equal(answer.citations[0].ref, 'S1');
    assert.equal(answer.degraded, true);
  });

  it('marks a stopped answer as stopped, not as a fault', () => {
    const s = store();
    s.dispatch(userAsked({ key, threadId: 'chat-t-9', id: 'm9', text: 'long one', scopeName: null, partLabel: null }));
    s.dispatch(streamEvent({ key, id: 'm9', event: 'step', data: { id: 's1', kind: 'model', label: 'Asking the model', state: 'start' } }));
    s.dispatch(streamEvent({ key, id: 'm9', event: 'token', data: { text: 'Half an ans' } }));
    s.dispatch(streamEnded({ key, id: 'm9', stopped: true }));
    const answer = s.getState().agent.threads[key].messages[1];
    assert.equal(answer.status, 'error');
    assert.equal(answer.error, 'Stopped.');
    assert.ok(answer.steps.every((x) => x.state !== 'error'), 'a stopped step is not a failure');
  });

  it('marks an answer that never arrived as an error, with a reason', () => {
    const s = store();
    s.dispatch(userAsked({ key, threadId: 'chat-t-2', id: 'm2', text: 'hi', scopeName: null, partLabel: null }));
    s.dispatch(streamEnded({ key, id: 'm2' }));
    const answer = s.getState().agent.threads[key].messages[1];
    assert.equal(answer.status, 'error');
    assert.match(answer.error, /cut off/);
  });

  it('restores a stored transcript without overwriting a question typed meanwhile', () => {
    const s = store();
    s.dispatch(threadHydrated({ key, threadId: 'chat-t-3', messages: [{ role: 'user', text: 'old' }, { role: 'assistant', text: 'answer' }] }));
    assert.equal(s.getState().agent.threads[key].messages.length, 2);
    s.dispatch(threadHydrated({ key, threadId: 'chat-t-3', messages: [{ role: 'user', text: 'other' }] }));
    assert.equal(s.getState().agent.threads[key].messages[0].text, 'old');
  });
});

describe('the agent pointing at the twin', () => {
  const asset = '65f0c0ffee0000000000abcd';

  it('applies highlight, focus and report commands only on the twin they are for', () => {
    const s = store();
    s.dispatch(applyUiCommands({ assetId: asset, commands: [{ type: 'highlight', meshName: 'PRESS_LUBE_FILTER' }] }));
    assert.deepEqual(s.getState().twinViewer.highlights, {}, 'no twin open: ignored');

    s.dispatch(twinOpened(asset));
    s.dispatch(applyUiCommands({
      assetId: asset,
      commands: [
        { type: 'highlight', meshName: 'PRESS_LUBE_FILTER', label: 'Lube oil filter bank', durationMs: 60_000 },
        { type: 'camera_focus', meshName: 'PRESS_LUBE_FILTER' },
        { type: 'open_report', reportId: '65f0c0ffee00000000000001' },
      ],
    }));
    const { twinViewer, agent } = s.getState();
    assert.equal(twinViewer.highlights.PRESS_LUBE_FILTER[0].source, 'agent');
    assert.deepEqual(
      { action: twinViewer.cameraCommand.action, meshName: twinViewer.cameraCommand.meshName },
      { action: 'focus', meshName: 'PRESS_LUBE_FILTER' },
    );
    assert.equal(agent.openReportId, '65f0c0ffee00000000000001');
    assert.equal(agent.pointer.label, 'Lube oil filter bank');

    s.dispatch(applyUiCommands({ assetId: 'ffffffffffffffffffffffff', commands: [{ type: 'clear_highlights' }] }));
    assert.ok(s.getState().twinViewer.highlights.PRESS_LUBE_FILTER, 'a command for another twin changes nothing');

    s.dispatch(clearAgentHighlights());
    assert.deepEqual(s.getState().twinViewer.highlights, {});
    assert.equal(s.getState().agent.pointer, null);
  });

  it('closes the report when a part is picked, and keeps one alert per report', () => {
    const s = store();
    s.dispatch(reportOpened('65f0c0ffee00000000000001'));
    s.dispatch(selectMesh('PRESS_MAIN_MOTOR'));
    assert.equal(s.getState().agent.openReportId, null);
    s.dispatch(alertReceived({ reportId: 'r1', headline: 'x' }));
    s.dispatch(alertReceived({ reportId: 'r1', headline: 'x' }));
    assert.equal(s.getState().agent.alerts.length, 1);
  });
});

describe('machine names', () => {
  it('come from the device registry, never from a built-in list', async () => {
    const { machineLabel } = await import('../src/features/agent/components/levels.js');
    assert.equal(machineLabel('press-line-7', [{ machineId: 'press-line-7', label: 'Transfer press 7' }]), 'Transfer press 7');
    assert.equal(machineLabel('press-stamp-01', []), 'press-stamp-01');
  });
});
