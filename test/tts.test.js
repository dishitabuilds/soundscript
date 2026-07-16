const test = require("node:test");
const assert = require("node:assert");
const { withRetry, TtsError, contentHash } = require("../lib/tts");

test("contentHash is stable for identical input", () => {
  assert.strictEqual(contentHash("hello"), contentHash("hello"));
});

test("contentHash changes with text, voice and model", () => {
  const base = contentHash("hello", "voiceA", "modelA");
  assert.notStrictEqual(base, contentHash("hello!", "voiceA", "modelA"));
  assert.notStrictEqual(base, contentHash("hello", "voiceB", "modelA"));
  assert.notStrictEqual(base, contentHash("hello", "voiceA", "modelB"));
});

test("withRetry returns the value when the call succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return "ok";
  });
  assert.strictEqual(result, "ok");
  assert.strictEqual(calls, 1, "a successful call should not be repeated");
});

test("withRetry retries a retryable error and eventually succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3)
        throw new TtsError("rate limited", { status: 429, retryable: true });
      return "recovered";
    },
    { baseMs: 1 },
  );
  assert.strictEqual(result, "recovered");
  assert.strictEqual(calls, 3);
});

test("withRetry gives up after the attempt budget", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new TtsError("still limited", { status: 429, retryable: true });
        },
        { attempts: 3, baseMs: 1 },
      ),
    /still limited/,
  );
  assert.strictEqual(
    calls,
    3,
    "should try exactly the budgeted number of times",
  );
});

test("withRetry does not retry a permanent error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new TtsError("bad api key", { status: 401, retryable: false });
        },
        { attempts: 5, baseMs: 1 },
      ),
    /bad api key/,
  );
  assert.strictEqual(
    calls,
    1,
    "a 401 will fail identically forever; retrying wastes time",
  );
});

test("withRetry does not retry a non-TtsError", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error("programmer error");
        },
        { attempts: 5, baseMs: 1 },
      ),
    /programmer error/,
  );
  assert.strictEqual(
    calls,
    1,
    "an unexpected error is a bug, not a transient fault",
  );
});

test("withRetry honours Retry-After over its own backoff", async () => {
  const waits = [];
  let calls = 0;

  await withRetry(
    async () => {
      calls++;
      if (calls === 1) {
        throw new TtsError("slow down", {
          status: 429,
          retryable: true,
          retryAfterMs: 7,
        });
      }
      return "ok";
    },
    { baseMs: 5000, onRetry: ({ wait }) => waits.push(wait) },
  );

  assert.deepStrictEqual(
    waits,
    [7],
    "server's Retry-After should win over the formula",
  );
});

test("withRetry backs off exponentially and jitters", async () => {
  const waits = [];

  await assert.rejects(() =>
    withRetry(
      async () => {
        throw new TtsError("429", { status: 429, retryable: true });
      },
      { attempts: 4, baseMs: 100, onRetry: ({ wait }) => waits.push(wait) },
    ),
  );

  assert.strictEqual(waits.length, 3, "3 waits between 4 attempts");

  // Jitter is 0.5x-1.5x of base * 2^(n-1): 50-150, 100-300, 200-600.
  const bounds = [
    [50, 150],
    [100, 300],
    [200, 600],
  ];
  waits.forEach((wait, i) => {
    const [lo, hi] = bounds[i];
    assert.ok(
      wait >= lo && wait <= hi,
      `wait ${i} was ${wait}ms, expected between ${lo} and ${hi}`,
    );
  });
});

test("withRetry respects maxMs", async () => {
  const waits = [];
  await assert.rejects(() =>
    withRetry(
      async () => {
        throw new TtsError("429", { status: 429, retryable: true });
      },
      {
        attempts: 5,
        baseMs: 1000,
        maxMs: 50,
        onRetry: ({ wait }) => waits.push(wait),
      },
    ),
  );
  // Capped at 50, then jittered by 0.5-1.5x.
  for (const wait of waits)
    assert.ok(wait <= 75, `wait ${wait} exceeded the cap`);
});
