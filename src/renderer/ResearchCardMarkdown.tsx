import { useState, type MouseEvent, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render a saved research summary as safe, readable Markdown. The card is a
 * local context surface: links are opened only through the desktop shell and
 * remote images / raw HTML are intentionally reduced to text.
 */
export function ResearchCardMarkdown({ text }: { text: string }): ReactElement {
  const [failedLink, setFailedLink] = useState<string>();
  return (
    <div className="research-card-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children, ...props }) => {
            const safeHref = safeExternalUrl(href);
            if (!safeHref || failedLink === safeHref) return <span>{children}</span>;
            const openLink = (event: MouseEvent<HTMLAnchorElement>): void => {
              event.preventDefault();
              if (!window.desktopApi?.shell.openExternal) {
                setFailedLink(safeHref);
                return;
              }
              void window.desktopApi.shell.openExternal(safeHref).catch(() => {
                setFailedLink(safeHref);
              });
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
            <span className="research-card-markdown-image" title={title ?? undefined}>
              图片：{alt || "未命名图片"}
            </span>
          ),
          table: ({ children }) => (
            <div className="research-card-markdown-table-scroll">
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
