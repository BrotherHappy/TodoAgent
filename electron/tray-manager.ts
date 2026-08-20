import { Menu, Tray, nativeImage } from 'electron';
import type { TrayTodaySummary } from './tray-task-preview';

export interface TrayStatus {
  sync: 'local' | 'synced' | 'pending' | 'offline' | 'error' | 'conflict';
  agent: 'disabled' | 'ready' | 'thinking' | 'awaiting-approval' | 'running' | 'stopped' | 'error';
  fullAccessExpiresAt?: string;
  floatingVisible: boolean;
  meetingMode: boolean;
  launchAtLogin: boolean;
}

interface TrayManagerOptions {
  iconPath: string;
  getStatus: () => TrayStatus;
  showMain: (route?: string) => void;
  showQuick: () => void;
  toggleFloating: (visible: boolean) => void;
  toggleBossMode: (enabled: boolean) => void;
  setLaunchAtLogin: (enabled: boolean) => void;
  stopAgent: () => void;
  getTodaySummary?: () => Promise<TrayTodaySummary>;
  quit: () => void;
}

function statusText(status: TrayStatus): string {
  if (status.fullAccessExpiresAt) {
    const remaining = Math.max(0, new Date(status.fullAccessExpiresAt).getTime() - Date.now());
    return `全权限 · 剩余 ${Math.ceil(remaining / 60_000)} 分钟`;
  }
  if (status.agent === 'awaiting-approval') return 'Agent · 等待确认';
  if (status.agent === 'running' || status.agent === 'thinking') return 'Agent · 正在运行';
  if (status.sync === 'conflict') return '飞书 · 有同步冲突';
  if (status.sync === 'offline') return '离线 · 操作将排队';
  if (status.sync === 'pending') return '飞书 · 等待同步';
  if (status.sync === 'error') return '飞书 · 需要处理同步问题';
  if (status.sync === 'synced') return '已同步';
  return '本地模式';
}

export class TrayManager {
  readonly #options: TrayManagerOptions;
  #tray?: Tray;
  #refreshToken = 0;

  constructor(options: TrayManagerOptions) {
    this.#options = options;
  }

  create(): Tray {
    if (this.#tray) return this.#tray;
    const icon = nativeImage.createFromPath(this.#options.iconPath);
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    this.#tray = new Tray(icon.resize({ width: 18, height: 18 }));
    this.#tray.setToolTip('Todo Agent');
    this.#tray.on('click', () => this.#options.showMain());
    this.refresh();
    return this.#tray;
  }

  refresh(): void {
    if (!this.#tray) return;
    const token = ++this.#refreshToken;
    const status = this.#options.getStatus();
    void this.#refreshMenu(token, status);
  }

  async #refreshMenu(
    token: number,
    status: TrayStatus,
  ): Promise<void> {
    let today: TrayTodaySummary = { tasks: [], totalOpen: 0 };
    try {
      today = (await this.#options.getTodaySummary?.()) ?? today;
    } catch {
      // A stale/temporarily unavailable task read must never break the tray.
    }
    if (token !== this.#refreshToken || !this.#tray) return;
    this.#tray.setContextMenu(Menu.buildFromTemplate([
      { label: statusText(status), enabled: false },
      { type: 'separator' },
      {
        label: today.totalOpen > 0
          ? `今日待办 · ${today.totalOpen} 项`
          : '今日待办 · 暂无未完成任务',
        enabled: false,
      },
      ...(today.tasks.length
        ? today.tasks.map((task, index) => ({
            label: `${index + 1}. ${task.title}`,
            click: () => this.#options.showMain('today'),
          }))
        : [{ label: '打开 Today 查看全部任务', click: () => this.#options.showMain('today') }]),
      ...(today.totalOpen > today.tasks.length
        ? [{ label: '打开 Today 查看其余任务…', click: () => this.#options.showMain('today') }]
        : []),
      { type: 'separator' },
      { label: '快速录入', accelerator: 'CommandOrControl+Shift+Space', click: this.#options.showQuick },
      { label: '打开 Today', click: () => this.#options.showMain('today') },
      { label: '打开 Agent', click: () => this.#options.showMain('agent') },
      { type: 'separator' },
      {
        label: '显示 Todo Pet',
        type: 'checkbox',
        checked: status.floatingVisible,
        click: (item) => this.#options.toggleFloating(item.checked),
      },
      {
        label: status.meetingMode ? '退出 Boss Mode' : '进入 Boss Mode',
        type: 'checkbox',
        checked: status.meetingMode,
        click: (item) => this.#options.toggleBossMode(item.checked),
      },
      {
        label: '开机启动',
        type: 'checkbox',
        checked: status.launchAtLogin,
        click: (item) => this.#options.setLaunchAtLogin(item.checked),
      },
      { label: '设置…', click: () => this.#options.showMain('settings') },
      { type: 'separator' },
      {
        label: '停止 Agent',
        enabled: status.agent !== 'disabled' && status.agent !== 'stopped',
        click: this.#options.stopAgent,
      },
      { label: '退出 Todo Agent', click: this.#options.quit },
    ]));
  }

  destroy(): void {
    this.#refreshToken += 1;
    this.#tray?.destroy();
    this.#tray = undefined;
  }
}
