import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  bff,
  type DraftAttachmentRef,
  type ReadMessageHeaders,
  type ReplyToEmailRpcResult,
  type RpcResult,
  type SaveDraftInput,
  type SendEmailAttachment,
  type SendEmailResult,
  type StoredDraft,
} from "../lib/bff-client.ts";
import {
  canonicalReSubject,
  previewQuotedBody,
  previewReplyAllCc,
  previewReplyTarget,
} from "../lib/reply-preview.ts";
import { sendAndArchive } from "../lib/send-and-archive.ts";
import { RichEditor, isStructurallyTrivial } from "./RichEditor.tsx";

export interface ComposerSeed {
  to?: string;
  cc?: string;
  subject?: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
}

// ADR-0035 (slice 8.17). Auto-save debounce. 1500ms is the gap between a
// fast typist's keystroke runs — long enough to skip mid-word writes, short
// enough that a draft survives a tab close within ~1.5s of the last edit.
const DRAFT_AUTOSAVE_DELAY_MS = 1500;

// ADR-0040 (slice 8.19). Mirror of the BFF caps in src/bff/schemas.ts. Client
// pre-validation only — the server enforces the same numbers as defense in
// depth. Sizes are decoded bytes (the recipient never sees the base64
// inflation).
const MAX_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 20;

// ADR-0040 in-memory attachment (never staged): bytes live in `contentBase64`.
// ADR-0043 staged attachment: bytes live in S3 under `s3Key`; the chip strip
// holds the metadata. On send the composer hydrates `s3Key` chips back to
// `contentBase64` via `get_staged_attachment` and re-emits as send_email
// attachments.
type ComposerAttachment =
  | {
      kind: "inline";
      id: string;
      filename: string;
      contentType: string;
      contentBase64: string;
      decodedSize: number;
    }
  | {
      kind: "staged";
      id: string;
      filename: string;
      contentType: string;
      decodedSize: number;
      sha256: string;
      s3Key: string;
    };

// Parent context for reply mode (ADR-0022). When present, the composer
// renders derived recipients/subject as read-only mono lines and routes
// Send through bff.replyToEmail — the server resolves the parent again
// and remains authoritative for threading + suppression.
export interface ComposerReplyParent {
  message_id: string;
  // Parent's mailbox (the operator's address that received the parent).
  // Used for the from line and for self-elision in the reply_all Cc preview.
  address: string;
  headers: ReadMessageHeaders;
  // Parent's plain-text body. Rendered below the operator's textarea as a
  // preview of what the server will quote.
  body_text: string;
  // Parent's ingest timestamp — fallback for the attribution line when
  // the parent has no Date: header.
  received_at: string;
  // ADR-0038 (slice 8.17). Server-stamped thread root for send-and-archive.
  // Null on legacy / unparseable parents — those threads can't be replied
  // to (parent_unrepliable already gates this), so the null path is
  // unreachable in practice; we type it null-safe to mirror ReadMessageOk.
  thread_id: string | null;
}

interface ComposerProps {
  from: string;
  seed: ComposerSeed | null;
  parent: ComposerReplyParent | null;
  // ADR-0035 (slice 8.17). When set, the composer pre-loads its fields from
  // a saved draft and treats the existing draft_id as the upsert handle for
  // subsequent auto-saves. Send-success deletes the draft. Resume implies
  // not-reply mode (parent === null) — the rail's drafts view doesn't know
  // about reply parents.
  resumeDraft?: StoredDraft | null;
  onCancel: () => void;
  onSent: () => void;
  // ADR-0038 (slice 8.17). Send-and-archive callback. Composer pre-stamps
  // the App's pendingArchives map via onArchiveStamp, fires the reply RPC,
  // and on reply-OK invokes this with the parent's thread_id so App can
  // close the composer and fire archive_thread. On reply error the
  // composer drops the stamp via onArchiveStampDrop. Optional — only the
  // "Send + archive" path uses it; bare Send still calls onSent().
  onSentAndArchive?: (threadId: string) => void;
  // ADR-0038. Pre-stamp / drop hooks for the optimistic archive-on-reply
  // flow. Called by the composer (not App) so the stamp lands the moment
  // the operator commits the send-and-archive button — same perceived
  // latency as a bare `e` press.
  onArchiveStamp?: (threadId: string, next: boolean) => void;
  onArchiveStampDrop?: (threadId: string) => void;
  // Fired after each successful save / delete so the parent can refresh
  // its drafts list and the rail count without re-polling.
  onDraftsChanged?: () => void;
}

// Inline composer — takes over the reader pane, never a modal. The 409
// suppression case renders blocked recipients under the To: field; the
// 500 case keeps the draft and surfaces a quiet line under the send button.
//
// Reply mode (parent !== null): To/Cc/Subject become derived read-only mono
// lines; Send calls reply_to_email; `a` toggles reply_all.

export function Composer({
  from,
  seed,
  parent,
  resumeDraft,
  onCancel,
  onSent,
  onSentAndArchive,
  onArchiveStamp,
  onArchiveStampDrop,
  onDraftsChanged,
}: ComposerProps): JSX.Element {
  const replyMode = parent !== null;
  // ADR-0038 (slice 8.17). The "Send + archive" affordance shows only
  // when reply mode is active, the parent has a server-stamped
  // thread_id, and the App has wired the callbacks. Legacy parents with
  // null thread_id (parse_status === "ok" but pre-ADR-0026 rows) keep
  // single-button behavior — they fall through to the bare reply path.
  const canSendAndArchive =
    replyMode &&
    parent.thread_id !== null &&
    onSentAndArchive !== undefined &&
    onArchiveStamp !== undefined;
  // Drafts only exist for fresh compose — reply mode routes through
  // reply_to_email (the parent's threading is server-authoritative; saving
  // an in-progress reply as a draft would lose that linkage). A future
  // slice can wire reply-as-draft once the schema carries the reply
  // parent's message_id.
  const draftsEnabled = !replyMode;

  const [to, setTo] = useState(resumeDraft?.to ?? seed?.to ?? "");
  const [cc, setCc] = useState(resumeDraft?.cc ?? seed?.cc ?? "");
  const [subject, setSubject] = useState(
    resumeDraft?.subject ?? seed?.subject ?? "",
  );
  const [bodyText, setBodyText] = useState(
    resumeDraft?.body_text ?? seed?.bodyText ?? "",
  );
  // ADR-0042 (slice 8.21). The TipTap editor owns the buffer once the
  // composer is mounted; bodyHtml mirrors editor.getHTML() and bodyText
  // mirrors editor.getText(). The composer suppresses body_html on send
  // when the doc is structurally trivial (no marks/lists/quotes), so
  // plain prose still ships as a single text/plain part.
  const [bodyHtml, setBodyHtml] = useState<string>("");
  const initialBodyText = resumeDraft?.body_text ?? seed?.bodyText ?? "";
  const [replyAll, setReplyAll] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "error"; message: string }
    | { kind: "blocked"; recipients: string[] }
    | { kind: "invalid"; field: string; message: string }
    | { kind: "parent_unrepliable"; reason: string; message: string }
  >({ kind: "idle" });
  // The minted draft id. null until the first save returns; subsequent
  // saves pass it back as the upsert handle. A 404 (draft deleted from
  // another tab) clears it so the next debounce mints a fresh row.
  const [draftId, setDraftId] = useState<string | null>(
    resumeDraft?.draft_id ?? null,
  );
  // Mirror of draftId for the rare case addFiles needs the freshly-minted
  // id within the same async tick (setState is queued for the next render).
  const draftIdRef = useRef<string | null>(resumeDraft?.draft_id ?? null);
  useEffect(() => {
    draftIdRef.current = draftId;
  }, [draftId]);
  // Saving spinner state. Kept tiny — the footer renders "saved · HH:MM"
  // when idle and "saving…" while in flight. Don't conflate with `status`
  // (which is for send-time errors only).
  const [draftStatus, setDraftStatus] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; at: string }
    | { kind: "error"; message: string }
  >(resumeDraft !== null && resumeDraft !== undefined
    ? { kind: "saved", at: resumeDraft.updated_at }
    : { kind: "idle" });

  // ADR-0043 (slice 8.22). When resuming a draft, hydrate the chip strip
  // from the persisted refs so the operator sees the same attachments
  // they saved. Inline-only fallback (kind: "inline") still works for
  // fresh-compose with no draft id; staging kicks in once the first
  // save mints a draft_id.
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() =>
    (resumeDraft?.attachments ?? []).map((ref) => ({
      kind: "staged" as const,
      id: ref.s3_key,
      filename: ref.filename,
      contentType: ref.content_type,
      decodedSize: ref.size,
      sha256: ref.sha256,
      s3Key: ref.s3_key,
    })),
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isStaging, setIsStaging] = useState(false);
  // ADR-0043 (slice 8.22). The autosave path must distinguish "user has not
  // touched attachments yet on this composer instance" from "user emptied
  // the chip strip". Resuming a draft hydrates `attachments` from the row
  // but should NOT cause the next autosave to overwrite that row's refs
  // with [] when, e.g., TanStack's cached list_drafts response was stale.
  // addFiles + removeAttachment flip this; saveDraftNow only includes
  // `attachments` in the upsert when true (or when an explicit override
  // is passed from the staging path).
  const attachmentsTouchedRef = useRef(false);
  // Live mirror of `attachments`. The Esc keydown listener and the autosave
  // useEffect intentionally don't list `attachments` in their dep arrays
  // (we don't want to re-register the listener on every chip change), which
  // means their closure captures a stale snapshot of `attachments`. Reading
  // through this ref inside saveDraftNow gives us the latest list at call
  // time — without it, an Esc-after-staging triggers the stale closure
  // (attachments=[], touchedRef=true) and clobbers the row's persisted refs.
  const attachmentsRef = useRef<ComposerAttachment[]>(attachments);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalAttachmentBytes = useMemo(
    () => attachments.reduce((acc, a) => acc + a.decodedSize, 0),
    [attachments],
  );
  const overCap =
    totalAttachmentBytes > MAX_ATTACHMENT_TOTAL_BYTES ||
    attachments.length > MAX_ATTACHMENT_COUNT;

  // Reply mode previews — UI-side mirror of the server derivation. Cheap to
  // recompute and keeps the operator honest about what will be sent.
  const replyPreview = useMemo(() => {
    if (parent === null) return null;
    const target = previewReplyTarget(
      parent.headers.reply_to,
      parent.headers.from,
    );
    const ccLine = replyAll
      ? previewReplyAllCc(
          parent.headers.to,
          parent.headers.cc,
          parent.address,
          target,
        )
      : "";
    return {
      to: target,
      cc: ccLine,
      subject: canonicalReSubject(parent.headers.subject),
    };
  }, [parent, replyAll]);

  const toRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // In reply mode the recipients/subject are derived; drop focus straight
    // into the body so the operator can start typing. Same for fresh compose
    // when the seed pre-fills To.
    if (replyMode || (seed?.to && seed.to.length > 0)) {
      const ta = document.querySelector<HTMLTextAreaElement>(
        ".composer__body",
      );
      ta?.focus();
    } else {
      toRef.current?.focus();
    }
  }, [seed, replyMode]);

  // Esc cancels the composer. ⌘↵ sends. In reply mode, `a` (when not in a
  // text field) flips reply_all — the textarea swallows the event so the
  // operator can still type the letter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Save-on-blur: persist whatever's in the buffer before the
        // composer goes away. The save is fire-and-forget; the parent
        // will reload the drafts list when the operator opens it next.
        if (draftsEnabled && hasContent(to, cc, subject, bodyText)) {
          void saveDraftNow();
        }
        onCancel();
      } else if (
        replyMode &&
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key === "Enter"
      ) {
        // ADR-0038 (slice 8.17). Shift+⌘↵ in reply mode sends the reply
        // and archives the parent thread in one gesture.
        e.preventDefault();
        void sendInternal({ archive: true });
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void send();
      } else if (replyMode && e.key === "a" && !isTypingTarget(e.target)) {
        e.preventDefault();
        setReplyAll((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // send is stable enough; eslint can complain in a follow-up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, subject, bodyText, seed, parent, replyAll]);

  // ADR-0043 (slice 8.22). On resume, the StoredDraft passed in may come
  // from a stale TanStack cache (drafts list has 60s staleTime) — the
  // attachments[] could be missing the most recent staging that happened
  // in another tab or just before the cache invalidated. Re-fetch the
  // row once on mount so the chip strip reflects the durable state, not
  // the stale snapshot. We only sync into state if the user hasn't
  // already touched chips on this mount, and only when we get a strict
  // superset/different ref set than what was hydrated from the prop.
  const resumedDraftId = resumeDraft?.draft_id ?? null;
  const resumedAddress = resumeDraft?.address ?? null;
  useEffect(() => {
    if (resumedDraftId === null || resumedAddress === null) return;
    let cancelled = false;
    void (async () => {
      const r = await bff.getDraft({
        address: resumedAddress,
        draft_id: resumedDraftId,
      });
      if (cancelled) return;
      if (r.kind !== "ok") return;
      if (attachmentsTouchedRef.current) return;
      const live = r.value.attachments.map<ComposerAttachment>((ref) => ({
        kind: "staged" as const,
        id: ref.s3_key,
        filename: ref.filename,
        contentType: ref.content_type,
        decodedSize: ref.size,
        sha256: ref.sha256,
        s3Key: ref.s3_key,
      }));
      setAttachments(live);
    })();
    return () => {
      cancelled = true;
    };
    // Run once per mount per resumed draft.
  }, [resumedDraftId, resumedAddress]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // ADR-0035 (slice 8.17) + ADR-0042 (slice 8.21). Debounced auto-save.
  // Fires 1500ms after the last edit when the buffer has any content.
  // The first save mints a ULID and stamps draftId; subsequent saves
  // upsert the same row. Empty buffers don't fire — a freshly-opened
  // composer with nothing typed shouldn't create a phantom draft.
  // bodyHtml is in the deps too so a formatting-only change (e.g.
  // selecting existing prose and toggling bold) still schedules a save.
  useEffect(() => {
    if (!draftsEnabled) return;
    if (!hasContent(to, cc, subject, bodyText)) return;
    const handle = window.setTimeout(() => {
      void saveDraftNow();
    }, DRAFT_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(handle);
    // saveDraftNow closes over draftId/from/to/cc/subject/bodyText/bodyHtml,
    // so we depend on the inputs themselves rather than a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, subject, bodyText, bodyHtml, draftsEnabled]);

  // Optional `attachmentsOverride` lets addFiles pass the post-staging
  // chip list explicitly — `attachments` from the closure is stale until
  // the next render, so the auto-save inside addFiles would otherwise
  // persist the pre-stage view of the world.
  const saveDraftNow = async (
    attachmentsOverride?: ComposerAttachment[],
  ): Promise<void> => {
    setDraftStatus({ kind: "saving" });
    // ADR-0035 (slice 8.17). draft_id MUST be present on the wire — null
    // for first save so the server mints a ULID, string for upserts. An
    // absent key is a 400 invalid_request.
    const input: SaveDraftInput = {
      address: from,
      draft_id: draftId,
      body_text: bodyText,
    };
    // ADR-0042 (slice 8.21). Persist HTML when the draft carries real
    // formatting; otherwise send null so a previously-formatted draft
    // that the operator stripped down to plain text doesn't quietly
    // round-trip with the old <strong> tags. Trivial docs (no marks,
    // no list, no quote) save as null too — they reload fine from the
    // body_text paragraph fallback and avoid persisting the stub
    // "<p>...</p>" wrapper that's purely a TipTap serialization
    // artifact.
    input.body_html =
      bodyHtml.length > 0 && !isStructurallyTrivial(bodyHtml) ? bodyHtml : null;
    if (to.length > 0) input.to = to;
    if (cc.length > 0) input.cc = cc;
    if (subject.length > 0) input.subject = subject;
    // ADR-0043 (slice 8.22). Persist staged-attachment refs on every save
    // once the draft has at least one (so removing the last chip clears
    // the row). Drafts with only kind:"inline" attachments — possible on
    // a fresh compose between staging attempts — leave attachments off so
    // the autosave doesn't clear out previously-staged refs the row still
    // holds.
    const sourceAttachments = attachmentsOverride ?? attachmentsRef.current;
    const stagedRefs = sourceAttachments.flatMap<DraftAttachmentRef>((a) =>
      a.kind === "staged"
        ? [
            {
              filename: a.filename,
              content_type: a.contentType,
              size: a.decodedSize,
              sha256: a.sha256,
              s3_key: a.s3Key,
            },
          ]
        : [],
    );
    const allStagedOrEmpty = sourceAttachments.every(
      (a) => a.kind === "staged",
    );
    // Include attachments in the upsert only when:
    //  (a) addFiles passed an explicit override (post-staging path), or
    //  (b) the user has touched the chip strip on this composer mount.
    // Otherwise, omit so the row's persisted refs survive autosaves
    // triggered purely by typing on a resumed draft.
    const shouldPersistAttachments =
      attachmentsOverride !== undefined || attachmentsTouchedRef.current;
    if (shouldPersistAttachments && allStagedOrEmpty) {
      input.attachments = stagedRefs;
    }
    const r = await bff.saveDraft(input);
    if (r.kind === "ok") {
      // Mirror to the ref synchronously so addFiles can read the freshly
      // minted id within the same async tick (the useEffect that syncs
      // ref ← state hasn't run yet).
      draftIdRef.current = r.value.draft_id;
      setDraftId(r.value.draft_id);
      setDraftStatus({ kind: "saved", at: r.value.updated_at });
      onDraftsChanged?.();
      return;
    }
    if (r.kind === "not_found") {
      // Stale draft_id — another tab deleted the row. Drop the id and
      // let the next debounce mint a fresh one. The local buffer is
      // preserved so the operator doesn't lose what they typed.
      draftIdRef.current = null;
      setDraftId(null);
      setDraftStatus({
        kind: "error",
        message: "draft was deleted elsewhere — saving as new",
      });
      return;
    }
    setDraftStatus({
      kind: "error",
      message: "code" in r ? `${r.code}: ${r.message}` : "save failed",
    });
  };

  // ADR-0040 (slice 8.19) + ADR-0043 (slice 8.22). Validate + add files via
  // picker or drop. Each file is read as ArrayBuffer, base64-encoded, and
  // appended to state as `kind: "inline"`. When drafts are enabled and a
  // draft_id exists, we then call stage_attachment on each accepted chip
  // and swap it for a `kind: "staged"` ref so subsequent saves persist
  // refs (not bytes). When drafts are enabled but no draft_id exists yet,
  // we save a draft first to mint one. Per-file and total caps are checked
  // client-side; the BFF re-checks.
  const addFiles = async (files: File[]): Promise<void> => {
    setAttachmentError(null);
    let runningTotal = totalAttachmentBytes;
    let runningCount = attachments.length;
    const accepted: Array<
      Extract<ComposerAttachment, { kind: "inline" }>
    > = [];
    for (const f of files) {
      if (runningCount >= MAX_ATTACHMENT_COUNT) {
        setAttachmentError(
          `attachment cap reached · max ${MAX_ATTACHMENT_COUNT} files`,
        );
        break;
      }
      if (f.size > MAX_ATTACHMENT_FILE_BYTES) {
        setAttachmentError(
          `${f.name}: ${formatBytes(f.size)} exceeds ${formatBytes(MAX_ATTACHMENT_FILE_BYTES)} per-file cap`,
        );
        continue;
      }
      if (runningTotal + f.size > MAX_ATTACHMENT_TOTAL_BYTES) {
        setAttachmentError(
          `${f.name}: would exceed ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)} total cap`,
        );
        continue;
      }
      const buf = await f.arrayBuffer();
      const base64 = encodeBase64(new Uint8Array(buf));
      accepted.push({
        kind: "inline",
        id: `att-${Date.now()}-${runningCount}`,
        filename: f.name,
        contentType: f.type,
        contentBase64: base64,
        decodedSize: f.size,
      });
      runningTotal += f.size;
      runningCount += 1;
    }
    if (accepted.length === 0) return;

    // We track the post-stage view of the chip list locally so the
    // autosave at the end can pass an explicit override — the React
    // closure's `attachments` is stale until the next render.
    let nextAttachments: ComposerAttachment[] = [...attachments, ...accepted];
    setAttachments(nextAttachments);
    attachmentsTouchedRef.current = true;

    // Replies don't stage (drafts disabled). Inline chips ride along on
    // the next send and never persist.
    if (!draftsEnabled) return;

    // First-attachment-in-fresh-compose: mint a draft id so staging has a
    // scope. saveDraftNow is debounce-safe (it always writes); if it
    // fails we leave the chips inline and the operator's next save
    // attempt will retry.
    let scopedDraftId = draftId;
    if (scopedDraftId === null) {
      // Pass the inline chips so the mint write is consistent with what
      // the operator sees — even though `allStagedOrEmpty` is false here
      // (so the BFF leaves attachments alone, which is correct for the
      // mint pass).
      await saveDraftNow(nextAttachments);
      scopedDraftId = draftIdRef.current;
      if (scopedDraftId === null) {
        // saveDraftNow surfaced its own error; leave chips inline.
        return;
      }
    }

    setIsStaging(true);
    try {
      for (const inline of accepted) {
        const stageResult = await bff.stageAttachment({
          address: from,
          draft_id: scopedDraftId,
          filename: inline.filename,
          content_type: inline.contentType,
          content_base64: inline.contentBase64,
        });
        if (stageResult.kind !== "ok") {
          setAttachmentError(
            "code" in stageResult
              ? `${inline.filename}: ${stageResult.code}: ${stageResult.message}`
              : `${inline.filename}: staging failed`,
          );
          continue;
        }
        const ref = stageResult.value;
        const stagedChip: ComposerAttachment = {
          kind: "staged",
          id: ref.s3_key,
          filename: ref.filename,
          contentType: ref.content_type,
          decodedSize: ref.size,
          sha256: ref.sha256,
          s3Key: ref.s3_key,
        };
        nextAttachments = nextAttachments.map((a) =>
          a.id === inline.id ? stagedChip : a,
        );
        setAttachments(nextAttachments);
      }
      // Persist the new refs immediately so a reload before the
      // autosave debounce still finds them.
      await saveDraftNow(nextAttachments);
    } finally {
      setIsStaging(false);
    }
  };

  const removeAttachment = (id: string): void => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    attachmentsTouchedRef.current = true;
    setAttachmentError(null);
  };

  const onPickFiles = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const list = e.target.files;
    if (list === null || list.length === 0) return;
    await addFiles(Array.from(list));
    // Reset so the same file can be re-selected after a removal.
    e.target.value = "";
  };

  const onDragOver = (e: React.DragEvent<HTMLElement>): void => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setIsDragging(true);
    }
  };
  const onDragLeave = (e: React.DragEvent<HTMLElement>): void => {
    if (e.currentTarget === e.target) setIsDragging(false);
  };
  const onDrop = async (
    e: React.DragEvent<HTMLElement>,
  ): Promise<void> => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) await addFiles(dropped);
  };

  const send = (): Promise<void> => sendInternal({ archive: false });

  // ADR-0038 (slice 8.17). Sends the reply (or new compose) and, when
  // `archive` is true and the parent thread_id is known, fires the App's
  // archive-on-reply callback after a successful send. Pre-stamps the
  // App's pendingArchives map *before* the reply RPC so the inbox row
  // vanishes the instant the operator commits — same perceived latency
  // as a bare `e` press. On send error the stamp is dropped before the
  // composer surfaces the error UI; the row snaps back into the inbox.
  const sendInternal = async ({
    archive,
  }: {
    archive: boolean;
  }): Promise<void> => {
    setStatus({ kind: "sending" });

    if (parent !== null) {
      // Send-and-archive is gated on a known thread_id + the App
      // callbacks. Both should be present when the operator clicks the
      // second button. Defensive null guard stays — a legacy parent
      // slipping through still sends as a plain reply.
      const willArchive =
        archive &&
        parent.thread_id !== null &&
        onSentAndArchive !== undefined &&
        onArchiveStamp !== undefined &&
        onArchiveStampDrop !== undefined;
      const archiveThreadId = willArchive ? parent.thread_id : null;

      const outcome = await sendAndArchive(archiveThreadId, {
        stampArchive: (tid) => onArchiveStamp?.(tid, true),
        dropArchive: (tid) => onArchiveStampDrop?.(tid),
        replyToEmail: () => {
          const replyInput: Parameters<typeof bff.replyToEmail>[0] = {
            message_id: parent.message_id,
            body_text: bodyText,
            reply_all: replyAll,
          };
          if (bodyHtml.length > 0 && !isStructurallyTrivial(bodyHtml)) {
            replyInput.body_html = bodyHtml;
          }
          return bff.replyToEmail(replyInput);
        },
      });
      const result: ReplyToEmailRpcResult = outcome.reply;
      if (result.kind === "ok") {
        if (
          outcome.shouldArchive &&
          archiveThreadId !== null &&
          onSentAndArchive !== undefined
        ) {
          // App handles closing the composer + firing archive_thread.
          onSentAndArchive(archiveThreadId);
        } else {
          onSent();
        }
        return;
      }
      if (result.kind === "suppressed") {
        setStatus({ kind: "blocked", recipients: result.blocked_recipients });
        return;
      }
      if (result.kind === "invalid_request") {
        setStatus({
          kind: "invalid",
          field: result.field,
          message: result.message,
        });
        return;
      }
      if (result.kind === "parent_unrepliable") {
        setStatus({
          kind: "parent_unrepliable",
          reason: result.reason,
          message: result.message,
        });
        return;
      }
      if (result.kind === "not_found") {
        setStatus({ kind: "error", message: `${result.code}: ${result.message}` });
        return;
      }
      setStatus({
        kind: "error",
        message: "code" in result ? `${result.code}: ${result.message}` : "reply failed",
      });
      return;
    }

    const recipients = parseAddrList(to);
    const ccList = parseAddrList(cc);
    const input: Parameters<typeof bff.sendEmail>[0] = {
      from,
      to: recipients,
      subject,
      body_text: bodyText,
    };
    // ADR-0042: only ship body_html when the doc actually carries
    // formatting. Plain prose still goes out as a single text/plain
    // part — the recipient never sees an empty alternative wrapper.
    if (bodyHtml.length > 0 && !isStructurallyTrivial(bodyHtml)) {
      input.body_html = bodyHtml;
    }
    if (ccList.length > 0) input.cc = ccList;
    if (seed?.inReplyTo && seed.inReplyTo.length > 0) {
      input.in_reply_to = seed.inReplyTo;
    }
    if (seed?.references && seed.references.length > 0) {
      input.references = seed.references.split(/\s+/).filter((s) => s.length > 0);
    }
    if (attachments.length > 0) {
      // ADR-0043 (slice 8.22). Inline chips ride along with their bytes;
      // staged chips need a round-trip to fetch the bytes back from S3
      // and re-base64. A 404 on hydrate means the staging blob expired
      // (30-day lifecycle) or was never written — we surface that as a
      // re-attach prompt and abort the send so the operator doesn't
      // ship a partial message.
      const wireAttachments: SendEmailAttachment[] = [];
      for (const a of attachments) {
        if (a.kind === "inline") {
          wireAttachments.push({
            filename: a.filename,
            content_type: a.contentType,
            content_base64: a.contentBase64,
          });
          continue;
        }
        const hydrated = await bff.getStagedAttachment({ s3_key: a.s3Key });
        if (hydrated.kind !== "ok") {
          const detail =
            hydrated.kind === "not_found"
              ? `${a.filename} is no longer available — please re-attach`
              : "code" in hydrated
                ? `${a.filename}: ${hydrated.code}: ${hydrated.message}`
                : `${a.filename}: failed to load attachment`;
          setStatus({ kind: "error", message: detail });
          return;
        }
        wireAttachments.push({
          filename: a.filename,
          content_type: a.contentType,
          content_base64: hydrated.value.content_base64,
        });
      }
      input.attachments = wireAttachments;
    }

    const result: RpcResult<SendEmailResult> = await bff.sendEmail(input);
    if (result.kind === "ok") {
      // ADR-0035 (slice 8.17). Send-success deletes the draft. Fire and
      // forget — a stale draft on send-success is a worse UI than missing
      // the rare 500 here, and the server-side delete is idempotent.
      if (draftsEnabled && draftId !== null) {
        const idToDelete = draftId;
        void bff
          .deleteDraft({ address: from, draft_id: idToDelete })
          .then(() => onDraftsChanged?.());
      }
      onSent();
      return;
    }
    if (result.kind === "suppressed") {
      setStatus({ kind: "blocked", recipients: result.blocked_recipients });
      return;
    }
    if (result.kind === "invalid_request") {
      setStatus({
        kind: "invalid",
        field: result.field,
        message: result.message,
      });
      return;
    }
    setStatus({
      kind: "error",
      message: "code" in result ? `${result.code}: ${result.message}` : "send failed",
    });
  };

  const fromAddress = parent !== null ? parent.address : from;

  const showAttachUi = !replyMode;

  return (
    <section
      className={
        "composer" + (isDragging && showAttachUi ? " composer--drag" : "")
      }
      onDragOver={showAttachUi ? onDragOver : undefined}
      onDragLeave={showAttachUi ? onDragLeave : undefined}
      onDrop={showAttachUi ? (e) => void onDrop(e) : undefined}
    >
      <header className="composer__head">
        <div className="composer__title mono faint">
          {replyMode
            ? replyAll
              ? "compose · reply-all"
              : "compose · reply"
            : draftId !== null
              ? "compose · draft"
              : "compose · new"}
        </div>
        <button className="btn btn--quiet" onClick={onCancel}>
          <span>Cancel</span>
          <span className="mono faint">esc</span>
        </button>
      </header>

      <Field label="from" mono>
        <span className="composer__from mono">{fromAddress}</span>
      </Field>

      <Field
        label="to"
        mono
        invalid={status.kind === "invalid" && status.field === "to"}
      >
        {replyMode && replyPreview !== null ? (
          <span className="composer__from mono">
            {replyPreview.to.length > 0 ? replyPreview.to : "—"}
          </span>
        ) : (
          <input
            ref={toRef}
            className="composer__input mono"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="alice@example.com"
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </Field>
      {status.kind === "blocked" ? (
        <div className="composer__blocked mono">
          <span className="composer__blocked-label">blocked · </span>
          {status.recipients.map((r, i) => (
            <span key={r}>
              <span className="composer__blocked-recipient">{r}</span>
              {i < status.recipients.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      ) : null}

      <Field label="cc" mono>
        {replyMode && replyPreview !== null ? (
          <span className="composer__from mono">
            {replyPreview.cc.length > 0 ? replyPreview.cc : "—"}
          </span>
        ) : (
          <input
            className="composer__input mono"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="(optional)"
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </Field>

      <Field
        label="subject"
        invalid={status.kind === "invalid" && status.field === "subject"}
      >
        {replyMode && replyPreview !== null ? (
          <span className="composer__from">{replyPreview.subject}</span>
        ) : (
          <input
            className="composer__input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        )}
      </Field>

      <RichEditor
        initialHtml={resumeDraft?.body_html ?? null}
        initialText={initialBodyText}
        placeholder={replyMode ? "Reply…" : "Body…"}
        onChange={({ html, text }) => {
          setBodyHtml(html);
          setBodyText(text);
        }}
      />

      {showAttachUi ? (
        <div className="composer__attach">
          <div className="composer__attach-row">
            <button
              className="btn btn--quiet"
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <span>Attach</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => void onPickFiles(e)}
            />
            <span
              className={
                "composer__attach-meter mono faint" +
                (overCap ? " composer__attach-meter--over" : "") +
                (totalAttachmentBytes / MAX_ATTACHMENT_TOTAL_BYTES > 0.8 &&
                !overCap
                  ? " composer__attach-meter--warn"
                  : "")
              }
            >
              {formatBytes(totalAttachmentBytes)} / {formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}
              {" · "}
              {attachments.length} / {MAX_ATTACHMENT_COUNT} files
            </span>
            {isStaging ? (
              <span className="composer__attach-note mono faint">
                · staging…
              </span>
            ) : null}
          </div>
          {attachments.length > 0 ? (
            <ul className="composer__chips">
              {attachments.map((a) => (
                <li key={a.id} className="composer__chip mono">
                  <span className="composer__chip-name">{a.filename}</span>
                  <span className="composer__chip-size faint">
                    {" · "}
                    {formatBytes(a.decodedSize)}
                  </span>
                  <button
                    className="composer__chip-x"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.filename}`}
                    type="button"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {attachmentError !== null ? (
            <div className="composer__attach-error mono">{attachmentError}</div>
          ) : null}
        </div>
      ) : null}

      {parent !== null ? (
        <pre className="composer__quote mono faint">
          {previewQuotedBody({
            parentDate: parent.headers.date,
            parentFrom: parent.headers.from,
            parentReceivedAt: parent.received_at,
            parentBodyText: parent.body_text,
          })}
        </pre>
      ) : null}

      <footer className="composer__foot">
        <div className="composer__footmeta mono faint">
          {status.kind === "error" ? (
            <span>{status.message}</span>
          ) : status.kind === "invalid" ? (
            <span>
              invalid · {status.field}: {status.message}
            </span>
          ) : status.kind === "parent_unrepliable" ? (
            <span>
              cannot reply · {status.reason}: {status.message}
            </span>
          ) : status.kind === "sending" ? (
            <span>sending…</span>
          ) : draftsEnabled && draftStatus.kind === "saving" ? (
            <span>saving draft…</span>
          ) : draftsEnabled && draftStatus.kind === "saved" ? (
            <span>saved · {formatSavedAt(draftStatus.at)}</span>
          ) : draftsEnabled && draftStatus.kind === "error" ? (
            <span>{draftStatus.message}</span>
          ) : replyMode && canSendAndArchive ? (
            <span>
              ⌘↵ to send · ⇧⌘↵ send + archive · a toggles reply-all · esc to cancel
            </span>
          ) : replyMode ? (
            <span>⌘↵ to send · a toggles reply-all · esc to cancel</span>
          ) : (
            <span>⌘↵ to send · esc to cancel</span>
          )}
        </div>
        <div className="composer__send-row">
          <button
            className="btn btn--primary"
            onClick={() => void send()}
            disabled={status.kind === "sending" || overCap || isStaging}
          >
            <span>
              {status.kind === "sending"
                ? "Sending…"
                : replyMode
                  ? replyAll
                    ? "Send reply-all"
                    : "Send reply"
                  : "Send"}
            </span>
            <span className="mono faint">⌘↵</span>
          </button>
          {replyMode && canSendAndArchive ? (
            <button
              className="btn btn--primary composer__send-archive"
              onClick={() => void sendInternal({ archive: true })}
              disabled={status.kind === "sending"}
              title="Send reply and archive the thread"
            >
              <span aria-hidden className="composer__send-archive-icon">
                ▾
              </span>
              <span>Send + archive</span>
              <span className="mono faint">⇧⌘↵</span>
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

function Field({
  label,
  mono,
  invalid,
  children,
}: {
  label: string;
  mono?: boolean;
  invalid?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={"composer__field" + (invalid ? " composer__field--invalid" : "")}>
      <div className={"composer__label mono" + (mono ? "" : "")}>{label}</div>
      <div className="composer__field-value">{children}</div>
    </div>
  );
}

function parseAddrList(s: string): string[] {
  return s
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

// True when at least one of the four user-editable fields has any
// non-whitespace content. Used to skip auto-saving an empty composer
// (which would create phantom drafts on every Compose-then-Esc).
function hasContent(
  to: string,
  cc: string,
  subject: string,
  bodyText: string,
): boolean {
  return (
    to.trim().length > 0 ||
    cc.trim().length > 0 ||
    subject.trim().length > 0 ||
    bodyText.trim().length > 0
  );
}

// HH:MM in local time — matches the rail's polled-at footer so the
// "saved" line reads in the same register.
function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

// ADR-0040 (slice 8.19). Human-readable byte count for the size readout
// and chip strip. KB / MB only — files smaller than 1KB show as `< 1 KB`
// to avoid the "0 KB" footgun on near-empty files.
function formatBytes(n: number): string {
  if (n === 0) return "0 KB";
  if (n < 1024) return "< 1 KB";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Browser base64 encoder for Uint8Array. btoa() takes a binary string so we
// build one chunk-by-chunk to avoid the call-stack limit on String.fromCharCode
// when spreading large arrays.
function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(bin);
}
