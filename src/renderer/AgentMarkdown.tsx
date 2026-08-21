import { Check, Clipboard, Sparkles } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SpeechOutputButton } from "./SpeechOutputButton";
import { rememberContextCapture } from "./context-capture-history";

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

export function AgentMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}): ReactElement {
  const [savedContext, setSavedContext] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setSavedContext(false);
    setCopied(false);
  }, [text]);
  const saveContext = () => {
    const normalized = text.trim();
    if (streaming || !normalized || savedContext) return;
    const labelText = normalized
      .replace(/[#*_~`]/gu, "")
      .replace(/^\s{0,3}#{1,6}\s*/gmu, "")
      .replace(/^\s*[-*+]\s+/gmu, "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 44);
    rememberContextCapture({
      id: `context-${crypto.randomUUID()}`,
      kind: "agent-reply",
      label: labelText ? `Agent：${labelText}` : "Agent 回复",
      text: normalized,
      createdAt: new Date().toISOString(),
    });
    setSavedContext(true);
  };
  const copyReply = async () => {
    const normalized = text.trim();
    if (streaming || !normalized || copied) return;
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(normalized);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard permissions are optional. Keep the reply available without
      // surfacing a second error channel in the conversation.
    }
  };
  return (
    <div className="agent-markdown">
      <div className="agent-markdown-toolbar">
        <button
          type="button"
          className="agent-reply-copy-button"
          aria-label={copied ? "已复制 Markdown 回复" : "复制 Markdown 回复"}
          title="复制原始 Markdown 到系统剪贴板"
          disabled={streaming || copied || !text.trim() || !navigator.clipboard?.writeText}
          onClick={() => void copyReply()}
        >
          {copied ? <Check size={12} /> : <Clipboard size={12} />}
          <span>{copied ? "已复制" : "复制 Markdown"}</span>
        </button>
        <button
          type="button"
          className="agent-context-save-button"
          aria-label={savedContext ? "已保存到最近上下文" : "保存到最近上下文"}
          title={streaming ? "回答完成后才能保存" : "仅保存到本机最近上下文"}
          disabled={streaming || savedContext || !text.trim()}
          onClick={saveContext}
        >
          <Sparkles size={12} />
          <span>{savedContext ? "已保存" : "保存上下文"}</span>
        </button>
        <SpeechOutputButton
          text={text}
          label="朗读"
          ariaLabel="朗读回答"
          disabled={streaming}
        />
      </div>
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
