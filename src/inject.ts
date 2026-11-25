import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MemoryStore } from './store';
import { MemoryEntry, TAG_LABEL } from './types';

const MARK_START = '<!-- aimemory:start -->';
const MARK_END = '<!-- aimemory:end -->';

function tagText(e: MemoryEntry): string {
  return (e.tags || []).map((t) => TAG_LABEL[t] || t).join('/');
}

/** 把记忆条目渲染为 Markdown 文本块；画像里的条目额外展开事实 */
export function renderEntries(entries: MemoryEntry[], options: { facts?: boolean } = {}): string {
  const lines: string[] = [];
  for (const e of entries) {
    const star = e.pinned ? '⭐ ' : '';
    lines.push(`- ${star}**${e.title}**（${tagText(e)}·P${e.importance}）: ${e.content.replace(/\r?\n/g, ' ')}`);
    if (options.facts && e.facts?.length) {
      for (const f of e.facts.slice(0, 3)) lines.push(`  - 事实: ${f}`);
    }
    if (e.source) lines.push(`  - 来源: ${e.source}`);
  }
  return lines.join('\n');
}

export interface InjectSections {
  /** 静态画像：置顶 + P5，整段注入，替代逐条检索 */
  profile: MemoryEntry[];
  /** 动态画像：近期改动 / 高命中的上下文 */
  dynamic: MemoryEntry[];
  /** 其余长期记忆条目 */
  rest: MemoryEntry[];
}

/** 生成注入块内容：静态画像 → 动态画像 → 长期记忆条目 */
export function buildInjectBlock(sections: InjectSections, repoName: string): string {
  const { profile, dynamic, rest } = sections;
  const head = [
    MARK_START,
    '',
    `# 游梦鱼·长记忆 · ${repoName}`,
    '',
    '> 本区块由「游梦鱼·长记忆」插件自动维护，请勿手动编辑标记对之间内容。',
    '> AI 助手（Agent / Cline / Copilot / Cursor）在本仓库工作时，必须遵守以下长期记忆与仓库既有规则；能从记忆确定的约定直接执行，不必重复确认。',
    '',
  ];
  const body: string[] = [];
  if (profile.length) {
    body.push('## 仓库画像（最高优先）', '', renderEntries(profile, { facts: true }), '');
  }
  if (dynamic.length) {
    body.push('## 近期动态画像', '', renderEntries(dynamic), '');
  }
  if (rest.length) {
    body.push('## 长期记忆条目', '', renderEntries(rest), '');
  }
  if (!profile.length && !dynamic.length && !rest.length) body.push('（暂无记忆条目）');
  return [...head, ...body, MARK_END].join('\n');
}

/** 在目标文件中更新标记对之间的内容，保留其余部分。内容没变则不写盘 */
function upsertBlock(filePath: string, block: string): 'created' | 'updated' | 'unchanged' {
  const exists = fs.existsSync(filePath);
  if (!exists) {
    fs.writeFileSync(filePath, `${block}\n`, 'utf-8');
    return 'created';
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(MARK_START);
  const endIdx = content.indexOf(MARK_END);
  if (startIdx >= 0 && endIdx > startIdx) {
    const current = content.slice(startIdx, endIdx + MARK_END.length);
    if (current === block) return 'unchanged';
    const next = content.slice(0, startIdx) + block + content.slice(endIdx + MARK_END.length);
    fs.writeFileSync(filePath, next, 'utf-8');
    return 'updated';
  }
  // 无标记对：追加到文件末尾
  const sep = content.endsWith('\n') || content === '' ? '' : '\n';
  fs.writeFileSync(filePath, `${content}${sep}\n${block}\n`, 'utf-8');
  return 'updated';
}

/** 按 画像 + 其余条目 组装注入章节，保证不超过条数上限 */
export function collectSections(store: MemoryStore, limit: number): InjectSections {
  const { statics, dynamic } = store.profile();
  const shown = new Set([...statics, ...dynamic].map((e) => e.id));
  const budget = Math.max(0, limit - statics.length - dynamic.length);
  const rest = store.injectEntries(limit).filter((e) => !shown.has(e.id)).slice(0, budget);
  return { profile: statics, dynamic, rest };
}

export async function generateInject(store: MemoryStore, opts?: { silent?: boolean }): Promise<void> {
  const root = store.workspaceRoot;
  if (!root || !store.ready) {
    void vscode.window.showWarningMessage('游梦鱼·长记忆: 请先打开一个工作区');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('aimemory');
  const targets = cfg.get<string[]>('injectTargets', ['AGENTS.md']);
  const limit = cfg.get<number>('maxInjectEntries', 60);
  const repoName = path.basename(root);
  const block = buildInjectBlock(collectSections(store, limit), repoName);
  const results: string[] = [];
  for (const rel of targets) {
    const abs = path.join(root, rel);
    try {
      const r = upsertBlock(abs, block);
      if (r !== 'unchanged') results.push(`${rel}（${r === 'created' ? '新建' : '更新'}）`);
    } catch (err) {
      void vscode.window.showErrorMessage(`游梦鱼·长记忆: 写入 ${rel} 失败: ${String(err)}`);
    }
  }
  if (!opts?.silent) {
    void vscode.window.showInformationMessage(
      results.length ? `游梦鱼·长记忆: 已写入 ${results.join('、')}` : '游梦鱼·长记忆: 注入块已是最新'
    );
  }
}

/** 全量上下文文本（复制到剪贴板用） */
export function buildFullContext(store: MemoryStore): string {
  const limit = vscode.workspace.getConfiguration('aimemory').get<number>('maxInjectEntries', 60);
  const repoName = store.workspaceRoot ? path.basename(store.workspaceRoot) : 'repo';
  return buildInjectBlock(collectSections(store, limit), repoName);
}
