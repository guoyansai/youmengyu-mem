/**
 * 记忆文件的 Git 合并规则（纯函数，不依赖 vscode，合并驱动与插件共用）。
 * - 记忆条目 JSON：按字段三方合并，双方都改了同一字段时 updatedAt 新者胜；版本链与关系取并集。
 *   合并结果与参数顺序无关、键序固定，两台终端各自合并出的文件字节一致。
 * - 删除写成墓碑 { id, deleted, deletedAt }，删除 vs 修改不再是 Git 的 modify/delete 冲突，删除优先。
 * - AGENTS.md 等注入目标：标记对之间是由记忆生成的派生内容，合并时只合人写的部分，块取本地版本，
 *   插件拉取后按合并后的记忆重新生成。
 */

export const MAX_VERSIONS = 10;

/** 条目文件的固定键序，保证不同终端写出的字节一致 */
const KEY_ORDER = [
  'id',
  'title',
  'content',
  'tags',
  'importance',
  'createdAt',
  'updatedAt',
  'source',
  'uses',
  'pinned',
  'space',
  'facts',
  'metadata',
  'expiresAt',
  'archived',
  'isLatest',
  'supersedes',
  'relations',
  'versions',
  'deleted',
  'deletedAt',
];

type Obj = Record<string, any>;

export interface Tombstone {
  id: string;
  deleted: true;
  deletedAt: string;
}

export function isTombstone(raw: unknown): raw is Tombstone {
  return Boolean(raw && typeof raw === 'object' && (raw as Obj).deleted === true);
}

export function makeTombstone(id: string, at = new Date().toISOString()): Tombstone {
  return { id, deleted: true, deletedAt: at };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 按固定键序输出，未知键按字母序排在后面 */
export function canonicalEntry(raw: Obj): Obj {
  const out: Obj = {};
  for (const k of KEY_ORDER) if (raw[k] !== undefined) out[k] = raw[k];
  for (const k of Object.keys(raw).sort()) if (!(k in out) && raw[k] !== undefined) out[k] = raw[k];
  return out;
}

export function stringifyEntry(raw: Obj): string {
  return `${JSON.stringify(canonicalEntry(raw), null, 2)}\n`;
}

function stamp(e: Obj): string {
  return String(e.deletedAt || e.updatedAt || e.createdAt || '');
}

/** 双方都改时的胜者：时间新者，时间相同按序列化内容比较，保证对称 */
function newer(a: Obj, b: Obj): Obj {
  const sa = stamp(a);
  const sb = stamp(b);
  if (sa !== sb) return sa > sb ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function pick(field: string, base: Obj | undefined, ours: Obj, theirs: Obj, win: Obj): unknown {
  const o = ours[field];
  const t = theirs[field];
  if (same(o, t)) return o;
  if (base) {
    if (same(o, base[field])) return t;
    if (same(t, base[field])) return o;
  }
  return win[field];
}

function mergeMetadata(base: Obj | undefined, ours: Obj, theirs: Obj, win: Obj): Obj | undefined {
  const b: Obj = base?.metadata || {};
  const o: Obj = ours.metadata || {};
  const t: Obj = theirs.metadata || {};
  const w: Obj = win.metadata || {};
  const keys = [...new Set([...Object.keys(o), ...Object.keys(t)])].sort();
  const out: Obj = {};
  for (const k of keys) {
    let v: unknown;
    if (same(o[k], t[k])) v = o[k];
    else if (base && same(o[k], b[k])) v = t[k];
    else if (base && same(t[k], b[k])) v = o[k];
    else v = k in w ? w[k] : o[k] ?? t[k];
    if (v !== undefined) out[k] = v;
  }
  return keys.length ? out : undefined;
}

function unionBy<T>(lists: T[][], key: (x: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const list of lists) for (const x of list || []) if (!seen.has(key(x))) seen.set(key(x), x);
  return [...seen.values()];
}

/** 三方合并一条记忆。base 为空表示双方各自新建了同一 id（同内容） */
export function mergeEntry(base: Obj | undefined, ours: Obj, theirs: Obj): Obj {
  if (isTombstone(ours) || isTombstone(theirs)) {
    const tombs = [ours, theirs].filter(isTombstone);
    const latest = tombs.reduce((a, b) => (a.deletedAt >= b.deletedAt ? a : b));
    return canonicalEntry({ id: ours.id || theirs.id, deleted: true, deletedAt: latest.deletedAt });
  }
  const win = newer(ours, theirs);
  const out: Obj = {};
  const fields = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const f of fields) out[f] = pick(f, base, ours, theirs, win);

  out.id = ours.id || theirs.id;
  const created = [ours.createdAt, theirs.createdAt].filter(Boolean).sort();
  if (created.length) out.createdAt = created[0];
  const updated = [ours.updatedAt, theirs.updatedAt].filter(Boolean).sort();
  if (updated.length) out.updatedAt = updated[updated.length - 1];
  const oImp = Number(ours.importance);
  const tImp = Number(theirs.importance);
  if (!same(oImp, tImp) && !(base && (same(oImp, base.importance) || same(tImp, base.importance)))) {
    out.importance = Math.max(oImp || 0, tImp || 0) || out.importance;
  }
  out.uses = Math.max(Number(ours.uses) || 0, Number(theirs.uses) || 0);
  out.metadata = mergeMetadata(base, ours, theirs, win);
  out.relations = unionBy([ours.relations, theirs.relations], (r: Obj) => `${r.targetId}|${r.kind}`).sort(
    (a: Obj, b: Obj) => `${a.targetId}|${a.kind}`.localeCompare(`${b.targetId}|${b.kind}`)
  );
  out.versions = unionBy(
    [ours.versions, theirs.versions],
    (v: Obj) => `${v.updatedAt}|${v.content}|${v.title}|${v.importance}|${v.note ?? ''}`
  )
    .sort((a: Obj, b: Obj) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
    .slice(0, MAX_VERSIONS);
  return canonicalEntry(out);
}

/**
 * 把带 Git 冲突标记的文本拆回双方全文（支持 diff3 的 ||||||| 段）。
 * 没有冲突标记返回 undefined。
 */
export function splitConflict(text: string): { ours: string; theirs: string; base?: string } | undefined {
  if (!/^<<<<<<< /m.test(text)) return undefined;
  const ours: string[] = [];
  const theirs: string[] = [];
  const base: string[] = [];
  let hasBase = false;
  let mode: 'both' | 'ours' | 'base' | 'theirs' = 'both';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('<<<<<<< ')) mode = 'ours';
    else if (line.startsWith('||||||| ') && mode === 'ours') {
      mode = 'base';
      hasBase = true;
    } else if (line === '=======' && (mode === 'ours' || mode === 'base')) mode = 'theirs';
    else if (line.startsWith('>>>>>>> ') && mode === 'theirs') mode = 'both';
    else if (mode === 'both') {
      ours.push(line);
      theirs.push(line);
      base.push(line);
    } else if (mode === 'ours') ours.push(line);
    else if (mode === 'base') base.push(line);
    else theirs.push(line);
  }
  return { ours: ours.join('\n'), theirs: theirs.join('\n'), base: hasBase ? base.join('\n') : undefined };
}

function parse(text: string | undefined): Obj | undefined {
  if (!text || !text.trim()) return undefined;
  try {
    const v = JSON.parse(text.replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 合并三份条目文件文本；任一方不是合法 JSON 时返回 undefined（交回 Git 当冲突处理） */
export function mergeEntryText(baseText: string | undefined, oursText: string, theirsText: string): string | undefined {
  const ours = parse(oursText);
  const theirs = parse(theirsText);
  if (!ours || !theirs) return undefined;
  return stringifyEntry(mergeEntry(parse(baseText), ours, theirs));
}

/** 修复已带冲突标记的条目文件（合并驱动没装时的兜底）。返回修好的文本或 undefined */
export function healConflictText(text: string): string | undefined {
  const parts = splitConflict(text);
  if (!parts) return undefined;
  return mergeEntryText(parts.base, parts.ours, parts.theirs);
}

const BLOCK_RE = /<!-- ([\w:-]+?):start -->[\s\S]*?<!-- \1:end -->/g;

/** 把生成块换成同名空占位，返回占位后的文本与块内容 */
export function stripBlocks(text: string): { text: string; blocks: Map<string, string> } {
  const blocks = new Map<string, string>();
  const out = text.replace(BLOCK_RE, (whole, name: string) => {
    blocks.set(name, whole);
    return `<!-- ${name}:start --><!-- ${name}:end -->`;
  });
  return { text: out, blocks };
}

/** 把块放回占位处：优先本地版本，本地没有就用对方的 */
export function restoreBlocks(text: string, ours: Map<string, string>, theirs: Map<string, string>): string {
  return text.replace(/<!-- ([\w:-]+?):start --><!-- \1:end -->/g, (whole, name: string) => ours.get(name) ?? theirs.get(name) ?? whole);
}
