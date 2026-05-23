// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import {
  isStructurallyTrivial,
  makeStarterKit,
} from "../../src/web/src/lib/rich-editor-config.js";

// ADR-0042 (slice 8.21). The composer's TipTap editor enforces a closed
// mark/node policy — only the six controls in the toolbar, plus
// paragraph + text. These tests pin the round-trip behaviour: getHTML()
// emits the expected tag for each control and getText() yields the
// auto-derived plain-text the BFF can ship without body_html.

function makeEditor(content = ""): Editor {
  // Headless construction: no DOM mount, no React. The editor still
  // builds the same schema we ship, so getHTML / getText / commands
  // round-trip exactly the way they will in the browser.
  return new Editor({
    extensions: [makeStarterKit()],
    content,
  });
}

describe("RichEditor — toolbar round-trip", () => {
  it("bold wraps the selected text in <strong>", () => {
    const editor = makeEditor("<p>hello world</p>");
    editor.commands.selectAll();
    editor.commands.toggleBold();
    expect(editor.getHTML()).toContain("<strong>hello world</strong>");
    expect(editor.getText()).toBe("hello world");
    editor.destroy();
  });

  it("italic wraps the selected text in <em>", () => {
    const editor = makeEditor("<p>tilted</p>");
    editor.commands.selectAll();
    editor.commands.toggleItalic();
    expect(editor.getHTML()).toContain("<em>tilted</em>");
    expect(editor.getText()).toBe("tilted");
    editor.destroy();
  });

  it("setLink creates an <a href> with rel + target hardening", () => {
    const editor = makeEditor("<p>click me</p>");
    editor.commands.selectAll();
    editor.commands.setLink({ href: "https://example.com" });
    const html = editor.getHTML();
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(editor.getText()).toBe("click me");
    editor.destroy();
  });

  it("ordered list emits <ol><li>", () => {
    const editor = makeEditor("<p>first</p>");
    editor.commands.selectAll();
    editor.commands.toggleOrderedList();
    const html = editor.getHTML();
    expect(html).toContain("<ol");
    expect(html).toContain("<li>");
    editor.destroy();
  });

  it("bullet list emits <ul><li>", () => {
    const editor = makeEditor("<p>milk</p>");
    editor.commands.selectAll();
    editor.commands.toggleBulletList();
    const html = editor.getHTML();
    expect(html).toContain("<ul");
    expect(html).toContain("<li>");
    editor.destroy();
  });

  it("blockquote wraps the paragraph in <blockquote>", () => {
    const editor = makeEditor("<p>quoted</p>");
    editor.commands.selectAll();
    editor.commands.toggleBlockquote();
    expect(editor.getHTML()).toContain("<blockquote>");
    expect(editor.getHTML()).toContain("quoted");
    editor.destroy();
  });

  it("drops disallowed nodes from pasted HTML (closed schema)", () => {
    // h1, code, hr, strike all disabled in makeStarterKit. They should
    // either be re-rendered as paragraphs/text or stripped. The
    // important property is that the dangerous/excluded shapes don't
    // round-trip in the output.
    const editor = makeEditor(
      `<h1>title</h1><p><s>strike</s> <code>x</code></p><hr/>`,
    );
    const html = editor.getHTML();
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<s>");
    expect(html).not.toContain("<code");
    expect(html).not.toContain("<hr");
    // Text content survives even when its wrapping element does not.
    expect(editor.getText()).toContain("title");
    expect(editor.getText()).toContain("strike");
    editor.destroy();
  });

  it("plain prose comes out structurally trivial — body_html should be suppressed", () => {
    const editor = makeEditor("<p>hi there</p><p>just text</p>");
    expect(isStructurallyTrivial(editor.getHTML())).toBe(true);
    editor.destroy();
  });

  it("any toolbar action makes the doc non-trivial — body_html should ship", () => {
    const editor = makeEditor("<p>hi there</p>");
    editor.commands.selectAll();
    editor.commands.toggleBold();
    expect(isStructurallyTrivial(editor.getHTML())).toBe(false);
    editor.destroy();
  });
});

describe("isStructurallyTrivial", () => {
  it("treats empty string as trivial", () => {
    expect(isStructurallyTrivial("")).toBe(true);
  });

  it("treats only <p>/<br> wrappers as trivial", () => {
    expect(isStructurallyTrivial("<p>hi</p>")).toBe(true);
    expect(isStructurallyTrivial("<p>line one<br/>line two</p>")).toBe(true);
    expect(isStructurallyTrivial("<p></p><p>x</p>")).toBe(true);
  });

  it("flags any other tag as non-trivial", () => {
    expect(isStructurallyTrivial("<p><strong>bold</strong></p>")).toBe(false);
    expect(isStructurallyTrivial("<ul><li>x</li></ul>")).toBe(false);
    expect(isStructurallyTrivial("<blockquote>q</blockquote>")).toBe(false);
    expect(isStructurallyTrivial(`<p><a href="x">x</a></p>`)).toBe(false);
  });
});
