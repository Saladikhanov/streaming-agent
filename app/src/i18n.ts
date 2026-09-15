/**
 * Interface strings.
 *
 * Catalogues are JSON files served from `public/locales/`, not modules compiled
 * into the bundle. That is the point: a catalogue is *data*. It can be handed to
 * a translator, reviewed on its own, and replaced on the server without
 * rebuilding the application.
 *
 * Only strings this application authors live here. Content from the service —
 * message text, tool titles, question wording — is rendered as it arrives and is
 * never translated; that is the assistant's language, not the interface's.
 *
 *   tr("transcript.empty")
 *   tr("transcript.loading", { thread: "welcome" })
 *
 * Placeholders are named rather than positional, because translations reorder
 * clauses: `"Loading {thread}…"` can become `"{thread} wird geladen…"` without
 * the call site changing.
 */

type Primitive = string | number;
type Catalogue = Record<string, unknown>;

let catalogue: Catalogue | null = null;
let locale = "en";

/**
 * Loads a catalogue before the application renders.
 *
 * Awaited during start-up so `tr` can stay synchronous everywhere else — a
 * component should not need a loading state to know what to call a button.
 */
export async function loadCatalogue(which = "en"): Promise<void> {
  const response = await fetch(`/locales/${which}.json`);
  if (!response.ok) {
    throw new Error(`missing locale catalogue: ${which} (${response.status})`);
  }
  catalogue = (await response.json()) as Catalogue;
  locale = typeof catalogue.$locale === "string" ? catalogue.$locale : which;
}

/**
 * The locale the loaded catalogue is written in.
 *
 * Number and date formatting is bound to this rather than to the browser, so a
 * German browser does not render `21.840` inside an English sentence.
 */
export function uiLocale(): string {
  return locale;
}

/**
 * Looks up a dotted key and fills in any placeholders.
 *
 * A missing key returns the key itself. That is deliberate: a visible
 * `transcript.emty` in the interface is a bug report, where an empty string
 * would be a silent hole nobody notices.
 */
export function tr(key: string, values?: Record<string, Primitive>): string {
  const template = resolve(key);

  if (template === undefined) {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }

  return values ? fill(template, values, key) : template;
}

function resolve(key: string): string | undefined {
  let node: unknown = catalogue;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    node = (node as Catalogue)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function fill(template: string, values: Record<string, Primitive>, key: string): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) {
      // A translation that dropped a placeholder, or a call site that forgot
      // one. Either way the original is left in place so it is visible.
      if (import.meta.env.DEV) {
        console.warn(`[i18n] ${key}: no value for {${name}}`);
      }
      return whole;
    }
    return String(value);
  });
}

/** Test seam: load a catalogue without a network. */
export function __setCatalogue(next: Catalogue): void {
  catalogue = next;
  locale = typeof next.$locale === "string" ? next.$locale : "en";
}
