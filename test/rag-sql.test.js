const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
let pg;
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const doc = "00000000-0000-4000-8000-000000000003";
const privateDoc = "00000000-0000-4000-8000-000000000004";
const passage = "00000000-0000-4000-8000-000000000005";
const vector = JSON.stringify([1, ...Array(383).fill(0)]);
before(async () => {
  const [{ PGlite }, { vector: extension }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-pgvector"),
  ]);
  pg = new PGlite({ extensions: { vector: extension } });
  // Minimal Supabase identity/document boundary. The RAG migration itself is
  // executed verbatim in Postgres WASM with the real pgvector extension.
  await pg.exec(`
    create schema auth; create schema extensions;
    create role authenticated; create role anon;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth, extensions to authenticated, anon;
    create table public.documents(id uuid primary key, user_id uuid references auth.users(id));
    alter table public.documents enable row level security;
    create policy owner_docs on public.documents for all to authenticated
      using(user_id = (select auth.uid())) with check(user_id = (select auth.uid()));
    grant select on public.documents to authenticated;
    insert into auth.users values ('${owner}'), ('${other}');
    insert into public.documents values ('${doc}','${owner}'), ('${privateDoc}','${other}');
  `);
  await pg.exec(
    await readFile(
      "supabase/migrations/20261104120000_document_rag.sql",
      "utf8",
    ),
  );
  await pg.query(
    `insert into public.document_passages
    (id,document_id,user_id,paragraph_idx,part_idx,text,embedding,embedding_model)
    values ($1,$2,$3,0,0,'Regularization penalizes complexity',$4::extensions.vector,'model'),
           (gen_random_uuid(),$5,$6,0,0,'Regularization private secret',$4::extensions.vector,'model')`,
    [passage, doc, owner, vector, privateDoc, other],
  );
});
after(async () => {
  if (pg) await pg.close();
});
async function asUser(user) {
  await pg.exec(
    `reset role; set request.jwt.claim.sub = '${user}'; set role authenticated;`,
  );
}
async function search(documentId, mode, model = "model") {
  return (
    await pg.query(
      "select * from public.search_document_passages($1,$2,$3::extensions.vector,$4,$5,20)",
      [documentId, "regularization", vector, model, mode],
    )
  ).rows;
}

test("actual migration executes keyword, cosine and hybrid retrieval", async () => {
  await asUser(owner);
  for (const mode of ["keyword", "semantic", "hybrid"]) {
    const rows = await search(doc, mode);
    assert.deepEqual(
      rows.map((r) => r.id),
      [passage],
    );
    assert.ok(rows[0].score > 0);
  }
  assert.equal((await search(doc, "semantic", "incompatible-model")).length, 0);
});
test("real RLS hides other owners' passages and forged document searches", async () => {
  await asUser(other);
  assert.equal((await search(doc, "hybrid")).length, 0);
  const rows = (
    await pg.query("select document_id from public.document_passages")
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.document_id),
    [privateDoc],
  );
});
test("real write policies reject forged owners and cross-document inserts", async () => {
  await asUser(owner);
  await assert.rejects(
    pg.query(
      "insert into public.document_passages(document_id,user_id,paragraph_idx,part_idx,text) values ($1,$2,1,0,'Forged')",
      [privateDoc, owner],
    ),
    /row-level security/,
  );
  await assert.rejects(
    pg.query("update public.document_passages set user_id=$1 where id=$2", [
      other,
      passage,
    ]),
    /row-level security/,
  );
});
test("anonymous role cannot call the retrieval function", async () => {
  await pg.exec("reset role; set role anon");
  await assert.rejects(search(doc, "keyword"), /permission denied/);
});
