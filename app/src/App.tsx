import { useCallback, useMemo, useRef, useState } from "react";

import type { StreamFrame } from "./api/types";

import { cancelTurn, resumeThread, streamTurn } from "./api/client";
import { Composer } from "./components/Composer";
import { ThreadList } from "./components/ThreadList";
import { Transcript } from "./transcript/Transcript";
import { tr } from "./i18n";

/**
 * A stream that hasn't been opened yet.
 *
 * The transcript is handed this rather than a live `AsyncIterable`, because an
 * iterator can only be consumed once: React would re-run an effect holding one
 * (in StrictMode, on every mount) and find it already exhausted. A factory can
 * be called again, so re-subscribing — after a remount, or a reconnect you
 * write yourself — just works.
 */
export type StreamSource = {
  /** Changes whenever a new stream should be opened. */
  key: string;
  open: (signal: AbortSignal) => AsyncIterable<StreamFrame>;
  /**
   * The message that started this stream, on a turn.
   *
   * The service records it in history but does not stream it back, so without
   * this the sender would not see their own message until the thread is
   * reopened. Absent on a resume, which replays the real one from history.
   */
  pendingUserText?: string;
};

export function App() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [source, setSource] = useState<StreamSource | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  /** True while an unanswered ask is blocking the composer. */
  const [hasPendingQuestion, setHasPendingQuestion] = useState(false);
  /** Set by the transcript so the composer's Stop button can reach the live stream. */
  const abortStream = useRef<(() => void) | null>(null);
  const sequence = useRef(0);

  const openThread = useCallback((id: string) => {
    sequence.current += 1;
    setThreadId(id);
    setIsStreaming(false);
    setHasPendingQuestion(false);
    setSource({ key: `resume:${id}:${sequence.current}`, open: (signal) => resumeThread(id, signal) });
  }, []);

  const send = useCallback(
    (text: string) => {
      if (!threadId) {
        return;
      }
      sequence.current += 1;
      setIsStreaming(true);
      setSource({
        key: `turn:${threadId}:${sequence.current}`,
        open: (signal) => streamTurn(threadId, text, signal),
        pendingUserText: text,
      });
    },
    [threadId],
  );

  const stop = useCallback(() => {
    if (!threadId) {
      return;
    }
    abortStream.current?.();
    setIsStreaming(false);
    void cancelTurn(threadId);
  }, [threadId]);

  const transcript = useMemo(
    () =>
      threadId && source ? (
        <Transcript
          key={threadId}
          onAnswer={send}
          onClosed={() => setIsStreaming(false)}
          onPendingQuestionChange={setHasPendingQuestion}
          registerAbort={(abort) => {
            abortStream.current = abort;
          }}
          source={source}
          threadId={threadId}
        />
      ) : (
        <EmptyState />
      ),
    [threadId, source, send],
  );

  return (
    <div className="flex h-screen bg-neutral-50 text-neutral-900">
      <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-200 bg-white">
        <header className="flex h-12 shrink-0 items-center border-b border-neutral-200 px-4 text-sm font-semibold">
          {tr('app.title')}
        </header>
        <ThreadList onSelect={openThread} selectedId={threadId} />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">{transcript}</div>
        <Composer
        disabled={!threadId}
        isStreaming={isStreaming}
        lockedReason={hasPendingQuestion ? tr('composer.lockedByQuestion') : undefined}
        onSend={send}
        onStop={stop}
      />
      </main>
    </div>
  );
}

function EmptyState() {
  return <div className="flex h-full items-center justify-center text-sm text-neutral-400">{tr('transcript.noThread')}</div>;
}
