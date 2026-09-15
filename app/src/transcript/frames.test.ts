import { describe, expect, it } from "vitest";

import { decodeFrame, payloadsOf } from "./frames";
import { ROOT_SCOPE } from "./model";

describe("decodeFrame", () => {
  it("reads a main-scope frame", () => {
    const frame = decodeFrame({ data: '{"type":"user","id":"u1"}', event: "final" });

    expect(frame.channel).toBe("final");
    expect(frame.scope).toBe(ROOT_SCOPE);
    expect(frame.data).toEqual({ id: "u1", type: "user" });
  });

  it("splits the scope id off the channel", () => {
    const frame = decodeFrame({ data: '{"type":"thinking","id":"s-t1"}', event: "final|aud-1" });

    expect(frame.channel).toBe("final");
    expect(frame.scope).toBe("aud-1");
  });

  it("treats only the first bar as the separator", () => {
    // Nothing forbids a scope id containing a bar; splitting on all of them
    // would lose part of it.
    expect(decodeFrame({ data: "", event: "final|a|b" }).scope).toBe("a|b");
  });

  it("keeps channels it does not recognise", () => {
    // Routing is not the decoder's job — an unknown channel is passed along and
    // ignored later, rather than being swallowed here.
    expect(decodeFrame({ data: "{}", event: "telemetry" }).channel).toBe("telemetry");
  });

  describe("payload decoding", () => {
    it("returns undefined for malformed json rather than throwing", () => {
      expect(decodeFrame({ data: '{"truncated": ', event: "final" }).data).toBeUndefined();
    });

    it("returns undefined for an absent data field", () => {
      expect(decodeFrame({ data: "", event: "complete" }).data).toBeUndefined();
    });
  });

  it("decodes a keep-alive to an unclaimed channel", () => {
    // The transport dispatches an empty frame after each `:` comment line.
    // Nothing handles the empty channel, so keep-alives cost nothing and — per
    // the brief — their absence must never be read as a failure.
    const frame = decodeFrame({ data: "", event: "" });

    expect(frame.channel).toBe("");
    expect(payloadsOf(frame)).toEqual([]);
  });
});

describe("payloadsOf", () => {
  it("wraps a single message", () => {
    expect(payloadsOf(decodeFrame({ data: '{"id":"a1"}', event: "final" }))).toEqual([{ id: "a1" }]);
  });

  it("passes an array of messages through", () => {
    const frame = decodeFrame({ data: '[{"id":"a1"},{"id":"a2"}]', event: "final" });

    expect(payloadsOf(frame)).toEqual([{ id: "a1" }, { id: "a2" }]);
  });

  it("yields nothing when the payload failed to parse", () => {
    expect(payloadsOf(decodeFrame({ data: "oops", event: "final" }))).toEqual([]);
  });
});
