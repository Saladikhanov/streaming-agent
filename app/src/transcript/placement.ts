import type { Artifact } from "../api/types";
import type { ActionGroupNode, ActionNode, NodeKey, TranscriptNode, TranscriptState } from "./model";

import { nodeKey, ROOT_SCOPE } from "./model";

/**
 * Where nodes go.
 *
 * Two rules live here, and they are the most load-bearing in the project:
 * consecutive actions collapse into one group, and scoped content belongs
 * inside the action that opened its scope. Keeping them apart from the
 * message-parsing handlers means they can be read — and tested — on their own.
 */

// ---- the working copy ----

/**
 * A shallow copy of the state, made once per applying frame and mutated freely
 * inside. The reducer reads like straight-line code while React still receives
 * a new object graph to diff against.
 */
export type Draft = {
  order: NodeKey[];
  nodes: Record<NodeKey, TranscriptNode>;
  children: Record<NodeKey, NodeKey[]>;
  scopeAnchors: Record<string, NodeKey>;
  pendingScopes: Record<string, NodeKey[]>;
  artifacts: Record<string, Artifact>;
  hasBookmark: boolean;
};

export function beginDraft(state: TranscriptState): Draft {
  return {
    artifacts: { ...state.artifacts },
    children: copyLists(state.children),
    hasBookmark: state.hasBookmark,
    nodes: { ...state.nodes },
    order: [...state.order],
    pendingScopes: copyLists(state.pendingScopes),
    scopeAnchors: { ...state.scopeAnchors },
  };
}

export function commitDraft(state: TranscriptState, draft: Draft): TranscriptState {
  return { ...state, ...draft };
}

function copyLists<T extends string>(source: Readonly<Record<T, NodeKey[]>>): Record<T, NodeKey[]> {
  const copy = {} as Record<T, NodeKey[]>;
  for (const key of Object.keys(source) as T[]) {
    copy[key] = [...source[key]];
  }
  return copy;
}

// ---- routing ----

/**
 * Which list a node belongs to — the single place routing is decided.
 *
 * Root-scope nodes go on the main timeline. Scoped nodes go inside the action
 * that opened their scope. If that action has not arrived yet they wait in
 * `pendingScopes`, because the stream does not guarantee the anchor comes
 * first: the brief's own trace shows `final|aud` frames landing before the
 * agent action that opens `aud`.
 *
 * Because every append routes through here, a scoped node has no path to
 * `order`. "Must not leak into the main transcript" is structural rather than a
 * rule anyone has to remember.
 */
export function containerOf(draft: Draft, scope: string): NodeKey[] {
  if (scope === ROOT_SCOPE) {
    return draft.order;
  }
  const anchor = draft.scopeAnchors[scope];
  if (anchor) {
    return (draft.children[anchor] ??= []);
  }
  return (draft.pendingScopes[scope] ??= []);
}

/**
 * Binds a scope to the action that owns it, adopting anything that arrived
 * early.
 *
 * Depth needs no special handling: a sub-agent nested inside another sub-agent
 * anchors against its own parent through exactly this path, so nesting is
 * unbounded without recursion.
 */
export function anchorScope(draft: Draft, scopeId: string, actionKey: NodeKey): void {
  if (draft.scopeAnchors[scopeId] === actionKey) {
    return;
  }
  draft.scopeAnchors[scopeId] = actionKey;

  const parked = draft.pendingScopes[scopeId];
  if (parked?.length) {
    draft.children[actionKey] = [...(draft.children[actionKey] ?? []), ...parked];
    delete draft.pendingScopes[scopeId];
  }
}

// ---- grouping ----

/** Appends anything that is not an action. */
export function appendNode(draft: Draft, scope: string, node: TranscriptNode): void {
  const container = containerOf(draft, scope);
  draft.nodes[node.key] = node;
  container.push(node.key);
}

/**
 * Appends an action, collapsing it into the run it belongs to.
 *
 * A group accepts another action exactly while it is still the last node in its
 * scope, so anything else arriving — assistant text, an artifact reference, a
 * thinking block — pushes it out of that position and the next action starts a
 * fresh group. Nothing has to be explicitly closed.
 *
 * Scoped content cannot break a parent's run either, because it is appended to
 * a different container entirely.
 */
export function appendAction(draft: Draft, scope: string, action: ActionNode): void {
  const container = containerOf(draft, scope);
  let group = trailingGroup(draft, container);

  if (!group) {
    // Named after its first action, which is unique within the scope.
    group = { actions: [], key: nodeKey(scope, `group:${action.id}`), kind: "group" };
    draft.nodes[group.key] = group;
    container.push(group.key);
  }

  draft.nodes[group.key] = { ...group, actions: [...group.actions, action.key] };
  draft.nodes[action.key] = action;
}

/** The group still accepting actions in this container, if the last node is one. */
function trailingGroup(draft: Draft, container: NodeKey[]): ActionGroupNode | undefined {
  const last = container.at(-1);
  const node = last ? draft.nodes[last] : undefined;
  return node?.kind === "group" ? node : undefined;
}
