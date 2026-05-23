// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeForReader } from "../../src/web/src/lib/html-sanitize.js";

// ADR-0042 (slice 8.21). The reader pane renders email HTML through
// DOMPurify with a closed allow-list. These tests pin the policy: the
// dangerous shapes that real email surfaces in the wild must come out
// inert, the safe shapes must round-trip, and remote <img> tags must be
// rewritten to a placeholder so the operator can opt-in once per open.

describe("sanitizeForReader — closed allow-list", () => {
  it("drops <script> tags and their contents", () => {
    const { html } = sanitizeForReader(
      `<p>before</p><script>alert("xss")</script><p>after</p>`,
      false,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("strips inline event handlers like onclick", () => {
    const { html } = sanitizeForReader(
      `<a href="https://example.com" onclick="alert(1)">click</a>`,
      false,
    );
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert");
    expect(html).toContain("https://example.com");
  });

  it("removes javascript: hrefs from anchors", () => {
    const { html } = sanitizeForReader(
      `<a href="javascript:alert(1)">go</a>`,
      false,
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("alert");
    // The anchor stays, just without an href to nowhere dangerous.
    expect(html).toContain("go");
  });

  it("drops <iframe> entirely", () => {
    const { html } = sanitizeForReader(
      `<iframe src="https://evil.example/"></iframe><p>kept</p>`,
      false,
    );
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("kept");
  });

  it("drops <object>, <embed>, <form>, <input>, and <style>", () => {
    const { html } = sanitizeForReader(
      [
        `<object data="x"></object>`,
        `<embed src="x" />`,
        `<form action="x"><input name="y"></form>`,
        `<style>p{color:red}</style>`,
        `<p>kept</p>`,
      ].join(""),
      false,
    );
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<embed");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<style");
    expect(html).toContain("kept");
  });

  it("strips inline style attributes", () => {
    const { html } = sanitizeForReader(
      `<p style="background:url(javascript:alert(1))">hello</p>`,
      false,
    );
    expect(html).not.toContain("style=");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("hello");
  });

  it("keeps https: links and adds rel/target hardening", () => {
    const { html } = sanitizeForReader(
      `<a href="https://example.com/x">x</a>`,
      false,
    );
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
  });

  it("keeps mailto: links", () => {
    const { html } = sanitizeForReader(
      `<a href="mailto:bob@example.com">bob</a>`,
      false,
    );
    expect(html).toContain("mailto:bob@example.com");
  });

  it("keeps cid: image references untouched (inline attachment path)", () => {
    const { html, remoteCount } = sanitizeForReader(
      `<img src="cid:abc123@x" alt="logo" />`,
      false,
    );
    expect(html).toContain('src="cid:abc123@x"');
    expect(remoteCount).toBe(0);
  });

  it("keeps data:image/png URIs (already inert binary)", () => {
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    const { html, remoteCount } = sanitizeForReader(
      `<img src="${tinyPng}" alt="dot" />`,
      false,
    );
    expect(html).toContain("data:image/png;base64,");
    expect(remoteCount).toBe(0);
  });

  it("rewrites remote <img> to placeholder span and counts them when not loaded", () => {
    const { html, remoteCount } = sanitizeForReader(
      `<p>hi</p><img src="https://tracker.example/pix.gif" alt="pixel" /><img src="http://other.example/logo.png" />`,
      false,
    );
    expect(remoteCount).toBe(2);
    expect(html).not.toMatch(/<img\s+[^>]*src="https?:/);
    expect(html).toContain("data-os-remote-img=");
    // Both originals show up as placeholder data attrs.
    expect(html).toContain("https://tracker.example/pix.gif");
    expect(html).toContain("http://other.example/logo.png");
    // alt text becomes both title and visible label when present.
    expect(html).toContain("pixel");
  });

  it("renders remote <img> normally when loadRemote = true", () => {
    const { html, remoteCount } = sanitizeForReader(
      `<img src="https://tracker.example/pix.gif" alt="pixel" />`,
      true,
    );
    expect(remoteCount).toBe(1);
    expect(html).toContain('src="https://tracker.example/pix.gif"');
    expect(html).not.toContain("os-remote-img");
  });

  it("drops <img src> with disallowed schemes and does not count them as remote", () => {
    const { html, remoteCount } = sanitizeForReader(
      `<img src="javascript:alert(1)" alt="x" />`,
      false,
    );
    expect(html).not.toContain("javascript:");
    expect(remoteCount).toBe(0);
  });

  it("preserves common formatting tags from the allow-list", () => {
    const { html } = sanitizeForReader(
      `<p><strong>bold</strong> <em>em</em> <a href="https://x">link</a></p><ul><li>one</li></ul><blockquote>q</blockquote>`,
      false,
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<blockquote>q</blockquote>");
  });
});
