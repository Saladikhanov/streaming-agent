import type { Artifact, ChartArtifact, FileArtifact, TableArtifact } from "../api/types";

import { Boundary } from "./Boundary";
import { tr, uiLocale } from "../i18n";

/**
 * Renders one artifact where a reference positioned it.
 *
 * The artifact is looked up by id at render time rather than copied into the
 * node, which is what lets a later delivery of the same id replace the payload
 * everywhere it is referenced without anything moving on the page.
 *
 * Tables and files render in full. Charts are a labelled placeholder, which the
 * brief explicitly permits — see `DECISIONS.md` §11 for why that trade was taken.
 */
export function ArtifactView({ artifact, artifactId }: { artifact: Artifact | undefined; artifactId: string }) {
  if (!artifact) {
    // A reference may legitimately arrive before its delivery.
    return (
      <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-xs text-neutral-400">
        {tr('artifact.waiting', { id: artifactId })}
      </div>
    );
  }

  return (
    <Boundary label={tr('boundary.artifactLabel', { id: artifactId })}>
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        {artifact.type === "table" ? (
          <TableView artifact={artifact} />
        ) : artifact.type === "file" ? (
          <FileView artifact={artifact} />
        ) : artifact.type === "chart" ? (
          <ChartPlaceholder artifact={artifact} />
        ) : (
          <Unsupported artifact={artifact} />
        )}
      </div>
    </Boundary>
  );
}

/**
 * Column-major on the wire: each key is a column name and each value that
 * column's cells, so rows are assembled by index rather than read directly.
 */
function TableView({ artifact }: { artifact: TableArtifact }) {
  const columns = Object.keys(artifact.columns ?? {});
  const rowCount = columns.length === 0 ? 0 : Math.max(...columns.map((name) => artifact.columns[name]?.length ?? 0));

  if (rowCount === 0) {
    return <p className="px-3 py-2 text-xs text-neutral-400">{tr('artifact.emptyTable')}</p>;
  }

  return (
    // Wide tables scroll inside their own box rather than stretching the column.
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr>
            {columns.map((name) => (
              <th className="bg-neutral-50 px-2 py-1.5 font-medium whitespace-nowrap text-neutral-600" key={name}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, row) => (
            <tr key={row}>
              {columns.map((name) => (
                <td className="border-t border-neutral-100 px-2 py-1.5 whitespace-nowrap" key={name}>
                  {renderCell(artifact.columns[name]?.[row])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FileView({ artifact }: { artifact: FileArtifact }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded bg-neutral-100 text-base">
        📄
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{artifact.file_name}</p>
        <p className="text-xs text-neutral-500">
          {artifact.file_type}
          {artifact.file_size ? ` · ${formatBytes(artifact.file_size)}` : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * A deliberate placeholder, not a failure.
 *
 * It names the chart and what it contains so the reader knows what is being
 * withheld — rendering it properly would mean either several megabytes of
 * `plotly.js` or a hand-written renderer for its trace subset.
 */
function ChartPlaceholder({ artifact }: { artifact: ChartArtifact }) {
  const series = Array.isArray(artifact.data) ? artifact.data : [];
  const title = typeof artifact.layout?.title === "string" ? artifact.layout.title : undefined;
  const kinds = [...new Set(series.map((trace) => (trace as { type?: string })?.type ?? "series"))];

  return (
    <div className="px-3 py-4">
      <p className="text-sm font-medium">{title ?? tr('artifact.chartTitle')}</p>
      <p className="mt-0.5 text-xs text-neutral-500">
        {tr('artifact.series', { count: series.length })}
        {kinds.length > 0 ? ` · ${kinds.join(", ")}` : ""} — {tr('artifact.chartNotRendered')}
      </p>
    </div>
  );
}

/** A type we have never seen is described rather than dropped. */
function Unsupported({ artifact }: { artifact: Artifact }) {
  return (
    <p className="px-3 py-2 text-xs text-neutral-500">
      {tr('artifact.unsupported', { type: (artifact as { type: string }).type })}
    </p>
  );
}

function renderCell(value: unknown): string {
  if (value == null) {
    return tr('artifact.emptyCell');
  }
  if (typeof value === "number") {
    // Bound to the interface locale, not the browser's: the words around this
    // number are English, so the number should be too.
    return Number.isInteger(value)
      ? value.toLocaleString(uiLocale())
      : value.toLocaleString(uiLocale(), { maximumFractionDigits: 2 });
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
