'use client';

import Link from 'next/link';
import { useState } from 'react';

type PaperSummary = {
  examId: string;
  title: string;
  courseModule?: string;
  questionCount: number;
  totalQuestions: number;
  missingAnswers: number;
  totalScore: number;
};

type StageSummary = {
  batchId: string;
  site: string;
  papers: PaperSummary[];
  assets: { images: number; attachments: number };
  errors: string[];
  warnings: string[];
};

type CommitResult = { imported: { paperId: string; title: string; created: boolean }[] };

export default function ImportClient() {
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<StageSummary | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'preview' | 'commit' | ''>('');

  async function preview() {
    if (!file) {
      setError('请先选择题包文件');
      return;
    }
    setBusy('preview');
    setError('');
    setSummary(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/import/preview', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '解析失败');
      setSummary(data as StageSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析失败');
    } finally {
      setBusy('');
    }
  }

  async function commit() {
    if (!summary) return;
    setBusy('commit');
    setError('');
    try {
      const res = await fetch('/api/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: summary.batchId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '导入失败');
      setResult(data as CommitResult);
      setSummary(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">导入题包</h1>
        <p className="mt-1 text-sm text-slate-500">
          支持油猴导出的 ZIP（含图片/附件）或纯 JSON。导入前会先校验并预览，确认后才写入题库。
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <input
          type="file"
          accept=".zip,.json,application/zip,application/json"
          onChange={(e) => {
            setFile(e.target.files?.[0] || null);
            setSummary(null);
            setResult(null);
            setError('');
          }}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:text-slate-700"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={preview}
            disabled={busy !== '' || !file}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy === 'preview' ? '解析中…' : '预览题包'}
          </button>
          {file ? <span className="text-xs text-slate-500">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span> : null}
        </div>
        {error ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
      </div>

      {summary ? (
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium">预览结果</div>
              <div className="mt-1 text-xs text-slate-500">
                来源：{summary.site} · {summary.papers.length} 套试卷 · 图片 {summary.assets.images} 个 · 附件{' '}
                {summary.assets.attachments} 个
              </div>
            </div>
            <button
              type="button"
              onClick={commit}
              disabled={busy !== ''}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {busy === 'commit' ? '导入中…' : '确认导入'}
            </button>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-xs text-slate-500">
                  <th className="border border-slate-200 px-2 py-1 text-left">试卷</th>
                  <th className="border border-slate-200 px-2 py-1 text-left">模块</th>
                  <th className="border border-slate-200 px-2 py-1 text-right">题数</th>
                  <th className="border border-slate-200 px-2 py-1 text-right">缺答案</th>
                  <th className="border border-slate-200 px-2 py-1 text-right">总分</th>
                </tr>
              </thead>
              <tbody>
                {summary.papers.map((p) => (
                  <tr key={p.examId}>
                    <td className="border border-slate-200 px-2 py-1">{p.title}</td>
                    <td className="border border-slate-200 px-2 py-1 text-slate-500">{p.courseModule || '—'}</td>
                    <td className="border border-slate-200 px-2 py-1 text-right">{p.questionCount}</td>
                    <td className={p.missingAnswers ? 'border border-slate-200 px-2 py-1 text-right text-amber-600' : 'border border-slate-200 px-2 py-1 text-right'}>
                      {p.missingAnswers}
                    </td>
                    <td className="border border-slate-200 px-2 py-1 text-right">{p.totalScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {summary.errors.length ? (
            <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
              {summary.errors.map((e, i) => (
                <div key={i}>错误：{e}</div>
              ))}
            </div>
          ) : null}
          {summary.warnings.length ? (
            <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {summary.warnings.slice(0, 8).map((w, i) => (
                <div key={i}>{w}</div>
              ))}
              {summary.warnings.length > 8 ? <div>…共 {summary.warnings.length} 条提示</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5">
          <div className="font-medium text-emerald-800">导入完成</div>
          <ul className="mt-2 space-y-1 text-sm text-emerald-900">
            {result.imported.map((p) => (
              <li key={p.paperId}>
                {p.title}（{p.created ? '新建' : '更新'}）
              </li>
            ))}
          </ul>
          <Link href="/papers" className="mt-3 inline-block rounded-md bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700">
            去试卷列表
          </Link>
        </div>
      ) : null}
    </div>
  );
}
