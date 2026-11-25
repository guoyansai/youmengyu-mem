/**
 * 发布前的版本进位。
 *
 * x.y.z 从左到右是主 / 次 / 末。
 * - 界面改动，或非界面增删不超过 SMALL_LINE_BUDGET 行：末位 +1（0.5.0 → 0.5.1）
 * - 非界面改动更大：次位 +1，末位归零（0.5.0 → 0.6.0）
 * - 主位不在这里自动改
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 非界面改动不超过这么多行，仍算小更新。 */
export const SMALL_LINE_BUDGET = 80;

const UI_RULES = [
  /(^|\/)media\//,
  /\.(css|scss|less|html|svg|png|gif|webp|ico)$/i,
  /(^|\/)src\/panel\.ts$/,
  /(^|\/)src\/ai\/settings-panel\.ts$/,
];

const IGNORE_RULES = [
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)CHANGELOG\.md$/i,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.youmengyu\//,
  /\.vsix$/i,
  /\.md$/i,
];

export function nextVersion(current, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current).trim());
  if (!m) throw new Error(`版本号须为 x.y.z，当前是 ${current}`);
  const ma = Number(m[1]);
  const mi = Number(m[2]);
  const pa = Number(m[3]);
  if (level === 'patch') return `${ma}.${mi}.${pa + 1}`;
  if (level === 'minor') return `${ma}.${mi + 1}.0`;
  if (level === 'major') return `${ma + 1}.0.0`;
  throw new Error(`未知版本级别: ${level}（patch / minor / major）`);
}

export function normalizeDiffPath(raw) {
  let p = String(raw).trim().replace(/\\/g, '/');
  const brace = p.match(/^(.*)\{.* => (.*)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[2]}${brace[3]}`;
  const arrow = p.lastIndexOf(' => ');
  if (arrow !== -1) p = p.slice(arrow + 4).trim();
  return p;
}

export function isUiPath(filePath) {
  const p = normalizeDiffPath(filePath);
  return UI_RULES.some((re) => re.test(p));
}

export function isIgnoredPath(filePath) {
  const p = normalizeDiffPath(filePath);
  return IGNORE_RULES.some((re) => re.test(p));
}

/** @param {string} text git diff --numstat 输出 */
export function parseNumstat(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tab = line.split('\t');
    if (tab.length < 3) continue;
    const added = tab[0] === '-' ? -1 : Number(tab[0]);
    const deleted = tab[1] === '-' ? -1 : Number(tab[1]);
    out.push({ path: normalizeDiffPath(tab.slice(2).join('\t')), added, deleted });
  }
  return out;
}

/**
 * @param {{ path: string, added: number, deleted: number }[]} entries
 * @returns {{ level: 'patch' | 'minor', reason: string, lines: number }}
 */
export function classifyBump(entries) {
  let lines = 0;
  let uiFiles = 0;
  let counted = 0;
  for (const entry of entries ?? []) {
    const p = normalizeDiffPath(entry.path);
    if (!p || isIgnoredPath(p)) continue;
    counted += 1;
    if (isUiPath(p)) {
      uiFiles += 1;
      continue;
    }
    const binary = entry.added < 0 || entry.deleted < 0 || Number.isNaN(entry.added) || Number.isNaN(entry.deleted);
    lines += binary ? SMALL_LINE_BUDGET + 1 : Number(entry.added) + Number(entry.deleted);
  }
  if (counted === 0) {
    return { level: 'patch', reason: '没有可计的代码改动，按小更新进末位', lines: 0 };
  }
  if (lines === 0 && uiFiles > 0) {
    return { level: 'patch', reason: '只动了界面，进末位', lines: 0 };
  }
  if (lines <= SMALL_LINE_BUDGET) {
    return { level: 'patch', reason: `非界面改动 ${lines} 行，未超过 ${SMALL_LINE_BUDGET}，进末位`, lines };
  }
  return { level: 'minor', reason: `非界面改动 ${lines} 行，超过 ${SMALL_LINE_BUDGET}，进次位`, lines };
}

function gitOut(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 自「当前版本号写入」那次提交之前，到工作区（含未跟踪文件）的改动。 */
export function changesForPublish(root, version) {
  const entries = [];
  let spec = '';
  try {
    const base = gitOut(root, ['log', '-1', '--format=%H', '-S', `"version": "${version}"`, '--', 'package.json']).trim();
    if (base) {
      try {
        gitOut(root, ['rev-parse', '--verify', '--quiet', `${base}^`]);
        spec = `${base}^`;
      } catch {
        spec = base;
      }
    }
  } catch {
    spec = '';
  }
  try {
    const text = spec
      ? gitOut(root, ['diff', '--numstat', spec])
      : gitOut(root, ['diff', '--numstat', 'HEAD']);
    entries.push(...parseNumstat(text));
  } catch {
    /* 非 git 目录时当作没有差异，走末位 */
  }
  try {
    const others = gitOut(root, ['ls-files', '--others', '--exclude-standard']);
    for (const rel of others.split(/\r?\n/)) {
      if (!rel.trim()) continue;
      const filePath = rel.trim().replace(/\\/g, '/');
      let added = 1;
      try {
        const buf = readFileSync(resolve(root, filePath));
        if (!buf.includes(0) && buf.length < 1_000_000) added = buf.toString('utf8').split(/\r?\n/).length;
        else added = -1;
      } catch {
        added = 1;
      }
      entries.push({ path: filePath, added, deleted: 0 });
    }
  } catch {
    /* 无 git */
  }
  return entries;
}

export function writeVersionFiles(root, version) {
  const pkgPath = resolve(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const lockPath = resolve(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.version = version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = version;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
}
