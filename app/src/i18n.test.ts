import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { __setCatalogue, tr, uiLocale } from "./i18n";

/**
 * Catalogues are loaded at runtime, which buys hot-replaceable JSON at the cost
 * of the compiler checking keys. These tests buy that back: the source is
 * scanned for `tr(...)` calls and every key is checked against the catalogue,
 * so a typo or a deleted entry fails the build rather than surfacing as a raw
 * key in someone's interface.
 */

const SRC = fileURLToPath(new URL("./", import.meta.url));
const CATALOGUE = fileURLToPath(new URL("../public/locales/en.json", import.meta.url));

const english = JSON.parse(readFileSync(CATALOGUE, "utf8")) as Record<string, unknown>;

/** Every `tr("some.key")` in the source, with the file it appears in. */
function usedKeys(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) {
        walk(`${path}/`);
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/\btr\(\s*['"]([\w.]+)['"]/g)) {
          found.push({ file: entry.name, key: match[1] });
        }
      }
    }
  };
  walk(SRC);
  return found;
}

/** Dotted paths of every string in the catalogue, ignoring `$` metadata. */
function cataloguedKeys(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") {
    return [prefix];
  }
  if (typeof node !== "object" || node === null) {
    return [];
  }
  return Object.entries(node as Record<string, unknown>)
    .filter(([name]) => !name.startsWith("$"))
    .flatMap(([name, value]) => cataloguedKeys(value, prefix ? `${prefix}.${name}` : name));
}

beforeAll(() => {
  __setCatalogue(english);
});

describe("interface strings", () => {
  it("finds tr() calls across the source", () => {
    expect(usedKeys().length).toBeGreaterThan(20);
  });

  it("resolves every key the source asks for", () => {
    const available = new Set(cataloguedKeys(english));
    const missing = usedKeys().filter(({ key }) => !available.has(key));

    expect(missing.map(({ file, key }) => `${key} (${file})`)).toEqual([]);
  });

  it("has no catalogue entries nothing uses", () => {
    const used = new Set(usedKeys().map(({ key }) => key));
    // Unused copy is copy nobody reviews, and it costs a translator real money.
    expect(cataloguedKeys(english).filter((key) => !used.has(key))).toEqual([]);
  });

  it("declares the locale it is written in", () => {
    expect(uiLocale()).toBe("en");
  });
});

describe("tr", () => {
  it("resolves a dotted key", () => {
    expect(tr("composer.send")).toBe("Send");
  });

  it("fills named placeholders", () => {
    expect(tr("transcript.loading", { thread: "welcome" })).toBe("Loading welcome…");
  });

  it("accepts numbers as values", () => {
    expect(tr("artifact.series", { count: 3 })).toBe("3 series");
  });

  /**
   * A missing key returns the key. A visible `transcript.emty` is a bug report;
   * an empty string is a silent hole nobody notices.
   */
  it("returns the key itself when it is missing", () => {
    expect(tr("nope.not.here")).toBe("nope.not.here");
  });

  it("leaves a placeholder intact when no value is given", () => {
    expect(tr("transcript.loading", {})).toBe("Loading {thread}…");
  });

  it("does not resolve a key that points at an object", () => {
    expect(tr("composer")).toBe("composer");
  });
});
