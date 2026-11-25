import { execFileSync } from 'child_process';

export interface GitCommit {
  hash: string;
  date: string;
  subject: string;
}

/** 读取最近提交。不是 Git 仓库时抛错，由面板提示，不弹系统窗口。 */
export function listRecentCommits(root: string, limit = 30): GitCommit[] {
  const log = execFileSync(
    'git',
    ['log', '--pretty=format:%h|%ad|%s', '--date=short', '-n', String(limit)],
    { cwd: root, encoding: 'utf-8' }
  );
  return String(log)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, date, subject] = line.split('|');
      return { hash: hash || '', date: date || '', subject: subject || '' };
    })
    .filter((c) => c.hash && c.subject);
}
