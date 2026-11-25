/**
 * 本机数字人：守则、焦点、风格、简报、叙事、重复归档、提交说明草稿。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const distUrl = 'file:///' + path.join(repoRoot, 'dist', 'twin-local.js').replace(/\\/g, '/');
const {
  CHARTER_TEXT,
  parseFocus,
  detectStyle,
  renderStyle,
  planTwin,
  parseGitStatus,
  draftCommitMessage,
  mergeCommitDraft,
  exactArchiveIds,
} = await import(distUrl);

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('当前焦点跳过占位，取第一条有效待办', () => {
  const focus = parseFocus(`# 目标\n\n## 当前焦点\n\n- （待填写）\n- 把测试补进 .youmengyu/test\n\n## 本周待办\n\n- 别的事\n`);
  assert.equal(focus, '把测试补进 .youmengyu/test');
  assert.equal(parseFocus('## 长期志向\n- 只写志向'), '');
});

test('2 空格、单引号、保留分号能被看出来', () => {
  const profile = detectStyle([
    {
      name: 'a.ts',
      text: "function hi() {\n  const name = 'a';\n  return name;\n}\n",
    },
  ]);
  assert.equal(profile.indent, '2');
  assert.equal(profile.quotes, 'single');
  assert.equal(profile.semicolons, 'always');
  assert.match(renderStyle(profile), /2 空格/);
  assert.match(renderStyle(profile), /单引号/);
});

test('一拍只补缺失的身份和目标，并带上守则、焦点、风格', () => {
  const plan = planTwin({
    day: '2026-11-25',
    hasIdentity: true,
    hasGoals: false,
    goalsText: '## 当前焦点\n\n- 稳住注入块\n',
    samples: [{ name: 'a.ts', text: "export const n = 'x';\n" }],
    branch: 'main',
    sessionTitles: ['记住对话'],
    ruleTitles: ['最小改动'],
    entries: [],
  });
  const rels = plan.files.map((f) => f.rel);
  assert.ok(!rels.includes('.youmengyu/memory/core/identity.md'));
  assert.ok(rels.includes('.youmengyu/memory/core/goals.md'));
  // 简报和叙事是本机内容，落在 .local/ 不入库，多终端同步不冲突
  assert.ok(rels.includes('.youmengyu/memory/evolution/.local/awareness.md'));
  assert.ok(rels.includes('.youmengyu/memory/evolution/.local/local-narrative.md'));
  assert.ok(!rels.includes('.youmengyu/memory/evolution/awareness.md'));
  const kinds = plan.memories.map((m) => m.kind);
  assert.deepEqual(kinds, ['charter', 'focus', 'style']);
  const charter = plan.memories[0];
  assert.equal(charter.pinned, true);
  assert.equal(charter.importance, 5);
  assert.equal(charter.content, CHARTER_TEXT);
  assert.match(charter.content, /禁止自动 git add、commit、push/);
  assert.equal(plan.memories[1].content, '稳住注入块');
  const awareness = plan.files.find((f) => f.rel.endsWith('awareness.md'));
  assert.match(awareness.content, /分支: main/);
  assert.match(awareness.content, /最小改动/);
});

test('正文相同只留置顶的那份', () => {
  const ids = exactArchiveIds([
    { id: 'b', content: '同一句话', pinned: false, importance: 2, uses: 0, updatedAt: '2026-01-01', versionCount: 0 },
    { id: 'a', content: '同一句话', pinned: true, importance: 5, uses: 1, updatedAt: '2026-01-02', versionCount: 0 },
    { id: 'c', content: '另一句', pinned: false, importance: 3, uses: 0, updatedAt: '2026-01-01', versionCount: 0 },
  ]);
  assert.deepEqual(ids, ['b']);
  const many = [];
  for (let i = 0; i < 5; i += 1) {
    many.push({
      id: `d${i}`,
      content: '完全相同的一句',
      pinned: i === 0,
      importance: 3,
      uses: 0,
      updatedAt: `2026-01-0${i + 1}`,
      versionCount: 0,
    });
  }
  assert.equal(exactArchiveIds(many).length, 2);
});

test('提交说明按路径归类，已有草稿只追加', () => {
  const parsed = parseGitStatus('M  src/a.ts\n?? README.md\nR  old.ts -> src/b.ts\n');
  assert.equal(parsed[2].path, 'src/b.ts');
  const testDraft = draftCommitMessage([{ status: 'M ', path: '.youmengyu/test/unit/a.test.mjs' }]);
  assert.match(testDraft, /^test: /);
  const merged = mergeCommitDraft('feat: 已有说明\n', testDraft);
  assert.match(merged, /feat: 已有说明/);
  assert.match(merged, /test: /);
  assert.equal(mergeCommitDraft(merged, testDraft).trim(), merged.trim());
});

test('插件接入本机一拍与提交说明，纯函数不依赖 vscode', () => {
  const src = read('src/twin-local.ts');
  assert.ok(!/from\s+'vscode'/.test(src));
  const ext = read('src/extension.ts');
  assert.match(ext, /startTwinRuntime/);
  assert.match(ext, /aimemory\.twin\.beat/);
  assert.match(ext, /aimemory\.commit\.draft/);
  const pkg = JSON.parse(read('package.json'));
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['aimemory.localTwin'].default, true);
  const cmds = pkg.contributes.commands.map((c) => c.command);
  assert.ok(cmds.includes('aimemory.commit.draft'));
  assert.match(read('README.md'), /起草提交说明/);
  assert.match(read('src/twin-loop.ts'), /scm-commit-msg\.txt/);
});
