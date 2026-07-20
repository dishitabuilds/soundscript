import { useEffect, useState } from "react";

// Explicit user choice wins; otherwise follow the OS. Stored as "light"/"dark"
// only when the user actually toggles, so "no key" keeps meaning "follow the
// system" forever rather than freezing whatever the OS said on first visit.
// The inline script in index.html mirrors this before first paint.
const KEY = "soundscript-theme";

function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function initialDark() {
  const stored = localStorage.getItem(KEY);
  if (stored === "dark") return true;
  if (stored === "light") return false;
  return systemPrefersDark();
}

export function useTheme() {
  const [dark, setDark] = useState(initialDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const toggle = () => {
    setDark((d) => {
      localStorage.setItem(KEY, d ? "light" : "dark");
      return !d;
    });
  };

  return { dark, toggle };
}
