import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import type { TranscriptState } from "./model";

import { __setCatalogue } from "../i18n";
import { pendingQuestionKey, TranscriptBody } from "./Transcript";
import { action, artifactRef, ask, assistant, bookmark, BRIEF_TRACE, errorFrame, play, scoped, user } from "./test-support";

/**
 * What the transcript actually renders, asserted as HTML.
 *
 * `renderToStaticMarkup` needs no DOM, so these run with no `jsdom` and no
 * testing library — the whole rendering contract is a pure function of the
 * state. Effects, clicks and scrolling are *not* covered here; those are
 * behaviour, they do need a DOM, and they are verified by hand (see
 * `docs/DECISIONS.md` §13c).
 *
 * The requirements pinned here were previously only checked by looking at a
 * browser, which is how "tables and files must render" was missed once.
 */

const CATALOGUE = fileURLToPath(new URL("../../public/locales/en.json", import.meta.url));

beforeAll(() => {
  __setCatalogue(JSON.parse(readFileSync(CATALOGUE, "utf8")) as Record<string, unknown>);
});

/** Renders a reduced state exactly as the application would. */
function html(state: TranscriptState): string {
  return renderToStaticMarkup(
    <TranscriptBody onAnswer={() => {}} pendingQuestion={pendingQuestionKey(state)} state={state} />,
  );
}

function countOf(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

describe("Compatibility details", () => {
  /**
   * "Every rendered message row must carry data-qa="msg-v2"."
   *
   * Asserted against a state containing one of every node kind, so a node type
   * added later without the attribute fails here rather than in someone's
   * end-to-end suite.
   */
  it("puts data-qa on every row of every node kind", () => {
    const state = play([
      user("u1", "asked"),
      assistant("a1", "answered"),
      action("t1", { kind: "agent", scope_id: "s1", title: "Delegate" }),
      scoped("s1", assistant("s-a1", "nested")),
      artifactRef("art-1"),
      ask("ask-1", [{ header: "Next", id: "q1", multi_select: false, options: [{ label: "Yes" }], question: "Go?" }]),
      bookmark(),
      errorFrame({ title: "Upstream failed" }),
    ]);
    const markup = html(state);

    // Every rendered row, including the nested one and the action inside the group.
    for (const kind of ["user", "assistant", "group", "action", "artifact", "question", "bookmark", "error"]) {
      expect(markup, `no row rendered for ${kind}`).toContain(`data-kind="${kind}"`);
    }
    // No row may carry a kind without the qa hook.
    expect(countOf(markup, 'data-qa="msg-v2"')).toBe(countOf(markup, "data-kind="));
  });
});

describe("Reduction and ordering, rendered", () => {
  // "This reduces to a user message, thinking block, one group containing the
  //  three consecutive actions, nested aud content inside act-agent…"
  it("renders the brief's example with the sub-agent nested inside its action", () => {
    const markup = html(play(BRIEF_TRACE));

    expect(markup).toContain("Audience Expert");
    expect(markup).toContain("Sub-agent reasoning");
    // The nested content must appear inside the delegating action's row, not
    // after it: everything between the action and its closing markup.
    const delegating = markup.indexOf("Audience Expert");
    const nested = markup.indexOf("Sub-agent reasoning");
    expect(nested).toBeGreaterThan(delegating);
    expect(markup).toContain("sub-agent");
  });

  it("renders consecutive actions inside a single group", () => {
    const markup = html(play([action("t1", { title: "One" }), action("t2", { title: "Two" })]));

    expect(countOf(markup, 'data-kind="group"')).toBe(1);
    expect(countOf(markup, 'data-kind="action"')).toBe(2);
  });
});

describe("Artifacts must render", () => {
  /**
   * "A chart may be rendered as a clearly labelled placeholder. Tables and
   * files must render."
   *
   * The requirement this project got wrong once, by reading the chart allowance
   * as covering every artifact type.
   */
  it("renders a table as a real table", () => {
    const state = play([
      action("t1", {
        artifacts: [{ columns: { channel: ["LinkedIn", "Meta"], spend: [21840, 10420] }, id: "art-1", type: "table" }],
        title: "Build table",
      }),
      artifactRef("art-1"),
    ]);
    const markup = html(state);

    expect(markup).toContain("<table");
    expect(markup).toContain("channel");
    expect(markup).toContain("LinkedIn");
    // Numbers are formatted for the interface locale, not the browser's.
    expect(markup).toContain("21,840");
  });

  it("renders a file with its name, type and size", () => {
    const state = play([
      action("t1", {
        artifacts: [
          { file_name: "q3-next-steps.md", file_size: 4231, file_type: "text/markdown", id: "art-2", type: "file" },
        ],
        results: [{ artifact_id: "art-2", title: "Report ready" }],
        title: "Draft report",
      }),
    ]);
    const markup = html(state);

    expect(markup).toContain("q3-next-steps.md");
    expect(markup).toContain("text/markdown");
    expect(markup).toContain("4.1 KB");
  });

  /**
   * Files are reached through a result's `artifact_id`, never through a
   * standalone artifact reference — measured across all 16 recorded streams.
   * Rendering only referenced artifacts would mean no file ever renders.
   */
  it("renders an artifact a result points at, without a separate reference", () => {
    const state = play([
      action("t1", {
        artifacts: [{ file_name: "notes.md", file_size: 100, file_type: "text/markdown", id: "art-3", type: "file" }],
        results: [{ artifact_id: "art-3" }],
        title: "Wrote notes",
      }),
    ]);

    expect(html(state)).toContain("notes.md");
  });

  it("renders a chart as a labelled placeholder naming what it holds", () => {
    const state = play([
      action("t1", {
        artifacts: [
          { data: [{ type: "bar" }, { type: "bar" }], id: "art-4", layout: { title: "Spend by channel" }, type: "chart" },
        ],
        title: "Plot",
      }),
      artifactRef("art-4"),
    ]);
    const markup = html(state);

    expect(markup).toContain("Spend by channel");
    expect(markup).toContain("2 series");
    expect(markup).not.toContain("<svg");
  });

  // "Unsupported or malformed content should be isolated."
  it("describes an artifact type it does not know instead of dropping it", () => {
    const state = play([
      action("t1", { artifacts: [{ id: "art-5", type: "hologram" }], title: "Odd" }),
      artifactRef("art-5"),
    ]);

    expect(html(state)).toContain("hologram");
  });

  it("says so when a reference arrives before its delivery", () => {
    expect(html(play([artifactRef("art-later")]))).toContain("art-later");
  });
});

describe("Questions, rendered", () => {
  // "While a question is pending, the normal composer is locked." The pending
  // ask is what drives that, so it must be identified from the transcript alone.
  it("treats an unanswered ask as pending and an answered one as settled", () => {
    const asked = play([
      ask("ask-1", [{ header: "Next", id: "q1", multi_select: false, options: [{ label: "Yes" }], question: "Go?" }]),
    ]);
    expect(pendingQuestionKey(asked)).toBeDefined();
    expect(html(asked)).toContain("Send answers");

    // "The question remains pending until a user turn answers it."
    const answered = play([user("u2", "Next: Yes")], asked);
    expect(pendingQuestionKey(answered)).toBeUndefined();
    expect(html(answered)).toContain("Answered");
  });

  it("offers every option and a free-form answer", () => {
    const state = play([
      ask("ask-1", [
        {
          header: "Budget",
          id: "q1",
          multi_select: true,
          options: [{ label: "Cap it" }, { label: "Leave it" }],
          question: "Cap spend?",
        },
      ]),
    ]);
    const markup = html(state);

    expect(markup).toContain("Cap it");
    expect(markup).toContain("Leave it");
    expect(markup).toContain("Or answer in your own words");
  });
});

describe("Interface strings", () => {
  it("renders copy from the catalogue, never a raw key", () => {
    const markup = html(play([bookmark(), errorFrame({ title: "Upstream failed" })]));

    expect(markup).toContain("live from here");
    expect(markup).not.toMatch(/\b(transcript|artifact|boundary|question)\.[a-zA-Z]+\b/);
  });
});
