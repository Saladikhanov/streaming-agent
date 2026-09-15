import type { Artifact, CommandQuestion, FileAttachment, ProblemDetails } from "../api/types";

/**
 * What a transcript is made of. Types only — no logic lives here, so every
 * other module can depend on this one without depending on any behaviour.
 */

/** The main transcript. Nested-agent frames carry their own scope id instead. */
export const ROOT_SCOPE = "";

/**
 * A message id identifies one message *within its scope*, so the id alone is
 * not unique: two sub-agents may each have a message called `a1`. Every node is
 * therefore keyed by scope and id together.
 */
export type NodeKey = string & { readonly __brand?: "NodeKey" };

export function nodeKey(scope: string, id: string): NodeKey {
  return `${scope}/${id}`;
}

// ---- nodes ----

export type UserNode = {
  kind: "user";
  key: NodeKey;
  id: string;
  content: string;
  timestamp?: string;
  attachments: FileAttachment[];
};

/** Assistant prose and model reasoning differ only in how they render. */
export type TextNode = {
  kind: "assistant" | "thinking";
  key: NodeKey;
  id: string;
  content: string;
  /** True between the first delta and the authoritative `final`. */
  isStreaming: boolean;
};

export type ActionResultLine = { title?: string; icon?: string; artifactId?: string };

export type ActionNode = {
  kind: "action";
  key: NodeKey;
  id: string;
  title: string;
  icon?: string;
  input?: unknown;
  results: ActionResultLine[];
  /** `null` while running. A later frame may settle it either way. */
  hasSucceeded: boolean | null;
  /** Open union — unknown kinds occur and must not break rendering. */
  actionKind: string;
  /** Present on `kind: "agent"` actions: the scope this action owns. */
  scopeId?: string;
  /** Set when the stream ended while this action was still running. */
  isInterrupted: boolean;
};

/**
 * Consecutive actions render as one container.
 *
 * There is no `isOpen` flag: a group accepts another action exactly while it is
 * still the last node in its scope. Anything else arriving pushes it out of
 * that position, which is what makes the next action start a fresh group.
 */
export type ActionGroupNode = { kind: "group"; key: NodeKey; actions: NodeKey[] };

/** A positioned reference to an artifact delivered earlier on some action. */
export type ArtifactRefNode = { kind: "artifactRef"; key: NodeKey; artifactId: string };

/** One ask, carrying one to four questions answered together as a single turn. */
export type QuestionNode = { kind: "question"; key: NodeKey; id: string; questions: CommandQuestion[] };

/** Divides replayed history from the live tail. v1 streams never emit one. */
export type BookmarkNode = { kind: "bookmark"; key: NodeKey };

/** An error is transcript content: the turn may continue after it. */
export type ErrorNode = { kind: "error"; key: NodeKey; problem: ProblemDetails };

export type TranscriptNode =
  | UserNode
  | TextNode
  | ActionNode
  | ActionGroupNode
  | ArtifactRefNode
  | QuestionNode
  | BookmarkNode
  | ErrorNode;

// ---- stream lifecycle ----

/**
 * How the turn stands. There is deliberately no `stalled`: silence is not
 * failure, and the brief forbids inventing a timeout the transport never
 * defines. A turn ends only on `complete`, a user stop, or the stream ending.
 */
export type StreamStatus =
  | "idle"
  | "loading"
  | "streaming"
  | "complete"
  | "stopped"
  | "interrupted"
  | "failed";

export type TranscriptState = {
  /** Announced by the first frame; may change mid-stream on a migrated thread. */
  protocol: 1 | 2;
  /** Root-level node keys, in render order. */
  order: NodeKey[];
  nodes: Readonly<Record<NodeKey, TranscriptNode>>;
  /** Action key → ordered child keys of the scope that action opened. */
  children: Readonly<Record<NodeKey, NodeKey[]>>;
  /** `scope_id` → key of the agent action that owns that scope. */
  scopeAnchors: Readonly<Record<string, NodeKey>>;
  /**
   * `scope_id` → nodes that arrived before the action opening their scope.
   * The brief's own trace shows `final|aud` frames landing before the agent
   * action that opens `aud`, so scoped content waits here until it can be
   * grafted onto its parent.
   */
  pendingScopes: Readonly<Record<string, NodeKey[]>>;
  /** Artifact id → newest delivery. A re-delivery replaces it everywhere. */
  artifacts: Readonly<Record<string, Artifact>>;
  status: StreamStatus;
  /** Set when the transport itself failed, not when an error frame arrived. */
  problem?: ProblemDetails;
  /** True once a bookmark has arrived: everything after it is live, not replay. */
  hasBookmark: boolean;
};

export const emptyTranscript: TranscriptState = {
  artifacts: {},
  children: {},
  hasBookmark: false,
  nodes: {},
  order: [],
  pendingScopes: {},
  protocol: 2,
  scopeAnchors: {},
  status: "idle",
};
