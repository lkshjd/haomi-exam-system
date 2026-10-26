'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function RunGradingButton({ label = '批改全部待批' }: { label?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  async function run() {
    setLoading(true);
    setMessage('');
    try {
      const control = await fetch('/api/grading/control').then((res) => res.json()).catch(() => ({}));
      if (control.paused) {
        setMessage('批改已暂停，请先在试卷页继续批改');
        return;
      }
      const res = await fetch('/api/grading/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drain: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '批改失败');
      const parts = [];
      if (data.processed > 0) parts.push(`已批改 ${data.processed} 题`);
      if (data.remaining > 0) parts.push(`还剩 ${data.remaining} 题`);
      if (data.timedOut) parts.push('到达时间预算，可再次点击继续');
      setMessage(parts.length ? parts.join('，') : '没有待批任务');
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '批改失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        {loading ? '批改中…' : label}
      </button>
      {message ? <span className="text-xs text-slate-500">{message}</span> : null}
    </span>
  );
}
