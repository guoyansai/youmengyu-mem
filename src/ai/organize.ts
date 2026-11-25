/**
 * 记忆自动引擎（主动记录 + 整理）：
 * - 主动记录：捕获 git 提交与开发 AI 的聊天/内容（watch glob + 手动捕获），交给当前通路 AI 提炼成记忆条目，
 *   替代由辅助 Agent 自己花 token 写记忆。
 * - 自动整理：定期让 AI 合并重复、归档过期、提炼事实，压缩注入体积，降低 Agent token 用量。
 * - 能力升级：每次捕获的内容都会沉淀进长记忆，长记忆随开发 AI 的聊天与产出持续进化。
 * 全部 AI 产出都走 JSON 约定，解析失败丢弃不写脏数据；受 importance 5 / pinned 条目保护。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MemoryStore } from '../store';
import { MEMORY_TAGS } from '../types';
import { estimateTokens, type ChatTurn } from './core';
import type { AiEngine } from './engine';

const SEEN_HEAD_KEY = 'aimemory.ai.seenHead';
const SEEN_HASH_KEY = 'aimemory.ai.seenHashes';
const LAST_CONSOLIDATE_KEY = 'aimemory.ai.lastConsolidate';
const LOG_KEY = 'aimemory.ai.runLog';
const LOG_MAX = 40;
/** git 提交体给 AI 的预算 */
const GIT_BUDGET = 3000;
/** 聊天内容给 AI 的预算 */
const CHAT_BUDGET = 5000;
/** 捕获节流：同一批来源合并处理 */
const DEBOUNCE_MS = 15_000;
/** git 轮询间隔 */
const GIT_POLL_MS = 60_000;

export type RunLogEntry = {
  at: string;
  kind: 'record' | 'consolidate' | 'capture';
  detail: string;
  added?: number;
  ops?: number;
  error?: string;
};

type Candidate = {
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
};

type ConsolidateOps = {
  archive?: { id: string; reason: string }[];
  merge?: { ids: string[]; title: string; content: string; tags?: string[]; importance?: number }[];
  facts?: { id: string; facts: string[] }[];
};

export class MemoryOrganizer {
  private gitTimer?: ReturnType<typeof setInterval>;
  private watchers: vscode.FileSystemWatcher[] = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private queue = new Map<string, { kind: 'git' | 'chat' | 'editor'; path?: string }>();
  private running = false;

  constructor(
    private engine: AiEngine,
    private store: MemoryStore,
    private context: vscode.ExtensionContext,
    private out?: (line: string) => void
  ) {}

  // ---------- 生命周期 ----------
  start(): void {
    this.stop();
    const prefs = this.engine.prefs;
    if (prefs.autoRecord) this.startWatchers();
    this.gitTimer = setInterval(() => this.checkGit(), GIT_POLL_MS);
  }

  stop(): void {
    if (this.gitTimer) clearInterval(this.gitTimer);
    this.gitTimer = undefined;
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  /** 偏好变化后重建 watcher。 */
  restart(): void {
    this.start();
  }

  private startWatchers(): void {
    const patterns = this.engine.prefs.chatWatchPatterns;
    for (const raw of patterns) {
      const pattern = raw.trim();
      if (!pattern) continue;
      try {
        const base = this.store.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const watcher = vscode.workspace.createFileSystemWatcher(
          base ? new vscode.RelativePattern(base, pattern) : new vscode.RelativePattern(vscode.Uri.file('/'), pattern)
        );
        const onChange = (uri: vscode.Uri) => this.enqueue({ kind: 'chat', path: uri.fsPath });
        watcher.onDidCreate(onChange);
        watcher.onDidChange(onChange);
        this.watchers.push(watcher);
      } catch (err) {
        this.out?.(`[ai-organize] watcher ${pattern} 注册失败: ${String(err)}`);
      }
    }
  }

  // ---------- 来源捕获 ----------
  /** git 最新提交，变化时入队。 */
  async checkGit(): Promise<void> {
    if (!this.engine.prefs.autoRecord || !this.store.workspaceRoot) return;
    const head = await gitHead(this.store.workspaceRoot);
    if (!head) return;
    const seen = this.context.globalState.get<string>(SEEN_HEAD_KEY, '');
    if (!seen) {
      // 首次只记录基线，不回溯历史提交（历史用 aimemory.git.lessons 手动提炼）
      await this.context.globalState.update(SEEN_HEAD_KEY, head);
      return;
    }
    if (head === seen) return;
    await this.context.globalState.update(SEEN_HEAD_KEY, head);
    this.enqueue({ kind: 'git', path: `${seen}..${head}` });
  }

  /** 手动捕获当前编辑器内容（开发 AI 的聊天记录/产出贴进文件后触发）。 */
  captureActiveEditor(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('游梦鱼·长记忆: 没有可捕获的活动编辑器');
      return;
    }
    this.enqueue({ kind: 'editor', path: editor.document.uri.fsPath });
    void this.flush('capture');
  }

  private enqueue(src: { kind: 'git' | 'chat' | 'editor'; path?: string }): void {
    if (!this.engine.prefs.autoRecord) return;
    const key = `${src.kind}:${src.path ?? ''}`;
    this.queue.set(key, src);
    this.out?.(`[ai-organize] 入队来源 ${key}`);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush('record'), DEBOUNCE_MS);
  }

  getLog(): RunLogEntry[] {
    return this.context.globalState.get<RunLogEntry[]>(LOG_KEY, []);
  }

  private pushLog(entry: RunLogEntry): void {
    const log = [entry, ...this.getLog()].slice(0, LOG_MAX);
    void this.context.globalState.update(LOG_KEY, log);
  }

  // ---------- 主动记录 ----------
  /** 处理队列里的全部来源，提炼成记忆条目。 */
  async flush(kind: 'record' | 'capture' = 'record'): Promise<RunLogEntry> {
    const detailParts: string[] = [];
    let added = 0;
    let error: string | undefined;
    if (this.running) {
      const entry: RunLogEntry = { at: new Date().toISOString(), kind, detail: '上一轮仍在运行，跳过' };
      return entry;
    }
    this.running = true;
    try {
      const sources: { label: string; text: string }[] = [];
      const items = [...this.queue.values()];
      this.queue.clear();
      for (const src of items) {
        const text = await this.readSource(src);
        if (text) sources.push({ label: srcLabel(src), text });
      }
      if (!sources.length) {
        const entry: RunLogEntry = { at: new Date().toISOString(), kind, detail: '没有新来源' };
        this.pushLog(entry);
        return entry;
      }
      detailParts.push(`来源 ${sources.length} 个（${sources.map((s) => s.label).join('、')}）`);
      const max = this.engine.prefs.maxAutoEntries;
      const existing = this.digestEntries(60);
      for (const src of sources) {
        if (added >= max) break;
        const cands = await this.extractCandidates(src, existing);
        if (typeof cands === 'string') {
          error = cands;
          continue;
        }
        for (const c of cands.slice(0, max - added)) {
          if (!c.title || !c.content) continue;
          const tags = sanitizeTags(c.tags);
          const r = this.store.add({
            title: c.title.slice(0, 80),
            content: c.content.trim().slice(0, 4000),
            tags,
            importance: clampImportance(c.importance),
            source: `ai:${src.label}`,
            metadata: { by: 'ai-organizer', lane: this.engine.prefs.lane },
          });
          if (!r.merged) added += 1;
        }
      }
      if (added) {
        void this.maybeAutoInject();
        detailParts.push(`新增记忆 ${added} 条`);
        void this.maybeConsolidate();
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.running = false;
    }
    const entry: RunLogEntry = {
      at: new Date().toISOString(),
      kind,
      detail: detailParts.join('；') || '没有新来源',
      ...(added ? { added } : {}),
      ...(error ? { error } : {}),
    };
    this.pushLog(entry);
    this.out?.(`[ai-organize] ${entry.detail}${error ? `，错误: ${error}` : ''}`);
    return entry;
  }

  private async readSource(src: { kind: 'git' | 'chat' | 'editor'; path?: string }): Promise<string> {
    try {
      if (src.kind === 'git' && src.path && this.store.workspaceRoot) {
        const commits = await gitRange(this.store.workspaceRoot, src.path);
        return commits;
      }
      if (src.path) {
        const raw = fs.readFileSync(src.path, 'utf-8');
        if (!raw.trim()) return '';
        const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
        const rel = this.store.workspaceRoot ? path.relative(this.store.workspaceRoot, src.path).replace(/\\/g, '/') : path.basename(src.path);
        const seenMap = this.context.globalState.get<Record<string, string>>(SEEN_HASH_KEY, {});
        if (seenMap[rel] === hash) return '';
        seenMap[rel] = hash;
        await this.context.globalState.update(SEEN_HASH_KEY, seenMap);
        return `【${rel}】\n${raw}`;
      }
    } catch (err) {
      this.out?.(`[ai-organize] 读来源失败 ${src.path ?? src.kind}: ${String(err)}`);
    }
    return '';
  }

  /** 让当前通路 AI 从来源里提炼记忆候选。失败返回错误串。 */
  private async extractCandidates(src: { label: string; text: string }, existing: string): Promise<Candidate[] | string> {
    const ready = await this.engine.ready();
    if (!ready) return 'AI 服务未就绪（未配置源或密钥）';
    const budget = this.engine.prefs.lane === 'offline' ? 2000 : this.engine.prefs.lane === 'online' ? CHAT_BUDGET + 2000 : CHAT_BUDGET;
    const body = clipText(src.text, budget);
    const messages: ChatTurn[] = [
      {
        role: 'system',
        content:
          '你是编程仓库的长记忆提炼引擎。从给出的开发内容（git 提交、AI 聊天记录等）里提炼值得长期记住的记忆条目：' +
          '踩坑教训、技术决策、架构事实、工作流约定、关键 bug 与修法。忽略一次性细节和已有记忆重复的内容。' +
          `标签只能取：${MEMORY_TAGS.join('、')}。` +
          '只输出 JSON 数组，不要解释不要代码围栏，元素形如 ' +
          '{"title":"简短标题","content":"事实化内容，写清结论与原因","tags":["lesson"],"importance":3}。' +
          '没有值得记的就输出 []。最多 5 条。',
      },
      {
        role: 'user',
        content: `【已有记忆摘要（勿重复）】\n${existing}\n\n【开发内容 ${src.label}】\n${body}`,
      },
    ];
    const r = await this.engine.talk(messages);
    if (r.error) return r.error;
    return parseJsonArray<Candidate>(r.text, (row) =>
      Boolean(row && typeof row === 'object' && typeof (row as Candidate).title === 'string' && typeof (row as Candidate).content === 'string')
    );
  }

  // ---------- 自动整理 ----------
  /** 手动触发一次整理（合并/归档/事实化）。 */
  async consolidate(): Promise<RunLogEntry> {
    let ops = 0;
    let error: string | undefined;
    let detail = '';
    try {
      const ready = await this.engine.ready();
      if (!ready) throw new Error('AI 服务未就绪（未配置源或密钥）');
      const entries = this.store.entries.filter((e) => !e.archived);
      if (entries.length < 2) {
        detail = '条目太少，无需整理';
      } else {
        const listing = entries.slice(0, 150).map((e) => {
          const head = e.content.replace(/\s+/g, ' ').slice(0, 120);
          const flag = e.pinned || e.importance >= 5 ? '【保护】' : '';
          return `${e.id}｜${flag}${e.title}｜[${e.tags.join(',')}]｜P${e.importance}｜${head}`;
        });
        const messages: ChatTurn[] = [
          {
            role: 'system',
            content:
              '你是长记忆整理引擎。对给出的记忆条目做去重、合并与归档建议：' +
              '1) 内容重复或高度相近的旧条目建议合并成一条更精炼的新条目；' +
              '2) 已过时、被新事实取代的条目建议归档（给出原因）；' +
              '3) 标了【保护】的条目不要动。' +
              '只输出 JSON 对象，不要解释不要代码围栏，形如 ' +
              '{"merge":[{"ids":["旧条目id"],"title":"合并后标题","content":"合并后精炼内容","tags":["decision"],"importance":4}],' +
              '"archive":[{"id":"条目id","reason":"为什么过时"}],' +
              '"facts":[{"id":"条目id","facts":["原子事实"]}]}。' +
              '没有建议就输出 {}。宁可少动，不确定的不建议。',
          },
          { role: 'user', content: `【记忆条目】\n${listing.join('\n')}` },
        ];
        const r = await this.engine.talk(messages);
        if (r.error) throw new Error(r.error);
        const parsed = parseJsonObject<ConsolidateOps>(r.text);
        ops = this.applyOps(parsed);
        detail = ops ? `应用整理 ${ops} 项` : 'AI 没有给出建议';
        if (ops) void this.maybeAutoInject();
      }
      await this.context.globalState.update(LAST_CONSOLIDATE_KEY, new Date().toISOString());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const entry: RunLogEntry = {
      at: new Date().toISOString(),
      kind: 'consolidate',
      detail: detail || '整理完成',
      ...(ops ? { ops } : {}),
      ...(error ? { error } : {}),
    };
    this.pushLog(entry);
    this.out?.(`[ai-organize] 整理: ${entry.detail}${error ? `，错误: ${error}` : ''}`);
    return entry;
  }

  private applyOps(ops: ConsolidateOps | null): number {
    if (!ops) return 0;
    let applied = 0;
    const byId = new Map(this.store.entries.map((e) => [e.id, e]));
    for (const m of ops.merge ?? []) {
      const targets = (m.ids ?? []).map((id) => byId.get(id)).filter((e): e is NonNullable<typeof e> => Boolean(e) && !e!.pinned && e!.importance < 5);
      if (targets.length < 2 || !m.title || !m.content) continue;
      const r = this.store.add({
        title: String(m.title).slice(0, 80),
        content: String(m.content).trim().slice(0, 4000),
        tags: sanitizeTags(m.tags),
        importance: clampImportance(m.importance),
        source: 'ai:consolidate',
        metadata: { by: 'ai-organizer', mergedFrom: targets.map((t) => t.id).join(',').slice(0, 200) },
      });
      if (!r.merged) {
        for (const t of targets) {
          if (t.id !== r.entry.id) this.store.archive(t.id, true);
        }
        applied += 1;
      }
    }
    for (const a of ops.archive ?? []) {
      const e = byId.get(a.id);
      if (!e || e.pinned || e.importance >= 5 || e.archived) continue;
      this.store.archive(e.id, true);
      applied += 1;
    }
    for (const f of ops.facts ?? []) {
      const e = byId.get(f.id);
      if (!e || !Array.isArray(f.facts)) continue;
      const facts = f.facts.filter((x) => typeof x === 'string' && x.trim()).slice(0, 10);
      if (facts.length && facts.join('|') !== (e.facts ?? []).join('|')) {
        this.store.update(e.id, { facts });
        applied += 1;
      }
    }
    return applied;
  }

  /** 到期自动整理（flush 后顺带检查，不单独起 timer）。 */
  private async maybeConsolidate(): Promise<void> {
    if (!this.engine.prefs.autoConsolidate) return;
    const last = this.context.globalState.get<string>(LAST_CONSOLIDATE_KEY, '');
    const hours = this.engine.prefs.consolidateHours;
    if (last && Date.now() - new Date(last).getTime() < hours * 3600_000) return;
    if (this.store.entries.filter((e) => !e.archived).length < 8) return;
    await this.consolidate();
  }

  private maybeAutoInject(): void {
    const auto = vscode.workspace.getConfiguration('aimemory').get<boolean>('autoInject', true);
    if (!auto) return;
    void vscode.commands.executeCommand('aimemory.inject.generate');
  }

  /** 记忆摘要：给提炼时的「已有记忆」参照，避免重复入库。 */
  private digestEntries(limit: number): string {
    return this.store.entries
      .filter((e) => !e.archived)
      .slice(0, limit)
      .map((e) => `- ${e.title}｜[${e.tags.join(',')}]｜${e.content.replace(/\s+/g, ' ').slice(0, 60)}`)
      .join('\n');
  }
}

// ---------- 纯函数（可单测） ----------
function srcLabel(src: { kind: 'git' | 'chat' | 'editor'; path?: string }): string {
  if (src.kind === 'git') return `git ${src.path ?? ''}`;
  const rel = src.path ? path.basename(src.path) : '';
  return src.kind === 'editor' ? `editor ${rel}` : rel || 'chat';
}

function clipText(text: string, budget: number): string {
  // 按字符粗裁再交给 estimateTokens 校正，避免整段超预算
  if (estimateTokens(text) <= budget) return text;
  return text.slice(0, budget * 3) + '\n…（后文已截断）';
}

function clampImportance(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 3;
}

function sanitizeTags(tags: unknown): string[] {
  const valid = new Set<string>(MEMORY_TAGS);
  const list = Array.isArray(tags) ? tags : [];
  const picked = list.filter((t): t is string => typeof t === 'string' && valid.has(t));
  return picked.length ? picked : ['other'];
}

/** 宽松解析 AI 返回的 JSON 数组：剥围栏、找首个 [ ] 段。 */
export function parseJsonArray<T>(raw: string, keep: (row: unknown) => boolean): T[] {
  const body = String(raw ?? '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const data = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(data) ? (data.filter(keep) as T[]) : [];
  } catch {
    return [];
  }
}

/** 宽松解析 AI 返回的 JSON 对象：找首个 { } 段。 */
export function parseJsonObject<T>(raw: string): T | null {
  const body = String(raw ?? '').replace(/```(?:json)?/gi, '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(body.slice(start, end + 1));
    return data && typeof data === 'object' ? (data as T) : null;
  } catch {
    return null;
  }
}

async function runGit(root: string, args: string[]): Promise<string> {
  const { execFile } = await import('child_process');
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, maxBuffer: 1024 * 1024, timeout: 15_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

async function gitHead(root: string): Promise<string> {
  try {
    return (await runGit(root, ['rev-parse', 'HEAD'])).trim().slice(0, 12);
  } catch {
    return '';
  }
}

/** 取一段提交区间的主题与 stat 摘要（不取全量 diff，控制 token）。 */
async function gitRange(root: string, range: string): Promise<string> {
  try {
    const log = await runGit(root, ['log', '--pretty=format:%h %ad %s', '--date=short', range]);
    const stat = await runGit(root, ['diff', '--stat', range]);
    const names = await runGit(root, ['diff', '--name-status', range]);
    return `【git 提交 ${range}】\n${log}\n【文件变更】\n${names}\n【规模】\n${stat.split('\n').slice(-5).join('\n')}`;
  } catch (err) {
    return `【git 提交 ${range}】（读取失败: ${String(err)}）`;
  }
}
