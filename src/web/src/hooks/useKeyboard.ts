import { useEffect } from "react";

// Bind a keystroke handler to window. Skips events that originate inside a
// text input / textarea / contenteditable so the composer's typing doesn't
// trigger nav. Non-text inputs (checkbox, radio, button) keep nav active —
// otherwise clicking a bulk-select checkbox would silently break Shift+x and
// the rest of the j/k/x keymap until the operator clicked elsewhere.

export type KeyHandler = (event: KeyboardEvent) => void;

const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
]);

export function useKeyboard(handler: KeyHandler, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "TEXTAREA" || target.isContentEditable) return;
        if (tag === "INPUT") {
          const type = (target as HTMLInputElement).type;
          if (!NON_TEXT_INPUT_TYPES.has(type)) return;
        }
      }
      handler(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handler, enabled]);
}
