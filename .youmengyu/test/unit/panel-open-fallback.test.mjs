/**
 * 回归锁：某个工作区残留的视图布局让宿主不再解析侧栏视图（点开插件一片空白）时，
 * 「打开记忆面板」必须改在编辑区打开同一页面，任何宿主都一样。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module, { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const distPanel = path.join(repoRoot, 'dist', 'panel.js');

function fakeHost(appName, ws) {
  const ev = () => () => ({ dispose() {} });
  const created = [];
  const commands = [];
  const makeWebview = () => {
    const w = { cspSource: 'vscode-resource:', options: {}, html: '', onDidReceiveMessage: ev(), postMessage: async () => true };
    return w;
  };
  const vscode = {
    env: { appName, clipboard: { writeText: async () => {} } },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: ws } }],
      getConfiguration: () => ({ get: (_k, d) => d, update: async () => {} }),
      onDidChangeWorkspaceFolders: ev(),
      onDidChangeConfiguration: ev(),
    },
    window: {
      createWebviewPanel: (viewType) => {
        const panel = { viewType, webview: makeWebview(), reveal() {}, onDidDispose: ev(), visible: true };
        created.push(panel);
        return panel;
      },
    },
    commands: { executeCommand: async (id) => { commands.push(id); } },
    ViewColumn: { Active: -1 },
    EventEmitter: class { constructor() { this.event = ev(); } fire() {} dispose() {} },
  };
  return { vscode, created, commands, makeWebview };
}

function loadWith(vscode) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return vscode;
    return orig.call(this, req, ...rest);
  };
  try {
    const req = createRequire(import.meta.url);
    for (const k of Object.keys(req.cache)) if (k.startsWith(path.join(repoRoot, 'dist'))) delete req.cache[k];
    return { panelMod: req(distPanel), storeMod: req(path.join(repoRoot, 'dist', 'store.js')) };
  } finally {
    Module._load = orig;
  }
}

async function openWithoutSidebar(appName) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aimem-open-'));
  const host = fakeHost(appName, ws);
  const { panelMod, storeMod } = loadWith(host.vscode);
  const store = new storeMod.MemoryStore({ defer: true });
  store.bindWorkspace();
  const ctx = { extensionPath: repoRoot, extensionUri: { fsPath: repoRoot }, subscriptions: [] };
  const panel = new panelMod.MemoryPanel(ctx, store);
  panel.show(store);
  await new Promise((r) => setTimeout(r, 1200));
  return { host, ws };
}

test('侧栏视图不被解析时，打开面板落到编辑区（VS Code 等非 Cursor 宿主）', async (t) => {
  if (!fs.existsSync(distPanel)) return t.skip('dist/panel.js 未编译');
  const { host } = await openWithoutSidebar('Visual Studio Code');
  assert.ok(host.commands.includes('aimemory.panel.focus'), '应先尝试打开侧栏视图');
  assert.equal(host.created.length, 1, '侧栏没解析，应在编辑区开一个面板');
  assert.equal(host.created[0].viewType, 'aimemory.editor');
  assert.match(host.created[0].webview.html, /游梦鱼·长记忆/);
});

test('Cursor 宿主同样只开一个编辑区面板，不重复创建', async (t) => {
  if (!fs.existsSync(distPanel)) return t.skip('dist/panel.js 未编译');
  const { host } = await openWithoutSidebar('Cursor');
  assert.equal(host.created.length, 1);
  assert.match(host.created[0].webview.html, /window\.__AIMEM_BOOT=/);
});

test('侧栏视图正常解析时不额外打开编辑区（非 Cursor）', async (t) => {
  if (!fs.existsSync(distPanel)) return t.skip('dist/panel.js 未编译');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aimem-open-'));
  const host = fakeHost('Visual Studio Code', ws);
  const { panelMod, storeMod } = loadWith(host.vscode);
  const store = new storeMod.MemoryStore({ defer: true });
  store.bindWorkspace();
  const ctx = { extensionPath: repoRoot, extensionUri: { fsPath: repoRoot }, subscriptions: [] };
  const panel = new panelMod.MemoryPanel(ctx, store);
  const ev = () => ({ dispose() {} });
  panel.resolveWebviewView({ webview: host.makeWebview(), visible: true, onDidChangeVisibility: ev, onDidDispose: ev });
  panel.show(store);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(host.created.length, 0);
});
