import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { listRecentCommits } from './add';
import { DEFAULT_SPACE, MemoryStore, SortMode, spaceLabel } from './store';
import { isExpired } from './clean';
import { MEMORY_TAGS, MemoryEntry, MemoryVersion, TAG_LABEL } from './types';
import { AI_SETTINGS_MSGS, AiSettingsController } from './ai/settings-panel';
import { buildFullContext, generateInject } from './inject';

type PanelTab = 'memory' | 'compose' | 'git' | 'profile' | 'io' | 'ai';

const PANEL_TABS: PanelTab[] = ['memory', 'compose', 'git', 'profile', 'io', 'ai'];

function asTab(v: unknown): PanelTab {
  const tab = String(v || '');
  return (PANEL_TABS as string[]).includes(tab) ? (tab as PanelTab) : 'memory';
}

/** Cursor 的活动栏 webview 经常是一块空白，编辑区面板才能看得见。 */
function isCursorHost(): boolean {
  return /cursor/i.test(vscode.env.appName || '');
}

interface PanelState {
  query: string;
  tag: string;
  space: string;
  sort: SortMode;
  archived: boolean;
}

const DEFAULT_STATE: PanelState = {
  query: '',
  tag: '',
  space: '',
  sort: 'relevance',
  archived: false,
};

const SORT_ITEMS: Array<{ value: SortMode; label: string }> = [
  { value: 'relevance', label: '相关度' },
  { value: 'recent', label: '最近更新' },
  { value: 'importance', label: '重要性' },
  { value: 'uses', label: '命中次数' },
];

/** 虚拟列表分页：每页推给前端的行数（滚动近底部时继续拉取） */
const PAGE_SIZE = 200;
/** 首屏 HTML 只带一小页，避免安装后的侧边栏视图被大文档卡住 */
const FIRST_PAINT = 40;
/** 打开面板后等侧栏视图解析的时长，超时就在编辑区打开 */
const VIEW_RESOLVE_MS = 800;

/** 面板按钮白名单。只处理这些动作，不把任意字符串交给命令系统。 */
const ACTION_COMMANDS: Record<string, string> = {
  add: 'compose',
  git: 'git',
  inject: 'inject',
  copyAll: 'copy',
  search: 'search',
  export: 'io',
  import: 'io',
  youmengyu: 'io',
  refresh: 'refresh',
  aiOrganize: 'organize',
};

const ICONS: Record<string, string> = {
  plus: '<path d="M8 3.4v9.2M3.4 8h9.2"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.3 10.3L14 14"/>',
  pin: '<path d="M4.8 2.6h6.4v10.8L8 10.7l-3.2 2.7z"/>',
  edit: '<path d="M11.4 2.3l2.3 2.3L5.5 12.8 2.3 13.7l.9-3.2z"/>',
  trash: '<path d="M2.8 4.4h10.4M6.2 4.4V2.7h3.6v1.7M4.5 4.4l.7 9h5.6l.7-9"/>',
  archive: '<path d="M2.4 5.6h11.2v7.8H2.4zM2 2.8h12v2.6H2zM6.4 8.6h3.2"/>',
  copy: '<rect x="5.6" y="2.6" width="7.8" height="7.8" rx="1.4"/><path d="M10.4 13.4H4.5A1.5 1.5 0 0 1 3 11.9V6"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  star: '<path d="M8 2.4l1.7 3.6 4 .5-2.9 2.7.7 4-3.5-2-3.5 2 .7-4L2.3 6.5l4-.5z"/>',
  layers: '<path d="M8 2.6l5.8 2.9L8 8.4 2.2 5.5zM2.2 8.5L8 11.4l5.8-2.9"/>',
  clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.9V8l2.3 1.4"/>',
  refresh: '<path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.9M13.2 2.8v3.1H10"/>',
  sparkle: '<path d="M8 1.2l1 3.8L13 6.2 9 7.4 8 11.2 7 7.4 3 6.2l4-1.2zM12.2 9.4l.4 1.5 1.5.4-1.5.4-.4 1.5-.4-1.5-1.5-.4 1.5-.4z"/>',
  book: '<path d="M2.6 3.2h4.2a1.6 1.6 0 0 1 1.6 1.6v8.4a1.4 1.4 0 0 0-1.4-1.4H2.6zM13.4 3.2H9.2a1.6 1.6 0 0 0-1.6 1.6v8.4a1.4 1.4 0 0 1 1.4-1.4h4.4z"/>',
  broom: '<path d="M12.2 2.4l1.4 1.4-4.2 4.2M9.9 5.1l1 1-5.6 5.6c-1 1-2.6 1.6-4 1.6 0-1.4.6-3 1.6-4z"/>',
  check: '<path d="M3 8.6l3.2 3.2L13 5"/>',
  db: '<ellipse cx="8" cy="3.6" rx="5.4" ry="1.8"/><path d="M2.6 3.6v8.8c0 1 2.4 1.8 5.4 1.8s5.4-.8 5.4-1.8V3.6M2.6 8c0 1 2.4 1.8 5.4 1.8s5.4-.8 5.4-1.8"/>',
};

function icon(name: string, cls = ''): string {
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 30 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return iso.slice(0, 10);
}

function pips(importance: number): string {
  let html = '';
  for (let i = 1; i <= 5; i += 1) html += `<i class="pip${i <= importance ? ' on' : ''}"></i>`;
  return html;
}

function tagsHtml(entry: MemoryEntry, limit = 3): string {
  const tags = entry.tags?.length ? entry.tags : ['other'];
  return tags
    .slice(0, limit)
    .map((t) => `<span class="tag">${esc(TAG_LABEL[t] || t)}</span>`)
    .join('');
}

function sanitizeState(raw: unknown): PanelState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sort = SORT_ITEMS.some((i) => i.value === s.sort) ? (s.sort as SortMode) : 'relevance';
  const tag =
    typeof s.tag === 'string' && (MEMORY_TAGS as readonly string[]).includes(s.tag) ? s.tag : '';
  return {
    query: typeof s.query === 'string' ? s.query : '',
    tag,
    space: typeof s.space === 'string' ? s.space : '',
    sort,
    archived: Boolean(s.archived),
  };
}

/** 推给前端虚拟列表的轻量行数据（短键名，百万条目分页下也省内存） */
interface RowData {
  id: string;
  t: string;
  c: string;
  g: string[];
  p: number;
  pin: boolean;
  ar: boolean;
  ex: boolean;
  s: string;
  u: number;
  d: string;
}

function toRow(e: MemoryEntry): RowData {
  const tags = e.tags?.length ? e.tags : ['other'];
  return {
    id: e.id,
    t: e.title,
    c: e.content.length > 200 ? `${e.content.slice(0, 200)}…` : e.content,
    g: tags.slice(0, 3).map((t) => TAG_LABEL[t] || t),
    p: e.importance,
    pin: Boolean(e.pinned),
    ar: Boolean(e.archived),
    ex: isExpired(e),
    s: spaceLabel(e.space),
    u: e.uses,
    d: timeAgo(e.updatedAt),
  };
}

export class MemoryPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'aimemory.panel';

  private readonly context: vscode.ExtensionContext;
  private store: MemoryStore | undefined;
  private view: vscode.WebviewView | undefined;
  /** Cursor 里侧栏 webview 不绘制时，同一份页面开在编辑区 */
  private editor: vscode.WebviewPanel | undefined;
  private painted = new WeakSet<vscode.Webview>();
  private state: PanelState = { ...DEFAULT_STATE };
  /** 当前已渲染的仓库根（用于切换工作区时重绘） */
  private renderedRoot: string | undefined;
  /** 抽屉里正在展示的条目（用于原地刷新） */
  private openId: string | undefined;
  /** 视图还没就绪时先记下来，等 webview 首帧请求再推送 */
  private pendingDetail: string | undefined;
  /** 当前筛选结果的全量 id（虚拟列表分页 + 「全选结果」批量删除的数据源） */
  private resultIds: string[] = [];
  /** 每次推送结果 +1。过期的 loadMore 回包 epoch 对不上，前端丢弃，避免拼进新列表 */
  private viewEpoch = 0;
  /** 当前标签页。全部页面都在这个侧边栏视图里切换 */
  private tab: PanelTab = 'memory';
  /** AI 服务设置控制器（extension.ts 装配后经 attachAi 注入） */
  private ai?: AiSettingsController;
  /** 整理与数字人导入由 extension 装配，避免面板去弹系统窗口 */
  private extra: {
    organize?: () => Promise<string>;
    youmengyu?: (root: string) => Promise<string>;
  } = {};
  private composePreset: { content: string; source: string } = { content: '', source: '' };
  /** 同一筛选下的结果缓存。loadMore 不再把全库重扫一遍 */
  private filteredEntries: MemoryEntry[] | null = null;
  private confirms = new Map<string, (ok: boolean) => void>();
  private pendingNote: { text: string; kind?: 'warn' } | undefined;
  private pendingFocus = false;

  constructor(context: vscode.ExtensionContext, store: MemoryStore) {
    this.context = context;
    this.store = store;
  }

  /** 注入 AI 服务设置控制器（引擎在面板之后创建，故后置装配） */
  attachAi(ai: AiSettingsController): void {
    this.ai = ai;
    const primary = this.primaryWebview();
    if (primary) ai.setView(primary);
  }

  bindExtra(extra: { organize?: () => Promise<string>; youmengyu?: (root: string) => Promise<string> }): void {
    this.extra = extra;
  }

  /** 打开「AI 服务设置」标签页 */
  showAiSettings(): void {
    this.openTab('ai');
  }

  /** 切到插件内的某个标签。视图还没创建时记下 tab，首帧 HTML 直接落在这一页 */
  openTab(tab: PanelTab, preset?: { content?: string; source?: string }): void {
    this.tab = tab;
    if (preset) this.composePreset = { content: preset.content || '', source: preset.source || '' };
    void this.reveal();
    if (!this.alive()) return;
    this.post({ type: 'tabState', tab });
    void this.afterTab(tab);
  }

  focusSearch(): void {
    this.pendingFocus = true;
    this.openTab('memory');
    this.flushFocus();
  }

  note(text: string, kind?: 'warn'): void {
    if (this.alive()) this.toast(text, kind);
    else {
      this.pendingNote = { text, kind };
      void this.reveal();
    }
  }

  openEditor(id: string): void {
    this.openTab('memory');
    this.postEditor(id);
  }

  async removeWithConfirm(id: string): Promise<void> {
    const entry = this.store?.entries.find((e) => e.id === id);
    if (!entry) return;
    this.openTab('memory');
    if (!(await this.askConfirm(`删除记忆「${entry.title}」？删除后不可恢复。`, '删除'))) return;
    this.store?.remove(id);
    this.toast('已删除');
    this.push();
  }

  async injectNow(): Promise<void> {
    const store = this.store;
    if (!store?.workspaceRoot) {
      this.note('请先打开一个工作区', 'warn');
      return;
    }
    await generateInject(store, { silent: true });
    this.note('已生成注入块');
  }

  async copyAll(): Promise<void> {
    const store = this.store;
    if (!store?.ready) {
      this.note('请先打开一个工作区', 'warn');
      return;
    }
    await vscode.env.clipboard.writeText(buildFullContext(store));
    this.note('已复制全部上下文');
  }

  /** 打开记忆面板。Cursor 同时在编辑区打开同一页面，侧栏画不出来时仍能使用。 */
  show(store: MemoryStore, entryId?: string): void {
    this.store = store;
    this.pendingDetail = entryId;
    if (entryId) this.tab = 'memory';
    void this.reveal();
    if (!store.workspaceRoot) {
      this.render();
      return;
    }
    if (this.alive() && entryId && this.tab === 'memory') {
      this.post({ type: 'tabState', tab: 'memory' });
    }
    if (this.alive() && this.renderedRoot === store.workspaceRoot) {
      this.push();
      if (this.pendingDetail) {
        const pending = this.pendingDetail;
        this.pendingDetail = undefined;
        this.postDetail(pending);
      }
    } else {
      this.render();
    }
  }

  /** 工作区绑定变化后，若当前是占位页则换成正式面板 */
  notifyStoreChanged(): void {
    const root = this.store?.workspaceRoot;
    if (this.alive() && root && this.renderedRoot !== root) this.render();
  }

  /** 记忆数据变化（新增 / 提炼 / 导入 / 外部命令）后刷新视图内容 */
  refresh(): void {
    if (this.alive()) this.push();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    this.ensureCursorEditor();
    const primary = this.primaryWebview();
    if (primary) this.ai?.setView(primary);
    view.onDidChangeVisibility(() => {
      if (!view.visible) return;
      this.painted.delete(view.webview);
      this.renderedRoot = undefined;
      this.render();
    });
    view.onDidDispose(() => {
      this.painted.delete(view.webview);
      this.view = undefined;
      this.openId = undefined;
      this.renderedRoot = undefined;
      this.filteredEntries = null;
      const next = this.primaryWebview();
      if (next) this.ai?.setView(next);
      else this.ai?.setView(undefined);
    });
    this.render();
    // Cursor 会丢掉 resolve 同一拍里设置的 html，下一拍再画一次。
    setTimeout(() => {
      this.painted.delete(view.webview);
      if (this.editor) this.painted.delete(this.editor.webview);
      this.renderedRoot = undefined;
      this.render();
    }, 0);
    void this.afterTab(this.tab);
    if (this.pendingNote) {
      const note = this.pendingNote;
      this.pendingNote = undefined;
      this.toast(note.text, note.kind);
    }
    this.flushFocus();
  }

  private flushFocus(): void {
    if (!this.pendingFocus || !this.alive()) return;
    this.pendingFocus = false;
    this.post({ type: 'focusSearch' });
  }

  private surfaces(): vscode.Webview[] {
    const list: vscode.Webview[] = [];
    if (this.view) list.push(this.view.webview);
    if (this.editor) list.push(this.editor.webview);
    return list;
  }

  private alive(): boolean {
    return Boolean(this.view || this.editor);
  }

  private primaryWebview(): vscode.Webview | undefined {
    return this.editor?.webview || this.view?.webview;
  }

  private post(message: unknown): void {
    for (const webview of this.surfaces()) void webview.postMessage(message);
  }

  /** Cursor 侧栏 webview 不绘制。点开插件时在编辑区放同一页面，方便看见。 */
  private ensureCursorEditor(): void {
    if (isCursorHost()) this.ensureEditor();
  }

  /** 在编辑区打开同一页面。侧栏画不出来的宿主或工作区都走这里。 */
  private ensureEditor(): void {
    if (this.editor) {
      this.editor.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'aimemory.editor',
      '记忆面板',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [this.context.extensionUri] }
    );
    this.editor = panel;
    panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    panel.onDidDispose(() => {
      this.painted.delete(panel.webview);
      if (this.editor === panel) this.editor = undefined;
      const primary = this.primaryWebview();
      if (primary) this.ai?.setView(primary);
    });
    const primary = this.primaryWebview();
    if (primary) this.ai?.setView(primary);
    this.renderedRoot = undefined;
  }

  /**
   * 把插件栏展开并切到记忆视图。
   * Cursor 不先 focus 主侧边栏：那一步会切回 Agent 栏，记忆页又变成空白。
   * 编辑区面板同时打开，侧栏画不出来时仍能使用。
   */
  private async reveal(): Promise<void> {
    this.ensureCursorEditor();
    if (!isCursorHost()) {
      try {
        await vscode.commands.executeCommand('workbench.action.focusSideBar');
      } catch {
        /* 宿主没有侧边栏命令时继续走容器命令 */
      }
    }
    try {
      await vscode.commands.executeCommand('workbench.view.extension.aimemory');
    } catch {
      /* 部分宿主没有这条容器命令 */
    }
    try {
      await vscode.commands.executeCommand(`${MemoryPanel.viewId}.focus`);
    } catch {
      /* 视图尚未注册完成时忽略 */
    }
    // 工作区里残留的视图布局会让宿主不再解析侧栏视图（容器点开一片空白），这时改在编辑区打开。
    const fallback = !this.editor && !(await this.waitForView(VIEW_RESOLVE_MS));
    if (fallback) this.ensureEditor();
    if (this.editor) this.render();
    if (fallback) this.afterOpen();
  }

  /** 只开了编辑区页面时，补上侧栏解析时会做的标签数据、提示和聚焦 */
  private afterOpen(): void {
    void this.afterTab(this.tab);
    if (this.pendingNote) {
      const note = this.pendingNote;
      this.pendingNote = undefined;
      this.toast(note.text, note.kind);
    }
    this.flushFocus();
  }

  /** 等侧栏视图被宿主解析并可见，超时返回 false */
  private async waitForView(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (this.view?.visible) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return Boolean(this.view?.visible);
  }

  private async afterTab(tab: PanelTab): Promise<void> {
    if (tab === 'ai') await this.ai?.push();
    if (tab === 'git') this.postGit();
    if (tab === 'compose') {
      this.post({ type: 'compose', ...this.composePreset });
    }
    if (tab === 'io') this.postIo();
  }

  /** 同一仓库只渲染一次，切换仓库或首次展示时才重绘。侧栏和编辑区各画一份。 */
  private render(): void {
    const store = this.store;
    const surfaces = this.surfaces();
    if (!surfaces.length) return;
    const root = store?.workspaceRoot;
    try {
      if (!root) {
        for (const webview of surfaces) webview.html = renderPlaceholder();
        this.renderedRoot = undefined;
        return;
      }
      const pending = surfaces.filter((webview) => !this.painted.has(webview) || this.renderedRoot !== root);
      if (!pending.length) return;
      const matched = this.searchAll();
      this.resultIds = matched.map((e) => e.id);
      for (const webview of pending) {
        webview.html = renderHtml(webview, store!, this.state, this.context, this.tab, this.composePreset, matched);
        this.painted.add(webview);
      }
      this.renderedRoot = root;
    } catch (err) {
      this.renderedRoot = undefined;
      for (const webview of surfaces) {
        this.painted.delete(webview);
        webview.html = renderBoom(err);
      }
    }
  }

  private toast(text: string, kind?: 'warn'): void {
    this.post({ type: 'toast', text, kind });
  }

  private filteredCount = -1;

  private searchAll(): MemoryEntry[] {
    const n = this.store!.entries.length;
    if (this.filteredEntries && this.filteredCount === n) return this.filteredEntries;
    const state = this.state;
    this.filteredCount = n;
    this.filteredEntries = this.store!.search(state.query, {
      tag: state.tag || undefined,
      space: state.space || undefined,
      sort: state.sort,
      includeArchived: state.archived,
      limit: Number.POSITIVE_INFINITY,
    });
    return this.filteredEntries;
  }

  private push(): void {
    this.filteredEntries = null;
    const store = this.store;
    if (!this.alive() || !store?.workspaceRoot) return;
    const state = this.state;
    const entries = this.searchAll();
    this.resultIds = entries.map((e) => e.id);
    this.viewEpoch += 1;
    const filtered = Boolean(state.query || state.tag || state.space);
    const emptyKind = entries.length ? '' : store.entries.length ? (filtered ? 'filter' : 'view') : 'none';
    this.post({
      type: 'results',
      epoch: this.viewEpoch,
      state,
      emptyKind,
      statsHtml: renderStats(store),
      chipsHtml: renderChips(store, state),
      spacesHtml: renderSpaceOptions(store, state),
      profileHtml: renderProfile(store),
      rows: entries.slice(0, PAGE_SIZE).map(toRow),
      total: entries.length,
    });
  }

  private postEditor(id: string): void {
    const store = this.store;
    if (!store || !this.alive()) return;
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) return;
    this.openId = id;
    this.post({ type: 'editor', html: renderEditor(store, entry) });
  }

  private postDetail(id: string): void {
    const store = this.store;
    if (!store || !this.alive()) return;
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) return;
    this.openId = id;
    this.post({ type: 'detail', html: renderDetail(store, entry) });
  }

  /** 计算清理目标 id（all = 当前筛选结果全量，except 是全选后取消的几条；否则用前端传来的选中 id） */
  private resolveBatchIds(all: boolean, ids: string[], except: string[] = []): string[] {
    if (all) {
      if (!except.length) return [...this.resultIds];
      const skip = new Set(except);
      return this.resultIds.filter((id) => !skip.has(id));
    }
    const have = new Set(this.store?.entries.map((e) => e.id) || []);
    return ids.filter((id) => have.has(id));
  }

  private async askConfirm(text: string, okLabel = '确认'): Promise<boolean> {
    if (!this.alive()) await this.reveal();
    if (!this.alive()) return false;
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        if (!this.confirms.has(token)) return;
        this.confirms.delete(token);
        resolve(ok);
      };
      this.confirms.set(token, done);
      this.post({ type: 'confirm', token, text, okLabel });
      setTimeout(() => done(false), 120000);
    });
  }

  private postGit(): void {
    const root = this.store?.workspaceRoot;
    if (!root || !this.alive()) return;
    try {
      const commits = listRecentCommits(root);
      this.post({ type: 'gitList', commits });
    } catch {
      this.post({ type: 'gitList', commits: [], error: '当前目录不是 Git 仓库' });
    }
  }

  private postIo(): void {
    const root = vscode.workspace.getConfiguration('aimemory').get<string>('youmengyuRoot', '');
    this.post({ type: 'ioState', root });
  }

  private async createFrom(raw: unknown): Promise<void> {
    const store = this.store;
    if (!store?.workspaceRoot) return;
    const patch = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const content = String(patch.content || '');
    const title = String(patch.title || '').trim() || content.trim().split('\n')[0].slice(0, 60);
    if (!title || !content.trim()) {
      this.toast('标题与正文不能为空', 'warn');
      return;
    }
    const tags = Array.isArray(patch.tags) && patch.tags.length ? patch.tags.map(String) : ['other'];
    const r = store.add({
      title: title.slice(0, 200),
      content,
      tags,
      importance: Number(patch.importance) || 3,
      source: patch.source ? String(patch.source) : undefined,
      space: String(patch.space || DEFAULT_SPACE),
    });
    this.toast(r.merged ? `已合并更新「${r.entry.title}」` : `已保存「${r.entry.title}」`);
    this.tab = 'memory';
    this.post({ type: 'tabState', tab: 'memory' });
    this.push();
    if (vscode.workspace.getConfiguration('aimemory').get<boolean>('autoInject', true)) {
      void generateInject(store, { silent: true });
    }
  }

  private importGit(hashes: string[], space: string): void {
    const root = this.store?.workspaceRoot;
    if (!root || !this.store) return;
    let commits: Array<{ hash: string; date: string; subject: string }> = [];
    try {
      commits = listRecentCommits(root);
    } catch {
      this.toast('当前目录不是 Git 仓库', 'warn');
      return;
    }
    const want = new Set(hashes);
    let n = 0;
    for (const c of commits) {
      if (!want.has(c.hash)) continue;
      this.store.add({
        title: c.subject.slice(0, 200),
        content: `${c.subject}\n\n来源 git ${c.hash} (${c.date})`,
        tags: ['lesson'],
        importance: 3,
        source: `git ${c.hash} (${c.date})`,
        space: space || DEFAULT_SPACE,
      });
      n += 1;
    }
    if (!n) {
      this.toast('先勾选要提炼的提交', 'warn');
      return;
    }
    this.toast(`已提炼 ${n} 条提交`);
    this.tab = 'memory';
    this.post({ type: 'tabState', tab: 'memory' });
    this.push();
  }

  private async exportJson(writeFile: boolean): Promise<void> {
    const store = this.store;
    if (!store?.workspaceRoot) return;
    const text = store.toJSONString();
    if (writeFile) {
      const file = path.join(store.workspaceRoot, '.youmengyu', 'runs', 'aimemory-export.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
      this.toast('已写入 .youmengyu/runs/aimemory-export.json');
    } else {
      await vscode.env.clipboard.writeText(text);
      this.toast('JSON 已复制');
    }
    this.post({ type: 'ioText', text });
  }

  private importJsonText(text: string): void {
    if (!this.store?.workspaceRoot) return;
    try {
      const n = this.store.importJson(text);
      this.toast(`导入完成，新增 ${n} 条`);
      this.tab = 'memory';
      this.post({ type: 'tabState', tab: 'memory' });
      this.push();
    } catch (err) {
      this.toast(`导入失败 ${String(err)}`, 'warn');
    }
  }

  private importPlain(title: string, content: string, space: string): void {
    const body = content.trim();
    if (!this.store?.workspaceRoot || !body) {
      this.toast('正文不能为空', 'warn');
      return;
    }
    const name = title.trim() || body.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60);
    this.store.add({ title: name, content: body, tags: ['fact'], space: space || DEFAULT_SPACE });
    this.toast('已从正文导入');
    this.tab = 'memory';
    this.post({ type: 'tabState', tab: 'memory' });
    this.push();
  }

  private async importYoumengyu(root: string): Promise<void> {
    const dir = root.trim();
    if (!dir) {
      this.toast('请填写数字人仓库路径', 'warn');
      return;
    }
    if (!this.extra.youmengyu) {
      this.toast('导入还没准备好', 'warn');
      return;
    }
    try {
      this.toast(await this.extra.youmengyu(dir));
      this.tab = 'memory';
      this.post({ type: 'tabState', tab: 'memory' });
      this.push();
    } catch (err) {
      this.toast(`导入失败 ${String(err)}`, 'warn');
    }
  }

  private async runLocalAction(actionKey: string): Promise<void> {
    if (!ACTION_COMMANDS[actionKey]) return;
    switch (actionKey) {
      case 'add':
        this.openTab('compose');
        return;
      case 'search':
        this.focusSearch();
        return;
      case 'git':
        this.openTab('git');
        return;
      case 'import':
      case 'export':
      case 'youmengyu':
        this.openTab('io');
        return;
      case 'inject':
        await this.injectNow();
        return;
      case 'copyAll':
        await this.copyAll();
        return;
      case 'refresh':
        this.store?.bindWorkspace();
        this.renderedRoot = undefined;
        this.render();
        this.push();
        this.toast('已刷新工作区绑定');
        return;
      case 'aiOrganize': {
        if (!this.extra.organize) {
          this.toast('AI 整理还没准备好', 'warn');
          return;
        }
        this.toast('正在整理…');
        this.toast(await this.extra.organize());
        this.push();
        return;
      }
      default:
        break;
    }
  }

  private async confirmBulk(label: string, count: number): Promise<boolean> {
    return this.askConfirm(
      `确认删除${label} ${count} 条记忆？删除后不可恢复。可以先到「导入」页复制 JSON 备份。`,
      '删除'
    );
  }

  private async handleMessage(msg: any): Promise<void> {
    const webview = this.primaryWebview();
    if (!webview) return;
    const type = String(msg?.type || '');
    // AI 服务设置消息：转发给设置控制器（设置不依赖当前工作区）
    if (AI_SETTINGS_MSGS.includes(type)) {
      void this.ai?.handle(msg, webview);
      return;
    }
    if (type === 'confirmAnswer') {
      this.confirms.get(String(msg.token || ''))?.(Boolean(msg.ok));
      return;
    }
    if (type === 'tab') {
      this.tab = asTab(msg.tab);
      await this.afterTab(this.tab);
      return;
    }
    const store = this.store;
    if (!store?.workspaceRoot) return;
    const id = String(msg?.id || '');
    switch (type) {
      case 'query': {
        this.state = sanitizeState(msg.state);
        this.push();
        if (this.pendingDetail) {
          const pending = this.pendingDetail;
          this.pendingDetail = undefined;
          this.postDetail(pending);
        }
        break;
      }
      case 'closed':
        this.openId = undefined;
        break;
      case 'edit':
        this.postEditor(id);
        break;
      case 'detail':
        this.postDetail(id);
        break;
      case 'loadMore': {
        // 虚拟列表滚动到已加载数据尾部：续推下一页。epoch 对不上说明期间筛选已变，回空包让前端丢弃
        const epoch = Number(msg.epoch) || 0;
        const offset = Math.max(0, Number(msg.offset) || 0);
        if (epoch !== this.viewEpoch) {
          this.post({
            type: 'rows',
            stale: true,
            epoch,
            offset,
            total: this.resultIds.length,
            rows: [],
          });
          break;
        }
        const entries = this.searchAll();
        this.resultIds = entries.map((e) => e.id);
        this.post({
          type: 'rows',
          epoch: this.viewEpoch,
          offset,
          total: entries.length,
          rows: entries.slice(offset, offset + PAGE_SIZE).map(toRow),
        });
        break;
      }
      case 'copy': {
        const entry = store.entries.find((e) => e.id === id);
        if (!entry) break;
        await vscode.env.clipboard.writeText(`${entry.title}\n${entry.content}`);
        this.toast('已复制到剪贴板');
        break;
      }
      case 'pin': {
        const entry = store.entries.find((e) => e.id === id);
        if (!entry) break;
        const nextPinned = !entry.pinned;
        store.update(entry.id, { pinned: nextPinned });
        this.toast(nextPinned ? '已置顶，进入仓库画像' : '已取消置顶');
        this.push();
        if (this.openId === id) this.postDetail(id);
        break;
      }
      case 'archive': {
        const entry = store.entries.find((e) => e.id === id);
        if (!entry) break;
        const nextArchived = !entry.archived;
        store.archive(entry.id, nextArchived);
        this.toast(nextArchived ? '已归档，可在「显示已归档」里找回' : '已恢复');
        this.push();
        if (this.openId === id) this.postDetail(id);
        break;
      }
      case 'delete': {
        const entry = store.entries.find((e) => e.id === id);
        if (!entry) break;
        if (!(await this.askConfirm(`删除记忆「${entry.title}」？删除后不可恢复。`, '删除'))) break;
        store.remove(entry.id);
        if (this.openId === id) {
          this.openId = undefined;
          this.post({ type: 'close' });
        }
        this.toast('已删除');
        this.push();
        break;
      }
      case 'batchDelete': {
        const ids = this.resolveBatchIds(
          Boolean(msg.all),
          Array.isArray(msg.ids) ? msg.ids.map(String) : [],
          Array.isArray(msg.except) ? msg.except.map(String) : []
        );
        if (!ids.length) {
          this.toast('没有可删除的条目', 'warn');
          break;
        }
        if (!(await this.confirmBulk('', ids.length))) break;
        const n = store.removeMany(ids);
        this.post({ type: 'deleted', count: n });
        this.toast(`已批量删除 ${n} 条`);
        this.push();
        break;
      }
      case 'scan': {
        const report = store.analyzeIssues();
        this.post({ type: 'scanReport', html: renderCleanupDrawer(report) });
        break;
      }
      case 'cleanup': {
        const kinds: string[] = Array.isArray(msg.kinds) ? msg.kinds.map(String) : [];
        const report = store.analyzeIssues();
        const idLists: Record<string, string[]> = {
          duplicate: report.duplicateIds,
          invalid: report.invalid.map((e) => e.id),
          meaningless: report.meaningless.map((e) => e.id),
          expired: report.expired.map((e) => e.id),
        };
        const ids = [...new Set(kinds.flatMap((k) => idLists[k] || []))];
        if (!ids.length) {
          this.toast('没有可清理的数据', 'warn');
          break;
        }
        if (!(await this.confirmBulk('问题数据', ids.length))) break;
        const n = store.removeMany(ids);
        this.post({ type: 'deleted', count: n });
        this.toast(`一键整理完成：清理 ${n} 条`);
        this.push();
        break;
      }
      case 'rollback': {
        const entry = store.entries.find((e) => e.id === id);
        const version = entry?.versions?.[Number(msg.index) || 0];
        if (!entry || !version) break;
        if (!(await this.askConfirm(
          `回滚「${entry.title}」到 ${(version.updatedAt || '').slice(0, 10)} 的版本？当前内容会留入版本历史。`,
          '回滚'
        ))) break;
        store.update(entry.id, {
          title: version.title,
          content: version.content,
          tags: version.tags,
          importance: version.importance,
        });
        this.toast('已回滚到该版本');
        this.push();
        this.postDetail(entry.id);
        break;
      }
      case 'update': {
        const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
        const entry = store.update(id, {
          title: String(patch.title ?? '').slice(0, 200),
          content: String(patch.content ?? ''),
          importance: Number(patch.importance) || 3,
          pinned: Boolean(patch.pinned),
          tags: Array.isArray(patch.tags) && patch.tags.length ? patch.tags.map(String) : ['other'],
          space: String(patch.space || DEFAULT_SPACE),
          expiresAt: patch.expiresAt ? String(patch.expiresAt) : undefined,
          metadata:
            patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : undefined,
        });
        this.post({ type: 'close' });
        this.openId = undefined;
        if (entry) this.toast('已保存');
        this.push();
        break;
      }
      case 'create':
        await this.createFrom(msg.patch);
        break;
      case 'gitLoad':
        this.postGit();
        break;
      case 'gitImport':
        this.importGit(Array.isArray(msg.hashes) ? msg.hashes.map(String) : [], String(msg.space || ''));
        break;
      case 'exportCopy':
        await this.exportJson(false);
        break;
      case 'exportWrite':
        await this.exportJson(true);
        break;
      case 'importJson':
        this.importJsonText(String(msg.text || ''));
        break;
      case 'importText':
        this.importPlain(String(msg.title || ''), String(msg.content || ''), String(msg.space || ''));
        break;
      case 'youmengyuGo':
        await this.importYoumengyu(String(msg.root || ''));
        break;
      case 'action': {
        await this.runLocalAction(String(msg.action || ''));
        break;
      }
      default:
        break;
    }
  }
}

/* ---------------------------------- 片段渲染 ---------------------------------- */

function renderStats(store: MemoryStore): string {
  const s = store.stats();
  const cards: Array<[number, string]> = [
    [s.total, '记忆总数'],
    [s.pinned, '置顶（进画像）'],
    [s.recent, '近 7 天更新'],
    [s.spaces, '记忆空间'],
    [s.archived, '已归档'],
  ];
  return cards
    .map(
      ([num, label]) =>
        `<div class="stat"><span class="stat-num">${num}</span><span class="stat-label">${esc(label)}</span></div>`
    )
    .join('');
}

function renderChips(store: MemoryStore, state: PanelState): string {
  const counts = store.tagCounts({ includeArchived: state.archived, space: state.space || undefined });
  let total = 0;
  for (const n of counts.values()) total += n;
  const parts = [`<button class="chip${state.tag ? '' : ' on'}" data-tag="">全部 <b>${total}</b></button>`];
  for (const tag of MEMORY_TAGS) {
    const n = counts.get(tag) || 0;
    if (!n) continue;
    parts.push(
      `<button class="chip${state.tag === tag ? ' on' : ''}" data-tag="${tag}">${esc(TAG_LABEL[tag] || tag)} <b>${n}</b></button>`
    );
  }
  return parts.join('');
}

function renderSpaceOptions(store: MemoryStore, state: PanelState): string {
  const options = [`<option value="">全部空间</option>`];
  for (const [space, count] of store.spaces()) {
    options.push(
      `<option value="${esc(space)}"${state.space === space ? ' selected' : ''}>${esc(spaceLabel(space))}（${count}）</option>`
    );
  }
  return options.join('');
}

function renderProfile(store: MemoryStore): string {
  const { statics, dynamic } = store.profile();
  const items = [...statics, ...dynamic];
  const body = items.length
    ? items
        .map(
          (e) =>
            `<button class="chip${e.pinned ? ' on' : ''}" data-act="detail" data-id="${esc(e.id)}" title="${esc(e.content)}">${e.pinned ? '⭐ ' : ''}${esc(e.title)}</button>`
        )
        .join('')
    : `<span class="muted">把关键约定置顶或设为 P5，就会进入仓库画像，AI 第一眼就读到。</span>`;
  return `<div class="profile-head">${icon('star')} 仓库画像 <span class="muted">静态 ${statics.length} 条 · 动态 ${dynamic.length} 条</span></div><div class="profile-body">${body}</div>`;
}

/** 虚拟列表单行 HTML；topPx 提供时输出绝对定位坐标（前端窗口渲染 / 服务端直出共用） */
function renderRowHtml(r: RowData, topPx?: number): string {
  const tagPills = r.g.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const flags = `${r.ar ? '<span class="pill">已归档</span>' : ''}${r.ex ? '<span class="pill warn">已过期</span>' : ''}`;
  const pos =
    topPx === undefined
      ? '' // 无坐标：服务端兜底直出，由 CSS --row-h 决定高度
      : ` style="top:${topPx}px;height:76px;"`;
  return `<div class="row${r.pin ? ' pinned' : ''}${r.ar ? ' archived' : ''}"${pos} data-row="${esc(r.id)}">
    <input type="checkbox" class="row-sel" data-sel="${esc(r.id)}" title="选择">
    <div class="row-main" data-act="detail" data-id="${esc(r.id)}" title="查看详情">
      <div class="row-top">
        <span class="row-title">${r.pin ? '⭐ ' : ''}${esc(r.t)}</span>
        <span class="pips" title="重要性 P${r.p}">${pips(r.p)}</span>
      </div>
      <div class="row-snippet">${esc(r.c)}</div>
      <div class="row-meta">${tagPills}${flags}<span class="meta-item">${esc(r.s)}</span><span class="meta-item">${r.u} 次命中</span><span class="meta-item">${esc(r.d)}</span></div>
    </div>
    <div class="row-tools">
      <button class="icon${r.pin ? ' active' : ''}" data-act="pin" data-id="${esc(r.id)}" title="${r.pin ? '取消置顶' : '置顶'}">${icon('pin')}</button>
      <button class="icon" data-act="edit" data-id="${esc(r.id)}" title="编辑">${icon('edit')}</button>
      <button class="icon" data-act="archive" data-id="${esc(r.id)}" title="${r.ar ? '恢复' : '归档'}">${icon('archive')}</button>
      <button class="icon danger" data-act="delete" data-id="${esc(r.id)}" title="删除">${icon('trash')}</button>
    </div>
  </div>`;
}

/** 无 JS 环境下的首屏兜底：服务端直出前几行（脚本可用后前端会用虚拟列表接管） */
function renderInitialRows(rows: RowData[]): string {
  return rows.map((r, i) => renderRowHtml(r, i * 76)).join('');
}

function emptyHtml(store: MemoryStore, state: PanelState): string {
  if (!store.entries.length) {
    return `<div class="empty">
      <div class="empty-icon">🐟</div>
      <div class="empty-title">还没有记忆</div>
      <p>教训、决策、架构、偏好都能存成记忆，之后一键注入 <code>AGENTS.md</code>，所有 AI 助手开工前自动读完。</p>
      <p>按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> 新建，或在编辑器里选中文本右键「将选中文本存为记忆」。</p>
      <p>记忆按条目跟着仓库自身存在 <code>.youmengyu/memory/long-memory/</code>（与游梦鱼数字人本仓记忆同目录），提交进 Git 即全团队共享。</p>
    </div>`;
  }
  const filtered = Boolean(state.query || state.tag || state.space);
  return `<div class="empty">
      <div class="empty-icon">${filtered ? '🔍' : '🗂️'}</div>
      <div class="empty-title">${filtered ? '没有匹配的记忆' : '该视图下暂无记忆'}</div>
      <p>${filtered ? '换个关键词，或清空标签 / 空间筛选再试。' : '试试关闭「显示已归档」，或新建一条记忆。'}</p>
    </div>`;
}

function renderEditor(store: MemoryStore, entry: MemoryEntry): string {
  const tagOptions = MEMORY_TAGS.map((t) => {
    const on = (entry.tags || []).includes(t);
    return `<label class="tagopt${on ? ' on' : ''}"><input type="checkbox" name="tag" value="${t}"${on ? ' checked' : ''}><span>${esc(TAG_LABEL[t] || t)}</span></label>`;
  }).join('');
  const spaceList = [...store.spaces().keys()]
    .filter((s) => s !== DEFAULT_SPACE)
    .map((s) => `<option value="${esc(s)}"></option>`)
    .join('');
  return `<form data-id="${esc(entry.id)}">
    <div class="drawer-head">
      <div>
        <div class="eyebrow">编辑记忆</div>
        <h2>${esc(entry.title)}</h2>
      </div>
      <button class="icon" type="button" data-act="close" title="关闭">${icon('close')}</button>
    </div>
    <label class="field"><span>标题</span><input name="title" value="${esc(entry.title)}"></label>
    <label class="field"><span>正文</span><textarea name="content" rows="8">${esc(entry.content)}</textarea></label>
    <div class="field-row">
      <label class="field"><span>重要性</span><span class="range-row"><input name="importance" type="range" min="1" max="5" step="1" value="${entry.importance}"><span class="range-val">P${entry.importance}</span></span></label>
      <label class="field"><span>记忆空间</span><input name="space" list="space-list" placeholder="默认" value="${entry.space && entry.space !== DEFAULT_SPACE ? esc(entry.space) : ''}"></label>
    </div>
    <datalist id="space-list">${spaceList}</datalist>
    <div class="field"><span>标签</span><div class="tagpick">${tagOptions}</div></div>
    <label class="field"><span>元数据（每行 key=value，可选）</span><textarea name="meta" rows="3">${esc(
      Object.entries(entry.metadata || {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    )}</textarea></label>
    <div class="field-row">
      <label class="switch"><input name="pinned" type="checkbox"${entry.pinned ? ' checked' : ''}><span>置顶（进入仓库画像）</span></label>
      <label class="field"><span>过期日期（留空长期有效）</span><input name="expiresAt" type="date" value="${entry.expiresAt ? esc(entry.expiresAt.slice(0, 10)) : ''}"></label>
    </div>
    <div class="drawer-actions">
      <button type="button" class="btn" data-act="close">取消</button>
      <button type="button" class="btn primary" data-act="save">保存</button>
    </div>
  </form>`;
}

function versionHtml(v: MemoryVersion, index: number, entryId: string): string {
  return `<button type="button" class="detail-item" data-act="rollback" data-id="${esc(entryId)}" data-vindex="${index}" title="回滚到这一版">
      <span>v${index + 1} · ${esc(v.title)}</span>
      <span class="muted">${esc((v.updatedAt || '').slice(0, 10))}</span>
    </button>`;
}

function renderDetail(store: MemoryStore, entry: MemoryEntry): string {
  const related = store.related(entry.id, 5);
  const facts = entry.facts || [];
  const versions = entry.versions || [];
  const meta = Object.entries(entry.metadata || {});
  const relatedHtml = related.length
    ? related
        .map(
          (r) =>
            `<button class="detail-item" data-act="detail" data-id="${esc(r.entry.id)}"><span>${esc(r.entry.title)}</span><span class="muted">${Math.round(r.score * 100)}%</span></button>`
        )
        .join('')
    : '<div class="muted small">暂无明显关联的记忆</div>';
  return `<div class="drawer-head">
      <div>
        <div class="eyebrow">记忆详情</div>
        <h2>${entry.pinned ? '⭐ ' : ''}${esc(entry.title)}</h2>
      </div>
      <button class="icon" type="button" data-act="close" title="关闭">${icon('close')}</button>
    </div>
    <div class="detail-meta">
      ${tagsHtml(entry, 6)}
      <span class="pill">P${entry.importance}</span>
      <span class="pill">${icon('layers')}${esc(spaceLabel(entry.space))}</span>
      <span class="pill">${icon('clock')}${esc(timeAgo(entry.updatedAt))}</span>
      <span class="pill">${entry.uses} 次命中</span>
      ${entry.archived ? '<span class="pill">已归档</span>' : ''}
      ${isExpired(entry) ? '<span class="pill warn">已过期</span>' : ''}
    </div>
    <div class="detail-body">${esc(entry.content)}</div>
    <div class="detail-section">
      <h4>事实（自动抽取）</h4>
      <div class="detail-list">${facts.length ? facts.map((f) => `<div class="detail-item static"><span class="fact-mark">›</span><span>${esc(f)}</span></div>`).join('') : '<div class="muted small">暂无</div>'}</div>
    </div>
    <div class="detail-section">
      <h4>相关记忆（关系图）</h4>
      <div class="detail-list">${relatedHtml}</div>
    </div>
    <div class="detail-section">
      <h4>版本历史（${versions.length}）</h4>
      <div class="detail-list">${versions.length ? versions.map((v, i) => versionHtml(v, i, entry.id)).join('') : '<div class="muted small">内容从未被改写</div>'}</div>
    </div>
    ${meta.length ? `<div class="detail-section"><h4>元数据</h4><div class="detail-list">${meta.map(([k, v]) => `<div class="detail-item static"><span>${esc(k)}</span><span class="muted">${esc(v)}</span></div>`).join('')}</div></div>` : ''}
    ${
      entry.source
        ? `<div class="detail-section"><h4>来源</h4><div class="muted small">${esc(entry.source)}</div></div>`
        : ''
    }
    <div class="drawer-actions">
      <button type="button" class="btn" data-act="copy" data-id="${esc(entry.id)}">${icon('copy')}复制</button>
      <button type="button" class="btn" data-act="edit" data-id="${esc(entry.id)}">${icon('edit')}编辑</button>
      <button type="button" class="btn" data-act="archive" data-id="${esc(entry.id)}">${icon('archive')}${entry.archived ? '恢复' : '归档'}</button>
      <button type="button" class="btn warn" data-act="delete" data-id="${esc(entry.id)}">${icon('trash')}删除</button>
    </div>`;
}

/** 一键整理抽屉：四类问题数据 + 分类清理按钮 */
function renderCleanupDrawer(report: {
  duplicateGroups: MemoryEntry[][];
  duplicateIds: string[];
  invalid: MemoryEntry[];
  meaningless: MemoryEntry[];
  expired: MemoryEntry[];
}): string {
  const section = (
    kind: string,
    title: string,
    desc: string,
    count: number,
    samples: MemoryEntry[]
  ): string => {
    const list = samples
      .slice(0, 8)
      .map(
        (e) =>
          `<div class="detail-item static"><span>${esc(e.title)}</span><span class="muted">${esc(timeAgo(e.updatedAt))}</span></div>`
      )
      .join('');
    const more = count > 8 ? `<div class="muted small">…等共 ${count} 条</div>` : '';
    const action = count
      ? `<button type="button" class="btn warn" data-act="cleanup" data-kind="${kind}">${icon('trash')}清理这 ${count} 条</button>`
      : '<span class="pill">没有此类问题</span>';
    return `<div class="detail-section">
      <h4>${esc(title)} <span class="issue-count${count ? '' : ' zero'}">${count}</span></h4>
      <div class="muted small">${esc(desc)}</div>
      <div class="detail-list">${list}${more}</div>
      <div class="cleanup-action">${action}</div>
    </div>`;
  };
  const dupTotal = report.duplicateIds.length;
  const anyIssue =
    dupTotal + report.invalid.length + report.meaningless.length + report.expired.length > 0;
  return `<div class="drawer-head">
      <div>
        <div class="eyebrow">记忆管理</div>
        <h2>${icon('broom')} 一键整理</h2>
      </div>
      <button class="icon" type="button" data-act="close" title="关闭">${icon('close')}</button>
    </div>
    <p class="muted small">扫描重复、无效、无意义与已过期的记忆，确认后批量清理。置顶条目不会被自动判定为垃圾。</p>
    ${section('duplicate', '重复数据', '归一化正文完全相同的副本，每组自动保留最完整的一份。', dupTotal, report.duplicateGroups.map((g) => g[0]))}
    ${section('invalid', '无效数据', '正文为空或全空白的条目，无法参与检索与注入。', report.invalid.length, report.invalid)}
    ${section('meaningless', '无意义数据', '有效字符过少、纯符号或占位内容（置顶条目除外）。', report.meaningless.length, report.meaningless)}
    ${section('expired', '已过期数据', '超过过期日期的条目，检索与注入早已跳过，可物理删除腾地方。', report.expired.length, report.expired)}
    <div class="drawer-actions">
      <button type="button" class="btn" data-act="close">取消</button>
      <button type="button" class="btn danger-broad" data-act="cleanup" data-kind="all"${anyIssue ? '' : ' disabled'}>${icon('broom')}清理全部问题数据</button>
    </div>`;
}

/* ---------------------------------- 页面骨架 ---------------------------------- */

let cachedClientScript: string | undefined;

/** 读取打包进插件的前端脚本（读不到时页面仍有服务端直出的内容） */
function readClientScript(context: vscode.ExtensionContext): string {
  if (cachedClientScript !== undefined) return cachedClientScript;
  try {
    const dir = path.join(context.extensionPath, 'media');
    cachedClientScript = ['list-window.js', 'panel.js']
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf-8'))
      .join('\n')
      .replace(/<\/script/gi, '<\\/script');
  } catch {
    cachedClientScript = '';
  }
  return cachedClientScript;
}

/** 没打开工作区时的侧边栏占位页 */
function renderPlaceholder(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body {
    margin: 0; padding: 28px 16px; font-size: 12.5px; color: var(--vscode-foreground, #d4d4d8);
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    background: var(--vscode-sideBar-background, #1f1f24); text-align: center;
  }
  .icon { font-size: 28px; margin-bottom: 10px; }
  h2 { margin: 0 0 8px; font-size: 14px; }
  p { margin: 4px 0; color: var(--vscode-descriptionForeground, #8b8b93); line-height: 1.7; }
  code { background: rgba(128,128,128,.16); border-radius: 5px; padding: 1px 6px; font-size: 11.5px; }
</style>
</head>
<body>
  <div class="icon">🐟</div>
  <h2>游梦鱼·长记忆</h2>
  <p>请先打开一个工作区（文件夹）。</p>
  <p>记忆跟着仓库存在 <code>.youmengyu/memory/long-memory/</code>，随 Git 共享给全团队与所有 AI 助手。</p>
</body>
</html>`;
}

function renderBoom(err: unknown): string {
  const detail = esc(err instanceof Error ? err.message : err);
  return `<!DOCTYPE html><html lang="zh-CN"><body style="font-family:sans-serif;padding:16px">
    <h2>游梦鱼·长记忆打不开这一页</h2>
    <p>${detail}</p>
    <p>请从命令面板再执行一次「打开记忆面板」。</p>
  </body></html>`;
}

function renderTagPicks(): string {
  return MEMORY_TAGS.map((t) => {
    const on = t === 'lesson';
    return `<label class="tagopt"><input type="checkbox" name="ctag" value="${t}"${on ? ' checked' : ''}><span>${esc(TAG_LABEL[t] || t)}</span></label>`;
  }).join('');
}

function renderHtml(
  webview: vscode.Webview,
  store: MemoryStore,
  state: PanelState,
  context: vscode.ExtensionContext,
  tab: PanelTab = 'memory',
  preset: { content: string; source: string } = { content: '', source: '' },
  matched: MemoryEntry[] = []
): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const clientScript = readClientScript(context);
  const on = (id: PanelTab) => (tab === id ? ' on' : '');
  const page = (id: PanelTab) => (tab === id ? '' : ' off');
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const repoName = store.workspaceRoot ? path.basename(store.workspaceRoot) : '';
  const storageRel = store.storageFileRel;
  // 首屏直出真实条数和前几行。统计条不能写死 0，否则全选只能选中 0 条。
  const initialRows = matched.slice(0, FIRST_PAINT).map(toRow);
  const initial = initialRows.length ? renderInitialRows(initialRows) : emptyHtml(store, state);
  const filteredOn = Boolean(state.query || state.tag || state.space);
  const emptyKind = matched.length ? '' : store.entries.length ? (filteredOn ? 'filter' : 'view') : 'none';
  const bootJson = JSON.stringify({
    total: matched.length,
    rows: initialRows,
    emptyKind,
    state,
  })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const sortOptions = SORT_ITEMS.map(
    (i) => `<option value="${i.value}"${state.sort === i.value ? ' selected' : ''}>${i.label}</option>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>游梦鱼·长记忆</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1b1b1f);
    --fg: var(--vscode-foreground, #d4d4d8);
    --muted: var(--vscode-descriptionForeground, #8b8b93);
    --card: var(--vscode-editorWidget-background, #232329);
    --card2: var(--vscode-sideBar-background, #1f1f24);
    --border: var(--vscode-widget-border, rgba(128,128,128,.22));
    --accent: var(--vscode-focusBorder, #4d9cf7);
    --accent-fg: var(--vscode-button-foreground, #ffffff);
    --btn: var(--vscode-button-background, #2f6fd0);
    --danger: var(--vscode-errorForeground, #f48771);
    --warn: var(--vscode-editorWarning-foreground, #e2b93d);
    --ok: var(--vscode-testing-iconPassed, #73c991);
    --radius: 14px;
    --radius-sm: 9px;
    --row-h: 76px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-size: 13px; color: var(--fg);
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    background: radial-gradient(1100px 380px at 8% -12%, rgba(77,156,247,.10), transparent 62%), var(--bg);
    height: 100%; min-height: 100%; overflow: auto; display: flex; flex-direction: column;
  }
  .app { display: flex; flex-direction: column; max-width: 1200px; width: 100%; margin: 0 auto; padding: 16px 20px 0; }
  .hero {
    display: flex; gap: 14px; align-items: center; justify-content: space-between; flex-wrap: wrap;
    padding: 12px 16px; border: 1px solid var(--border); border-radius: 14px; flex: none;
    background: linear-gradient(135deg, rgba(77,156,247,.14), rgba(155,89,245,.10) 46%, transparent 78%), var(--card);
    box-shadow: 0 12px 30px rgba(0,0,0,.16);
  }
  .brand { display: flex; gap: 12px; align-items: center; min-width: 0; }
  .logo {
    width: 40px; height: 40px; display: grid; place-items: center; font-size: 20px; border-radius: 12px;
    background: linear-gradient(135deg, rgba(77,156,247,.34), rgba(155,89,245,.34)); border: 1px solid var(--border);
  }
  h1 { margin: 0; font-size: 15.5px; letter-spacing: .3px; }
  .repo { margin-top: 3px; color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 56vw; }
  .hero-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--card2);
    color: var(--fg); padding: 7px 13px; border-radius: 9px; font-size: 12.5px; cursor: pointer;
    font-family: inherit; transition: transform .15s ease, border-color .15s ease, filter .15s ease;
  }
  .btn:hover { border-color: var(--accent); transform: translateY(-1px); }
  .btn.primary {
    background: linear-gradient(135deg, var(--btn), #6a5cd8); border-color: transparent; color: var(--accent-fg);
    box-shadow: 0 4px 14px rgba(47,111,208,.32);
  }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.clean { border-color: rgba(226,185,61,.45); }
  .btn.clean:hover { border-color: var(--warn); }
  /* AI 整理：胶囊 + 星火，和工具条里灰色方钮「刷新」（环形箭头）分开 */
  .btn.ai-organize {
    border-radius: 999px; border: 1px solid transparent; color: #f6fffd; font-weight: 600;
    background:
      linear-gradient(180deg, rgba(255,255,255,.16), transparent 46%),
      linear-gradient(120deg, #0b8f86 0%, #1a6fd4 58%, #7a45e0 100%);
    box-shadow: 0 6px 16px rgba(11, 143, 134, .28);
    padding-left: 12px;
  }
  .btn.ai-organize:hover { filter: brightness(1.06); border-color: transparent; }
  .btn.ai-organize .ic { stroke: currentColor; }
  .btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
  .btn.warn:hover { border-color: var(--danger); color: var(--danger); }
  .danger-broad { background: rgba(244,135,113,.14); border-color: rgba(244,135,113,.4); color: var(--danger); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 8px; margin: 12px 0 0; flex: none; }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 12px; }
  .stat-num { display: block; font-size: 17px; font-weight: 600; letter-spacing: .4px; }
  .stat-label { color: var(--muted); font-size: 10.5px; }
  .controls {
    display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; flex: none;
  }
  .search {
    flex: 1 1 220px; display: flex; align-items: center; gap: 8px; background: var(--card);
    border: 1px solid var(--border); border-radius: 10px; padding: 0 12px; height: 34px; transition: border-color .15s, box-shadow .15s;
  }
  .search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(77,156,247,.15); }
  .search .ic { color: var(--muted); }
  .search input { flex: 1; border: none; outline: none; background: transparent; color: var(--fg); font-size: 12.5px; height: 100%; font-family: inherit; }
  .select {
    height: 34px; background: var(--card); color: var(--fg); border: 1px solid var(--border);
    border-radius: 10px; padding: 0 10px; font-size: 12.5px; font-family: inherit; outline: none; cursor: pointer;
  }
  .switch {
    display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border: 1px solid var(--border);
    border-radius: 10px; background: var(--card); color: var(--muted); font-size: 12px; cursor: pointer; user-select: none;
  }
  .switch input { accent-color: var(--accent); margin: 0; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; flex: none; }
  .chip {
    border: 1px solid var(--border); background: transparent; color: var(--muted); border-radius: 999px;
    padding: 3px 11px; font-size: 12px; cursor: pointer; font-family: inherit; transition: all .15s ease;
  }
  .chip:hover { color: var(--fg); border-color: var(--accent); }
  .chip.on { background: rgba(77,156,247,.16); border-color: var(--accent); color: var(--fg); }
  .chip b { font-weight: 600; opacity: .72; margin-left: 2px; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; flex: none; }
  .toolbar .btn { padding: 5px 11px; font-size: 12px; }
  .profile { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 13px; margin: 10px 0 0; flex: none; }
  .profile-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; margin-bottom: 8px; }
  .profile-head .muted { font-weight: 400; margin-left: 4px; }
  .profile-body { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  /* 批量管理条 */
  .batchbar {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0 8px; padding: 7px 12px; flex: none;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card); font-size: 12px;
  }
  .batchbar .grow { flex: 1; }
  .batchbar .btn { padding: 4px 10px; font-size: 11.5px; }
  .batchbar .btn.danger { border-color: rgba(244,135,113,.45); color: var(--danger); }
  .batchbar .btn.on { border-color: var(--accent); color: var(--fg); background: rgba(77,156,247,.16); }
  .batchbar .btn:disabled, .sel-master input:disabled { opacity: .4; cursor: default; }
  .sel-master {
    display: inline-flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;
    user-select: none; color: var(--fg);
  }
  .sel-master input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); cursor: pointer; }
  .sel-info { color: var(--muted); }
  .sel-info b { color: var(--accent); font-weight: 600; }
  /* 列表容器：跟随整页滚动（页面本身可滚，区块多时也能全部看到），
     虚拟列表只渲染可见窗口，画布 #list 由 JS 按总条数撑高 */
  .listbox {
    flex: none; position: relative;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card2);
    overflow: hidden;
  }
  .listbox.is-empty { overflow: visible; background: transparent; border-color: transparent; }
  #list { position: relative; width: 100%; }
  .row {
    position: absolute; left: 0; right: 0; height: var(--row-h);
    display: flex; align-items: center; gap: 10px; padding: 0 12px;
    border-bottom: 1px solid var(--border); overflow: hidden;
  }
  .row:hover { background: rgba(77,156,247,.07); }
  .row.picked, .row.picked:hover { background: rgba(77,156,247,.12); }
  .row.pinned { box-shadow: inset 3px 0 0 var(--accent); }
  .row.archived { opacity: .58; }
  .row-sel { flex: none; width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; margin: 0; }
  .row-main { flex: 1; min-width: 0; cursor: pointer; display: flex; flex-direction: column; gap: 3px; }
  .row-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .row-title { font-size: 12.8px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pips { display: inline-flex; gap: 3px; flex: none; }
  .pip { width: 5px; height: 5px; border-radius: 50%; background: var(--border); }
  .pip.on { background: linear-gradient(135deg, var(--accent), #a855f7); }
  .row-snippet {
    color: var(--muted); font-size: 11.8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .row-meta { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(77,156,247,.14); border: 1px solid rgba(77,156,247,.25); white-space: nowrap; }
  .meta-item { color: var(--muted); font-size: 10.5px; white-space: nowrap; }
  .row-tools { display: flex; gap: 2px; flex: none; opacity: 0; transition: opacity .15s ease; }
  .row:hover .row-tools, .row:focus-within .row-tools { opacity: 1; }
  .icon {
    display: inline-grid; place-items: center; width: 26px; height: 26px; border: none; background: transparent;
    color: var(--muted); border-radius: 7px; cursor: pointer; padding: 0; transition: background .15s, color .15s;
  }
  .icon:hover { background: rgba(128,128,128,.16); color: var(--fg); }
  .icon.active { color: var(--accent); }
  .icon.danger:hover { color: var(--danger); }
  .ic { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .list-loading { padding: 40px 0; text-align: center; color: var(--muted); }
  .load-more { position: sticky; bottom: 0; text-align: center; padding: 6px 0 8px; color: var(--muted); font-size: 11px;
    background: linear-gradient(transparent, var(--card2) 40%); pointer-events: none; }
  .load-more.off { display: none; }
  .grow { flex: 1; }
  .muted { color: var(--muted); }
  .small { font-size: 11.5px; }
  .link { border: none; background: transparent; color: var(--accent); font-size: 11.5px; cursor: pointer; padding: 0; font-family: inherit; }
  .link:hover { text-decoration: underline; }
  .pill {
    display: inline-flex; align-items: center; gap: 4px; font-size: 10px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--muted); white-space: nowrap;
  }
  .pill .ic { width: 11px; height: 11px; }
  .pill.warn { color: var(--warn); border-color: rgba(226,185,61,.4); }
  .empty {
    text-align: center; padding: 52px 20px; margin: 14px; border: 1px dashed var(--border);
    border-radius: var(--radius); background: var(--card);
  }
  .empty-icon { font-size: 30px; margin-bottom: 10px; }
  .empty-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
  .empty p { color: var(--muted); margin: 6px 0; font-size: 12.5px; line-height: 1.7; }
  kbd { background: rgba(128,128,128,.16); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; font-size: 11px; }
  code { background: rgba(128,128,128,.16); border-radius: 5px; padding: 1px 6px; font-size: 11.5px; }
  .foot { margin: 8px 0 10px; color: var(--muted); font-size: 10.5px; text-align: center; line-height: 1.7; flex: none; }
  /* 标签页：记忆 / AI 服务（同一侧边栏视图内切换，不另开页面） */
  .tabs { display: flex; gap: 6px; max-width: 1200px; width: 100%; margin: 0 auto; padding: 10px 12px 0; flex: none; overflow-x: auto; }
  .tab {
    flex: 0 0 auto; border: 1px solid var(--border); background: var(--card2); color: var(--muted);
    border-radius: 10px; padding: 7px 10px; font-size: 12.5px; font-family: inherit; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: all .15s ease;
  }
  .tab:hover { color: var(--fg); border-color: var(--accent); }
  .tab.on { background: rgba(77,156,247,.16); border-color: var(--accent); color: var(--fg); font-weight: 600; }
  .off { display: none !important; }
  /* AI 服务设置（并入标签页后的页面样式） */
  .page { max-width: 1200px; width: 100%; margin: 0 auto; padding: 4px 16px 32px; }
  .page h2 { font-size: 14px; margin: 12px 0 8px; }
  .git-row { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .confirm {
    position: sticky; bottom: 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    margin: 8px 12px 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px;
    background: var(--card); z-index: 25;
  }
  .confirm p { margin: 0; flex: 1; min-width: 140px; font-size: 12.5px; }
  #aiapp { max-width: 1200px; width: 100%; margin: 0 auto; padding: 0 20px 48px; }
  #aiapp h2 { font-size: 14px; margin: 18px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 5px; }
  #aiapp h3.sub { font-size: 12.5px; margin: 12px 0 6px; opacity: .85; }
  #aiapp .card { background: var(--card); border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px; margin-bottom: 10px; }
  #aiapp .card.on { border-color: var(--accent); }
  #aiapp .lanes { display: flex; gap: 10px; flex-wrap: wrap; }
  #aiapp .lanes .lane { flex: 1 1 240px; }
  #aiapp .lane-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  #aiapp .lane-head label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  #aiapp .count { opacity: .7; font-size: 12px; }
  #aiapp select, #aiapp input, #aiapp textarea {
    width: 100%; box-sizing: border-box; background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font: inherit; margin-top: 3px; outline: none;
  }
  #aiapp select:focus, #aiapp input:focus, #aiapp textarea:focus { border-color: var(--accent); }
  #aiapp input[type=checkbox], #aiapp input[type=radio] { width: auto; margin: 0 6px 0 0; accent-color: var(--accent); }
  #aiapp .chk { display: block; margin: 8px 0; }
  #aiapp .lbl { display: block; margin: 10px 0; }
  #aiapp .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; word-break: break-all; }
  #aiapp .btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  #aiapp .btn.sm { padding: 3px 10px; font-size: 12px; }
  #aiapp .btn.danger { border-color: rgba(244,135,113,.45); color: var(--danger); }
  #aiapp .tag.ok { background: rgba(115,201,145,.16); color: var(--ok); border-color: transparent; }
  #aiapp .prov { margin-bottom: 8px; }
  #aiapp .prov-head { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
  #aiapp .sm-note { margin-top: 6px; font-size: 12px; }
  #aiapp .log { font-size: 12px; }
  #aiapp .log-row { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px dashed var(--border); align-items: baseline; }
  #aiapp .err { color: var(--danger); }
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; justify-content: flex-end;
    opacity: 0; pointer-events: none; transition: opacity .18s ease; z-index: 20;
  }
  .overlay.show { opacity: 1; pointer-events: auto; }
  .drawer {
    width: min(540px, 100%); height: 100%; overflow: auto; background: var(--card); border-left: 1px solid var(--border);
    padding: 20px 22px 32px; transform: translateX(18px); transition: transform .2s ease;
    box-shadow: -18px 0 40px rgba(0,0,0,.25);
  }
  .overlay.show .drawer { transform: none; }
  .drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .drawer-head h2 { display: inline-flex; align-items: center; gap: 8px; }
  .eyebrow { color: var(--muted); font-size: 11px; letter-spacing: .6px; }
  .drawer h2 { margin: 3px 0 0; font-size: 15px; line-height: 1.45; word-break: break-word; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; flex: 1; }
  .field > span { color: var(--muted); font-size: 11.5px; }
  .field input, .field textarea {
    background: var(--bg); border: 1px solid var(--border); border-radius: 9px; color: var(--fg);
    padding: 8px 10px; font-size: 12.5px; font-family: inherit; outline: none; width: 100%;
  }
  .field input:focus, .field textarea:focus { border-color: var(--accent); }
  .field textarea { resize: vertical; min-height: 130px; line-height: 1.6; }
  .field-row { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
  .range-row { display: flex; align-items: center; gap: 10px; padding-top: 6px; }
  .range-row input[type=range] { flex: 1; accent-color: var(--accent); padding: 0; }
  .range-val { font-size: 12px; min-width: 26px; }
  .tagpick { display: flex; gap: 8px; flex-wrap: wrap; }
  .tagopt {
    display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 999px;
    padding: 4px 10px; font-size: 12px; color: var(--muted); cursor: pointer;
  }
  .tagopt:has(input:checked) { border-color: var(--accent); background: rgba(77,156,247,.14); color: var(--fg); }
  .tagopt input { display: none; }
  .drawer-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }
  .detail-meta { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .detail-body {
    white-space: pre-wrap; word-break: break-word; line-height: 1.72; font-size: 12.8px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px;
  }
  .detail-section { margin: 16px 0; }
  .detail-section h4 { margin: 0 0 8px; font-size: 12px; color: var(--muted); font-weight: 600; letter-spacing: .4px; display: flex; align-items: center; gap: 8px; }
  .issue-count {
    display: inline-grid; place-items: center; min-width: 20px; height: 18px; padding: 0 6px; border-radius: 999px;
    background: rgba(244,135,113,.16); color: var(--danger); font-size: 11px; font-weight: 600;
  }
  .issue-count.zero { background: rgba(115,201,145,.14); color: var(--ok); }
  .cleanup-action { margin-top: 10px; }
  .detail-list { display: flex; flex-direction: column; gap: 6px; }
  .detail-item {
    display: flex; gap: 8px; align-items: center; border: 1px solid var(--border); border-radius: 9px;
    padding: 8px 10px; background: transparent; color: var(--fg); text-align: left; font-family: inherit;
    font-size: 12px; cursor: pointer; line-height: 1.55;
  }
  .detail-item.static { cursor: default; }
  button.detail-item:hover { border-color: var(--accent); }
  .detail-item .muted { margin-left: auto; font-size: 11px; white-space: nowrap; }
  .fact-mark { color: var(--accent); font-weight: 600; }
  .toast {
    position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 14px); background: var(--card);
    border: 1px solid var(--border); color: var(--fg); padding: 9px 16px; border-radius: 999px; font-size: 12px;
    box-shadow: 0 10px 26px rgba(0,0,0,.3); opacity: 0; pointer-events: none; transition: all .2s ease;
    z-index: 30; max-width: 80vw;
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast.warn { border-color: rgba(226,185,61,.5); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: rgba(128,128,128,.3); border-radius: 6px; }
  /* 侧边栏窄视图（WebviewView 常驻约 280~340px） */
  @media (max-width: 420px) {
    .app, .tabs { padding: 10px 10px 0; }
    .tabs { margin-bottom: 8px; }
    #aiapp { padding: 0 10px 40px; }
    .hero { padding: 10px 12px; gap: 8px; }
    .logo { width: 34px; height: 34px; font-size: 17px; border-radius: 9px; }
    h1 { font-size: 14px; }
    .stats { grid-template-columns: repeat(2, 1fr); gap: 6px; }
    .stat { padding: 6px 9px; }
    .stat-num { font-size: 14.5px; }
    .search { height: 32px; flex-basis: 100%; }
    .select, .switch { height: 32px; }
    :root { --row-h: 84px; }
    .row { padding: 0 8px; gap: 7px; }
    .row-tools { opacity: 1; position: absolute; right: 6px; top: 4px; z-index: 2; background: var(--card2); border-radius: 7px; }
    .row-main { padding-right: 112px; }
    .foot { margin-bottom: 8px; }
  }
</style>
</head>
<body>
  <nav class="tabs" id="tabs">
    <button class="tab${on('memory')}" data-tab="memory">${icon('db')}记忆</button>
    <button class="tab${on('compose')}" data-tab="compose">${icon('plus')}新建</button>
    <button class="tab${on('git')}" data-tab="git">${icon('book')}提炼</button>
    <button class="tab${on('profile')}" data-tab="profile">${icon('star')}画像</button>
    <button class="tab${on('io')}" data-tab="io">${icon('layers')}导入</button>
    <button class="tab${on('ai')}" data-tab="ai">${icon('sparkle')}AI</button>
  </nav>

  <div class="app${page('memory')}" id="memapp">
    <header class="hero">
      <div class="brand">
        <div class="logo">🐟</div>
        <div>
          <h1>游梦鱼·长记忆${repoName ? ` · ${esc(repoName)}` : ''}</h1>
          <div class="repo">${esc(storageRel)} · 教训、决策、架构、偏好与事实 · 随 Git 共享给全团队与所有 AI 助手</div>
        </div>
      </div>
      <div class="hero-actions">
        <button class="btn primary" data-act="add">${icon('plus')}新建记忆</button>
        <button class="btn clean" data-act="scan" title="扫描并清理重复 / 无效 / 无意义 / 过期数据">${icon('broom')}一键整理</button>
        <button class="btn" data-act="inject">${icon('star')}生成注入块</button>
        <button class="btn ai-organize" data-act="aiOrganize" title="用已配置的 AI 通路立即记录并整理记忆，不占用开发 Agent 的 token">${icon('sparkle')}AI 立即整理记忆</button>
      </div>
    </header>

    <section class="stats" id="stats">${renderStats(store)}</section>

    <section class="controls">
      <div class="search">
        ${icon('search')}
        <input id="q" type="search" placeholder="搜索标题、正文、标签、事实…（按 / 聚焦）" value="${esc(state.query)}" autocomplete="off">
      </div>
      <select id="sort" class="select" title="排序方式">${sortOptions}</select>
      <select id="space" class="select" title="记忆空间">${renderSpaceOptions(store, state)}</select>
      <label class="switch" title="包含已归档记忆"><input id="archived" type="checkbox"${state.archived ? ' checked' : ''}><span>显示已归档</span></label>
    </section>

    <section class="chips" id="chips" data-tag="${esc(state.tag)}">${renderChips(store, state)}</section>

    <section class="toolbar">
      <button class="btn" data-act="git">${icon('book')}从 Git 提交提炼</button>
      <button class="btn" data-act="copyAll">${icon('copy')}复制全部上下文</button>
      <button class="btn" data-act="import">导入 JSON</button>
      <button class="btn" data-act="export">导出 JSON</button>
      <button class="btn" data-act="search">${icon('search')}快速搜索</button>
      <button class="btn" data-act="youmengyu">${icon('layers')}数字人记忆</button>
      <button class="btn" data-act="refresh">${icon('refresh')}刷新</button>
    </section>

    <section class="batchbar">
      <label class="sel-master" title="选中当前筛选结果的全部条目">
        <input type="checkbox" id="selmaster"${matched.length ? '' : ' disabled'}>
        <span>全选</span>
      </label>
      <span class="sel-info" id="selinfo">共 <b id="total">${matched.length}</b> 条 · 已选 <b id="selcount">0</b> 条</span>
      <span class="grow"></span>
      <button type="button" class="btn" id="selallbtn" data-act="selAll" title="选中当前筛选结果的全部条目"${matched.length ? '' : ' disabled'}>全选</button>
      <button type="button" class="btn" id="selnone" data-act="selNone" disabled>清除选择</button>
      <button type="button" class="btn danger" id="batchdel" data-act="batchDelete" title="删除所选（批量）" disabled>${icon('trash')}删除所选</button>
    </section>

    <main class="listbox" id="listbox">
      <div id="list"${initialRows.length ? ` style="height:${initialRows.length * 76}px;"` : ''}>${initial}</div>
      <div class="load-more off" id="loadmore">滚动加载更多…</div>
    </main>

    <footer class="foot">
      数据保存在 <code>${esc(storageRel)}</code>，提交进 Git 即全团队、全 AI 共享同一份记忆。
      <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> 搜索 · <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> 新建 · <kbd>/</kbd> 聚焦搜索 · <kbd>Esc</kbd> 关闭抽屉
    </footer>
  </div>

  <section id="composeapp" class="page${page('compose')}">
    <h2>${icon('plus')} 新建记忆</h2>
    <form id="composeform">
      <label class="field"><span>标题</span><input name="title" placeholder="留空则用正文首行"></label>
      <label class="field"><span>正文</span><textarea name="content" id="ccontent" rows="8">${esc(preset.content)}</textarea></label>
      <div class="field-row">
        <label class="field"><span>重要性</span><span class="range-row"><input name="importance" type="range" min="1" max="5" step="1" value="3"><span class="range-val">P3</span></span></label>
        <label class="field"><span>记忆空间</span><input name="space" placeholder="默认"></label>
      </div>
      <label class="field"><span>来源（可选）</span><input name="source" id="csource" value="${esc(preset.source)}"></label>
      <div class="field"><span>标签</span><div class="tagpick">${renderTagPicks()}</div></div>
      <div class="drawer-actions"><button type="button" class="btn primary" data-act="create">保存到本仓库</button></div>
    </form>
  </section>

  <section id="gitapp" class="page${page('git')}">
    <h2>${icon('book')} 从 Git 提交提炼</h2>
    <p class="muted small">勾选踩坑或重大变更，直接写成记忆。不打开选择框。</p>
    <label class="field"><span>写入空间</span><input id="gitspace" placeholder="默认"></label>
    <div id="gitlist"><p class="muted">打开这一页时读取最近 30 条提交…</p></div>
    <div class="drawer-actions">
      <button type="button" class="btn" data-act="gitReload">重新读取</button>
      <button type="button" class="btn primary" data-act="gitImport">提炼所选</button>
    </div>
  </section>

  <section id="profileapp" class="page${page('profile')}">
    <h2>${icon('star')} 仓库画像</h2>
    <p class="muted small">置顶和 P5 会整段注入 AGENTS.md。点一条可看详情。</p>
    <div class="profile" id="profile">${renderProfile(store)}</div>
  </section>

  <section id="ioapp" class="page${page('io')}">
    <h2>${icon('layers')} 导入 / 导出</h2>
    <label class="field"><span>JSON</span><textarea id="iojson" rows="6" placeholder="粘贴记忆 JSON，或点下面的按钮把当前记忆填进来"></textarea></label>
    <div class="drawer-actions">
      <button type="button" class="btn" data-act="exportCopy">复制 JSON</button>
      <button type="button" class="btn" data-act="exportWrite">写入仓库文件</button>
      <button type="button" class="btn primary" data-act="importJson">导入 JSON</button>
    </div>
    <label class="field"><span>单条正文（md / txt）</span><input id="iotitle" placeholder="标题，留空用首行"></label>
    <label class="field"><span>正文</span><textarea id="iomd" rows="5" placeholder="把一段教训或约定贴在这里"></textarea></label>
    <label class="field"><span>空间</span><input id="iospace" placeholder="默认"></label>
    <div class="drawer-actions"><button type="button" class="btn primary" data-act="importText">导入这条正文</button></div>
    <label class="field"><span>数字人仓库路径（含 .youmengyu/memory）</span><input id="ioroot" placeholder="D:/Web/asaiwebagent"></label>
    <div class="drawer-actions"><button type="button" class="btn" data-act="youmengyuGo">导入数字人记忆</button></div>
  </section>

  <section id="aiapp" class="${page('ai')}"><p class="muted">正在加载 AI 服务设置…</p></section>
  ${clientScript ? '' : '<p class="empty-title">面板脚本没有打进安装包。页面能看，按钮暂时不会动。请重新打包安装。</p>'}

  <div class="confirm off" id="confirm">
    <p id="confirmtext"></p>
    <button type="button" class="btn danger" id="confirmok" data-act="confirmYes">确认</button>
    <button type="button" class="btn" data-act="confirmNo">取消</button>
  </div>
  <div class="overlay" id="overlay"><aside class="drawer" id="drawer"></aside></div>
  <div class="toast" id="toast"></div>

<script nonce="${nonce}">window.__AIMEM_BOOT=${bootJson};</script>
<script nonce="${nonce}">${clientScript}</script>
</body>
</html>`;
}
