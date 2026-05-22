import { useEffect, useState } from "react";

// Day / night with manual override. First load respects prefers-color-scheme;
// the override persists to localStorage. Two felt rooms — accent hue snaps
// when this changes (handled by tokens.css, not here).

export type Theme = "day" | "night";

const STORAGE_KEY = "os.theme";

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "day" || v === "night" ? v : null;
  } catch {
    return null;
  }
}

function systemPreferred(): Theme {
  if (typeof window === "undefined") return "day";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "night"
    : "day";
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => readStored() ?? systemPreferred());

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  const toggle = (): void => {
    setTheme((t) => {
      const next: Theme = t === "day" ? "night" : "day";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // no-op: private mode etc.
      }
      return next;
    });
  };

  return { theme, toggle };
}
