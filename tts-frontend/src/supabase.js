import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.",
  );
}

const authOrigin = new URL("/auth/v1/", url).href;

export const supabase = createClient(url, anonKey, {
  global: {
    fetch(input, init) {
      // Bound auth requests without timing out document or audio transfers.
      if (typeof input === "string" && input.startsWith(authOrigin)) {
        const timeout = AbortSignal.timeout(8000);
        const signal = init?.signal
          ? AbortSignal.any([init.signal, timeout])
          : timeout;
        return fetch(input, { ...init, signal });
      }
      return fetch(input, init);
    },
  },
});
