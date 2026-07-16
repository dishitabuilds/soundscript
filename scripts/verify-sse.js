// Verifies that /api/documents/:id/events streams progress live.
//
// The thing being tested is timing, not content: events must arrive spread out
// while work happens, not all at once when the response closes. A buffered
// stream looks identical in the payload and useless in the UI.
//
// Requires: npm start in another terminal.

require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
const { createClient } = require("@supabase/supabase-js");
const { buildPdf } = require("../test/helpers/make-pdf");

const API = process.env.API_URL || "http://localhost:5000";

const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  console.log(`  FAIL  ${m}`);
  process.exitCode = 1;
};

const PAGES = [
  ["Notes", "Rivers carve canyons slowly.", "1"],
  ["Notes", "Glaciers grind valleys flat.", "2"],
  ["Notes", "Wind shapes dunes over time.", "3"],
];

/** Read an SSE stream with fetch, so the JWT stays in a header. */
async function readEvents(jwt, docId, onEvent) {
  const res = await fetch(`${API}/api/documents/${docId}/events`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "text/event-stream" },
  });

  if (!res.ok) throw new Error(`stream failed: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop();

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue; // heartbeat comment
      onEvent(JSON.parse(line.slice(6)));
    }
  }
}

(async () => {
  const client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { data: auth } = await client.auth.signInAnonymously();
  const jwt = auth.session.access_token;
  console.log(`Guest: ${auth.user.id}\n`);

  const form = new FormData();
  form.append(
    "file",
    new Blob([buildPdf(PAGES)], { type: "application/pdf" }),
    "notes.pdf",
  );
  form.append("title", "SSE Test");

  const res = await fetch(`${API}/api/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  const created = await res.json();
  if (res.status !== 201)
    return fail(`upload failed: ${JSON.stringify(created)}`);

  const docId = created.document.id;
  console.log(
    `document ${docId}, ${created.chunks.pending} chunk(s) pending\n`,
  );

  console.log("streaming events");
  const events = [];
  const t0 = Date.now();

  await readEvents(jwt, docId, (e) => {
    const dt = Date.now() - t0;
    events.push({ ...e, dt });
    const detail =
      e.type === "chunk"
        ? `idx=${e.idx} ${e.status}${e.cached ? " (cached)" : ""}`
        : e.type === "job"
          ? e.status
          : e.type === "snapshot"
            ? JSON.stringify(e.progress)
            : "";
    console.log(
      `        +${String(dt).padStart(5)}ms  ${e.type.padEnd(10)} ${detail}`,
    );
  });

  console.log();

  // --- shape ---------------------------------------------------------------
  if (events[0]?.type === "snapshot") pass("stream opens with a snapshot");
  else fail(`expected snapshot first, got ${events[0]?.type}`);

  const last = events[events.length - 1];
  if (
    last?.type === "job" &&
    (last.status === "succeeded" || last.status === "failed")
  ) {
    pass(`stream ends with a terminal job event (${last.status})`);
  } else {
    fail(`expected terminal job event last, got ${JSON.stringify(last)}`);
  }

  const chunkEvents = events.filter((e) => e.type === "chunk");
  if (chunkEvents.length === created.chunks.total) {
    pass(`one event per chunk (${chunkEvents.length})`);
  } else {
    fail(
      `expected ${created.chunks.total} chunk events, got ${chunkEvents.length}`,
    );
  }

  if (events.some((e) => e.type === "assembling"))
    pass("assembly is announced");
  else fail("no assembling event");

  // --- the actual point: is it live? ---------------------------------------
  const firstChunk = chunkEvents[0];
  if (firstChunk && firstChunk.dt < last.dt - 200) {
    pass(
      `events are spread over time, not batched ` +
        `(first chunk at +${firstChunk.dt}ms, finish at +${last.dt}ms)`,
    );
  } else {
    fail(
      `events look buffered: first chunk +${firstChunk?.dt}ms vs finish +${last.dt}ms`,
    );
  }

  // The stream must close on its own once the job is terminal. If readEvents
  // returned, it did -- otherwise this script would still be hanging.
  pass("server closed the stream after the terminal event");

  // --- late attach ---------------------------------------------------------
  console.log("\nattaching after the job has finished");
  const lateEvents = [];
  await readEvents(jwt, docId, (e) => lateEvents.push(e));

  if (lateEvents[0]?.type === "snapshot")
    pass("late client still gets a snapshot");
  else fail("late client got no snapshot");

  if (lateEvents.some((e) => e.type === "job")) {
    pass(
      "late client is told the job is already finished, and the stream closes",
    );
  } else {
    fail("late client was left hanging with no terminal event");
  }

  // --- auth ----------------------------------------------------------------
  console.log("\nauth");
  const noAuth = await fetch(`${API}/api/documents/${docId}/events`);
  if (noAuth.status === 401) pass("stream requires auth");
  else fail(`expected 401, got ${noAuth.status}`);

  const otherClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { data: bAuth } = await otherClient.auth.signInAnonymously();
  const bRes = await fetch(`${API}/api/documents/${docId}/events`, {
    headers: { Authorization: `Bearer ${bAuth.session.access_token}` },
  });
  if (bRes.status === 404) pass("another guest cannot stream this document");
  else fail(`expected 404 for other user, got ${bRes.status}`);
  await bRes.body?.cancel();

  await fetch(`${API}/api/documents/${docId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jwt}` },
  });

  console.log(
    process.exitCode === 1
      ? "\n=== SOME CHECKS FAILED ==="
      : "\n=== ALL CHECKS PASSED ===",
  );
})().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
