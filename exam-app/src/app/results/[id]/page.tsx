import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import AutoRefresh from '@/components/AutoRefresh';
import RunGradingButton from '@/components/RunGradingButton';
import { parseAnswerValue, type Snapshot, type SnapshotQuestion } from '@/lib/types';

export const dynamic = 'force-dynamic';

const methodLabel: Record<string, string> = {
  rule: '规则判分',
  ai: 'AI 批改',
  mock: '模拟评分',
  pending: '待批改',
  manual: '人工改分',
};

function formatAnswer(raw: string | null | undefined): string {
  const value = parseAnswerValue(raw);
  if (!value) return '（未作答）';
  if (value.kind === 'choice') return value.ids.length ? value.ids.join('、') : '（未作答）';
  if (value.kind === 'text') return value.text.trim() || '（未作答）';
  const entries = Object.entries(value.values).filter(([, v]) => String(v).trim() !== '');
  return entries.length ? entries.map(([k, v]) => `${k}：${v}`).join('；') : '（未作答）';
}

function formatReference(q: SnapshotQuestion): string {
  if (q.type === 'structured_fill') {
    try {
      const obj = JSON.parse(q.answerRaw || q.answer[0] || '{}');
      const entries = Object.entries(obj).filter(([, v]) => String(v).trim() !== '');
      return entries.map(([k, v]) => `${k}：${v}`).join('；');
    } catch {
      return q.answerRaw || '—';
    }
  }
  if (q.type === 'material_group') return '';
  return q.answer.length ? q.answer.join('、') : '（无参考答案）';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type GradeDetail = {
  expected?: string;
  got?: string;
  blanks?: { name: string; expected: string; got: string; correct: boolean; score: number; maxScore: number }[];
  hitPoints?: string[];
  missedPoints?: string[];
  deductions?: string[];
  advice?: string;
  reason?: string;
  reviewReason?: string;
  model?: string | null;
  mock?: boolean;
};

export default async function ResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const attempt = await prisma.attempt.findUnique({
    where: { id },
    include: { paper: true, grades: true, tasks: true, answers: true },
  });
  if (!attempt) notFound();
  if (attempt.status === 'in_progress') redirect(`/attempts/${attempt.id}`);

  let snapshot: Snapshot | null = null;
  try {
    snapshot = attempt.snapshotJson ? (JSON.parse(attempt.snapshotJson) as Snapshot) : null;
  } catch {
    snapshot = null;
  }
  const questions = snapshot?.questions || [];
  const gradeMap = new Map(attempt.grades.map((g) => [g.questionExternalId, g]));
  const answerMap = new Map(attempt.answers.map((a) => [a.questionExternalId, a.answerJson]));
  const pending = attempt.tasks.filter((t) => t.status === 'pending' || t.status === 'running').length;
  const needsReview = attempt.grades.filter((g) => g.needsReview).length;

  const groupIds = new Set(questions.filter((q) => q.type === 'material_group').map((q) => q.externalId));
  const numberMap = new Map<string, number>();
  let seq = 0;
  for (const q of questions) {
    if (q.type !== 'material_group') {
      seq += 1;
      numberMap.set(q.externalId, seq);
    }
  }
  const childrenByGroup = new Map<string, SnapshotQuestion[]>();
  for (const q of questions) {
    if (q.parentExternalId && groupIds.has(q.parentExternalId)) {
      const list = childrenByGroup.get(q.parentExternalId) || [];
      list.push(q);
      childrenByGroup.set(q.parentExternalId, list);
    }
  }

  function renderQuestion(q: SnapshotQuestion) {
    const grade = gradeMap.get(q.externalId);
    let detail: GradeDetail = {};
    try {
      detail = grade?.detailJson ? (JSON.parse(grade.detailJson) as GradeDetail) : {};
    } catch {
      detail = {};
    }
    const expected = formatReference(q);
    const got = formatAnswer(answerMap.get(q.externalId));

    return (
      <div key={q.externalId} className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{numberMap.get(q.externalId) || '-'}.</span>
          <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">{q.typeName || q.type}</span>
          {grade ? (
            <span
              className={
                grade.isCorrect === true
                  ? 'rounded bg-emerald-50 px-2 py-0.5 text-emerald-700'
                  : grade.isCorrect === false
                    ? 'rounded bg-red-50 px-2 py-0.5 text-red-700'
                    : 'rounded bg-amber-50 px-2 py-0.5 text-amber-700'
              }
            >
              {grade.score} / {grade.maxScore} 分
            </span>
          ) : (
            <span className="rounded bg-slate-100 px-2 py-0.5">未判分</span>
          )}
          {grade ? (
            <span className="rounded bg-slate-100 px-2 py-0.5">
              {methodLabel[grade.method] || grade.method}
              {grade.needsReview ? ' · 待复核' : ''}
            </span>
          ) : null}
        </div>

        {q.stemHtml ? (
          <div className="q-content mb-3 text-sm text-slate-800" dangerouslySetInnerHTML={{ __html: q.stemHtml }} />
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-md bg-slate-50 p-3">
            <div className="mb-1 text-xs font-medium text-slate-500">我的答案</div>
            <div className="whitespace-pre-wrap text-sm text-slate-800">{got}</div>
          </div>
          <div className="rounded-md bg-emerald-50/60 p-3">
            <div className="mb-1 text-xs font-medium text-emerald-700">参考答案</div>
            <div className="whitespace-pre-wrap text-sm text-slate-800">{expected || '—'}</div>
          </div>
        </div>

        {detail.blanks && detail.blanks.length ? (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-500">
                  <th className="border border-slate-200 px-2 py-1 text-left">空</th>
                  <th className="border border-slate-200 px-2 py-1 text-left">我的答案</th>
                  <th className="border border-slate-200 px-2 py-1 text-left">参考答案</th>
                  <th className="border border-slate-200 px-2 py-1 text-left">结果</th>
                </tr>
              </thead>
              <tbody>
                {detail.blanks.map((b, i) => (
                  <tr key={i}>
                    <td className="border border-slate-200 px-2 py-1">{b.name}</td>
                    <td className="border border-slate-200 px-2 py-1">{b.got || '—'}</td>
                    <td className="border border-slate-200 px-2 py-1">{b.expected}</td>
                    <td className={b.correct ? 'border border-slate-200 px-2 py-1 text-emerald-600' : 'border border-slate-200 px-2 py-1 text-red-600'}>
                      {b.correct ? '正确' : '错误'}（{b.score}/{b.maxScore}）
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {q.analysisHtml ? (
          <div className="mt-3 rounded-md border border-slate-200 p-3">
            <div className="mb-1 text-xs font-medium text-slate-500">解析</div>
            <div className="q-content text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: q.analysisHtml }} />
          </div>
        ) : null}

        {detail.hitPoints?.length || detail.missedPoints?.length || detail.deductions?.length || detail.advice ? (
          <div className="mt-3 space-y-1 text-xs text-slate-600">
            {detail.hitPoints?.length ? <div>命中：{detail.hitPoints.join('；')}</div> : null}
            {detail.missedPoints?.length ? <div>遗漏：{detail.missedPoints.join('；')}</div> : null}
            {detail.deductions?.length ? <div>扣分：{detail.deductions.join('；')}</div> : null}
            {detail.advice ? <div>建议：{detail.advice}</div> : null}
            {detail.reviewReason ? <div className="text-amber-600">复核原因：{detail.reviewReason}</div> : null}
          </div>
        ) : null}
      </div>
    );
  }

  const topLevel = questions.filter(
    (q) => q.type === 'material_group' || !q.parentExternalId || !groupIds.has(q.parentExternalId)
  );

  return (
    <div className="space-y-4">
      <AutoRefresh enabled={attempt.status === 'grading'} />

      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{attempt.paper.title}</h1>
            <p className="mt-1 text-sm text-slate-500">
              {attempt.status === 'grading' ? '批改中' : '已批改'}
              {attempt.submittedAt ? ` · 提交于 ${attempt.submittedAt.toLocaleString('zh-CN')}` : ''}
              {pending > 0 ? ` · 待批 ${pending} 题` : ''}
              {needsReview > 0 ? ` · 待复核 ${needsReview} 题` : ''}
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold text-blue-600">
              {attempt.totalScore ?? 0}
              <span className="ml-1 text-base font-normal text-slate-400">/ {attempt.maxScore}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">总分</div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <RunGradingButton />
          <Link href="/wrong" className="text-sm text-blue-600 hover:underline">
            查看错题本
          </Link>
          <Link href="/papers" className="text-sm text-slate-500 hover:underline">
            返回试卷列表
          </Link>
        </div>
      </div>

      <div className="space-y-4">
        {topLevel.map((q) => {
          if (q.type === 'material_group') {
            const children = childrenByGroup.get(q.externalId) || [];
            return (
              <div key={q.externalId} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="mb-2 text-xs text-slate-500">题目组</div>
                <div className="q-content text-sm text-slate-800" dangerouslySetInnerHTML={{ __html: q.stemHtml }} />
                <div className="mt-3 space-y-3">{children.map((child) => renderQuestion(child))}</div>
              </div>
            );
          }
          return renderQuestion(q);
        })}
      </div>

      <p className="pb-6 text-center text-xs text-slate-400">
        题包采集时间：{snapshot?.frozenAt ? new Date(snapshot.frozenAt).toLocaleString('zh-CN') : '—'}
      </p>
    </div>
  );
}
