/**
 * 回归锁：记忆面板批量管理与一键整理（0.4.0）
 *
 *  - clean.ts 纯函数：重复分组 / 最优保留 / 无效 / 无意义 / 过期判定
 *  - store / panel / 前端脚本的批量管理协议（源码级静态校验）
 *
 * clean.ts 不依赖 vscode 运行时，编译后可直接 import。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readSrc = (f) => fs.readFileSync(path.join(repoRoot, 'src', f), 'utf8');
const distDir = path.join(repoRoot, 'dist');
const cleanUrl = 'file:///' + path.join(distDir, 'clean.js').replace(/\\/g, '/');

const { findDuplicateGroups, pickBestOfGroup, findInvalidEntries, findMeaninglessEntries, duplicateRemoveIds, isExpired } =
  await import(cleanUrl);

const mk = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2, 8),
  title: over.title || '记忆',
  content: over.content ?? '这是一条有效内容',
  tags: over.tags || ['other'],
  importance: over.importance ?? 3,
  createdAt: over.createdAt || '2026-01-01T00:00:00.000Z',
  updatedAt: over.updatedAt || '2026-01-01T00:00:00.000Z',
  uses: over.uses ?? 0,
  pinned: over.pinned,
  space: over.space,
  expiresAt: over.expiresAt,
  versions: over.versions,
  archived: over.archived,
});

test('重复分组：归一化正文相同为一组，保留最优一份', () => {
  const a = mk({ id: 'a', content: '固定用 pnpm 安装依赖', updatedAt: '2026-01-01T00:00:00.000Z' });
  const b = mk({ id: 'b', content: '固定用  PNPM 安装依赖  ', updatedAt: '2026-01-02T00:00:00.000Z' });
  const c = mk({ id: 'c', content: '完全不同的内容', updatedAt: '2026-01-03T00:00:00.000Z' });
  const groups = findDuplicateGroups([a, b, c]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
  // 默认按更新时间新者优先
  assert.equal(pickBestOfGroup(groups[0]).id, 'b');
  assert.deepEqual(duplicateRemoveIds(groups), ['a']);
  // 置顶优先保留
  const pinnedOld = mk({ id: 'p', content: '置顶的那份', pinned: true, updatedAt: '2025-01-01T00:00:00.000Z' });
  const newer = mk({ id: 'n', content: '置顶的那份', updatedAt: '2026-06-01T00:00:00.000Z' });
  assert.equal(pickBestOfGroup([newer, pinnedOld]).id, 'p');
});

test('无效数据：正文为空或全空白', () => {
  const invalid = mk({ id: 'bad', content: '   \n  \t ' });
  const ok = mk({ id: 'ok', content: '正常内容' });
  const list = findInvalidEntries([invalid, ok]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'bad');
});

test('无意义数据：有效字符过少 / 纯符号 / 单字符复读', () => {
  const cases = [
    mk({ id: 'm1', content: '。。。。。' }),
    mk({ id: 'm2', content: '----------' }),
    mk({ id: 'm3', content: 'test' }),
    mk({ id: 'm4', content: '12345' }),
    mk({ id: 'm5', content: '=== === ===' }),
  ];
  const found = findMeaninglessEntries(cases);
  assert.equal(found.length, cases.length, '全部都应判为无意义');
  const good = [
    mk({ id: 'g1', content: '测试通过，全部用例绿了' }),
    mk({ id: 'g2', content: 'fix: 修复登录超时问题' }),
  ];
  assert.equal(findMeaninglessEntries(good).length, 0, '正常内容不应误杀');
});

test('过期判定：日期按当天 23:59:59 失效', () => {
  const yesterday = mk({ id: 'e1', expiresAt: '2020-01-01' });
  const today = mk({ id: 'e2', expiresAt: new Date().toISOString().slice(0, 10) });
  const far = mk({ id: 'e3', expiresAt: '2099-12-31' });
  const none = mk({ id: 'e4' });
  assert.equal(isExpired(yesterday), true);
  assert.equal(isExpired(today), false, '当天 23:59:59 才失效');
  assert.equal(isExpired(far), false);
  assert.equal(isExpired(none), false);
});

test('store/panel/前端脚本的批量管理协议已挂接', () => {
  const store = readSrc('store.ts');
  for (const token of ['removeMany(ids: string[])', 'analyzeIssues(): IssueReport', 'tagCounts(', 'removeMany([id])']) {
    assert.ok(store.includes(token), `store.ts 缺少 ${token}`);
  }
  const panel = readSrc('panel.ts');
  for (const token of ["case 'loadMore'", "case 'batchDelete'", "case 'scan'", "case 'cleanup'", 'renderCleanupDrawer', 'batchbar']) {
    assert.ok(panel.includes(token), `panel.ts 缺少批量管理挂点 ${token}`);
  }
  const clientJs = path.join(repoRoot, 'media', 'panel.js');
  const client = fs.readFileSync(clientJs, 'utf8');
  for (const token of ['虚拟渲染', 'loadMore', 'batchDelete', 'scanReport', 'data-sel', "window.addEventListener('scroll'", 'viewportH()']) {
    assert.ok(client.includes(token), `media/panel.js 缺少 ${token}`);
  }
});
