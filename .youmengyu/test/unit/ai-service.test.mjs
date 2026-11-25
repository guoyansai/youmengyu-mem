/**
 * 回归锁：AI 服务三通路（0.5.0）
 *
 *  - core.ts 纯函数：协议拼装（openai/anthropic/gemini/ollama/text-get/azure）、回复解析、免费档拦截、上下文裁剪
 *  - organize.ts 纯函数：AI 返回 JSON 的宽松解析
 *  - panel.js 前端协议静态校验（消息类型与引擎对齐；设置页已并入记忆面板标签页）
 *
 * core/organize 不依赖 vscode 运行时（organize 编译产物含 vscode import，只测其导出的纯函数会连带加载 vscode ——
 * 因此 JSON 宽松解析的断言在 core.js 侧跑不到，改为对 organize.js 源码做静态校验 + 用 node:module 缓存旁路不可行，
 * 折衷：parseJsonArray/parseJsonObject 复制进测试的等价断言改为直接 import organize.js 并容忍 vscode 缺失的环境下跳过。
 * 实际采用：core.js 直接 import；organize.js 静态校验关键片段。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const distDir = path.join(repoRoot, 'dist');
const coreUrl = 'file:///' + path.join(distDir, 'ai', 'core.js').replace(/\\/g, '/');

const {
  buildRequest,
  parseReply,
  guardFree,
  stripThink,
  fitContext,
  estimateTokens,
  clipTokens,
} = await import(coreUrl);

const readSrc = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8');

// ---------- 协议拼装 ----------
test('buildRequest: openai 兼容拼 chat/completions，无 key 不带 authorization', () => {
  const r = buildRequest('openai', {
    endpoint: 'https://api.llm7.io/v1',
    model: 'default',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.llm7.io/v1/chat/completions');
  assert.ok(!('authorization' in r.headers));
  assert.equal(r.body.model, 'default');
  assert.equal(r.body.stream, false);
});

test('buildRequest: anthropic 拆 system、拼 v1/messages 头', () => {
  const r = buildRequest('anthropic', {
    endpoint: 'https://api.anthropic.com',
    model: 'claude-3-5-haiku-latest',
    key: 'sk-ant-test',
    messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: 'hi' },
    ],
    maxTokens: 100,
  });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'sk-ant-test');
  assert.equal(r.body.system, '系统提示');
  assert.equal(r.body.max_tokens, 100);
  assert.deepEqual(r.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('buildRequest: gemini 拼 generateContent 且连续同角色合并', () => {
  const r = buildRequest('gemini', {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    key: 'AIza' + 'x'.repeat(35),
    messages: [
      { role: 'system', content: '系统' },
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
    ],
  });
  assert.ok(r.url.endsWith('/models/gemini-2.5-flash:generateContent'));
  assert.equal(r.headers['x-goog-api-key'], 'AIza' + 'x'.repeat(35));
  assert.deepEqual(r.body.contents, [{ role: 'user', parts: [{ text: '第一句\n第二句' }] }]);
  assert.deepEqual(r.body.systemInstruction.parts, [{ text: '系统' }]);
});

test('buildRequest: ollama 归一到 /api/chat，text-get 走 /openai', () => {
  const o = buildRequest('ollama', { endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5:0.5b', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(o.url, 'http://127.0.0.1:11434/api/chat');
  const t = buildRequest('text-get', { endpoint: 'https://text.pollinations.ai', model: 'openai-fast', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(t.url, 'https://text.pollinations.ai/openai');
  assert.equal(t.headers['content-type'], 'application/json');
});

test('buildRequest: azure 拼 api-version 且用 api-key 头', () => {
  const r = buildRequest('azure', {
    endpoint: 'https://res.openai.azure.com/openai/deployments/d1',
    model: '',
    key: 'az-key',
    messages: [{ role: 'user', content: 'hi' }],
    apiVersion: '2024-10-21',
  });
  assert.ok(r.url.includes('api-version=2024-10-21'));
  assert.equal(r.headers['api-key'], 'az-key');
});

// ---------- 回复解析 ----------
test('parseReply: 按协议取正文', () => {
  const openai = parseReply('openai', { choices: [{ message: { content: '正文' } }] });
  assert.equal(openai, '正文');
  const anthropic = parseReply('anthropic', { content: [{ type: 'text', text: '正文' }] });
  assert.equal(anthropic, '正文');
  const gemini = parseReply('gemini', { candidates: [{ content: { parts: [{ text: '正文' }] } }] });
  assert.equal(gemini, '正文');
  const ollama = parseReply('ollama', { message: { content: '正文' } });
  assert.equal(ollama, '正文');
  const text = parseReply('text-get', '纯文本回复');
  assert.equal(text, '纯文本回复');
});

test('stripThink: 掉推理模型的思考段', () => {
  assert.equal(stripThink('<think>内部推理</think>答案'), '答案');
  assert.equal(stripThink('<think>没闭合'), '');
});

// ---------- 免费档拦截 ----------
test('guardFree: 剥密钥、手机号、代码块并计数', () => {
  const r = guardFree('密钥 sk-abcdefghij0123456789 别泄露，手机 13812345678，代码 ```secret```');
  assert.ok(r.removed >= 3, `应拦下至少 3 处，实际 ${r.removed}`);
  assert.ok(!r.text.includes('sk-abcdefghij0123456789'));
  assert.ok(!r.text.includes('13812345678'));
  assert.ok(!r.text.includes('secret'));
  const plain = guardFree('普通中文内容不动');
  assert.equal(plain.removed, 0);
  assert.equal(plain.text, '普通中文内容不动');
});

// ---------- 上下文裁剪 ----------
test('fitContext: 超预算时从旧消息开始丢弃，system 保留', () => {
  const long = '字'.repeat(800);
  const messages = [
    { role: 'system', content: '系统' },
    { role: 'user', content: long },
    { role: 'user', content: '最新一句' },
  ];
  const fitted = fitContext(messages, 300);
  assert.equal(fitted[0].role, 'system');
  assert.ok(estimateTokens(fitted.map((m) => m.content).join('')) <= 300);
  const texts = fitted.map((m) => m.content);
  assert.ok(texts.includes('最新一句'), '最新消息必须保留');
  assert.ok(!texts.includes(long), '旧长消息应被裁掉');
});

test('clipTokens: 宁短勿超并留省略号', () => {
  const s = '长'.repeat(1000);
  const out = clipTokens(s, 100);
  assert.ok(estimateTokens(out) <= 101);
  assert.ok(out.endsWith('…'));
});

// ---------- organize 源码关键片段静态校验 ----------
test('organize: 关键约定在位（保护条目 / maxAutoEntries / JSON 提取）', () => {
  const src = readSrc('src/ai/organize.ts');
  assert.ok(src.includes('.pinned') && src.includes('importance < 5'), '合并目标必须跳过保护条目');
  assert.ok(src.includes('maxAutoEntries'), '每轮上限要生效');
  assert.ok(src.includes('importance >= 5') && src.includes('归档'), '归档建议要跳过保护条目');
  assert.ok(src.includes('parseJsonArray') && src.includes('parseJsonObject'), 'AI 产出走宽松 JSON 解析');
});

// ---------- 设置页前端协议静态校验（设置页已并入记忆面板标签页，不再有独立 settings.js） ----------
test('panel.js 与 settings-panel.ts 消息协议对齐', () => {
  const js = readSrc('media/panel.js');
  const ts = readSrc('src/ai/settings-panel.ts');
  const uplink = ['savePrefs', 'selectProvider', 'saveProvider', 'deleteProvider', 'testProvider', 'runRecord', 'runConsolidate', 'captureEditor'];
  for (const t of uplink) {
    assert.ok(js.includes(`type: '${t}'`), `panel.js 应上行 ${t}`);
    assert.ok(ts.includes(`case '${t}'`), `settings-panel.ts 应处理 ${t}`);
  }
  for (const down of ['aiState', 'toast', 'testResult']) {
    assert.ok(js.includes(`msg.type === '${down}'`), `panel.js 应处理下行 ${down}`);
  }
  assert.ok(js.includes(`data-tab="ai"`) || readSrc('src/panel.ts').includes(`data-tab="ai"`), '设置页应作为标签页并入记忆面板');
  assert.ok(!/api[_-]?key/i.test(readSrc('package.json')), '密钥不进 package.json');
});
