import { describe, expect, it } from "vitest";
import { composeRawMime, type ComposeInput } from "../src/core/composer.js";

const FIXED_NOW = new Date("2026-05-21T13:00:00.000Z");
const FIXED_RANDOM = () =>
  new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // deterministic

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function baseInput(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    from: "test@nille.net",
    to: ["alice@example.com"],
    subject: "Hello",
    bodyText: "Hi there.\n",
    ...overrides,
  };
}

describe("composeRawMime", () => {
  it("produces an RFC 5322 message with required headers and CRLF line endings", () => {
    const { raw, messageId } = composeRawMime(baseInput(), {
      now: () => FIXED_NOW,
      randomBytes: FIXED_RANDOM,
    });
    const text = decode(raw);

    expect(text).toContain("From: test@nille.net\r\n");
    expect(text).toContain("To: alice@example.com\r\n");
    expect(text).toContain("Subject: Hello\r\n");
    expect(text).toContain("Date: Thu, 21 May 2026 13:00:00 +0000\r\n");
    expect(text).toContain("MIME-Version: 1.0\r\n");
    expect(text).toContain(`Message-ID: ${messageId}\r\n`);
    // Header/body separator must be a blank CRLF line.
    expect(text).toContain("\r\n\r\n");
    // No bare LF anywhere — every \n must be preceded by \r.
    expect(/[^\r]\n/.test(text)).toBe(false);
  });

  it("generates a Message-ID with brackets and a domain matching the From address", () => {
    const { messageId } = composeRawMime(baseInput(), {
      now: () => FIXED_NOW,
      randomBytes: FIXED_RANDOM,
    });
    expect(messageId.startsWith("<")).toBe(true);
    expect(messageId.endsWith(">")).toBe(true);
    expect(messageId).toContain("@nille.net>");
    // ULID body: 26 Crockford chars between `<` and `@`.
    const local = messageId.slice(1, messageId.indexOf("@"));
    expect(local).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("encodes a non-ASCII subject as RFC 2047 base64 utf-8", () => {
    const { raw } = composeRawMime(baseInput({ subject: "Héllo 🙂" }), {
      now: () => FIXED_NOW,
      randomBytes: FIXED_RANDOM,
    });
    const text = decode(raw);
    expect(text).toMatch(/Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
  });

  it("emits multiple recipients comma-separated on a single header line", () => {
    const { raw } = composeRawMime(
      baseInput({ to: ["a@example.com", "b@example.com"] }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    expect(decode(raw)).toContain("To: a@example.com, b@example.com\r\n");
  });

  it("emits Cc when provided and omits it when not", () => {
    const withCc = composeRawMime(baseInput({ cc: ["c@example.com"] }), {
      now: () => FIXED_NOW,
      randomBytes: FIXED_RANDOM,
    });
    expect(decode(withCc.raw)).toContain("Cc: c@example.com\r\n");

    const withoutCc = composeRawMime(baseInput(), {
      now: () => FIXED_NOW,
      randomBytes: FIXED_RANDOM,
    });
    expect(decode(withoutCc.raw)).not.toMatch(/^Cc:/m);
  });

  it("never emits Bcc on the wire even when bcc[] is set", () => {
    // Bcc recipients are passed to SES as envelope destinations only —
    // the header MUST NOT appear in the rendered MIME.
    const { raw } = composeRawMime(
      baseInput({ bcc: ["secret@example.com"] }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    expect(decode(raw)).not.toContain("secret@example.com");
    expect(decode(raw)).not.toMatch(/^Bcc:/im);
  });

  it("encodes a text/plain body as quoted-printable utf-8", () => {
    const { raw } = composeRawMime(
      baseInput({ bodyText: "Hej Räksmörgås\n" }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    expect(text).toContain('Content-Type: text/plain; charset="utf-8"\r\n');
    expect(text).toContain("Content-Transfer-Encoding: quoted-printable\r\n");
    // Ä = 0xC3 0x84 → =C3=84
    expect(text).toContain("Hej R=C3=A4ksm=C3=B6rg=C3=A5s");
  });

  it("wraps text + html in multipart/alternative", () => {
    const { raw } = composeRawMime(
      baseInput({ bodyText: "plain", bodyHtml: "<p>html</p>" }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    expect(text).toMatch(
      /Content-Type: multipart\/alternative; boundary="[^"]+"\r\n/,
    );
    expect(text).toContain("plain");
    expect(text).toContain("<p>html</p>");
    // text/plain part precedes text/html part (RFC 2046 §5.1.4 — most-faithful first).
    const plainIdx = text.indexOf("text/plain");
    const htmlIdx = text.indexOf("text/html");
    expect(plainIdx).toBeGreaterThan(0);
    expect(htmlIdx).toBeGreaterThan(plainIdx);
  });

  it("emits In-Reply-To and References headers when provided", () => {
    const { raw } = composeRawMime(
      baseInput({
        inReplyTo: "<orig@example.com>",
        references: ["<orig@example.com>", "<earlier@example.com>"],
      }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    expect(text).toContain("In-Reply-To: <orig@example.com>\r\n");
    expect(text).toContain(
      "References: <orig@example.com> <earlier@example.com>\r\n",
    );
  });

  it("preserves a display name in From with quoted local-part as needed", () => {
    const { raw } = composeRawMime(
      baseInput({ from: "Test User <test@nille.net>" }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    expect(text).toContain("From: Test User <test@nille.net>\r\n");
    // Message-ID must still derive its domain from the bare addr-spec.
    expect(text).toMatch(/Message-ID: <[^>]+@nille\.net>\r\n/);
  });

  it("encodes a non-ASCII display name in From as RFC 2047", () => {
    const { raw } = composeRawMime(
      baseInput({ from: "Räksmörgås <test@nille.net>" }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    expect(text).toMatch(
      /From: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <test@nille\.net>\r\n/,
    );
  });

  it("rejects an empty to[] list", () => {
    expect(() =>
      composeRawMime(baseInput({ to: [] }), {
        now: () => FIXED_NOW,
        randomBytes: FIXED_RANDOM,
      }),
    ).toThrow(/at least one/i);
  });

  it("rejects a from address that is not parseable", () => {
    expect(() =>
      composeRawMime(baseInput({ from: "no-at-sign" }), {
        now: () => FIXED_NOW,
        randomBytes: FIXED_RANDOM,
      }),
    ).toThrow(/from/i);
  });

  it("returns the From addr-spec as fromAddress for envelope use", () => {
    const { fromAddress } = composeRawMime(
      baseInput({ from: "Test User <test@nille.net>" }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    expect(fromAddress).toBe("test@nille.net");
  });

  it("returns the union of to + cc + bcc as envelopeTo for SES SendRawEmail", () => {
    const { envelopeTo } = composeRawMime(
      baseInput({
        to: ["a@example.com", "b@example.com"],
        cc: ["c@example.com"],
        bcc: ["d@example.com"],
      }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    expect(envelopeTo).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "d@example.com",
    ]);
  });

  // ADR-0040 (slice 8.19) — outbound attachments. Body is wrapped in
  // multipart/mixed; each attachment becomes a base64 part with both
  // Content-Type and Content-Disposition carrying the filename.

  it("wraps text-only body + attachment in multipart/mixed", () => {
    const bytes = new Uint8Array([0x48, 0x69, 0x21]); // "Hi!"
    const { raw } = composeRawMime(
      baseInput({
        attachments: [
          { filename: "note.txt", contentType: "text/plain", contentBytes: bytes },
        ],
      }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    expect(text).toMatch(
      /Content-Type: multipart\/mixed; boundary="[^"]+"\r\n/,
    );
    // Body part: text/plain quoted-printable.
    expect(text).toContain('Content-Type: text/plain; charset="utf-8"');
    // Attachment part: declared content-type + base64 body.
    expect(text).toContain('Content-Type: text/plain; name="note.txt"');
    expect(text).toContain('Content-Disposition: attachment; filename="note.txt"');
    expect(text).toContain("Content-Transfer-Encoding: base64");
    // base64("Hi!") = "SGkh"
    expect(text).toContain("SGkh");
    // Body part comes before the attachment part.
    const bodyIdx = text.indexOf("Hi there");
    const attIdx = text.indexOf("SGkh");
    expect(bodyIdx).toBeGreaterThan(0);
    expect(attIdx).toBeGreaterThan(bodyIdx);
  });

  it("nests multipart/alternative inside multipart/mixed when html + attachment", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI marker
    const { raw } = composeRawMime(
      baseInput({
        bodyText: "plain",
        bodyHtml: "<p>html</p>",
        attachments: [
          {
            filename: "pic.jpg",
            contentType: "image/jpeg",
            contentBytes: bytes,
          },
        ],
      }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    // Outer envelope is multipart/mixed.
    expect(text).toMatch(
      /Content-Type: multipart\/mixed; boundary="[^"]+"\r\n/,
    );
    // Inner alternative for body.
    expect(text).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/);
    // Attachment is image/jpeg with the filename on both headers.
    expect(text).toContain('Content-Type: image/jpeg; name="pic.jpg"');
    expect(text).toContain(
      'Content-Disposition: attachment; filename="pic.jpg"',
    );
    // Order: text → html → attachment.
    const plainIdx = text.indexOf("text/plain");
    const htmlIdx = text.indexOf("text/html");
    const jpgIdx = text.indexOf("image/jpeg");
    expect(plainIdx).toBeGreaterThan(0);
    expect(htmlIdx).toBeGreaterThan(plainIdx);
    expect(jpgIdx).toBeGreaterThan(htmlIdx);
  });

  it("emits multiple attachments each as their own part", () => {
    const a = new Uint8Array([0x41]); // "A"
    const b = new Uint8Array([0x42, 0x43]); // "BC"
    const { raw } = composeRawMime(
      baseInput({
        attachments: [
          { filename: "a.txt", contentType: "text/plain", contentBytes: a },
          { filename: "b.txt", contentType: "text/plain", contentBytes: b },
        ],
      }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    expect(text).toContain('name="a.txt"');
    expect(text).toContain('name="b.txt"');
    expect(text).toContain("QQ=="); // base64("A")
    expect(text).toContain("QkM="); // base64("BC")
  });

  it("folds long base64 attachment payload at 76 columns", () => {
    // 200 bytes → 268 base64 chars → 4 folded lines (76+76+76+40).
    const bytes = new Uint8Array(200).fill(0x61); // "aaaa…"
    const { raw } = composeRawMime(
      baseInput({
        attachments: [
          {
            filename: "long.bin",
            contentType: "application/octet-stream",
            contentBytes: bytes,
          },
        ],
      }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    // After the empty separator line, the first base64 line must be ≤ 76
    // chars before the next CRLF.
    const idx = text.indexOf("Content-Transfer-Encoding: base64");
    const tail = text.slice(idx);
    const blank = tail.indexOf("\r\n\r\n");
    const after = tail.slice(blank + 4);
    const firstLine = after.split("\r\n")[0]!;
    expect(firstLine.length).toBeLessThanOrEqual(76);
    expect(firstLine.length).toBeGreaterThan(0);
  });

  it("RFC 5987 encodes a non-ASCII filename on Content-Disposition", () => {
    const bytes = new Uint8Array([0x44]); // "D"
    const { raw } = composeRawMime(
      baseInput({
        attachments: [
          {
            filename: "räksmörgås.txt",
            contentType: "text/plain",
            contentBytes: bytes,
          },
        ],
      }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    // Content-Disposition uses filename*=UTF-8''… for non-ASCII.
    expect(text).toMatch(
      /Content-Disposition: attachment; filename\*=UTF-8''r%C3%A4ksm%C3%B6rg%C3%A5s\.txt/,
    );
    // Content-Type;name= uses RFC 2047 encoded-word.
    expect(text).toMatch(
      /Content-Type: text\/plain; name="=\?utf-8\?B\?[A-Za-z0-9+/=]+\?="/,
    );
  });

  it("falls back to application/octet-stream when contentType is empty", () => {
    const bytes = new Uint8Array([0x45]);
    const { raw } = composeRawMime(
      baseInput({
        attachments: [
          { filename: "x.bin", contentType: "", contentBytes: bytes },
        ],
      }),
      { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
    );
    const text = decode(raw);
    expect(text).toContain('Content-Type: application/octet-stream; name="x.bin"');
  });

  it("rejects a filename containing CRLF (header injection guard)", () => {
    const bytes = new Uint8Array([0x46]);
    expect(() =>
      composeRawMime(
        baseInput({
          attachments: [
            {
              filename: "ok.txt\r\nBcc: leaked@example.com",
              contentType: "text/plain",
              contentBytes: bytes,
            },
          ],
        }),
        { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
      ),
    ).toThrow(/filename/);
  });

  it("rejects a contentType containing a NUL byte", () => {
    const bytes = new Uint8Array([0x47]);
    expect(() =>
      composeRawMime(
        baseInput({
          attachments: [
            {
              filename: "ok.txt",
              contentType: "text/plain ",
              contentBytes: bytes,
            },
          ],
        }),
        { now: () => FIXED_NOW, randomBytes: FIXED_RANDOM },
      ),
    ).toThrow(/contentType/);
  });
});
