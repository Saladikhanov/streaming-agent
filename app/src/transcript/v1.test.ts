import { describe, expect, it } from "vitest";

import type { ActionNode, TextNode, TranscriptState } from "./model";
import type { StreamFrame } from "../api/types";

import { decodeFrame } from "./frames";
import { emptyTranscript, nodeKey, ROOT_SCOPE } from "./model";
import { asRecord } from "./narrow";
import { finishStream, reduce } from "./reducer";
import { at, shape, sse } from "./test-support";
import { createV1Adapter, type V1Adapter } from "./v1";

/**
 * Extension 1 — dual protocol support.
 *
 * Clauses quoted from `PROTOCOL_V1.md` and the extension description in
 * `docs/BRIEF.md`. The recorded fixtures are stored in v2 form and translated
 * to v1 by the service at playback time, so these drive the adapter with the v1
 * wire shapes directly — captured from a real `/resume` against a v1 thread.
 */

/**
 * Runs frames the way the hook does: the adapter is attached and dropped by
 * whatever the latest `protocol` frame announces, so a thread can migrate
 * mid-stream.
 */
function playV1(frames: StreamFrame[]): TranscriptState {
  let legacy: V1Adapter | null = null;
  let state = emptyTranscript;

  for (const raw of frames) {
    const frame = decodeFrame(raw);
    let translated = [frame];

    if (frame.channel === "protocol") {
      const version = asRecord(frame.data)?.version;
      legacy = version === 1 ? createV1Adapter() : null;
    } else if (legacy) {
      translated = legacy(frame);
    }

    for (const decoded of translated) {
      state = reduce(state, decoded);
    }
  }
  return state;
}

const v1 = (data: unknown) => sse("message", data);

describe("Dual protocol support", () => {
  // "A stream announces its version in its first frame."
  it("renders a legacy thread through the same reducer", () => {
    const state = playV1([
      sse("protocol", { version: 1 }),
      v1({ at: "2026-03-11T10:05:00Z", body: "How do I connect HubSpot?", kind: "user", seq: 1 }),
      v1({ body: "Head to Settings > Connections.", done: true, kind: "bot", seq: 2 }),
      sse("done", {}),
    ]);

    expect(state.protocol).toBe(1);
    expect(shape(state)).toEqual(["user", "assistant"]);
    expect((at(state, ROOT_SCOPE, "v1:2") as TextNode).content).toBe("Head to Settings > Connections.");
    expect(state.status).toBe("complete");
  });

  /**
   * "Bot text (end): {"kind":"bot","seq":n,"done":true} — optionally carries
   * body with the full text."
   *
   * The lossy case. A v2 `final` is authoritative, so translating a bodyless
   * `done` literally would settle the message to an empty string and purge
   * every delta it was meant to seal.
   */
  it("keeps accumulated text when `done` arrives without a body", () => {
    const state = playV1([
      sse("protocol", { version: 1 }),
      v1({ append: "Hello ", kind: "bot", seq: 1 }),
      v1({ append: "world.", kind: "bot", seq: 1 }),
      v1({ done: true, kind: "bot", seq: 1 }),
    ]);

    const node = at(state, ROOT_SCOPE, "v1:1") as TextNode;
    expect(node.content).toBe("Hello world.");
    expect(node.isStreaming).toBe(false);
  });

  it("prefers the wire's own body when `done` carries one", () => {
    const state = playV1([
      sse("protocol", { version: 1 }),
      v1({ append: "draft", kind: "bot", seq: 1 }),
      v1({ body: "The tidied final wording.", done: true, kind: "bot", seq: 1 }),
    ]);

    expect((at(state, ROOT_SCOPE, "v1:1") as TextNode).content).toBe("The tidied final wording.");
  });

  // "Tool call: … then a second frame with "status": "ok" | "error"."
  it("settles a tool call across its two frames", () => {
    const state = playV1([
      sse("protocol", { version: 1 }),
      v1({ kind: "tool", name: "Check connection status", seq: 3, status: "running" }),
      v1({ kind: "tool", name: "Check connection status", seq: 3, status: "ok" }),
    ]);

    const action = at(state, ROOT_SCOPE, "v1:3") as ActionNode;
    expect(action.title).toBe("Check connection status");
    expect(action.hasSucceeded).toBe(true);
    expect(shape(state)).toEqual(["group"]);
  });

  it("marks a failed tool call as failed, not interrupted", () => {
    const state = playV1([
      sse("protocol", { version: 1 }),
      v1({ kind: "tool", name: "Sync contacts", seq: 1, status: "error" }),
    ]);

    expect((at(state, ROOT_SCOPE, "v1:1") as ActionNode).hasSucceeded).toBe(false);
  });

  /**
   * "attachments carries artifacts inline — there is no delivery/reference
   * split." So the positioning reference v2 would have sent is synthesised;
   * without it the artifact is registered but drawn nowhere, which is the
   * "empty UI" the extension explicitly warns against.
   */
  it("positions inline attachments that v1 never places", () => {
    const state = playV1([
      sse("protocol", { version: 1 }),
      v1({
        attachments: [{ columns: { roas: [3.1] }, id: "art-roas", type: "table" }],
        kind: "tool",
        name: "Pull ROAS",
        seq: 3,
        status: "ok",
      }),
    ]);

    expect(state.artifacts["art-roas"]).toMatchObject({ type: "table" });
    expect(shape(state)).toEqual(["group", "artifactRef"]);
  });

  // "An action still running when the stream terminates is interrupted, not failed."
  it("leaves a running legacy tool interruptible", () => {
    const live = playV1([
      sse("protocol", { version: 1 }),
      v1({ kind: "tool", name: "Slow query", seq: 1, status: "running" }),
    ]);
    expect((at(live, ROOT_SCOPE, "v1:1") as ActionNode).hasSucceeded).toBeNull();

    const ended = finishStream(live, "interrupted");
    expect((ended.nodes[nodeKey(ROOT_SCOPE, "v1:1")] as ActionNode).isInterrupted).toBe(true);
  });

  // "event: fail with data: {"message": "…"} — the turn failed."
  it("maps a v1 failure onto the error channel as content", () => {
    const state = playV1([sse("protocol", { version: 1 }), sse("fail", { message: "Connector timed out" })]);

    expect(shape(state)).toEqual(["error"]);
    // Consistent with v2: an error is content, not a terminal transport failure.
    expect(state.status).not.toBe("failed");
  });

  // "A v1 replay has no bookmark: history and live tail are not delimited."
  it("renders no bookmark for a legacy replay", () => {
    const state = playV1([
      sse("protocol", { version: 1 }),
      v1({ body: "hello", done: true, kind: "bot", seq: 1 }),
      sse("done", {}),
    ]);

    expect(state.hasBookmark).toBe(false);
    expect(shape(state)).not.toContain("bookmark");
  });

  /**
   * "A thread that has migrated returns v2 — even though /resume replays its
   * older history in v1." The service re-announces the version at the boundary,
   * so the adapter must be dropped mid-stream rather than chosen once.
   */
  it("switches to native v2 when the version changes mid-stream", () => {
    const state = playV1([
      sse("protocol", { version: 1 }),
      v1({ body: "legacy history", done: true, kind: "bot", seq: 1 }),
      sse("protocol", { version: 2 }),
      sse("final", { content: "modern turn", id: "a1", type: "assistant" }),
      sse("final", { id: "act", kind: "agent", scope_id: "s1", title: "Sub-agent", type: "action" }),
      sse("final|s1", { content: "nested", id: "s-t1", type: "thinking" }),
      sse("complete", {}),
    ]);

    expect(state.protocol).toBe(2);
    // Legacy history and the modern turn coexist in one presentation model.
    expect((at(state, ROOT_SCOPE, "v1:1") as TextNode).content).toBe("legacy history");
    expect((at(state, ROOT_SCOPE, "a1") as TextNode).content).toBe("modern turn");
    // v2 features work again immediately: the scoped frame nests as normal.
    expect(state.children[nodeKey(ROOT_SCOPE, "act")]).toEqual([nodeKey("s1", "s-t1")]);
    expect(state.status).toBe("complete");
  });

  it("ignores v1 payload kinds it does not recognise", () => {
    const state = playV1([
      sse("protocol", { version: 1 }),
      v1({ kind: "telemetry", seq: 9 }),
      v1({ body: "still here", done: true, kind: "bot", seq: 1 }),
    ]);

    expect(shape(state)).toEqual(["assistant"]);
  });
});
