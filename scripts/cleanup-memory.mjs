#!/usr/bin/env node
/**
 * 游梦鱼·长记忆 — 一键清理无用/重复/垃圾记忆条目
 *
 * 用法:
 *   node scripts/cleanup-memory.mjs                # 默认：dry-run，只报告不删除
 *   node scripts/cleanup-memory.mjs --apply         # 实际执行删除
 *   node scripts/cleanup-memory.mjs --apply --aggressive  # 激进模式（连叙事类也清）
 *   node scripts/cleanup-memory.mjs --json          # 输出 JSON 报告
 *
 * 清理三类脏数据:
 *   1. 纯垃圾 — 只有一行无意义失败（"Network request failed" 等），无技术内容
 *   2. 重复副本 — 同语义的两个条目，保留更完整那份
 *   3. 模板废话 — 每日自我叙事、深度反刍（--aggressive 才清）
 */

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STORAGE_DIR = join(ROOT, '.youmengyu', 'memory', 'long-memory');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const aggressive = args.includes('--aggressive');
const jsonReport = args.includes('--json');

// ---------- 工具 ----------
function log(step, msg) { if (!jsonReport) console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`); }
function ok(msg) { if (!jsonReport) console.log(`\x1b[32m  ✓\x1b[0m ${msg}`); }
function warn(msg) { if (!jsonReport) console.log(`\x1b[33m  ⚠\x1b[0m ${msg}`); }
function fail(msg) { console.error(`\x1b[31m  ✗\x1b[0m ${msg}`); process.exit(1); }

function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  const latin = lower.match(/[a-z0-9_$.-]{2,}/g) || [];
  const cjk = lower.match(/[\u4e00-\u9fa5]+/g) || [];
  const grams = [];
  for (const c of cjk) {
    if (c.length === 1) grams.push(c);
    else for (let i = 0; i < c.length - 1; i++) grams.push(c.slice(i, i + 2));
  }
  return [...latin, ...grams];
}

function similarity(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.sqrt(ta.size * tb.size);
}

// ---------- 垃圾检测 ----------

/** 纯失败关键词 — 只有这些的条目，无技术内容 */
const PURE_FAILURE_PATTERNS = [
  /network request failed/i,
  /database is locked/i,
  /invalid user api key/i,
];

/** 任务指令/验收标准（不是教训） */
const TASK_ONLY_PATTERNS = [
  /请按 unknown/i,
  /失败模式不再复现/,
  /验收标准/,
  /## 验收/,
];

/** 模板废话 — 每日叙事 */
const NARRATIVE_PATTERNS = [
  /自我叙事/,
  /这段时间里共记录了\s*\d+\s*件任务/,
  /深度反刍/,
  /重复\s*\d+\s*次/,
];

/** 综合判断是否为纯垃圾 */
function isPureGarbage(entry) {
  const content = entry.content;
  const norm = normalize(content);

  // 1. 只有一行短内容 + 匹配纯失败关键词
  if (norm.length <= 30) {
    if (PURE_FAILURE_PATTERNS.some((re) => re.test(norm))) return { reason: '纯失败关键词无技术内容', category: 'pure-failure' };
  }

  // 2. 只有任务指令（不是实际教训）
  if (TASK_ONLY_PATTERNS.some((re) => re.test(content))) {
    return { reason: '任务指令/验收标准非教训', category: 'task-only' };
  }

  // 3. content 只写了失败名，没有任何解决方案/教训
  const lineCount = content.split('\n').filter((l) => l.trim()).length;
  const hasLessonMarker = /教训|应该|必须|要|不得|否则|记得|排障|症状|原因/.test(content);
  const hasSource = /（.*?\d{4}/.test(content);
  if (lineCount <= 2 && !hasLessonMarker && !hasSource) {
    if (/^\s*[-*]?\s*失败[：:]/m.test(content) || /^失败[：:]/.test(content.trim())) {
      return { reason: '只有失败名无解决方案', category: 'no-solution' };
    }
  }

  // 4. 深度反刍模板 — "重复 N 次"出现 ≥ 3 次就是垃圾噪音
  const repeatMatches = content.match(/（重复\s*\d+\s*次）/g);
  if (repeatMatches && repeatMatches.length >= 3) {
    return { reason: `模板化重复次数 ×${repeatMatches.length}，无实质教训`, category: 'template-ruminate' };
  }

  return null;
}

/** 模板废话（--aggressive 才清） */
function isTemplateNoise(entry) {
  const content = entry.content;
  const matched = NARRATIVE_PATTERNS.filter((re) => re.test(content));
  if (matched.length >= 2) {
    return { reason: `匹配模板废话模式 ×${matched.length}`, category: 'template-noise' };
  }
  return null;
}

// ---------- 主流程 ----------

log('扫描', `记忆目录: ${relative(ROOT, STORAGE_DIR)}`);

if (!existsSync(STORAGE_DIR)) fail(`目录不存在: ${STORAGE_DIR}`);

const files = readdirSync(STORAGE_DIR)
  .filter((n) => n.endsWith('.json') && !n.startsWith('.'));

ok(`发现 ${files.length} 个记忆条目文件`);

// 加载所有条目
const entries = [];
const loadErrors = [];
for (const f of files) {
  try {
    const raw = JSON.parse(readFileSync(join(STORAGE_DIR, f), 'utf-8'));
    entries.push({ ...raw, _file: f });
  } catch (e) {
    loadErrors.push({ file: f, error: String(e.message || e) });
  }
}
if (loadErrors.length) {
  warn(`${loadErrors.length} 个文件损坏，跳过: ${loadErrors.map((e) => e.file).join(', ')}`);
}

let bytesSaved = 0;

// Phase 1: 纯垃圾
log('Phase 1', '检测纯垃圾条目');
const pureGarbage = [];
const survivors = [];
for (const e of entries) {
  const hit = isPureGarbage(e);
  if (hit) pureGarbage.push({ ...e, _hit: hit });
  else survivors.push(e);
}
ok(`纯垃圾: ${pureGarbage.length} 条`);
for (const e of pureGarbage) {
  warn(`  ${e.id} · ${e.title.slice(0, 40)} — ${e._hit.reason}`);
}

// Phase 2: 模板废话（仅 --aggressive）
let templateNoise = [];
if (aggressive) {
  log('Phase 2', '检测模板废话（--aggressive）');
  for (const e of survivors) {
    const hit = isTemplateNoise(e);
    if (hit) templateNoise.push({ ...e, _hit: hit });
  }
  if (templateNoise.length) ok(`模板废话: ${templateNoise.length} 条`);
  for (const e of templateNoise) {
    warn(`  ${e.id} · ${e.title.slice(0, 40)} — ${e._hit.reason}`);
  }
}

// Phase 3: 重复副本
log('Phase 3', '检测重复副本');
const toRemove = new Set([...pureGarbage, ...templateNoise].map((e) => e.id));
const dupesFound = [];

const candidateList = survivors.filter((e) => !toRemove.has(e.id));
// 两两比较相似度
for (let i = 0; i < candidateList.length; i++) {
  if (toRemove.has(candidateList[i].id)) continue;
  for (let j = i + 1; j < candidateList.length; j++) {
    if (toRemove.has(candidateList[j].id)) continue;
    const a = candidateList[i], b = candidateList[j];
    const sim = similarity(
      normalize(`${a.title} ${a.content}`),
      normalize(`${b.title} ${b.content}`)
    );
    if (sim >= 0.85) {
      // 保留更完整的那份（content 更长 + 有 source 字段）
      const aScore = a.content.length + (a.source ? 200 : 0) + ((a.versions?.length || 0) * 50);
      const bScore = b.content.length + (b.source ? 200 : 0) + ((b.versions?.length || 0) * 50);
      const keep = aScore >= bScore ? a : b;
      const drop = keep === a ? b : a;
      toRemove.add(drop.id);
      dupesFound.push({ keep: keep.id, drop: drop.id, sim: sim.toFixed(2) });
    }
  }
}
if (dupesFound.length) ok(`重复副本: ${dupesFound.length} 组`);
for (const d of dupesFound) {
  warn(`  删 ${d.drop} → 留 ${d.keep} (相似度 ${d.sim})`);
}

// ---------- 执行删除 ----------
const removeList = [...pureGarbage, ...templateNoise, ...survivors.filter((e) => toRemove.has(e.id) && !pureGarbage.includes(e) && !templateNoise.includes(e))];
const uniqueRemove = [];
const seen = new Set();
for (const e of removeList) {
  if (!seen.has(e.id)) { seen.add(e.id); uniqueRemove.push(e); }
}

log('Phase 4', apply ? `执行删除 ${uniqueRemove.length} 条` : `DRY-RUN: 将删除 ${uniqueRemove.length} 条`);

if (apply) {
  for (const e of uniqueRemove) {
    const fpath = join(STORAGE_DIR, e._file);
    try {
      const size = existsSync(fpath) ? readFileSync(fpath).length : 0;
      rmSync(fpath, { force: true });
      bytesSaved += size;
      ok(`  删 ${e._file} · ${e.title.slice(0, 40)}`);
    } catch (err) {
      fail(`  删除失败 ${e._file}: ${err.message}`);
    }
  }
}

// ---------- 输出报告 ----------
const report = {
  mode: apply ? 'apply' : 'dry-run',
  aggressive,
  totalBefore: files.length,
  wouldRemove: uniqueRemove.length,
  breakdown: {
    pureFailure: pureGarbage.filter((e) => e._hit.category === 'pure-failure').length,
    taskOnly: pureGarbage.filter((e) => e._hit.category === 'task-only').length,
    noSolution: pureGarbage.filter((e) => e._hit.category === 'no-solution').length,
    templateNoise: templateNoise.length,
    duplicateCopy: dupesFound.length,
  },
  details: uniqueRemove.map((e) => ({
    id: e.id,
    file: e._file,
    title: e.title,
    reason: e._hit?.reason || '重复副本',
    category: e._hit?.category || 'duplicate',
  })),
  bytesSaved,
  remaining: files.length - uniqueRemove.length,
};

if (jsonReport) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n\x1b[1m清理报告\x1b[0m`);
  console.log(`  总条目: ${report.totalBefore}`);
  console.log(`  ${apply ? '已删除' : '将删除'}: ${report.wouldRemove} 条`);
  console.log(`  剩余: ${report.remaining} 条`);
  if (apply) console.log(`  节省: ${(report.bytesSaved / 1024).toFixed(1)} KB`);
  console.log(`\n  分类:`);
  console.log(`    纯失败无技术内容    ${report.breakdown.pureFailure}`);
  console.log(`    任务指令非教训      ${report.breakdown.taskOnly}`);
  console.log(`    只有失败名无解法    ${report.breakdown.noSolution}`);
  if (aggressive) console.log(`    模板废话(叙事/反刍) ${report.breakdown.templateNoise}`);
  console.log(`    重复副本            ${report.breakdown.duplicateCopy}`);

  if (!apply && report.wouldRemove > 0) {
    console.log(`\n\x1b[33m提示: 加 --apply 实际执行删除，或 --apply --aggressive 连模板叙事也清\x1b[0m`);
  }
}

// 输出 JSON 报告文件
const reportDir = join(ROOT, '.youmengyu', 'test', 'reports');
mkdirSync(reportDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(join(reportDir, `cleanup-${ts}.json`), JSON.stringify(report, null, 2));
if (!jsonReport) ok(`报告已写入 .youmengyu/test/reports/cleanup-${ts}.json`);