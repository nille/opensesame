import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../src/core/parser.js";
import {
  type SkeletonRow,
  type StoredMessage,
  isSkeletonRow,
} from "../src/core/store.js";

// The store port is just types + a runtime discriminator; there's no
// implementation in this slice. The DDB-backed implementation lives in
// src/aws/dynamodb.ts in a later slice. These tests pin the discriminator's
// shape so reader code (per ADR-0012: "every reader handles the partially-
// parsed state") stays stable.

const PARSED: ParsedMessage = {
  headers: {
    from: null,
    to: null,
    cc: null,
    subject: null,
    date: null,
    messageId: null,
    inReplyTo: null,
    references: null,
    autoSubmitted: "no",
    listId: null,
    customHeaders: {},
    customHeadersTruncated: false,
  },
  headersBlob: "",
  bodyText: "",
  bodyHtml: null,
  attachments: [],
};

describe("isSkeletonRow", () => {
  it("returns true for rows with parse_status === 'failed'", () => {
    const row: SkeletonRow = {
      parse_status: "failed",
      parse_error: "no boundary parameter",
      internal_id: "01HF7E0000000000000000DYNAMO",
      address: "alice@acme.com",
      received_at: "2026-05-19T14:23:10.901Z",
      raw_s3_uri: "s3://bucket/2026/05/19/msg.eml",
      schema_v: "1",
    };
    expect(isSkeletonRow(row)).toBe(true);
  });

  it("returns false for fully-parsed StoredMessage rows", () => {
    const row: StoredMessage = {
      parse_status: "ok",
      internal_id: "01HF7E0000000000000000DYNAMO",
      address: "alice@acme.com",
      received_at: "2026-05-19T14:23:10.901Z",
      raw_s3_uri: "s3://bucket/2026/05/19/msg.eml",
      schema_v: "1",
      parsed: PARSED,
    };
    expect(isSkeletonRow(row)).toBe(false);
  });
});
