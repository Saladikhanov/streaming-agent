# Streaming Agent Console — Technical Implementation Brief

> The behaviour contract this implementation is built against, kept in version control so it
> is diffable, greppable, and readable alongside the code.
>
> Transcribed verbatim from the supplied brief. Wording, order, and emphasis are the
> source's; only the page layout was expressed as Markdown headings, tables, and lists.
> Nothing was reworded, summarised, or reordered.

*A self-contained product and architecture contract*

## Objective

Implement the transcript layer for a React application that displays live AI-agent activity.
The transcript must remain correct while content streams incrementally, tools run, nested
agents emit events, artifacts are updated, a turn is stopped, and older threads are replayed.

The repository already contains an application shell, composer, thread list, transport
client, wire types, mock service, and recorded streams. Focus on transcript state,
rendering, turn lifecycle, and scrolling. Existing code may be reorganized when useful.

## Stream contract

The transport exposes parsed frames from an SSE stream. Each original SSE frame has this
form:

```
event: <channel>[|<scope_id>]
data: <MessageEvent | MessageEvent[]>
```

The client may receive individual messages or arrays of messages.

### Channels

| Channel | Meaning |
|---|---|
| `protocol` | Announces the protocol version. It opens every stream and may appear again if the version changes during a stream. |
| `streaming` | Carries incremental assistant and thinking chunks. |
| `final` | Carries a complete message. It replaces accumulated streaming content for that message ID. A later final may replace an earlier one. |
| `error` | Carries problem details: title, status, and detail. An error frame is transcript content and does not necessarily end the turn. |
| `complete` | Marks the end of a turn or replay. |

A `|<scope_id>` suffix routes the frame to a nested agent scope rather than the main
transcript.

Streams may also contain SSE comments/keep-alives, long silent periods, unknown channels,
and unknown message types. Unknown content must degrade locally without damaging content
already rendered.

## Version 2 message types

| Type | Fields and behavior |
|---|---|
| `user` / `assistant` | `id`, Markdown `content`. A user message may include `file_attachments[]` containing `file_name`, `file_type`, and `file_size`. |
| `thinking` | `id`, `content`. |
| `action` | `id`, `title`, `icon`, `input`, `results[]`, `has_succeeded`, `artifacts[]`, `kind`, and `scope_id`. A result may contain `title`, `artifact_id`, `icon`, or `type`. `has_succeeded` is absent or null while running. Known kinds include `agent`, `library`, and `tool`; unknown kinds may occur. An agent action opens the scope referenced by `scope_id`. |
| `artifact` | `artifact_id`, referencing an artifact previously delivered on an action. |
| `command` | `ask-user-question` with `questions[]`. Each ask contains one to four questions with `id`, `header`, `question`, `options[]`, and `multi_select`. Each option contains `label` and `description`. |
| `bookmark` | Separates replayed history from the live portion of the stream. |

Artifacts have three supported forms:

- `chart`: Plotly `data` and `layout`;
- `table`: column-major `columns`;
- `file`: `file_name`, `file_type`, and `file_size`.

A chart may be rendered as a clearly labelled placeholder. Tables and files must render.

## Identity rules

- In v2, a message ID identifies one message within its scope. Updates retain that ID.
- A `scope_id` identifies one nested-agent invocation and is not reused across turns in a
  thread.
- An `ask-user-question` command has its own stable ID in streams and REST reads.
- A question ID is unique only within its ask; different asks may reuse question IDs.
- Protocol v1 identity is defined in `PROTOCOL_V1.md`.

## Reduction and ordering

Frames arrive linearly, but the resulting transcript is hierarchical. For example:

```
final          user        u1
final          thinking    t1
final          action      act-spend
final          action      act-bench
final|aud      thinking    s-t1
final|aud      action      s-act
final          action      act-agent   kind: agent, scope_id: aud
final          artifact    art-trend
streaming      assistant   a1
streaming      assistant   a1
final          assistant   a1
complete
```

This reduces to a user message, thinking block, one group containing the three consecutive
actions, nested `aud` content inside `act-agent`, the artifact reference at its stream
position, and one assistant message.

Important rules:

- Streaming chunks with the same identity form one message, not multiple rows.
- A final replaces all streaming content accumulated for that identity.
- A later final may replace an earlier final. Action status and title may therefore change
  after first render.
- Consecutive actions form one group. Main-scope assistant text or an artifact reference
  closes the group.
- Scoped frames belong inside the agent action that opened their scope, even when scoped
  frames arrive before that action.
- Nested scopes must work at arbitrary depth.

## Turn lifecycle

- A turn ends as completed, stopped by the user, or failed. These states must be visually
  distinguishable.
- Silence is not failure. A turn remains open through long pauses.
- A turn ends on `complete`, an explicit user stop, or transport termination.
- An error frame is content; processing may continue after it.
- A healthy connection may send keep-alive comments during long pauses. Do not invent a
  timeout unless the transport contract explicitly defines one.
- An action still running when the stream terminates is interrupted, not failed.
- Only one turn may stream at a time.
- Stopping a turn must preserve all content already received and call the provided
  cancellation mechanism.

## Artifacts and forward compatibility

- An artifact payload is delivered on the action that produced it and may later be
  referenced by ID.
- Render each reference at its position in the transcript.
- If an artifact ID is delivered more than once, the most recent payload is current
  everywhere it is referenced.
- Actions may contain additional fields such as large output values or `results_units`.
  Render understood fields and ignore the rest.
- Unsupported or malformed content should be isolated to its own fallback/error boundary.

## Questions, files, and history

- A turn may finish by asking the user a question.
- The question remains pending until a user turn answers it and must survive reopening the
  thread.
- One ask may contain up to four questions. All answers are submitted together as one user
  turn.
- Individual questions cannot be submitted separately.
- Users must be able to provide a free-form answer outside the predefined options or leave
  a question unanswered.
- While a question is pending, the normal composer is locked.
- User text may refer to its `file_attachments`.
- Everything before a v2 bookmark is replayed history; everything after it is live.

## Available service interface

```
streamTurn(threadId, text, signal): AsyncIterable<StreamFrame>
resumeThread(threadId, signal): AsyncIterable<StreamFrame>
fetchThreads(cursor?): Promise<ThreadsPage>
fetchMessages(threadId, cursor?): Promise<MessagesPage>
cancelTurn(threadId): Promise<void>
```

`resumeThread` yields history, a bookmark, and any current live turn. `fetchMessages`
retrieves settled history backward in pages. The application transport already exposes raw
`StreamFrame` values; no additional third-party SSE parser is required.

## Required implementation

Complete all four areas:

1. **Streaming transcript:** Render Markdown text, thinking, action groups, tables, and
   files in stream order, updating as frames arrive.
2. **Nested agents:** Route nested-agent thinking and actions into the delegating action at
   arbitrary depth, including out-of-order scope anchors.
3. **Stop and state handling:** Allow user cancellation while preserving received content.
   Distinguish loading, empty, error, completed, stopped, and interrupted states.
4. **Reliable scrolling:** Follow new streaming content only while the user is at or near
   the bottom. Do not force-scroll after the user intentionally scrolls away. Returning to
   the bottom must require one action and restore follow mode. Avoid viewport jumps caused
   by content growth.

Compatibility details:

- Prefix each sidebar thread title with the account domain in square brackets, for example
  `[acme.com] Q3 launch review`.
- Every rendered message row must carry `data-qa="msg-v2"`.

## Reliability and tests

Recorded streams may include:

- keep-alives and long silences;
- Markdown split in the middle of a token;
- streaming content that differs from its final replacement;
- repeated finals and changing action status/title;
- scoped frames arriving before their parent action;
- unsupported channels, message types, and fields;
- actions left running when the stream terminates.

Add focused tests for the load-bearing behavior. At minimum, cover stream reduction, scope
routing, and supersession. Tests should operate directly on recorded fixtures when
practical, without requiring the server or network.

## Select one extension

Implement one extension deeply and document the choice:

1. **Dual protocol support:** Render v1 and v2 through one presentation model. Keep
   protocol differences outside rendering and avoid empty UI for features v1 does not
   provide. See `PROTOCOL_V1.md`.
2. **Paged history:** Load older messages when scrolling upward without moving the content
   currently being read.
3. **Ask-user-question:** Implement the interactive question behavior described above.
4. **Recoverable interruption:** Extend the mock service with a cursor and retention
   contract so a client can reconnect mid-turn without replaying the full thread. Define
   repeated-resume and post-completion behavior.
5. **Long-wait UX:** Define and implement what remains available while a turn may take up
   to 90 seconds. Document remaining gaps.

Optional improvements include an alternative representation (print/export/copy) that reuses
the same state model, and maintaining responsiveness with approximately 2,000 messages.

## Dependency boundaries

Do not use libraries that implement the core behavior being exercised:

- chat/assistant SDKs or hooks such as Vercel AI SDK `useChat`, assistant-ui, LangChain UI,
  or LlamaIndex UI;
- prebuilt chat, transcript, message-list, or agent UI kits;
- libraries that reduce a stream into conversation state;
- copied or adapted implementations from repositories, articles, or generated
  reproductions.

Allowed dependencies include Markdown renderers, virtualization, styling/component
libraries, state management, testing libraries, React, and TypeScript.

## Project documentation

Document:

- component architecture and state model;
- partial content and supersession behavior;
- visual hierarchy decisions;
- selected extension and rationale;
- intentionally omitted work;
- improvements that would be made with additional time;
- exact local installation, run, and test commands.

## Project delivery requirements

- Preserve the untouched starter project as the initial Git commit before implementation
  begins.
- Maintain a clear development history using small, meaningful commits that show how the
  solution evolved.
- Keep the repository runnable throughout development where practical; do not collapse all
  work into one final commit.
- Deliver the completed work as a standalone Git repository with its full commit history.
- Include the project documentation described above and verify that its installation,
  development, production-build, and test commands are exact.
- Provide a working application that starts locally using only the documented commands.
- Run every recorded stream and the automated tests before considering the project complete.
- Ensure required source files, fixtures, configuration, and lockfiles are committed.
  Exclude dependencies, generated caches, secrets, and machine-specific files.

Prioritize a coherent state model, correct required behavior, simple testable code, and a
usable visual hierarchy.
