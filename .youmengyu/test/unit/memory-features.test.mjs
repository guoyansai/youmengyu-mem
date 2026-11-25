/**
 * 回归锁：记忆能力（事实化 / 画像 / 重排检索 / 版本链 / 关系 / 空间 / 归档 / 过期）
 * 与"仓库文档里不得出现外部记忆产品品牌"这条约束。
 *
 * 说明：store.ts 依赖 vscode 运行时，node --test 里无法直接 import，
 * 因此这里做源码级静态校验，并覆盖面板与命令注册的可回归面。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const selfFile = fileURLToPath(import.meta.url);
const srcDir = path.join(repoRoot, 'src');
const readSrc = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vscode-test']);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.isDirectory()) {
      if (SKIP_DIRS.has(name.name)) continue;
      walk(path.join(dir, name.name), out);
    } else if (/\.(ts|mjs|js|json|md|svg|txt)$/i.test(name.name)) {
      out.push(path.join(dir, name.name));
    }
  }
  return out;
}

test('仓库内不再出现外部记忆产品的品牌与链接', () => {
  const offenders = walk(repoRoot)
    .filter((f) => f !== selfFile)
    .filter((f) => /supermemory/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], `以下文件仍残留外部品牌：${offenders.join(', ')}`);
});

test('数据模型覆盖事实 / 空间 / 版本 / 关系 / 归档 / 过期', () => {
  const types = readSrc('types.ts');
  for (const field of ['facts', 'space', 'versions', 'relations', 'archived', 'expiresAt', 'isLatest']) {
    assert.match(types, new RegExp(`${field}\\??:`), `types.ts 缺少字段 ${field}`);
  }
  assert.match(types, /'fact'/, '标签体系需要包含「事实」');
});

test('存储层实现事实化、重排检索、画像、关系、空间与归档', () => {
  const store = readSrc('store.ts');
  for (const fn of [
    /export function extractFacts/,
    /export function tokenize/,
    /export function overlap/,
    /export function similarity/,
    /profile\(\): MemoryProfile/,
    /related\(id: string/,
    /spaces\(\): Map<string, number>/,
    /archive\(id: string, archived: boolean\)/,
    /moveToSpace\(id: string/,
    /get storageFileRel\(\)/,
  ]) {
    assert.match(store, fn, `store.ts 缺少 ${fn}`);
  }
  // 检索必须支持标签 / 空间 / 排序 / 归档过滤
  assert.match(store, /export interface SearchOptions/);
  for (const opt of ['tag', 'space', 'sort', 'includeArchived', 'includeExpired']) {
    assert.match(store, new RegExp(`${opt}\\?:`), `SearchOptions 缺少 ${opt}`);
  }
  // 版本链：改写前留档且有上限
  assert.match(store, /MAX_VERSIONS/);
  assert.match(store, /versions = \[snapshot/);
});

test('注入块分节输出静态画像、动态画像与长期条目', () => {
  const inject = readSrc('inject.ts');
  assert.match(inject, /仓库画像（最高优先）/);
  assert.match(inject, /近期动态画像/);
  assert.match(inject, /长期记忆条目/);
  assert.match(inject, /export function collectSections/);
});

test('记忆面板包含筛选、排序、空间、详情与编辑抽屉', () => {
  const panel = readSrc('panel.ts');
  for (const token of [
    'id="q"',
    'id="sort"',
    'id="space"',
    'id="archived"',
    'id="chips"',
    'id="profile"',
    'id="overlay"',
    'id="drawer"',
    'id="toast"',
    'data-act="save"',
    'data-act="detail"',
    'data-act="archive"',
    'data-act="rollback"',
    "type: 'editor'",
    "type: 'results'",
  ]) {
    assert.ok(panel.includes(token), `panel.ts 缺少 ${token}`);
  }
  // 首屏直出仍在（脚本被 CSP 限制也不能白屏），虚拟列表接管后重绘
  assert.match(panel, /const initial = initialRows\.length \? renderInitialRows/);
  // 面板操作必须走白名单命令，禁止任意命令透传
  assert.match(panel, /const ACTION_COMMANDS/);
  // 虚拟列表与批量管理的数据协议必须存在（百万条目支撑）
  for (const token of ["case 'loadMore'", "type: 'rows'", "case 'batchDelete'", "type: 'scanReport'", 'renderRowHtml(r, i * 76)']) {
    assert.ok(panel.includes(token), `panel.ts 缺少虚拟列表/批量管理协议 ${token}`);
  }
});

test('记忆库树视图已移除，侧边栏只保留记忆面板', () => {
  const viewIds = pkg.contributes.views.aimemory.map((v) => v.id);
  assert.ok(!viewIds.includes('aimemory.tree'), 'aimemory.tree 应已下线，避免与记忆面板内容重复');
  assert.ok(!JSON.stringify(pkg.contributes).includes('aimemory.tree'), 'package.json contributes 里不应残留 aimemory.tree');
  assert.ok(!fs.existsSync(path.join(srcDir, 'tree.ts')), 'src/tree.ts 应已删除');
  const ext = readSrc('extension.ts');
  assert.ok(!ext.includes('MemoryTree'), 'extension.ts 不应再引用 MemoryTree');
});

test('面板前端脚本独立成文件且语法可解析', () => {
  const clientJs = path.join(repoRoot, 'media', 'panel.js');
  assert.ok(fs.existsSync(clientJs), 'media/panel.js 必须存在（面板交互脚本随插件打包）');
  // 内联进 TS 模板字符串时 `\n` 会被折叠成真换行，曾导致整个前端脚本语法错误，这里锁住
  execFileSync(process.execPath, ['--check', clientJs], { stdio: 'pipe' });
  const panel = readSrc('panel.ts');
  assert.ok(!panel.includes('${CLIENT_SCRIPT}'), 'panel.ts 不应再内联前端脚本');
  assert.match(panel, /readClientScript\(context\)/);
});

test('package.json 的视图与命令 id 不重复，且面板视图已注册', () => {
  const viewIds = pkg.contributes.views.aimemory.map((v) => v.id);
  assert.equal(new Set(viewIds).size, viewIds.length, `视图 id 重复：${viewIds.join(',')}`);
  const cmdIds = pkg.contributes.commands.map((c) => c.command);
  assert.equal(new Set(cmdIds).size, cmdIds.length, '命令 id 重复');
  assert.ok(viewIds.includes('aimemory.panel'), '面板 WebviewView 必须声明，否则侧边栏看不到');
  assert.match(readSrc('extension.ts'), /registerWebviewViewProvider\(MemoryPanel\.viewId/);
  assert.match(readSrc('panel.ts'), /static readonly viewId = 'aimemory\.panel'/);
});

test('新增命令全部登记且有中文标题', () => {
  const ids = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const cmd of [
    'aimemory.entry.forget',
    'aimemory.entry.space',
    'aimemory.entry.detail',
    'aimemory.profile',
    'aimemory.openPanel',
    'aimemory.import.files',
    'aimemory.import.youmengyu',
  ]) {
    assert.ok(ids.has(cmd), `package.json 缺少命令 ${cmd}`);
  }
  for (const cmd of pkg.contributes.commands) {
    assert.ok(cmd.title && cmd.category === '游梦鱼·长记忆', `${cmd.command} 缺少分类或标题`);
  }
  assert.match(pkg.version, /^0\.[4-9]\./, '版本应保持 0.4+');
});

test('命令处理器与新增入口在 extension 中注册', () => {
  const ext = readSrc('extension.ts');
  for (const cmd of [
    'aimemory.entry.forget',
    'aimemory.entry.space',
    'aimemory.entry.detail',
    'aimemory.profile',
  ]) {
    assert.ok(ext.includes(`reg('${cmd}'`), `extension.ts 未注册 ${cmd}`);
  }
});

test('README 描述与功能保持一致（无过期表述）', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  for (const topic of ['事实化', '仓库画像', '版本链', '关系图', '记忆空间', '归档', '过期']) {
    assert.ok(readme.includes(topic), `README 未提及 ${topic}`);
  }
  assert.ok(!/灵感来自/.test(readme), 'README 不应再写"灵感来自"外部产品');
});
