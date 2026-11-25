/**
 * 安装后自动记住当前 Agent 对话：解析 jsonl、提炼规则、重复则强化、会话不进注入块。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const distUrl = 'file:///' + path.join(repoRoot, 'dist', 'agent-learn.js').replace(/\\/g, '/');
const {
  workspaceSlug,
  agentTranscriptDir,
  parseTranscript,
  distillTurns,
  planLearn,
  redact,
  transcriptSettled,
  pickTranscriptBatch,
  collectTranscriptFiles,
  ruleKey,
  takeLearnWrites,
  disposableMemoryIds,
  isDurableRule,
  MAX_SESSION_FILES,
  LEARN_WRITE_BUDGET,
} = await import(distUrl);

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('工作区路径映射到 Cursor 项目目录（盘符小写，其余保持原样）', () => {
  const slug = workspaceSlug('D:\\Web\\aicodingmem');
  assert.equal(slug, 'd-Web-aicodingmem');
  const dir = agentTranscriptDir('D:\\Web\\aicodingmem', 'C:\\Users\\WEB');
  assert.equal(dir, path.join('C:\\Users\\WEB', '.cursor', 'projects', 'd-Web-aicodingmem', 'agent-transcripts'));
});

test('解析 Agent jsonl：取出用户问题，丢掉只有工具调用的回合', () => {
  const raw = [
    JSON.stringify({
      role: 'user',
      message: {
        content: [{ type: 'text', text: '<timestamp>t</timestamp>\n<user_query>\n发布前必须跑完全量测试\n</user_query>' }],
      },
    }),
    JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
    }),
    JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: '结论：下次必须先跑测试，这是教训。' }] },
    }),
    JSON.stringify({ type: 'turn_ended', status: 'success' }),
  ].join('\n');
  const turns = parseTranscript(raw);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[0].text, '发布前必须跑完全量测试');
  assert.equal(turns[1].role, 'assistant');
  assert.match(turns[1].text, /必须先跑测试/);
});

test('对话收成可检索会话，规则进入长记忆且不携带密钥', () => {
  const turns = parseTranscript(
    JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: '<user_query>\n禁止把密钥写进仓库，token=sk-abcdefghijklmnopqrstuvwxyz\n</user_query>' }] },
    })
  );
  assert.match(turns[0].text, /密钥已省略|已省略/);
  assert.equal(redact('sk-abcdefghijklmnopqrstuvwxyz').includes('sk-abc'), false);
  const drafts = distillTurns(turns, 'sess-1');
  const session = drafts.find((d) => d.kind === 'session');
  const rule = drafts.find((d) => d.kind === 'rule');
  assert.ok(session);
  assert.equal(session.metadata.inject, 'skip');
  assert.equal(session.space, 'agent');
  assert.equal(session.source, 'agent:sess-1');
  assert.ok(rule);
  assert.equal(rule.metadata.inject, undefined);
  assert.match(rule.content, /禁止把密钥写进仓库/);
  assert.equal(rule.content.includes('sk-abc'), false);
});

test('同一约定再次出现则提高重要性；不相干的句子另起一条', () => {
  const again = {
    kind: 'rule',
    title: '发布前必须跑完全量测试',
    content: '发布前必须跑完全量测试',
    tags: ['workflow'],
    importance: 4,
    source: 'agent:s2',
    space: 'default',
    metadata: { kind: 'rule' },
  };
  const existing = [
    {
      id: 'e1',
      title: '发布前必须跑完全量测试',
      content: '发布前必须跑完全量测试才能合并',
      importance: 4,
      metadata: { kind: 'rule' },
    },
  ];
  const strengthened = planLearn([again], existing);
  assert.equal(strengthened.length, 1);
  assert.equal(strengthened[0].op, 'strengthen');
  assert.equal(strengthened[0].importance, 5);

  const other = { ...again, title: '界面用中文', content: '面板文案保持中文' };
  const added = planLearn([other], existing);
  assert.equal(added[0].op, 'add');

  const capped = planLearn([again], [{ ...existing[0], importance: 5 }]);
  assert.equal(capped[0].op, 'touch');
});

test('已记住的会话在内容变化时更新同一条，而不是再新增', () => {
  const [session] = distillTurns(
    [
      { role: 'user', text: '记住：提交前必须看 diff' },
      { role: 'assistant', text: '好的。' },
    ],
    'sess-9'
  );
  const first = planLearn([session], []);
  assert.equal(first[0].op, 'add');
  const longer = distillTurns(
    [
      { role: 'user', text: '记住：提交前必须看 diff' },
      { role: 'user', text: '另外补一条说明' },
      { role: 'assistant', text: '已记下。' },
    ],
    'sess-9'
  ).find((d) => d.kind === 'session');
  const second = planLearn([longer], [{ id: 'old', title: session.title, content: session.content, importance: 2, source: session.source, metadata: session.metadata }]);
  assert.equal(second[0].op, 'update-session');
  assert.equal(second[0].id, 'old');
});

test('未写完的对话不立刻落会话摘要；安静或回合结束后才落', () => {
  const now = 1_000_000;
  assert.equal(transcriptSettled('{"role":"user"}', now - 1000, now), false);
  assert.equal(transcriptSettled('{"type":"turn_ended","status":"success"}', now, now), true);
  assert.equal(transcriptSettled('{"role":"user"}', now - 46_000, now), true);
  const turns = [{ role: 'user', text: '必须先读 AGENTS.md 再改代码' }];
  const live = distillTurns(turns, 'live', { includeSession: false });
  assert.equal(live.some((d) => d.kind === 'session'), false);
  assert.equal(live.some((d) => d.kind === 'rule'), true);
});

test('每轮只挑有变化的最近对话，已落盘的跳过', () => {
  const files = [
    { file: 'a', sessionId: 'a', mtimeMs: 10, size: 1 },
    { file: 'b', sessionId: 'b', mtimeMs: 50, size: 2 },
    { file: 'c', sessionId: 'c', mtimeMs: 30, size: 3 },
  ];
  const cursors = {
    a: { size: 1, mtimeMs: 10, sessionWritten: true, ruleKeys: [] },
    c: { size: 3, mtimeMs: 30, sessionWritten: false, ruleKeys: [] },
  };
  const picked = pickTranscriptBatch(files, cursors, 8, 40_000);
  assert.deepEqual(picked.map((f) => f.file), ['b']);
  const idle = pickTranscriptBatch(files, cursors, 8, 80_000);
  assert.deepEqual(idle.map((f) => f.file), ['b', 'c']);
  assert.ok(ruleKey('  必须 A ') === ruleKey('必须A'));
});

test('能扫到子目录里的 jsonl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-agent-'));
  try {
    const nested = path.join(dir, 'abc', 'abc.jsonl');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, '{}\n', 'utf8');
    const files = collectTranscriptFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].sessionId, 'abc');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('过程句和系统噪声不单独占记忆文件', () => {
  const drafts = distillTurns(
    [
      { role: 'user', text: '我先读开工助手和本次查修约定，再把统计修通。不能一次改很多文件。' },
      { role: 'assistant', text: '先看开工助手里的约定和验收，再开始改。' },
      { role: 'user', text: 'Briefly inform the user about the task result and perform any follow-up actions.' },
    ],
    'sess-noise'
  );
  const rules = drafts.filter((d) => d.kind === 'rule').map((d) => d.content);
  assert.deepEqual(rules, ['不能一次改很多文件。']);
  assert.equal(isDurableRule('我先读开工助手和本次查修约定'), false);
  assert.equal(isDurableRule('不能存储太多文件，也不能一次改很多'), true);
  const session = drafts.find((d) => d.kind === 'session');
  assert.equal(session.content.includes('Briefly inform'), false);
});

test('已有句子被包含时并进原条目，不再新建文件', () => {
  const again = {
    kind: 'rule',
    title: '不能一次改很多文件',
    content: '不能一次改很多文件，重复的记忆要并进去',
    tags: ['preference'],
    importance: 4,
    source: 'agent:s3',
    space: 'default',
    metadata: { kind: 'rule' },
  };
  const existing = [
    {
      id: 'e9',
      title: '不能一次改很多文件',
      content: '不能一次改很多文件，重复的记忆要并进去，有用的才留',
      importance: 4,
      metadata: { kind: 'rule' },
    },
  ];
  const actions = planLearn([again], existing);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].op, 'strengthen');
  assert.equal(actions[0].id, 'e9');
});

test('会话和规则都有上限，一拍最多改两个文件', () => {
  const sessions = Array.from({ length: MAX_SESSION_FILES }, (_, i) => ({
    id: `s${i}`,
    title: `对话${i}`,
    content: `会话 ${i}`,
    importance: 2,
    source: `agent:old-${i}`,
    metadata: { kind: 'session', inject: 'skip' },
  }));
  const draft = {
    kind: 'session',
    title: '对话·新的',
    content: '会话 new\n用户（1 轮）：\n- 必须留下这条新会话',
    tags: ['workflow'],
    importance: 2,
    source: 'agent:new',
    space: 'agent',
    metadata: { kind: 'session', inject: 'skip' },
  };
  assert.equal(planLearn([draft], sessions).length, 0);
  const rule = {
    kind: 'rule',
    title: '必须留下这条',
    content: '必须留下这条有用的约定',
    tags: ['workflow'],
    importance: 4,
    source: 'agent:new',
    space: 'default',
    metadata: { kind: 'rule' },
  };
  const sessionAdd = { op: 'add', draft, key: 'session:agent:new' };
  const ruleAdd = { op: 'add', draft: rule, key: 'rule' };
  const extra = { op: 'update-session', id: 's0', draft, key: 'session:agent:old-0' };
  const picked = takeLearnWrites([sessionAdd, ruleAdd, extra], LEARN_WRITE_BUDGET);
  assert.equal(picked.taken.filter((a) => a.op !== 'touch').length, 2);
  assert.equal(picked.taken[0].op, 'add');
  assert.equal(picked.taken[0].draft.kind, 'rule');
  assert.equal(picked.deferred.length, 1);
  assert.equal(picked.deferred[0].op, 'update-session');
});

test('过程句和超额旧会话每拍只退役一小批', () => {
  const entries = [
    {
      id: 'noise',
      title: '先看',
      content: '我先读开工助手和本次查修约定，再对着列表实现。',
      importance: 3,
      metadata: { by: 'agent-learn', kind: 'rule' },
      updatedAt: '2026-11-25T00:00:00.000Z',
    },
    {
      id: 'keep',
      title: '禁止',
      content: '禁止把密钥写进仓库',
      importance: 4,
      metadata: { by: 'agent-learn', kind: 'rule' },
      updatedAt: '2026-11-25T00:00:00.000Z',
    },
  ];
  for (let i = 0; i < MAX_SESSION_FILES + 2; i += 1) {
    entries.push({
      id: `sess-${i}`,
      title: `对话${i}`,
      content: `会话 ${i}`,
      importance: 2,
      metadata: { by: 'agent-learn', kind: 'session', inject: 'skip' },
      updatedAt: `2026-11-2${i < 10 ? 0 : 1}T00:00:0${i % 10}.000Z`,
    });
  }
  const ids = disposableMemoryIds(entries, 2);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], 'noise');
  assert.equal(ids.includes('keep'), false);
});

test('激活时接上自动记忆，未写完不落盘，写过的会话不会紧接着再改', () => {
  const ext = read('src/extension.ts');
  const pkg = JSON.parse(read('package.json'));
  const props = pkg.contributes.configuration.properties;
  assert.match(ext, /startAgentMemory\(store/);
  assert.match(ext, /generateInject\(store, \{ silent: true \}\)/);
  assert.equal(props['aimemory.autoInject'].default, true);
  assert.equal(props['aimemory.autoAgentMemory'].default, true);
  assert.match(read('src/agent-loop.ts'), /if \(!settled\) continue/);
  assert.match(read('src/agent-loop.ts'), /LEARN_WRITE_BUDGET/);
  assert.match(read('src/agent-loop.ts'), /sessionCooling/);
  assert.match(read('src/store.ts'), /countsForInject/);
  assert.match(read('src/ai/organize.ts'), /get<boolean>\('autoInject', true\)/);
  assert.match(read('README.md'), /记住当前 Agent 的全部对话/);
  assert.match(read('README.md'), /aimemory\.autoAgentMemory/);
});
