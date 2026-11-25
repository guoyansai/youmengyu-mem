/**
 * 回归锁：游梦鱼数字人 .youmengyu 记忆导入。
 *
 * - 静态校验：命令注册、配置项、纯函数模块无 vscode 依赖
 * - 功能校验：dist 编译产物存在时，用临时目录夹具跑真实解析与收集
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readSrc = (f) => fs.readFileSync(path.join(repoRoot, 'src', f), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

test('package.json 注册数字人导入命令与配置项', () => {
  const cmds = pkg.contributes.commands.map((c) => c.command);
  assert.ok(cmds.includes('aimemory.import.youmengyu'), '缺少命令 aimemory.import.youmengyu');
  const props = pkg.contributes.configuration.properties;
  assert.ok(props['aimemory.youmengyuRoot'], '缺少配置 aimemory.youmengyuRoot');
  assert.ok(props['aimemory.youmengyuAutoImport'], '缺少配置 aimemory.youmengyuAutoImport');
});

test('youmengyu.ts 保持纯函数（不依赖 vscode），导出收集器与解析器', () => {
  const src = readSrc('youmengyu.ts');
  assert.ok(!/from\s+'vscode'/.test(src), 'youmengyu.ts 不应 import vscode，否则 node --test 无法回归');
  assert.ok(/export function collectYoumengyuEntries/.test(src), '缺少 collectYoumengyuEntries');
  assert.ok(/export function parseLessonsSections/.test(src), '缺少 parseLessonsSections');
  assert.ok(/export function parseProceduralBody/.test(src), '缺少 parseProceduralBody');
  assert.ok(/episodic/.test(src), '应注释说明 episodic 运行流水不导入');
});

test('extension.ts 接入数字人导入：命令 + 自动导入 + 空间', () => {
  const src = readSrc('extension.ts');
  assert.ok(/aimemory\.import\.youmengyu/.test(src), '未注册 aimemory.import.youmengyu');
  assert.ok(/youmengyuAutoImport/.test(src), '未按配置做激活自动导入');
  assert.ok(/collectYoumengyuEntries/.test(src), '未调用 collectYoumengyuEntries');
  assert.ok(/YOUMENGYU_SPACE/.test(src), '未使用数字人空间');
});

test('解析与收集：lessons 分节、procedural 取最新块、core 置顶、幂等合并', async (t) => {
  const distFile = path.join(repoRoot, 'dist', 'youmengyu.js');
  if (!fs.existsSync(distFile)) {
    t.skip('dist/youmengyu.js 未编译（npm run compile 后此用例生效）');
    return;
  }
  const ym = createRequire(import.meta.url)(distFile);

  // lessons.md 分节（含嵌套 ## 与失败流水回退）
  const lessons = [
    '## 2026-11-24T04:55:54.644Z [learn, codebuddy]',
    '权限目录只认 capabilities.list() 的 id；菜单与后端登记必须同名。',
    '',
    '## 2026-11-23T11:22:02.135Z [learn, codebuddy]',
    '复用工作室树时模板 fs.write 要包一层 flush。',
    '',
    '## 2026-11-22T00:00:00.000Z [learn]',
    '- 失败：# 修复重复失败：unknown',
    '',
    '来源：意识活动时段',
    '类型：fix-failure',
    '',
    '## 任务',
    '请按 unknown 的失败模式补回归用例',
    '',
    '## 2026-11-21T00:00:00.000Z',
    '- 失败：Invalid User API Key',
  ].join('\n');
  const secs = ym.parseLessonsSections(lessons);
  assert.equal(secs.length, 4, `嵌套 ## 任务/## 验收 不应拆分节，实际 ${secs.length}`);
  assert.match(secs[0].header, /2026-11-24/);
  assert.match(secs[0].body, /capabilities\.list/);
  assert.match(secs[2].body, /## 任务/, '嵌套 ## 行应留在本节正文里');

  // procedural 最新块 + 同文去重
  const proc = [
    '# fix-x',
    '--- score: 0.5 ts: 2026-01-01T00:00:00.000Z ---',
    '旧版步骤 v1',
    '--- score: 0.9 ts: 2026-06-01T00:00:00.000Z ---',
    '新版步骤 v2',
    '--- score: 0.9 ts: 2026-06-02T00:00:00.000Z ---',
    '新版步骤 v2',
  ].join('\n');
  assert.equal(ym.parseProceduralBody(proc), '新版步骤 v2');

  // 临时数字人仓库夹具 → collect
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-import-'));
  const mem = path.join(root, '.youmengyu', 'memory');
  fs.mkdirSync(path.join(mem, 'core'), { recursive: true });
  fs.mkdirSync(path.join(mem, 'semantic'), { recursive: true });
  fs.mkdirSync(path.join(mem, 'procedural'), { recursive: true });
  fs.mkdirSync(path.join(mem, 'episodic'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'core', 'identity.md'), '你是游梦鱼数字开发工程师，服务于主人', 'utf-8');
  fs.writeFileSync(path.join(mem, 'core', 'goals.md'), '# 目标\n\n## 当前焦点\n- 自动化记忆导入');
  fs.writeFileSync(path.join(mem, 'semantic', 'lessons.md'), lessons, 'utf-8');
  fs.writeFileSync(path.join(mem, 'semantic', 'user-preferences.md'), '# user-preferences\n主人偏好：最小改动、省 token');
  fs.writeFileSync(path.join(mem, 'procedural', 'fix-bug.md'), proc, 'utf-8');
  fs.writeFileSync(path.join(mem, 'procedural', '自定义教训.md'), '--- score: 1 ts: 2026-11-24T00:00:00.000Z ---\n门禁用例要当场能抓住静默失败。');
  fs.writeFileSync(path.join(mem, 'repo.md'), '# 仓库架构记忆 — demo\n核心模块：lib/paths（被引 90）');
  fs.writeFileSync(path.join(mem, 'episodic', '2026-11-24.jsonl'), '{"ts":"2026-11-24T00:00:00Z","event":"task:complete"}');
  fs.writeFileSync(path.join(mem, 'bus.jsonl'), '{"noise":true}');

  const r = ym.collectYoumengyuEntries(root);
  assert.ok(r.files >= 7, `应读到 >=7 个来源文件，实际 ${r.files}`);
  const byTitle = new Map(r.entries.map((e) => [e.title, e]));
  // episodic / bus 运行流水不导入
  assert.ok(![...byTitle.keys()].some((t2) => /2026-11-24\.jsonl|bus/.test(t2)), '运行流水不应被导入');
  // identity 置顶 P5
  const identity = r.entries.find((e) => /游梦鱼数字开发工程师/.test(e.content));
  assert.ok(identity, 'identity 应被导入');
  assert.equal(identity.pinned, true);
  assert.equal(identity.importance, 5);
  assert.ok(identity.tags.includes('preference'));
  // lessons 分节导入为独立教训
  assert.ok(r.entries.some((e) => /capabilities\.list/.test(e.content) && e.tags.includes('lesson')));
  assert.ok(r.entries.some((e) => /fs\.write 要包一层 flush/.test(e.content)));
  // 失败流水节：标题回退为失败摘要，而不是时间戳或元数据行
  assert.ok(
    r.entries.some((e) => e.title.includes('失败：Invalid User API Key')),
    '纯失败流水节的标题应回退为失败摘要'
  );
  assert.ok(!r.entries.some((e) => e.title === '来源：意识活动时段'), '复盘元数据行不得当标题');
  // procedural fix-bug → workflow，自定义教训 → lesson
  const workflow = r.entries.find((e) => e.tags.includes('workflow') && /新版步骤 v2/.test(e.content));
  assert.ok(workflow, 'fix-bug 应以 workflow 导入且取最新块');
  const custom = r.entries.find((e) => /门禁用例要当场能抓住/.test(e.content));
  assert.ok(custom && custom.tags.includes('lesson'), '自定义 procedural 教训应以 lesson 导入');
  // 元数据与来源
  const anyE = r.entries[0];
  assert.equal(anyE.metadata['来源'], '游梦鱼数字人');
  assert.match(anyE.source, /\.youmengyu\/memory\//);

  // 清理夹具
  fs.rmSync(root, { recursive: true, force: true });
});
