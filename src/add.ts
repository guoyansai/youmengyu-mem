import * as path from 'path';
import * as vscode from 'vscode';
import { MemoryStore } from './store';
import { MEMORY_TAGS, TAG_LABEL } from './types';
import { editEntryFlow, pickSpace } from './search';

/** 添加记忆流程：来源文本 → 标题 → 标签 → 重要性 → 空间 → 确认 */
export async function addMemoryFlow(
  store: MemoryStore,
  presetContent?: string,
  presetSource?: string,
  presetSpace?: string
): Promise<void> {
  if (!store.ready) {
    void vscode.window.showWarningMessage('游梦鱼·长记忆: 请先打开一个工作区');
    return;
  }
  let content = presetContent;
  if (!content) {
    const editor = vscode.window.activeTextEditor;
    const sel = editor?.selection;
    const selText = sel && !sel.isEmpty ? editor?.document.getText(sel) : undefined;
    content = await vscode.window.showInputBox({
      prompt: '记忆内容（支持换行粘贴；留空取消）',
      placeHolder: selText ? '当前有选中文本，将自动填入' : '例如：部署前必须先跑 npm run asaitest，否则会漏掉 HTML 测试',
    });
    if (!content && selText) content = selText;
  }
  if (!content || !content.trim()) return;

  const firstLine = content.trim().split('\n')[0];
  const title =
    (await vscode.window.showInputBox({
      prompt: '记忆标题（回车用首行默认）',
      value: firstLine.slice(0, 60),
    })) || firstLine.slice(0, 60);

  const tagItems = MEMORY_TAGS.map((t) => ({
    label: TAG_LABEL[t],
    tag: t,
    description: t,
    picked: t === 'lesson',
  }));
  const picked = await vscode.window.showQuickPick(tagItems, {
    canPickMany: true,
    placeHolder: '选择标签（可多选，回车确认）',
  });
  if (!picked) return;
  const tags = picked.map((p) => (p as any).tag);

  const impStr = await vscode.window.showQuickPick(
    ['5（最高，入仓库画像）', '4', '3（默认）', '2', '1'],
    { placeHolder: '重要性（P5 会被注入到「仓库画像」区块）' }
  );
  const importance = impStr ? Number(impStr[0]) : 3;

  const space = presetSpace ?? (await pickSpace(store));

  const r = store.add({ title, content, tags, importance, source: presetSource, space });
  const msg = r.merged
    ? `游梦鱼·长记忆: 已合并更新现有记忆「${r.entry.title}」`
    : `游梦鱼·长记忆: 已保存「${r.entry.title}」`;
  void vscode.window.showInformationMessage(msg);

  const auto = vscode.workspace.getConfiguration('aimemory').get<boolean>('autoInject', false);
  if (auto) {
    const { generateInject } = await import('./inject');
    void generateInject(store);
  }
}

/** 从最近 git 提交提炼记忆草稿 */
export async function gitLessonsFlow(store: MemoryStore): Promise<void> {
  const root = store.workspaceRoot;
  if (!root || !store.ready) {
    void vscode.window.showWarningMessage('游梦鱼·长记忆: 请先打开一个工作区');
    return;
  }
  const { execFileSync } = await import('child_process');
  let log: string;
  try {
    log = execFileSync('git', ['log', '--pretty=format:%h|%ad|%s', '--date=short', '-n', '30'], {
      cwd: root,
      encoding: 'utf-8',
    });
  } catch {
    void vscode.window.showErrorMessage('游梦鱼·长记忆: 当前目录不是 Git 仓库');
    return;
  }
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, date, subject] = line.split('|');
      return { hash, date, subject };
    });
  if (!commits.length) {
    void vscode.window.showInformationMessage('游梦鱼·长记忆: 没有可用的提交记录');
    return;
  }
  const items = commits.map((c) => ({
    label: c.subject,
    description: `${c.hash} ${c.date}`,
    commit: c,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: '选择要提炼成记忆的提交（可多选，建议选踩坑/重大变更类）',
    matchOnDescription: true,
  });
  if (!picked?.length) return;
  const space = await pickSpace(store);
  for (const p of picked) {
    const c = (p as any).commit;
    await addMemoryFlow(store, c.subject, `git ${c.hash} (${c.date})`, space);
  }
}
