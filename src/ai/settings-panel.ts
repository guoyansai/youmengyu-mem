/**
 * AI 服务设置控制器：不再独立开编辑器面板，而是嵌入侧边栏记忆面板的「AI 服务」标签页。
 * 三通路选择（离线/在线/免费）、服务源增删改查与测试连接、自动记录/整理开关、运行日志。
 * 密钥输入只单向写进 SecretStorage，回显只给末 4 位。
 * 消息协议：aiState/toast/testResult 下行；savePrefs/selectProvider/saveProvider/
 * deleteProvider/testProvider/runRecord/runConsolidate/captureEditor 上行（由 MemoryPanel 转发）。
 */
import * as vscode from 'vscode';
import { AI_LANES, type ChatLane } from './core';
import type { AiEngine, Provider } from './engine';
import { PRESETS } from './presets';
import type { MemoryOrganizer } from './organize';

const LANE_LABEL: Record<ChatLane, string> = { offline: '离线', online: '在线', free: '免费' };
const PROTOCOL_LABEL: Record<string, string> = {
  openai: 'OpenAI 兼容',
  azure: 'Azure',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
  'text-get': 'Text GET（Pollinations）',
};

type SettingsDeps = {
  engine: AiEngine;
  organizer: MemoryOrganizer;
};

/** 设置页上行消息类型（panel.ts 据此转发给控制器） */
export const AI_SETTINGS_MSGS: readonly string[] = [
  'savePrefs',
  'selectProvider',
  'saveProvider',
  'deleteProvider',
  'testProvider',
  'runRecord',
  'runConsolidate',
  'captureEditor',
];

export class AiSettingsController {
  private view?: vscode.Webview;

  constructor(
    private deps: SettingsDeps,
    context: vscode.ExtensionContext
  ) {
    context.subscriptions.push(
      deps.engine.onChange(() => {
        if (this.view) void this.pushTo(this.view);
      })
    );
  }

  /** 记忆面板的 webview 创建/销毁时同步给控制器 */
  setView(view?: vscode.Webview): void {
    this.view = view;
  }

  private async pushTo(webview: vscode.Webview): Promise<void> {
    const engine = this.deps.engine;
    const providers = await Promise.all(
      engine.providers.map(async (p) => ({
        ...p,
        keyHint: p.keyless ? '（免密钥）' : await engine.keyHint(p.id),
      }))
    );
    await webview.postMessage({
      type: 'aiState',
      prefs: engine.prefs,
      providers,
      presets: PRESETS.map((p) => ({ id: p.id, name: p.name, lane: p.lane, needsKey: p.needsKey, protocol: p.protocol ?? 'openai' })),
      presetDetails: PRESETS.map((p) => ({ id: p.id, baseUrl: p.baseUrl, model: p.model })),
      protocols: Object.entries(PROTOCOL_LABEL).map(([id, label]) => ({ id, label })),
      lanes: AI_LANES.map((l) => ({ id: l, label: LANE_LABEL[l] })),
      log: this.deps.organizer.getLog().slice(0, 12),
    });
  }

  /** 推送当前设置状态（切到 AI 标签页 / 引擎配置变化时调用） */
  async push(): Promise<void> {
    if (this.view) await this.pushTo(this.view);
  }

  /** 处理设置页上行消息（MemoryPanel 转发） */
  async handle(msg: { type: string; [k: string]: unknown }, webview: vscode.Webview): Promise<void> {
    const engine = this.deps.engine;
    const organizer = this.deps.organizer;
    const toast = (text: string, kind?: string) => void webview.postMessage({ type: 'toast', text, kind });
    switch (msg.type) {
      case 'savePrefs': {
        engine.savePrefs((msg.prefs ?? {}) as Record<string, never>);
        organizer.restart();
        toast('已保存偏好');
        return;
      }
      case 'selectProvider': {
        const prefs = engine.selectProvider(String(msg.id));
        // 切通路后同步整组偏好到 organizer
        organizer.restart();
        void webview.postMessage({ type: 'toast', text: `当前通路：${LANE_LABEL[prefs.lane]}`, kind: 'ok' });
        return;
      }
      case 'saveProvider': {
        const p = (msg.provider ?? {}) as Partial<Provider> & { lane?: string };
        if (!p.name || !p.baseUrl || !p.model || !p.lane) {
          toast('名称、地址、模型不能为空', 'err');
          return;
        }
        const row = engine.upsertProvider({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          model: p.model,
          protocol: (p.protocol as Provider['protocol']) || undefined,
          apiVersion: p.apiVersion || undefined,
          lane: p.lane as ChatLane,
          keyless: Boolean(p.keyless),
        });
        if (typeof msg.key === 'string' && msg.key) await engine.setKey(row.id, msg.key.trim());
        engine.selectProvider(row.id);
        organizer.restart();
        toast(`已保存服务源「${row.name}」并设为当前通路`);
        return;
      }
      case 'deleteProvider': {
        const ok = engine.removeProvider(String(msg.id));
        toast(ok ? '已删除' : '内置免费源不能删除', ok ? 'ok' : 'err');
        return;
      }
      case 'testProvider': {
        toast('正在测试连接…');
        const r = await engine.testProvider(String(msg.id));
        void webview.postMessage({ type: 'testResult', id: String(msg.id), ...r });
        return;
      }
      case 'runRecord': {
        toast('正在运行主动记录…');
        const entry = await organizer.flush('record');
        toast(entry.error ? `记录失败：${entry.error}` : entry.detail, entry.error ? 'err' : 'ok');
        return;
      }
      case 'runConsolidate': {
        toast('正在运行整理…');
        const entry = await organizer.consolidate();
        toast(entry.error ? `整理失败：${entry.error}` : entry.detail, entry.error ? 'err' : 'ok');
        return;
      }
      case 'captureEditor': {
        organizer.captureActiveEditor();
        return;
      }
      default:
        return;
    }
  }
}
