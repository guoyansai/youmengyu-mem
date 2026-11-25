import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  duplicateRemoveIds,
  findDuplicateGroups,
  findInvalidEntries,
  findMeaninglessEntries,
  isExpired,
  normalizeText,
  IssueReport,
} from './clean';
import { MEMORY_TAGS, MemoryDoc, MemoryEntry, MemoryTag, MemoryVersion } from './types';

/** isExpired 的实现挪到了 clean.ts（纯函数可单测），这里保持原导入路径可用 */
export { isExpired };

/**
 * 默认记忆目录：放进游梦鱼数字人约定目录的 memory/ 分区（LAYOUT v3.1，建议入库），
 * 与数字人本仓记忆共用同一份数据，不另设重复目录；提交进 Git 即团队与所有 AI 共享。
 * 每条记忆一个 JSON 文件（<id>.json，id 为内容哈希）：不同终端改不同条目互不冲突，
 * 相同内容在两个终端会产生完全相同的文件，Git 合并天然无冲突。
 */
export const DEFAULT_STORAGE_DIR = '.youmengyu/memory/long-memory';
/** 旧版记忆目录：0.1.x 使用，首次启动自动迁移 */
export const LEGACY_STORAGE_DIR = '.aimemory';
/** 0.3 及之前的默认目录（单体记忆文件所在），仅作为迁移来源 */
export const LEGACY_YOUMENGYU_DIR = '.youmengyu';
/** 单体记忆文件名（0.1-0.3 旧格式），迁移完成后删除，不留重复数据 */
export const MEMORY_FILE_NAME = 'memories.json';
/** 本机运行态子目录：命中计数等易变数据不入库，避免多终端 Git 冲突 */
export const LOCAL_DIR = '.local';
/** 本机命中计数文件名 */
export const HITS_FILE = 'hits.json';
/** 文档版本：2 起支持事实、空间、版本链、关系、归档与过期 */
export const DOC_VERSION = 2;
/** 默认记忆空间 */
export const DEFAULT_SPACE = 'default';
/** 历史版本最多保留条数 */
const MAX_VERSIONS = 10;
/** 事实化片段的单条最短长度 */
const MIN_FACT_LEN = 4;

export type SortMode = 'relevance' | 'recent' | 'importance' | 'uses';

export interface SearchOptions {
  limit?: number;
  tag?: string;
  space?: string;
  sort?: SortMode;
  includeArchived?: boolean;
  includeExpired?: boolean;
}

export interface MemoryProfile {
  /** 静态画像：置顶与 P5 条目，AI 第一眼必须读到 */
  statics: MemoryEntry[];
  /** 动态画像：近期有改动或高命中的上下文 */
  dynamic: MemoryEntry[];
}

export interface RelatedEntry {
  entry: MemoryEntry;
  score: number;
  kind: 'related' | 'extends' | 'supersedes';
}

export interface MemoryStats {
  total: number;
  pinned: number;
  archived: number;
  recent: number;
  spaces: number;
  facts: number;
}

/** 归一化内容用于去重比较（实现见 clean.ts，可单测） */
const normalize = normalizeText;

/** 归一化目录配置值，便于与默认值比较 */
function normalizeDir(sub: string): string {
  return sub.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 归一化空间名（空 → default，空格压缩） */
export function normalizeSpace(space?: string): string {
  const s = String(space ?? '').trim();
  if (!s || s === '默认') return DEFAULT_SPACE;
  return s;
}

/**
 * 对话流水只留在记忆库里供检索，不进画像和注入块。
 * 否则每轮对话都会挤掉项目规则，Agent 开工时读到的是聊天而不是约定。
 */
export function countsForInject(e: { metadata?: Record<string, string> }): boolean {
  return e.metadata?.inject !== 'skip';
}

/** 空间展示名 */
export function spaceLabel(space?: string): string {
  const s = normalizeSpace(space);
  return s === DEFAULT_SPACE ? '默认' : s;
}

export function entryId(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
}

/**
 * 事实化：把一段正文切成原子事实（按句号/分号/换行），去掉列表符号与空句。
 * 记忆写进仓库后，检索与画像都优先用这些短句，命中更准。
 */
export function extractFacts(content: string, max = 8): string[] {
  const parts = String(content ?? '')
    .split(/[\n\r]+|(?<=[。！？；!?;])|(?:\s*[.．]\s+)/)
    .map((s) =>
      s
        .replace(/^[\s>*\-+•·\d]+[.、)）]?\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((s) => s.length >= MIN_FACT_LEN);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of parts) {
    const key = normalize(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** 分词：拉丁词 + 中文二元组，零依赖的轻量语义近似 */
export function tokenize(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();
  const latin = lower.match(/[a-z0-9_$.-]{2,}/g) || [];
  const cjkChunks = lower.match(/[\u4e00-\u9fa5]+/g) || [];
  const grams: string[] = [];
  for (const chunk of cjkChunks) {
    if (chunk.length === 1) {
      grams.push(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length - 1; i += 1) grams.push(chunk.slice(i, i + 2));
  }
  return [...latin, ...grams];
}

/** 集合重叠度（余弦近似），用于检索重排与关系发现 */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.sqrt(a.size * b.size);
}

export function similarity(a: string, b: string): number {
  return overlap(new Set(tokenize(a)), new Set(tokenize(b)));
}

function clampImportance(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** 把任意历史数据补齐成完整条目（不落盘，仅在内存中规范化） */
function normalizeEntry(raw: Partial<MemoryEntry>): MemoryEntry {
  const now = new Date().toISOString();
  const content = String(raw.content ?? '');
  const createdAt = raw.createdAt || now;
  return {
    id: raw.id || entryId(content),
    title: String(raw.title ?? '').trim() || '未命名记忆',
    content,
    tags: Array.isArray(raw.tags) && raw.tags.length ? raw.tags.map(String) : ['other'],
    importance: clampImportance(raw.importance),
    createdAt,
    updatedAt: raw.updatedAt || createdAt,
    source: raw.source,
    uses: Number(raw.uses) || 0,
    pinned: Boolean(raw.pinned),
    space: normalizeSpace(raw.space),
    facts: Array.isArray(raw.facts) && raw.facts.length ? raw.facts.map(String) : extractFacts(content),
    metadata: raw.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata } : undefined,
    expiresAt: raw.expiresAt,
    archived: Boolean(raw.archived),
    isLatest: raw.isLatest !== false,
    supersedes: raw.supersedes,
    relations: Array.isArray(raw.relations) ? raw.relations : [],
    versions: Array.isArray(raw.versions) ? raw.versions : [],
  };
}

function snapshot(entry: MemoryEntry, note?: string): MemoryVersion {
  return {
    title: entry.title,
    content: entry.content,
    tags: [...(entry.tags || [])],
    importance: entry.importance,
    updatedAt: entry.updatedAt,
    note,
  };
}

export class MemoryStore {
  private dir = '';
  private doc: MemoryDoc = { version: DOC_VERSION, entries: [] };
  private touchTimer: NodeJS.Timeout | undefined;
  private tokenCache = new Map<string, { key: string; tokens: Set<string> }>();
  private _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  constructor(opts?: { defer?: boolean }) {
    if (!opts?.defer) this.bindWorkspace();
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.bindWorkspace());
  }

  get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  bindWorkspace(): void {
    const root = this.workspaceRoot;
    this.tokenCache.clear();
    if (!root) {
      this.dir = '';
      this.doc = { version: DOC_VERSION, entries: [] };
      return;
    }
    const cfg = vscode.workspace.getConfiguration('aimemory');
    const sub = cfg.get<string>('storageDir', DEFAULT_STORAGE_DIR);
    this.dir = path.join(root, sub);
    this.ensureGitignore();
    this.migrateLegacy(root, sub);
    this.load();
  }

  /**
   * 旧版单体 memories.json（0.1-0.3：.aimemory/ 或 .youmengyu/ 根）→ 每条一个 JSON 文件。
   * 只在仍用默认目录、新目录还没有条目文件时执行；迁移成功后删除旧文件，不留重复数据。
   */
  private migrateLegacy(root: string, sub: string): void {
    const norm = normalizeDir(sub);
    if (norm !== DEFAULT_STORAGE_DIR && norm !== LEGACY_YOUMENGYU_DIR) return;
    if (this.hasEntryFiles()) return;
    const sources = [LEGACY_YOUMENGYU_DIR, LEGACY_STORAGE_DIR];
    for (const legacyDir of sources) {
      const legacyFile = path.join(root, legacyDir, MEMORY_FILE_NAME);
      if (!fs.existsSync(legacyFile)) continue;
      try {
        const text = fs.readFileSync(legacyFile, 'utf-8').replace(/^\uFEFF/, '');
        const raw = JSON.parse(text) as Partial<MemoryDoc>;
        const entries = (Array.isArray(raw.entries) ? raw.entries : [])
          .map((e) => normalizeEntry(e as Partial<MemoryEntry>))
          .filter((e) => e.content.trim());
        for (const e of entries) this.persistEntry(e, false);
        fs.rmSync(legacyFile, { force: true });
        void vscode.window.showInformationMessage(
          `游梦鱼·长记忆: 已把旧单体文件 ${legacyDir}/${MEMORY_FILE_NAME} 的 ${entries.length} 条记忆迁移为按条目存储（${DEFAULT_STORAGE_DIR}/），旧文件已删除`
        );
      } catch (err) {
        void vscode.window.showWarningMessage(`游梦鱼·长记忆: 迁移旧记忆失败（${String(err)}）`);
      }
      break; // 一次只迁一个来源，另一个来源留待下次启动
    }
  }

  /** 新目录里是否已有按条目存储的 JSON 文件 */
  private hasEntryFiles(): boolean {
    try {
      return fs
        .readdirSync(this.dir)
        .some((n) => n.endsWith('.json') && !n.startsWith('.'));
    } catch {
      return false;
    }
  }

  /** 目录内嵌 .gitignore：只忽略本机运行态，其余记忆数据默认全部随 Git 入库 */
  private ensureGitignore(): void {
    try {
      const f = path.join(this.dir, '.gitignore');
      if (fs.existsSync(f)) return;
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(
        f,
        '# 游梦鱼·长记忆：本机运行态（命中计数）不入库，避免多终端 Git 同步冲突\n.local/\n',
        'utf-8'
      );
    } catch {
      /* 写不了就不写，不影响记忆功能 */
    }
  }

  private load(): void {
    const entries: MemoryEntry[] = [];
    try {
      if (fs.existsSync(this.dir)) {
        for (const name of fs.readdirSync(this.dir)) {
          if (!name.endsWith('.json') || name.startsWith('.')) continue;
          try {
            const raw = JSON.parse(
              fs.readFileSync(path.join(this.dir, name), 'utf-8').replace(/^\uFEFF/, '')
            ) as Partial<MemoryEntry> & Partial<MemoryDoc>;
            // 旧单体文件残留：交给迁移处理，这里不当作条目解析
            if (Array.isArray((raw as MemoryDoc).entries)) continue;
            if (typeof raw.content !== 'string' || !raw.content.trim()) continue;
            entries.push(normalizeEntry(raw));
          } catch {
            /* 单个条目损坏不影响其余记忆 */
          }
        }
      }
    } catch (err) {
      void vscode.window.showWarningMessage(`游梦鱼·长记忆: 读取记忆目录失败（${String(err)}）`);
    }
    // 确定性排序：创建时间倒序 + id 兜底。多终端合并后顺序一致，注入块 diff 保持稳定
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : 1));
    this.doc = { version: DOC_VERSION, entries };
    this.loadHits();
  }

  /** 原子写入 JSON（tmp + rename），避免多终端/崩溃时出现半截文件 */
  private writeJsonAtomic(file: string, data: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, file);
  }

  /** 每条记忆一个 JSON 文件，只在条目内容/元信息变化时写盘 */
  private persistEntry(entry: MemoryEntry, fire = true): void {
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.writeJsonAtomic(path.join(this.dir, `${entry.id}.json`), JSON.stringify(entry, null, 2));
    } catch (err) {
      void vscode.window.showErrorMessage(`游梦鱼·长记忆: 写入记忆文件失败（${String(err)}）`);
      return;
    }
    if (fire) this._onChange.fire();
  }

  /** 本机命中计数文件：.local/hits.json（不入库） */
  private hitsFile(): string {
    return path.join(this.dir, LOCAL_DIR, HITS_FILE);
  }

  private loadHits(): void {
    try {
      if (!fs.existsSync(this.hitsFile())) return;
      const raw = JSON.parse(fs.readFileSync(this.hitsFile(), 'utf-8')) as Record<string, number>;
      for (const e of this.doc.entries) {
        const n = Number(raw[e.id]);
        if (Number.isFinite(n) && n > e.uses) e.uses = n; // 入库存档值与本机计数取较大者
      }
    } catch {
      /* 本机计数损坏可忽略 */
    }
  }

  private flushHits(): void {
    if (!this.dir) return;
    try {
      const hits: Record<string, number> = {};
      for (const e of this.doc.entries) if (e.uses > 0) hits[e.id] = e.uses;
      fs.mkdirSync(path.join(this.dir, LOCAL_DIR), { recursive: true });
      this.writeJsonAtomic(this.hitsFile(), JSON.stringify(hits, null, 2));
    } catch {
      /* 本机计数写失败可忽略 */
    }
  }

  get entries(): MemoryEntry[] {
    return this.doc.entries;
  }

  get ready(): boolean {
    return Boolean(this.dir);
  }

  /** 记忆目录相对工作区根的路径（界面展示用） */
  get storageFileRel(): string {
    const root = this.workspaceRoot;
    if (!root || !this.dir) return DEFAULT_STORAGE_DIR;
    return path.relative(root, this.dir).replace(/\\/g, '/');
  }

  /** 活跃条目（未归档、未过期） */
  private active(now = Date.now(), includeExpired = false): MemoryEntry[] {
    return this.doc.entries.filter((e) => !e.archived && (includeExpired || !isExpired(e, now)));
  }

  /** 新增或合并（去重：normalize 后相同则更新旧条目，并留一份历史版本） */
  add(input: {
    title: string;
    content: string;
    tags?: string[];
    importance?: number;
    source?: string;
    pinned?: boolean;
    space?: string;
    metadata?: Record<string, string>;
    expiresAt?: string;
    facts?: string[];
    supersedes?: string;
  }): { entry: MemoryEntry; merged: boolean } {
    const now = new Date().toISOString();
    const content = String(input.content ?? '').trim();
    const norm = normalize(content);
    const existing = this.doc.entries.find((e) => normalize(e.content) === norm);
    if (existing) {
      const nextTitle = input.title || existing.title;
      const nextTags = input.tags?.length ? input.tags : existing.tags;
      const nextImportance =
        input.importance !== undefined ? clampImportance(input.importance) : existing.importance;
      const nextSpace = input.space ? normalizeSpace(input.space) : existing.space;
      const nextExpires = input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt;
      const nextMeta = input.metadata ? { ...existing.metadata, ...input.metadata } : existing.metadata;
      const dirty =
        nextTitle !== existing.title ||
        nextTags.join(',') !== existing.tags.join(',') ||
        nextImportance !== existing.importance ||
        (input.pinned !== undefined && Boolean(input.pinned) !== Boolean(existing.pinned)) ||
        nextSpace !== existing.space ||
        nextExpires !== existing.expiresAt ||
        JSON.stringify(nextMeta || {}) !== JSON.stringify(existing.metadata || {}) ||
        Boolean(existing.archived);
      // 同内容且无任何变化：直接返回，不写盘也不刷新 updatedAt（自动导入才真正幂等，git 不留噪声）
      if (!dirty) return { entry: existing, merged: true };
      existing.versions = [snapshot(existing, '合并前'), ...(existing.versions || [])].slice(0, MAX_VERSIONS);
      existing.title = nextTitle;
      existing.updatedAt = now;
      existing.tags = nextTags;
      existing.importance = nextImportance;
      if (input.pinned !== undefined) existing.pinned = input.pinned;
      existing.space = nextSpace;
      existing.metadata = nextMeta;
      existing.expiresAt = nextExpires;
      existing.archived = false;
      this.persistEntry(existing);
      return { entry: existing, merged: true };
    }
    const entry: MemoryEntry = {
      id: entryId(content),
      title: input.title?.trim() || '未命名记忆',
      content,
      tags: input.tags?.length ? input.tags : ['other'],
      importance: clampImportance(input.importance ?? 3),
      createdAt: now,
      updatedAt: now,
      source: input.source,
      uses: 0,
      pinned: input.pinned,
      space: normalizeSpace(input.space),
      facts: input.facts?.length ? input.facts : extractFacts(content),
      metadata: input.metadata,
      expiresAt: input.expiresAt,
      archived: false,
      isLatest: true,
      supersedes: input.supersedes,
      relations: [],
      versions: [],
    };
    if (input.supersedes) {
      entry.relations = [{ targetId: input.supersedes, kind: 'supersedes' }];
      this.markSuperseded(input.supersedes, entry.id);
    }
    this.doc.entries.unshift(entry);
    this.persistEntry(entry);
    return { entry, merged: false };
  }

  /** 旧条目被新条目取代：标记归档并建立双向关系 */
  private markSuperseded(oldId: string, newId: string): void {
    const old = this.doc.entries.find((e) => e.id === oldId);
    if (!old) return;
    old.archived = true;
    old.isLatest = false;
    old.relations = [
      { targetId: newId, kind: 'supersedes' },
      ...(old.relations || []).filter((r) => r.targetId !== newId),
    ];
  }

  update(id: string, patch: Partial<MemoryEntry>): MemoryEntry | undefined {
    const e = this.doc.entries.find((x) => x.id === id);
    if (!e) return undefined;
    const nextContent = typeof patch.content === 'string' ? patch.content.trim() : e.content;
    const contentChanged = nextContent !== e.content;
    const metaChanged =
      (patch.title !== undefined && patch.title !== e.title) ||
      (patch.importance !== undefined && clampImportance(patch.importance) !== e.importance) ||
      (patch.tags !== undefined && patch.tags.join(',') !== (e.tags || []).join(','));
    if (contentChanged || metaChanged) {
      e.versions = [snapshot(e, contentChanged ? '内容改写前' : '元信息调整前'), ...(e.versions || [])].slice(
        0,
        MAX_VERSIONS
      );
    }
    Object.assign(e, patch, { id: e.id, updatedAt: new Date().toISOString() });
    e.content = String(e.content ?? '').trim();
    e.title = String(e.title ?? '').trim() || '未命名记忆';
    e.importance = clampImportance(e.importance);
    e.tags = Array.isArray(e.tags) && e.tags.length ? e.tags.map(String) : ['other'];
    e.space = normalizeSpace(e.space);
    if (contentChanged || !e.facts?.length) e.facts = extractFacts(e.content);
    if (patch.archived === false) e.isLatest = true;
    this.tokenCache.delete(id);
    this.persistEntry(e);
    return e;
  }

  /** 命中计数：写进本机 .local/hits.json（不入库），延迟落盘，不碰 Git 跟踪的条目文件 */
  touch(id: string): void {
    const e = this.doc.entries.find((x) => x.id === id);
    if (!e) return;
    e.uses += 1;
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touchTimer = setTimeout(() => {
      this.touchTimer = undefined;
      this.flushHits();
    }, 1200);
  }

  remove(id: string): void {
    this.removeMany([id]);
  }

  /** 批量删除：一次过滤、一次清理关系、批量删文件、只广播一次变更（清理大数据集用） */
  removeMany(ids: string[]): number {
    const kill = new Set(ids);
    if (!kill.size) return 0;
    const before = this.doc.entries.length;
    this.doc.entries = this.doc.entries.filter((e) => !kill.has(e.id));
    const removed = before - this.doc.entries.length;
    for (const e of this.doc.entries) {
      if (e.relations?.some((r) => kill.has(r.targetId))) {
        e.relations = e.relations.filter((r) => !kill.has(r.targetId));
        this.persistEntry(e, false);
      }
    }
    if (this.dir) {
      for (const id of kill) {
        try {
          fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
        } catch {
          /* 文件删不掉不影响内存态 */
        }
      }
    }
    for (const id of kill) this.tokenCache.delete(id);
    if (removed) this._onChange.fire();
    return removed;
  }

  /**
   * 扫描问题数据（记忆面板「一键整理」的数据源）：
   * 重复（每组保留最优）/ 无效 / 无意义 / 已过期；置顶条目不进无效与无意义清单。
   */
  analyzeIssues(): IssueReport {
    const groups = findDuplicateGroups(this.doc.entries);
    const duplicateIds = duplicateRemoveIds(groups);
    const dupSet = new Set(duplicateIds);
    const invalid = findInvalidEntries(this.doc.entries).filter((e) => !e.pinned);
    const invalidSet = new Set(invalid.map((e) => e.id));
    const meaningless = findMeaninglessEntries(this.doc.entries).filter(
      (e) => !e.pinned && !dupSet.has(e.id) && !invalidSet.has(e.id)
    );
    const expired = this.doc.entries.filter((e) => isExpired(e) && !e.archived);
    return { duplicateGroups: groups, duplicateIds, invalid, meaningless, expired };
  }

  /** 归档（遗忘但留档）/ 恢复 */
  archive(id: string, archived: boolean): void {
    const e = this.doc.entries.find((x) => x.id === id);
    if (!e) return;
    e.archived = archived;
    if (archived) e.isLatest = false;
    else e.isLatest = true;
    e.updatedAt = new Date().toISOString();
    this.persistEntry(e);
  }

  /** 把条目移动到某个空间 */
  moveToSpace(id: string, space: string): void {
    this.update(id, { space: normalizeSpace(space) });
  }

  private tokensOf(entry: MemoryEntry): Set<string> {
    const key = `${entry.updatedAt}|${entry.content.length}|${entry.archived ? 1 : 0}`;
    const cached = this.tokenCache.get(entry.id);
    if (cached && cached.key === key) return cached.tokens;
    const tokens = new Set(
      tokenize(`${entry.title} ${entry.content} ${(entry.tags || []).join(' ')} ${(entry.facts || []).join(' ')}`)
    );
    this.tokenCache.set(entry.id, { key, tokens });
    return tokens;
  }

  /**
   * 检索：关键词命中 + 中文二元组相似度重排 + 重要性 / 置顶 / 新鲜度 / 命中次数加权。
   * 支持按标签、空间、排序方式与是否包含归档/过期条目过滤。
   */
  search(query: string, options: SearchOptions = {}): MemoryEntry[] {
    const {
      limit = 30,
      tag,
      space,
      sort = 'relevance',
      includeArchived = false,
      includeExpired = false,
    } = options;
    const now = Date.now();
    const q = normalize(query);
    const terms = q.split(' ').filter(Boolean);
    const qTokens = new Set(tokenize(q));

    let pool = this.doc.entries.filter((e) => {
      if (!includeArchived && e.archived) return false;
      if (!includeExpired && isExpired(e, now)) return false;
      if (space && normalizeSpace(e.space) !== normalizeSpace(space)) return false;
      if (tag && !(e.tags?.length ? e.tags : ['other']).includes(tag)) return false;
      return true;
    });

    const hasQuery = terms.length > 0 || qTokens.size > 0;

    if (!hasQuery) {
      // 无关键词快路径：百万条目下跳过逐条打分，直接按所选排序输出
      pool.sort((a, b) => {
        switch (sort) {
          case 'recent':
            return b.updatedAt.localeCompare(a.updatedAt);
          case 'importance':
            return Number(!!b.pinned) - Number(!!a.pinned) || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt);
          case 'uses':
            return b.uses - a.uses || b.updatedAt.localeCompare(a.updatedAt);
          default:
            return Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt);
        }
      });
      return limit < Number.POSITIVE_INFINITY ? pool.slice(0, limit) : pool;
    }

    const scored = pool.map((e) => {
      let hit = false;
      let score = 0;
      const meta = Object.entries(e.metadata || {})
        .map(([k, v]) => `${k} ${v}`)
        .join(' ');
      const hay = normalize(
        `${e.title} ${e.content} ${(e.tags || []).join(' ')} ${(e.facts || []).join(' ')} ${meta}`
      );
      const title = normalize(e.title);
      for (const t of terms) {
        if (!hay.includes(t)) continue;
        hit = true;
        score += 4;
        if (title.includes(t)) score += 3;
        if ((e.tags || []).includes(t)) score += 2;
      }
      const sim = overlap(qTokens, this.tokensOf(e));
      if (sim > 0.12) hit = true;
      score += sim * 12;
      if (e.pinned) score += 5;
      score += e.importance;
      const ageDays = (now - new Date(e.updatedAt).getTime()) / 86400000;
      score += Math.max(0, 3 - ageDays / 30); // 90 天内线性衰减
      score += Math.min(3, e.uses * 0.1);
      return { e, score, hit };
    });

    if (hasQuery) {
      pool = scored.filter((s) => s.hit).map((s) => s.e);
    }

    const byRelevance = new Map(scored.map((s) => [s.e.id, s.score]));
    const sorted = [...pool].sort((a, b) => {
      switch (sort) {
        case 'recent':
          return b.updatedAt.localeCompare(a.updatedAt);
        case 'importance':
          return Number(!!b.pinned) - Number(!!a.pinned) || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt);
        case 'uses':
          return b.uses - a.uses || b.updatedAt.localeCompare(a.updatedAt);
        default:
          return (byRelevance.get(b.id) || 0) - (byRelevance.get(a.id) || 0);
      }
    });
    return sorted.slice(0, limit);
  }

  /** 注入排序：置顶 > 重要性 > 更新时间；过期与归档不注入。对话流水（inject=skip）不占注入位 */
  injectEntries(limit: number, space?: string): MemoryEntry[] {
    const now = Date.now();
    const list = this.active(now).filter(
      (e) => countsForInject(e) && (!space || normalizeSpace(e.space) === normalizeSpace(space))
    );
    list.sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return list.slice(0, limit);
  }

  /** 画像：静态（置顶/P5）+ 动态（近 30 天或有命中的上下文） */
  profile(): MemoryProfile {
    const now = Date.now();
    const active = this.active(now).filter(countsForInject);
    const statics = active
      .filter((e) => e.pinned || e.importance >= 5)
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 8);
    const staticIds = new Set(statics.map((e) => e.id));
    const dynamic = active
      .filter(
        (e) =>
          !staticIds.has(e.id) &&
          (now - new Date(e.updatedAt).getTime() <= 30 * 86400000 || e.uses >= 3)
      )
      .sort((a, b) => b.uses - a.uses || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 6);
    return { statics, dynamic };
  }

  /** 关系发现：向量相似 + 共享标签 + 显式关系 */
  related(id: string, limit = 5): RelatedEntry[] {
    const base = this.doc.entries.find((e) => e.id === id);
    if (!base) return [];
    const baseTokens = this.tokensOf(base);
    const out: RelatedEntry[] = [];
    for (const e of this.doc.entries) {
      if (e.id === id || e.archived) continue;
      const explicit = (base.relations || []).find((r) => r.targetId === e.id);
      let score = overlap(baseTokens, this.tokensOf(e));
      const sharedTags = (base.tags || []).filter((t) => (e.tags || []).includes(t)).length;
      score += sharedTags * 0.15;
      if (explicit) score += 0.5;
      if (score < 0.15) continue;
      out.push({ entry: e, score, kind: explicit?.kind ?? 'related' });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  /** 空间 → 活跃条目数 */
  spaces(): Map<string, number> {
    const map = new Map<string, number>();
    map.set(DEFAULT_SPACE, 0);
    for (const e of this.active()) {
      const s = normalizeSpace(e.space);
      map.set(s, (map.get(s) || 0) + 1);
    }
    return map;
  }

  /** 标签 → 条目数（只计数不建数组，百万条目下内存友好；chips 用） */
  tagCounts(options: { includeArchived?: boolean; space?: string } = {}): Map<string, number> {
    const { includeArchived = false, space } = options;
    const map = new Map<string, number>();
    for (const t of MEMORY_TAGS) map.set(t, 0);
    for (const e of this.doc.entries) {
      if (!includeArchived && (e.archived || isExpired(e))) continue;
      if (space && normalizeSpace(e.space) !== normalizeSpace(space)) continue;
      const tags = e.tags?.length ? e.tags : ['other'];
      for (const t of tags) map.set(t, (map.get(t) || 0) + 1);
    }
    return map;
  }

  tagGroups(options: { includeArchived?: boolean; space?: string } = {}): Map<string, MemoryEntry[]> {
    const { includeArchived = false, space } = options;
    const map = new Map<string, MemoryEntry[]>();
    for (const t of MEMORY_TAGS) map.set(t, []);
    for (const e of this.doc.entries) {
      if (!includeArchived && (e.archived || isExpired(e))) continue;
      if (space && normalizeSpace(e.space) !== normalizeSpace(space)) continue;
      const tags = e.tags?.length ? e.tags : ['other'];
      for (const t of tags) {
        if (!map.has(t)) map.set(t, []);
        map.get(t)!.push(e);
      }
    }
    return map;
  }

  stats(): MemoryStats {
    const now = Date.now();
    const active = this.active(now);
    return {
      total: active.length,
      pinned: active.filter((e) => e.pinned).length,
      archived: this.doc.entries.filter((e) => e.archived).length,
      recent: active.filter((e) => now - new Date(e.updatedAt).getTime() < 7 * 86400000).length,
      spaces: this.spaces().size,
      facts: active.reduce((n, e) => n + (e.facts?.length || 0), 0),
    };
  }

  history(id: string): MemoryVersion[] {
    return this.doc.entries.find((e) => e.id === id)?.versions || [];
  }

  toJSONString(): string {
    return JSON.stringify({ ...this.doc, version: DOC_VERSION }, null, 2);
  }

  /** 导入合并：同内容自动合并，保留空间/事实/过期等新字段 */
  importJson(json: string): number {
    const raw = JSON.parse(json) as Partial<MemoryDoc>;
    let added = 0;
    for (const e of raw.entries || []) {
      if (!e || typeof e.content !== 'string' || !e.content.trim()) continue;
      const r = this.add({
        title: e.title || '导入记忆',
        content: e.content,
        tags: e.tags,
        importance: e.importance,
        source: e.source,
        pinned: e.pinned,
        space: e.space,
        metadata: e.metadata,
        expiresAt: e.expiresAt,
        facts: e.facts,
      });
      if (!r.merged) added += 1;
    }
    return added;
  }
}

export function isTag(s: string): s is MemoryTag {
  return (MEMORY_TAGS as readonly string[]).includes(s);
}
