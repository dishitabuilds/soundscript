// Test double for application contracts. It does not prove real Postgres RLS,
// transactions, storage policies or cross-process locking.
const { randomUUID } = require("node:crypto");

function fakeSupabase() {
  const tables = {};
  const objects = new Map();
  const failures = new Map();
  const table = (name) => (tables[name] ||= []);
  const db = {
    tables,
    objects,
    failures,
    from(name) {
      let operation = "select",
        payload,
        one = false,
        cap = Infinity,
        offset = 0,
        sort;
      const filters = [];
      const query = {
        select() {
          return query;
        },
        insert(value) {
          operation = "insert";
          payload = value;
          return query;
        },
        upsert(value) {
          operation = "upsert";
          payload = value;
          return query;
        },
        update(value) {
          operation = "update";
          payload = value;
          return query;
        },
        delete() {
          operation = "delete";
          return query;
        },
        eq(key, value) {
          filters.push((r) => r[key] === value);
          return query;
        },
        in(key, values) {
          filters.push((r) => values.includes(r[key]));
          return query;
        },
        gte(key, value) {
          filters.push((r) => r[key] >= value);
          return query;
        },
        lt(key, value) {
          filters.push((r) => r[key] < value);
          return query;
        },
        order(key, options = {}) {
          sort = [key, options.ascending !== false];
          return query;
        },
        limit(value) {
          cap = value;
          return query;
        },
        range(start, end) {
          offset = start;
          cap = end - start + 1;
          return query;
        },
        single() {
          one = true;
          return query;
        },
        maybeSingle() {
          one = true;
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(() => {
              const error =
                failures.get(name + ":" + operation) || failures.get(name);
              if (error) return { data: null, error: { message: error } };
              let rows = table(name).filter((r) => filters.every((f) => f(r)));
              if (operation === "insert" || operation === "upsert") {
                rows = (Array.isArray(payload) ? payload : [payload]).map(
                  (value) => {
                    const keyFields =
                      name === "audio_cache"
                        ? ["user_id", "content_hash"]
                        : name === "listening_positions"
                          ? ["user_id", "document_id"]
                          : name === "user_feeds"
                            ? ["user_id"]
                            : name === "pronunciation_rules"
                              ? ["user_id", "pattern"]
                              : ["id"];
                    const existing =
                      operation === "upsert" &&
                      table(name).find((r) =>
                        keyFields.every(
                          (key) =>
                            value[key] !== undefined && r[key] === value[key],
                        ),
                      );
                    if (existing) return Object.assign(existing, value);
                    const row = {
                      id: randomUUID(),
                      created_at: new Date().toISOString(),
                      ...(name === "chunks"
                        ? { status: "pending", attempts: 0 }
                        : {}),
                      ...value,
                    };
                    table(name).push(row);
                    return row;
                  },
                );
              } else if (operation === "update") {
                rows.forEach((r) => Object.assign(r, payload));
              } else if (operation === "delete") {
                tables[name] = table(name).filter((r) => !rows.includes(r));
              }
              if (sort)
                rows = [...rows].sort(
                  (a, b) =>
                    String(a[sort[0]]).localeCompare(String(b[sort[0]])) *
                    (sort[1] ? 1 : -1),
                );
              rows = rows.slice(offset, offset + cap);
              return { data: one ? rows[0] || null : rows, error: null };
            })
            .then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, { p_document_id: id }) {
      if (failures.has(name))
        return { data: null, error: { message: failures.get(name) } };
      const chunks = table("chunks").filter((c) => c.document_id === id);
      if (name === "claim_next_chunk") {
        const chunk = chunks
          .filter((c) => c.status === "pending")
          .sort((a, b) => a.idx - b.idx)[0];
        if (!chunk) return { data: [], error: null };
        chunk.status = "processing";
        chunk.attempts++;
        return { data: [{ ...chunk }], error: null };
      }
      if (name === "document_progress") {
        const p = { total: chunks.length };
        for (const status of ["done", "failed", "pending", "processing"]) {
          p[status] = chunks.filter((c) => c.status === status).length;
        }
        return { data: [p], error: null };
      }
      throw new Error("Unexpected RPC: " + name);
    },
    storage: {
      from(bucket) {
        return {
          async upload(path, body) {
            if (failures.has("upload"))
              return { error: { message: failures.get("upload") } };
            objects.set(bucket + "/" + path, Buffer.from(body));
            return { data: { path }, error: null };
          },
          async download(path) {
            const data = objects.get(bucket + "/" + path);
            return data
              ? { data: new Blob([data]), error: null }
              : { data: null, error: { message: "Object missing" } };
          },
          getPublicUrl(path) {
            return {
              data: {
                publicUrl: "https://storage.invalid/" + bucket + "/" + path,
              },
            };
          },
          async createSignedUrl(path) {
            return {
              data: { signedUrl: "https://storage.invalid/signed/" + path },
              error: null,
            };
          },
        };
      },
    },
  };
  return db;
}

module.exports = { fakeSupabase };
