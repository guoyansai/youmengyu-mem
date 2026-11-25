/**
 * 回归锁：记忆数据跟着仓库自身存在 .youmengyu/memory/long-memory（与游梦鱼数字人
 * 本仓记忆共用目录）+ 插件名称「游梦鱼·长记忆」。
 * 纯静态校验（不 import vscode），保证改配置/改目录时不会静默回退。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const storeSrc = fs.readFileSync(path.join(repoRoot, 'src', 'store.ts'), 'utf8');
const readSrc = (f) => fs.readFileSync(path.join(repoRoot, 'src', f), 'utf8');

const BRAND = '游梦鱼·长记忆';
const STORAGE_DIR = '.youmengyu/memory/long-memory';
const LEGACY_DIR = '.aimemory';

test('插件名称是「游梦鱼·长记忆」', () => {
  // displayName 允许带后缀（市场显示名被占用时加「仓库」区分），品牌主体必须保留
  assert.ok(pkg.displayName.includes(BRAND), `displayName 缺少品牌「${BRAND}」: ${pkg.displayName}`);
  assert.equal(pkg.contributes.viewsContainers.activitybar[0].title, BRAND);
  assert.equal(pkg.contributes.configuration.title, BRAND);
});

test('命令面板分类统一为「游梦鱼·长记忆」且标题不再重复前缀', () => {
  for (const cmd of pkg.contributes.commands) {
    assert.equal(cmd.category, BRAND, `${cmd.command} 分类不对`);
    assert.ok(!cmd.title.includes('长记忆:'), `${cmd.command} 标题仍带旧前缀: ${cmd.title}`);
  }
});

test('记忆目录默认在数字人 memory 分区 .youmengyu/memory/long-memory', () => {
  assert.equal(pkg.contributes.configuration.properties['aimemory.storageDir'].default, STORAGE_DIR);
  // 记忆库树视图已下线（与记忆面板内容重复），viewsWelcome 一并移除
  assert.ok(!pkg.contributes.viewsWelcome, '树视图已删除，不应残留 viewsWelcome');
  const panelSrc = readSrc('panel.ts');
  assert.ok(panelSrc.includes(STORAGE_DIR), '记忆面板空态文案必须写明存储路径');
  assert.match(storeSrc, /DEFAULT_STORAGE_DIR = '\.youmengyu\/memory\/long-memory'/);
  // 默认值不得回退成旧目录
  assert.ok(!/get<string>\('storageDir',\s*'\.aimemory'\)/.test(storeSrc));
  assert.ok(!/get<string>\('storageDir',\s*'\.youmengyu'\)/.test(storeSrc));
});

test('按条目存储：每条记忆一个 <id>.json，原子写入，目录扫描加载（多终端 Git 合并无冲突）', () => {
  // 确定性 id：内容哈希，相同内容在两个终端生成相同文件
  assert.match(storeSrc, /entryId\(content: string\): string/, 'id 必须由内容哈希派生');
  // 每条一个文件 + 原子写入
  assert.match(storeSrc, /persistEntry\(entry: MemoryEntry/, '必须按条目落盘');
  assert.match(storeSrc, /writeJsonAtomic\(/, '必须 tmp+rename 原子写入');
  assert.match(storeSrc, /fs\.renameSync\(tmp, file\)/);
  assert.match(storeSrc, /\$\{entry\.id\}\.json/);
  // 加载：扫描目录而不是读单体文件，无全局索引（索引才是冲突磁铁）
  assert.match(storeSrc, /readdirSync\(this\.dir\)/);
  assert.ok(!/MEMORY_INDEX|index\.json/.test(storeSrc), '不得引入全局索引文件');
  // 确定性排序：注入块 diff 跨终端稳定
  assert.match(storeSrc, /createdAt\.localeCompare\(a\.createdAt\)/);
});

test('易变数据不入库：命中计数写 .local/hits.json 并被嵌套 .gitignore 忽略', () => {
  assert.match(storeSrc, /LOCAL_DIR = '\.local'/);
  assert.match(storeSrc, /HITS_FILE = 'hits\.json'/);
  assert.match(storeSrc, /flushHits\(\)/);
  assert.match(storeSrc, /ensureGitignore\(\)/);
  assert.match(storeSrc, /\.local\/\\n/, '嵌套 .gitignore 必须忽略 .local/');
  // touch 不得触碰 Git 跟踪的条目文件
  const touchBody = storeSrc.slice(storeSrc.indexOf('touch(id: string)'), storeSrc.indexOf('remove(id: string)'));
  assert.ok(!touchBody.includes('persistEntry'), 'touch 只能写本机计数，不得写条目文件');
});

test('旧版单体记忆只需一次性迁移，迁移后删除旧文件（不留重复数据）', () => {
  assert.match(storeSrc, /LEGACY_STORAGE_DIR = '\.aimemory'/);
  assert.match(storeSrc, /LEGACY_YOUMENGYU_DIR = '\.youmengyu'/);
  assert.match(storeSrc, /private migrateLegacy/);
  assert.match(storeSrc, /persistEntry\(e, false\)/);
  assert.match(storeSrc, /fs\.rmSync\(legacyFile/, '迁移成功后必须删除旧单体文件');
  // 迁移必须在 load 之前，否则会先读到空记忆
  assert.ok(storeSrc.indexOf('this.migrateLegacy(') < storeSrc.indexOf('this.load();'));
});

test('源码里不再残留旧品牌「仓库长记忆」与旧路径文案', () => {
  for (const f of fs.readdirSync(path.join(repoRoot, 'src'))) {
    if (!f.endsWith('.ts')) continue;
    const src = readSrc(f);
    assert.ok(!src.includes('仓库长记忆'), `${f} 仍残留旧品牌`);
    assert.ok(!src.includes(`${LEGACY_DIR}/memories.json'`), `${f} 仍把旧目录当默认路径`);
    assert.ok(!src.includes('.youmengyu/memories.json'), `${f} 仍残留旧单体文件路径文案`);
  }
});
