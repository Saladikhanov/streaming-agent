import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ActionGroupNode, ActionNode, TextNode } from "./model";

import { emptyTranscript, nodeKey, ROOT_SCOPE } from "./model";
import { finishStream, streamOutcome } from "./reducer";
import {
  action,
  artifactRef,
  ask,
  assistant,
  assistantChunk,
  at,
  bookmark,
  BRIEF_TRACE,
  complete,
  errorFrame,
  FIXTURES,
  framesOf,
  keepAlive,
  play,
  protocol,
  scoped,
  shape,
  sse,
  thinking,
  thinkingChunk,
  user,
} from "./test-support";

/**
 * Organised by section of `docs/BRIEF.md`, with each test quoting the clause it
 * enforces. The point is traceability: a reviewer can read these names against
 * the brief to see what is covered, and when the contract changes the affected
 * tests are findable by the quoted text.
 *
 * Everything runs through `reduce()`, the real entry point, rather than the
 * modules beneath it — so the suite survives refactoring those.
 */

describe("Stream contract", () => {
  // "The client may receive individual messages or arrays of messages."
  it("accepts an array of messages in one frame", () => {
    const state = play([
      sse("final", [
        { content: "asked", id: "u1", type: "user" },
        { content: "answered", id: "a1", type: "assistant" },
      ]),
    ]);

    expect(shape(state)).toEqual(["user", "assistant"]);
  });

  // "Streams may also contain SSE comments/keep-alives, long silent periods,
  //  unknown channels, and unknown message types."
  it("ignores keep-alives and unknown channels without disturbing content", () => {
    const state = play([
      assistant("a1", "kept"),
      keepAlive(),
      sse("telemetry", { anything: true }),
      sse("final", { id: "x", type: "hologram" }),
      assistant("a2", "also kept"),
    ]);

    expect(shape(state)).toEqual(["assistant", "assistant"]);
  });

  // "Unknown content must degrade locally without damaging content already rendered."
  it("drops a malformed payload and keeps everything around it", () => {
    const state = play([assistant("a1", "before"), sse("final", '{"truncated": '), assistant("a2", "after")]);

    expect(shape(state)).toEqual(["assistant", "assistant"]);
  });

  // "Announces the protocol version. It opens every stream and may appear again
  //  if the version changes during a stream."
  it("follows a protocol change mid-stream", () => {
    expect(play([protocol(1), protocol(2)]).protocol).toBe(2);
  });
});

describe("Version 2 message types", () => {
  // "A user message may include file_attachments[] containing file_name,
  //  file_type, and file_size."
  it("keeps a user message's file attachments", () => {
    const state = play([
      user("u1", "see attached", {
        file_attachments: [{ file_name: "q3.csv", file_size: 2048, file_type: "text/csv", id: "f1", type: "file" }],
      }),
    ]);

    const node = at(state, ROOT_SCOPE, "u1");
    expect(node.kind === "user" && node.attachments[0].file_name).toBe("q3.csv");
  });

  // "Known kinds include agent, library, and tool; unknown kinds may occur."
  it("renders an action whose kind it does not recognise", () => {
    const state = play([action("t1", { kind: "quantum", title: "New kind" })]);

    expect((at(state, ROOT_SCOPE, "t1") as ActionNode).actionKind).toBe("quantum");
    expect(shape(state)).toEqual(["group"]);
  });

  // "has_succeeded is absent or null while running."
  it("treats an absent has_succeeded as still running", () => {
    const state = play([action("t1", { title: "Running" })]);

    expect((at(state, ROOT_SCOPE, "t1") as ActionNode).hasSucceeded).toBeNull();
  });

  // "A result may contain title, artifact_id, icon, or type."
  it("reads an artifact_id on a result whatever `type` claims", () => {
    const state = play([action("t1", { results: [{ artifact_id: "art-9", type: "text" }], title: "Go" })]);

    expect((at(state, ROOT_SCOPE, "t1") as ActionNode).results[0].artifactId).toBe("art-9");
  });
});

describe("Identity rules", () => {
  // "In v2, a message ID identifies one message within its scope."
  it("keeps identical ids in different scopes apart", () => {
    const state = play([
      action("dup", { kind: "agent", scope_id: "s1", title: "Opens s1" }),
      scoped("s1", assistant("dup", "scoped text")),
    ]);

    expect(at(state, ROOT_SCOPE, "dup").kind).toBe("action");
    expect(at(state, "s1", "dup").kind).toBe("assistant");
  });

  // "Updates retain that ID."
  it("updates a message in place rather than appending a second row", () => {
    const state = play([
      assistantChunk("a1", "first"),
      assistant("a2", "second"),
      assistant("a1", "first settled"),
    ]);

    expect(state.order).toEqual([nodeKey(ROOT_SCOPE, "a1"), nodeKey(ROOT_SCOPE, "a2")]);
  });
});

describe("Reduction and ordering", () => {
  // "This reduces to a user message, thinking block, one group containing the
  //  three consecutive actions, nested aud content inside act-agent, the
  //  artifact reference at its stream position, and one assistant message."
  it("reduces the brief's example to the shape the brief describes", () => {
    const state = play(BRIEF_TRACE);

    expect(shape(state)).toEqual(["user", "thinking", "group", "artifactRef", "assistant"]);
    expect((state.nodes[state.order[2]] as ActionGroupNode).actions).toEqual([
      nodeKey(ROOT_SCOPE, "act-spend"),
      nodeKey(ROOT_SCOPE, "act-bench"),
      nodeKey(ROOT_SCOPE, "act-agent"),
    ]);
  });

  // "Streaming chunks with the same identity form one message, not multiple rows."
  it("accumulates streaming chunks into one message", () => {
    const state = play([assistantChunk("a1", "abc"), assistantChunk("a1", "def")]);

    const node = at(state, ROOT_SCOPE, "a1") as TextNode;
    expect(node.content).toBe("abcdef");
    expect(node.isStreaming).toBe(true);
    expect(state.order).toHaveLength(1);
  });

  // "A final replaces all streaming content accumulated for that identity."
  it("lets a final purge accumulated deltas rather than appending to them", () => {
    const streamed = play([
      assistantChunk("a1", "Here's the audit script. "),
      assistantChunk("a1", "Findings first:"),
    ]);
    const settled = play([assistant("a1", "Here's the audit, tightened up.")], streamed);

    const node = at(settled, ROOT_SCOPE, "a1") as TextNode;
    expect(node.content).toBe("Here's the audit, tightened up.");
    expect(node.isStreaming).toBe(false);
  });

  it("applies supersession to thinking as well as assistant text", () => {
    const state = play([thinkingChunk("t1", "partial"), thinking("t1", "settled reasoning")]);

    expect((at(state, ROOT_SCOPE, "t1") as TextNode).content).toBe("settled reasoning");
  });

  // "A later final may replace an earlier final. Action status and title may
  //  therefore change after first render."
  it("lets a settled action change title and status", () => {
    const state = play([
      action("t1", { has_succeeded: null, title: "Accessing remote storage..." }),
      action("t1", { has_succeeded: true, results: [{ title: "1,208 rows" }], title: "Successfully imported tables" }),
    ]);

    const node = at(state, ROOT_SCOPE, "t1") as ActionNode;
    expect(node.title).toBe("Successfully imported tables");
    expect(node.hasSucceeded).toBe(true);
    expect(node.results).toHaveLength(1);
  });

  // "Render understood fields and ignore the rest." A field the later frame
  // omits keeps its previous value rather than being blanked.
  it("keeps fields a later frame does not mention", () => {
    const state = play([
      action("t1", { icon: "database", kind: "agent", scope_id: "s1", title: "Running" }),
      action("t1", { has_succeeded: true }),
    ]);

    const node = at(state, ROOT_SCOPE, "t1") as ActionNode;
    expect(node.title).toBe("Running");
    expect(node.icon).toBe("database");
    expect(node.actionKind).toBe("agent");
    expect(node.hasSucceeded).toBe(true);
  });

  // "Consecutive actions form one group. Main-scope assistant text or an
  //  artifact reference closes the group."
  it("merges consecutive actions and closes the group on assistant text", () => {
    const state = play([
      action("t1", { title: "One" }),
      action("t2", { title: "Two" }),
      assistant("a1", "Done."),
      action("t3", { title: "Three" }),
    ]);

    expect(shape(state)).toEqual(["group", "assistant", "group"]);
    expect((state.nodes[state.order[0]] as ActionGroupNode).actions).toHaveLength(2);
  });

  it("closes the group on an artifact reference too", () => {
    const state = play([action("t1", { title: "One" }), artifactRef("art-1"), action("t2", { title: "Two" })]);

    expect(shape(state)).toEqual(["group", "artifactRef", "group"]);
  });

  /**
   * Thinking is not named as a closer in the brief, but it sits between two
   * main-scope actions dozens of times across four recorded streams. We read
   * "consecutive" literally: anything in between breaks the run. See
   * `DECISIONS.md`.
   */
  it("treats thinking between two actions as breaking the run", () => {
    const state = play([action("t1", { title: "One" }), thinking("th1", "hmm"), action("t2", { title: "Two" })]);

    expect(shape(state)).toEqual(["group", "thinking", "group"]);
  });

  // "Scoped frames belong inside the agent action that opened their scope, even
  //  when scoped frames arrive before that action."
  it("adopts scoped frames that arrived before their anchor", () => {
    const beforeAnchor = play(BRIEF_TRACE.slice(0, 6));
    expect(beforeAnchor.pendingScopes.aud).toHaveLength(2);
    expect(beforeAnchor.order).not.toContain(nodeKey("aud", "s-t1"));

    const state = play(BRIEF_TRACE);
    const agent = at(state, ROOT_SCOPE, "act-agent") as ActionNode;
    expect(state.scopeAnchors.aud).toBe(agent.key);
    expect(state.children[agent.key]).toEqual([nodeKey("aud", "s-t1"), nodeKey("aud", "group:s-act")]);
    expect(state.pendingScopes.aud).toBeUndefined();
  });

  // "A |<scope_id> suffix routes the frame to a nested agent scope rather than
  //  the main transcript."
  it("never lets scoped content reach the main transcript", () => {
    for (const key of play(BRIEF_TRACE).order) {
      expect(key.startsWith(`${ROOT_SCOPE}/`)).toBe(true);
    }
  });

  // "Nested scopes must work at arbitrary depth."
  it("nests scopes arbitrarily deep", () => {
    const frames = [];
    for (let level = 1; level <= 6; level += 1) {
      const frame = action(`a${level}`, { kind: "agent", scope_id: `s${level}`, title: `level ${level}` });
      frames.push(level === 1 ? frame : scoped(`s${level - 1}`, frame));
    }
    const state = play(frames);

    let key = nodeKey(ROOT_SCOPE, "a1");
    for (let level = 2; level <= 6; level += 1) {
      expect(state.children[key], `level ${level} missing`).toEqual([nodeKey(`s${level - 1}`, `group:a${level}`)]);
      key = nodeKey(`s${level - 1}`, `a${level}`);
    }
  });
});

describe("Turn lifecycle", () => {
  // "Marks the end of a turn or replay."
  it("completes on a complete frame", () => {
    expect(play([assistant("a1", "hi"), complete()]).status).toBe("complete");
  });

  /**
   * "An error frame is content; processing may continue after it."
   *
   * The status is checked *immediately* after the error rather than at the end
   * of the stream: any later content frame sets the status back to `streaming`
   * on its way through, which would mask the error having ended the turn.
   */
  it("treats an error as content and leaves the turn open", () => {
    const afterError = play([
      action("t1", { title: "Fetch benchmarks" }),
      errorFrame({ detail: "upstream said no", status: 502, title: "Benchmark fetch failed" }),
    ]);

    expect(afterError.status).toBe("streaming");
    expect(afterError.problem).toBeUndefined();

    const state = play([assistant("a1", "Carrying on without benchmarks.")], afterError);
    expect(shape(state)).toEqual(["group", "error", "assistant"]);
  });

  it("records more than one error as separate content", () => {
    const state = play([
      errorFrame({ title: "First failure" }),
      assistant("a1", "retrying"),
      errorFrame({ title: "Second failure" }),
    ]);

    expect(shape(state)).toEqual(["error", "assistant", "error"]);
    expect(state.status).toBe("streaming");
  });

  // "An action still running when the stream terminates is interrupted, not failed."
  it("marks unfinished actions interrupted, never failed", () => {
    const live = play([
      action("t1", { has_succeeded: null, title: "Build attribution report" }),
      assistantChunk("a1", "half a sen"),
    ]);
    const ended = finishStream(live, "interrupted");

    const node = at(ended, ROOT_SCOPE, "t1") as ActionNode;
    expect(node.isInterrupted).toBe(true);
    expect(node.hasSucceeded).toBeNull(); // never claim it failed
    expect((at(ended, ROOT_SCOPE, "a1") as TextNode).isStreaming).toBe(false);
    expect(ended.status).toBe("interrupted");
  });

  // "Stopping a turn must preserve all content already received."
  it("preserves received content when the user stops the turn", () => {
    const live = play([user("u1", "asked"), assistantChunk("a1", "partial answer")]);
    const stopped = finishStream(live, "stopped");

    expect(shape(stopped)).toEqual(["user", "assistant"]);
    expect((at(stopped, ROOT_SCOPE, "a1") as TextNode).content).toBe("partial answer");
    expect(stopped.status).toBe("stopped");
  });

  it("does not mark anything interrupted on a clean completion", () => {
    const state = play([action("t1", { has_succeeded: true, title: "Done" }), complete()]);

    expect((at(finishStream(state, "complete"), ROOT_SCOPE, "t1") as ActionNode).isInterrupted).toBe(false);
  });

  /**
   * "Silence is not failure. A turn remains open through long pauses." and
   * "Do not invent a timeout unless the transport contract explicitly defines
   * one." Keep-alives therefore change nothing at all.
   */
  it("does not end a turn because of silence", () => {
    const state = play([thinkingChunk("t1", "thinking"), keepAlive(), keepAlive(), keepAlive()]);

    expect(state.status).toBe("streaming");
  });
});

describe("How a stream ended", () => {
  /**
   * These branches were defects found only by running the app in a browser —
   * Node ends a killed stream quietly while the browser raises, so the code had
   * keyed off the exception and reported a dropped connection as a failure.
   *
   * Extracting the decision out of the effect is what makes it testable here,
   * with no DOM and no browser.
   */
  const withContent = play([assistant("a1", "partial")]);
  const empty = emptyTranscript;
  const completed = play([assistant("a1", "done"), complete()]);

  // "A turn ends as completed, stopped by the user, or failed."
  it("reports a completed turn", () => {
    expect(streamOutcome(completed, { aborted: false, threw: false })).toBe("complete");
  });

  // "Stopping a turn must preserve all content already received."
  it("reports a user stop as stopped, whether or not the stream raised", () => {
    expect(streamOutcome(withContent, { aborted: true, threw: true })).toBe("stopped");
    expect(streamOutcome(withContent, { aborted: true, threw: false })).toBe("stopped");
  });

  /**
   * "An action still running when the stream terminates is interrupted, not
   * failed." Content received and then cut off is interrupted in *both*
   * runtimes — the quiet Node ending and the browser's network error.
   */
  it("reports a dropped connection as interrupted however it surfaces", () => {
    expect(streamOutcome(withContent, { aborted: false, threw: true })).toBe("interrupted");
    expect(streamOutcome(withContent, { aborted: false, threw: false })).toBe("interrupted");
  });

  it("reports a turn that never started as failed", () => {
    expect(streamOutcome(empty, { aborted: false, threw: true })).toBe("failed");
  });

  it("does not call an empty thread a failure when nothing went wrong", () => {
    expect(streamOutcome(empty, { aborted: false, threw: false })).toBe("complete");
  });

  it("keeps a completed turn completed even if the stream then raises", () => {
    expect(streamOutcome(completed, { aborted: false, threw: true })).toBe("complete");
  });
});

describe("Artifacts and forward compatibility", () => {
  // "An artifact payload is delivered on the action that produced it and may
  //  later be referenced by ID. Render each reference at its position."
  it("registers a delivery and positions its reference", () => {
    const state = play([
      action("t1", {
        artifacts: [{ columns: { channel: ["LinkedIn"] }, id: "art-1", type: "table" }],
        title: "Build table",
      }),
      artifactRef("art-1"),
    ]);

    expect(state.artifacts["art-1"]).toMatchObject({ type: "table" });
    expect(shape(state)).toEqual(["group", "artifactRef"]);
  });

  // "If an artifact ID is delivered more than once, the most recent payload is
  //  current everywhere it is referenced."
  it("replaces a re-delivered artifact without moving its position", () => {
    const state = play([
      action("t1", { artifacts: [{ columns: { n: [1] }, id: "art-1", type: "table" }], title: "First" }),
      artifactRef("art-1"),
      assistant("a1", "text in between"),
      action("t2", { artifacts: [{ columns: { n: [1, 2, 3] }, id: "art-1", type: "table" }], title: "Second" }),
    ]);

    expect(state.artifacts["art-1"]).toMatchObject({ columns: { n: [1, 2, 3] } });
    // The reference still sits before the assistant text, where it first landed.
    expect(shape(state)).toEqual(["group", "artifactRef", "assistant", "group"]);
  });

  // "Actions may contain additional fields such as large output values or
  //  results_units. Render understood fields and ignore the rest."
  it("ignores fields it does not understand", () => {
    const state = play([action("t1", { output: "x".repeat(5000), results_units: "rows", title: "Odd" })]);

    expect((at(state, ROOT_SCOPE, "t1") as ActionNode).title).toBe("Odd");
  });
});

describe("Questions, files, and history", () => {
  // "One ask may contain up to four questions with id, header, question,
  //  options[], and multi_select."
  it("records an ask as a single node holding all its questions", () => {
    const state = play([
      ask("ask-1", [
        { header: "Budget", id: "q1", multi_select: false, options: [{ label: "Cap it" }], question: "Cap spend?" },
        { header: "Channels", id: "q2", multi_select: true, options: [{ label: "LinkedIn" }], question: "Which?" },
      ]),
    ]);

    const node = at(state, ROOT_SCOPE, "ask-1");
    expect(node.kind === "question" && node.questions).toHaveLength(2);
    expect(shape(state)).toEqual(["question"]);
  });

  // "Everything before a v2 bookmark is replayed history; everything after it
  //  is live."
  it("marks the boundary between replayed history and the live tail", () => {
    const state = play([assistant("a1", "old"), bookmark(), assistant("a2", "new")]);

    expect(state.hasBookmark).toBe(true);
    expect(shape(state)).toEqual(["assistant", "bookmark", "assistant"]);
  });
});

describe("Recorded streams", () => {
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".sse"));

  it("found the recorded streams", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  // "Run every recorded stream." Rather than assert a shape per fixture, assert
  // the invariants that must hold across all of them.
  it.each(names)("reduces %s while holding every invariant", (name) => {
    const state = play(framesOf(name));

    expect(state.order.length, `${name} produced nothing`).toBeGreaterThan(0);

    for (const key of state.order) {
      expect(key.startsWith(`${ROOT_SCOPE}/`), `${name} leaked ${key}`).toBe(true);

      const node = state.nodes[key];
      if (node.kind === "group") {
        expect(node.actions.length, `${name}: empty group ${key}`).toBeGreaterThan(0);
        for (const child of node.actions) {
          expect(state.nodes[child], `${name}: dangling action ${child}`).toBeDefined();
        }
      }
    }

    for (const [parent, childKeys] of Object.entries(state.children)) {
      expect(state.nodes[parent], `${name}: dangling parent ${parent}`).toBeDefined();
      for (const child of childKeys) {
        expect(state.nodes[child], `${name}: dangling child ${child}`).toBeDefined();
      }
    }

    for (const [id, artifact] of Object.entries(state.artifacts)) {
      expect(artifact.id, `${name}: artifact ${id} mismatched`).toBe(id);
    }
  });
});
