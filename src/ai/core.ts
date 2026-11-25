/**
 * AI 调用内核（移植自 asaiwriter chat-core.ts + hostai-core.ts 出网口）。
 * 纯函数可单测：协议拼装、回复解析、免费档拦截、上下文裁剪。
 */
import type { ProviderProtocol } from './presets';

export type ChatLane = 'offline' | 'online' | 'free';
export const AI_LANES: readonly ChatLane[] = ['offline', 'online', 'free'];

export type ChatTurn = { role: 'system' | 'user' | 'assistant'; content: string };

export function stripThink(text: string): string {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

const GUARD_RULES: { re: RegExp; tag: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, tag: 'privateKey' },
  { re: /```[\s\S]*?```/g, tag: 'code' },
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, tag: 'key' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, tag: 'key' },
  { re: /\b(?:gsk|ghp|gho|ghu|ghs|github_pat|xox[abpr]|hf)_[A-Za-z0-9_]{16,}\b/g, tag: 'key' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, tag: 'key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, tag: 'key' },
  { re: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, tag: 'idCard' },
  { re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, tag: 'phone' },
];

/**
 * 免费档发出前的拦截：公开接口可能留存请求，先剥掉疑似密钥、私钥、代码块、身份证与手机号。
 */
export function guardFree(text: string): { text: string; removed: number; tags: string[] } {
  let out = String(text ?? '');
  let removed = 0;
  const tags = new Set<string>();
  for (const rule of GUARD_RULES) {
    out = out.replace(rule.re, () => {
      removed += 1;
      tags.add(rule.tag);
      return `[${rule.tag}]`;
    });
  }
  return { text: out, removed, tags: [...tags] };
}

/** 粗估 token：中日韩一字约一个，其余约四个字符一个。 */
export function estimateTokens(text: string): number {
  const s = String(text ?? '');
  const cjk = (s.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) ?? []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

/** 裁到预算以内，宁短勿超。 */
export function clipTokens(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo).trimEnd();
  return cut ? `${cut}…` : '';
}

/** 离线本机小模型上下文小；在线/免费给足整理空间。 */
export const LANE_TOKEN_BUDGET: Record<ChatLane, number> = { offline: 3000, online: 16000, free: 6000 };

/** 按上下文预算裁消息：system 占 35%，其余从新往旧留。 */
export function fitContext(messages: ChatTurn[], budget: number): ChatTurn[] {
  const system = messages.filter((row) => row.role === 'system');
  const rest = messages.filter((row) => row.role !== 'system');
  const sysAllow = Math.max(32, Math.floor(budget * 0.35));
  let sysCost = 0;
  const sys = system
    .map((row) => {
      const room = Math.max(0, sysAllow - sysCost);
      const content = clipTokens(row.content, room);
      sysCost += estimateTokens(content) + 4;
      return { ...row, content };
    })
    .filter((row) => row.content);
  let left = Math.max(0, budget - sysCost);
  const kept: ChatTurn[] = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(rest[i].content) + 4;
    if (!kept.length) {
      const content = cost > left ? clipTokens(rest[i].content, Math.max(0, left - 4)) : rest[i].content;
      if (content) kept.unshift({ ...rest[i], content });
      left -= estimateTokens(content) + 4;
      continue;
    }
    if (cost > left) break;
    kept.unshift(rest[i]);
    left -= cost;
  }
  return [...sys, ...kept];
}

export type BuiltRequest = {
  method: 'POST' | 'GET';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

const AZURE_API_VERSION = '2024-10-21';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 2048;

function trimSlash(s: string): string {
  return String(s ?? '').replace(/\/+$/, '');
}

function splitSystem(messages: ChatTurn[]): { system: string; rest: ChatTurn[] } {
  const system = messages
    .filter((row) => row.role === 'system')
    .map((row) => row.content)
    .join('\n');
  return { system, rest: messages.filter((row) => row.role !== 'system') };
}

/** 相邻消息角色去重：部分协议（anthropic/gemini）不接受连续同角色。 */
function alternate(messages: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const row of messages) {
    const last = out.at(-1);
    if (last && last.role === row.role) last.content += `\n${row.content}`;
    else out.push({ ...row });
  }
  if (out.length && out[0].role === 'assistant') out.unshift({ role: 'user', content: '(继续)' });
  return out;
}

/** 按协议拼一次对话请求。 */
export function buildRequest(
  protocol: ProviderProtocol,
  input: { endpoint: string; model: string; key?: string; messages: ChatTurn[]; apiVersion?: string; maxTokens?: number }
): BuiltRequest {
  const key = String(input.key ?? '').trim();
  const maxTokens = Number.isFinite(input.maxTokens) && Number(input.maxTokens) > 0 ? Math.floor(Number(input.maxTokens)) : undefined;
  const json = { 'content-type': 'application/json' };
  if (protocol === 'text-get') {
    return {
      method: 'POST',
      url: `${trimSlash(input.endpoint)}/openai`,
      headers: json,
      body: { model: input.model, messages: input.messages, stream: false },
    };
  }
  if (protocol === 'azure') {
    const version = input.apiVersion || AZURE_API_VERSION;
    return {
      method: 'POST',
      url: `${trimSlash(input.endpoint)}/chat/completions?api-version=${encodeURIComponent(version)}`,
      headers: { ...json, 'api-key': key },
      body: { messages: input.messages, stream: false, ...(maxTokens ? { max_tokens: maxTokens } : {}) },
    };
  }
  if (protocol === 'anthropic') {
    const base = trimSlash(input.endpoint).replace(/\/v1$/i, '');
    const { system, rest } = splitSystem(input.messages);
    return {
      method: 'POST',
      url: `${base}/v1/messages`,
      headers: { ...json, 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      body: {
        model: input.model,
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages: alternate(rest),
      },
    };
  }
  if (protocol === 'gemini') {
    const { system, rest } = splitSystem(input.messages);
    const config: Record<string, number> = {};
    if (maxTokens) config.maxOutputTokens = maxTokens;
    return {
      method: 'POST',
      url: `${trimSlash(input.endpoint)}/models/${encodeURIComponent(input.model)}:generateContent`,
      headers: { ...json, 'x-goog-api-key': key },
      body: {
        contents: alternate(rest).map((row) => ({
          role: row.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: row.content }],
        })),
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        ...(Object.keys(config).length ? { generationConfig: config } : {}),
      },
    };
  }
  if (protocol === 'ollama') {
    const options: Record<string, number> = {};
    if (maxTokens) options.num_predict = maxTokens;
    return {
      method: 'POST',
      url: `${trimSlash(input.endpoint).replace(/\/api$/i, '')}/api/chat`,
      headers: json,
      body: { model: input.model, messages: input.messages, stream: false, ...(Object.keys(options).length ? { options } : {}) },
    };
  }
  return {
    method: 'POST',
    url: `${trimSlash(input.endpoint).replace(/\/chat\/completions$/i, '')}/chat/completions`,
    headers: key ? { ...json, authorization: `Bearer ${key}` } : json,
    body: { model: input.model, messages: input.messages, stream: false, ...(maxTokens ? { max_tokens: maxTokens } : {}) },
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 按协议取回复正文。取不到返回空串。 */
export function parseReply(protocol: ProviderProtocol, data: unknown): string {
  if (typeof data === 'string') return data.trim();
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (protocol === 'anthropic') {
    const parts = Array.isArray(o.content) ? o.content : [];
    return parts.map((row) => str((row as Record<string, unknown>)?.text)).join('').trim();
  }
  if (protocol === 'gemini') {
    const first = (Array.isArray(o.candidates) ? o.candidates[0] : null) as Record<string, unknown> | null;
    const content = (first?.content ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return parts.map((row) => str((row as Record<string, unknown>)?.text)).join('').trim();
  }
  if (protocol === 'ollama') {
    return str((o.message as Record<string, unknown> | undefined)?.content).trim();
  }
  const choice = (Array.isArray(o.choices) ? o.choices[0] : null) as Record<string, unknown> | null;
  const message = (choice?.message ?? {}) as Record<string, unknown>;
  return (str(message.content) || str(choice?.text) || str(o.reply) || str(o.content)).trim();
}

export type CallError = { kind: 'http' | 'network' | 'empty'; status?: number; message: string };

/** 发一次对话，返回正文；失败抛 CallError 形状的 Error。 */
export async function chatOnce(
  provider: { protocol?: ProviderProtocol; baseUrl: string; model: string; apiVersion?: string },
  key: string,
  messages: ChatTurn[],
  opts?: { signal?: AbortSignal; timeoutMs?: number; maxTokens?: number }
): Promise<string> {
  const protocol = provider.protocol ?? 'openai';
  const built = buildRequest(protocol, {
    endpoint: provider.baseUrl,
    model: provider.model,
    key,
    messages,
    apiVersion: provider.apiVersion,
    maxTokens: opts?.maxTokens,
  });
  const ac = new AbortController();
  const timer = opts?.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
  if (opts?.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  try {
    const res = await fetch(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.method === 'POST' ? JSON.stringify(built.body) : undefined,
      signal: ac.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      const detail = raw.slice(0, 300).replace(/\s+/g, ' ');
      const err = new Error(`HTTP ${res.status}${detail ? `：${detail}` : ''}`) as Error & { kind?: string; status?: number };
      err.kind = 'http';
      err.status = res.status;
      throw err;
    }
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* text-get 等纯文本回复 */
    }
    const text = parseReply(protocol, data);
    if (!text) {
      const err = new Error('回复为空') as Error & { kind?: string };
      err.kind = 'empty';
      throw err;
    }
    return stripThink(text);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') {
      const e = new Error('aborted') as Error & { kind?: string };
      e.kind = 'aborted';
      throw e;
    }
    if ((err as Error & { kind?: string }).kind) throw err;
    const e = new Error(err instanceof Error ? err.message : String(err)) as Error & { kind?: string };
    e.kind = 'network';
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
