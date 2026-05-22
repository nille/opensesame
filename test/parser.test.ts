import { describe, expect, it } from "vitest";
import { chunkBody } from "../src/core/chunking.js";
import { MimeParseError, parseMime } from "../src/core/parser.js";

const enc = new TextEncoder();

describe("parseMime", () => {
  it("parses a minimal text/plain message into the expected ParsedMessage shape", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: hello",
        "Date: Thu, 14 May 2026 10:00:00 +0000",
        "Message-ID: <abc123@example.com>",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "hi bob",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.headers.from).toBe("Alice <alice@example.com>");
    expect(parsed.headers.to).toBe("Bob <bob@example.com>");
    expect(parsed.headers.subject).toBe("hello");
    expect(parsed.headers.date).toBe("Thu, 14 May 2026 10:00:00 +0000");
    expect(parsed.headers.messageId).toBe("<abc123@example.com>");

    expect(parsed.bodyText).toBe("hi bob\n");
    expect(parsed.bodyHtml).toBeNull();
    expect(parsed.attachments).toEqual([]);

    // headersBlob must contain the raw header bytes (CRLF preserved) so
    // arbitrary HEADER search per ADR-0004 works.
    expect(parsed.headersBlob).toContain("From: Alice <alice@example.com>\r\n");
    expect(parsed.headersBlob).toContain("Subject: hello\r\n");
  });

  it("extracts both bodyText and bodyHtml from multipart/alternative", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: alt",
        'Content-Type: multipart/alternative; boundary="bnd1"',
        "",
        "--bnd1",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "plain hi",
        "--bnd1",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>html hi</p>",
        "--bnd1--",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    // Per RFC 2046, the CRLF preceding a boundary delimiter is part of the
    // boundary, not the body — so part bodies have no trailing newline here.
    expect(parsed.bodyText).toBe("plain hi");
    expect(parsed.bodyHtml).toBe("<p>html hi</p>");
    expect(parsed.attachments).toEqual([]);
  });

  it("recurses into nested multipart/alternative inside multipart/mixed", () => {
    // Real-world Gmail shape: multipart/mixed { multipart/alternative {
    //   text/plain, text/html }, image/png attachment }. Without recursion
    // the parser silently drops the inner multipart and bodyText comes back
    // empty — a "successful" parse that lies to readers (the bug ADR-0012
    // explicitly forbids).
    const pngBytes = "\x89PNG\r\n\x1a\n fake-png-bytes";
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: nested",
        'Content-Type: multipart/mixed; boundary="outer"',
        "",
        "--outer",
        'Content-Type: multipart/alternative; boundary="inner"',
        "",
        "--inner",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "plain body inside nested alt",
        "--inner",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>html body inside nested alt</p>",
        "--inner--",
        "--outer",
        "Content-Type: image/png",
        'Content-Disposition: attachment; filename="img.png"',
        "",
        pngBytes,
        "--outer--",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.bodyText).toBe("plain body inside nested alt");
    expect(parsed.bodyHtml).toBe("<p>html body inside nested alt</p>");

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe("img.png");
    expect(parsed.attachments[0]!.contentType).toBe("image/png");
  });

  it("returns an attachment summary for multipart/mixed and keeps binary out of body fields", () => {
    // %PDF-1.4 followed by some bytes a real PDF often contains.
    const pdfBytes = "%PDF-1.4\n%âãÏÓ binary-marker";
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: with attachment",
        'Content-Type: multipart/mixed; boundary="bnd2"',
        "",
        "--bnd2",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "see attached",
        "--bnd2",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="invoice.pdf"',
        "Content-ID: <invoice-1>",
        "",
        pdfBytes,
        "--bnd2--",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.bodyText).toBe("see attached");
    expect(parsed.bodyHtml).toBeNull();

    expect(parsed.attachments).toHaveLength(1);
    const att = parsed.attachments[0]!;
    expect(att.filename).toBe("invoice.pdf");
    expect(att.contentType).toBe("application/pdf");
    expect(att.contentId).toBe("<invoice-1>");
    expect(att.sizeBytes).toBe(enc.encode(pdfBytes).length);

    // Per ADR-0004, attachment binary content must not appear in any
    // extracted text field. bodyText/bodyHtml are searchable; attachments are
    // summary-only in v1.
    expect(parsed.bodyText).not.toContain("PDF");
    expect(parsed.bodyText).not.toContain("binary-marker");
    expect(parsed.bodyHtml).toBeNull();
  });

  // ------------------------------------------------------------------
  // Byte extraction — slice 8.1: attachments need the actual bytes for
  // S3 storage + presigned download. base64 / quoted-printable are the
  // realistic encodings for binary parts; 7bit/8bit/binary fall through
  // to UTF-8 of the body string and are not lossless for binary content.
  // ------------------------------------------------------------------

  it("extracts base64-encoded attachment bytes losslessly", () => {
    // A small but unmistakably binary payload — high bytes the UTF-8
    // decoder would mangle if the parser tried to decode through string.
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff, 0xe0,
      0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]);
    const b64 = Buffer.from(bytes).toString("base64");

    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: binary attachment",
        'Content-Type: multipart/mixed; boundary="b3"',
        "",
        "--b3",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
        "--b3",
        "Content-Type: image/png",
        'Content-Disposition: attachment; filename="x.png"',
        "Content-Transfer-Encoding: base64",
        "",
        b64,
        "--b3--",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.attachments).toHaveLength(1);
    const att = parsed.attachments[0]!;
    expect(att.filename).toBe("x.png");
    expect(att.contentType).toBe("image/png");
    expect(att.partIndex).toBe(0);
    expect(Array.from(att.bytes)).toEqual(Array.from(bytes));
    expect(att.sizeBytes).toBe(bytes.length);
    // sha256 hex of the bytes — used for dedupe + S3 ETag verification.
    expect(att.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("extracts quoted-printable text attachment bytes as UTF-8", () => {
    // QP-encoded "Hej Björn — räkning"
    const original = "Hej Björn — räkning";
    const qp = "Hej Bj=C3=B6rn =E2=80=94 r=C3=A4kning";
    const expectedBytes = enc.encode(original);

    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: txt attachment",
        'Content-Type: multipart/mixed; boundary="b4"',
        "",
        "--b4",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
        "--b4",
        "Content-Type: text/plain; charset=utf-8",
        'Content-Disposition: attachment; filename="note.txt"',
        "Content-Transfer-Encoding: quoted-printable",
        "",
        qp,
        "--b4--",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.attachments).toHaveLength(1);
    const att = parsed.attachments[0]!;
    expect(att.filename).toBe("note.txt");
    expect(Array.from(att.bytes)).toEqual(Array.from(expectedBytes));
    expect(att.sizeBytes).toBe(expectedBytes.length);
  });

  it("assigns sequential partIndex across multiple attachments", () => {
    const a = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64");
    const b = Buffer.from(new Uint8Array([5, 6, 7, 8, 9])).toString("base64");

    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: two atts",
        'Content-Type: multipart/mixed; boundary="b5"',
        "",
        "--b5",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
        "--b5",
        "Content-Type: application/octet-stream",
        'Content-Disposition: attachment; filename="a.bin"',
        "Content-Transfer-Encoding: base64",
        "",
        a,
        "--b5",
        "Content-Type: application/octet-stream",
        'Content-Disposition: attachment; filename="b.bin"',
        "Content-Transfer-Encoding: base64",
        "",
        b,
        "--b5--",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]!.partIndex).toBe(0);
    expect(parsed.attachments[1]!.partIndex).toBe(1);
    expect(parsed.attachments[0]!.filename).toBe("a.bin");
    expect(parsed.attachments[1]!.filename).toBe("b.bin");
    expect(parsed.attachments[0]!.sizeBytes).toBe(4);
    expect(parsed.attachments[1]!.sizeBytes).toBe(5);
    // sha256 must differ for different content
    expect(parsed.attachments[0]!.sha256).not.toBe(parsed.attachments[1]!.sha256);
  });

  it("falls back to Content-Type name= when Content-Disposition has no filename", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const b64 = Buffer.from(bytes).toString("base64");

    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: name fallback",
        'Content-Type: multipart/mixed; boundary="b6"',
        "",
        "--b6",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
        "--b6",
        'Content-Type: application/octet-stream; name="legacy.bin"',
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        b64,
        "--b6--",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe("legacy.bin");
    expect(Array.from(parsed.attachments[0]!.bytes)).toEqual(Array.from(bytes));
  });

  it("decodes a quoted-printable text/plain body into UTF-8", () => {
    // "Hej Bj=C3=B6rn, =C3=A5=C3=A4=C3=B6" → "Hej Björn, åäö"
    // Plus a soft line break (=\r\n) which must be removed.
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: qp",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Hej Bj=C3=B6rn, =C3=A5=C3=A4=C3=B6 long line that=",
        " continues here.",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.bodyText).toBe("Hej Björn, åäö long line that continues here.\n");
  });

  it("decodes a base64 text/plain body into UTF-8", () => {
    // base64 of "Hej Björn — slutfaktura" (Swedish + em dash)
    const original = "Hej Björn — slutfaktura";
    const b64 = Buffer.from(original, "utf-8").toString("base64");

    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: b64",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64,
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    // base64 stripping collapses whitespace, so no trailing newline survives
    // here — the decoded body is exactly the original string.
    expect(parsed.bodyText).toBe(original);
  });

  it("decodes RFC 2047 encoded-word headers (Q and B encodings)", () => {
    const raw = enc.encode(
      [
        // Q-encoding for Subject: "Slutfaktura — åäö"
        "Subject: =?utf-8?Q?Slutfaktura_=E2=80=94_=C3=A5=C3=A4=C3=B6?=",
        // B-encoding for From display name: "Björn"
        "From: =?utf-8?B?QmrDtnJu?= <bjorn@example.com>",
        "To: Bob <bob@example.com>",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.headers.subject).toBe("Slutfaktura — åäö");
    expect(parsed.headers.from).toBe("Björn <bjorn@example.com>");
  });

  it("preserves CRLF in headersBlob and normalizes bodyText to LF", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: lines",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "line one",
        "line two",
        "line three",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    // Per ADR-0004, headersBlob must be the raw header bytes so HEADER
    // search hits inputs that include literal CRLFs.
    expect(parsed.headersBlob).toContain("From: Alice <alice@example.com>\r\n");
    expect(parsed.headersBlob).toContain("Subject: lines\r\n");
    expect(parsed.headersBlob).not.toMatch(/\r\n\r\n/); // no body in blob

    // bodyText is normalized to LF for downstream chunking + display.
    expect(parsed.bodyText).toBe("line one\nline two\nline three\n");
    expect(parsed.bodyText).not.toContain("\r");
  });

  it("parses Reply-To when present and defaults to null otherwise", () => {
    const withReplyTo = enc.encode(
      [
        "From: list@example.com",
        "To: alice@example.com",
        "Reply-To: list-replies@example.com",
        "Subject: digest",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "hi",
        "",
      ].join("\r\n"),
    );
    expect(parseMime(withReplyTo).headers.replyTo).toBe(
      "list-replies@example.com",
    );

    const withoutReplyTo = enc.encode(
      [
        "From: alice@example.com",
        "To: bob@example.com",
        "Subject: hi",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "hello",
        "",
      ].join("\r\n"),
    );
    expect(parseMime(withoutReplyTo).headers.replyTo).toBeNull();
  });

  it("extracts In-Reply-To and References threading headers", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: Re: hi",
        "Message-ID: <reply-2@example.com>",
        "In-Reply-To: <orig-1@example.com>",
        "References: <root@example.com> <orig-1@example.com>",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "thanks",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.headers.inReplyTo).toBe("<orig-1@example.com>");
    expect(parsed.headers.references).toBe(
      "<root@example.com> <orig-1@example.com>",
    );
  });

  it("throws MimeParseError when multipart declares no boundary", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: bad",
        // multipart/* with no boundary= — structurally unparseable
        "Content-Type: multipart/mixed",
        "",
        "anything",
        "",
      ].join("\r\n"),
    );

    let caught: unknown = null;
    try {
      parseMime(raw);
    } catch (err) {
      caught = err;
    }

    // Per ADR-0012 the ingest Lambda needs a typed error with a short reason
    // it can persist as parse_status: "failed".
    expect(caught).toBeInstanceOf(MimeParseError);
    if (caught instanceof MimeParseError) {
      expect(caught.reason).toMatch(/boundary/i);
    }
  });

  // ADR-0010 mapping — fields the event-payload builder needs from parseMime.

  it("passes Auto-Submitted: through verbatim when present", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: out of office",
        "Auto-Submitted: auto-generated",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "I am away.",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    // Per ADR-0010, the value is forwarded verbatim so consumers can apply
    // RFC 3834 loop suppression without re-parsing the message.
    expect(parsed.headers.autoSubmitted).toBe("auto-generated");
  });

  it("defaults autoSubmitted to 'no' when the header is absent", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: hello",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "hi",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    // Per ADR-0010 the field is non-null; absence collapses to "no".
    expect(parsed.headers.autoSubmitted).toBe("no");
  });

  it("extracts List-Id verbatim when present", () => {
    const raw = enc.encode(
      [
        "From: news@acme.com",
        "To: alice@example.com",
        "Subject: weekly digest",
        "List-Id: Acme Newsletter <newsletter.acme.com>",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "news",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    // ADR-0010 says listId carries the header verbatim so consumers can
    // cheaply distinguish list mail from direct mail.
    expect(parsed.headers.listId).toBe("Acme Newsletter <newsletter.acme.com>");
  });

  it("extracts Cc verbatim and decodes its encoded-words like To", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        // RFC 2047 B-encoding for "Björn"
        "Cc: =?utf-8?B?QmrDtnJu?= <bjorn@example.com>, carol@example.com",
        "Subject: hi all",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "hello cc'd folks",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    // Per ADR-0010 the event payload includes a `cc` array; parseMime hands
    // the structured value to parseAddressList just like `to`.
    expect(parsed.headers.cc).toBe(
      "Björn <bjorn@example.com>, carol@example.com",
    );
  });

  it("returns cc as null when the Cc header is absent", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: no cc",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);
    expect(parsed.headers.cc).toBeNull();
  });

  it("returns listId as null when List-Id is absent", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: direct",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "direct mail",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);
    expect(parsed.headers.listId).toBeNull();
  });

  it("collects X-* headers into a flat lowercase map and skips non-X headers", () => {
    const raw = enc.encode(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: tagged",
        "X-Mailer: Acme Billing 4.2",
        "X-Priority: 3",
        "Received: from mta1.example.com",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);

    expect(parsed.headers.customHeaders).toEqual({
      "x-mailer": "Acme Billing 4.2",
      "x-priority": "3",
    });
    expect(parsed.headers.customHeadersTruncated).toBe(false);
  });

  it("truncates customHeaders past the 4 KB cap and signals via the truncated flag", () => {
    // Build enough large X-* headers to blow the 4 KB budget.
    const big = "x".repeat(500);
    const lines: string[] = [
      "From: Alice <alice@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: lots of tags",
      "Content-Type: text/plain; charset=utf-8",
    ];
    for (let i = 0; i < 20; i++) {
      lines.push(`X-Tag-${i}: ${big}`);
    }
    lines.push("", "body", "");
    const raw = enc.encode(lines.join("\r\n"));

    const parsed = parseMime(raw);

    // Per ADR-0010: overflow is silently dropped with the flag set.
    expect(parsed.headers.customHeadersTruncated).toBe(true);

    const kept = Object.keys(parsed.headers.customHeaders);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(20);

    // Cumulative key+value byte size stays within the 4 KB cap.
    const enc2 = new TextEncoder();
    const total = kept.reduce(
      (n, k) => n + enc2.encode(k).length +
        enc2.encode(parsed.headers.customHeaders[k]!).length,
      0,
    );
    expect(total).toBeLessThanOrEqual(4096);
  });

  it("preserves Swedish + emoji content end-to-end through parseMime → chunkBody", () => {
    // Pad the body past the chunkBody single-chunk threshold so we exercise
    // the multi-chunk path; sprinkle Swedish + emoji through the padding.
    const flavor = "åäö Björn slutfaktura 🇸🇪 — räkning ✉️ ";
    const body = flavor.repeat(20_000); // >> 300 KB once UTF-8-encoded
    const b64 = Buffer.from(body, "utf-8").toString("base64");

    // Wrap base64 to RFC-2045-friendly 76-char lines so we also prove our
    // base64 decoder copes with line-wrapped input.
    const wrapped = b64.replace(/(.{76})/g, "$1\r\n");

    const raw = new TextEncoder().encode(
      [
        "From: Björn <bjorn@example.com>",
        "To: Alice <alice@example.com>",
        "Subject: round-trip",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        wrapped,
        "",
      ].join("\r\n"),
    );

    const parsed = parseMime(raw);
    expect(parsed.bodyText).toBe(body);

    const chunks = chunkBody(parsed.bodyText);
    expect(chunks.length).toBeGreaterThan(1);

    // Reconstruct the chunks and verify lossless round-trip on UTF-8 bytes.
    const enc2 = new TextEncoder();
    const dec2 = new TextDecoder("utf-8", { fatal: true });
    const buffers: Uint8Array[] = [enc2.encode(chunks[0]!.text)];
    for (let i = 1; i < chunks.length; i++) {
      const overlap = chunks[i - 1]!.endByte - chunks[i]!.startByte;
      const bytes = enc2.encode(chunks[i]!.text);
      buffers.push(bytes.subarray(overlap));
    }
    const total = buffers.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of buffers) {
      out.set(b, off);
      off += b.length;
    }
    expect(dec2.decode(out)).toBe(body);
  });
});
