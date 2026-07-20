import { supabase } from "./supabase";

// The API origin, baked in at build time from VITE_BACKEND_URL (render.yaml for
// the deploy, .env for local). The fallback matters: Render preserves an
// already-set env var, so a service first deployed with VITE_BACKEND_URL blank
// keeps it blank even after render.yaml gains a value -- without the fallback
// the built bundle would have no API to call.
const BASE =
  import.meta.env.VITE_BACKEND_URL ||
  "https://soundscript-api-55nk.onrender.com";

async function authHeader() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token)
    throw new Error("No active session. Reload the page.");
  return { Authorization: `Bearer ${session.access_token}` };
}

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/** Single-shot conversion of a short piece of text. */
export async function convertText(text) {
  const res = await fetch(`${BASE}/api/convert`, {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return asJson(res);
}

export async function listDocuments() {
  const res = await fetch(`${BASE}/api/documents`, {
    headers: await authHeader(),
  });
  return (await asJson(res)).documents;
}

export async function getDocument(id) {
  const res = await fetch(`${BASE}/api/documents/${id}`, {
    headers: await authHeader(),
  });
  return asJson(res);
}

export async function deleteDocument(id) {
  const res = await fetch(`${BASE}/api/documents/${id}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!res.ok && res.status !== 204) await asJson(res);
}

function documentForm(file, { title, voice, estimate } = {}) {
  const form = new FormData();
  form.append("file", file);
  if (title) form.append("title", title);
  if (voice?.provider) form.append("provider", voice.provider);
  if (voice?.voiceId) form.append("voiceId", voice.voiceId);
  if (voice?.modelId) form.append("modelId", voice.modelId);
  if (estimate) form.append("estimate", "1");
  return form;
}

/**
 * Quote a document without creating it: chunk count, cache hits, billable
 * characters and whether it fits today's quota. Same parsing as the real
 * upload, so the numbers cannot drift from what a confirm would cost.
 */
export async function estimateDocument(file, options = {}) {
  const res = await fetch(`${BASE}/api/documents`, {
    method: "POST",
    headers: await authHeader(),
    body: documentForm(file, { ...options, estimate: true }),
  });
  return (await asJson(res)).estimate;
}

export async function uploadDocument(file, options = {}) {
  const res = await fetch(`${BASE}/api/documents`, {
    method: "POST",
    headers: await authHeader(),
    body: documentForm(file, options),
  });
  return asJson(res);
}

/** Every provider and voice the server offers, for the picker. */
export async function listVoices() {
  const res = await fetch(`${BASE}/api/voices`, {
    headers: await authHeader(),
  });
  return (await asJson(res)).providers;
}

/**
 * A short spoken sample of a voice. Returns an object URL the caller must
 * revoke after playback -- it is a blob, not a remote URL.
 */
export async function previewVoice(voice) {
  const res = await fetch(`${BASE}/api/voices/preview`, {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify(voice || {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Preview failed (${res.status})`);
  }
  return URL.createObjectURL(await res.blob());
}

/** Chunk text in reading order, for the read-along view. */
export async function getDocumentText(id) {
  const res = await fetch(`${BASE}/api/documents/${id}/text`, {
    headers: await authHeader(),
  });
  return (await asJson(res)).chunks;
}

/** Remember playback position so any device can resume there. */
export async function savePosition(id, seconds) {
  await fetch(`${BASE}/api/documents/${id}/position`, {
    method: "PUT",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify({ seconds }),
  });
}

export async function listPronunciations() {
  const res = await fetch(`${BASE}/api/pronunciations`, {
    headers: await authHeader(),
  });
  return (await asJson(res)).rules;
}

export async function savePronunciation(pattern, replacement) {
  const res = await fetch(`${BASE}/api/pronunciations`, {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify({ pattern, replacement }),
  });
  return (await asJson(res)).rule;
}

export async function deletePronunciation(id) {
  const res = await fetch(`${BASE}/api/pronunciations/${id}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!res.ok && res.status !== 204) await asJson(res);
}

export async function getFeed() {
  const res = await fetch(`${BASE}/api/feed`, { headers: await authHeader() });
  return asJson(res);
}

export async function rotateFeed() {
  const res = await fetch(`${BASE}/api/feed/rotate`, {
    method: "POST",
    headers: await authHeader(),
  });
  return asJson(res);
}

export async function retryDocument(id) {
  const res = await fetch(`${BASE}/api/documents/${id}/process`, {
    method: "POST",
    headers: await authHeader(),
  });
  return asJson(res);
}

/**
 * Stream a document's progress.
 *
 * Uses fetch rather than EventSource: EventSource cannot send an Authorization
 * header, and the usual workaround puts the JWT in the query string where every
 * proxy log will keep a copy of it.
 *
 * @returns {() => void} stop the stream
 */
export function streamDocument(id, onEvent, onError) {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE}/api/documents/${id}/events`, {
        headers: { ...(await authHeader()), Accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Stream failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line. The trailing piece may be a
        // partial frame, so it stays in the buffer until the rest arrives.
        const frames = buffer.split("\n\n");
        buffer = frames.pop();

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue; // heartbeat comment
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {
            // A malformed frame is not worth tearing the stream down for.
          }
        }
      }
    } catch (err) {
      // Abort is how this function is meant to end; it is not a failure.
      if (err.name !== "AbortError") onError?.(err);
    }
  })();

  return () => controller.abort();
}

/**
 * Short-lived URL for a private object. The library bucket is not public, so
 * playback needs one of these rather than a permanent link.
 */
export async function signedUrl(path, expiresIn = 3600) {
  const { data, error } = await supabase.storage
    .from("library")
    .createSignedUrl(path, expiresIn);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
