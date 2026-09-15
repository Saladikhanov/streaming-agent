import type { MessageEvent } from "../api/types";

/**
 * Reading values that came off the wire.
 *
 * Payloads arrive as `unknown`, which is the honest type for them — the service
 * is free to send fields we have never seen, and the brief guarantees it will.
 * Narrowing that back to something usable is mechanical and easy to get subtly
 * wrong, so it happens here once rather than at every call site.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The message types the v2 contract defines, taken from the contract itself. */
export type WireType = MessageEvent["type"];

/**
 * Every known message type. Written as a record so the compiler enforces
 * completeness: add a type to `MessageEvent` and this fails to build until it
 * is listed here, rather than silently falling through to "unknown" at runtime.
 */
const KNOWN_TYPES: Record<WireType, true> = {
  action: true,
  artifact: true,
  assistant: true,
  bookmark: true,
  command: true,
  metadata: true,
  thinking: true,
  user: true,
};

/**
 * The payload's `type`, if we recognise it.
 *
 * Returning a union rather than a raw string is what makes the reducer's switch
 * checkable: a mistyped `case` stops compiling instead of quietly never
 * matching. An unrecognised type returns `undefined` — a new message type the
 * service invented is ignored, not an error.
 */
export function wireTypeOf(record: Record<string, unknown>): WireType | undefined {
  const type = record.type;
  return typeof type === "string" && type in KNOWN_TYPES ? (type as WireType) : undefined;
}
