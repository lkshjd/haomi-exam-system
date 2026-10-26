'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Option = { id: string; html: string };
type StructuredCell = { type: 'text'; text: string } | { type: 'input'; name: string; width?: string };
type StructuredOptions = {
  mode: 'structured';
  rows: StructuredCell[][];
  fields?: Record<string, { score?: number }>;
};
type Attachment = { filename?: string; originalName?: string; url?: string; size?: number };
export type ClientQuestion = {
  externalId: string;
  parentExternalId: string | null;
  type: string;
  typeName: string;
  order: number;
  stemHtml: string;
  options: Option[];
  structured: StructuredOptions | null;
  maxScore: number;
  attachments: Attachment[];
};
export type AnswerValue =
  | { kind: 'choice'; ids: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'structured'; values: Record<string, string> };

type SaveState = 'saving' | 'saved' | 'error';

function emptyAnswer(q: ClientQuestion): AnswerValue {
  if (q.type === 'structured_fill') return { kind: 'structured', values: {} };
  if (q.type === 'single_choice' || q.type === 'multiple_choice' || q.type === 'true_false') {
    return { kind: 'choice', ids: [] };
  }
  return { kind: 'text', text: '' };
}

function isAnswered(value: AnswerValue | undefined): boolean {
  if (!value) return false;
  if (value.kind === 'choice') return value.ids.length > 0;
  if (value.kind === 'text') return value.text.trim().length > 0;
  return Object.values(value.values).some((v) => String(v).trim().length > 0);
}

function choiceIds(value: AnswerValue | undefined): string[] {
  return value && value.kind === 'choice' ? value.ids : [];
}

function textValue(value: AnswerValue | undefined): string {
  return value && value.kind === 'text' ? value.text : '';
}

function structuredValues(value: AnswerValue | undefined): Record<string, string> {
  return value && value.kind === 'structured' ? value.values : {};
}

export default function TakeClient({
  attemptId,
  title,
  totalScore,
  questions,
  initialAnswers,
}: {
  attemptId: string;
  title: string;
  totalScore: number;
  questions: ClientQuestion[];
  initialAnswers: Record<string, AnswerValue>;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(initialAnswers || {});
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [submitting, setSubmitting] = useState(false);
  const timers = useRef<Record<string, number>>({});
  const latest = useRef(answers);

  useEffect(() => {
    latest.current = answers;
  }, [answers]);

  useEffect(() => {
    return () => {
      Object.values(timers.current).forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const groupIds = useMemo(
    () => new Set(questions.filter((q) => q.type === 'material_group').map((q) => q.externalId)),
    [questions]
  );

  const childrenByGroup = useMemo(() => {
    const map = new Map<string, ClientQuestion[]>();
    for (const q of questions) {
      if (!q.parentExternalId) continue;
      const list = map.get(q.parentExternalId) || [];
      list.push(q);
      map.set(q.parentExternalId, list);
    }
    return map;
  }, [questions]);

  const items = useMemo(() => {
    const list: { group?: ClientQuestion; question?: ClientQuestion }[] = [];
    for (const q of questions) {
      if (q.type === 'material_group') {
        list.push({ group: q });
      } else if (!q.parentExternalId || !groupIds.has(q.parentExternalId)) {
        list.push({ question: q });
      }
    }
    return list;
  }, [questions, groupIds]);

  const numberByQid = useMemo(() => {
    const map = new Map<string, number>();
    let n = 0;
    for (const item of items) {
      if (item.group) {
        for (const child of childrenByGroup.get(item.group.externalId) || []) {
          n += 1;
          map.set(child.externalId, n);
        }
      } else if (item.question) {
        n += 1;
        map.set(item.question.externalId, n);
      }
    }
    return { map, total: n };
  }, [items, childrenByGroup]);

  const answerable = useMemo(
    () => questions.filter((q) => q.type !== 'material_group'),
    [questions]
  );

  const answeredCount = useMemo(
    () => answerable.filter((q) => isAnswered(answers[q.externalId])).length,
    [answerable, answers]
  );

  function scheduleSave(qid: string, value: AnswerValue) {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
    latest.current = { ...latest.current, [qid]: value };
    setSaveState((prev) => ({ ...prev, [qid]: 'saving' }));
    if (timers.current[qid]) window.clearTimeout(timers.current[qid]);
    timers.current[qid] = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/attempts/${attemptId}/answer`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionExternalId: qid, value }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || '保存失败');
        }
        setSaveState((prev) => ({ ...prev, [qid]: 'saved' }));
      } catch {
        setSaveState((prev) => ({ ...prev, [qid]: 'error' }));
      }
    }, 600);
  }

  async function submit() {
    if (submitting) return;
    const unanswered = answerable.length - answeredCount;
    const message =
      '确认提交？' + (unanswered > 0 ? `\n还有 ${unanswered} 题未作答。` : '') + '\n提交后不能修改答案。';
    if (!window.confirm(message)) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/attempts/${attemptId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: latest.current }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '提交失败');
      router.push(`/results/${attemptId}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '提交失败');
      setSubmitting(false);
    }
  }

  function renderSaveState(qid: string) {
    const state = saveState[qid];
    if (!state) return null;
    if (state === 'saving') return <span className="text-xs text-slate-400">保存中…</span>;
    if (state === 'saved') return <span className="text-xs text-emerald-600">已保存</span>;
    return <span className="text-xs text-red-600">保存失败</span>;
  }

  function renderInput(q: ClientQuestion) {
    const value = answers[q.externalId];

    if (q.type === 'single_choice' || q.type === 'true_false') {
      const options = q.options.length
        ? q.options
        : [
            { id: '正确', html: '正确' },
            { id: '错误', html: '错误' },
          ];
      const selected = choiceIds(value);
      return (
        <div className="space-y-2">
          {options.map((opt) => (
            <label
              key={opt.id}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50"
            >
              <input
                type="radio"
                name={`q-${q.externalId}`}
                checked={selected[0] === opt.id}
                onChange={() => scheduleSave(q.externalId, { kind: 'choice', ids: [opt.id] })}
                className="mt-1"
              />
              <span className="flex-1">
                <span className="mr-1 font-medium text-slate-700">{opt.id}.</span>
                <span className="q-content inline" dangerouslySetInnerHTML={{ __html: opt.html }} />
              </span>
            </label>
          ))}
        </div>
      );
    }

    if (q.type === 'multiple_choice') {
      const selected = new Set(choiceIds(value));
      return (
        <div className="space-y-2">
          {q.options.map((opt) => (
            <label
              key={opt.id}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selected.has(opt.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(opt.id);
                  else next.delete(opt.id);
                  scheduleSave(q.externalId, { kind: 'choice', ids: Array.from(next).sort() });
                }}
                className="mt-1"
              />
              <span className="flex-1">
                <span className="mr-1 font-medium text-slate-700">{opt.id}.</span>
                <span className="q-content inline" dangerouslySetInnerHTML={{ __html: opt.html }} />
              </span>
            </label>
          ))}
        </div>
      );
    }

    if (q.type === 'structured_fill') {
      const values = structuredValues(value);
      return (
        <div className="space-y-2">
          {(q.structured?.rows || []).map((row, rowIndex) => (
            <div key={rowIndex} className="flex flex-wrap items-center gap-2">
              {row.map((cell, cellIndex) =>
                cell.type === 'text' ? (
                  <span key={cellIndex} className="text-sm text-slate-600">
                    {cell.text}
                  </span>
                ) : (
                  <input
                    key={cellIndex}
                    type="text"
                    value={values[cell.name] ?? ''}
                    onChange={(e) =>
                      scheduleSave(q.externalId, {
                        kind: 'structured',
                        values: { ...values, [cell.name]: e.target.value },
                      })
                    }
                    style={cell.width ? { width: cell.width } : undefined}
                    className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  />
                )
              )}
            </div>
          ))}
        </div>
      );
    }

    return (
      <textarea
        value={textValue(value)}
        onChange={(e) => scheduleSave(q.externalId, { kind: 'text', text: e.target.value })}
        rows={6}
        placeholder="请输入答案"
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
    );
  }

  function renderQuestionCard(q: ClientQuestion) {
    return (
      <div key={q.externalId} className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{numberByQid.map.get(q.externalId) || '-'}.</span>
          <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">{q.typeName || q.type}</span>
          <span>{q.maxScore} 分</span>
          <span className="ml-auto">{renderSaveState(q.externalId)}</span>
        </div>
        {q.stemHtml ? (
          <div className="q-content mb-3 text-sm text-slate-800" dangerouslySetInnerHTML={{ __html: q.stemHtml }} />
        ) : null}
        {q.attachments.length ? (
          <div className="mb-3 flex flex-wrap gap-3 text-xs">
            {q.attachments.map((att, i) =>
              att.url ? (
                <a key={i} href={att.url} className="text-blue-600 underline" target="_blank" rel="noreferrer">
                  附件：{att.originalName || att.filename}
                </a>
              ) : null
            )}
          </div>
        ) : null}
        {renderInput(q)}
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            共 {numberByQid.total} 题 · {totalScore} 分 · 已答 {answeredCount} 题
          </p>
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {submitting ? '提交中…' : '提交试卷'}
        </button>
      </div>

      <div className="space-y-4">
        {items.map((item) => {
          if (item.group) {
            const group = item.group;
            const children = childrenByGroup.get(group.externalId) || [];
            return (
              <div key={group.externalId} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="mb-2 text-xs text-slate-500">题目组</div>
                <div className="q-content text-sm text-slate-800" dangerouslySetInnerHTML={{ __html: group.stemHtml }} />
                <div className="mt-3 space-y-3">{children.map((child) => renderQuestionCard(child))}</div>
              </div>
            );
          }
          const q = item.question!;
          return <div key={q.externalId}>{renderQuestionCard(q)}</div>;
        })}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 text-sm">
          <span className="text-slate-500">
            已答 {answeredCount} / {numberByQid.total}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting ? '提交中…' : '提交试卷'}
          </button>
        </div>
      </div>
    </div>
  );
}
