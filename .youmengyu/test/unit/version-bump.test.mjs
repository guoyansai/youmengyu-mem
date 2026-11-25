/**
 * npm run publish 前的版本进位：界面或小改动末位，更大的改动次位，主位不自动动。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const modUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'version-bump.mjs')).href;
const {
  SMALL_LINE_BUDGET,
  classifyBump,
  nextVersion,
  normalizeDiffPath,
  parseNumstat,
  writeVersionFiles,
} = await import(modUrl);

test('末位只加最右一位', () => {
  assert.equal(nextVersion('0.5.0', 'patch'), '0.5.1');
  assert.equal(nextVersion('1.2.9', 'patch'), '1.2.10');
});

test('次位加左起第二位并清零末位，主位不动', () => {
  assert.equal(nextVersion('0.5.0', 'minor'), '0.6.0');
  assert.equal(nextVersion('0.5.3', 'minor'), '0.6.0');
  assert.equal(nextVersion('1.9.4', 'minor'), '1.10.0');
});

test('主位进位只在显式 major 时发生', () => {
  assert.equal(nextVersion('0.5.9', 'major'), '1.0.0');
});

test('界面改动再大也进末位', () => {
  const decision = classifyBump([
    { path: 'src/panel.ts', added: 400, deleted: 120 },
    { path: 'src/ai/settings-panel.ts', added: 40, deleted: 0 },
    { path: 'media/icon.svg', added: -1, deleted: -1 },
  ]);
  assert.equal(decision.level, 'patch');
});

test('非界面小改动进末位，超过预算进次位', () => {
  const small = classifyBump([{ path: 'src/store.ts', added: 30, deleted: 10 }]);
  assert.equal(small.level, 'patch');
  const big = classifyBump([{ path: 'src/extension.ts', added: SMALL_LINE_BUDGET, deleted: 1 }]);
  assert.equal(big.level, 'minor');
});

test('界面夹一小段逻辑仍算小更新', () => {
  const decision = classifyBump([
    { path: 'src/panel.ts', added: 200, deleted: 0 },
    { path: 'src/store.ts', added: 20, deleted: 5 },
  ]);
  assert.equal(decision.level, 'patch');
});

test('版本文件、文档和测试不把更新抬到次位', () => {
  const decision = classifyBump([
    { path: 'package.json', added: 1, deleted: 1 },
    { path: 'package-lock.json', added: 2, deleted: 2 },
    { path: 'README.md', added: 500, deleted: 0 },
    { path: '.youmengyu/test/unit/version-bump.test.mjs', added: 80, deleted: 0 },
  ]);
  assert.equal(decision.level, 'patch');
  assert.equal(decision.lines, 0);
});

test('没有改动时仍进末位，避免市场报版本已存在', () => {
  assert.equal(classifyBump([]).level, 'patch');
});

test('自动结果不会是主版本', () => {
  const decision = classifyBump([{ path: 'src/extension.ts', added: 5000, deleted: 0 }]);
  assert.equal(decision.level, 'minor');
  assert.notEqual(decision.level, 'major');
});

test('numstat 重命名取新路径', () => {
  const rows = parseNumstat('12\t3\tsrc/{old.ts => store.ts}\n-\t-\tmedia/icon.png\n');
  assert.equal(rows[0].path, 'src/store.ts');
  assert.equal(rows[0].added, 12);
  assert.equal(normalizeDiffPath('old.ts => src/extension.ts'), 'src/extension.ts');
  assert.equal(rows[1].added, -1);
});

test('写版本时 package.json 与 lock 根版本一起改', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-bump-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '0.5.0' }, null, 2));
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'demo', version: '0.4.1', packages: { '': { version: '0.4.1' } } }, null, 2),
  );
  writeVersionFiles(dir, '0.5.1');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.version, '0.5.1');
  assert.equal(lock.version, '0.5.1');
  assert.equal(lock.packages[''].version, '0.5.1');
  fs.rmSync(dir, { recursive: true, force: true });
});
