/**
 * 按小时把 AI 工作和个人更新写进更新日志。
 * CHANGELOG.md 是完整日志；CHANGELOG+git用户.md 只留这个人的个人更新和 AI 工作。
 */

import { parseTranscript } from './agent-learn';

export interface LogPoint {
  hour: string;
  kind: 'ai' | 'personal';
  who: string;
  text: string;
}

export interface GitChange {
  author: string;
  date: string;
  subject: string;
  body: string;
}

const HOUR = /^### (\d{4}-\d{2}-\d{2} \d{2}:00)(?: · v(\d+\.\d+\.\d+))?[ \t]*$/;

export function hourBucket(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:00`;
}

/** git 用户名 → CHANGELOG+用户名.md。名字里不能当文件名的字符去掉。 */
export function personalChangelogName(user: string): string {
  const safe = String(user || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .slice(0, 40);
  if (!safe) return '';
  return `CHANGELOG+${safe}.md`;
}

export function isAiChange(subject: string, body: string): boolean {
  const blob = `${subject}\n${body}`;
  return /co-authored-by:\s*.*(cursor|copilot|claude|chatgpt|youmengyu|gpt-)/i.test(blob) || /\[ai\]/i.test(subject);
}

export function parseGitLog(raw: string): GitChange[] {
  const out: GitChange[] = [];
  for (const rec of String(raw || '').split('\x1e')) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\x1f');
    if (parts.length < 3) continue;
    const subject = (parts[2] || '').trim();
    if (!subject) continue;
    out.push({
      author: (parts[0] || '').trim(),
      date: (parts[1] || '').trim(),
      subject,
      body: (parts[3] || '').trim(),
    });
  }
  return out;
}

function oneLine(text: string): string {
  const line = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (line.length < 4) return '';
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

function isNoise(text: string): boolean {
  return /briefly inform the user/i.test(text) || /perform any follow-up actions/i.test(text);
}

function latestUserLine(raw: string): string {
  const turns = parseTranscript(raw);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role !== 'user') continue;
    const line = oneLine(turns[i].text);
    if (!line || isNoise(line)) continue;
    return line;
  }
  return '';
}

export function planPoints(input: {
  user: string;
  commits: GitChange[];
  transcripts: { mtimeMs: number; text: string }[];
}): LogPoint[] {
  const points: LogPoint[] = [];
  const seen = new Set<string>();
  const push = (point: LogPoint) => {
    const text = oneLine(point.text);
    if (!text || !point.hour) return;
    const key = `${point.hour}\n${point.kind}\n${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push({ ...point, text });
  };
  for (const commit of input.commits) {
    if (/^merge\b/i.test(commit.subject)) continue;
    const when = new Date(commit.date);
    if (Number.isNaN(when.getTime())) continue;
    const ai = isAiChange(commit.subject, commit.body);
    push({
      hour: hourBucket(when),
      kind: ai ? 'ai' : 'personal',
      who: ai ? 'AI' : commit.author || input.user || '更新',
      text: commit.subject,
    });
  }
  for (const file of input.transcripts) {
    const when = new Date(file.mtimeMs);
    if (Number.isNaN(when.getTime())) continue;
    push({
      hour: hourBucket(when),
      kind: 'ai',
      who: 'AI',
      text: latestUserLine(file.text),
    });
  }
  return points;
}

export function pointsForPersonal(points: LogPoint[], user: string): LogPoint[] {
  const who = user.trim().toLowerCase();
  if (!who) return points.filter((point) => point.kind === 'ai');
  return points.filter((point) => point.kind === 'ai' || point.who.trim().toLowerCase() === who);
}

export function bulletLine(point: LogPoint): string {
  const who = point.kind === 'ai' ? 'AI' : point.who.trim() || '更新';
  return `- ${who}：${point.text.trim()}`;
}

interface HourSection {
  hour: string;
  version: string;
  lines: string[];
  rawHeading: string;
}

function ensureSkeleton(markdown: string, title: string): string {
  let text = String(markdown || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return `${title}\n\n## Unreleased\n`;
  if (!/^#\s/m.test(text)) text = `${title}\n\n${text}`;
  if (text.indexOf('## Unreleased') < 0) {
    const nl = text.indexOf('\n');
    const head = nl < 0 ? text : text.slice(0, nl);
    const rest = nl < 0 ? '' : text.slice(nl + 1).replace(/^\n/, '');
    text = `${head}\n\n## Unreleased\n${rest}`;
  }
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

function splitUnreleased(markdown: string, title: string): { head: string; body: string; tail: string } {
  const text = ensureSkeleton(markdown, title);
  const mark = '## Unreleased';
  const at = text.indexOf(mark);
  const after = at + mark.length;
  const lineEnd = text.indexOf('\n', after);
  const bodyStart = lineEnd < 0 ? text.length : lineEnd + 1;
  const rest = text.slice(bodyStart);
  const next = rest.indexOf('\n## ');
  if (next < 0) return { head: text.slice(0, bodyStart), body: rest, tail: '' };
  return { head: text.slice(0, bodyStart), body: rest.slice(0, next + 1), tail: rest.slice(next + 1) };
}

function parseSection(chunk: string): HourSection {
  const text = chunk.replace(/^\n/, '').replace(/\s+$/, '');
  const nl = text.indexOf('\n');
  const heading = (nl < 0 ? text : text.slice(0, nl)).trim();
  const matched = HOUR.exec(heading);
  const body = nl < 0 ? '' : text.slice(nl + 1);
  const lines = body.split('\n').filter((line) => line.trim());
  return {
    hour: matched ? matched[1] : '',
    version: matched && matched[2] ? matched[2] : '',
    lines,
    rawHeading: heading.startsWith('### ') ? heading : `### ${heading}`,
  };
}

function parseHours(body: string): { loose: string; sections: HourSection[] } {
  const text = body.replace(/\s+$/, '');
  let cut = -1;
  if (text.startsWith('### ')) cut = 0;
  else {
    const at = text.indexOf('\n### ');
    if (at >= 0) cut = at + 1;
  }
  if (cut < 0) {
    if (!body) return { loose: '', sections: [] };
    return { loose: body.endsWith('\n') ? body : `${body}\n`, sections: [] };
  }
  const looseRaw = text.slice(0, cut);
  const rest = text.slice(cut);
  const chunks = rest.split('\n### ').map((part, index) => (index === 0 ? part : `### ${part}`));
  return {
    loose: looseRaw && !looseRaw.endsWith('\n') ? `${looseRaw}\n` : looseRaw,
    sections: chunks.filter((chunk) => chunk.trim()).map(parseSection),
  };
}

function headingOf(section: HourSection): string {
  if (!section.hour) return section.rawHeading;
  return section.version ? `### ${section.hour} · v${section.version}` : `### ${section.hour}`;
}

function renderUnreleased(loose: string, sections: HourSection[]): string {
  const ordered = sections.slice().sort((a, b) => {
    if (a.hour && b.hour) return a.hour < b.hour ? 1 : a.hour > b.hour ? -1 : 0;
    if (a.hour) return -1;
    if (b.hour) return 1;
    return 0;
  });
  const blocks = ordered.map((section) => {
    const lines = section.lines.filter((line) => line.trim());
    return [headingOf(section), '', ...lines, ''].join('\n');
  });
  const looseText = loose && !loose.endsWith('\n') ? `${loose}\n` : loose;
  let text = `${looseText}${looseText && blocks.length ? '\n' : ''}${blocks.join('\n')}`;
  text = text.replace(/\n{3,}/g, '\n\n');
  if (text && !text.endsWith('\n\n')) text = `${text.replace(/\n*$/, '')}\n\n`;
  return text;
}

function mergeInto(markdown: string, title: string, points: LogPoint[], versionForHour?: { hour: string; version: string }): string {
  const { head, body, tail } = splitUnreleased(markdown, title);
  const parsed = parseHours(body);
  for (const point of points) {
    if (!point.hour || !point.text.trim()) continue;
    let section = parsed.sections.find((item) => item.hour === point.hour);
    if (!section) {
      section = { hour: point.hour, version: '', lines: [], rawHeading: `### ${point.hour}` };
      parsed.sections.push(section);
    }
    const line = bulletLine(point);
    if (!section.lines.includes(line)) section.lines.push(line);
  }
  if (versionForHour) {
    let section = parsed.sections.find((item) => item.hour === versionForHour.hour);
    if (!section) {
      section = {
        hour: versionForHour.hour,
        version: versionForHour.version,
        lines: [],
        rawHeading: `### ${versionForHour.hour}`,
      };
      parsed.sections.push(section);
    }
    section.version = versionForHour.version;
  }
  const nextBody = renderUnreleased(parsed.loose, parsed.sections);
  const headOut = nextBody.startsWith('###') && !head.endsWith('\n\n') ? `${head}\n` : head;
  const joined = `${headOut}${nextBody}${tail}`.replace(/## Unreleased\n{3,}/g, '## Unreleased\n\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

/** 把内容点合并进已有日志。没有新点时原文不动。手写的 Unreleased 条目留在小时标题上面。 */
export function applyPoints(markdown: string, points: LogPoint[], title = '# 更新日志'): string {
  const useful = points.filter((point) => point.hour && point.text.trim());
  if (!useful.length) return markdown;
  return mergeInto(markdown, title, useful);
}

/** 打包时给指定小时标上版本号。该小时还没有标题就补一节。 */
export function stampHourVersion(markdown: string, version: string, hour: string, title = '# 更新日志'): string {
  const ver = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(ver) || !hour) return markdown;
  return mergeInto(markdown, title, [], { hour, version: ver });
}
