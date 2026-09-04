import { Keyboard, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogFocus } from "./dialog-focus";

interface ShortcutItem {
  id: string;
  label: string;
  description: string;
  shortcut: string;
  keywords?: readonly string[];
}

interface ShortcutGroup {
  id: string;
  label: string;
  items: readonly ShortcutItem[];
}

interface KeyboardShortcutsSheetProps {
  onClose: () => void;
}

const normalize = (value: string): string => value.trim().toLocaleLowerCase();

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/u.test(`${navigator.platform} ${navigator.userAgent}`);
}

function buildShortcutGroups(isMac: boolean): readonly ShortcutGroup[] {
  const modifier = isMac ? "⌘" : "Ctrl";
  const backShortcut = isMac ? "⌘ [" : "Alt ←";
  return [
    {
      id: "global",
      label: "全局操作",
      items: [
        {
          id: "show-help",
          label: "打开快捷键说明",
          description: "随时查看并搜索这份说明",
          shortcut: "?",
          keywords: ["help", "shortcut", "快捷键", "帮助"],
        },
        {
          id: "new-task",
          label: "新建任务",
          description: "打开完整任务编辑器",
          shortcut: `${modifier} N`,
          keywords: ["new", "create", "任务", "新增"],
        },
        {
          id: "search-or-command",
          label: "聚焦任务搜索 / 打开快速命令",
          description: "任务列表聚焦搜索框，其他页面打开快速命令",
          shortcut: `${modifier} K`,
          keywords: ["search", "command", "搜索", "命令"],
        },
        {
          id: "global-search",
          label: "全局查找",
          description: "跨任务、项目、清单和本机会话查找",
          shortcut: `${modifier} ⇧ F`,
          keywords: ["find", "global", "查找", "搜索"],
        },
        {
          id: "toggle-sidebar",
          label: "隐藏 / 显示侧栏",
          description: "收起主导航，为当前工作区留出更多空间",
          shortcut: `${modifier} /`,
          keywords: ["sidebar", "focus", "navigation", "侧栏", "专注", "导航"],
        },
        {
          id: "undo-task-operation",
          label: "撤销最近任务变更",
          description: "恢复最近一次本地任务操作；输入框和弹窗内保留原生撤销",
          shortcut: `${modifier} Z`,
          keywords: ["undo", "rollback", "撤销", "恢复", "回滚"],
        },
        {
          id: "redo-task-operation",
          label: "重做最近任务变更",
          description: "重新应用刚才撤销的本地任务操作；新建变更后重做会失效",
          shortcut: `${modifier} ⇧ Z`,
          keywords: ["redo", "reapply", "重做", "再次应用", "回滚"],
        },
        {
          id: "quick-capture",
          label: "快速捕获",
          description: "从任意工作流快速记录一项任务",
          shortcut: `${modifier} ⇧ Space`,
          keywords: ["capture", "inbox", "捕获", "暂存"],
        },
        {
          id: "go-back",
          label: "返回上一页",
          description: "回到上一个工作区",
          shortcut: backShortcut,
          keywords: ["back", "navigation", "返回", "导航"],
        },
      ],
    },
    {
      id: "task-list",
      label: "任务列表",
      items: [
        {
          id: "move-task-focus",
          label: "浏览任务",
          description: "移动当前任务焦点，并自动保持可见",
          shortcut: "↑ ↓ / J K",
          keywords: ["move", "focus", "上下", "浏览"],
        },
        {
          id: "insert-task-after-selection",
          label: "在当前任务后新增",
          description: "在 Today 的“计划今天”任务后打开内联快速添加",
          shortcut: "Space",
          keywords: ["insert", "below", "today", "新增", "当前任务后", "空格"],
        },
        {
          id: "open-task",
          label: "打开任务详情",
          description: "在右侧检查器查看或编辑当前任务",
          shortcut: "Enter",
          keywords: ["open", "detail", "详情", "打开"],
        },
        {
          id: "complete-task",
          label: "完成 / 重新打开任务",
          description: "在待办与已完成之间切换当前任务",
          shortcut: "E",
          keywords: ["complete", "reopen", "完成", "重新打开"],
        },
        {
          id: "select-task",
          label: "选择任务",
          description: "进入批量选择，并保留当前任务焦点",
          shortcut: "X",
          keywords: ["select", "bulk", "选择", "批量"],
        },
        {
          id: "select-range",
          label: "选择连续范围",
          description: "先点击起点，再按住 Shift 点击终点",
          shortcut: "Shift + 点击",
          keywords: ["range", "shift", "范围", "连续"],
        },
        {
          id: "select-non-contiguous",
          label: "切换不连续选择",
          description: "按住 ⌘/Ctrl 点选任务，可保留已经选中的任务",
          shortcut: `${modifier} + 点击`,
          keywords: ["multiple", "command", "control", "不连续", "选择"],
        },
        {
          id: "focus-bulk-toolbar",
          label: "聚焦批量工具栏",
          description: "进入批量操作按钮，随后可用 Tab 浏览",
          shortcut: ",",
          keywords: ["toolbar", "bulk", "工具栏", "批量"],
        },
        {
          id: "dismiss-layer",
          label: "关闭当前层",
          description: "依次关闭编辑器、批量层、筛选或任务详情",
          shortcut: "Esc",
          keywords: ["close", "dismiss", "关闭", "退出"],
        },
      ],
    },
  ];
}

export function KeyboardShortcutsSheet({ onClose }: KeyboardShortcutsSheetProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const groups = useMemo(
    () => buildShortcutGroups(isMacPlatform()),
    [],
  );
  const filteredGroups = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          [item.label, item.description, item.shortcut, ...(item.keywords ?? [])]
            .join(" ")
            .toLocaleLowerCase()
            .includes(needle),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, query]);
  const itemCount = filteredGroups.reduce(
    (total, group) => total + group.items.length,
    0,
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useDialogFocus(dialogRef, inputRef);

  return (
    <div
      className="keyboard-shortcuts-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="keyboard-shortcuts-sheet"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onClose();
        }}
      >
        <header className="keyboard-shortcuts-header">
          <div className="feature-icon" aria-hidden="true">
            <Keyboard size={21} />
          </div>
          <div>
            <h2 id="keyboard-shortcuts-title">键盘快捷键</h2>
            <p>用更少的鼠标往返完成任务整理，按 ? 可再次打开。</p>
          </div>
          <button
            type="button"
            className="icon-button command-palette-close"
            onClick={onClose}
            aria-label="关闭快捷键说明"
            title="关闭（Esc）"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="keyboard-shortcuts-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索快捷键或功能…"
            aria-label="搜索快捷键"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="keyboard-shortcuts-summary" aria-live="polite">
          {itemCount} 个快捷键
        </div>
        <div className="keyboard-shortcuts-groups">
          {filteredGroups.length > 0 ? (
            filteredGroups.map((group) => (
              <section className="keyboard-shortcuts-group" key={group.id}>
                <h3>{group.label}</h3>
                <div className="keyboard-shortcuts-list" role="list">
                  {group.items.map((item) => (
                    <div className="keyboard-shortcuts-row" key={item.id} role="listitem">
                      <div>
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </div>
                      <kbd>{item.shortcut}</kbd>
                    </div>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <div className="keyboard-shortcuts-empty">
              <Search size={18} aria-hidden="true" />
              <span>没有匹配的快捷键</span>
            </div>
          )}
        </div>
        <footer className="keyboard-shortcuts-footer">
          <span>提示：在任务列表中先聚焦任务，再使用 E、X、Space 或 Shift 点击。</span>
          <span>Esc 关闭</span>
        </footer>
      </section>
    </div>
  );
}
