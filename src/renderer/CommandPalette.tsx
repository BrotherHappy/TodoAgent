import {
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  Command as CommandIcon,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface CommandPaletteAction {
  id: string;
  label: string;
  description: string;
  keywords?: string[];
  shortcut?: string;
  icon?: ReactNode;
  run: () => void;
}

interface CommandPaletteProps {
  actions: readonly CommandPaletteAction[];
  onClose: () => void;
}

const normalize = (value: string): string => value.trim().toLocaleLowerCase();

export function CommandPalette({ actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredActions = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return [...actions];
    return actions.filter((action) =>
      [action.label, action.description, ...(action.keywords ?? [])]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [actions, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex((current) =>
      filteredActions.length === 0
        ? 0
        : Math.min(current, filteredActions.length - 1),
    );
  }, [filteredActions.length]);

  const runActive = () => {
    const action = filteredActions[activeIndex];
    if (!action) return;
    onClose();
    action.run();
  };

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
      >
        <div className="command-palette-heading">
          <div className="command-palette-mark" aria-hidden="true">
            <CommandIcon size={18} />
          </div>
          <div>
            <strong id="command-palette-title">快速命令</strong>
            <span>跳转、捕获、规划和打开工具</span>
          </div>
          <button
            type="button"
            className="icon-button command-palette-close"
            onClick={onClose}
            aria-label="关闭快速命令"
            title="关闭（Esc）"
          >
            <X size={16} />
          </button>
        </div>
        <label className="command-palette-search">
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
                  filteredActions.length === 0
                    ? 0
                    : (current + 1) % filteredActions.length,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) =>
                  filteredActions.length === 0
                    ? 0
                    : (current - 1 + filteredActions.length) % filteredActions.length,
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                runActive();
              }
            }}
            placeholder="输入命令或搜索功能…"
            aria-label="搜索快速命令"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-options"
            aria-activedescendant={
              filteredActions[activeIndex]
                ? `command-palette-option-${activeIndex}`
                : undefined
            }
          />
          <kbd>Esc</kbd>
        </label>
        <div
          id="command-palette-options"
          className="command-palette-options"
          role="listbox"
          aria-label="可用命令"
        >
          {filteredActions.length > 0 ? (
            filteredActions.map((action, index) => (
              <button
                key={action.id}
                id={`command-palette-option-${index}`}
                type="button"
                className={`command-palette-option ${index === activeIndex ? "is-active" : ""}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={runActive}
              >
                <span className="command-palette-option-icon" aria-hidden="true">
                  {action.icon ?? <CommandIcon size={16} />}
                </span>
                <span className="command-palette-option-copy">
                  <strong>{action.label}</strong>
                  <small>{action.description}</small>
                </span>
                {action.shortcut ? (
                  <kbd>{action.shortcut}</kbd>
                ) : index === activeIndex ? (
                  <span className="command-palette-enter" aria-hidden="true">
                    <CornerDownLeft size={14} />
                  </span>
                ) : null}
              </button>
            ))
          ) : (
            <div className="command-palette-empty">
              <Search size={18} aria-hidden="true" />
              <span>没有匹配的命令</span>
            </div>
          )}
        </div>
        <footer className="command-palette-footer">
          <span><ArrowUp size={13} /><ArrowDown size={13} /> 选择</span>
          <span><CornerDownLeft size={13} /> 执行</span>
          <span>Esc 关闭</span>
        </footer>
      </section>
    </div>
  );
}
