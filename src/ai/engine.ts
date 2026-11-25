/**
 * AI 服务引擎：三通路（离线/在线/免费）偏好、服务源管理、密钥存取、带 failover 的调用。
 * 服务源列表与偏好存 globalState；API 密钥只进 SecretStorage，不落 JSON、不进代码。
 */
import * as vscode from 'vscode';
import { chatOnce, guardFree, fitContext, LANE_TOKEN_BUDGET, type ChatLane, type ChatTurn, stripThink } from './core';
import { PRESETS, type ProviderProtocol } from './presets';

const STATE_KEY = 'aimemory.ai.state.v1';
export const SECRET_PREFIX = 'aimemory.ai.key:';

export type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol?: ProviderProtocol;
  apiVersion?: string;
  lane: ChatLane;
  /** 免密钥（公共免费接口） */
  keyless?: boolean;
  /** 系统补上的预设源，不能删 */
  builtin?: boolean;
  createdAt: number;
};

export type AiPrefs = {
  lane: ChatLane;
  onlineId: string;
  freeId: string;
  offlineId: string;
  /** 免费档超时秒数 */
  freeTimeoutSec: number;
  /** 免费档失败自动换下一个免费源 */
  freeFailover: boolean;
  /** 自动主动记录：捕获 git 提交与 AI 聊天内容，提炼成记忆 */
  autoRecord: boolean;
  /** 自动整理：合并重复、归档过期、提炼事实，压缩注入体积 */
  autoConsolidate: boolean;
  /** 整理周期（小时） */
  consolidateHours: number;
  /** 每次记录最多新增条数 */
  maxAutoEntries: number;
  /** AI 聊天捕获的文件匹配（glob，换行分隔），如导出的对话 md/json */
  chatWatchPatterns: string[];
};

export const DEFAULT_PREFS: AiPrefs = {
  lane: 'free',
  onlineId: '',
  freeId: 'free-pollinations',
  offlineId: '',
  freeTimeoutSec: 20,
  freeFailover: true,
  autoRecord: true,
  autoConsolidate: true,
  consolidateHours: 24,
  maxAutoEntries: 5,
  chatWatchPatterns: ['**/*.chat.md', '**/.aichat/**/*.md', '**/.aichat/**/*.json'],
};

export type AiState = { prefs: AiPrefs; providers: Provider[] };

const FREE_TIMEOUT_CHOICES = [10, 20, 30, 45];

function normalizeLane(v: unknown): ChatLane {
  return v === 'offline' || v === 'online' || v === 'free' ? v : 'free';
}

export function normalizePrefs(raw: unknown): AiPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<AiPrefs>;
  const timeout = Number(o.freeTimeoutSec);
  const hours = Number(o.consolidateHours);
  const max = Number(o.maxAutoEntries);
  const patterns = Array.isArray(o.chatWatchPatterns)
    ? o.chatWatchPatterns.filter((p) => typeof p === 'string' && p.trim())
    : DEFAULT_PREFS.chatWatchPatterns;
  return {
    lane: normalizeLane(o.lane),
    onlineId: typeof o.onlineId === 'string' ? o.onlineId : '',
    freeId: typeof o.freeId === 'string' ? o.freeId : DEFAULT_PREFS.freeId,
    offlineId: typeof o.offlineId === 'string' ? o.offlineId : '',
    freeTimeoutSec: FREE_TIMEOUT_CHOICES.includes(timeout) ? timeout : DEFAULT_PREFS.freeTimeoutSec,
    freeFailover: o.freeFailover !== false,
    autoRecord: o.autoRecord !== false,
    autoConsolidate: o.autoConsolidate !== false,
    consolidateHours: hours > 0 && hours <= 24 * 7 ? hours : DEFAULT_PREFS.consolidateHours,
    maxAutoEntries: max > 0 && max <= 20 ? Math.floor(max) : DEFAULT_PREFS.maxAutoEntries,
    chatWatchPatterns: patterns.length ? patterns : DEFAULT_PREFS.chatWatchPatterns,
  };
}

/** 把某条服务源写成当前通路的选中项。 */
export function prefsForProvider(prefs: AiPrefs, p: { id: string; lane?: string }): AiPrefs {
  const lane = normalizeLane(p.lane);
  prefs.lane = lane;
  if (lane === 'online') prefs.onlineId = p.id;
  else if (lane === 'free') prefs.freeId = p.id;
  else prefs.offlineId = p.id;
  return prefs;
}

function newId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export type TalkResult = {
  text: string;
  providerId: string;
  model: string;
  error?: string;
  switched: number;
};

/** 免费源健康度：刚失败的排到最后，60 秒冷却。只存内存。 */
type FailoverHealth = {
  order(ids: readonly string[], chosen?: string): string[];
  fail(id: string): void;
  ok(id: string): void;
};

function createFreeHealth(): FailoverHealth {
  const failedAt = new Map<string, number>();
  let lastGood = '';
  const cooldown = 60_000;
  return {
    order(ids, chosen) {
      const now = Date.now();
      const cooling = (id: string) => now - (failedAt.get(id) ?? -Infinity) < cooldown;
      const rank = (id: string) => (cooling(id) ? 2 : id === chosen ? 0 : id === lastGood ? 0.5 : 1);
      return [...new Set(ids)].map((id, i) => ({ id, i, r: rank(id) })).sort((a, b) => a.r - b.r || a.i - b.i).map((r) => r.id);
    },
    fail(id) {
      failedAt.set(id, Date.now());
      if (lastGood === id) lastGood = '';
    },
    ok(id) {
      failedAt.delete(id);
      lastGood = id;
    },
  };
}

export type RunFailoverResult<T> =
  | { ok: true; id: string; value: T; attempts: { id: string; error?: string }[] }
  | { ok: false; error: string; attempts: { id: string; error?: string }[] };

/** 依次试候选源，成功即停；全失败回最后一条错误。 */
export async function runLaneFailover<T>(
  ids: readonly string[],
  call: (id: string) => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
  opts: { timeoutMs: number; health: FailoverHealth; signal?: AbortSignal }
): Promise<RunFailoverResult<T>> {
  const attempts: { id: string; error?: string }[] = [];
  let error = 'noFree';
  for (const id of ids) {
    if (opts.signal?.aborted) return { ok: false, error: 'aborted', attempts };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), opts.timeoutMs);
    });
    const r = await Promise.race([
      call(id).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
      timeout,
    ]);
    clearTimeout(timer);
    if (r.ok) {
      opts.health.ok(id);
      attempts.push({ id });
      return { ok: true, id, value: r.value, attempts };
    }
    opts.health.fail(id);
    error = r.error;
    attempts.push({ id, error: r.error });
  }
  return { ok: false, error, attempts };
}

export class AiEngine {
  private state: AiState;
  private health = createFreeHealth();
  private listeners = new Set<() => void>();

  constructor(
    private context: vscode.ExtensionContext,
    private log?: (line: string) => void
  ) {
    this.state = { prefs: DEFAULT_PREFS, providers: [] };
    this.loadState();
  }

  // ---------- 状态 ----------
  private loadState(): AiState {
    const raw = this.context.globalState.get<AiState>(STATE_KEY);
    const prefs = normalizePrefs(raw?.prefs);
    const providers = Array.isArray(raw?.providers) ? (raw!.providers as Provider[]) : [];
    this.state = { prefs, providers };
    const added = this.ensureKeylessProviders();
    if (added) this.persist();
    return this.state;
  }

  private persist(): void {
    void this.context.globalState.update(STATE_KEY, this.state);
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): vscode.Disposable {
    this.listeners.add(fn);
    return new vscode.Disposable(() => this.listeners.delete(fn));
  }

  get prefs(): AiPrefs {
    return this.state.prefs;
  }

  get providers(): Provider[] {
    return this.state.providers;
  }

  savePrefs(patch: Partial<AiPrefs>): AiPrefs {
    this.state.prefs = normalizePrefs({ ...this.state.prefs, ...patch });
    this.persist();
    return this.state.prefs;
  }

  /** 免密钥公共接口没有就补上，免费通路开箱即用。已有的不覆盖。 */
  private ensureKeylessProviders(): number {
    const ids = new Set(this.state.providers.map((p) => p.id));
    let added = 0;
    for (const preset of PRESETS.filter((p) => p.keyless)) {
      if (ids.has(preset.id)) continue;
      this.state.providers.push({
        id: preset.id,
        name: preset.name,
        baseUrl: preset.baseUrl,
        model: preset.model,
        protocol: preset.protocol,
        lane: 'free',
        keyless: true,
        builtin: true,
        createdAt: 1,
      });
      added += 1;
    }
    return added;
  }

  upsertProvider(input: Partial<Provider> & { name: string; baseUrl: string; model: string; lane: ChatLane }): Provider {
    const lane = normalizeLane(input.lane);
    let row = input.id ? this.state.providers.find((p) => p.id === input.id) : undefined;
    if (!row) {
      row = {
        id: input.id && !input.builtin ? input.id : newId(),
        name: input.name,
        baseUrl: input.baseUrl,
        model: input.model,
        protocol: input.protocol,
        apiVersion: input.apiVersion,
        lane,
        keyless: input.keyless,
        builtin: input.builtin,
        createdAt: Date.now(),
      };
      this.state.providers.push(row);
    } else {
      row.name = input.name;
      row.baseUrl = input.baseUrl;
      row.model = input.model;
      row.protocol = input.protocol;
      row.apiVersion = input.apiVersion;
      row.lane = lane;
      row.keyless = input.keyless;
    }
    // 编辑当前通路选中的源时保持选中
    this.persist();
    return row;
  }

  removeProvider(id: string): boolean {
    const before = this.state.providers.length;
    this.state.providers = this.state.providers.filter((p) => p.id !== id || p.builtin);
    const removed = this.state.providers.length < before;
    if (removed) {
      if (this.state.prefs.freeId === id) this.state.prefs.freeId = '';
      if (this.state.prefs.onlineId === id) this.state.prefs.onlineId = '';
      if (this.state.prefs.offlineId === id) this.state.prefs.offlineId = '';
      void this.context.secrets.delete(SECRET_PREFIX + id);
      this.persist();
    }
    return removed;
  }

  selectProvider(id: string): AiPrefs {
    const row = this.state.providers.find((p) => p.id === id);
    if (!row) return this.state.prefs;
    this.state.prefs = prefsForProvider(this.state.prefs, row);
    this.persist();
    return this.state.prefs;
  }

  async setKey(id: string, key: string): Promise<void> {
    if (key) await this.context.secrets.store(SECRET_PREFIX + id, key);
    else await this.context.secrets.delete(SECRET_PREFIX + id);
  }

  async getKey(id: string): Promise<string> {
    return (await this.context.secrets.get(SECRET_PREFIX + id)) ?? '';
  }

  async hasKey(id: string): Promise<boolean> {
    return Boolean(await this.context.secrets.get(SECRET_PREFIX + id));
  }

  /** 密钥只回末 4 位给设置页展示，全量不出引擎。 */
  async keyHint(id: string): Promise<string> {
    const key = await this.getKey(id);
    if (!key) return '';
    return key.length <= 8 ? '****' : `****${key.slice(-4)}`;
  }

  // ---------- 调用 ----------
  private poolFor(lane: ChatLane): Provider[] {
    return this.state.providers.filter((p) => p.lane === lane);
  }

  chosenFor(lane: ChatLane = this.state.prefs.lane): Provider | undefined {
    const pool = this.poolFor(lane);
    const id = lane === 'online' ? this.state.prefs.onlineId : lane === 'free' ? this.state.prefs.freeId : this.state.prefs.offlineId;
    return pool.find((p) => p.id === id) ?? pool.find((p) => p.keyless) ?? pool[0];
  }

  /** 当前通路是否可用（有选中源；需密钥的源已存密钥才算可用）。 */
  async ready(lane: ChatLane = this.state.prefs.lane): Promise<boolean> {
    const chosen = this.chosenFor(lane);
    if (!chosen) return false;
    if (chosen.keyless || !PRESETS.find((p) => p.id === chosen.id)?.needsKey) return true;
    return this.hasKey(chosen.id);
  }

  /**
   * 按当前通路发一次对话。离线/在线只打选中那条；免费档可在免费源间超时换源。
   * 免费档出网前剥密钥/证件号/手机号。
   */
  async talk(
    messages: ChatTurn[],
    opts?: { lane?: ChatLane; signal?: AbortSignal; maxTokens?: number }
  ): Promise<TalkResult> {
    const lane = opts?.lane ?? this.state.prefs.lane;
    const pool = this.poolFor(lane);
    const chosen = this.chosenFor(lane);
    const empty = (error: string): TalkResult => ({ text: '', providerId: '', model: '', error, switched: 0 });
    if (!chosen) return empty(lane === 'offline' ? '未配置离线服务源' : lane === 'online' ? '未配置在线服务源' : '未配置免费服务源');
    if (opts?.signal?.aborted) return { ...empty('已中断'), providerId: chosen.id, model: chosen.model };

    let turns = fitContext(messages, LANE_TOKEN_BUDGET[lane]);
    if (lane === 'free') {
      let removed = 0;
      turns = turns.map((row) => {
        const hit = guardFree(row.content);
        removed += hit.removed;
        return { ...row, content: hit.text };
      });
      if (removed && this.log) this.log(`[ai] 免费档拦截敏感片段 ${removed} 处`);
    }

    const callProvider = async (p: Provider, timeoutMs: number): Promise<string> => {
      const key = p.keyless ? '' : await this.getKey(p.id);
      return chatOnce(
        { protocol: p.protocol, baseUrl: p.baseUrl, model: p.model, apiVersion: p.apiVersion },
        key,
        turns,
        { signal: opts?.signal, timeoutMs, maxTokens: opts?.maxTokens }
      );
    };

    if (lane === 'free' && this.state.prefs.freeFailover) {
      const ids = this.health.order(pool.map((p) => p.id), chosen.id);
      const byId = new Map(pool.map((p) => [p.id, p]));
      const result = await runLaneFailover(
        ids,
        async (id) => {
          const row = byId.get(id);
          if (!row) return { ok: false as const, error: 'noFree' };
          try {
            return { ok: true as const, value: await callProvider(row, this.state.prefs.freeTimeoutSec * 1000) };
          } catch (err) {
            return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
          }
        },
        { timeoutMs: this.state.prefs.freeTimeoutSec * 1000, health: this.health, signal: opts?.signal }
      );
      const switched = Math.max(0, result.attempts.length - 1);
      if (!result.ok) return { text: '', providerId: chosen.id, model: chosen.model, error: result.error, switched };
      const row = byId.get(result.id) ?? chosen;
      if (switched && this.log) this.log(`[ai] 免费档换源 ${switched} 次后命中 ${row.name}`);
      return { text: result.value, providerId: row.id, model: row.model, switched };
    }

    const timeoutMs = lane === 'offline' ? 120_000 : 60_000;
    try {
      const text = stripThink(await callProvider(chosen, timeoutMs));
      return { text, providerId: chosen.id, model: chosen.model, switched: 0 };
    } catch (err) {
      return { text: '', providerId: chosen.id, model: chosen.model, error: err instanceof Error ? err.message : String(err), switched: 0 };
    }
  }

  /** 设置页「测试连接」：发一句 ping，返回耗时与错误。 */
  async testProvider(id: string): Promise<{ ok: boolean; ms: number; error?: string; reply?: string }> {
    const row = this.state.providers.find((p) => p.id === id);
    if (!row) return { ok: false, ms: 0, error: '服务源不存在' };
    const started = Date.now();
    try {
      const key = row.keyless ? '' : await this.getKey(row.id);
      const reply = await chatOnce(
        { protocol: row.protocol, baseUrl: row.baseUrl, model: row.model, apiVersion: row.apiVersion },
        key,
        [{ role: 'user', content: '只回复两个字：正常' }],
        { timeoutMs: 30_000, maxTokens: 64 }
      );
      return { ok: true, ms: Date.now() - started, reply: reply.slice(0, 60) };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export { PRESETS };
