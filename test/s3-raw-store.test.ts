import { describe, expect, it, vi } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { makeS3RawMessageWriter } from "../src/aws/s3-raw-store.js";

// S3-bound RawMessageWriter (ADR-0017). The adapter is one PutObject;
// these tests assert the on-the-wire command shape so a future SDK bump
// or stub-swap doesn't silently change Bucket/Key/Body.

type StubClient = { send: ReturnType<typeof vi.fn> };

function makeStubClient(): StubClient {
  return { send: vi.fn(async () => ({})) };
}

describe("makeS3RawMessageWriter", () => {
  it("issues a single PutObjectCommand with the supplied bucket, key, and bytes", async () => {
    const client = makeStubClient();
    const writer = makeS3RawMessageWriter({ client: client as never });

    const raw = new Uint8Array([0x68, 0x69, 0x0d, 0x0a]);
    await writer.putRaw({
      bucket: "opensesame-raw-mime-925039213717",
      key: "outbound/ses-msgid-1",
      raw,
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    const cmd = client.send.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    const input = (cmd as PutObjectCommand).input;
    expect(input.Bucket).toBe("opensesame-raw-mime-925039213717");
    expect(input.Key).toBe("outbound/ses-msgid-1");
    expect(input.Body).toBe(raw);
    expect(input.ContentType).toBe("application/octet-stream");
  });

  it("propagates SDK errors verbatim", async () => {
    const boom = new Error("AccessDenied");
    const client: StubClient = {
      send: vi.fn(async () => {
        throw boom;
      }),
    };
    const writer = makeS3RawMessageWriter({ client: client as never });

    await expect(
      writer.putRaw({
        bucket: "b",
        key: "outbound/x",
        raw: new Uint8Array([0]),
      }),
    ).rejects.toBe(boom);
  });
});
