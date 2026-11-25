/**
 * Git 自定义合并驱动入口，由 git 以 `node merge-driver.js <memory|agents> %O %A %B` 调用。
 * 结果写回 %A；退出码 0 = 已合并，非 0 = 留给人工处理（git 按冲突对待）。
 * 只依赖 Node 内置模块，插件激活时会复制到 .git/youmengyu/ 下，卸载插件后仍能用。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeEntryText, restoreBlocks, stripBlocks } from './memory-merge';

const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

function mergeMemory(base: string, ours: string, theirs: string): string | undefined {
  return mergeEntryText(base, ours, theirs);
}

/** 生成块换成占位后交给 git merge-file 合人写的部分，再把本地块放回 */
function mergeAgents(base: string, ours: string, theirs: string): { text: string; clean: boolean } {
  const b = stripBlocks(base);
  const o = stripBlocks(ours);
  const t = stripBlocks(theirs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymy-merge-'));
  const fo = path.join(dir, 'ours');
  const fb = path.join(dir, 'base');
  const ft = path.join(dir, 'theirs');
  fs.writeFileSync(fo, o.text, 'utf8');
  fs.writeFileSync(fb, b.text, 'utf8');
  fs.writeFileSync(ft, t.text, 'utf8');
  let merged = '';
  let clean = true;
  try {
    merged = execFileSync('git', ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', fo, fb, ft], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err: any) {
    merged = String(err?.stdout ?? '');
    clean = typeof err?.status === 'number' && err.status === 0;
    if (!merged) merged = o.text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { text: restoreBlocks(merged, o.blocks, t.blocks), clean };
}

export function runDriver(argv: string[]): number {
  const [mode, baseFile, oursFile, theirsFile] = argv;
  if (!mode || !oursFile || !theirsFile) return 2;
  const base = read(baseFile);
  const ours = read(oursFile);
  const theirs = read(theirsFile);
  if (mode === 'memory') {
    const out = mergeMemory(base, ours, theirs);
    if (out === undefined) return 1;
    fs.writeFileSync(oursFile, out, 'utf8');
    return 0;
  }
  if (mode === 'agents') {
    const { text, clean } = mergeAgents(base, ours, theirs);
    fs.writeFileSync(oursFile, text, 'utf8');
    return clean ? 0 : 1;
  }
  return 2;
}

if (require.main === module) {
  try {
    process.exitCode = runDriver(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[youmengyu merge] ${String(err)}\n`);
    process.exitCode = 1;
  }
}
