'use client';

import { useCallback, useEffect, useState } from 'react';

type GradingStatus = {
  paused: boolean;
  workerLastSeen: string;
  workerOnline: boolean;
  pending: number;
};

export default function GradingControl() {
  const [status, setStatus] = useState<GradingStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/grading/status', { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) setStatus(data as GradingStatus);
    } catch {
      /* 状态读取失败不影响操作 */
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function toggle() {
    if (!status || loading) return;
    setLoading(true);
    try {
      await fetch('/api/grading/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !status.paused }),
      });
      await load();
    } finally {
      setLoading(false);
    }
  }

  if (!status) return null;

  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
        <span
          className={
            status.workerOnline
              ? 'h-2 w-2 rounded-full bg-emerald-500'
              : 'h-2 w-2 rounded-full bg-slate-300'
          }
        />
        {status.workerOnline ? '批改服务运行中' : '批改服务未启动'}
        {status.pending > 0 ? ` · 待批 ${status.pending}` : ''}
      </span>
      <button
        type="button"
        onClick={toggle}
        disabled={loading}
        className={
          status.paused
            ? 'rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-100 disabled:opacity-60'
            : 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60'
        }
        title="暂停后 worker 与手动批改都不会领取新任务"
      >
        {loading ? '设置中…' : status.paused ? '已暂停 · 点此继续' : '暂停批改'}
      </button>
    </span>
  );
}
