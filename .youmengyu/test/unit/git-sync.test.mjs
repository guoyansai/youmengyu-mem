/**
 * 多用户多终端 Git 同步不冲突：字段级合并、墓碑、冲突标记兜底修复、
 * 以及两个真实克隆各自改同一条记忆 / AGENTS.md 生成块 / 更新日志后 pull 不出冲突。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dist = (f) => 'file:///' + path.join(repoRoot, 'dist', f).replace(/\\/g, '/');
const merge = await import(dist('memory-merge.js'));
const sync = await import(dist('git-sync.js'));
const { mergeEntry, mergeEntryText, healConflictText, stringifyEntry, makeTombstone, stripBlocks, restoreBlocks } = merge;
const { ensureGitSync, ensureLines } = sync;

const base = {
  id: 'abc123',
  title: '原标题',
  content: '同一条记忆',
  tags: ['lesson'],
  importance: 3,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  uses: 1,
  pinned: false,
  space: 'default',
  facts: ['同一条记忆'],
  metadata: { by: 'agent-learn' },
  archived: false,
  isLatest: true,
  relations: [],
  versions: [],
};

test('双方改不同字段：两边改动都保留，且与参数顺序无关', () => {
  const ours = { ...base, title: '甲改的标题', updatedAt: '2026-11-02T00:00:00.000Z', versions: [{ title: '原标题', content: base.content, tags: ['lesson'], importance: 3, updatedAt: base.updatedAt, note: '元信息调整前' }] };
  const theirs = { ...base, pinned: true, metadata: { by: 'agent-learn', session: 's2' }, updatedAt: '2026-11-03T00:00:00.000Z', versions: [{ title: '原标题', content: base.content, tags: ['lesson'], importance: 3, updatedAt: base.updatedAt, note: '元信息调整前' }] };
  const a = mergeEntry(base, ours, theirs);
  const b = mergeEntry(base, theirs, ours);
  assert.equal(a.title, '甲改的标题');
  assert.equal(a.pinned, true);
  assert.equal(a.metadata.session, 's2');
  assert.equal(a.updatedAt, '2026-11-03T00:00:00.000Z');
  assert.equal(a.versions.length, 1, '相同历史快照只留一份');
  assert.equal(stringifyEntry(a), stringifyEntry(b), '两台终端合并出的字节一致');
});

test('双方改同一字段：新者胜，重要度取较大值，命中取较大值', () => {
  const ours = { ...base, title: '甲', importance: 4, uses: 5, updatedAt: '2026-11-05T00:00:00.000Z' };
  const theirs = { ...base, title: '乙', importance: 5, uses: 2, updatedAt: '2026-11-04T00:00:00.000Z' };
  const m = mergeEntry(base, ours, theirs);
  assert.equal(m.title, '甲');
  assert.equal(m.importance, 5);
  assert.equal(m.uses, 5);
});

test('双方各自新建同内容条目（add/add）：createdAt 取最早', () => {
  const ours = { ...base, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' };
  const theirs = { ...base, createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-01T08:00:00.000Z' };
  const out = JSON.parse(mergeEntryText('', JSON.stringify(ours), JSON.stringify(theirs)));
  assert.equal(out.createdAt, '2026-11-01T08:00:00.000Z');
});

test('删除 vs 修改：删除墓碑优先', () => {
  const tomb = makeTombstone('abc123', '2026-11-02T00:00:00.000Z');
  const edited = { ...base, title: '改了', updatedAt: '2026-11-03T00:00:00.000Z' };
  assert.equal(mergeEntry(base, tomb, edited).deleted, true);
  assert.equal(mergeEntry(base, edited, tomb).deleted, true);
});

test('带冲突标记的条目文件能按字段修好；坏 JSON 交回 git', () => {
  const ours = stringifyEntry({ ...base, title: '甲', updatedAt: '2026-11-05T00:00:00.000Z' });
  const theirs = stringifyEntry({ ...base, pinned: true, updatedAt: '2026-11-04T00:00:00.000Z' });
  // diff3 带基线：按字段三方合并，双方改动都留
  const diff3 = `<<<<<<< HEAD\n${ours}||||||| base\n${stringifyEntry(base)}=======\n${theirs}>>>>>>> origin/main\n`;
  const healed = JSON.parse(healConflictText(diff3));
  assert.equal(healed.title, '甲');
  assert.equal(healed.pinned, true);
  // 无基线：分不清谁改的，整体新者胜，仍是合法 JSON
  const plain = JSON.parse(healConflictText(`<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> origin/main\n`));
  assert.equal(plain.title, '甲');
  assert.equal(plain.updatedAt, '2026-11-05T00:00:00.000Z');
  assert.equal(healConflictText(ours), undefined, '没有冲突标记不动');
  assert.equal(mergeEntryText('', '{坏', theirs), undefined);
});

test('生成块换占位再放回：人写部分不受影响，块取本地', () => {
  const text = '# 说明\n\n<!-- aimemory:start -->\n甲的块\n<!-- aimemory:end -->\n\n<!-- youmengyu:digest:start -->\nd\n<!-- youmengyu:digest:end -->\n';
  const s = stripBlocks(text);
  assert.ok(!s.text.includes('甲的块'));
  assert.equal(s.blocks.size, 2);
  assert.equal(restoreBlocks(s.text, s.blocks, new Map()), text);
});

test('规则文件只补缺失行，重复执行不写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymy-lines-'));
  const f = path.join(dir, '.gitignore');
  fs.writeFileSync(f, 'node_modules/\nruns/\n', 'utf8');
  assert.equal(ensureLines(f, '# head', ['runs/', 'cache/']), true);
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /^node_modules\/\nruns\/\n\n# head\ncache\/\n$/);
  assert.equal(ensureLines(f, '# head', ['runs/', 'cache/']), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

const STORAGE = '.youmengyu/memory/long-memory';

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function clone(remote, dir, name) {
  sh(path.dirname(dir), 'clone', '-q', '-c', 'core.autocrlf=false', remote, dir);
  sh(dir, 'config', 'user.name', name);
  sh(dir, 'config', 'user.email', `${name}@example.com`);
  const r = ensureGitSync({ root: dir, storageRel: STORAGE, injectTargets: ['AGENTS.md'], driverSrcDir: path.join(repoRoot, 'dist') });
  assert.notEqual(r.driver, 'skipped');
}

const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text, 'utf8');
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const agents = (block) => `# 仓库约定\n\n人写的第一段\n\n<!-- aimemory:start -->\n${block}\n<!-- aimemory:end -->\n\n人写的结尾\n`;

test('两个克隆同时改同一条记忆、AGENTS.md 生成块、更新日志：pull 不冲突', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ymy-sync-'));
  const remote = path.join(work, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { windowsHide: true });
  const seed = path.join(work, 'seed');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  sh(seed, 'config', 'user.name', 'seed');
  sh(seed, 'config', 'user.email', 'seed@example.com');
  sh(seed, 'config', 'core.autocrlf', 'false');
  ensureGitSync({ root: seed, storageRel: STORAGE, injectTargets: ['AGENTS.md'], registerDriver: false });
  write(seed, `${STORAGE}/abc123.json`, stringifyEntry(base));
  write(seed, `${STORAGE}/gone01.json`, stringifyEntry({ ...base, id: 'gone01', content: '会被删' }));
  write(seed, 'AGENTS.md', agents('初始块'));
  write(seed, 'CHANGELOG.md', '# 更新日志\n\n## 2026-11-25 16:00\n\n- 初始\n');
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'seed');
  sh(seed, 'remote', 'add', 'origin', remote);
  sh(seed, 'push', '-q', 'origin', 'main');

  const a = path.join(work, 'a');
  const b = path.join(work, 'b');
  clone(remote, a, '甲');
  clone(remote, b, '乙');

  // 运行态不入库
  write(a, '.youmengyu/runs/agent-assist.json', '{"a":1}');
  write(a, '.youmengyu/memory/evolution/.local/awareness.md', '分支 a');
  assert.equal(sh(a, 'status', '--porcelain').trim(), '');

  // 甲：改标题、改 AGENTS 块和人写开头、加日志；删 gone01（写墓碑）
  write(a, `${STORAGE}/abc123.json`, stringifyEntry({ ...base, title: '甲改的标题', importance: 4, updatedAt: '2026-11-25T08:00:00.000Z' }));
  write(a, `${STORAGE}/gone01.json`, stringifyEntry(makeTombstone('gone01', '2026-11-25T08:00:00.000Z')));
  write(a, 'AGENTS.md', agents('甲生成的块').replace('人写的第一段', '人写的第一段（甲补充）'));
  write(a, 'CHANGELOG.md', read(a, 'CHANGELOG.md') + '- 甲的工作\n');
  sh(a, 'commit', '-q', '-am', 'a');
  sh(a, 'push', '-q', 'origin', 'main');

  // 乙：同一条改置顶和重要度、同时改了 gone01、AGENTS 块和人写结尾、加日志
  write(b, `${STORAGE}/abc123.json`, stringifyEntry({ ...base, pinned: true, importance: 5, updatedAt: '2026-11-25T09:00:00.000Z' }));
  write(b, `${STORAGE}/gone01.json`, stringifyEntry({ ...base, id: 'gone01', content: '会被删', importance: 5, updatedAt: '2026-11-25T09:00:00.000Z' }));
  write(b, 'AGENTS.md', agents('乙生成的块').replace('人写的结尾', '人写的结尾（乙补充）'));
  write(b, 'CHANGELOG.md', read(b, 'CHANGELOG.md') + '- 乙的工作\n');
  sh(b, 'commit', '-q', '-am', 'b');
  sh(b, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');

  assert.equal(sh(b, 'diff', '--name-only', '--diff-filter=U').trim(), '', '不应有未解决冲突');
  const merged = JSON.parse(read(b, `${STORAGE}/abc123.json`));
  assert.equal(merged.title, '甲改的标题');
  assert.equal(merged.pinned, true);
  assert.equal(merged.importance, 5);
  assert.equal(JSON.parse(read(b, `${STORAGE}/gone01.json`)).deleted, true);
  const md = read(b, 'AGENTS.md');
  assert.match(md, /人写的第一段（甲补充）/);
  assert.match(md, /人写的结尾（乙补充）/);
  assert.match(md, /乙生成的块/);
  assert.ok(!/<<<<<<<|>>>>>>>/.test(md));
  const log = read(b, 'CHANGELOG.md');
  assert.match(log, /甲的工作/);
  assert.match(log, /乙的工作/);

  // 乙推上去后甲再拉，两边内容一致
  sh(b, 'push', '-q', 'origin', 'main');
  sh(a, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
  assert.equal(read(a, `${STORAGE}/abc123.json`), read(b, `${STORAGE}/abc123.json`));
  fs.rmSync(work, { recursive: true, force: true });
});
