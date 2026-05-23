import type { JSX, MouseEvent, ReactNode } from "react";

interface HelpOverlayProps {
  onClose: () => void;
}

interface Binding {
  keys: ReactNode;
  action: string;
}

interface Operator {
  syntax: string;
  example: string;
}

const KEYBINDS: Binding[] = [
  {
    keys: (
      <>
        <kbd>j</kbd> / <kbd>k</kbd>
      </>
    ),
    action: "move selection between threads",
  },
  {
    keys: (
      <>
        <kbd>J</kbd> / <kbd>K</kbd>
      </>
    ),
    action: "expand / collapse next message in thread",
  },
  {
    keys: <kbd>enter</kbd>,
    action: "open message (auto-opened in reader)",
  },
  { keys: <kbd>/</kbd>, action: "focus search" },
  { keys: <kbd>r</kbd>, action: "reply to latest in thread" },
  { keys: <kbd>s</kbd>, action: "star / unstar selected thread" },
  {
    keys: (
      <>
        <kbd>z</kbd> / <kbd>Z</kbd>
      </>
    ),
    action: "snooze (picker) / unsnooze immediately",
  },
  { keys: <kbd>#</kbd>, action: "trash / untrash selected thread" },
  { keys: <kbd>e</kbd>, action: "archive / unarchive selected thread" },
  {
    keys: <kbd>Shift+U</kbd>,
    action: "mark thread read / unread",
  },
  {
    keys: <kbd>l</kbd>,
    action: "label picker (enter toggles, ⌘↩ closes)",
  },
  {
    keys: <kbd>x</kbd>,
    action: "add / remove focused thread from selection",
  },
  {
    keys: <kbd>Shift+x</kbd>,
    action: "select / deselect all in view",
  },
  { keys: <kbd>c</kbd>, action: "compose new" },
  { keys: <kbd>⌘↵</kbd>, action: "send (in composer)" },
  {
    keys: <kbd>⇧⌘↵</kbd>,
    action: "send reply and archive thread (in composer)",
  },
  { keys: <kbd>⌘B</kbd>, action: "bold (in composer)" },
  { keys: <kbd>⌘I</kbd>, action: "italic (in composer)" },
  { keys: <kbd>⌘K</kbd>, action: "add link (in composer)" },
  { keys: <kbd>t</kbd>, action: "toggle theme" },
  {
    keys: <kbd>esc</kbd>,
    action: "close composer / clear search / clear selection",
  },
  { keys: <kbd>?</kbd>, action: "this cheat sheet" },
];

const OPERATORS: Operator[] = [
  { syntax: "from:", example: "from:bob" },
  { syntax: "subject:", example: "subject:invoice" },
  { syntax: "to:", example: "to:alice" },
  { syntax: "is:unread", example: "is:unread" },
  { syntax: "is:starred", example: "is:starred" },
  { syntax: "is:snoozed", example: "is:snoozed" },
  { syntax: "has:attachment", example: "has:attachment" },
  { syntax: "in:trash", example: "in:trash" },
  { syntax: "in:archive", example: "in:archive" },
  { syntax: '"…"', example: '"quoted phrase"' },
  { syntax: "-", example: "-from:noreply" },
];

export function HelpOverlay({ onClose }: HelpOverlayProps): JSX.Element {
  const onCardClick = (e: MouseEvent<HTMLDivElement>): void => {
    e.stopPropagation();
  };
  return (
    <div
      className="help-overlay"
      onClick={onClose}
      role="dialog"
      aria-label="Keyboard cheat sheet"
    >
      <div className="help-overlay__card" onClick={onCardClick}>
        <h2 className="help-overlay__title">keyboard reference</h2>
        <dl className="help-overlay__list">
          {KEYBINDS.map((b, i) => (
            <div key={i} className="help-overlay__row">
              <dt>{b.keys}</dt>
              <dd>{b.action}</dd>
            </div>
          ))}
        </dl>
        <h2 className="help-overlay__title">search operators</h2>
        <dl className="help-overlay__list">
          {OPERATORS.map((o, i) => (
            <div key={i} className="help-overlay__row">
              <dt>
                <kbd>{o.syntax}</kbd>
              </dt>
              <dd>{o.example}</dd>
            </div>
          ))}
        </dl>
        <p className="help-overlay__hint">
          <kbd>esc</kbd> to close
        </p>
      </div>
    </div>
  );
}
