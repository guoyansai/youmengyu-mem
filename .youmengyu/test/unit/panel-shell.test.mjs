/**
 * 回归锁：打包安装后侧边栏要能打开，页面都在插件内切换。
 * 视图提供器必须在读盘之前注册，激活事件要带上 onView，确认和导入不再走系统弹窗。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('安装后打开视图：先注册提供器，激活事件包含 onView', () => {
  const ext = read('src/extension.ts');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.activationEvents.includes('onView:aimemory.panel'));
  assert.match(ext, /registerWebviewViewProvider\(MemoryPanel\.viewId, panel\)/);
  assert.doesNotMatch(ext, /retainContextWhenHidden/);
  const panelSrc = read('src/panel.ts');
  assert.match(panelSrc, /isCursorHost\(\)/);
  assert.match(panelSrc, /createWebviewPanel\(\s*'aimemory\.editor'/);
  assert.match(panelSrc, /if \(!isCursorHost\(\)\)/);
  assert.equal(pkg.contributes.views.aimemory[0].visibility, 'visible');
  const registerAt = ext.indexOf('registerWebviewViewProvider');
  const bindAt = ext.indexOf('store.bindWorkspace()');
  assert.ok(registerAt > 0 && bindAt > registerAt, '读记忆必须发生在视图提供器注册之后');
  assert.match(ext, /new MemoryStore\(\{ defer: true \}\)/);
});

test('标签页都在插件里，不再用选择框、输入框或文件对话框', () => {
  const panel = read('src/panel.ts');
  const ext = read('src/extension.ts');
  const client = read('media/panel.js');
  for (const id of ['memory', 'compose', 'git', 'profile', 'io', 'ai']) {
    assert.match(panel, new RegExp(`data-tab="${id}"`));
  }
  assert.match(panel, /id="composeapp"/);
  assert.match(panel, /id="gitapp"/);
  assert.match(panel, /id="profileapp"/);
  assert.match(panel, /id="ioapp"/);
  assert.match(panel, /id="confirm"/);
  assert.match(client, /function setTab/);
  assert.match(client, /composeapp/);
  assert.doesNotMatch(panel, /showQuickPick|showInputBox|showOpenDialog|showSaveDialog|showWarningMessage/);
  assert.match(panel, /createWebviewPanel\(\s*'aimemory\.editor'/);
  assert.doesNotMatch(ext, /showQuickPick|showInputBox|showOpenDialog|showSaveDialog|showWarningMessage|createWebviewPanel/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'src/search.ts')), false);
});

test('首屏变轻，脚本读失败时页面仍能说明原因', () => {
  const panel = read('src/panel.ts');
  assert.match(panel, /FIRST_PAINT/);
  assert.match(panel, /readClientScript\(context\)/);
  assert.match(panel, /面板脚本没有打进安装包/);
  assert.match(panel, /localResourceRoots: \[this\.context\.extensionUri\]/);
  assert.match(panel, /filteredEntries/);
});
