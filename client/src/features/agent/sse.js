/**
 * @file A minimal reader for `text/event-stream` bodies.
 *
 * `EventSource` only does GET, and a chat turn is a POST with a JSON body, so
 * the stream is read from `fetch` and split here. Only the two fields the
 * assistant sends are understood: `event:` and `data:` (JSON).
 *
 * @module features/agent/sse
 */

/**
 * Split buffered text into complete events, returning what is left over.
 *
 * @param {string} buffer - Text received so far.
 * @returns {{events: Array<{event: string, data: any}>, rest: string}}
 */
export function parseSseChunk(buffer) {
  const normalised = buffer.replace(/\r\n/g, '\n');
  const blocks = normalised.split('\n\n');
  const rest = blocks.pop() ?? '';
  /** @type {Array<{event: string, data: any}>} */
  const events = [];
  for (const block of blocks) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) });
    } catch {
      events.push({ event, data: { text: data.join('\n') } });
    }
  }
  return { events, rest };
}

/**
 * Read a streamed response to its end, calling `onEvent` for each event.
 *
 * @param {Response} response
 * @param {(event: {event: string, data: any}) => void} onEvent
 * @returns {Promise<void>}
 */
export async function readSse(response, onEvent) {
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseChunk(buffer);
    buffer = rest;
    for (const e of events) onEvent(e);
  }
  const { events } = parseSseChunk(`${buffer}\n\n`);
  for (const e of events) onEvent(e);
}
