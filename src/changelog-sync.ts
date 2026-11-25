/**
 * 扫描 git 提交和本机 Agent 对话，按小时写 CHANGELOG.md 与 CHANGELOG+用户名.md。
 * 不依赖 vscode，打包脚本和插件激活都能调用。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentTranscriptDir } from './agent-learn';
import {
  applyPoints,
  hourBucket,
  parseGitLog,
  personalChangelogName,
  planPoints,
  pointsForPersonal,
  stampHourVersion,
  type LogPoint,
} from './changelog-log';

const DAY_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FILES = 20;
const MAX_READ = 400_000;

export interface SyncResult {
  user: string;
  personalFile: string;
  addedFull: number;
  addedPersonal: number;
  stamped: string;
}

function gitText(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1_000_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function listTranscripts(root: string, homeDir: string, now: number): { mtimeMs: number; text: string }[] {
  const dir = agentTranscriptDir(root, homeDir);
  if (!fs.existsSync(dir)) return [];
  const found: { file: string; mtimeMs: number }[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 3) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(current, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.endsWith('.jsonl') && now - st.mtimeMs <= DAY_MS) found.push({ file: full, mtimeMs: st.mtimeMs });
    }
  };
  walk(dir, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, MAX_FILES).map((item) => {
    let text = '';
    try {
      const fd = fs.openSync(item.file, 'r');
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, MAX_READ);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, Math.max(0, size - length));
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch {
      text = '';
    }
    return { mtimeMs: item.mtimeMs, text };
  });
}

function countNew(before: string, after: string): number {
  const had = new Set(before.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- ')));
  let n = 0;
  for (const line of after.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') && !had.has(trimmed)) n += 1;
  }
  return n;
}

function writeIfChanged(file: string, before: string, after: string): void {
  if (before === after) return;
  fs.writeFileSync(file, after, 'utf8');
}

export function collectPoints(root: string, now = new Date(), homeDir = os.homedir()): { user: string; points: LogPoint[] } {
  const user = gitText(root, ['config', '--get', 'user.name']).trim();
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const log = gitText(root, [
    'log',
    '-n',
    '80',
    `--since=${since}`,
    '--pretty=format:%an%x1f%aI%x1f%s%x1f%b%x1e',
  ]);
  const commits = parseGitLog(log).filter((commit) => {
    const when = new Date(commit.date).getTime();
    return !Number.isNaN(when) && now.getTime() - when <= DAY_MS;
  });
  const points = planPoints({ user, commits, transcripts: listTranscripts(root, homeDir, now.getTime()) });
  return { user, points };
}

/** 合并内容点。stampVersion 有值时再给当前小时标上版本号。 */
export function syncChangelogs(root: string, opts?: { now?: Date; homeDir?: string; stampVersion?: string }): SyncResult {
  const now = opts?.now || new Date();
  const { user, points } = collectPoints(root, now, opts?.homeDir || os.homedir());
  const fullPath = path.join(root, 'CHANGELOG.md');
  const beforeFull = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
  let nextFull = applyPoints(beforeFull, points);
  let stamped = '';
  if (opts?.stampVersion) {
    const hour = hourBucket(now);
    nextFull = stampHourVersion(nextFull, opts.stampVersion, hour);
    stamped = `${hour} · v${opts.stampVersion}`;
  }
  if (nextFull && nextFull !== beforeFull) writeIfChanged(fullPath, beforeFull, nextFull);
  else if (!beforeFull && nextFull) writeIfChanged(fullPath, '', nextFull);

  const personalName = personalChangelogName(user);
  let addedPersonal = 0;
  if (personalName) {
    const personalPath = path.join(root, personalName);
    const beforePersonal = fs.existsSync(personalPath) ? fs.readFileSync(personalPath, 'utf8') : '';
    const title = `# 更新日志 · ${user.trim()}`;
    let nextPersonal = applyPoints(beforePersonal, pointsForPersonal(points, user), title);
    if (opts?.stampVersion) nextPersonal = stampHourVersion(nextPersonal, opts.stampVersion, hourBucket(now), title);
    if (!beforePersonal.trim() && nextPersonal.trim()) {
      nextPersonal = nextPersonal.replace(
        title,
        `${title}\n\n按小时记录 AI 工作和个人更新。完整日志见 CHANGELOG.md。`
      );
    }
    if (nextPersonal !== beforePersonal) writeIfChanged(personalPath, beforePersonal, nextPersonal);
    addedPersonal = countNew(beforePersonal, nextPersonal);
  }
  return {
    user,
    personalFile: personalName,
    addedFull: countNew(beforeFull, nextFull),
    addedPersonal,
    stamped,
  };
}

export function startChangelogSync(root: string, out?: (line: string) => void): { stop: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let starter: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped) return;
    try {
      const result = syncChangelogs(root);
      if (result.addedFull || result.addedPersonal) {
        out?.(
          `[changelog] 已按小时写入更新日志${result.personalFile ? ` 与 ${result.personalFile}` : ''}（完整 +${result.addedFull}，个人 +${result.addedPersonal}）`
        );
      }
    } catch (err) {
      out?.(`[changelog] 写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  starter = setTimeout(() => {
    run();
    timer = setInterval(run, 3 * 60 * 1000);
  }, 4000);
  return {
    stop: () => {
      stopped = true;
      if (starter) clearTimeout(starter);
      if (timer) clearInterval(timer);
    },
  };
}
