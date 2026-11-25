/**
 * 打包前：按 git 用户把近期 AI 工作和个人更新写入更新日志，并在当前小时标上 package.json 的版本号。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || process.cwd());
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`[changelog] package.json 版本号不是 x.y.z：${version}`);
  process.exit(1);
}

const modUrl = pathToFileURL(resolve(root, 'dist', 'changelog-sync.js')).href;
const { syncChangelogs } = await import(modUrl);
const result = syncChangelogs(root, { stampVersion: version });
const where = result.personalFile ? `CHANGELOG.md、${result.personalFile}` : 'CHANGELOG.md';
console.log(`[changelog] ${where} 当前小时已标 v${version}${result.stamped ? `（${result.stamped}）` : ''}`);
