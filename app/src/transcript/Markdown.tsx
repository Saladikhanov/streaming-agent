import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Assistant prose renders as GitHub-flavoured Markdown. GFM specifically,
 * because the recorded streams contain pipe tables and fenced code.
 *
 * Memoised on `content`: this is the hot path. A streaming message re-renders
 * on every delta, and re-parsing a long answer per delta is the one thing here
 * expensive enough to notice.
 *
 * Note what is *not* done: chunks are never parsed individually. A delta can
 * split a token in half — `markdown-torture` ends one mid-way through a table
 * separator, `"|\n|---|--"` — so text is accumulated as plain strings by the
 * reducer and only parsed once assembled.
 */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="space-y-3 leading-relaxed break-words">
      <ReactMarkdown
        components={{
          a: ({ children, href }) => (
            <a className="text-blue-600 underline underline-offset-2" href={href} rel="noreferrer" target="_blank">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-neutral-300 pl-3 text-neutral-600">{children}</blockquote>
          ),
          code: ({ children, className }) =>
            className?.startsWith("language-") ? (
              <code className="font-mono text-xs">{children}</code>
            ) : (
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
            ),
          h1: ({ children }) => <h1 className="text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="font-semibold">{children}</h3>,
          hr: () => <hr className="border-neutral-200" />,
          li: ({ children }) => <li>{children}</li>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          // Wide code and tables scroll inside their own box rather than
          // stretching the column and pushing the whole transcript sideways.
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">{children}</pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          td: ({ children }) => <td className="border-t border-neutral-200 px-2 py-1 align-top">{children}</td>,
          th: ({ children }) => (
            <th className="bg-neutral-50 px-2 py-1 font-medium whitespace-nowrap text-neutral-600">{children}</th>
          ),
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
        }}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
