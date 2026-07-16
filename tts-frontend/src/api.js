import { supabase } from "./supabase";

const BASE = import.meta.env.VITE_BACKEND_URL;

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

export async function uploadDocument(file, title) {
  const form = new FormData();
  form.append("file", file);
  if (title) form.append("title", title);

  const res = await fetch(`${BASE}/api/documents`, {
    method: "POST",
    headers: await authHeader(),
    body: form,
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
