import { describe, expect, it } from "vitest";
import { buildMailIngestedEvent } from "../src/core/event.js";
import type { ParsedMessage } from "../src/core/parser.js";

const enc = new TextEncoder();

// A minimal ParsedMessage factory so each test can override only the fields it
// actually exercises. Mirrors what parseMime would return for a normal inbound
// message; defaults align with ADR-0010 "no extras present" baselines.
function makeParsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    headers: {
      from: "Sender Name <sender@example.com>",
      to: "alice@acme.com",
      cc: null,
      subject: "Re: Q2 invoice",
      date: "Tue, 19 May 2026 14:23:10 +0000",
      messageId: "<msg-1@example.com>",
      inReplyTo: null,
      references: null,
      autoSubmitted: "no",
      listId: null,
      customHeaders: {},
      customHeadersTruncated: false,
    },
    headersBlob: "From: Sender <sender@example.com>\r\n",
    bodyText: "hi",
    bodyHtml: null,
    attachments: [],
    ...overrides,
  };
}

const baseInput = {
  parsed: makeParsed(),
  internalId: "01HF7E0000000000000000DYNAMO",
  address: "alice@acme.com",
  receivedAt: "2026-05-19T14:23:10.901Z",
  sizeBytes: 28934,
  rawS3Uri:
    "s3://opensesame-raw-mime-123456789012/2026/05/19/<msg-1@example.com>.eml",
  verdicts: {
    spam: "PASS",
    virus: "PASS",
    dkim: "PASS",
    spf: "PASS",
    dmarc: "PASS",
  },
  eventId: "01HF7E0000000000000000EVENTX",
  occurredAt: "2026-05-19T14:23:11.482Z",
  deploymentId: "deploy-acme-prod",
} as const;

describe("buildMailIngestedEvent", () => {
  it("emits the ADR-0010 envelope with caller-supplied id, time, and deployment", () => {
    const event = buildMailIngestedEvent(baseInput);

    // Envelope is fixed across every event type Open Sesame may emit.
    expect(event.schema_version).toBe("1");
    expect(event.event_type).toBe("MailIngested");
    expect(event.event_id).toBe("01HF7E0000000000000000EVENTX");
    expect(event.occurred_at).toBe("2026-05-19T14:23:11.482Z");
    expect(event.deployment_id).toBe("deploy-acme-prod");
    expect(event.data).toBeDefined();
  });

  it("populates data.message_id, internal_id, address, received_at, size_bytes, raw_s3_uri", () => {
    const event = buildMailIngestedEvent(baseInput);

    expect(event.data.message_id).toBe("<msg-1@example.com>");
    expect(event.data.internal_id).toBe("01HF7E0000000000000000DYNAMO");
    expect(event.data.address).toBe("alice@acme.com");
    expect(event.data.received_at).toBe("2026-05-19T14:23:10.901Z");
    expect(event.data.size_bytes).toBe(28934);
    expect(event.data.raw_s3_uri).toBe(
      "s3://opensesame-raw-mime-123456789012/2026/05/19/<msg-1@example.com>.eml",
    );
  });

  it("parses From into a single object with address + name", () => {
    const event = buildMailIngestedEvent(baseInput);

    // Per ADR-0010, `from` is an object (not an array) and the display name
    // is `null` when absent — a missing name must not collapse the field.
    expect(event.data.from).toEqual({
      address: "sender@example.com",
      name: "Sender Name",
    });
  });

  it("parses To and Cc into address lists, with empty arrays when headers are absent", () => {
    const event = buildMailIngestedEvent({
      ...baseInput,
      parsed: makeParsed({
        headers: {
          ...makeParsed().headers,
          to: "Alice <alice@acme.com>, bob@example.com",
          cc: "Carol <carol@example.com>",
        },
      }),
    });

    expect(event.data.to).toEqual([
      { address: "alice@acme.com", name: "Alice" },
      { address: "bob@example.com", name: null },
    ]);
    expect(event.data.cc).toEqual([
      { address: "carol@example.com", name: "Carol" },
    ]);

    const noLists = buildMailIngestedEvent({
      ...baseInput,
      parsed: makeParsed({
        headers: {
          ...makeParsed().headers,
          to: null,
          cc: null,
        },
      }),
    });

    // Per ADR-0010 these are arrays, never null — keeps consumer code branch-free.
    expect(noLists.data.to).toEqual([]);
    expect(noLists.data.cc).toEqual([]);
  });

  it("returns null for from when the From header is absent", () => {
    // ADR-0010 shows from as a non-null object in the example, but inbound MIME
    // can technically omit From — we surface null rather than fabricating one.
    const event = buildMailIngestedEvent({
      ...baseInput,
      parsed: makeParsed({
        headers: { ...makeParsed().headers, from: null },
      }),
    });
    expect(event.data.from).toBeNull();
  });

  it("derives thread_id from References / In-Reply-To / Message-ID in that order", () => {
    const reply = buildMailIngestedEvent({
      ...baseInput,
      parsed: makeParsed({
        headers: {
          ...makeParsed().headers,
          messageId: "<reply-2@example.com>",
          inReplyTo: "<reply-1@example.com>",
          references: "<root@example.com> <reply-1@example.com>",
        },
      }),
    });
    expect(reply.data.thread_id).toBe("<root@example.com>");

    // Brand new thread → its own message id.
    const fresh = buildMailIngestedEvent({
      ...baseInput,
      parsed: makeParsed({
        headers: {
          ...makeParsed().headers,
          messageId: "<fresh@example.com>",
          inReplyTo: null,
          references: null,
        },
      }),
    });
    expect(fresh.data.thread_id).toBe("<fresh@example.com>");

    // Per ADR-0010 thread_id is best-effort: null when nothing is usable.
    const headless = buildMailIngestedEvent({
      ...baseInput,
      parsed: makeParsed({
        headers: {
          ...makeParsed().headers,
          messageId: null,
          inReplyTo: null,
          references: null,
        },
      }),
    });
    expect(headless.data.thread_id).toBeNull();
  });

  it("passes in_reply_to and references through verbatim, with null for absent", () => {
    const replyHeaders = makeParsed({
      headers: {
        ...makeParsed().headers,
        inReplyTo: "<orig@example.com>",
        references: "<root@example.com> <orig@example.com>",
      },
    });
    const event = buildMailIngestedEvent({ ...baseInput, parsed: replyHeaders });

    expect(event.data.in_reply_to).toBe("<orig@example.com>");
    // ADR-0010 gives references as a structured array of msg-ids, not the raw
    // whitespace-joined header value.
    expect(event.data.references).toEqual([
      "<root@example.com>",
      "<orig@example.com>",
    ]);

    const fresh = buildMailIngestedEvent(baseInput);
    expect(fresh.data.in_reply_to).toBeNull();
    expect(fresh.data.references).toEqual([]);
  });

  it("summarizes attachments and derives has_attachments / attachment_count", () => {
    const withAtt = buildMailIngestedEvent({
      ...baseInput,
      parsed: makeParsed({
        attachments: [
          {
            filename: "invoice-q2.pdf",
            contentType: "application/pdf",
            sizeBytes: 18452,
            contentId: null,
          },
          {
            filename: "summary.xlsx",
            contentType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            sizeBytes: 9120,
            contentId: null,
          },
        ],
      }),
    });

    expect(withAtt.data.has_attachments).toBe(true);
    expect(withAtt.data.attachment_count).toBe(2);
    // Per ADR-0010 the event carries summary only — filename, MIME type, size.
    // contentId is internal to the parser and must not appear here.
    expect(withAtt.data.attachments).toEqual([
      {
        filename: "invoice-q2.pdf",
        content_type: "application/pdf",
        size_bytes: 18452,
      },
      {
        filename: "summary.xlsx",
        content_type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size_bytes: 9120,
      },
    ]);

    const empty = buildMailIngestedEvent(baseInput);
    expect(empty.data.has_attachments).toBe(false);
    expect(empty.data.attachment_count).toBe(0);
    expect(empty.data.attachments).toEqual([]);
  });

  it("forwards auto_submitted, list_id, custom_headers, and the truncated flag", () => {
    const event = buildMailIngestedEvent({
      ...baseInput,
      parsed: makeParsed({
        headers: {
          ...makeParsed().headers,
          autoSubmitted: "auto-generated",
          listId: "Acme Newsletter <newsletter.acme.com>",
          customHeaders: { "x-mailer": "Acme Billing 4.2", "x-priority": "3" },
          customHeadersTruncated: false,
        },
      }),
    });

    expect(event.data.auto_submitted).toBe("auto-generated");
    expect(event.data.list_id).toBe("Acme Newsletter <newsletter.acme.com>");
    expect(event.data.custom_headers).toEqual({
      "x-mailer": "Acme Billing 4.2",
      "x-priority": "3",
    });
    // ADR-0010 says the `custom_headers_truncated: true` flag is only set when
    // overflow happens — omit it when no truncation occurred to match the
    // documented additive shape.
    expect(event.data.custom_headers_truncated).toBeUndefined();
  });

  it("emits custom_headers_truncated: true when the parser flagged overflow", () => {
    const event = buildMailIngestedEvent({
      ...baseInput,
      parsed: makeParsed({
        headers: {
          ...makeParsed().headers,
          customHeaders: { "x-tag-0": "something" },
          customHeadersTruncated: true,
        },
      }),
    });

    expect(event.data.custom_headers_truncated).toBe(true);
  });

  it("passes SES verdicts through verbatim", () => {
    // Per ADR-0010 Open Sesame does not re-judge — verdicts mirror SES.
    const event = buildMailIngestedEvent({
      ...baseInput,
      verdicts: {
        spam: "FAIL",
        virus: "PASS",
        dkim: "GRAY",
        spf: "PASS",
        dmarc: "FAIL",
      },
    });

    expect(event.data.spam_verdict).toBe("FAIL");
    expect(event.data.virus_verdict).toBe("PASS");
    expect(event.data.dkim_verdict).toBe("GRAY");
    expect(event.data.spf_verdict).toBe("PASS");
    expect(event.data.dmarc_verdict).toBe("FAIL");
  });

  it("returns null for list_id when absent and 'no' for auto_submitted by default", () => {
    const event = buildMailIngestedEvent(baseInput);
    expect(event.data.list_id).toBeNull();
    // parseMime collapses absent Auto-Submitted to "no" — the builder forwards.
    expect(event.data.auto_submitted).toBe("no");
  });

  it("does not mutate its input", () => {
    // Coding-style rule: builders must return new objects. Snapshot a couple
    // of input fields and verify they're unchanged after the call.
    const parsed = makeParsed({
      attachments: [
        {
          filename: "a.pdf",
          contentType: "application/pdf",
          sizeBytes: 10,
          contentId: null,
        },
      ],
    });
    const input = { ...baseInput, parsed };
    const beforeAttachments = parsed.attachments.slice();

    buildMailIngestedEvent(input);

    expect(parsed.attachments).toEqual(beforeAttachments);
    expect(parsed.attachments).toBe(input.parsed.attachments);
  });

  it("accepts a non-textual size_bytes (raw MIME byte count) without re-encoding bodyText", () => {
    // The caller knows the true on-the-wire size from the S3 object. The
    // builder must not try to recompute from parsed.bodyText (which is
    // post-decoding and would understate or overstate the truth).
    const event = buildMailIngestedEvent({ ...baseInput, sizeBytes: 1234567 });
    expect(event.data.size_bytes).toBe(1234567);
  });

  // Sanity check that we haven't drifted from ADR-0010's documented top-level
  // `data` field set. If this list changes, ADR-0010 + this expectation must
  // change together.
  it("data has exactly the ADR-0010 top-level field set (additive only via custom_headers_truncated)", () => {
    const event = buildMailIngestedEvent(baseInput);
    const keys = Object.keys(event.data).sort();
    expect(keys).toEqual(
      [
        "address",
        "attachment_count",
        "attachments",
        "auto_submitted",
        "cc",
        "custom_headers",
        "dkim_verdict",
        "dmarc_verdict",
        "from",
        "has_attachments",
        "in_reply_to",
        "internal_id",
        "list_id",
        "message_id",
        "raw_s3_uri",
        "received_at",
        "references",
        "size_bytes",
        "spam_verdict",
        "spf_verdict",
        "subject",
        "thread_id",
        "to",
        "virus_verdict",
      ].sort(),
    );
  });

  // Echo the example in the codebase for completeness — a tiny non-textual
  // pad to confirm the builder works against a `parseMime` result rather than
  // a hand-rolled ParsedMessage.
  it("composes an event from a real parseMime + parseAddressList result", async () => {
    const { parseMime } = await import("../src/core/parser.js");
    const raw = enc.encode(
      [
        "From: =?utf-8?B?QmrDtnJu?= <bjorn@example.com>",
        "To: Alice <alice@acme.com>, bob@example.com",
        "Cc: carol@example.com",
        "Subject: =?utf-8?Q?Re=3A_Q2_invoice?=",
        "Message-ID: <m1@example.com>",
        "Auto-Submitted: no",
        "X-Mailer: Acme Billing 4.2",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
        "",
      ].join("\r\n"),
    );
    const parsed = parseMime(raw);

    const event = buildMailIngestedEvent({ ...baseInput, parsed });

    expect(event.data.from).toEqual({
      address: "bjorn@example.com",
      name: "Björn",
    });
    expect(event.data.to.map((a) => a.address)).toEqual([
      "alice@acme.com",
      "bob@example.com",
    ]);
    expect(event.data.cc).toEqual([
      { address: "carol@example.com", name: null },
    ]);
    expect(event.data.subject).toBe("Re: Q2 invoice");
    expect(event.data.thread_id).toBe("<m1@example.com>");
    expect(event.data.custom_headers["x-mailer"]).toBe("Acme Billing 4.2");
  });
});
