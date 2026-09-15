import { useEffect, useRef, useState } from "react";

import type { StreamSource } from "../App";
import type { TranscriptState } from "./model";

import type { DecodedFrame } from "./frames";

import { decodeFrame } from "./frames";
import { emptyTranscript, ROOT_SCOPE } from "./model";
import { asRecord } from "./narrow";
import { finishStream, reduce, streamOutcome } from "./reducer";
import { createV1Adapter, type V1Adapter } from "./v1";

type Options = {
  /** Called when the stream ends, however it ends. */
  onClosed: () => void;
  /** Hands the Stop button a way to abort the live stream. */
  registerAbort: (abort: () => void) => void;
};

/**
 * Drives a thread's streams into one transcript.
 *
 * This is the only part of the transcript that knows React exists. Everything
 * below it — decoding, reduction, placement — is plain functions, which is why
 * they can be tested by replaying a fixture off disk.
 *
 * There is deliberately no timer here. Silence is not failure, and the brief
 * forbids inferring a timeout the transport never defines, so a turn ends only
 * when the stream says so or the user stops it.
 */
export function useTranscript(source: StreamSource, { onClosed, registerAbort }: Options): TranscriptState {
  const [state, setState] = useState<TranscriptState>(emptyTranscript);

  /**
   * The transcript so far, surviving between streams.
   *
   * A thread opens with a resume and then runs one stream per turn, and each
   * of those is a separate `source`. The accumulated transcript has to outlive
   * them: starting each stream from empty would wipe the history the resume
   * just replayed. Resetting between *threads* still happens, because the
   * component is keyed by thread id and remounts.
   */
  const accumulated = useRef<TranscriptState>(emptyTranscript);

  // Held in a ref so a changing callback identity cannot re-subscribe the
  // stream: re-running the effect would restart the turn from scratch.
  const closed = useRef(onClosed);
  closed.current = onClosed;

  useEffect(() => {
    const controller = new AbortController();
    registerAbort(() => controller.abort("stopped"));

    const commit = (next: TranscriptState) => {
      accumulated.current = next;
      setState(next);
    };

    // Continue from whatever is already on screen rather than starting over.
    let current: TranscriptState = {
      ...accumulated.current,
      status: accumulated.current.order.length === 0 ? "loading" : "streaming",
    };

    /**
     * The service records the user's message in history but does not stream it
     * back on the turn, so the sender would watch their own message vanish
     * until the thread is reopened. Rendering it locally is the only way it can
     * appear at the moment it is sent.
     */
    if (source.pendingUserText !== undefined) {
      current = reduce(current, {
        channel: "final",
        data: { content: source.pendingUserText, id: `local:${source.key}`, type: "user" },
        scope: ROOT_SCOPE,
      });
    }
    commit(current);

    /**
     * Non-null only while the stream is speaking the legacy protocol.
     *
     * A thread can migrate mid-stream — `legacy-roas` replays its history as v1
     * and then announces v2 for the live tail — so the adapter is attached and
     * dropped by whatever the latest handshake says rather than decided once.
     */
    let legacy: V1Adapter | null = null;

    const route = (frame: DecodedFrame): DecodedFrame[] => {
      if (frame.channel === "protocol") {
        const version = asRecord(frame.data)?.version;
        legacy = version === 1 ? createV1Adapter() : null;
        return [frame];
      }
      return legacy ? legacy(frame) : [frame];
    };

    void (async () => {
      try {
        for await (const frame of source.open(controller.signal)) {
          if (controller.signal.aborted) {
            /**
             * Aborting usually makes the response stream throw, which the catch
             * below turns into `stopped`. But when the abort lands between
             * frames the loop simply notices it first, so the same conclusion
             * has to be reached here too — otherwise stopping quietly leaves
             * the turn looking as though it were still running.
             */
            commit(finishStream(current, streamOutcome(current, { aborted: true, threw: false })));
            return;
          }
          let next = current;
          for (const decoded of route(decodeFrame(frame))) {
            next = reduce(next, decoded);
          }
          if (next !== current) {
            current = next;
            commit(next);
          }
        }
        /**
         * The iterator ran out without complaint. A turn that finished cleanly
         * and one whose connection was dropped both look like this, so they are
         * told apart by whether a `complete` frame ever arrived.
         */
        commit(finishStream(current, streamOutcome(current, { aborted: false, threw: false })));
      } catch {
        commit(finishStream(current, streamOutcome(current, { aborted: controller.signal.aborted, threw: true })));
      } finally {
        if (!controller.signal.aborted) {
          closed.current();
        }
      }
    })();

    return () => controller.abort("superseded");
    // `source.key` changes whenever a new stream should be opened. The source is
    // a factory rather than an iterator precisely so this can re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.key]);

  return state;
}
