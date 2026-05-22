import { useEffect } from "react";

// Bind a keystroke handler to window. Skips events that originate inside a
// text input / textarea / contenteditable so the composer's typing doesn't
// trigger nav.

export type KeyHandler = (event: KeyboardEvent) => void;

export function useKeyboard(handler: KeyHandler, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      handler(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handler, enabled]);
}
