/**
 * 更新日志按小时分节：完整 CHANGELOG.md，以及 git 用户的 CHANGELOG+用户名.md。
 * 打包时给当前小时标上版本号。手写的 Unreleased 条目不能被小时节盖掉。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const distUrl = 'file:///' + path.join(repoRoot, 'dist', 'changelog-log.js').replace(/\\/g, '/');
const syncUrl = 'file:///' + path.join(repoRoot, 'dist', 'changelog-sync.js').replace(/\\/g, '/');
const {
  hourBucket,
  personalChangelogName,
  isAiChange,
  parseGitLog,
  planPoints,
  pointsForPersonal,
  applyPoints,
  stampHourVersion,
} = await import(distUrl);
const { syncChangelogs } = await import(syncUrl);

const existing = `# 更新日志

## Unreleased

- 手写的完整记录留在这里

## 0.5.0 (2026-11-24)

- 旧版本条目
`;

test('git 用户名生成 CHANGELOG+用户名.md，非法字符去掉', () => {
  assert.equal(personalChangelogName('yansai'), 'CHANGELOG+yansai.md');
  assert.equal(personalChangelogName('a/b:c'), 'CHANGELOG+abc.md');
  assert.equal(personalChangelogName('   '), '');
});

test('提交和对话按小时分成 AI 与个人', () => {
  const commits = parseGitLog(
    [
      'yansai\x1f2026-11-25T14:20:00+08:00\x1ffix: 侧栏空白\x1fCo-authored-by: Cursor <cursor@cursor.com>\x1e',
      'yansai\x1f2026-11-25T13:05:00+08:00\x1f调整记忆面板文案\x1f\x1e',
      'other\x1f2026-11-25T13:10:00+08:00\x1f别人的提交\x1f\x1e',
    ].join('')
  );
  assert.equal(isAiChange(commits[0].subject, commits[0].body), true);
  assert.equal(isAiChange(commits[1].subject, commits[1].body), false);
  const points = planPoints({
    user: 'yansai',
    commits,
    transcripts: [
      {
        mtimeMs: new Date('2026-11-25T14:10:00+08:00').getTime(),
        text: JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: '<user_query>先修复插件打不开</user_query>' }] },
        }),
      },
    ],
  });
  const hours = points.map((point) => point.hour);
  assert.ok(hours.includes(hourBucket(new Date('2026-11-25T14:20:00+08:00'))));
  assert.ok(hours.includes(hourBucket(new Date('2026-11-25T13:05:00+08:00'))));
  const personal = pointsForPersonal(points, 'yansai');
  assert.ok(personal.some((point) => point.kind === 'ai' && point.text.includes('打不开')));
  assert.ok(personal.some((point) => point.kind === 'personal' && point.text.includes('调整记忆面板')));
  assert.equal(personal.some((point) => point.text.includes('别人的提交')), false);
  assert.ok(points.some((point) => point.text.includes('别人的提交')));
});

test('合并进完整日志时保留手写条目和旧版本，同一小时不重复', () => {
  const hour = '2026-11-25 14:00';
  const point = { hour, kind: 'ai', who: 'AI', text: '修复 Cursor 侧栏空白' };
  const once = applyPoints(existing, [point]);
  const twice = applyPoints(once, [point]);
  assert.equal(once, twice);
  assert.match(once, /手写的完整记录留在这里/);
  assert.match(once, /\n\n## 0\.5\.0 \(2026-11-24\)/);
  assert.match(once, /## Unreleased\n\n- 手写的完整记录/);
  assert.match(once, new RegExp(`### ${hour}\\n\\n- AI：修复 Cursor 侧栏空白`));
  const older = applyPoints(once, [{ hour: '2026-11-25 13:00', kind: 'personal', who: 'yansai', text: '改文案' }]);
  assert.ok(older.indexOf('### 2026-11-25 14:00') < older.indexOf('### 2026-11-25 13:00'));
  assert.ok(older.indexOf('手写的完整记录') < older.indexOf('### 2026-11-25 14:00'));
});

test('打包在当前小时标上版本号，已有版本不重复叠加', () => {
  const hour = '2026-11-25 14:00';
  const stamped = stampHourVersion(existing, '0.7.0', hour);
  assert.match(stamped, /### 2026-11-25 14:00 · v0\.7\.0/);
  assert.match(stamped, /手写的完整记录留在这里/);
  const again = stampHourVersion(stamped, '0.7.0', hour);
  assert.equal(again, stamped);
  const moved = stampHourVersion(stamped, '0.8.0', hour);
  assert.match(moved, /### 2026-11-25 14:00 · v0\.8\.0/);
  assert.doesNotMatch(moved, /v0\.7\.0/);
  const bare = stampHourVersion('# 更新日志 · 游梦鱼\n\n## Unreleased\n', '0.7.0', hour, '# 更新日志 · 游梦鱼');
  assert.match(bare, /## Unreleased\n\n### 2026-11-25 14:00 · v0\.7\.0/);
  assert.doesNotMatch(bare, /## Unreleased\n\n\n/);
});

test('同步写到临时目录：完整日志和个人日志都有，版本打在当前小时', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimem-changelog-'));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), existing, 'utf8');
  const now = new Date('2026-11-25T14:40:00');
  const result = syncChangelogs(dir, { now, stampVersion: '0.7.0', homeDir: dir });
  const full = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(full, /### 2026-11-25 14:00 · v0\.7\.0/);
  assert.match(full, /手写的完整记录留在这里/);
  assert.match(full, /## 0\.5\.0/);
  if (result.personalFile) {
    const personal = fs.readFileSync(path.join(dir, result.personalFile), 'utf8');
    assert.match(personal, /完整日志见 CHANGELOG\.md/);
    assert.match(personal, /### 2026-11-25 14:00 · v0\.7\.0/);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.package, /stamp-changelog\.mjs/);
  assert.match(fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8'), /startChangelogSync/);
});
