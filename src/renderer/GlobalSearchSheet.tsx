import {
  ArrowDown,
  ArrowUp,
  ClipboardCheck,
  Command,
  CornerDownLeft,
  FolderKanban,
  ListChecks,
  MessageCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  searchGlobalWorkspace,
  type GlobalSearchConversation,
  type GlobalSearchInput,
  type GlobalSearchResult,
  type GlobalSearchResultKind,
} from "../shared/global-search";
import type { Task, TaskList, TaskProject } from "../shared/models";
import {
  clearGlobalSearchHistory,
  readGlobalSearchHistory,
  rememberGlobalSearch,
} from "./global-search-history";

type SearchFilter = "all" | GlobalSearchResultKind;

interface GlobalSearchSheetProps {
  tasks: readonly Task[];
  projects: readonly TaskProject[];
  lists: readonly TaskList[];
  conversations: readonly GlobalSearchConversation[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onClose: () => void;
  onSelect: (result: GlobalSearchResult) => void;
}

const filters: Array<{ id: SearchFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "task", label: "任务" },
  { id: "project", label: "项目" },
  { id: "list", label: "清单" },
  { id: "conversation", label: "会话" },
];

const kindLabel: Record<GlobalSearchResultKind, string> = {
  task: "任务",
  project: "项目",
  list: "清单",
  conversation: "Agent 会话",
};

const resultIcon = (kind: GlobalSearchResultKind) => {
  if (kind === "project") return <FolderKanban size={17} />;
  if (kind === "list") return <ListChecks size={17} />;
  if (kind === "conversation") return <MessageCircle size={17} />;
  return <ClipboardCheck size={17} />;
};

export function GlobalSearchSheet({
  tasks,
  projects,
  lists,
  conversations,
  loading = false,
  error,
  onRetry,
  onClose,
  onSelect,
}: GlobalSearchSheetProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentQueries, setRecentQueries] = useState<string[]>(() => readGlobalSearchHistory());
  const inputRef = useRef<HTMLInputElement>(null);

  const searchInput: GlobalSearchInput = useMemo(
    () => ({ tasks, projects, lists, conversations, query, limit: 36 }),
    [conversations, lists, projects, query, tasks],
  );
  const allResults = useMemo(() => searchGlobalWorkspace(searchInput), [searchInput]);
  const results = useMemo(
    () => (filter === "all" ? allResults : allResults.filter((result) => result.kind === filter)),
    [allResults, filter],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex((current) =>
      results.length === 0 ? 0 : Math.min(current, results.length - 1),
    );
  }, [results.length]);

  const selectActive = () => {
    const result = results[activeIndex];
    if (result) {
      setRecentQueries(rememberGlobalSearch(query));
      onSelect(result);
    }
  };

  const selectResult = (result: GlobalSearchResult): void => {
    setRecentQueries(rememberGlobalSearch(query));
    onSelect(result);
  };

  return (
    <div
      className="global-search-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="global-search-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-search-title"
        aria-busy={loading}
      >
        <header className="global-search-heading">
          <div className="global-search-mark" aria-hidden="true">
            <Search size={18} />
          </div>
          <div>
            <strong id="global-search-title">全局查找</strong>
            <span>任务、项目、清单和本机会话，一次找到</span>
          </div>
          <button
            type="button"
            className="icon-button global-search-close"
            onClick={onClose}
            aria-label="关闭全局查找"
            title="关闭（Esc）"
          >
            <X size={16} />
          </button>
        </header>
        <label className="global-search-input">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) =>
                  results.length === 0 ? 0 : (current + 1) % results.length,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) =>
                  results.length === 0
                    ? 0
                    : (current - 1 + results.length) % results.length,
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                selectActive();
              }
            }}
            placeholder="搜索任务标题、备注、项目、会话内容…"
            aria-label="全局搜索"
            role="combobox"
            aria-expanded="true"
            aria-controls="global-search-results"
            aria-activedescendant={
              results[activeIndex] ? `global-search-result-${activeIndex}` : undefined
            }
          />
          <kbd>Esc</kbd>
        </label>
        <nav className="global-search-filters" aria-label="搜索范围">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`global-search-filter ${filter === item.id ? "is-active" : ""}`}
              aria-pressed={filter === item.id}
              onClick={() => {
                setFilter(item.id);
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
            >
              {item.label}
              {item.id === "all" && query.trim() ? <small>{allResults.length}</small> : null}
            </button>
          ))}
        </nav>
        <div
          id="global-search-results"
          className="global-search-results"
          role="listbox"
          aria-label="搜索结果"
        >
          {loading ? (
            <div className="global-search-state" aria-live="polite">
              <RefreshCw size={18} className="spin" aria-hidden="true" />
              <span>正在读取本地工作区…</span>
            </div>
          ) : error ? (
            <div className="global-search-state global-search-state-error" role="alert">
              <span>{error}</span>
              {onRetry ? (
                <button type="button" className="soft-button" onClick={onRetry}>
                  <RefreshCw size={14} /> 重试
                </button>
              ) : null}
            </div>
          ) : !query.trim() ? (
            <div className="global-search-start">
              {recentQueries.length > 0 ? (
                <div className="global-search-recent">
                  <div className="global-search-recent-heading">
                    <span>最近搜索</span>
                    <button
                      type="button"
                      className="global-search-clear-recent"
                      onClick={() => {
                        clearGlobalSearchHistory();
                        setRecentQueries([]);
                        inputRef.current?.focus();
                      }}
                    >
                      清空
                    </button>
                  </div>
                  <div className="global-search-recent-list">
                    {recentQueries.map((recent) => (
                      <button
                        key={recent}
                        type="button"
                        className="global-search-recent-chip"
                        onClick={() => {
                          setQuery(recent);
                          inputRef.current?.focus();
                        }}
                      >
                        <Search size={13} aria-hidden="true" />
                        <span>{recent}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="global-search-state">
                  <Command size={19} aria-hidden="true" />
                  <span>输入关键词，搜索所有本地内容</span>
                </div>
              )}
            </div>
          ) : results.length === 0 ? (
            <div className="global-search-state">
              <Search size={19} aria-hidden="true" />
              <span>没有找到匹配内容</span>
            </div>
          ) : (
            results.map((result, index) => (
              <button
                key={`${result.kind}:${result.id}`}
                id={`global-search-result-${index}`}
                type="button"
                className={`global-search-result ${index === activeIndex ? "is-active" : ""}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectResult(result)}
              >
                <span className={`global-search-result-icon is-${result.kind}`} aria-hidden="true">
                  {resultIcon(result.kind)}
                </span>
                <span className="global-search-result-copy">
                  <strong>{result.title}</strong>
                  <small>{result.subtitle}</small>
                  {result.snippet && result.snippet !== result.title ? (
                    <em>{result.snippet}</em>
                  ) : null}
                </span>
                <span className="global-search-result-kind">
                  {kindLabel[result.kind]}
                  {index === activeIndex ? <CornerDownLeft size={14} aria-hidden="true" /> : null}
                </span>
              </button>
            ))
          )}
        </div>
        <footer className="global-search-footer">
          <span><ArrowUp size={13} /><ArrowDown size={13} /> 选择</span>
          <span><CornerDownLeft size={13} /> 打开</span>
          <span>⌘ ⇧ F 随时打开</span>
          <span>最近搜索仅保存在本机</span>
        </footer>
      </section>
    </div>
  );
}
