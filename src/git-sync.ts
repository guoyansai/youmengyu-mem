/**
 * 多用户、多终端 Git 同步防冲突（参考 git-lfs 的驱动注册、.idea/.gitignore 的目录内忽略）：
 * 1. .youmengyu/.gitignore：运行态（runs/cache/tmp/test/reports/任意 .local/）只留本机，不入库。
 * 2. 记忆目录 .gitattributes：条目 JSON 走 youmengyu-memory 合并驱动（字段级三方合并）。
 * 3. 根 .gitattributes：注入目标走 youmengyu-agents（生成块不参与文本合并），更新日志走内置 union。
 * 4. 驱动脚本复制进 .git/youmengyu/，并写入本仓 .git/config（每个克隆各自注册，不入库）。
 * 只补缺失行、内容不变不写盘；不执行 git add / commit / push。不依赖 vscode，可单测。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const MEMORY_DRIVER = 'youmengyu-memory';
export const AGENTS_DRIVER = 'youmengyu-agents';
export const DRIVER_FILES = ['merge-driver.js', 'memory-merge.js'];

export const YOUMENGYU_IGNORE_HEAD = '# 游梦鱼·长记忆：本机运行态不入库，避免多用户多终端 Git 同步冲突';
export const YOUMENGYU_IGNORE = ['runs/', 'cache/', 'tmp/', 'test/reports/', '.local/'];
export const ATTR_HEAD = '# 游梦鱼·长记忆：记忆与注入文件的合并规则（多用户多终端同步不冲突）';

export interface GitSyncOptions {
  root: string;
  /** 记忆目录（相对 root） */
  storageRel: string;
  /** 注入目标（相对 root），如 AGENTS.md */
  injectTargets: string[];
  /** 驱动脚本所在目录（插件 dist） */
  driverSrcDir?: string;
  /** 是否写 .git/config 注册驱动 */
  registerDriver?: boolean;
}

export interface GitSyncResult {
  changed: string[];
  driver: 'registered' | 'unchanged' | 'skipped';
}

const readText = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

/** 往规则文件里补缺失行（按行去空白比较），已有内容一字不动。返回是否写盘 */
export function ensureLines(file: string, head: string, lines: string[]): boolean {
  const before = readText(file);
  const have = new Set(before.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l.trim()));
  if (!missing.length) return false;
  const sep = !before || before.endsWith('\n') ? '' : '\n';
  const lead = before.trim() ? '\n' : '';
  const headLine = have.has(head) ? '' : `${head}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${before}${sep}${lead}${headLine}${missing.join('\n')}\n`, 'utf8');
  return true;
}

const posix = (p: string) => p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');

/** gitattributes 路径里的空格要转义 */
const attrPath = (p: string) => posix(p).replace(/ /g, '[[:space:]]');

export function rootAttributeLines(injectTargets: string[]): string[] {
  const lines = injectTargets
    .map(posix)
    .filter((t) => t && !t.includes('..'))
    .map((t) => `${attrPath(t)} merge=${AGENTS_DRIVER}`);
  lines.push('CHANGELOG*.md merge=union');
  return lines;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitTry(root: string, args: string[]): string {
  try {
    return git(root, args);
  } catch {
    return '';
  }
}

/** 驱动命令：node "<.git/youmengyu>/merge-driver.js" <mode> %O %A %B */
export function driverCommand(dir: string, mode: 'memory' | 'agents'): string {
  return `node "${posix(path.join(dir, 'merge-driver.js'))}" ${mode} %O %A %B`;
}

/** 复制驱动脚本到 .git/youmengyu/ 并写入本仓 git config。内容与配置都不变时不动 */
export function registerDrivers(root: string, driverSrcDir: string): 'registered' | 'unchanged' | 'skipped' {
  const common = gitTry(root, ['rev-parse', '--git-common-dir']);
  if (!common) return 'skipped';
  const gitDir = path.resolve(root, common);
  const dest = path.join(gitDir, 'youmengyu');
  let touched = false;
  for (const name of DRIVER_FILES) {
    const src = path.join(driverSrcDir, name);
    if (!fs.existsSync(src)) return 'skipped';
    const text = fs.readFileSync(src, 'utf8');
    const target = path.join(dest, name);
    if (readText(target) === text) continue;
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    touched = true;
  }
  const want: [string, string][] = [
    [`merge.${MEMORY_DRIVER}.name`, '游梦鱼·长记忆 记忆条目字段级合并'],
    [`merge.${MEMORY_DRIVER}.driver`, driverCommand(dest, 'memory')],
    [`merge.${AGENTS_DRIVER}.name`, '游梦鱼·长记忆 注入文件合并（生成块取本地）'],
    [`merge.${AGENTS_DRIVER}.driver`, driverCommand(dest, 'agents')],
  ];
  for (const [key, value] of want) {
    if (gitTry(root, ['config', '--local', '--get', key]) === value) continue;
    try {
      git(root, ['config', '--local', key, value]);
      touched = true;
    } catch {
      return 'skipped';
    }
  }
  return touched ? 'registered' : 'unchanged';
}

export function ensureGitSync(opts: GitSyncOptions): GitSyncResult {
  const { root, storageRel, injectTargets } = opts;
  const changed: string[] = [];
  const yIgnore = path.join(root, '.youmengyu', '.gitignore');
  if (ensureLines(yIgnore, YOUMENGYU_IGNORE_HEAD, YOUMENGYU_IGNORE)) changed.push('.youmengyu/.gitignore');
  const storageAttr = path.join(root, storageRel, '.gitattributes');
  if (ensureLines(storageAttr, ATTR_HEAD, [`*.json merge=${MEMORY_DRIVER}`])) {
    changed.push(`${posix(storageRel)}/.gitattributes`);
  }
  if (ensureLines(path.join(root, '.gitattributes'), ATTR_HEAD, rootAttributeLines(injectTargets))) {
    changed.push('.gitattributes');
  }
  let driver: GitSyncResult['driver'] = 'skipped';
  if (opts.registerDriver !== false && opts.driverSrcDir) driver = registerDrivers(root, opts.driverSrcDir);
  return { changed, driver };
}
