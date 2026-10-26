import { prisma } from './db';

const PAUSE_KEY = 'grading_paused';

const AI_KEYS = {
  baseURL: 'ai_base_url',
  apiKey: 'ai_api_key',
  model: 'ai_model',
  maxSteps: 'grading_max_steps',
  timeoutMs: 'grading_timeout_ms',
  maxOutputTokens: 'grading_max_output_tokens',
  contextChars: 'grading_context_chars',
} as const;

export type AISource = 'database' | 'environment' | 'none';

export type AIConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  maxSteps: number;
  timeoutMs: number;
  maxOutputTokens: number;
  contextChars: number;
  source: AISource;
};

export type PublicAIConfig = {
  baseURL: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyMasked: string;
  source: AISource;
  maxSteps: number;
  timeoutMs: number;
  maxOutputTokens: number;
  contextChars: number;
};

export type AISettingsInput = {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxSteps?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  contextChars?: number;
  clearKey?: boolean;
};

export async function isGradingPaused(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: PAUSE_KEY } });
  return row?.value === '1';
}

export async function setGradingPaused(paused: boolean): Promise<boolean> {
  await prisma.appSetting.upsert({
    where: { key: PAUSE_KEY },
    update: { value: paused ? '1' : '0' },
    create: { key: PAUSE_KEY, value: paused ? '1' : '0' },
  });
  return paused;
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return '••••';
  return '••••' + key.slice(-4);
}

async function readAISettingsMap(): Promise<Map<string, string>> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: Object.values(AI_KEYS) } },
  });
  return new Map(rows.map((r) => [r.key, r.value]));
}

/**
 * 批改配置来源：数据库优先，其次环境变量。
 * API Key 只允许在服务端读取，绝不返回给前端。
 */
export async function getAIConfig(): Promise<AIConfig> {
  const map = await readAISettingsMap();
  const dbBaseURL = (map.get(AI_KEYS.baseURL) || '').trim();
  const dbKey = (map.get(AI_KEYS.apiKey) || '').trim();
  const dbModel = (map.get(AI_KEYS.model) || '').trim();

  const envBaseURL = (process.env.AI_BASE_URL || '').trim();
  const envKey = (process.env.AI_API_KEY || '').trim();
  const envModel = (process.env.AI_MODEL || '').trim();

  const apiKey = dbKey || envKey;
  const baseURL = dbBaseURL || envBaseURL;
  const model = dbModel || envModel;

  return {
    baseURL,
    apiKey,
    model,
    maxSteps: Number(map.get(AI_KEYS.maxSteps)) || envInt('GRADING_MAX_STEPS', 6),
    timeoutMs: Number(map.get(AI_KEYS.timeoutMs)) || envInt('GRADING_TIMEOUT_MS', 120000),
    maxOutputTokens:
      Number(map.get(AI_KEYS.maxOutputTokens)) || envInt('GRADING_MAX_OUTPUT_TOKENS', 1500),
    contextChars: Number(map.get(AI_KEYS.contextChars)) || envInt('GRADING_CONTEXT_CHARS', 32000),
    source: apiKey ? (dbKey ? 'database' : 'environment') : 'none',
  };
}

export async function getPublicAIConfig(): Promise<PublicAIConfig> {
  const cfg = await getAIConfig();
  return {
    baseURL: cfg.baseURL,
    model: cfg.model,
    apiKeyConfigured: Boolean(cfg.apiKey),
    apiKeyMasked: maskKey(cfg.apiKey),
    source: cfg.source,
    maxSteps: cfg.maxSteps,
    timeoutMs: cfg.timeoutMs,
    maxOutputTokens: cfg.maxOutputTokens,
    contextChars: cfg.contextChars,
  };
}

export async function saveAISettings(input: AISettingsInput): Promise<PublicAIConfig> {
  const upserts: { key: string; value: string }[] = [];

  if (input.baseURL !== undefined) {
    upserts.push({ key: AI_KEYS.baseURL, value: input.baseURL.trim().replace(/\/+$/, '') });
  }
  if (input.model !== undefined) {
    upserts.push({ key: AI_KEYS.model, value: input.model.trim() });
  }
  if (input.clearKey) {
    upserts.push({ key: AI_KEYS.apiKey, value: '' });
  } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    upserts.push({ key: AI_KEYS.apiKey, value: input.apiKey.trim() });
  }
  if (Number.isFinite(input.maxSteps) && Number(input.maxSteps) > 0) {
    upserts.push({ key: AI_KEYS.maxSteps, value: String(Math.floor(Number(input.maxSteps))) });
  }
  if (Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0) {
    upserts.push({ key: AI_KEYS.timeoutMs, value: String(Math.floor(Number(input.timeoutMs))) });
  }
  if (Number.isFinite(input.maxOutputTokens) && Number(input.maxOutputTokens) > 0) {
    upserts.push({
      key: AI_KEYS.maxOutputTokens,
      value: String(Math.floor(Number(input.maxOutputTokens))),
    });
  }
  if (Number.isFinite(input.contextChars) && Number(input.contextChars) > 500) {
    upserts.push({ key: AI_KEYS.contextChars, value: String(Math.floor(Number(input.contextChars))) });
  }

  if (upserts.length) {
    await prisma.$transaction(
      upserts.map((item) =>
        prisma.appSetting.upsert({
          where: { key: item.key },
          update: { value: item.value },
          create: { key: item.key, value: item.value },
        })
      )
    );
  }

  return getPublicAIConfig();
}

export async function clearAIKey(): Promise<PublicAIConfig> {
  return saveAISettings({ clearKey: true });
}

/** 批改服务状态：worker 心跳、暂停开关、待批任务数 */
export async function getGradingStatus(): Promise<{
  paused: boolean;
  workerLastSeen: string;
  workerOnline: boolean;
  pending: number;
}> {
  const [pauseRow, seenRow, pending] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: PAUSE_KEY } }),
    prisma.appSetting.findUnique({ where: { key: 'grading_worker_seen' } }),
    prisma.gradingTask.count({ where: { status: { in: ['pending', 'running'] } } }),
  ]);
  const workerLastSeen = seenRow?.value || '';
  const workerOnline = workerLastSeen
    ? Date.now() - new Date(workerLastSeen).getTime() < 15000
    : false;
  return {
    paused: pauseRow?.value === '1',
    workerLastSeen,
    workerOnline,
    pending,
  };
}

/**
 * 读取 OpenAI 兼容服务的 /models 列表。
 * 允许先用表单里的 Base URL / Key 试拉取，未填时回退到已保存配置。
 */
export async function listAIModels(input?: { baseURL?: string; apiKey?: string }): Promise<string[]> {
  const cfg = await getAIConfig();
  const baseURL = (input?.baseURL || cfg.baseURL || '').trim().replace(/\/+$/, '');
  const apiKey = (input?.apiKey || cfg.apiKey || '').trim();

  if (!baseURL) throw new Error('请先填写 Base URL');
  if (!apiKey) throw new Error('请先填写 API Key');

  let target: URL;
  try {
    target = new URL(baseURL + '/models');
  } catch {
    throw new Error('Base URL 格式不正确');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Base URL 必须是 http:// 或 https:// 地址');
  }

  const res = await fetch(target.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);

  const json: unknown = await res.json();
  const list = Array.isArray(json)
    ? json
    : (json as { data?: unknown[]; models?: unknown[] })?.data ||
      (json as { models?: unknown[] })?.models ||
      [];

  const ids = (list as unknown[])
    .map((item) => (typeof item === 'string' ? item : (item as { id?: string })?.id))
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  return Array.from(new Set(ids)).sort();
}

