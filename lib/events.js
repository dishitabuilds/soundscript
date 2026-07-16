// In-process event bus carrying worker progress to connected clients.
//
// The pool runs in this process, so progress can be pushed the instant a chunk
// finishes rather than discovered by polling the database on a timer. That is
// the difference between a progress bar that moves when work happens and one
// that moves once a second regardless.
//
// Limit worth knowing: this is per-process. Run two instances behind a load
// balancer and a client attached to instance A hears nothing about a job on
// instance B. The fix at that point is a shared channel (Postgres LISTEN/NOTIFY
// or Supabase Realtime), not a bigger EventEmitter -- but for a single process
// this is exactly right and costs nothing.

const { EventEmitter } = require("events");

const bus = new EventEmitter();

// Every SSE client attaches a listener, and a document being watched from a few
// tabs is normal rather than a leak -- the default limit of 10 would print
// spurious warnings.
bus.setMaxListeners(0);

const channel = (documentId) => `doc:${documentId}`;

/**
 * @param {string} documentId
 * @param {{ type: string, [k: string]: any }} event
 */
function publish(documentId, event) {
  bus.emit(channel(documentId), { ...event, at: Date.now() });
}

/**
 * @param {string} documentId
 * @param {(event: object) => void} listener
 * @returns {() => void} unsubscribe
 */
function subscribe(documentId, listener) {
  const name = channel(documentId);
  bus.on(name, listener);
  return () => bus.off(name, listener);
}

module.exports = { publish, subscribe };
