import Link from 'next/link';
import { prisma } from '@/lib/db';
import StartButton from '@/components/StartButton';
import type { Snapshot, SnapshotQuestion } from '@/lib/types';

export const dynamic = 'force-dynamic';

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function WrongPage() {
  const grades = await prisma.grade.findMany({
    where: { attempt: { status: 'graded' } },
    include: {
      attempt: { include: { paper: { select: { id: true, title: true } } } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 400,
  });

  const seen = new Set<string>();
  const picked = grades.filter((g) => {
    if (g.maxScore <= 0) return false;
    if (g.isCorrect !== false) return false;
    if (g.method === 'pending') return false;
    const key = `${g.attempt.paperId}:${g.questionExternalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const attemptIds = Array.from(new Set(picked.map((g) => g.attemptId)));
  const attempts = await prisma.attempt.findMany({
    where: { id: { in: attemptIds } },
    select: { id: true, snapshotJson: true },
  });
  const questionMap = new Map<string, SnapshotQuestion>();
  for (const a of attempts) {
    if (!a.snapshotJson) continue;
    try {
      const snapshot = JSON.parse(a.snapshotJson) as Snapshot;
      for (const q of snapshot.questions) questionMap.set(`${a.id}:${q.externalId}`, q);
    } catch {
      /* 忽略损坏快照 */
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">错题本</h1>
        <p className="mt-1 text-sm text-slate-500">来自已批改试卷的错题，按题目去重展示最近一次结果。</p>
      </div>

      {picked.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
          还没有错题
        </div>
      ) : (
        <div className="space-y-3">
          {picked.slice(0, 60).map((g) => {
            const question = questionMap.get(`${g.attemptId}:${g.questionExternalId}`);
            const snippet = question ? stripHtml(question.stemHtml).slice(0, 140) : `题目 ${g.questionExternalId}`;
            return (
              <div key={g.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-800">{snippet || '（无题干）'}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {g.attempt.paper.title}
                      {question?.typeName ? ` · ${question.typeName}` : ''}
                      {` · 得分 ${g.score} / ${g.maxScore}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/results/${g.attemptId}`}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                    >
                      查看
                    </Link>
                    <StartButton paperId={g.attempt.paper.id} label="重做" variant="ghost" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
