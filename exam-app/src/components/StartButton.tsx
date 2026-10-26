'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function StartButton({
  paperId,
  label = '开始答题',
  variant = 'primary',
}: {
  paperId: string;
  label?: string;
  variant?: 'primary' | 'ghost';
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paperId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '创建作答失败');
      if (data.status !== 'in_progress') {
        router.push(`/results/${data.attemptId}`);
      } else {
        router.push(`/attempts/${data.attemptId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建作答失败');
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={start}
        disabled={loading}
        className={
          variant === 'primary'
            ? 'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60'
            : 'rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60'
        }
      >
        {loading ? '准备中…' : label}
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
