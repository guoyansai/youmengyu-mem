/**
 * 记忆清理启发式（纯函数，不依赖 vscode 运行时，可被 node --test 直接导入）。
 *
 * 四类问题数据：
 *  - 重复：归一化正文完全相同的一组条目，组内保留最优一份
 *  - 无效：正文为空 / 全空白，无法作为记忆检索
 *  - 无意义：去掉符号后有效字符过少（纯符号、单字符复读、占位内容等）
 *  - 过期：expiresAt 已过（检索与注入默认已排除，可一键物理清理）
 */

import { MemoryEntry } from './types';

/** 无意义判定：正文去掉符号后，有效字符（中文/字母/数字）至少要有这么多 */
const MIN_MEANINGFUL_CHARS = 6;

/** 归一化内容用于去重比较 */
export function normalizeText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function isExpired(entry: MemoryEntry, now = Date.now()): boolean {
  if (!entry.expiresAt) return false;
  // 只写日期时按当天 23:59:59 失效，避免"当天就过期"的反直觉
  const raw = String(entry.expiresAt);
  const t = new Date(raw.length === 10 ? `${raw}T23:59:59` : raw).getTime();
  return Number.isFinite(t) && t < now;
}

/** 找重复组：归一化正文相同即为一组（只返回 >1 条的组） */
export function findDuplicateGroups(entries: MemoryEntry[]): MemoryEntry[][] {
  const map = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const key = normalizeText(e.content);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  const groups: MemoryEntry[][] = [];
  for (const list of map.values()) if (list.length > 1) groups.push(list);
  return groups;
}

/** 组内保留最优一份：置顶 > 重要性 > 命中多 > 更新新 > 版本链长 */
export function pickBestOfGroup(group: MemoryEntry[]): MemoryEntry {
  return [...group].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      b.importance - a.importance ||
      b.uses - a.uses ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      (b.versions?.length || 0) - (a.versions?.length || 0) ||
      (a.id < b.id ? -1 : 1)
  )[0];
}

/** 无效数据：正文为空 / 全空白（标题占位也救不回来） */
export function findInvalidEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => !normalizeText(e.content));
}

/** 正文里的有效字符（中文 / 字母 / 数字） */
function meaningfulChars(content: string): number {
  return (normalizeText(content).match(/[\u4e00-\u9fa5a-z0-9]/g) || []).length;
}

/**
 * 无意义数据：有效字符过少，或纯符号/单字符复读/无意义占位。
 * 置顶条目由调用方排除——用户明确留下的不算垃圾。
 */
export function findMeaninglessEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => {
    const norm = normalizeText(e.content);
    if (!norm) return false; // 空内容归「无效」
    if (meaningfulChars(e.content) < MIN_MEANINGFUL_CHARS) return true;
    // 单一字符复读（----------、======、。。。。）
    const compact = norm.replace(/[\s\p{P}\p{S}]/gu, '');
    if (!compact) return true;
    const first = compact[0];
    if (compact.length >= 4 && [...compact].every((c) => c === first)) return true;
    return false;
  });
}

/** 把重复组列表展开成「建议删除」的条目 id（每组保留最优一份） */
export function duplicateRemoveIds(groups: MemoryEntry[][]): string[] {
  const ids: string[] = [];
  for (const g of groups) {
    const best = pickBestOfGroup(g);
    for (const e of g) if (e.id !== best.id) ids.push(e.id);
  }
  return ids;
}

export interface IssueReport {
  /** 重复组（每组保留最优一份，其余建议删除） */
  duplicateGroups: MemoryEntry[][];
  /** 建议删除的重复条目 id */
  duplicateIds: string[];
  invalid: MemoryEntry[];
  meaningless: MemoryEntry[];
  expired: MemoryEntry[];
}
