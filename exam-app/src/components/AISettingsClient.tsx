'use client';

import { useEffect, useState } from 'react';

type PublicAIConfig = {
  baseURL: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyMasked: string;
  source: 'database' | 'environment' | 'none';
  maxSteps: number;
  timeoutMs: number;
  maxOutputTokens: number;
  contextChars: number;
};

type TestResult = { ok: true; latencyMs: number; reply: string; model: string };

const sourceLabel: Record<PublicAIConfig['source'], string> = {
  database: '已配置（本地数据库）',
  environment: '已配置（环境变量）',
  none: '未配置',
};

export default function AISettingsClient() {
  const [config, setConfig] = useState<PublicAIConfig | null>(null);
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [maxSteps, setMaxSteps] = useState('6');
  const [timeoutMs, setTimeoutMs] = useState('120000');
  const [maxOutputTokens, setMaxOutputTokens] = useState('1500');
  const [contextChars, setContextChars] = useState('32000');

  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | ''>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  function apply(cfg: PublicAIConfig) {
    setConfig(cfg);
    setBaseURL(cfg.baseURL || '');
    setModel(cfg.model || '');
    setMaxSteps(String(cfg.maxSteps || 6));
    setTimeoutMs(String(cfg.timeoutMs || 120000));
    setMaxOutputTokens(String(cfg.maxOutputTokens || 1500));
    setContextChars(String(cfg.contextChars || 32000));
    setApiKey('');
  }

  async function load() {
    const res = await fetch('/api/settings/ai');
    const data = await res.json();
    if (res.ok) apply(data as PublicAIConfig);
  }

  useEffect(() => {
    load().catch(() => setError('读取设置失败'));
  }, []);

  async function save() {
    setBusy('save');
    setError('');
    setMessage('');
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {
        baseURL,
        model,
        maxSteps: Number(maxSteps),
        timeoutMs: Number(timeoutMs),
        maxOutputTokens: Number(maxOutputTokens),
        contextChars: Number(contextChars),
      };
      if (apiKey.trim()) body.apiKey = apiKey.trim();

      const res = await fetch('/api/settings/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');
      apply(data as PublicAIConfig);
      setMessage('已保存。新的配置会在下一次批改任务生效。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy('');
    }
  }

  async function test() {
    setBusy('test');
    setError('');
    setMessage('');
    setTestResult(null);
    try {
      const res = await fetch('/api/settings/ai/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '连接测试失败');
      setTestResult(data as TestResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接测试失败');
    } finally {
      setBusy('');
    }
  }

  async function fetchModels() {
    setModelsLoading(true);
    setError('');
    setMessage('');
    try {
      const res = await fetch('/api/settings/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseURL: baseURL.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '获取模型列表失败');
      const list: string[] = Array.isArray(data.models) ? data.models : [];
      setModels(list);
      if (!list.length) {
        setMessage('服务没有返回模型，请手动填写模型名。');
      } else if (!model && list.length) {
        setModel(list[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取模型列表失败');
    } finally {
      setModelsLoading(false);
    }
  }

  async function clearKey() {
    if (!window.confirm('清除本地保存的 API Key？如果环境变量里还有 Key，会回退到环境变量。')) return;
    setBusy('clear');
    setError('');
    setMessage('');
    setTestResult(null);
    try {
      const res = await fetch('/api/settings/ai', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '清除失败');
      apply(data as PublicAIConfig);
      setMessage('已清除数据库中的 API Key。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '清除失败');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">AI 批改设置</h1>
        <p className="mt-1 text-sm text-slate-500">
          配置兼容 OpenAI 接口的模型服务。密钥只保存在本地后端，浏览器永远拿不到明文。
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">当前状态</div>
            <div className="mt-1 text-xs text-slate-500">
              {config ? sourceLabel[config.source] : '读取中…'}
              {config?.apiKeyConfigured ? ` · Key ${config.apiKeyMasked}` : ''}
              {config?.model ? ` · 模型 ${config.model}` : ''}
            </div>
          </div>
          {config && config.source === 'none' ? (
            <span className="rounded bg-amber-50 px-3 py-1 text-xs text-amber-700">
              主观题会使用模拟评分
            </span>
          ) : null}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="text-sm text-slate-700">Base URL</span>
            <input
              type="url"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
            <span className="mt-1 block text-xs text-slate-500">需要兼容 OpenAI Chat Completions</span>
          </label>

          <div className="block">
            <span className="text-sm text-slate-700">模型名</span>
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="例如 gpt-4o-mini / qwen-plus"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={fetchModels}
                disabled={modelsLoading || !baseURL.trim() || (!apiKey.trim() && !config?.apiKeyConfigured)}
                className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {modelsLoading ? '获取中…' : '获取模型'}
              </button>
            </div>
            {models.length ? (
              <select
                value={models.includes(model) ? model : ''}
                onChange={(e) => setModel(e.target.value)}
                className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">从列表选择（{models.length} 个可用模型）</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="mt-1 block text-xs text-slate-500">
              需支持工具调用与结构化输出；部分服务不提供 /models 接口，可手动填写
            </span>
          </div>

          <label className="block md:col-span-2">
            <span className="text-sm text-slate-700">API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
              placeholder={
                config?.apiKeyConfigured
                  ? `已保存 ${config.apiKeyMasked}，留空保持不变`
                  : '输入 API Key（仅保存在本地）'
              }
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>
        </div>

        <details className="mt-4 rounded-md border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm text-slate-700">单题批改限制（高级）</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="text-xs text-slate-600">最大工具步数</span>
              <input
                type="number"
                min={1}
                max={20}
                value={maxSteps}
                onChange={(e) => setMaxSteps(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              <span className="mt-1 block text-xs text-slate-500">
                模型每调用一轮工具算一步；达到上限仍未提交评分，本题判失败并进入复核
              </span>
            </label>
            <label className="block">
              <span className="text-xs text-slate-600">超时（毫秒）</span>
              <input
                type="number"
                min={1000}
                step={1000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-600">输出 Token 预算</span>
              <input
                type="number"
                min={100}
                step={100}
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="block md:col-span-3">
              <span className="text-xs text-slate-600">单题上下文预算（字符）</span>
              <input
                type="number"
                min={1000}
                step={1000}
                value={contextChars}
                onChange={(e) => setContextChars(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              <span className="mt-1 block text-xs text-slate-500">
                按“学生答案 → 参考答案 → 题干 → 共用材料 → 解析”的顺序分配；超出部分会截断并记录在评分详情里
              </span>
            </label>
          </div>
        </details>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={busy !== ''}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy === 'save' ? '保存中…' : '保存设置'}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={busy !== '' || !config?.apiKeyConfigured}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            onClick={clearKey}
            disabled={busy !== '' || !config?.apiKeyConfigured}
            className="rounded-md border border-red-200 bg-white px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-60"
          >
            清除 Key
          </button>
        </div>

        {message ? (
          <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}
        {testResult ? (
          <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
            连接成功：{testResult.model} · {testResult.latencyMs} ms · 回复 “{testResult.reply || '(空)'}”
          </div>
        ) : null}

        <p className="mt-4 text-xs text-slate-500">
          Key 只写入本机 SQLite 的 AppSetting 表，接口只返回掩码；批改 worker 每次任务开始时重新读取配置，无需重启。
        </p>
      </div>
    </div>
  );
}
