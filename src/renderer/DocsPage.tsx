import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  FolderOpen,
  Hash,
  Search,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type TableHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  docsById,
  docsCategoryMeta,
  extractDocHeadings,
  findProjectDocByHref,
  projectDocs,
  slugifyHeading,
  type DocsCategory,
  type DocHeading,
  type ProjectDoc,
} from "./docs-catalog";

const selectedDocStorageKey = "todoAgentDocsDocument";

const categoryOrder: readonly DocsCategory[] = [
  "overview",
  "product",
  "experience",
  "pet",
  "engineering",
  "quality",
];

const safeExternalUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const plainText = (children: ReactNode): string =>
  Array.isArray(children)
    ? children.map((child) => plainText(child)).join("")
    : typeof children === "string" || typeof children === "number"
      ? String(children)
      : "";

const readSavedDocument = (): string => {
  try {
    const saved = localStorage.getItem(selectedDocStorageKey);
    return saved && docsById.has(saved) ? saved : "readme";
  } catch {
    return "readme";
  }
};

const saveDocument = (id: string): void => {
  try {
    localStorage.setItem(selectedDocStorageKey, id);
  } catch {
    // Private browsing or a disabled storage area should not block reading.
  }
};

function DocumentIcon({ category }: { category: DocsCategory }): ReactElement {
  if (category === "overview") return <BookOpen size={15} />;
  if (category === "product") return <FolderOpen size={15} />;
  if (category === "experience") return <CircleHelp size={15} />;
  if (category === "pet") return <Hash size={15} />;
  if (category === "engineering") return <FileText size={15} />;
  return <Check size={15} />;
}

function DocumentCatalogItem({
  doc,
  active,
  onSelect,
}: {
  doc: ProjectDoc;
  active: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`docs-catalog-item ${active ? "is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(doc.id)}
    >
      <span className="docs-catalog-item-icon" aria-hidden="true">
        <DocumentIcon category={doc.category} />
      </span>
      <span className="docs-catalog-item-copy">
        <strong>{doc.title}</strong>
        <small>{doc.file}</small>
      </span>
      {active && <span className="docs-catalog-item-dot" aria-hidden="true" />}
    </button>
  );
}

function headingComponents(headings: readonly DocHeading[]) {
  const cursor = { value: 0 };
  const createHeading = (level: number) => {
    const Heading = ({ children, ...props }: HTMLAttributes<HTMLHeadingElement> & ExtraProps) => {
      const entry = headings[cursor.value];
      cursor.value += 1;
      const text = plainText(children);
      const id = entry?.id ?? slugifyHeading(text, cursor.value - 1);
      return ReactMarkdownHeading(level, { ...props, id }, children);
    };
    Heading.displayName = `DocsHeading${level}`;
    return Heading;
  };
  return {
    h1: createHeading(1),
    h2: createHeading(2),
    h3: createHeading(3),
    h4: createHeading(4),
    h5: createHeading(5),
    h6: createHeading(6),
  };
}

function ReactMarkdownHeading(
  level: number,
  props: Record<string, unknown>,
  children: ReactNode,
): ReactElement {
  const headingProps = props as { id?: string; className?: string };
  // Keeping this tiny factory separate avoids unsafe HTML parsing while still
  // allowing every Markdown heading to receive a stable scroll target.
  switch (level) {
    case 1:
      return <h1 id={headingProps.id} className={headingProps.className}>{children}</h1>;
    case 2:
      return <h2 id={headingProps.id} className={headingProps.className}>{children}</h2>;
    case 3:
      return <h3 id={headingProps.id} className={headingProps.className}>{children}</h3>;
    case 4:
      return <h4 id={headingProps.id} className={headingProps.className}>{children}</h4>;
    case 5:
      return <h5 id={headingProps.id} className={headingProps.className}>{children}</h5>;
    default:
      return <h6 id={headingProps.id} className={headingProps.className}>{children}</h6>;
  }
}

export function DocsPage(): ReactElement {
  const [selectedId, setSelectedId] = useState(readSavedDocument);
  const [query, setQuery] = useState("");
  const articleRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedDoc = docsById.get(selectedId) ?? projectDocs[0];
  const headings = useMemo(
    () => extractDocHeadings(selectedDoc.content),
    [selectedDoc.content],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredDocs = useMemo(() => {
    if (!normalizedQuery) return projectDocs;
    return projectDocs.filter((doc) =>
      [doc.title, doc.file, doc.summary, doc.status, ...doc.keywords]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [normalizedQuery]);
  const groupedDocs = useMemo(
    () =>
      categoryOrder
        .map((category) => ({
          category,
          docs: filteredDocs.filter((doc) => doc.category === category),
        }))
        .filter((group) => group.docs.length > 0),
    [filteredDocs],
  );
  const selectedIndex = projectDocs.findIndex((doc) => doc.id === selectedDoc.id);
  const previousDoc = selectedIndex > 0 ? projectDocs[selectedIndex - 1] : undefined;
  const nextDoc =
    selectedIndex >= 0 && selectedIndex < projectDocs.length - 1
      ? projectDocs[selectedIndex + 1]
      : undefined;

  const selectDocument = (id: string): void => {
    if (!docsById.has(id)) return;
    setSelectedId(id);
    saveDocument(id);
    const article = articleRef.current;
    if (article) {
      if (typeof article.scrollTo === "function") {
        article.scrollTo({ top: 0, behavior: "auto" });
      } else {
        article.scrollTop = 0;
      }
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const markdownComponents = useMemo(() => {
    const headingsMap = headingComponents(headings);
    return {
      ...headingsMap,
      a: ({ href, children, node: _node, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) => {
        const linkedDoc = href ? findProjectDocByHref(href) : undefined;
        if (linkedDoc) {
          return (
            <a
              {...props}
              href={href}
              className="docs-internal-link"
              onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                event.preventDefault();
                selectDocument(linkedDoc.id);
              }}
            >
              {children}
            </a>
          );
        }
        const hash = href?.split("#")[1];
        if (href?.startsWith("#") && hash) {
          return (
            <a
              {...props}
              href={href}
              className="docs-internal-link"
              onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                event.preventDefault();
                document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {children}
            </a>
          );
        }
        const safeHref = safeExternalUrl(href);
        if (!safeHref) return <span>{children}</span>;
        return (
          <a
            {...props}
            href={safeHref}
            rel="noreferrer"
            target="_blank"
            onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              void window.desktopApi?.shell.openExternal(safeHref);
            }}
          >
            {children}
          </a>
        );
      },
      img: ({ alt, title }: ImgHTMLAttributes<HTMLImageElement> & ExtraProps) => (
        <span className="docs-markdown-image" title={title ?? undefined}>
          图片：{alt || "未命名图片"}
        </span>
      ),
      table: ({ children }: TableHTMLAttributes<HTMLTableElement> & ExtraProps) => (
        <div className="docs-markdown-table-scroll">
          <table>{children}</table>
        </div>
      ),
      pre: ({ children }: { children?: ReactNode }) => (
        <pre className="docs-code-block">{children}</pre>
      ),
    };
  }, [headings, selectedDoc.id]);

  return (
    <main className="docs-page" aria-label="项目文档中心">
      <aside className="docs-sidebar" aria-label="文档导航">
        <div className="docs-sidebar-intro">
          <span className="docs-sidebar-mark" aria-hidden="true">
            <BookOpen size={18} />
          </span>
          <div>
            <span className="docs-eyebrow">PROJECT KNOWLEDGE</span>
            <h1>文档中心</h1>
            <p>把产品、体验和代码放在同一张地图上。</p>
          </div>
        </div>
        <label className="docs-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文档、关键词…"
            aria-label="搜索文档"
          />
          <kbd>⌘F</kbd>
        </label>
        <div className="docs-sidebar-summary">
          <span>{filteredDocs.length} 份文档</span>
          <span>更新于 {new Date("2026-08-30T00:00:00Z").toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span>
        </div>
        <nav className="docs-catalog" aria-label="全部文档">
          {groupedDocs.map(({ category, docs }) => {
            const meta = docsCategoryMeta[category];
            return (
              <section className="docs-catalog-group" key={category}>
                <div className="docs-catalog-group-heading">
                  <span>{meta.label}</span>
                  <small>{docs.length}</small>
                </div>
                {docs.map((doc) => (
                  <DocumentCatalogItem
                    key={doc.id}
                    doc={doc}
                    active={doc.id === selectedDoc.id}
                    onSelect={selectDocument}
                  />
                ))}
              </section>
            );
          })}
          {filteredDocs.length === 0 && (
            <div className="docs-empty-search">
              <Search size={17} />
              <strong>没有匹配的文档</strong>
              <span>换个关键词试试，例如“飞书”或“动画”。</span>
            </div>
          )}
        </nav>
      </aside>

      <article className="docs-article" ref={articleRef}>
        <header className="docs-article-header">
          <div className="docs-breadcrumbs">
            <span>文档中心</span>
            <ChevronRight size={14} aria-hidden="true" />
            <span>{docsCategoryMeta[selectedDoc.category].label}</span>
          </div>
          <div className="docs-article-meta-line">
            <span className="docs-status-badge">{selectedDoc.status}</span>
            <span className="docs-updated">
              <CalendarDays size={13} aria-hidden="true" />
              更新于 {selectedDoc.updatedAt}
            </span>
          </div>
          <h2>{selectedDoc.title}</h2>
          <p>{selectedDoc.summary}</p>
          <div className="docs-source-row">
            <code>docs/{selectedDoc.file}</code>
            <span>源文件是唯一事实来源</span>
          </div>
        </header>

        <div className="docs-reading-grid">
          <div className="docs-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={markdownComponents}
            >
              {selectedDoc.content}
            </ReactMarkdown>
          </div>
          <aside className="docs-toc" aria-label="本文目录">
            <div className="docs-toc-heading">本文目录</div>
            {headings.length === 0 ? (
              <span className="docs-toc-empty">暂无小节</span>
            ) : (
              <nav aria-label="本文目录">
                {headings.slice(0, 18).map((heading) => (
                  <a
                    href={`#${heading.id}`}
                    key={heading.id}
                    className={`docs-toc-link level-${Math.min(heading.level, 3)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById(heading.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    {heading.text}
                  </a>
                ))}
                {headings.length > 18 && <span className="docs-toc-more">还有 {headings.length - 18} 个小节</span>}
              </nav>
            )}
          </aside>
        </div>

        <footer className="docs-pagination">
          <button
            type="button"
            className="docs-pagination-button"
            disabled={!previousDoc}
            onClick={() => previousDoc && selectDocument(previousDoc.id)}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            <span>
              <small>上一篇</small>
              <strong>{previousDoc?.title ?? "已经是第一篇"}</strong>
            </span>
          </button>
          <button
            type="button"
            className="docs-pagination-button is-next"
            disabled={!nextDoc}
            onClick={() => nextDoc && selectDocument(nextDoc.id)}
          >
            <span>
              <small>下一篇</small>
              <strong>{nextDoc?.title ?? "已经是最后一篇"}</strong>
            </span>
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </footer>
      </article>
    </main>
  );
}
