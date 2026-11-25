/** 记忆条目类型标签 */
export const MEMORY_TAGS = [
  'lesson', // 教训 / 踩坑
  'decision', // 技术决策
  'architecture', // 仓库架构
  'preference', // 偏好 / 约定
  'bug', // 关键 Bug 与修法
  'workflow', // 工作流
  'fact', // 原子事实
  'other',
] as const;

export type MemoryTag = (typeof MEMORY_TAGS)[number];

export const TAG_LABEL: Record<string, string> = {
  lesson: '教训',
  decision: '决策',
  architecture: '架构',
  preference: '偏好',
  bug: 'Bug',
  workflow: '工作流',
  fact: '事实',
  other: '其他',
};

/** 条目之间的关系类型 */
export type RelationKind = 'related' | 'extends' | 'supersedes';

export interface MemoryRelation {
  targetId: string;
  kind: RelationKind;
  /** 关系强度 0-1 */
  score?: number;
  note?: string;
}

/** 历史版本快照：每次内容被改写前留档，可回溯 */
export interface MemoryVersion {
  title: string;
  content: string;
  tags: string[];
  importance: number;
  updatedAt: string;
  note?: string;
}

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  /** 1-5，5 最重要 */
  importance: number;
  createdAt: string;
  updatedAt: string;
  /** 来源：file:line / commit hash / manual */
  source?: string;
  /** 被检索/注入命中的次数 */
  uses: number;
  pinned?: boolean;
  /** 记忆空间：按项目/主题分区，默认 default */
  space?: string;
  /** 事实化片段：从正文抽取的原子事实 */
  facts?: string[];
  /** 自定义元数据（模块、负责人、文件等） */
  metadata?: Record<string, string>;
  /** 过期时间（ISO）；过期后默认不参与检索与注入 */
  expiresAt?: string;
  /** 归档（遗忘但留档，可恢复） */
  archived?: boolean;
  /** 版本链上是否为最新 */
  isLatest?: boolean;
  /** 被本条目取代的旧条目 id */
  supersedes?: string;
  /** 显式关系（自动关联在此基础上叠加） */
  relations?: MemoryRelation[];
  /** 历史版本，最近的在前，最多保留 10 条 */
  versions?: MemoryVersion[];
}

export interface MemoryDoc {
  version: number;
  entries: MemoryEntry[];
  updatedAt?: string;
}

export interface StoreData {
  dir: string;
  file: string;
  doc: MemoryDoc;
}
