/**
 * @file In-process domain events.
 *
 * The binding services change state that other parts of the process cache: the
 * binding index that routes every incoming telemetry sample, and the browsers
 * that hold a copy of the twin scene. Rather than have the services import the
 * websocket server and the index (which would invert the layering), they emit
 * a domain event and the interested parties subscribe.
 *
 * Two properties matter:
 *
 *   1. **Listeners cannot fail the emitter.** The emit happens on the HTTP
 *      request path, after the database write has already committed. A listener
 *      that throws must not turn a successful bind into a 500. Each listener
 *      runs in its own microtask inside a try/catch.
 *   2. **Emit after commit, never inside a transaction callback.** The driver
 *      may re-run a transaction callback, which would emit twice for one write,
 *      and a listener could observe state that later rolls back.
 *
 * @module utils/domainEvents
 */

import { EventEmitter } from 'node:events';

/**
 * Event names used across the service layer.
 *
 * @readonly
 * @enum {string}
 */
export const DOMAIN_EVENT = Object.freeze({
  /** A binding, mesh node or asset changed. Payload: {@link BindingChangedPayload}. */
  BINDING_CHANGED: 'binding:changed',
});

/**
 * @typedef {object} BindingChangedPayload
 * @property {string[]} assetIds - Every asset whose scene or bindings changed.
 *   More than one when a sensor is reassigned away from another asset, because
 *   the uniqueness rule on active sensors is global, not per asset.
 * @property {string} reason - Short machine-readable cause, for logs and tests.
 */

const emitter = new EventEmitter();
// Listeners are few and fixed (index, websocket); a leak warning would only
// ever fire on a genuine bug, so keep the default ceiling.
emitter.setMaxListeners(20);

/**
 * Subscribe to a domain event.
 *
 * @param {string} name - Event name from {@link DOMAIN_EVENT}.
 * @param {(payload: any) => void|Promise<void>} listener - Handler. Errors are logged, never rethrown.
 * @returns {() => void} Unsubscribe function.
 */
export function onDomainEvent(name, listener) {
  /** @param {any} payload */
  const wrapped = (payload) => {
    queueMicrotask(async () => {
      try {
        await listener(payload);
      } catch (error) {
        console.error(`[events] Listener for "${name}" failed:`, error?.message ?? error);
      }
    });
  };

  emitter.on(name, wrapped);
  return () => emitter.off(name, wrapped);
}

/**
 * Publish a domain event to every subscriber.
 *
 * @param {string} name - Event name from {@link DOMAIN_EVENT}.
 * @param {any} payload - Event payload.
 * @returns {void}
 */
export function emitDomainEvent(name, payload) {
  emitter.emit(name, payload);
}

/**
 * Drop every subscriber. Test-only.
 * @returns {void}
 */
export function resetDomainEventsForTests() {
  emitter.removeAllListeners();
}

export default { DOMAIN_EVENT, onDomainEvent, emitDomainEvent, resetDomainEventsForTests };
