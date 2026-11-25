/**
 * 激活后在当前仓库跑本机数字人一拍：身份/目标只补缺，风格/简报/叙事按内容变化才写，
 * 守则与焦点进入长记忆并注入。提交说明命令写入草稿文件和 Git 提交框，不执行提交。
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { generateInject } from './inject';
import type { MemoryStore } from './store';
import { disposableMemoryIds } from './agent-learn';
import {
  draftCommitMessage,
  LEGACY_LOCAL_FILES,
  mergeCommitDraft,
  parseGitStatus,
  planTwin,
  type TwinMemory,
} from './twin-local';

const RETIRE_CAP = 2;

const BEAT_MS = 30 * 60 * 1000;
const START_DELAY_MS = 4000;

export function startTwinRuntime(
  store: MemoryStore,
  out?: (line: string) => void,
  notify?: (text: string) => void
): { stop: () => void; beatNow: () => Promise<void>; rebind: () => Promise<void>; draftCommit: () => Promise<void> } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let starter: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;

  const enabled = () => vscode.workspace.getConfiguration('aimemory').get<boolean>('localTwin', true);

  const beat = async (manual = false) => {
    if (stopped || running) return;
    if (!store.ready || !store.workspaceRoot) return;
    if (!manual && !enabled()) return;
    running = true;
    try {
      const root = store.workspaceRoot;
      const goalsText = readText(path.join(root, '.youmengyu', 'memory', 'core', 'goals.md'));
      const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const plan = planTwin({
        day: new Date().toISOString().slice(0, 10),
        hasIdentity: fs.existsSync(path.join(root, '.youmengyu', 'memory', 'core', 'identity.md')),
        hasGoals: fs.existsSync(path.join(root, '.youmengyu', 'memory', 'core', 'goals.md')),
        goalsText,
        samples: collectSamples(root),
        branch: branch === 'HEAD' ? '' : branch,
        sessionTitles: store.entries
          .filter((e) => !e.archived && e.metadata?.kind === 'session')
          .slice(0, 8)
          .map((e) => e.title),
        ruleTitles: store.entries
          .filter(
            (e) =>
              !e.archived &&
              e.metadata?.inject !== 'skip' &&
              e.metadata?.kind !== 'charter' &&
              (e.pinned || e.importance >= 5)
          )
          .slice(0, 5)
          .map((e) => e.title),
        entries: store.entries.map((e) => ({
          id: e.id,
          content: e.content,
          pinned: e.pinned,
          archived: e.archived,
          importance: e.importance,
          uses: e.uses,
          updatedAt: e.updatedAt,
          versionCount: e.versions?.length || 0,
        })),
      });
      let changed = 0;
      for (const file of plan.files) {
        const abs = path.join(root, file.rel);
        if (file.ifMissing && fs.existsSync(abs)) continue;
        if (readText(abs) === file.content) continue;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, file.content, 'utf8');
        changed += 1;
      }
      for (const rel of LEGACY_LOCAL_FILES) {
        const abs = path.join(root, rel);
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
      }
      for (const mem of plan.memories) {
        if (upsertKind(store, mem)) changed += 1;
      }
      for (const id of retireIds(plan.archiveIds, store)) {
        store.archive(id, true);
        changed += 1;
      }
      if (changed > 0 && vscode.workspace.getConfiguration('aimemory').get<boolean>('autoInject', true)) {
        await generateInject(store, { silent: !manual });
      }
      out?.(`[twin] 本机一拍完成，变更 ${changed}`);
      if (manual) notify?.(`本机一拍完成，更新 ${changed} 处`);
    } catch (err) {
      out?.(`[twin] 本机一拍失败: ${String(err)}`);
      if (manual) notify?.(`本机一拍失败 ${String(err)}`);
    } finally {
      running = false;
    }
  };

  const draftCommit = async () => {
    const root = store.workspaceRoot;
    if (!root || !store.ready) {
      notify?.('请先打开一个工作区');
      return;
    }
    const porcelain = await git(root, ['status', '--porcelain']);
    const draft = draftCommitMessage(parseGitStatus(porcelain));
    const file = path.join(root, '.youmengyu', 'runs', 'scm-commit-msg.txt');
    const box = await gitInputBox(root);
    const base = (box?.value ?? '').trim().length >= readText(file).trim().length ? box?.value ?? '' : readText(file);
    const merged = mergeCommitDraft(base, draft);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, merged, 'utf8');
    if (box) box.value = merged;
    notify?.(
      box
        ? '提交说明已写入 Changes 框，请按本次原因改一句再提交'
        : '提交说明已写入 .youmengyu/runs/scm-commit-msg.txt'
    );
    out?.('[twin] 已起草提交说明');
  };

  starter = setTimeout(() => void beat(false), START_DELAY_MS);
  timer = setInterval(() => void beat(false), BEAT_MS);
  out?.('[twin] 本机数字人已接管：守则、焦点、风格、简报、叙事、提交说明');

  return {
    stop() {
      stopped = true;
      if (starter) clearTimeout(starter);
      if (timer) clearInterval(timer);
    },
    beatNow: () => beat(true),
    rebind: () => beat(false),
    draftCommit,
  };
}

function retireIds(archiveIds: string[], store: MemoryStore): string[] {
  const ids: string[] = [];
  const push = (id: string) => {
    if (!id || ids.length >= RETIRE_CAP || ids.includes(id)) return;
    ids.push(id);
  };
  for (const id of archiveIds) push(id);
  if (ids.length >= RETIRE_CAP) return ids;
  const extra = disposableMemoryIds(
    store.entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      importance: entry.importance,
      pinned: entry.pinned,
      archived: entry.archived,
      source: entry.source,
      metadata: entry.metadata,
      updatedAt: entry.updatedAt,
    })),
    RETIRE_CAP
  );
  for (const id of extra) push(id);
  return ids;
}

function upsertKind(store: MemoryStore, mem: TwinMemory): boolean {
  const prev = store.entries.find((e) => !e.archived && e.metadata?.twin === 'local' && e.metadata?.kind === mem.kind);
  if (!prev) {
    const r = store.add({
      title: mem.title,
      content: mem.content,
      tags: mem.tags,
      importance: mem.importance,
      pinned: mem.pinned,
      space: mem.space,
      source: 'twin-local',
      metadata: mem.metadata,
    });
    return !r.merged;
  }
  if (
    prev.content === mem.content &&
    prev.title === mem.title &&
    prev.importance === mem.importance &&
    Boolean(prev.pinned) === Boolean(mem.pinned)
  ) {
    return false;
  }
  store.update(prev.id, {
    title: mem.title,
    content: mem.content,
    tags: mem.tags,
    importance: mem.importance,
    pinned: mem.pinned,
    space: mem.space,
    metadata: { ...prev.metadata, ...mem.metadata },
  });
  return true;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function collectSamples(root: string): { name: string; text: string }[] {
  const skip = new Set(['node_modules', 'dist', '.git', '.youmengyu', 'coverage', 'out', 'media', '.vscode']);
  const ok = /\.(ts|tsx|js|mjs|vue)$/;
  const samples: { name: string; text: string }[] = [];
  const queue = [root];
  while (queue.length && samples.length < 8) {
    const dir = queue.shift()!;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (samples.length >= 8) break;
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (skip.has(name) || name.startsWith('.')) continue;
        const depth = abs.split(path.sep).length - root.split(path.sep).length;
        if (depth > 4) continue;
        queue.push(abs);
      } else if (ok.test(name) && st.size > 0 && st.size < 200_000) {
        try {
          samples.push({ name, text: fs.readFileSync(abs, 'utf8').slice(0, 6000) });
        } catch {
          /* 单文件读失败跳过 */
        }
      }
    }
  }
  return samples;
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout: 8000, windowsHide: true, maxBuffer: 1_000_000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout ?? ''));
    });
  });
}

async function gitInputBox(root: string): Promise<{ value: string } | undefined> {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (ext && !ext.isActive) await ext.activate();
    const api = ext?.exports?.getAPI?.(1) as
      | { repositories?: { rootUri?: { fsPath?: string }; inputBox?: { value: string } }[] }
      | undefined;
    const repos = api?.repositories ?? [];
    const repo =
      repos.find((r) => r.rootUri?.fsPath && path.resolve(r.rootUri.fsPath) === path.resolve(root)) ?? repos[0];
    return repo?.inputBox;
  } catch {
    return undefined;
  }
}
