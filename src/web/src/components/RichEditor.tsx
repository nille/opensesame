import { useEffect, useMemo, type JSX } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import {
  isStructurallyTrivial,
  makeStarterKit,
} from "../lib/rich-editor-config.ts";

// Re-export so the composer can import the trivial-doc check from the
// component path it already uses.
export { isStructurallyTrivial };

// ADR-0042 (slice 8.21). The composer's rich-text editor. Closed
// mark/node set; the toolbar is the spec. Six controls in one row,
// mono labels, no icon font. The editor exposes `bodyHtml` and an
// auto-derived `bodyText` to its caller; the latter is what gets
// shipped on outbound when the formatting is structurally trivial,
// so a reply that only typed prose still goes out as a single
// text/plain part.

interface RichEditorProps {
  // Initial document — accepts HTML (resumed draft) or null/empty
  // string (fresh compose). After mount, the editor owns the buffer.
  initialHtml?: string | null;
  initialText?: string | null;
  placeholder?: string;
  // Fired on every doc change with the editor's current HTML and the
  // auto-derived plain-text. The caller decides whether to suppress
  // body_html on send when the doc has no marks/lists/quotes (see
  // isStructurallyTrivial below).
  onChange: (state: { html: string; text: string }) => void;
}

export function RichEditor({
  initialHtml,
  initialText,
  placeholder,
  onChange,
}: RichEditorProps): JSX.Element {
  const initialContent = useMemo<string>(() => {
    if (initialHtml !== null && initialHtml !== undefined && initialHtml.length > 0) {
      return initialHtml;
    }
    if (initialText !== null && initialText !== undefined && initialText.length > 0) {
      // Plain-text seeds load as paragraphs. Splitting on \n\n keeps the
      // operator's existing line breaks in TipTap's prosemirror model.
      return initialText
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
        .join("");
    }
    return "";
  }, [initialHtml, initialText]);

  const editor = useEditor({
    extensions: [makeStarterKit()],
    content: initialContent,
    editorProps: {
      attributes: {
        class: "rich-editor__content",
        "aria-label": placeholder ?? "Body",
      },
    },
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      const text = ed.getText({ blockSeparator: "\n\n" });
      onChange({ html, text });
    },
  });

  // Re-emit once on mount so the parent has the seeded state — useEditor
  // doesn't fire onUpdate for the initial content.
  useEffect(() => {
    if (editor === null) return;
    onChange({
      html: editor.getHTML(),
      text: editor.getText({ blockSeparator: "\n\n" }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  if (editor === null) {
    // Should not happen in practice — useEditor returns the editor on
    // first render. The guard keeps strict TypeScript happy and gives
    // SSR a graceful fallback.
    return <div className="rich-editor rich-editor--loading" />;
  }

  return (
    <div className="rich-editor">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="rich-editor__host" />
    </div>
  );
}

interface ToolbarProps {
  editor: Editor;
}

// Mono labels, no icons. State is read via useEditorState so the
// active/inactive styling tracks caret position without imperative DOM
// reads. Six controls match the closed mark/node policy.
function Toolbar({ editor }: ToolbarProps): JSX.Element {
  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: ed.isActive("bold"),
      italic: ed.isActive("italic"),
      link: ed.isActive("link"),
      orderedList: ed.isActive("orderedList"),
      bulletList: ed.isActive("bulletList"),
      blockquote: ed.isActive("blockquote"),
    }),
  });

  const onLink = (): void => {
    if (state.link) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const prev = editor.getAttributes("link")["href"] as string | undefined;
    const url = window.prompt("URL", prev ?? "https://");
    if (url === null) return;
    if (url.length === 0) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: url })
      .run();
  };

  return (
    <div className="rich-editor__toolbar mono" role="toolbar" aria-label="Formatting">
      <ToolbarButton
        active={state.bold}
        label="B"
        title="Bold (⌘B)"
        onClick={() => editor.chain().focus().toggleBold().run()}
        styleWeight="bold"
      />
      <ToolbarButton
        active={state.italic}
        label="I"
        title="Italic (⌘I)"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        styleWeight="italic"
      />
      <ToolbarButton
        active={state.link}
        label="link"
        title="Link (⌘K)"
        onClick={onLink}
      />
      <span className="rich-editor__sep" aria-hidden />
      <ToolbarButton
        active={state.orderedList}
        label="1."
        title="Numbered list"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton
        active={state.bulletList}
        label="•"
        title="Bullet list"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        active={state.blockquote}
        label={"”"}
        title="Quote"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
    </div>
  );
}

interface ToolbarButtonProps {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
  styleWeight?: "bold" | "italic";
}

function ToolbarButton({
  active,
  label,
  title,
  onClick,
  styleWeight,
}: ToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={
        "rich-editor__btn" + (active ? " rich-editor__btn--active" : "")
      }
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      aria-pressed={active}
      aria-label={title}
      data-weight={styleWeight ?? undefined}
    >
      {label}
    </button>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
