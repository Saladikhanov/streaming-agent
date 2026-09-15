import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { StreamSource } from "../App";
import type { NodeKey, TranscriptState } from "./model";

import { ArtifactView, formatBytes } from "./Artifacts";
import { Boundary } from "./Boundary";
import { Markdown } from "./Markdown";
import { QuestionCard } from "./QuestionCard";
import { useTranscript } from "./useTranscript";
import { tr } from "../i18n";

/**
 * How close to the bottom still counts as "following".
 *
 * Not zero: a stream that appends while the user sits exactly at the bottom
 * would otherwise unpin itself on the first pixel of overshoot, and a few lines
 * of slack matches what people read as "at the end".
 */
const NEAR_BOTTOM_PX = 64;

type Props = {
  source: StreamSource;
  threadId: string;
  /** Called when the stream ends, however it ends. */
  onClosed: () => void;
  /** Hands the Stop button a way to abort the live stream. */
  registerAbort: (abort: () => void) => void;
  /** Sends the answers to an outstanding ask as a single user turn. */
  onAnswer: (text: string) => void;
  /** Reports whether an unanswered ask is currently blocking the composer. */
  onPendingQuestionChange: (isPending: boolean) => void;
};

/**
 * First pass: correctness over appearance.
 *
 * This renders the reduced transcript with almost no styling, so the pipeline
 * — transport, decoding, reduction, React — can be verified against real
 * streams in a browser before any effort goes into how it looks.
 */
export function Transcript({ onAnswer, onClosed, onPendingQuestionChange, registerAbort, source, threadId }: Props) {
  const state = useTranscript(source, { onClosed, registerAbort });

  const scroller = useRef<HTMLDivElement>(null);
  /**
   * Whether new content should pull the view down.
   *
   * Kept in a ref as well as state because the layout effect below reads it on
   * every frame and must not re-subscribe to a changing value, while the button
   * needs a re-render to appear.
   */
  const following = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);

  const setFollowing = useCallback((next: boolean) => {
    if (next !== following.current) {
      following.current = next;
      setIsFollowing(next);
    }
  }, []);

  /**
   * Follow the tail, but only for someone already there.
   *
   * `useLayoutEffect` rather than `useEffect`: this runs before the browser
   * paints, so the view never shows the pre-scroll position for a frame and
   * then jump. Scrolling the container directly (rather than an anchor element)
   * keeps it instant, since smooth scrolling cannot keep up with a stream.
   */
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [state]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element) {
      // Anything beyond a few lines from the bottom means the user has gone
      // looking at something, and content must stop moving under them.
      setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX);
    }
  }, [setFollowing]);

  /**
   * The ask still waiting on the user, if any.
   *
   * Derived rather than stored: an ask is answered once a user message follows
   * it. On reopening a thread the history replays both, so the answered state
   * reconstructs itself with nothing persisted.
   */
  const pendingQuestion = pendingQuestionKey(state);

  useEffect(() => {
    onPendingQuestionChange(pendingQuestion !== undefined);
  }, [pendingQuestion, onPendingQuestionChange]);

  const followAgain = useCallback(() => {
    const element = scroller.current;
    if (element) {
      element.scrollTo({ behavior: "smooth", top: element.scrollHeight });
      setFollowing(true);
    }
  }, [setFollowing]);

  if (state.status === "loading" && state.order.length === 0) {
    return <Centered>{tr('transcript.loading', { thread: threadId })}</Centered>;
  }
  if (state.order.length === 0) {
    return <Centered>{tr('transcript.empty')}</Centered>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto" onScroll={onScroll} ref={scroller}>
          <TranscriptBody onAnswer={onAnswer} pendingQuestion={pendingQuestion} state={state} />
        </div>

        {/* One action to catch up, and it restores following. */}
        {!isFollowing && (
          <button
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs shadow-sm hover:bg-neutral-50"
            onClick={followAgain}
            type="button"
          >
            {tr('transcript.jumpToLatest')}
          </button>
        )}
      </div>
      <StatusBar state={state} />
    </div>
  );
}

/**
 * The transcript itself, given a state.
 *
 * Separated from `Transcript` so it can be rendered from a known state — no
 * stream, no effects, no DOM. That is what lets the rendering contract be
 * asserted in tests: every row carrying `data-qa`, tables and files actually
 * rendering, sub-agent content nesting inside its delegating action.
 */
export function TranscriptBody({
  onAnswer,
  pendingQuestion,
  state,
}: {
  onAnswer: (text: string) => void;
  pendingQuestion: NodeKey | undefined;
  state: TranscriptState;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-6 text-sm">
      {state.order.map((key) => (
        <Node key={key} nodeKey={key} onAnswer={onAnswer} pendingQuestion={pendingQuestion} state={state} />
      ))}
    </div>
  );
}

/**
 * Every rendered row carries `data-qa="msg-v2"`. It is applied here, once, so
 * no node type added later can quietly omit it.
 */
type NodeProps = {
  nodeKey: NodeKey;
  state: TranscriptState;
  onAnswer: (text: string) => void;
  pendingQuestion: NodeKey | undefined;
};

function Node({ nodeKey, onAnswer, pendingQuestion, state }: NodeProps) {
  const node = state.nodes[nodeKey];
  if (!node) {
    return null;
  }

  switch (node.kind) {
    case "user":
      return (
        <Row kind="user">
          <div className="ml-auto max-w-[80%] rounded-lg bg-neutral-900 px-3 py-2 whitespace-pre-wrap text-white">
            {node.content}
            {node.attachments.map((file) => (
              <div className="mt-1 text-xs text-neutral-300" key={file.id ?? file.file_name}>
                📎 {file.file_name}
                {file.file_size ? ` · ${formatBytes(file.file_size)}` : ""}
              </div>
            ))}
          </div>
        </Row>
      );

    case "assistant":
      return (
        <Row kind="assistant">
          <div>
            <Boundary label={tr('boundary.messageLabel')}>
              <Markdown content={node.content} />
            </Boundary>
            {node.isStreaming && <span className="text-neutral-400">▌</span>}
          </div>
        </Row>
      );

    case "thinking":
      return (
        <Row kind="thinking">
          <details className="rounded border border-neutral-200 bg-neutral-50 px-3 py-1.5">
            <summary className="cursor-pointer text-xs text-neutral-500">
              {node.isStreaming ? tr('transcript.thinkingStreaming') : tr('transcript.thinking')}
            </summary>
            <p className="mt-1 text-xs whitespace-pre-wrap text-neutral-600">{node.content}</p>
          </details>
        </Row>
      );

    case "group":
      return (
        <Row kind="group">
          <div className="divide-y divide-neutral-200 rounded border border-neutral-200">
            {node.actions.map((actionKey) => (
              <Action
                key={actionKey}
                nodeKey={actionKey}
                onAnswer={onAnswer}
                pendingQuestion={pendingQuestion}
                state={state}
              />
            ))}
          </div>
        </Row>
      );

    case "artifactRef":
      return (
        <Row kind="artifact">
          <ArtifactView artifact={state.artifacts[node.artifactId]} artifactId={node.artifactId} />
        </Row>
      );

    case "question":
      return (
        <Row kind="question">
          <QuestionCard isPending={pendingQuestion === node.key} node={node} onSubmit={onAnswer} />
        </Row>
      );

    case "bookmark":
      return (
        <Row kind="bookmark">
          <div className="text-center text-[11px] tracking-wide text-neutral-400 uppercase">{tr('transcript.liveFromHere')}</div>
        </Row>
      );

    case "error":
      return (
        <Row kind="error">
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">
            <strong>{node.problem.title}</strong>
            {node.problem.detail && <div className="text-xs">{node.problem.detail}</div>}
          </div>
        </Row>
      );

    default:
      return null;
  }
}

/** One tool call, plus the sub-agent transcript it owns when it has one. */
function Action({ nodeKey, onAnswer, pendingQuestion, state }: NodeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const node = state.nodes[nodeKey];
  if (node?.kind !== "action") {
    return null;
  }
  const children = state.children[node.key] ?? [];

  // A result either names something (rendered as a line) or points at an
  // artifact (rendered as the artifact itself).
  const artifactResults = node.results.map((result) => result.artifactId).filter((id): id is string => id != null);
  const textResults = node.results.filter((result) => result.title != null && result.artifactId == null);
  const hasDetail = textResults.length > 0 || node.input != null;

  return (
    <div data-kind="action" data-qa="msg-v2">
      <button
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${hasDetail ? "hover:bg-neutral-50" : "cursor-default"}`}
        disabled={!hasDetail}
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <span>{statusMark(node.hasSucceeded, node.isInterrupted)}</span>
        <span className="flex-1 truncate">{node.title || node.actionKind}</span>
        {node.actionKind === "agent" && <span className="text-[10px] text-violet-600">{tr('transcript.subAgent')}</span>}
        {node.isInterrupted && <span className="text-[10px] text-amber-600">{tr('transcript.interrupted')}</span>}
        {hasDetail && <span className="text-xs text-neutral-300">{isOpen ? "▾" : "▸"}</span>}
      </button>

      {/*
        Artifacts a result points at, rendered outside the collapse.

        Files are *only* ever pointed at this way — never by a standalone
        artifact reference, in any recorded stream — so hiding them behind a
        disclosure would mean files effectively never render.
      */}
      {artifactResults.length > 0 && (
        <div className="space-y-2 px-3 pt-1 pb-2">
          {artifactResults.map((artifactId) => (
            <ArtifactView artifact={state.artifacts[artifactId]} artifactId={artifactId} key={artifactId} />
          ))}
        </div>
      )}

      {/* Plain result lines and the tool's input stay collapsed, so a long run
          of tool calls stays scannable. */}
      {isOpen && (
        <div className="space-y-2 border-t border-neutral-100 bg-neutral-50/60 px-3 py-2">
          {textResults.length > 0 && (
            <ul className="space-y-1 text-xs text-neutral-600">
              {textResults.map((result, index) => (
                <li key={index}>• {result.title}</li>
              ))}
            </ul>
          )}
          {node.input != null && (
            <Boundary label={tr('boundary.toolInputLabel')}>
              <pre className="overflow-x-auto rounded bg-white p-2 text-[11px] text-neutral-600">
                {JSON.stringify(node.input, null, 2)}
              </pre>
            </Boundary>
          )}
        </div>
      )}

      {children.length > 0 && (
        <div className="ml-4 flex flex-col gap-2 border-l-2 border-violet-200 py-2 pl-3">
          {children.map((childKey) => (
            <Node
              key={childKey}
              nodeKey={childKey}
              onAnswer={onAnswer}
              pendingQuestion={pendingQuestion}
              state={state}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function statusMark(hasSucceeded: boolean | null, isInterrupted: boolean): string {
  if (isInterrupted) {
    return "⚠";
  }
  if (hasSucceeded == null) {
    return "◌";
  }
  return hasSucceeded ? "✓" : "✕";
}

function Row({ children, kind }: { children: React.ReactNode; kind: string }) {
  return (
    <div data-kind={kind} data-qa="msg-v2">
      {children}
    </div>
  );
}

function StatusBar({ state }: { state: TranscriptState }) {
  const message: Partial<Record<TranscriptState["status"], string>> = {
    failed: tr('status.failed'),
    interrupted: tr('status.interrupted'),
    loading: tr('status.connecting'),
    stopped: tr('status.stopped'),
  };
  const text = message[state.status];
  if (!text) {
    return null;
  }
  return <div className="shrink-0 border-t border-neutral-200 px-6 py-1.5 text-xs text-neutral-500">{text}</div>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-neutral-400">{children}</div>;
}

/**
 * The ask still waiting on the user: the last question with no user message
 * after it. Returns `undefined` when every ask has been answered.
 */
export function pendingQuestionKey(state: TranscriptState): NodeKey | undefined {
  let waiting: NodeKey | undefined;
  for (const key of state.order) {
    const node = state.nodes[key];
    if (node?.kind === "question") {
      waiting = key;
    } else if (node?.kind === "user") {
      waiting = undefined;
    }
  }
  return waiting;
}
