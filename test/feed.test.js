const test = require("node:test");
const assert = require("node:assert");

const { buildFeedXml, newFeedToken, escapeXml } = require("../lib/feed");

// A supabase query builder is awaitable at any point in the chain; this fake
// mirrors that: every method returns the chain, awaiting it yields the result.
function chain(result) {
  const c = {
    then: (resolve) => resolve(result),
  };
  for (const m of ["select", "eq", "in", "order", "limit"]) c[m] = () => c;
  return c;
}

function fakeService({ assets, docs }) {
  return {
    from(table) {
      if (table === "audio_assets") return chain({ data: assets, error: null });
      if (table === "documents") return chain({ data: docs, error: null });
      throw new Error(`unexpected table ${table}`);
    },
    storage: {
      from() {
        return {
          createSignedUrl: async (path) => ({
            data: { signedUrl: `https://signed.example/${path}?sig=abc&exp=1` },
            error: null,
          }),
        };
      },
    },
  };
}

test("newFeedToken is url-safe and unique", () => {
  const a = newFeedToken();
  const b = newFeedToken();
  assert.notStrictEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/, "must survive being pasted into a URL");
});

test("escapeXml neutralises markup", () => {
  assert.strictEqual(
    escapeXml(`<Ben & Jerry's "notes">`),
    "&lt;Ben &amp; Jerry&apos;s &quot;notes&quot;&gt;",
  );
});

test("buildFeedXml renders one item per asset with escaped titles", async () => {
  const service = fakeService({
    assets: [
      {
        document_id: "doc-1",
        path: "u1/books/doc-1.mp3",
        duration_seconds: 61.4,
        byte_size: 12345,
        created_at: "2026-07-18T10:00:00Z",
      },
      {
        document_id: "doc-2",
        path: "u1/books/doc-2.mp3",
        duration_seconds: 10,
        byte_size: 999,
        created_at: "2026-07-17T10:00:00Z",
      },
    ],
    docs: [
      { id: "doc-1", title: `Chapter <3 & "more"` },
      { id: "doc-2", title: "Plain title" },
    ],
  });

  const xml = await buildFeedXml(service, "u1");

  assert.ok(xml.startsWith(`<?xml version="1.0"`));
  assert.strictEqual((xml.match(/<item>/g) || []).length, 2);

  // Titles with markup characters must arrive escaped, never raw.
  assert.ok(xml.includes("Chapter &lt;3 &amp; &quot;more&quot;"));
  assert.ok(!xml.includes(`Chapter <3`), "raw title would break the XML");

  // The signed URL's ampersand must be escaped inside the attribute.
  assert.ok(xml.includes("?sig=abc&amp;exp=1"));

  // Episode identity is the document, not the (rotating) signed URL.
  assert.ok(xml.includes(`<guid isPermaLink="false">soundscript-doc-1</guid>`));

  // Durations are whole seconds.
  assert.ok(xml.includes("<itunes:duration>61</itunes:duration>"));
});

test("buildFeedXml with an empty library is a valid empty channel", async () => {
  const xml = await buildFeedXml(fakeService({ assets: [], docs: [] }), "u1");
  assert.ok(xml.includes("<channel>"));
  assert.ok(!xml.includes("<item>"));
});
