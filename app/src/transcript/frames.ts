import type { StreamFrame } from "../api/types";

import { ROOT_SCOPE } from "./model";

/**
 * A raw SSE frame split into the three things the transcript needs: where it
 * should be routed, and what it says.
 *
 * Keep-alive comments reach us as entirely empty frames — the transport drops
 * the `:` line but still dispatches on the blank line after it. They decode to
 * an empty channel, which no handler claims, so they are ignored for free. The
 * brief is explicit that silence is not failure and that we must not invent a
 * timeout, so there is deliberately nothing here that treats their absence as
 * meaningful.
 */
export type DecodedFrame = {
  /** The `event:` field with any `|<scope_id>` suffix removed. */
  channel: string;
  /** `ROOT_SCOPE` for the main transcript, otherwise the nested agent's scope id. */
  scope: string;
  /**
   * Parsed `data:`. `undefined` when the field was absent, empty, or not valid
   * JSON — a malformed frame is dropped rather than thrown, so one bad payload
   * cannot damage content already rendered.
   */
  data: unknown;
};

export function decodeFrame(frame: StreamFrame): DecodedFrame {
  const separator = frame.event.indexOf("|");

  return {
    channel: separator === -1 ? frame.event : frame.event.slice(0, separator),
    data: parseJson(frame.data),
    scope: separator === -1 ? ROOT_SCOPE : frame.event.slice(separator + 1),
  };
}

/** A frame carries one message or an array of them; callers always want the list. */
export function payloadsOf(frame: DecodedFrame): unknown[] {
  if (frame.data === undefined) {
    return [];
  }
  return Array.isArray(frame.data) ? frame.data : [frame.data];
}

function parseJson(raw: string): unknown {
  if (raw === "") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
