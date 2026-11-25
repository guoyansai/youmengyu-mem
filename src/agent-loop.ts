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
  LEARN_WRITE_BUDGET,
  planLearn,
  pickTranscriptBatch,
  parseTranscript,
  ruleKey,
  takeLearnWrites,
  transcriptSettled,
  type ExistingMemory,
  type LearnAction,
  type LearnDraft,
  type TranscriptCursor,
} from './agent-learn';
import { generateInject } from './inject';
import type { MemoryStore } from './store';
import { DEFAULT_STORAGE_DIR } from './store';

const BATCH = 2;
const POLL_MS = 20_000;
const WRITE_GAP_MS = 10 * 60 * 1000;
const HOT_MS = 2 * 60 * 1000;
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
  let lastMutate = 0;

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
      const pool = now - lastMutate >= WRITE_GAP_MS ? files : files.filter((f) => now - f.mtimeMs <= HOT_MS);
      const batch = pickTranscriptBatch(pool, cursors, BATCH, now);
      let changed = 0;
      let budget = LEARN_WRITE_BUDGET;
      let cursorDirty = false;
      for (const file of batch) {
        if (budget <= 0) break;
        try {
          const raw = readTranscript(file.file, file.size);
          const turns = parseTranscript(raw);
          const settled = transcriptSettled(raw, file.mtimeMs, now);
          const prev = cursors[file.file] ?? { size: 0, mtimeMs: 0, sessionWritten: false, ruleKeys: [] };
          if (!settled) continue;
          if (!turns.length) {
            cursors[file.file] = {
              size: file.size,
              mtimeMs: file.mtimeMs,
              sessionWritten: true,
              ruleKeys: prev.ruleKeys,
            };
            cursorDirty = true;
            continue;
          }
          const drafts = distillTurns(turns, file.sessionId, { includeSession: true });
          const known = new Set(prev.ruleKeys);
          const fresh = drafts.filter((d) => d.kind === 'session' || !known.has(ruleKey(d.content)));
          const sessionCooling = prev.sessionWritten && now - lastMutate < WRITE_GAP_MS;
          const learnDrafts = sessionCooling ? fresh.filter((d) => d.kind !== 'session') : fresh;
          const actions = planLearn(learnDrafts, snapshot(store));
          const picked = takeLearnWrites(actions, budget);
          changed += applyLearn(store, picked.taken);
          budget -= picked.taken.filter((action) => action.op !== 'touch').length;
          const done = new Set(picked.taken.map((action) => action.key));
          const ruleKeys = prev.ruleKeys.slice();
          for (const draft of fresh) {
            if (draft.kind !== 'rule') continue;
            const key = ruleKey(draft.content);
            if (!done.has(key) || ruleKeys.includes(key)) continue;
            ruleKeys.push(key);
          }
          const wroteSession = picked.taken.some(
            (action) => action.op === 'update-session' || (action.op === 'add' && action.draft.kind === 'session')
          );
          const sessionWritten = prev.sessionWritten || wroteSession || !fresh.some((d) => d.kind === 'session');
          const hold =
            picked.deferred.length > 0 || (sessionCooling && fresh.some((d) => d.kind === 'session') && !wroteSession);
          cursors[file.file] = hold
            ? { size: prev.size, mtimeMs: prev.mtimeMs, sessionWritten, ruleKeys: ruleKeys.slice(-40) }
            : { size: file.size, mtimeMs: file.mtimeMs, sessionWritten: true, ruleKeys: ruleKeys.slice(-40) };
          cursorDirty = true;
        } catch (err) {
          out?.(`[agent] 读取对话失败 ${file.sessionId}: ${String(err)}`);
        }
      }
      if (cursorDirty) writeCursors(cursorPath(store), cursors);
      if (changed > 0) {
        lastMutate = Date.now();
        if (vscode.workspace.getConfiguration('aimemory').get<boolean>('autoInject', true)) {
          await generateInject(store, { silent: true });
          out?.(`[agent] 长记忆已更新 ${changed} 处，并写回注入块供 Agent 使用`);
        }
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
