import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AiEngine } from './ai/engine';
import { MemoryOrganizer } from './ai/organize';
import { AiSettingsController } from './ai/settings-panel';
import { startAgentMemory } from './agent-loop';
import { startChangelogSync } from './changelog-sync';
import { startTwinRuntime } from './twin-loop';
import { generateInject } from './inject';
import { MemoryPanel } from './panel';
import { MemoryStore } from './store';
import { DEFAULT_YOUMENGYU_ROOT, collectYoumengyuEntries, YOUMENGYU_SPACE } from './youmengyu';

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('游梦鱼·长记忆');
  context.subscriptions.push(out);
  try {
    activateImpl(context, out);
    out.appendLine('[activate] ok');
  } catch (err) {
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    out.appendLine(`[activate] 失败: ${detail}`);
    void vscode.window.showErrorMessage(
      '游梦鱼·长记忆: 插件激活失败，详情见「输出」面板的「游梦鱼·长记忆」通道'
    );
  }
}

function activateImpl(context: vscode.ExtensionContext, out: vscode.OutputChannel): void {
  // 先注册视图，再读记忆。安装后恢复侧边栏时，若读盘阻塞在注册之前，视图会停在「没有数据提供程序」。
  const store = new MemoryStore({ defer: true });
  const panel = new MemoryPanel(context, store);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MemoryPanel.viewId, panel),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      panel.notifyStoreChanged();
    })
  );
  store.bindWorkspace();
  panel.notifyStoreChanged();
  out.appendLine(
    `[store] root=${store.workspaceRoot ?? '(未打开工作区)'} ready=${store.ready} entries=${store.entries.length}`
  );

  // 状态栏：记忆数量
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'aimemory.openPanel';
  statusBar.tooltip = '游梦鱼·长记忆：打开记忆面板';
  const updateStatus = () => {
    if (!store.ready) {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(bookmark) ${store.entries.length}`;
    statusBar.show();
  };
  store.onChange(updateStatus);
  updateStatus();
  context.subscriptions.push(statusBar);

  const reg = (cmd: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(cmd, fn));

  reg('aimemory.add', (presetContent?: string, presetSource?: string) =>
    panel.openTab('compose', { content: presetContent, source: presetSource }));
  reg('aimemory.search', () => panel.focusSearch());
  reg('aimemory.openPanel', () => panel.show(store));
  reg('aimemory.inject.generate', () => panel.injectNow());
  reg('aimemory.inject.copyAll', () => panel.copyAll());
  reg('aimemory.git.lessons', () => panel.openTab('git'));
  reg('aimemory.refresh', () => {
    store.bindWorkspace();
    panel.notifyStoreChanged();
    panel.refresh();
  });
  reg('aimemory.entry.edit', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (entry) panel.openEditor(entry.id);
  });
  reg('aimemory.entry.delete', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (entry) await panel.removeWithConfirm(entry.id);
  });
  reg('aimemory.entry.copy', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (!entry) return;
    await vscode.env.clipboard.writeText(`${entry.title}\n${entry.content}`);
    panel.note('已复制');
  });
  reg('aimemory.entry.pin', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (!entry) return;
    store.update(entry.id, { pinned: !entry.pinned });
    panel.note(entry.pinned ? '已取消置顶' : '已置顶');
    panel.refresh();
  });
  reg('aimemory.entry.forget', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (!entry) return;
    const nextArchived = !entry.archived;
    store.archive(entry.id, nextArchived);
    panel.note(nextArchived ? '已归档，可在记忆页勾选「显示已归档」找回' : '已恢复');
    panel.refresh();
  });
  reg('aimemory.entry.space', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (entry) panel.openEditor(entry.id);
  });
  reg('aimemory.entry.detail', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    panel.show(store, entry?.id);
  });
  reg('aimemory.profile', () => panel.openTab('profile'));
  reg('aimemory.export', () => panel.openTab('io'));
  // 游梦鱼数字人记忆导入：手动命令 + 激活时按配置自动导入
  const youmengyuRoot = () =>
    vscode.workspace.getConfiguration('aimemory').get<string>('youmengyuRoot', DEFAULT_YOUMENGYU_ROOT);
  const importYoumengyuInto = (root: string): { added: number; merged: number } => {
    const { entries } = collectYoumengyuEntries(root);
    let added = 0;
    let merged = 0;
    for (const e of entries) {
      const r = store.add({
        title: e.title,
        content: e.content,
        tags: e.tags,
        importance: e.importance,
        source: e.source,
        pinned: e.pinned,
        space: YOUMENGYU_SPACE,
        metadata: e.metadata,
      });
      if (r.merged) merged += 1;
      else added += 1;
    }
    return { added, merged };
  };
  reg('aimemory.import.youmengyu', () => panel.openTab('io'));
  reg('aimemory.import.files', () => panel.openTab('io'));
  reg('aimemory.import', () => panel.openTab('io'));

  // 自动导入放到下一拍，避免激活时扫数字人仓库把侧边栏视图堵住。
  const autoImport = () => {
    if (!store.ready || !vscode.workspace.getConfiguration('aimemory').get<boolean>('youmengyuAutoImport', true)) return;
    const root = youmengyuRoot();
    const isDigitalHumanRepo =
      store.workspaceRoot && path.resolve(store.workspaceRoot) === path.resolve(root);
    if (isDigitalHumanRepo || !fs.existsSync(path.join(root, '.youmengyu', 'memory'))) return;
    try {
      const { added } = importYoumengyuInto(root);
      if (added > 0) out.appendLine(`[youmengyu] 已自动导入数字人记忆 ${added} 条（空间「${YOUMENGYU_SPACE}」）`);
    } catch (err) {
      out.appendLine(`[youmengyu] 自动导入失败: ${String(err)}`);
    }
  };

  // AI 服务引擎：离线/在线/免费三通路，密钥进 SecretStorage
  const aiEngine = new AiEngine(context, (line) => out.appendLine(line));
  // 记忆自动引擎：AI 主动记录（git 提交 + AI 聊天捕获）与定期整理，降低辅助 Agent token 用量
  const organizer = new MemoryOrganizer(aiEngine, store, context, (line) => out.appendLine(line));
  const aiSettings = new AiSettingsController({ engine: aiEngine, organizer }, context);
  panel.attachAi(aiSettings);
  panel.bindExtra({
    organize: async () => {
      const rec = await organizer.flush('record');
      const cons = await organizer.consolidate();
      const parts = [rec.detail, cons.detail].filter((d) => d && d !== '没有新来源');
      const err = rec.error || cons.error;
      return `AI 记录与整理完成${parts.length ? ` — ${parts.join('；')}` : ''}${err ? `（错误: ${err}）` : ''}`;
    },
    youmengyu: async (root: string) => {
      if (!fs.existsSync(path.join(root, '.youmengyu', 'memory'))) {
        throw new Error('目录里没有 .youmengyu/memory');
      }
      await vscode.workspace.getConfiguration('aimemory').update('youmengyuRoot', root, vscode.ConfigurationTarget.Global);
      const { added, merged } = importYoumengyuInto(root);
      return `数字人记忆导入完成，新增 ${added} 条${merged ? `，合并 ${merged} 条` : ''}（空间「${YOUMENGYU_SPACE}」）`;
    },
  });
  organizer.start();
  context.subscriptions.push(aiEngine.onChange(() => organizer.restart()), { dispose: () => organizer.stop() });

  reg('aimemory.ai.settings', () => panel.showAiSettings());
  reg('aimemory.ai.organize', async () => {
    if (!store.ready) {
      panel.note('请先打开一个工作区', 'warn');
      return;
    }
    panel.openTab('memory');
    panel.note('正在整理…');
    const rec = await organizer.flush('record');
    const cons = await organizer.consolidate();
    const parts = [rec.detail, cons.detail].filter((d) => d && d !== '没有新来源');
    const err = rec.error || cons.error;
    panel.note(`AI 记录与整理完成${parts.length ? ` — ${parts.join('；')}` : ''}${err ? `（错误: ${err}）` : ''}`, err ? 'warn' : undefined);
    panel.refresh();
  });
  reg('aimemory.ai.capture', () => {
    if (!store.ready) {
      panel.note('请先打开一个工作区', 'warn');
      return;
    }
    const text = organizer.captureActiveEditor();
    panel.note(text, text.indexOf('没有') === 0 ? 'warn' : undefined);
  });

  // 安装即记住当前 Agent 对话，并把长记忆写进 AGENTS.md，助手开工就能用上项目规则
  if (store.ready) {
    const agentMemory = startAgentMemory(store, context, (line) => out.appendLine(line));
    const twin = startTwinRuntime(store, (line) => out.appendLine(line), (text) => panel.note(text));
    context.subscriptions.push(
      { dispose: () => agentMemory.stop() },
      { dispose: () => twin.stop() },
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        agentMemory.rebind();
        void twin.rebind();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('aimemory')) {
          agentMemory.rebind();
          void twin.rebind();
        }
      })
    );
    reg('aimemory.twin.beat', () => twin.beatNow());
    reg('aimemory.commit.draft', () => twin.draftCommit());
    const later = setTimeout(() => {
      autoImport();
      if (vscode.workspace.getConfiguration('aimemory').get<boolean>('autoInject', true)) {
        void generateInject(store, { silent: true });
      }
    }, 1200);
    context.subscriptions.push({ dispose: () => clearTimeout(later) });
  } else {
    const needWorkspace = () => {
      panel.note('请先打开一个工作区', 'warn');
    };
    reg('aimemory.twin.beat', needWorkspace);
    reg('aimemory.commit.draft', needWorkspace);
  }

  // 编辑器右键 / 命令面板带选中文本进入
  reg('aimemory.addSelection', () => {
    const editor = vscode.window.activeTextEditor;
    const sel = editor?.selection;
    const text = sel && !sel.isEmpty ? editor!.document.getText(sel) : undefined;
    const source = editor ? `${path.basename(editor.document.uri.fsPath)}:${sel?.start.line! + 1}` : undefined;
    panel.openTab('compose', { content: text, source });
  });

  // 按 git 用户把 AI 工作和个人更新按小时写进 CHANGELOG.md / CHANGELOG+用户名.md
  if (store.workspaceRoot) {
    const changelog = startChangelogSync(store.workspaceRoot, (line) => out.appendLine(line));
    context.subscriptions.push({ dispose: () => changelog.stop() });
  }

  updateStatus();
}

async function resolveEntry(store: MemoryStore, nodeOrId: any) {
  if (!nodeOrId) return undefined;
  const id = typeof nodeOrId === 'string' ? nodeOrId : nodeOrId?.entry?.id ?? nodeOrId?.id;
  if (!id) return undefined;
  return store.entries.find((e) => e.id === id);
}

export function deactivate(): void {
  // 无常驻资源
}
