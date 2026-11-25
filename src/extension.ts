import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AiEngine } from './ai/engine';
import { MemoryOrganizer } from './ai/organize';
import { AiSettingsController } from './ai/settings-panel';
import { startAgentMemory } from './agent-loop';
import { addMemoryFlow, gitLessonsFlow } from './add';
import { buildFullContext, generateInject } from './inject';
import { MemoryPanel } from './panel';
import { pickSpace, quickSearch, showEntryActions, showProfile } from './search';
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
  const store = new MemoryStore();
  // 记忆面板：注册为侧边栏 WebviewView，直接在活动栏图标视图内打开
  const panel = new MemoryPanel(context, store);
  out.appendLine(
    `[store] root=${store.workspaceRoot ?? '(未打开工作区)'} ready=${store.ready} entries=${store.entries.length}`
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MemoryPanel.viewId, panel),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      panel.notifyStoreChanged();
    })
  );

  // 状态栏：记忆数量
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'aimemory.search';
  statusBar.tooltip = '游梦鱼·长记忆：点击搜索';
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
    addMemoryFlow(store, presetContent, presetSource));
  reg('aimemory.search', () => quickSearch(store));
  reg('aimemory.openPanel', () => panel.show(store));
  reg('aimemory.inject.generate', () => generateInject(store));
  reg('aimemory.inject.copyAll', async () => {
    if (!store.ready) return;
    await vscode.env.clipboard.writeText(buildFullContext(store));
    void vscode.window.showInformationMessage('游梦鱼·长记忆: 上下文已复制到剪贴板');
  });
  reg('aimemory.git.lessons', () => gitLessonsFlow(store));
  reg('aimemory.refresh', () => {
    store.bindWorkspace();
  });
  reg('aimemory.entry.edit', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (entry) await showEntryActions(store, entry);
  });
  reg('aimemory.entry.delete', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (!entry) return;
    const ok = await vscode.window.showWarningMessage(`删除记忆「${entry.title}」？`, { modal: true }, '删除');
    if (ok === '删除') store.remove(entry.id);
  });
  reg('aimemory.entry.copy', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (!entry) return;
    await vscode.env.clipboard.writeText(`${entry.title}\n${entry.content}`);
    void vscode.window.showInformationMessage('游梦鱼·长记忆: 已复制');
  });
  reg('aimemory.entry.pin', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (entry) store.update(entry.id, { pinned: !entry.pinned });
  });
  reg('aimemory.entry.forget', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (!entry) return;
    const nextArchived = !entry.archived;
    store.archive(entry.id, nextArchived);
    void vscode.window.showInformationMessage(
      nextArchived ? '游梦鱼·长记忆: 已归档，可在记忆面板勾选「显示已归档」找回' : '游梦鱼·长记忆: 已恢复'
    );
  });
  reg('aimemory.entry.space', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    if (!entry) return;
    const space = await pickSpace(store, entry.space);
    if (space) store.moveToSpace(entry.id, space);
  });
  reg('aimemory.entry.detail', async (nodeOrId: any) => {
    const entry = await resolveEntry(store, nodeOrId);
    panel.show(store, entry?.id);
  });
  reg('aimemory.profile', () => showProfile(store));
  reg('aimemory.export', async () => {
    if (!store.ready) return;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(store.workspaceRoot!, 'aimemory-export.json')),
      filters: { JSON: ['json'] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(store.toJSONString(), 'utf-8'));
    void vscode.window.showInformationMessage(`游梦鱼·长记忆: 已导出到 ${path.basename(uri.fsPath)}`);
  });
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
  const resolveYoumengyuRoot = async (): Promise<string | undefined> => {
    let root = youmengyuRoot();
    if (fs.existsSync(path.join(root, '.youmengyu', 'memory'))) return root;
    const pick = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectMany: false,
      title: '选择游梦鱼数字人仓库根目录（含 .youmengyu/memory）',
    });
    if (!pick?.length) return undefined;
    root = pick[0].fsPath;
    await vscode.workspace.getConfiguration('aimemory').update('youmengyuRoot', root, vscode.ConfigurationTarget.Global);
    return root;
  };
  reg('aimemory.import.youmengyu', async () => {
    if (!store.ready) return;
    const root = await resolveYoumengyuRoot();
    if (!root) return;
    try {
      const { added, merged } = importYoumengyuInto(root);
      void vscode.window.showInformationMessage(
        `游梦鱼·长记忆: 数字人记忆导入完成，新增 ${added} 条${merged ? `，合并 ${merged} 条` : ''}（空间「${YOUMENGYU_SPACE}」）`
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`游梦鱼·长记忆: 数字人记忆导入失败 ${String(err)}`);
    }
  });

  reg('aimemory.import.files', async () => {
    if (!store.ready) return;
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { 记忆文档: ['md', 'markdown', 'txt'], 全部: ['*'] },
    });
    if (!uris?.length) return;
    const space = await pickSpace(store);
    let added = 0;
    let merged = 0;
    for (const uri of uris) {
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8').trim();
        if (!text) continue;
        const rel = store.workspaceRoot
          ? path.relative(store.workspaceRoot, uri.fsPath).replace(/\\/g, '/')
          : path.basename(uri.fsPath);
        const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60);
        const r = store.add({
          title: firstLine || path.basename(uri.fsPath),
          content: text,
          tags: ['fact'],
          source: rel,
          space,
        });
        if (r.merged) merged += 1;
        else added += 1;
      } catch (err) {
        void vscode.window.showErrorMessage(`游梦鱼·长记忆: 读取 ${path.basename(uri.fsPath)} 失败 ${String(err)}`);
      }
    }
    void vscode.window.showInformationMessage(
      `游梦鱼·长记忆: 文件导入完成，新增 ${added} 条${merged ? `，合并 ${merged} 条` : ''}`
    );
  });
  reg('aimemory.import', async () => {
    if (!store.ready) return;
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { JSON: ['json'] },
    });
    if (!uris?.length) return;
    try {
      const raw = await vscode.workspace.fs.readFile(uris[0]);
      const n = store.importJson(Buffer.from(raw).toString('utf-8'));
      void vscode.window.showInformationMessage(`游梦鱼·长记忆: 导入完成，新增 ${n} 条`);
    } catch (err) {
      void vscode.window.showErrorMessage(`游梦鱼·长记忆: 导入失败 ${String(err)}`);
    }
  });

  // 自动导入数字人记忆：数据源存在且配置开启时静默执行，仅在有新增时提示。
  // 数字人仓库自身除外——插件数据已存进其 .youmengyu/memory/long-memory 分区，再导入会形成副本。
  if (store.ready && vscode.workspace.getConfiguration('aimemory').get<boolean>('youmengyuAutoImport', true)) {
    const root = youmengyuRoot();
    const isDigitalHumanRepo =
      store.workspaceRoot && path.resolve(store.workspaceRoot) === path.resolve(root);
    if (!isDigitalHumanRepo && fs.existsSync(path.join(root, '.youmengyu', 'memory'))) {
      try {
        const { added } = importYoumengyuInto(root);
        if (added > 0) {
          void vscode.window.showInformationMessage(
            `游梦鱼·长记忆: 已自动导入数字人记忆 ${added} 条（空间「${YOUMENGYU_SPACE}」，可关闭 aimemory.youmengyuAutoImport）`
          );
        }
      } catch (err) {
        out.appendLine(`[youmengyu] 自动导入失败: ${String(err)}`);
      }
    }
  }

  // AI 服务引擎：离线/在线/免费三通路，密钥进 SecretStorage
  const aiEngine = new AiEngine(context, (line) => out.appendLine(line));
  // 记忆自动引擎：AI 主动记录（git 提交 + AI 聊天捕获）与定期整理，降低辅助 Agent token 用量
  const organizer = new MemoryOrganizer(aiEngine, store, context, (line) => out.appendLine(line));
  const aiSettings = new AiSettingsController({ engine: aiEngine, organizer }, context);
  panel.attachAi(aiSettings); // 设置页并入侧边栏记忆面板的「AI 服务」标签页，不再另开编辑器页面
  organizer.start();
  context.subscriptions.push(aiEngine.onChange(() => organizer.restart()), { dispose: () => organizer.stop() });

  reg('aimemory.ai.settings', () => panel.showAiSettings());
  reg('aimemory.ai.organize', async () => {
    if (!store.ready) return;
    const rec = await organizer.flush('record');
    const cons = await organizer.consolidate();
    const parts = [rec.detail, cons.detail].filter((d) => d && d !== '没有新来源');
    void vscode.window.showInformationMessage(
      `游梦鱼·长记忆: AI 记录与整理完成${parts.length ? ` — ${parts.join('；')}` : ''}${rec.error || cons.error ? `（错误: ${rec.error || cons.error}）` : ''}`
    );
  });
  reg('aimemory.ai.capture', () => {
    if (!store.ready) return;
    organizer.captureActiveEditor();
  });

  // 安装即记住当前 Agent 对话，并把长记忆写进 AGENTS.md，助手开工就能用上项目规则
  if (store.ready) {
    const agentMemory = startAgentMemory(store, context, (line) => out.appendLine(line));
    context.subscriptions.push(
      { dispose: () => agentMemory.stop() },
      vscode.workspace.onDidChangeWorkspaceFolders(() => agentMemory.rebind()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('aimemory')) agentMemory.rebind();
      })
    );
    if (vscode.workspace.getConfiguration('aimemory').get<boolean>('autoInject', true)) {
      void generateInject(store, { silent: true });
    }
  }

  // 编辑器右键 / 命令面板带选中文本进入
  reg('aimemory.addSelection', () => {
    const editor = vscode.window.activeTextEditor;
    const sel = editor?.selection;
    const text = sel && !sel.isEmpty ? editor!.document.getText(sel) : undefined;
    const source = editor ? `${path.basename(editor.document.uri.fsPath)}:${sel?.start.line! + 1}` : undefined;
    void addMemoryFlow(store, text, source);
  });

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
