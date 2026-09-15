import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { StreamFrame } from "../api/types";
import type { TranscriptState } from "./model";

import { decodeFrame } from "./frames";
import { emptyTranscript, nodeKey } from "./model";
import { reduce } from "./reducer";

/**
 * Shared scaffolding for the transcript tests.
 *
 * The builders below exist so a test reads as its intent — `assistant("a1",
 * "Done.")` rather than the wire shape spelled out — while the wire shape
 * itself stays covered by `frames.test.ts`.
 *
 * They deliberately supply **no defaults**. Each sets `type` and whatever the
 * caller passes, nothing more. Several rules in the brief turn on a field being
 * genuinely *absent* — `has_succeeded` absent means "still running", and a
 * later frame omitting `title` must not blank it — so a builder that helpfully
 * filled those in would make those tests pass while proving nothing.
 */

export const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

// ---- frames ----

/** The raw escape hatch, for tests that care about the wire shape itself. */
export function sse(event: string, data: unknown): StreamFrame {
  return { data: typeof data === "string" ? data : JSON.stringify(data), event };
}

export function protocol(version: number): StreamFrame {
  return sse("protocol", { version });
}

export function user(id: string, content: string, extra?: Record<string, unknown>): StreamFrame {
  return sse("final", { content, id, type: "user", ...extra });
}

export function assistant(id: string, content: string): StreamFrame {
  return sse("final", { content, id, type: "assistant" });
}

export function assistantChunk(id: string, content: string): StreamFrame {
  return sse("streaming", { content, id, type: "assistant" });
}

export function thinking(id: string, content: string): StreamFrame {
  return sse("final", { content, id, type: "thinking" });
}

export function thinkingChunk(id: string, content: string): StreamFrame {
  return sse("streaming", { content, id, type: "thinking" });
}

/** `fields` is passed through verbatim — absence is meaningful, so nothing is added. */
export function action(id: string, fields?: Record<string, unknown>): StreamFrame {
  return sse("final", { id, type: "action", ...fields });
}

export function artifactRef(artifactId: string): StreamFrame {
  return sse("final", { artifact_id: artifactId, type: "artifact" });
}

export function ask(id: string, questions: unknown[]): StreamFrame {
  return sse("final", { command: "ask-user-question", id, questions, type: "command" });
}

export function bookmark(): StreamFrame {
  return sse("final", { type: "bookmark" });
}

export function errorFrame(fields: Record<string, unknown>): StreamFrame {
  return sse("error", fields);
}

export function complete(): StreamFrame {
  return sse("complete", {});
}

/** A keep-alive, as the transport delivers one: every field empty. */
export function keepAlive(): StreamFrame {
  return { data: "", event: "" };
}

/** Retags a frame into a nested-agent scope: `final` becomes `final|aud`. */
export function scoped(scopeId: string, frame: StreamFrame): StreamFrame {
  return { ...frame, event: `${frame.event}|${scopeId}` };
}

// ---- running ----

/** Folds frames through the same path the transport uses. */
export function play(frames: StreamFrame[], from: TranscriptState = emptyTranscript): TranscriptState {
  return frames.reduce((state, frame) => reduce(state, decodeFrame(frame)), from);
}

/** Every `event:`/`data:` pair in a recorded stream, in order. */
export function framesOf(name: string): StreamFrame[] {
  const frames: StreamFrame[] = [];
  let event = "";
  for (const line of readFileSync(FIXTURES + name, "utf8").split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      frames.push({ data: line.slice(6), event });
    }
  }
  return frames;
}

// ---- inspecting ----

export function at(state: TranscriptState, scope: string, id: string) {
  return state.nodes[nodeKey(scope, id)];
}

/** Root-level node kinds in render order — the visible shape of the transcript. */
export function shape(state: TranscriptState): string[] {
  return state.order.map((key) => state.nodes[key].kind);
}

// ---- the brief's worked example ----

/**
 * The event trace printed in `docs/BRIEF.md`, in its exact order — including
 * the deliberately out-of-order `aud` frames, which arrive before the agent
 * action that opens that scope.
 *
 * Defined once so it cannot drift from the document it comes from.
 */
export const BRIEF_TRACE: StreamFrame[] = [
  user("u1", "Analyze performance metrics..."),
  thinking("t1", "Considering spend"),
  action("act-spend", { kind: "tool", title: "Query campaign spend" }),
  action("act-bench", { kind: "tool", title: "Fetch benchmarks" }),
  scoped("aud", thinking("s-t1", "Sub-agent reasoning")),
  scoped("aud", action("s-act", { kind: "tool", title: "Compute overlap" })),
  action("act-agent", { kind: "agent", scope_id: "aud", title: "Audience Expert" }),
  artifactRef("art-trend"),
  assistantChunk("a1", "Consolidated "),
  assistantChunk("a1", "ROAS "),
  assistant("a1", "Consolidated ROAS of 3.1."),
  complete(),
];
