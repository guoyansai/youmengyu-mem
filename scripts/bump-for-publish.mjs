#!/usr/bin/env node
/**
 * npm run publish 的入口：先按改动进版本号，再编译并 vsce publish。
 *
 *   node scripts/bump-for-publish.mjs            # 自动：界面/小改动末位，更大改动次位
 *   node scripts/bump-for-publish.mjs patch
 *   node scripts/bump-for-publish.mjs minor
 *   node scripts/bump-for-publish.mjs --dry-run  # 只打印，不写盘、不发布
 *
 * 最左一位（主版本）不在这里改，用 npm run release:major。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changesForPublish, classifyBump, nextVersion, writeVersionFiles } from './version-bump.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const bumpOnly = args.includes('--bump-only');
const levelArg = args.find((a) => !a.startsWith('--')) || 'auto';

function fail(msg) {
  console.error(`\x1b[31m[publish]\x1b[0m ${msg}`);
  process.exit(1);
}

if (levelArg === 'major') {
  fail('最左一位（主版本）只手动更新。请直接改 package.json 的 version，或执行 npm run release:major');
}
if (!['auto', 'patch', 'minor'].includes(levelArg)) {
  fail(`未知参数: ${levelArg}（auto / patch / minor，或 --dry-run）`);
}

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const current = pkg.version;
let level = levelArg;
let reason = '指定级别';
if (levelArg === 'auto') {
  const decision = classifyBump(changesForPublish(ROOT, current));
  level = decision.level;
  reason = decision.reason;
}

let next;
try {
  next = nextVersion(current, level);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

console.log(`[publish] ${current} → ${next}（${reason}）`);
if (dry) {
  console.log('[publish] dry-run：未改版本，未发布');
  process.exit(0);
}

writeVersionFiles(ROOT, next);
if (bumpOnly) process.exit(0);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['run', 'compile']);
run('npx', ['--no-install', 'vsce', 'publish', '--no-dependencies']);
console.log(`[publish] v${next} 已交给 vsce`);
