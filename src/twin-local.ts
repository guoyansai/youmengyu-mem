/**
 * 本机数字人日常能力（纯函数，不依赖 vscode）。
 *
 * 安装插件后由 twin-loop 在当前仓库内执行：播种身份与目标、对照源码写风格、
 * 写开工简报与叙事、把守则/焦点/风格放进长记忆、归档正文完全相同的重复条目、
 * 起草提交说明。不启动外部数字人进程。
 */

export const TWIN_SPACE = '本机';

/** 注入进仓库画像的守则。渲染时换行会被折成一行，所以保持单段。 */
export const CHARTER_TEXT =
  '你是本仓库的游梦鱼数字开发工程师。本插件已在仓库内接管数字人的日常能力：记住对话、强化长记忆、注入规则、对照代码风格、写开工简报和叙事、起草提交说明，不必另开数字人进程。开工先遵守本注入块和仓库既有规则，能确定的约定直接执行。最小改动，不破坏已有功能，密钥不入库。测试写在 .youmengyu/test/，改完跑项目测试。禁止自动 git add、commit、push；收尾用命令「游梦鱼·长记忆: 起草提交说明」写入 Changes 框，由主人决定是否提交。';

export const IDENTITY_TEMPLATE = `# 身份

你是游梦鱼数字开发工程师，服务于当前仓库的主人。日常能力由「游梦鱼·长记忆」插件在本仓库内提供。
`;

export const GOALS_TEMPLATE = `# 目标（意图层）

## 长期志向

- （待填写）

## 当前焦点

- （待填写）

## 本周待办

- [ ] （待填写）
`;

export interface StyleProfile {
  indent: 'tab' | '2' | '4' | 'unknown';
  quotes: 'single' | 'double' | 'unknown';
  semicolons: 'always' | 'never' | 'unknown';
  sampleFiles: number;
}

export interface TwinMemory {
  kind: 'charter' | 'style' | 'focus';
  title: string;
  content: string;
  tags: string[];
  importance: number;
  pinned?: boolean;
  space: string;
  metadata: Record<string, string>;
}

export interface TwinFile {
  rel: string;
  content: string;
  /** 已有文件不覆盖（身份、目标由主人维护） */
  ifMissing?: boolean;
}

export interface TwinEntryRef {
  id: string;
  content: string;
  pinned?: boolean;
  archived?: boolean;
  importance: number;
  uses: number;
  updatedAt: string;
  versionCount: number;
}

export interface TwinPlanInput {
  day: string;
  hasIdentity: boolean;
  hasGoals: boolean;
  goalsText: string;
  samples: { name: string; text: string }[];
  branch: string;
  sessionTitles: string[];
  ruleTitles: string[];
  entries: TwinEntryRef[];
}

export interface TwinPlan {
  files: TwinFile[];
  memories: TwinMemory[];
  archiveIds: string[];
}

export interface GitPath {
  status: string;
  path: string;
}

/** 读 goals.md 里「当前焦点」的第一条有效待办，跳过占位 */
export function parseFocus(goalsMd: string): string {
  const text = String(goalsMd ?? '').replace(/\r\n/g, '\n');
  const start = text.indexOf('## 当前焦点');
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.indexOf('\n## ', 1);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  for (const raw of section.split('\n').slice(1)) {
    const line = raw.replace(/^[-*]\s*/, '').replace(/\[[ xX]\]\s*/, '').trim();
    if (!line || line.includes('待填写')) continue;
    return line.slice(0, 200);
  }
  return '';
}

/** 从若干源文件统计缩进、引号和分号。4 空格文件不会出现非 4 倍数的缩进。 */
export function detectStyle(files: { name: string; text: string }[]): StyleProfile {
  let tab = 0;
  let two = 0;
  let four = 0;
  let single = 0;
  let double = 0;
  let semi = 0;
  let nosemi = 0;
  for (const file of files) {
    const text = String(file.text ?? '').slice(0, 6000);
    for (const line of text.split(/\n/).slice(0, 400)) {
      if (!line.trim() || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (line.startsWith('\t')) tab += 1;
      else {
        const m = /^ +/.exec(line);
        if (m) {
          const w = m[0].length;
          if (w % 4 === 0) four += 1;
          else if (w % 2 === 0) two += 1;
        }
      }
      if (/;\s*$/.test(line)) semi += 1;
      else if (
        !/^\s*[{}[\]]+\s*$/.test(line) &&
        /[^\s{]\s*$/.test(line) &&
        !/^\s*(import|export|if|for|while|else|try|catch|switch)\b/.test(line)
      ) {
        nosemi += 1;
      }
    }
    single += (text.match(/'/g) || []).length;
    double += (text.match(/"/g) || []).length;
  }
  const indent: StyleProfile['indent'] =
    tab > two && tab > four ? 'tab' : two > 0 ? '2' : four > 0 ? '4' : 'unknown';
  const quotes: StyleProfile['quotes'] =
    single > double * 1.2 ? 'single' : double > single * 1.2 ? 'double' : 'unknown';
  const semicolons: StyleProfile['semicolons'] =
    semi + nosemi < 2 ? 'unknown' : semi > nosemi * 1.5 ? 'always' : nosemi > semi * 1.5 ? 'never' : 'unknown';
  return { indent, quotes, semicolons, sampleFiles: files.length };
}

export function renderStyle(profile: StyleProfile): string {
  if (!profile.sampleFiles) return '';
  const indent =
    profile.indent === 'tab' ? 'Tab' : profile.indent === 'unknown' ? '随周围代码' : `${profile.indent} 空格`;
  const quotes = profile.quotes === 'single' ? '单引号' : profile.quotes === 'double' ? '双引号' : '随周围代码';
  const semi =
    profile.semicolons === 'always' ? '语句保留分号' : profile.semicolons === 'never' ? '语句不写分号' : '分号随周围代码';
  return `本仓代码风格（抽样 ${profile.sampleFiles} 个源文件）：缩进用${indent}；字符串用${quotes}；${semi}。新代码按这个风格写。`;
}

export function awarenessText(branch: string, focus: string, rules: string[]): string {
  const lines = [
    '# 开工简报',
    '',
    `- 分支: ${branch || '（不是 git 仓库或尚无提交）'}`,
    `- 当前焦点: ${focus || '（未写，见 .youmengyu/memory/core/goals.md）'}`,
  ];
  const picked = rules.map((r) => r.trim()).filter(Boolean).slice(0, 5);
  if (picked.length) {
    lines.push('- 优先约定:');
    for (const rule of picked) lines.push(`  - ${rule}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function narrativeText(day: string, sessions: string[]): string {
  const titles = sessions.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8);
  const lines = [`# ${day} · 本机叙事`, ''];
  if (!titles.length) lines.push('这段时间还没有新的 Agent 对话留档。');
  else {
    lines.push(`这段时间记住了 ${titles.length} 段 Agent 对话。`);
    lines.push('');
    for (const title of titles) lines.push(`- ${title.slice(0, 80)}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function parseGitStatus(porcelain: string): GitPath[] {
  const out: GitPath[] = [];
  for (const line of String(porcelain ?? '').split(/\n/)) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    let filePath = line.slice(3).trim();
    const arrow = filePath.lastIndexOf(' -> ');
    if (arrow >= 0) filePath = filePath.slice(arrow + 4).trim();
    if (!filePath) continue;
    out.push({ status, path: filePath.replace(/\\/g, '/') });
  }
  return out;
}

/** 按路径大致归类，生成可放进提交框的草稿。标题是范围，原因留给主人改一句。 */
export function draftCommitMessage(files: GitPath[]): string {
  if (!files.length) return 'chore: 记录本次工作\n\n本次工作区没有未提交的路径变化。\n';
  const paths = files.map((f) => f.path);
  const onlyTest = paths.every((p) => p.includes('.youmengyu/test/') || /\.test\./.test(p));
  const onlyDocs = paths.every((p) => /\.(md|txt)$/i.test(p));
  const hasNew = files.some((f) => f.status.includes('A') || f.status.includes('?'));
  const type = onlyTest ? 'test' : onlyDocs ? 'docs' : hasNew ? 'feat' : 'fix';
  const areas = [...new Set(paths.map((p) => p.split('/')[0] || p))].slice(0, 3);
  const title = `${type}: 更新${areas.join('、')}`;
  const body = ['请把标题改成这次改动的原因后再提交。', ''];
  for (const file of files.slice(0, 12)) body.push(`- ${file.status.trim() || file.status} ${file.path}`);
  if (files.length > 12) body.push(`- …另有 ${files.length - 12} 个路径`);
  return `${title}\n\n${body.join('\n')}\n`;
}

/** 已有草稿保留，新说明追加；完全包含则不再重复。 */
export function mergeCommitDraft(existing: string, draft: string): string {
  const cur = String(existing ?? '').trim();
  const next = String(draft ?? '').trim();
  if (!next) return cur ? `${cur}\n` : '';
  if (!cur) return `${next}\n`;
  if (cur.includes(next)) return cur.endsWith('\n') ? cur : `${cur}\n`;
  return `${cur}\n\n${next}\n`;
}

/** 正文归一化后完全相同的条目只留最优一份。每拍最多归档 2 条，避免一次改太多文件 */
export function exactArchiveIds(entries: TwinEntryRef[], cap = 2): string[] {
  const map = new Map<string, TwinEntryRef[]>();
  for (const entry of entries) {
    if (entry.archived) continue;
    const key = entry.content.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  }
  const ids: string[] = [];
  for (const group of map.values()) {
    if (group.length < 2) continue;
    const best = [...group].sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        b.importance - a.importance ||
        b.uses - a.uses ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.versionCount - a.versionCount ||
        (a.id < b.id ? -1 : 1)
    )[0];
    for (const entry of group) if (entry.id !== best.id) ids.push(entry.id);
  }
  ids.sort();
  return ids.slice(0, cap);
}

function memory(
  kind: TwinMemory['kind'],
  title: string,
  content: string,
  tags: string[],
  importance: number,
  pinned?: boolean
): TwinMemory {
  return {
    kind,
    title,
    content,
    tags,
    importance,
    pinned,
    space: TWIN_SPACE,
    metadata: { twin: 'local', kind },
  };
}

/** 一拍要写的文件、要 upsert 的记忆、要归档的重复 id */
export function planTwin(input: TwinPlanInput): TwinPlan {
  const files: TwinFile[] = [];
  if (!input.hasIdentity) {
    files.push({ rel: '.youmengyu/memory/core/identity.md', content: IDENTITY_TEMPLATE, ifMissing: true });
  }
  if (!input.hasGoals) {
    files.push({ rel: '.youmengyu/memory/core/goals.md', content: GOALS_TEMPLATE, ifMissing: true });
  }
  const focus = parseFocus(input.goalsText);
  const styleSentence = renderStyle(detectStyle(input.samples));
  if (styleSentence) {
    files.push({
      rel: '.youmengyu/memory/semantic/pref-style.md',
      content: `# 本仓代码风格\n\n${styleSentence}\n`,
    });
  }
  files.push({
    rel: '.youmengyu/memory/evolution/awareness.md',
    content: awarenessText(input.branch, focus, input.ruleTitles),
  });
  files.push({
    rel: '.youmengyu/memory/evolution/local-narrative.md',
    content: narrativeText(input.day, input.sessionTitles),
  });

  const memories: TwinMemory[] = [
    memory('charter', '游梦鱼本机守则', CHARTER_TEXT, ['workflow'], 5, true),
  ];
  if (focus) memories.push(memory('focus', '当前焦点', focus, ['decision'], 5, true));
  if (styleSentence) memories.push(memory('style', '本仓代码风格', styleSentence, ['preference'], 4));

  return { files, memories, archiveIds: exactArchiveIds(input.entries) };
}
