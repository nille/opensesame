import {
  handleDeliveryEvent,
  parseSnsDeliveryEvent,
  type DeliveryEventHandlerDeps,
} from "../core/delivery-events.js";

// Pure factory for the bounce-handler Lambda body (ADR-0018). Wired into
// the AWS-bound entry in `bounce-handler.handler.ts`.
//
// SNS event shape (the SDK type lives in @types/aws-lambda; we keep this
// module SDK-free so the unit tests don't have to install the typings):
//   { Records: [{ Sns: { Message: string, ... } }, ...] }
//
// Each record carries one SES delivery-event JSON (double-encoded inside
// the SNS Message field). We parse each, then hand off to the orchestrator.
// Per-record failures don't stop the batch — SNS-to-Lambda is one record
// per invocation by default, but the handler is written defensively so a
// future fan-in (FIFO topic, batched event source) doesn't surprise us.

export type SnsRecord = {
  Sns: {
    Message: string;
    MessageId?: string;
  };
};

export type SnsEvent = {
  Records: SnsRecord[];
};

export type BounceHandlerLogger = {
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
};

export type BounceHandlerDeps = DeliveryEventHandlerDeps & {
  logger?: BounceHandlerLogger;
};

const defaultLogger: BounceHandlerLogger = {
  warn: (m, f) => console.warn(m, f ?? {}),
  info: (m, f) => console.info(m, f ?? {}),
};

export function makeBounceHandler(
  deps: BounceHandlerDeps,
): (event: SnsEvent) => Promise<void> {
  const logger = deps.logger ?? defaultLogger;
  return async (event) => {
    const records = event.Records ?? [];
    if (records.length === 0) {
      logger.warn("bounce-handler: SNS event with no records");
      return;
    }
    for (const record of records) {
      const snsMessageId = record.Sns?.MessageId ?? "(no SNS MessageId)";
      const snsMessage = record.Sns?.Message;
      if (typeof snsMessage !== "string") {
        logger.warn("bounce-handler: record missing Sns.Message", {
          snsMessageId,
        });
        continue;
      }
      const parsed = parseSnsDeliveryEvent(snsMessage);
      if (!parsed.ok) {
        logger.warn("bounce-handler: unparseable SES event, skipping", {
          snsMessageId,
          error: parsed.error,
        });
        continue;
      }
      const result = await handleDeliveryEvent(parsed.event, deps);
      logger.info("bounce-handler: processed", {
        ses_message_id: parsed.event.ses_message_id,
        event_id: parsed.event.event_id,
        category: parsed.event.category,
        delivery_status: result.status,
        message_row_updated: result.messageRowUpdated,
      });
    }
  };
}
