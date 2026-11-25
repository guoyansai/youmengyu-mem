/**
 * 插件激活后自动记住当前工作区 Agent 的对话，并写回注入块辅助下一轮编程。
 * 对话目录在本机 ~/.cursor/projects/<仓库>/agent-transcripts，不在仓库里，所以用 fs.watch 而不是工作区 watcher。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  agentTranscriptDir,
  collectTranscriptFiles,
  distillTurns,
  planLearn,
  pickTranscriptBatch,
  parseTranscript,
  ruleKey,
  transcriptSettled,
  type ExistingMemory,
  type LearnAction,
  type LearnDraft,
  type TranscriptCursor,
} from './agent-learn';
import { generateInject } from './inject';
import type { MemoryStore } from './store';
import { DEFAULT_STORAGE_DIR } from './store';

const BATCH = 8;
const POLL_MS = 20_000;
const MAX_READ = 1_500_000;

export function startAgentMemory(
  store: MemoryStore,
  _context: vscode.ExtensionContext,
  out?: (line: string) => void
): { stop: () => void; rebind: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let starter: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let announced = '';

  const armWatch = (dir: string) => {
    if (watcher) return;
    if (!fs.existsSync(dir)) return;
    try {
      watcher = fs.watch(dir, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void tick(), 3000);
      });
    } catch (err) {
      out?.(`[agent] 监听对话目录失败: ${String(err)}`);
    }
  };

  const tick = async () => {
    if (stopped || running) return;
    if (!store.ready || !store.workspaceRoot) return;
    if (!vscode.workspace.getConfiguration('aimemory').get<boolean>('autoAgentMemory', true)) return;
    running = true;
    try {
      const root = store.workspaceRoot;
      const dir = agentTranscriptDir(root, os.homedir());
      if (announced !== dir) {
        announced = dir;
        out?.(`[agent] 已开启当前 Agent 对话记忆 ${dir}`);
      }
      armWatch(dir);
      const files = collectTranscriptFiles(dir);
      const cursors = readCursors(cursorPath(store));
      const now = Date.now();
      const batch = pickTranscriptBatch(files, cursors, BATCH, now);
      let changed = 0;
      for (const file of batch) {
        try {
          const raw = readTranscript(file.file, file.size);
          const turns = parseTranscript(raw);
          const settled = transcriptSettled(raw, file.mtimeMs, now);
          const drafts = distillTurns(turns, file.sessionId, { includeSession: settled || turns.length === 0 });
          const prev = cursors[file.file] ?? { size: 0, mtimeMs: 0, sessionWritten: false, ruleKeys: [] };
          const known = new Set(prev.ruleKeys);
          const fresh = drafts.filter((d) => d.kind === 'session' || !known.has(ruleKey(d.content)));
          const actions = planLearn(fresh, snapshot(store));
          changed += applyLearn(store, actions);
          const ruleKeys = prev.ruleKeys.slice();
          for (const d of fresh) {
            if (d.kind !== 'rule') continue;
            const k = ruleKey(d.content);
            if (!ruleKeys.includes(k)) ruleKeys.push(k);
          }
          cursors[file.file] = {
            size: file.size,
            mtimeMs: file.mtimeMs,
            sessionWritten: settled || turns.length === 0,
            ruleKeys: ruleKeys.slice(-40),
          };
        } catch (err) {
          out?.(`[agent] 读取对话失败 ${file.sessionId}: ${String(err)}`);
        }
      }
      if (batch.length) writeCursors(cursorPath(store), cursors);
      if (changed > 0 && vscode.workspace.getConfiguration('aimemory').get<boolean>('autoInject', true)) {
        await generateInject(store, { silent: true });
        out?.(`[agent] 长记忆已更新 ${changed} 处，并写回注入块供 Agent 使用`);
      }
    } catch (err) {
      out?.(`[agent] 对话记忆本轮失败: ${String(err)}`);
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), POLL_MS);
  // 首轮扫描会读对话文件。让开激活，侧边栏视图先完成注册和首帧。
  starter = setTimeout(() => void tick(), 1500);

  return {
    stop() {
      stopped = true;
      if (starter) clearTimeout(starter);
      if (timer) clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      watcher = undefined;
    },
    rebind() {
      watcher?.close();
      watcher = undefined;
      announced = '';
      void tick();
    },
  };
}

function snapshot(store: MemoryStore): ExistingMemory[] {
  return store.entries.map((e) => ({
    id: e.id,
    title: e.title,
    content: e.content,
    importance: e.importance,
    pinned: e.pinned,
    archived: e.archived,
    source: e.source,
    metadata: e.metadata,
  }));
}

function applyLearn(store: MemoryStore, actions: LearnAction[]): number {
  let changed = 0;
  for (const action of actions) {
    if (action.op === 'add') {
      const r = store.add(toInput(action.draft));
      if (!r.merged) changed += 1;
      continue;
    }
    if (action.op === 'update-session') {
      const cur = store.entries.find((e) => e.id === action.id);
      if (!cur) continue;
      store.update(action.id, {
        title: action.draft.title,
        content: action.draft.content,
        tags: action.draft.tags,
        importance: action.draft.importance,
        metadata: { ...cur.metadata, ...action.draft.metadata },
      });
      changed += 1;
      continue;
    }
    if (action.op === 'strengthen') {
      store.update(action.id, { importance: action.importance });
      store.touch(action.id);
      changed += 1;
      continue;
    }
    store.touch(action.id);
  }
  return changed;
}

function toInput(draft: LearnDraft) {
  return {
    title: draft.title,
    content: draft.content,
    tags: draft.tags,
    importance: draft.importance,
    source: draft.source,
    space: draft.space,
    metadata: draft.metadata,
  };
}

function cursorPath(store: MemoryStore): string {
  const root = store.workspaceRoot ?? '';
  const sub = vscode.workspace.getConfiguration('aimemory').get<string>('storageDir', DEFAULT_STORAGE_DIR);
  return path.join(root, sub, '.local', 'agent-cursors.json');
}

function readCursors(file: string): Record<string, TranscriptCursor> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, TranscriptCursor>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeCursors(file: string, cursors: Record<string, TranscriptCursor>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursors), 'utf-8');
  fs.renameSync(tmp, file);
}

function readTranscript(file: string, size: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    if (size <= MAX_READ) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return buf.toString('utf8');
    }
    const buf = Buffer.alloc(MAX_READ);
    fs.readSync(fd, buf, 0, MAX_READ, Math.max(0, size - MAX_READ));
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}
