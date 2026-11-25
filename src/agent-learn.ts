/**
 * 当前 Agent 对话 → 长记忆（纯函数，不依赖 vscode）。
 *
 * - 每段对话收成一条可检索的会话记忆（不进注入块，避免聊天挤掉项目规则）。
 * - 用户约定 / 助手结论里值得长期记住的句子另写为规则记忆，重复出现则提高重要性。
 * 安装插件后由 agent-loop 自动跑，不需要主人再点命令。
 */
import * as fs from 'fs';
import * as path from 'path';

const RULE_CUE = /必须|禁止|不要|勿|一律|务必|不能|不允许|红线|偏好|记住/;
const LESSON_CUE = /教训|根因|结论/;
const PROGRESS_CUE = /^(我|咱们|我们)?(先看|先读|先摸|接下来|下面|开始|让我|我会|我先)/;
const NOISE_CUE = /briefly inform the user|perform any follow-up actions/i;

/** 同时在写的记忆文件上限。会话留档和规则分开计数，多出来的不再新建文件。 */
export const MAX_SESSION_FILES = 8;
export const MAX_RULE_FILES = 24;
/** 每一拍最多改写这么多个记忆文件（新建、改写、提高重要度都算）。 */
export const LEARN_WRITE_BUDGET = 2;

export type Turn = { role: 'user' | 'assistant'; text: string };

export type LearnDraft = {
  kind: 'session' | 'rule';
  title: string;
  content: string;
  tags: string[];
  importance: number;
  source: string;
  space: string;
  metadata: Record<string, string>;
};

export type ExistingMemory = {
  id: string;
  title: string;
  content: string;
  importance: number;
  pinned?: boolean;
  archived?: boolean;
  source?: string;
  metadata?: Record<string, string>;
};

export type LearnAction =
  | { op: 'add'; draft: LearnDraft; key: string }
  | { op: 'update-session'; id: string; draft: LearnDraft; key: string }
  | { op: 'strengthen'; id: string; importance: number; key: string }
  | { op: 'touch'; id: string; key: string };

export type RetireRef = ExistingMemory & { updatedAt?: string };

export type TranscriptFile = {
  file: string;
  sessionId: string;
  mtimeMs: number;
  size: number;
};

export type TranscriptCursor = {
  size: number;
  mtimeMs: number;
  sessionWritten: boolean;
  ruleKeys: string[];
};

/** Cursor 项目目录名：D:\\Web\\aicodingmem → d-Web-aicodingmem（只把盘符小写，其余保持原样） */
export function workspaceSlug(root: string): string {
  const norm = path.resolve(root).replace(/\\/g, '/');
  const stripped = norm.replace(/^([A-Za-z]):/, (_m, drive: string) => drive.toLowerCase()).replace(/^\/+/, '');
  return stripped.replace(/\/+/g, '-');
}

/** 当前工作区在本机 Cursor 里的 Agent 对话目录 */
export function agentTranscriptDir(workspaceRoot: string, homeDir: string): string {
  return path.join(homeDir, '.cursor', 'projects', workspaceSlug(workspaceRoot), 'agent-transcripts');
}

export function ruleKey(content: string): string {
  return normText(content).slice(0, 180);
}

export function redact(text: string): string {
  return String(text ?? '')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[私钥已省略]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[密钥已省略]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[密钥已省略]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[已省略]');
}

/** 从 jsonl 里取出用户与助手的正文，丢掉工具调用和 turn_ended */
export function parseTranscript(raw: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of String(raw ?? '').split(/\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let row: { role?: string; type?: string; message?: { content?: unknown } };
    try {
      row = JSON.parse(t);
    } catch {
      continue;
    }
    if (row.type === 'turn_ended') continue;
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const text = contentText(row.message?.content);
    if (!text.trim()) continue;
    const cleaned = row.role === 'user' ? unwrapUser(text) : prose(text);
    if (!cleaned.trim()) continue;
    turns.push({ role: row.role, text: redact(cleaned.trim()) });
  }
  return turns;
}

export function distillTurns(turns: Turn[], sessionId: string, opts?: { includeSession?: boolean }): LearnDraft[] {
  if (!turns.length) return [];
  const drafts: LearnDraft[] = [];
  if (opts?.includeSession !== false) drafts.push(sessionDraft(turns, sessionId));
  const seen = new Set<string>();
  const pushRule = (sent: string, from: 'user' | 'assistant') => {
    const key = ruleKey(sent);
    if (!key || seen.has(key)) return;
    seen.add(key);
    drafts.push(ruleDraft(sent, sessionId, from));
  };
  let userN = 0;
  let assistantN = 0;
  for (const turn of turns) {
    if (turn.role === 'assistant' && userN > 0) continue;
    const limit = 1;
    const got = turn.role === 'user' ? userN : assistantN;
    if (got >= limit) continue;
    for (const sent of sentences(turn.text)) {
      if (!keepSentence(sent, turn.role)) continue;
      pushRule(sent, turn.role);
      if (turn.role === 'user') userN += 1;
      else assistantN += 1;
      if ((turn.role === 'user' ? userN : assistantN) >= limit) break;
    }
  }
  return drafts;
}

/**
 * 对照已有记忆决定：新增、更新会话、或把重复约定的重要性 +1（上限 5）。
 * 同一条已在正文里且已是 P5 时只记一次命中，不再改写文件。
 */
export function planLearn(drafts: LearnDraft[], existing: ExistingMemory[]): LearnAction[] {
  const actions: LearnAction[] = [];
  const strengthened = new Set<string>();
  let sessions = existing.filter((e) => !e.archived && e.metadata?.kind === 'session').length;
  let rules = existing.filter((e) => !e.archived && e.metadata?.kind === 'rule').length;
  for (const draft of drafts) {
    const key = actionKey(draft);
    if (draft.kind === 'session') {
      const prev = existing.find(
        (e) => e.source === draft.source && e.metadata?.kind === 'session' && !e.archived
      );
      if (!prev) {
        if (sessions >= MAX_SESSION_FILES) continue;
        sessions += 1;
        actions.push({ op: 'add', draft, key });
      } else if (normText(prev.content) !== normText(draft.content) || prev.title !== draft.title) {
        actions.push({ op: 'update-session', id: prev.id, draft, key });
      }
      continue;
    }
    let best: ExistingMemory | undefined;
    let bestScore = 0;
    for (const e of existing) {
      if (e.archived || e.metadata?.inject === 'skip' || e.metadata?.kind === 'session') continue;
      const score = memoryScore(draft.content, `${e.title}\n${e.content}`);
      if (score >= 0.62 && score > bestScore) {
        best = e;
        bestScore = score;
      }
    }
    if (best) {
      const hit = reinforce(best, strengthened);
      if (hit.op === 'touch') actions.push({ op: 'touch', id: hit.id, key });
      else actions.push({ op: 'strengthen', id: hit.id, importance: hit.importance ?? best.importance, key });
      continue;
    }
    if (rules >= MAX_RULE_FILES) continue;
    rules += 1;
    actions.push({ op: 'add', draft, key });
  }
  return actions;
}

/**
 * 本拍只落预算内的文件改写。命中计数不占预算。
 * 优先留下规则，其次才改会话留档，避免一轮刷出很多文件。
 */
export function takeLearnWrites(
  actions: LearnAction[],
  budget = LEARN_WRITE_BUDGET
): { taken: LearnAction[]; deferred: LearnAction[] } {
  const touches: LearnAction[] = [];
  const writes: { action: LearnAction; index: number }[] = [];
  actions.forEach((action, index) => {
    if (action.op === 'touch') touches.push(action);
    else writes.push({ action, index });
  });
  const rank = (action: LearnAction) => {
    if (action.op === 'add' && action.draft.kind === 'rule') return 0;
    if (action.op === 'strengthen') return 1;
    if (action.op === 'add') return 2;
    return 3;
  };
  writes.sort((a, b) => rank(a.action) - rank(b.action) || a.index - b.index);
  const taken: LearnAction[] = [];
  const deferred: LearnAction[] = [];
  for (const row of writes) {
    if (taken.length < budget) taken.push(row.action);
    else deferred.push(row.action);
  }
  taken.push(...touches);
  return { taken, deferred };
}

/**
 * 每拍最多指出 limit 条可退役的文件：先是不像规则的过程句，再是超出上限的旧会话。
 * 置顶和已经重复强化到 P5 的不退役。
 */
export function disposableMemoryIds(entries: RetireRef[], limit: number): string[] {
  const ids: string[] = [];
  const push = (id: string) => {
    if (!id || ids.length >= limit || ids.includes(id)) return;
    ids.push(id);
  };
  for (const entry of entries) {
    if (entry.archived || entry.pinned || entry.importance >= 5) continue;
    if (entry.metadata?.by !== 'agent-learn' || entry.metadata?.kind !== 'rule') continue;
    if (isDurableRule(entry.content)) continue;
    push(entry.id);
  }
  const sessions = entries.filter((e) => !e.archived && !e.pinned && e.metadata?.kind === 'session');
  if (sessions.length > MAX_SESSION_FILES) {
    const oldest = [...sessions].sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
    for (const entry of oldest.slice(0, sessions.length - MAX_SESSION_FILES)) push(entry.id);
  }
  return ids;
}

/** 这句话还值得单独占一个记忆文件 */
export function isDurableRule(text: string): boolean {
  return keepSentence(text, 'user') || keepSentence(text, 'assistant');
}

/** 本轮助手回合已经写完，或文件安静超过 45 秒，才落会话摘要，避免生成过程中反复改文件 */
export function transcriptSettled(raw: string, mtimeMs: number, now: number): boolean {
  const tail = String(raw ?? '').slice(-800);
  if (tail.includes('"turn_ended"')) return true;
  return now - mtimeMs >= 45_000;
}

/** 优先处理正在进行的对话；已落盘且无变化的文件跳过。每轮有上限，避免一次激活写爆仓库 */
export function pickTranscriptBatch(
  files: TranscriptFile[],
  cursors: Record<string, TranscriptCursor>,
  limit: number,
  now: number
): TranscriptFile[] {
  const pending = files.filter((f) => {
    const c = cursors[f.file];
    if (!c) return true;
    if (c.size !== f.size || c.mtimeMs !== f.mtimeMs) return true;
    if (!c.sessionWritten && now - f.mtimeMs >= 45_000) return true;
    return false;
  });
  pending.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return pending.slice(0, Math.max(0, limit));
}

export function collectTranscriptFiles(rootDir: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const abs = path.join(dir, n.name);
      if (n.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!n.isFile() || !n.name.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(abs);
        out.push({
          file: abs,
          sessionId: n.name.replace(/\.jsonl$/i, ''),
          mtimeMs: Math.round(st.mtimeMs),
          size: st.size,
        });
      } catch {
        /* 文件在扫描中消失则跳过 */
      }
    }
  };
  walk(rootDir, 0);
  return out;
}

function reinforce(entry: ExistingMemory, strengthened: Set<string>): { op: 'touch' | 'strengthen'; id: string; importance?: number } {
  if (strengthened.has(entry.id) || entry.importance >= 5) return { op: 'touch', id: entry.id };
  strengthened.add(entry.id);
  return { op: 'strengthen', id: entry.id, importance: Math.min(5, entry.importance + 1) };
}

function actionKey(draft: LearnDraft): string {
  return draft.kind === 'session' ? `session:${draft.source}` : ruleKey(draft.content);
}

function sessionDraft(turns: Turn[], sessionId: string): LearnDraft {
  const userLines = turns
    .filter((t) => t.role === 'user')
    .map((t) => oneLine(t.text, 180))
    .filter((line) => line && !NOISE_CUE.test(line));
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
  const close = lastAssistant ? oneLine(lastAssistant.text, 360) : '';
  const titleSrc = userLines[0] || '未命名对话';
  const lines = [`会话 ${sessionId}`, `用户（${userLines.length} 轮）：`, ...userLines.slice(0, 12).map((l) => `- ${l}`)];
  if (close) lines.push(`助手收尾：${close}`);
  return {
    kind: 'session',
    title: `对话·${titleSrc.slice(0, 36)}`,
    content: lines.join('\n'),
    tags: ['workflow'],
    importance: 2,
    source: `agent:${sessionId}`,
    space: 'agent',
    metadata: {
      by: 'agent-learn',
      kind: 'session',
      inject: 'skip',
      session: sessionId,
      turns: String(turns.length),
    },
  };
}

function ruleDraft(sent: string, sessionId: string, from: 'user' | 'assistant'): LearnDraft {
  return {
    kind: 'rule',
    title: oneLine(sent, 40),
    content: sent,
    tags: tagsFor(sent),
    importance: from === 'user' ? 4 : 3,
    source: `agent:${sessionId}`,
    space: 'default',
    metadata: { by: 'agent-learn', kind: 'rule', session: sessionId },
  };
}

function tagsFor(sent: string): string[] {
  if (/教训|根因|bug|失败/.test(sent)) return ['lesson'];
  if (/决定|改为|采用/.test(sent)) return ['decision'];
  if (/架构|模块/.test(sent)) return ['architecture'];
  if (/流程|测试|提交|先读/.test(sent)) return ['workflow'];
  return ['preference'];
}

function keepSentence(sent: string, role: 'user' | 'assistant'): boolean {
  if (sent.length < 8 || sent.length > 180) return false;
  if (/^[|`]/.test(sent)) return false;
  if (/[?？]\s*$/.test(sent)) return false;
  if (NOISE_CUE.test(sent) || PROGRESS_CUE.test(sent)) return false;
  if (role === 'user') return RULE_CUE.test(sent);
  return LESSON_CUE.test(sent) && RULE_CUE.test(sent);
}

function sentences(text: string): string[] {
  const noCode = text.replace(/```[\s\S]*?```/g, ' ');
  return noCode
    .split(/[\n\r]+|(?<=[。！；;])/)
    .map((s) => s.replace(/^[\s>*\-+•·\d]+[.、)）]?\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const part = p as { type?: string; text?: string };
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

function unwrapUser(text: string): string {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  const body = m ? m[1] : text;
  return body.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '').trim();
}

function normText(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '');
}

function tokenize(text: string): string[] {
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

function memoryScore(draft: string, existing: string): number {
  const left = normText(draft);
  const right = normText(existing);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const short = left.length <= right.length ? left : right;
  const long = left.length <= right.length ? right : left;
  if (short.length >= 12 && long.includes(short)) return 0.95;
  return similarity(draft, existing);
}

function similarity(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let inter = 0;
  for (const t of left) if (right.has(t)) inter += 1;
  return inter / Math.sqrt(left.size * right.size);
}
