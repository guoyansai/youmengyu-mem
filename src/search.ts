import * as vscode from 'vscode';
import { DEFAULT_SPACE, MemoryStore, spaceLabel } from './store';
import { MemoryEntry, TAG_LABEL } from './types';

/**
 * 选择记忆空间：默认空间 + 已有空间 + 新建。
 * 取消时返回 undefined（调用方按默认空间处理，不打断整个流程）。
 */
export async function pickSpace(store: MemoryStore, current?: string): Promise<string | undefined> {
  const currentSpace = current ? spaceLabel(current) : '';
  const items = [
    { label: spaceLabel(DEFAULT_SPACE), space: DEFAULT_SPACE, description: '不分区（默认）' },
    ...[...store.spaces().keys()]
      .filter((s) => s !== DEFAULT_SPACE)
      .map((s) => ({ label: s, space: s, description: `${store.spaces().get(s) || 0} 条记忆` })),
    { label: '＋ 新建空间…', space: '__new__', description: '按项目/主题分区' },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: currentSpace ? `记忆空间（当前：${currentSpace}）` : '记忆空间（可回车用默认）',
    matchOnDescription: true,
  });
  if (!pick) return undefined;
  if (pick.space === '__new__') {
    const name = await vscode.window.showInputBox({
      prompt: '新空间名称',
      placeHolder: '如：前端 / 后端 / 发布',
      validateInput: (v) => (v.trim() ? undefined : '空间名不能为空'),
    });
    return name?.trim() || undefined;
  }
  return pick.space;
}

/** QuickPick 搜索记忆：输入即搜，回车查看详情并给出后续操作 */
export async function quickSearch(store: MemoryStore): Promise<void> {
  if (!store.ready) return showNoWorkspace();

  const pick = vscode.window.createQuickPick();
  pick.placeholder = '输入关键词搜索游梦鱼·长记忆…（回车选中条目）';
  pick.matchOnDetail = true;
  pick.matchOnDescription = true;
  pick.busy = false;
  pick.show();

  const render = (query: string) => {
    const hits = store.search(query, { limit: 30 });
    pick.items = hits.map((e) => ({
      label: `${e.pinned ? '⭐ ' : ''}${e.title}`,
      description: `${(e.tags || []).map((t) => TAG_LABEL[t] || t).join('/')} · P${e.importance} · ${spaceLabel(e.space)} · ${e.uses} 次命中`,
      detail: e.content,
      entryId: e.id,
    }));
  };
  render('');

  pick.onDidChangeValue((v) => render(v));

  pick.onDidChangeSelection((items) => {
    const sel = items[0] as { entryId?: string };
    if (!sel?.entryId) return;
    pick.hide();
    const entry = store.entries.find((e) => e.id === sel.entryId);
    if (entry) store.touch(entry.id);
    void showEntryActions(store, entry);
  });
}

export async function showEntryActions(store: MemoryStore, entry: any): Promise<void> {
  if (!entry) return;
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(clippy) 复制内容', action: 'copy' },
      { label: '$(edit) 编辑', action: 'edit' },
      { label: '$(preview) 查看详情（事实 / 关系 / 版本）', action: 'detail' },
      { label: entry.pinned ? '$(pinned) 取消置顶' : '$(pin) 置顶（进入仓库画像）', action: 'pin' },
      { label: '$(layers) 移动到空间…', action: 'space' },
      {
        label: entry.archived ? '$(history) 恢复（取消归档）' : '$(archive) 归档（遗忘但留档）',
        action: 'archive',
      },
      { label: '$(trash) 删除', action: 'delete' },
    ],
    { placeHolder: entry.title }
  );
  if (!choice) return;
  switch (choice.action) {
    case 'copy':
      await vscode.env.clipboard.writeText(`${entry.title}\n${entry.content}`);
      void vscode.window.showInformationMessage('游梦鱼·长记忆: 已复制');
      break;
    case 'edit':
      await editEntryFlow(store, entry);
      break;
    case 'detail':
      await vscode.commands.executeCommand('aimemory.entry.detail', entry.id);
      break;
    case 'pin':
      store.update(entry.id, { pinned: !entry.pinned });
      break;
    case 'space': {
      const space = await pickSpace(store, entry.space);
      if (space) store.moveToSpace(entry.id, space);
      break;
    }
    case 'archive': {
      const nextArchived = !entry.archived;
      store.archive(entry.id, nextArchived);
      void vscode.window.showInformationMessage(
        nextArchived ? '游梦鱼·长记忆: 已归档，可在面板里勾选「显示已归档」找回' : '游梦鱼·长记忆: 已恢复'
      );
      break;
    }
    case 'delete': {
      const ok = await vscode.window.showWarningMessage(
        `删除记忆「${entry.title}」？删除后不可恢复。`,
        { modal: true },
        '删除'
      );
      if (ok === '删除') store.remove(entry.id);
      break;
    }
  }
}

export async function editEntryFlow(store: MemoryStore, entry: any): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: '记忆标题',
    value: entry.title,
  });
  if (title === undefined) return;
  const content = await vscode.window.showInputBox({
    prompt: '记忆正文（支持换行粘贴）',
    value: entry.content,
  });
  if (content === undefined) return;
  const importanceStr = await vscode.window.showInputBox({
    prompt: '重要性 1-5（5 最高，会进入仓库画像）',
    value: String(entry.importance),
    validateInput: (v) => {
      const n = Number(v);
      return n >= 1 && n <= 5 ? undefined : '请输入 1-5 的数字';
    },
  });
  if (importanceStr === undefined) return;
  const space = await pickSpace(store, entry.space);
  store.update(entry.id, {
    title,
    content,
    importance: Number(importanceStr),
    space: space || entry.space || DEFAULT_SPACE,
  });
  void vscode.window.showInformationMessage('游梦鱼·长记忆: 已保存（旧内容已留入版本历史）');
}

/** 查看仓库画像：静态画像（置顶/P5）+ 动态画像 */
export async function showProfile(store: MemoryStore): Promise<void> {
  if (!store.ready) return showNoWorkspace();
  const { statics, dynamic } = store.profile();
  if (!statics.length && !dynamic.length) {
    void vscode.window.showInformationMessage(
      '游梦鱼·长记忆: 还没有画像条目。把关键约定置顶或设为 P5，就会进入「仓库画像」被 AI 优先读到。'
    );
    return;
  }
  const items: Array<{ label: string; description: string; detail?: string; id: string }> = [];
  for (const e of statics) {
    items.push({
      label: `$(star) ${e.title}`,
      description: `静态画像 · P${e.importance} · ${spaceLabel(e.space)}`,
      detail: e.content,
      id: e.id,
    });
  }
  for (const e of dynamic) {
    items.push({
      label: `$(clock) ${e.title}`,
      description: `动态画像 · ${e.uses} 次命中 · ${spaceLabel(e.space)}`,
      detail: e.content,
      id: e.id,
    });
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: '仓库画像：置顶与 P5 条目会整段注入 AGENTS.md',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;
  const entry = store.entries.find((e: MemoryEntry) => e.id === pick.id);
  if (entry) await showEntryActions(store, entry);
}

function showNoWorkspace(): void {
  void vscode.window.showWarningMessage('游梦鱼·长记忆: 请先打开一个工作区');
}
