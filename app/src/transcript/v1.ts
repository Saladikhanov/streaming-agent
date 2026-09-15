import type { DecodedFrame } from "./frames";

import { payloadsOf } from "./frames";
import { ROOT_SCOPE } from "./model";
import { asRecord, asString } from "./narrow";
import { tr } from "../i18n";

/**
 * Extension 1 — the legacy seam.
 *
 * Everything protocol v1 does differently is translated here into the v2 shapes
 * the reducer already understands. Nothing downstream — reducer, placement,
 * components, tests — learns that v1 exists, so legacy threads render through
 * exactly the same path as modern ones and there is one transcript
 * implementation to reason about rather than two.
 *
 * This is the brief's *"keep protocol differences outside rendering"*, and it
 * sits beside `frames.ts` as a second translation layer: that one converts
 * wire *format*, this one converts protocol *version*.
 *
 * The adapter is stateful because v1 loses information that cannot be
 * recovered frame-by-frame — see `translateBot` and `translateTool`.
 */
export type V1Adapter = (frame: DecodedFrame) => DecodedFrame[];

/** v1 identifies messages by a per-thread sequence number, not an id. */
function idOf(seq: unknown): string {
  return `v1:${String(seq)}`;
}

export function createV1Adapter(): V1Adapter {
  /** seq → bot text so far, so a `done` frame without a body can be completed. */
  const botText = new Map<string, string>();

  return function translate(frame: DecodedFrame): DecodedFrame[] {
    switch (frame.channel) {
      case "protocol":
        // Passed through: the reducer tracks the version, and a migrated thread
        // re-announces v2 mid-stream to hand control back to the native path.
        return [frame];

      case "message":
        return payloadsOf(frame).flatMap((payload) => translateMessage(payload, botText));

      case "done":
        // v1's terminal frame is v2's `complete`.
        return [rewritten("complete", {})];

      case "fail":
        return [rewritten("error", { title: asString(asRecord(frame.data)?.message) ?? "The turn failed" })];

      default:
        // Keep-alives and anything unrecognised: nothing to translate.
        return [];
    }
  };
}

function translateMessage(payload: unknown, botText: Map<string, string>): DecodedFrame[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  const id = idOf(record.seq);

  switch (record.kind) {
    case "user":
      return [rewritten("final", { content: asString(record.body) ?? "", id, timestamp: asString(record.at), type: "user" })];
    case "bot":
      return translateBot(record, id, botText);
    case "tool":
      return translateTool(record, id);
    default:
      return [];
  }
}

/**
 * Bot text arrives as append-only deltas, then a `done` frame that *may* carry
 * the full body.
 *
 * When it does not, a v2 `final` built from it would be authoritative and empty
 * — purging every delta it was meant to settle. So the running text is kept
 * here and supplied when the wire does not.
 */
function translateBot(record: Record<string, unknown>, id: string, botText: Map<string, string>): DecodedFrame[] {
  if (record.done === true) {
    const content = asString(record.body) ?? botText.get(id) ?? "";
    botText.delete(id);
    return [rewritten("final", { content, id, type: "assistant" })];
  }

  const append = asString(record.append) ?? "";
  botText.set(id, (botText.get(id) ?? "") + append);
  return [rewritten("streaming", { content: append, id, type: "assistant" })];
}

/**
 * A v1 tool call is a running frame followed by an `ok`/`error` frame.
 *
 * v1 predates sub-agents, so every call is a plain tool — no `kind: "agent"`,
 * no scope, and deliberately no sub-agent chrome for a feature the protocol
 * does not have.
 *
 * Attachments arrive inline with no separate reference saying where to draw
 * them, so the positioning frame v2 would have sent is synthesised. Without it
 * a legacy chart or table would be registered but never rendered.
 */
function translateTool(record: Record<string, unknown>, id: string): DecodedFrame[] {
  const status = asString(record.status);
  const attachments = Array.isArray(record.attachments) ? record.attachments : [];

  const frames = [
    rewritten("final", {
      icon: "tool",
      id,
      kind: "tool",
      title: asString(record.name) ?? tr('fallback.untitledTool'),
      type: "action",
      // `running` leaves this null, which is what lets a killed legacy stream's
      // last tool call read as interrupted rather than failed.
      ...(status === "ok" || status === "error" ? { has_succeeded: status === "ok" } : { has_succeeded: null }),
      ...(attachments.length > 0 ? { artifacts: attachments } : {}),
    }),
  ];

  for (const attachment of attachments) {
    const artifactId = asRecord(attachment)?.id;
    if (typeof artifactId === "string") {
      frames.push(rewritten("final", { artifact_id: artifactId, type: "artifact" }));
    }
  }
  return frames;
}

/** v1 has no scopes, so everything lands on the main transcript. */
function rewritten(channel: string, data: unknown): DecodedFrame {
  return { channel, data, scope: ROOT_SCOPE };
}
