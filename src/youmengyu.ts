/**
 * 游梦鱼数字人 .youmengyu 记忆目录解析器。
 *
 * 数据源是数字人仓库（默认 D:/Web/asaiwebagent）下的 .youmengyu/memory/**，分层为：
 * - core/identity.md、core/goals.md —— 身份与目标（置顶导入）
 * - semantic/*.md —— 教训、偏好、项目记忆、反思（lessons.md 按时间戳分节逐条导入）
 * - procedural/*.md —— 流程教训（文件名即标题，取 score/ts 最新块为正文）
 * - repo.md —— 仓库架构记忆
 * - evolution/wisdom.md、evolution/narrative.md —— 智慧与叙事
 * - episodic/*.jsonl、bus.jsonl 等运行流水不导入（操作日志，价值低且噪音大）
 *
 * 本文件保持纯函数（不 import vscode），便于 node --test 回归锁。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 数字人记忆导入的目标空间名 */
export const YOUMENGYU_SPACE = '数字人';

/** 数字人仓库默认根目录 */
export const DEFAULT_YOUMENGYU_ROOT = 'D:/Web/asaiwebagent';

/** 导入后的单条最短正文长度（短句也可能是关键约定，只挡明显的空/噪声行） */
const MIN_CONTENT_LEN = 4;

export interface YoumengyuEntry {
  title: string;
  content: string;
  tags: string[];
  importance: number;
  pinned?: boolean;
  source?: string;
  metadata?: Record<string, string>;
}

export interface YoumengyuCollectResult {
  entries: YoumengyuEntry[];
  /** 读到的来源文件数（便于提示） */
  files: number;
}

function clean(text: string): string {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function truncate(s: string, n = 40): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** 取第一个 markdown 标题文本作为候选标题 */
function firstHeading(text: string): string | undefined {
  const m = clean(text).match(/^#{1,3}\s+(.+)$/m);
  return m ? m[1].trim() : undefined;
}

/** 正文首行有效句（跳过标题、失败流水行、复盘元数据行），用于生成标题 */
function firstMeaningfulLine(text: string): string | undefined {
  const isFailure = (l: string) => /^[-*+]?\s*失败：/.test(l);
  const isMeta = (l: string) => /^(来源|类型|理由|原因|说明)：/.test(l);
  for (const raw of clean(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (isFailure(line) || isMeta(line)) continue;
    return line.replace(/^[-*+]\s*/, '');
  }
  // 全是失败流水时退回失败摘要本身（比时间戳标题有意义）
  const failure = clean(text)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => isFailure(l));
  if (failure) return `失败：${failure.replace(/^[-*+]?\s*失败：/, '').trim()}`;
  return undefined;
}

function relPath(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, '/');
}

function makeEntry(
  root: string,
  file: string,
  content: string,
  tags: string[],
  importance: number,
  pinned?: boolean
): YoumengyuEntry | undefined {
  const body = clean(content);
  if (body.length < MIN_CONTENT_LEN) return undefined;
  return {
    title: truncate(firstHeading(body) || path.basename(file, '.md'), 60),
    content: body,
    tags,
    importance,
    pinned,
    source: relPath(root, file),
    metadata: { 来源: '游梦鱼数字人', 文件: relPath(root, file) },
  };
}

/**
 * 解析 lessons.md：按 `## 时间戳 [来源]` 分节，每节一条教训。
 * 头行形如 `2026-11-24T04:55:54.644Z [learn, codebuddy]`。
 * 只有日期开头的 `##` 行才算新分节——正文里嵌套的 `## 任务`/`## 验收` 属于本节内容。
 */
export function parseLessonsSections(text: string): Array<{ header: string; body: string }> {
  const out: Array<{ header: string; body: string }> = [];
  const lines = clean(text).split('\n');
  let header = '';
  let body: string[] = [];
  const flush = () => {
    const b = body.join('\n').trim();
    if (header && b) out.push({ header, body: b });
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2}.*)$/);
    if (m) {
      flush();
      header = m[1].trim();
      body = [];
    } else if (header) {
      body.push(line);
    }
  }
  flush();
  return out;
}

/**
 * 解析 procedural 教训文件：块由 `--- score: x ts: ... ---` 分隔，取 ts 最新的块为正文。
 * 同文重复块只保留一条（保留最新那份，避免历史结论把新结论盖掉）。
 */
export function parseProceduralBody(text: string): string {
  const raw = clean(text);
  interface Block {
    body: string;
    ts: string;
    score: number;
  }
  const blocks: Block[] = [];
  let body: string[] = [];
  let ts = '';
  let score = -1;
  const flush = () => {
    const content = body.join('\n').trim();
    if (content) blocks.push({ body: content, ts, score });
    body = [];
    ts = '';
    score = -1;
  };
  for (const line of raw.split('\n')) {
    const meta = line.match(/^---\s*(.*?)\s*---\s*$/);
    if (meta) {
      flush();
      const info = meta[1] || '';
      ts = info.match(/ts:\s*([^\s]+)/)?.[1] || '';
      const n = Number(info.match(/score:\s*([\d.]+)/)?.[1]);
      score = Number.isFinite(n) ? n : -1;
      continue;
    }
    body.push(line);
  }
  flush();
  if (!blocks.length) return raw;

  const unique = new Map<string, Block>();
  for (const b of blocks) {
    const key = b.body.toLowerCase().replace(/\s+/g, ' ');
    const prev = unique.get(key);
    if (!prev || (b.ts && b.ts > prev.ts) || (!prev.ts && b.score > prev.score)) unique.set(key, b);
  }
  const list = [...unique.values()].sort(
    (a, b) => (b.ts || '').localeCompare(a.ts || '') || b.score - a.score
  );
  return list[0].body;
}

function semanticTagsFor(name: string): { tags: string[]; importance: number } {
  if (/^user-preferences|^pref\b/.test(name)) return { tags: ['preference'], importance: 4 };
  if (/^project-/.test(name)) return { tags: ['architecture'], importance: 4 };
  if (/test-pitfalls/.test(name)) return { tags: ['lesson'], importance: 4 };
  if (/lessons/.test(name)) return { tags: ['lesson'], importance: 4 };
  return { tags: ['fact'], importance: 3 };
}

function readIfExists(file: string): string | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const text = clean(fs.readFileSync(file, 'utf-8'));
    return text || undefined;
  } catch {
    return undefined;
  }
}

function readMdDir(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      const file = path.join(dir, name);
      const text = readIfExists(file);
      if (text) out.push({ file, text });
    }
  } catch {
    // 目录不可读则跳过
  }
  return out;
}

/**
 * 收集数字人 .youmengyu/memory 下的全部可导入条目。
 * 幂等：同内容重复导入由 store.add 按归一化正文合并。
 */
export function collectYoumengyuEntries(root: string): YoumengyuCollectResult {
  const memDir = path.join(root, '.youmengyu', 'memory');
  const entries: YoumengyuEntry[] = [];
  let files = 0;

  const push = (file: string, content: string, tags: string[], importance: number, pinned?: boolean) => {
    files += 1;
    const e = makeEntry(root, file, content, tags, importance, pinned);
    if (e) entries.push(e);
  };

  // core：身份与目标（置顶）
  const identity = readIfExists(path.join(memDir, 'core', 'identity.md'));
  if (identity) push(path.join(memDir, 'core', 'identity.md'), identity, ['preference'], 5, true);
  const goals = readIfExists(path.join(memDir, 'core', 'goals.md'));
  if (goals) push(path.join(memDir, 'core', 'goals.md'), goals, ['decision'], 5, true);

  // semantic：lessons.md 分节逐条；其余每文件一条
  for (const { file, text } of readMdDir(path.join(memDir, 'semantic'))) {
    const name = path.basename(file, '.md');
    if (name === 'lessons') {
      for (const sec of parseLessonsSections(text)) {
        files += 1;
        const host = sec.header.match(/\[([^\]]+)\]/)?.[1] || '';
        const body = sec.body.trim();
        if (body.length < MIN_CONTENT_LEN) continue;
        entries.push({
          title: truncate(firstMeaningfulLine(body) || `教训 ${sec.header}`, 60),
          content: body,
          tags: ['lesson'],
          importance: 4,
          source: relPath(root, file),
          metadata: { 来源: '游梦鱼数字人', 文件: relPath(root, file), 片段: sec.header, 宿主: host },
        });
      }
      continue;
    }
    const { tags, importance } = semanticTagsFor(name);
    push(file, text, tags, importance);
  }

  // procedural：文件名即标题，正文取最新块
  for (const { file, text } of readMdDir(path.join(memDir, 'procedural'))) {
    const name = path.basename(file, '.md');
    const isWorkflow = /^(fix-bug|playbook|workflow)/i.test(name);
    push(file, parseProceduralBody(text), isWorkflow ? ['workflow'] : ['lesson'], 4);
  }

  // 仓库架构记忆
  const repo = readIfExists(path.join(memDir, 'repo.md'));
  if (repo) push(path.join(memDir, 'repo.md'), repo, ['architecture'], 4);

  // evolution：智慧与叙事
  const wisdom = readIfExists(path.join(memDir, 'evolution', 'wisdom.md'));
  if (wisdom) push(path.join(memDir, 'evolution', 'wisdom.md'), wisdom, ['lesson'], 3);
  const narrative = readIfExists(path.join(memDir, 'evolution', 'narrative.md'));
  if (narrative) push(path.join(memDir, 'evolution', 'narrative.md'), narrative, ['fact'], 3);

  return { entries, files };
}
