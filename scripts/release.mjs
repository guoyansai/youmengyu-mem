#!/usr/bin/env node
/**
 * 游梦鱼·长记忆 — 一键发布脚本
 *
 * 用法:
 *   node scripts/release.mjs              # 默认 patch
 *   node scripts/release.mjs patch        # 0.3.0 → 0.3.1
 *   node scripts/release.mjs minor        # 0.3.0 → 0.4.0
 *   node scripts/release.mjs major        # 0.3.0 → 1.0.0（主版本只走这里或手改）
 *   node scripts/release.mjs 0.5.0        # 直接指定版本号
 *   node scripts/release.mjs patch --dry-run   # 只改版本+编译+打包，不发布
 *
 * 日常 `npm run publish` 不走本脚本：它按改动自动选末位或次位，不改最左一位。
 *
 * 步骤: bump → sync lockfile → compile → package → publish
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { nextVersion } from './version-bump.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------- 解析参数 ----------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bumpArg = args.find((a) => !a.startsWith('--')) || 'patch';

// ---------- 工具函数 ----------
function log(step, msg) {
  console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);
}
function ok(msg) {
  console.log(`\x1b[32m  ✓\x1b[0m ${msg}`);
}
function fail(msg) {
  console.error(`\x1b[31m  ✗\x1b[0m ${msg}`);
  process.exit(1);
}
function run(cmd, opts = {}) {
  try {
    const out = execSync(cmd, {
      cwd: ROOT,
      stdio: opts.silent ? 'pipe' : 'inherit',
      encoding: 'utf-8',
      ...opts,
    });
    return out?.trim();
  } catch (e) {
    fail(`命令失败: ${cmd}\n${e.stderr || e.message}`);
  }
}

// ---------- 1. 读 package.json ----------
log('1/6', '读取当前版本');
const pkgPath = resolve(ROOT, 'package.json');
const lockPath = resolve(ROOT, 'package-lock.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
const currentVersion = pkg.version;
ok(`当前版本 ${currentVersion}`);

// ---------- 2. 计算新版本 ----------
log('2/6', `计算新版本 (${bumpArg})`);
let newVersion;
if (/^\d+\.\d+\.\d+$/.test(bumpArg)) {
  newVersion = bumpArg;
} else {
  try {
    newVersion = nextVersion(currentVersion, bumpArg);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
if (newVersion === currentVersion) {
  fail(`新版本 ${newVersion} 与当前版本相同，无需发布`);
}
ok(`${currentVersion} → ${newVersion}`);

// ---------- 3. 同步更新版本 ----------
log('3/6', '更新 package.json + package-lock.json');
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
lock.version = newVersion;
lock.packages[''].version = newVersion;
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
ok(`两个文件均已更新为 ${newVersion}`);

// ---------- 4. 编译 ----------
log('4/6', 'TypeScript 编译');
run('npm.cmd run compile', { silent: true });
ok('编译成功');

// ---------- 5. 打包 ----------
log('5/6', '打包 .vsix');
const pkgName = pkg.name;
const vsixFile = run(`npx.cmd vsce package --no-dependencies`, { silent: true })
  .split('\n')
  .map((l) => l.trim())
  .find((l) => l.endsWith('.vsix'));
if (!vsixFile) fail('未能从 vsce 输出中解析出 .vsix 文件名');
ok(`已生成 ${vsixFile}`);

if (dryRun) {
  console.log('\n\x1b[33m[DRY-RUN]\x1b[0m 跳过发布步骤。');
  console.log(`  版本: ${newVersion}`);
  console.log(`  产物: ${vsixFile}`);
  console.log('\n执行以下命令可正式发布:\n  npm run publish\n');
  process.exit(0);
}

// ---------- 6. 发布 ----------
log('6/6', `发布到 VS Code Marketplace (publisher: ${pkg.publisher})`);
if (!process.env.VSCE_PAT) {
  fail('未检测到 VSCE_PAT 环境变量。请先在 PowerShell 中设置：[Environment]::SetEnvironmentVariable("VSCE_PAT", "<your-pat>", "User")\n或临时设置：$env:VSCE_PAT = "<your-pat>"');
}
try {
  run('npx.cmd vsce publish --no-dependencies');
  ok(`v${newVersion} 已发布`);
} catch (e) {
  fail(`发布失败。可能原因: PAT 无效/过期、publisher 不匹配、版本已存在，或 displayName 被占用`);
}

// ---------- 收尾 ----------
console.log(`\n\x1b[32m🎉 游梦鱼·长记忆 v${newVersion} 发布完成\x1b[0m`);
console.log(`  package : ${pkgName}`);
console.log(`  vsix    : ${vsixFile}`);
console.log(`  版本    : ${currentVersion} → ${newVersion}`);
console.log(`  marketplace: https://marketplace.visualstudio.com/items?itemName=${pkg.publisher}.${pkgName}\n`);
