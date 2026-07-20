const test = require("node:test");
const assert = require("node:assert");

const { classify } = require("../lib/tts/elevenlabs");

// Build a fake axios error with a JSON body, the way the provider sees it.
function httpError(status, body, headers = {}) {
  return {
    response: {
      status,
      headers,
      data: Buffer.from(JSON.stringify(body)),
    },
  };
}

test("a 401 quota_exceeded is reported as a quota problem, not a bad key", () => {
  const err = classify(
    httpError(401, {
      detail: {
        status: "quota_exceeded",
        message: "This request exceeds your quota of 10000. You have 7 left.",
      },
    }),
  );
  assert.match(err.message, /quota reached/i);
  assert.match(err.message, /You have 7 left/);
  assert.ok(!/invalid.*api key/i.test(err.message), "must not blame the key");
  assert.strictEqual(err.retryable, false);
});

test("a 401 with a quota-worded message is caught even without the status field", () => {
  const err = classify(
    httpError(401, { detail: { message: "You are out of characters." } }),
  );
  assert.match(err.message, /quota reached/i);
});

test("a genuine 401 auth failure still reads as an invalid key", () => {
  const err = classify(
    httpError(401, { detail: { status: "invalid_api_key", message: "" } }),
  );
  assert.match(err.message, /invalid elevenlabs api key/i);
  assert.strictEqual(err.retryable, false);
});

test("a network error with no response is retryable", () => {
  const err = classify({ message: "socket hang up" });
  assert.strictEqual(err.retryable, true);
  assert.strictEqual(err.status, undefined);
});

test("a 429 is retryable and honours Retry-After", () => {
  const err = classify(
    httpError(
      429,
      { detail: { message: "slow down" } },
      { "retry-after": "3" },
    ),
  );
  assert.strictEqual(err.retryable, true);
  assert.strictEqual(err.retryAfterMs, 3000);
});

test("a 5xx is retryable", () => {
  const err = classify(httpError(503, {}));
  assert.strictEqual(err.retryable, true);
  assert.strictEqual(err.status, 503);
});
