import type { ActionResult, Artifact, CommandQuestion, ProblemDetails } from "../api/types";
import type { DecodedFrame } from "./frames";
import type { ActionNode, ActionResultLine, NodeKey, StreamStatus, TranscriptState } from "./model";
import type { Draft } from "./placement";

import { payloadsOf } from "./frames";
import { nodeKey } from "./model";
import { asRecord, asString, wireTypeOf } from "./narrow";
import { anchorScope, appendAction, appendNode, beginDraft, commitDraft } from "./placement";
import { tr } from "../i18n";

/**
 * Folds one decoded frame into the transcript.
 *
 * Pure, and free of React: the whole reducer can be exercised by replaying a
 * recorded fixture off disk, which is where its tests live. Where each node
 * *goes* is `placement.ts`; this file decides what each frame *means*.
 */
export function reduce(state: TranscriptState, frame: DecodedFrame): TranscriptState {
  switch (frame.channel) {
    case "protocol":
      return applyProtocol(state, frame);
    case "streaming":
    case "final":
      return applyMessages(state, frame);
    case "error":
      return applyError(state, frame);
    case "complete":
      return state.status === "complete" ? state : { ...state, status: "complete" };
    default:
      // Keep-alives decode to an empty channel and land here, as does any
      // channel the service invents later. Both are ignored, not errors.
      return state;
  }
}

/**
 * Closes out a stream.
 *
 * Anything still running when the connection ends is *interrupted*, not failed:
 * nothing said it went wrong, we simply stopped listening. In `interrupted-run`
 * the tool actually succeeded — the client never heard. Showing a failure there
 * would be a lie.
 */
export function finishStream(state: TranscriptState, reason: StreamStatus): TranscriptState {
  const draft = beginDraft(state);
  let touched = false;

  for (const key of Object.keys(draft.nodes) as NodeKey[]) {
    const node = draft.nodes[key];

    if (node.kind === "action" && node.hasSucceeded == null && !node.isInterrupted && reason !== "complete") {
      draft.nodes[key] = { ...node, isInterrupted: true };
      touched = true;
    }
    // Text that never received its authoritative `final` stops pulsing.
    if ((node.kind === "assistant" || node.kind === "thinking") && node.isStreaming) {
      draft.nodes[key] = { ...node, isStreaming: false };
      touched = true;
    }
  }

  if (!touched && state.status === reason) {
    return state;
  }
  return { ...commitDraft(state, draft), status: reason };
}

/** How a stream stopped producing frames. */
export type StreamEnding = {
  /** The user pressed Stop. */
  aborted: boolean;
  /** The response stream raised, rather than simply running out. */
  threw: boolean;
};

/**
 * Which terminal state a stream ended in.
 *
 * Pure, and deliberately separate from the hook that calls it. Deciding this
 * *looks* like React plumbing but is a judgement about the data: it is the
 * difference between telling someone their tool call failed and telling them it
 * was cut short. Two of the defects found in this project lived in these
 * branches while they were tangled up in an effect.
 *
 * Note that throwing is not the signal. A dropped connection ends the iterator
 * quietly in Node and raises from the response stream in a browser, so the same
 * event arrives two different ways. What actually separates the cases is
 * whether the stream ever delivered anything.
 */
export function streamOutcome(state: TranscriptState, ending: StreamEnding): StreamStatus {
  if (ending.aborted) {
    // A decision by the user, not a failure.
    return "stopped";
  }
  if (state.status === "complete") {
    return "complete";
  }
  if (state.order.length > 0) {
    // Content arrived and then stopped: cut short, never "failed". The work may
    // well have succeeded unheard.
    return "interrupted";
  }
  // Nothing ever arrived. Raising means the turn could not start; ending
  // quietly means there was simply nothing in the thread.
  return ending.threw ? "failed" : "complete";
}

// ---- channels ----

function applyProtocol(state: TranscriptState, frame: DecodedFrame): TranscriptState {
  const version = asRecord(frame.data)?.version;
  if (version !== 1 && version !== 2) {
    return state;
  }
  // A migrated thread re-announces mid-stream: history replayed as v1, the live
  // tail as v2. Everything already reduced stays exactly as it rendered.
  return version === state.protocol ? state : { ...state, protocol: version };
}

/**
 * An error frame is transcript content, not the end of the turn.
 *
 * The brief is explicit that processing may continue after one, and
 * `error-recovery.sse` sends three more frames after its first error. So this
 * appends a node and leaves the status alone — `failed` is reserved for the
 * transport itself giving out.
 */
function applyError(state: TranscriptState, frame: DecodedFrame): TranscriptState {
  const record = asRecord(frame.data) ?? {};
  const problem: ProblemDetails = {
    detail: asString(record.detail),
    status: typeof record.status === "number" ? record.status : undefined,
    title: asString(record.title) ?? asString(record.message) ?? tr('fallback.untitledError'),
  };

  const draft = beginDraft(state);
  const seen = Object.values(draft.nodes).filter((node) => node.kind === "error").length;
  appendNode(draft, frame.scope, { key: nodeKey(frame.scope, `error:${seen}`), kind: "error", problem });

  return commitDraft(state, draft);
}

function applyMessages(state: TranscriptState, frame: DecodedFrame): TranscriptState {
  const payloads = payloadsOf(frame);
  if (payloads.length === 0) {
    return state;
  }

  const draft = beginDraft(state);
  const isFinal = frame.channel === "final";
  let applied = false;

  for (const payload of payloads) {
    const record = asRecord(payload);
    if (!record) {
      continue;
    }
    // One unrenderable payload must not take the transcript with it: the frames
    // already applied stay applied, and the bad one is skipped.
    try {
      applied = applyOne(draft, frame.scope, record, isFinal) || applied;
    } catch {
      continue;
    }
  }

  if (!applied) {
    return state;
  }
  const next = commitDraft(state, draft);
  return next.status === "streaming" ? next : { ...next, status: "streaming" };
}

function applyOne(draft: Draft, frameScope: string, record: Record<string, unknown>, isFinal: boolean): boolean {
  // On REST reads the scope travels in the body rather than the event field.
  const scope = asString(record.in_scope) ?? frameScope;
  const type = wireTypeOf(record);

  switch (type) {
    case "user":
      return applyUser(draft, scope, record);
    case "assistant":
    case "thinking":
      return applyText(draft, scope, record, type, isFinal);
    case "action":
      return applyAction(draft, scope, record);
    case "artifact":
      return applyArtifactRef(draft, scope, record);
    case "command":
      return applyCommand(draft, scope, record);
    case "bookmark":
      return applyBookmark(draft, scope);
    default:
      // `metadata`, and anything the service invents later, render as nothing
      // rather than breaking the stream.
      return false;
  }
}

// ---- message types ----

function applyUser(draft: Draft, scope: string, record: Record<string, unknown>): boolean {
  const id = asString(record.id);
  if (!id) {
    return false;
  }
  const key = nodeKey(scope, id);
  const node = {
    attachments: Array.isArray(record.file_attachments) ? record.file_attachments : [],
    content: asString(record.content) ?? "",
    id,
    key,
    kind: "user",
    timestamp: asString(record.timestamp),
  } as const;

  if (draft.nodes[key]) {
    draft.nodes[key] = node;
  } else {
    appendNode(draft, scope, node);
  }
  return true;
}

function applyText(
  draft: Draft,
  scope: string,
  record: Record<string, unknown>,
  kind: "assistant" | "thinking",
  isFinal: boolean,
): boolean {
  const id = asString(record.id);
  if (!id) {
    return false;
  }
  const key = nodeKey(scope, id);
  const existing = draft.nodes[key];
  const incoming = asString(record.content) ?? "";

  if (existing && (existing.kind === "assistant" || existing.kind === "thinking")) {
    draft.nodes[key] = {
      ...existing,
      // A `final` is authoritative: it replaces every delta accumulated for
      // this id rather than appending one more piece to them. The recorded
      // streams include finals whose text differs from what was streamed.
      content: isFinal ? incoming : existing.content + incoming,
      isStreaming: !isFinal,
    };
    return true;
  }

  appendNode(draft, scope, { content: incoming, id, isStreaming: !isFinal, key, kind });
  return true;
}

function applyAction(draft: Draft, scope: string, record: Record<string, unknown>): boolean {
  const id = asString(record.id);
  if (!id) {
    return false;
  }
  const key = nodeKey(scope, id);
  const existing = draft.nodes[key];

  registerArtifacts(draft, record.artifacts);
  const incoming = actionFields(record);

  if (existing && existing.kind === "action") {
    draft.nodes[key] = { ...existing, ...incoming };
  } else {
    appendAction(draft, scope, {
      actionKind: "tool",
      hasSucceeded: null,
      id,
      isInterrupted: false,
      key,
      kind: "action",
      results: [],
      title: "",
      ...incoming,
    });
  }

  // An agent action owns a scope. Claim it here, whether this frame created the
  // action or updated one that already existed.
  const scopeId = (draft.nodes[key] as ActionNode).scopeId;
  if (scopeId) {
    anchorScope(draft, scopeId, key);
  }
  return true;
}

/**
 * The fields an action frame actually carries.
 *
 * Only keys present on this frame are returned. A settled action re-fires with
 * new structure — a running title becoming a finished one, results arriving
 * late — and a field the new frame omits must keep its previous value rather
 * than being blanked.
 */
function actionFields(record: Record<string, unknown>): Partial<ActionNode> {
  const fields: Partial<ActionNode> = {};

  if (record.title !== undefined) {
    fields.title = asString(record.title) ?? "";
  }
  if (record.icon !== undefined) {
    fields.icon = asString(record.icon);
  }
  if (record.input !== undefined) {
    fields.input = record.input;
  }
  if (record.kind !== undefined) {
    fields.actionKind = asString(record.kind) ?? "tool";
  }
  if (record.results !== undefined) {
    fields.results = resultLines(record.results);
  }
  if (record.has_succeeded !== undefined) {
    // Absent and null both mean "still running"; only true/false settle it.
    fields.hasSucceeded = (record.has_succeeded as boolean | null) ?? null;
  }
  if (record.scope_id !== undefined) {
    fields.scopeId = asString(record.scope_id);
  }
  return fields;
}

/**
 * Artifacts are delivered on the action that produced them and referenced
 * separately. Registering them by id is what lets a later delivery replace an
 * earlier one everywhere it is referenced, without moving where it sits.
 */
function registerArtifacts(draft: Draft, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const artifact of value as Artifact[]) {
    if (artifact?.id) {
      draft.artifacts[artifact.id] = artifact;
    }
  }
}

function resultLines(value: unknown): ActionResultLine[] {
  if (!Array.isArray(value)) {
    return [];
  }
  // `type` is unreliable — an `artifact_id` is a pointer whatever it claims.
  return (value as ActionResult[]).map((result) => ({
    artifactId: result?.artifact_id,
    icon: result?.icon,
    title: result?.title,
  }));
}

/** A positioned reference to an artifact some action delivered. */
function applyArtifactRef(draft: Draft, scope: string, record: Record<string, unknown>): boolean {
  const artifactId = asString(record.artifact_id);
  if (!artifactId) {
    return false;
  }
  const key = nodeKey(scope, `artifact:${artifactId}`);
  if (draft.nodes[key]) {
    // Already positioned. A re-delivery updates the payload, which the registry
    // has handled — the slot on the page does not move.
    return true;
  }
  appendNode(draft, scope, { artifactId, key, kind: "artifactRef" });
  return true;
}

function applyCommand(draft: Draft, scope: string, record: Record<string, unknown>): boolean {
  if (record.command !== "ask-user-question") {
    return false;
  }
  const id = asString(record.id);
  const questions = Array.isArray(record.questions) ? (record.questions as CommandQuestion[]) : [];
  if (!id || questions.length === 0) {
    return false;
  }
  const key = nodeKey(scope, id);
  if (draft.nodes[key]) {
    return true;
  }
  // Whether it has been answered is not stored: it is derived from whether a
  // user message follows it, so the answer survives reopening the thread.
  appendNode(draft, scope, { id, key, kind: "question", questions });
  return true;
}

function applyBookmark(draft: Draft, scope: string): boolean {
  const key = nodeKey(scope, "bookmark");
  if (draft.nodes[key]) {
    return true;
  }
  appendNode(draft, scope, { key, kind: "bookmark" });
  draft.hasBookmark = true;
  return true;
}
