// Explicitly local browser fixture. Uses real routes, parsers, workers and
// FFmpeg, with in-memory Supabase and synthetic speech. Never loads dotenv.
// Run: node scripts/browser-fixture.js ; open http://127.0.0.1:5176
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { fakeSupabase } = require("../test/helpers/fake-supabase");
const { withWorkDir, makeSilence } = require("../lib/audio/stitch");

async function main() {
  const apiPort = Number(process.env.FIXTURE_API_PORT || 5105);
  const webPort = Number(process.env.FIXTURE_WEB_PORT || 5176);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  process.env.INLINE_PROCESSING = "true";
  process.env.ALLOWED_ORIGINS = `http://127.0.0.1:${webPort}`;
  process.env.ELEVEN_API_KEY = "test-only-placeholder";
  process.env.OPENAI_API_KEY = "";
  process.env.RAG_ENABLED = "true";
  const db = fakeSupabase();
  const originalRpc = db.rpc.bind(db);
  db.rpc = async (name, args) => {
    if (name !== "search_document_passages") return originalRpc(name, args);
    // Disposable SQL substitute: UI/API wiring only; does not verify pgvector.
    const words = args.p_query.toLowerCase().match(/\w+/g) || [];
    const rows = (db.tables.document_passages || [])
      .filter((p) => p.document_id === args.p_document_id)
      .map((p) => ({
        ...p,
        score: words.filter((w) => p.text.toLowerCase().includes(w)).length,
      }))
      .filter((p) => p.score > 0 || args.p_mode !== "keyword")
      .sort((a, b) => b.score - a.score)
      .slice(0, args.p_limit);
    return { data: rows, error: null };
  };
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    is_anonymous: true,
  };
  const clients = require("../lib/supabase");
  clients.getAuthClient = () => ({
    ...db,
    auth: { getUser: async () => ({ data: { user }, error: null }) },
  });
  clients.getUserClient = () => db;
  clients.getServiceClient = () => null;
  const audio = await withWorkDir(async (dir) => {
    const file = path.join(dir, "sample.mp3");
    await makeSilence(0.2, file);
    return fs.readFile(file);
  });
  let synthesisCalls = 0;
  const axios = require("axios");
  const realPost = axios.post.bind(axios);
  axios.post = async (url, body, config) => {
    if (
      process.env.FIXTURE_REAL_TTS === "true" &&
      url === "http://127.0.0.1:8002/speech"
    )
      return realPost(url, body, config);
    if (!url.startsWith("https://api.elevenlabs.io/v1/text-to-speech/")) {
      throw new Error("External requests are disabled in this fixture.");
    }
    synthesisCalls++;
    if (process.env.FIXTURE_ELEVEN_QUOTA === "true") {
      const error = new Error("Simulated exhausted premium quota");
      error.response = {
        status: 401,
        data: {
          detail: {
            status: "quota_exceeded",
            message: "Simulated exhausted quota",
          },
        },
      };
      throw error;
    }
    return { data: audio, headers: { "content-type": "audio/mpeg" } };
  };
  axios.get = async () => {
    throw new Error("External requests disabled.");
  };
  const storageFrom = db.storage.from;
  db.storage.from = (bucket) => ({
    ...storageFrom(bucket),
    getPublicUrl: (name) => ({
      data: {
        publicUrl: apiOrigin + "/__fixture/object/" + bucket + "/" + name,
      },
    }),
    createSignedUrl: async (name) => ({
      data: {
        signedUrl: apiOrigin + "/__fixture/object/" + bucket + "/" + name,
      },
      error: null,
    }),
  });
  const app = require("../app");
  app.get("/__fixture/object/*", (req, res) => {
    const body = db.objects.get(req.params[0]);
    if (!body) return res.sendStatus(404);
    if (typeof req.query.download === "string")
      res.attachment(req.query.download);
    res.type("audio/mpeg").send(body);
  });
  app.get("/__fixture/status", (req, res) =>
    res.json({
      synthesisCalls,
      documents: db.tables.documents?.length || 0,
      jobs: db.tables.jobs?.map((j) => j.status) || [],
    }),
  );
  const api = app.listen(apiPort, "127.0.0.1");
  const frontend = path.resolve("tts-frontend");
  process.chdir(frontend); // Tailwind resolves its content globs from cwd.
  const { createServer } = await import(
    pathToFileURL(require.resolve("vite", { paths: [frontend] }))
  );
  const sessionSource =
    "const user=" +
    JSON.stringify(user) +
    ";" +
    "export const supabase={auth:{" +
    "getSession:async()=>({data:{session:{access_token:'fixture-session',user}}})," +
    "getUser:async()=>({data:{user},error:null})," +
    "onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})," +
    "signInAnonymously:async()=>({data:{user},error:null})}," +
    "from:()=>{const q={select:()=>q,eq:()=>q,order:async()=>({data:[],error:null})};return q;}," +
    "storage:{from:bucket=>({createSignedUrl:async (name,expiry,options)=>({data:{signedUrl:" +
    JSON.stringify(apiOrigin + "/__fixture/object/") +
    "+bucket+'/'+name+(options?.download?'?download='+encodeURIComponent(options.download):'')},error:null})})}};";
  const web = await createServer({
    root: frontend,
    define: { "import.meta.env.VITE_BACKEND_URL": JSON.stringify(apiOrigin) },
    plugins: [
      {
        name: "local-fixture-session",
        enforce: "pre",
        resolveId(source, importer) {
          if (source === "./supabase" && importer?.includes("/src/"))
            return "\0fixture-session";
        },
        load(id) {
          if (id === "\0fixture-session") return sessionSource;
        },
      },
    ],
    server: { host: "127.0.0.1", port: webPort, strictPort: true },
  });
  await web.listen();
  console.log(
    `Local fixture ready at http://127.0.0.1:${webPort} (no real credentials or paid speech).`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await web.close();
      api.close(() => process.exit(0));
    });
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
