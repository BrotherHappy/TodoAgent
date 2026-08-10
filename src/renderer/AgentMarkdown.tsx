import type { MouseEvent, ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const safeExternalUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

export function AgentMarkdown({ text }: { text: string }): ReactElement {
  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children, ...props }) => {
            const safeHref = safeExternalUrl(href);
            if (!safeHref) return <span>{children}</span>;
            const openLink = (event: MouseEvent<HTMLAnchorElement>): void => {
              event.preventDefault();
              void window.desktopApi?.shell.openExternal(safeHref);
            };
            return (
              <a
                {...props}
                href={safeHref}
                rel="noreferrer"
                target="_blank"
                onClick={openLink}
              >
                {children}
              </a>
            );
          },
          img: ({ alt, title }) => (
            <span className="agent-markdown-image" title={title ?? undefined}>
              图片：{alt || "未命名图片"}
            </span>
          ),
          // Keep a wide Markdown table readable in the compact floating
          // window. The surrounding message still wraps normally; only the
          // table itself receives its own horizontal scroll area.
          table: ({ children }) => (
            <div className="agent-markdown-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
