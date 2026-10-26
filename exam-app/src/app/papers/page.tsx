import Link from 'next/link';
import { prisma } from '@/lib/db';
import StartButton from '@/components/StartButton';
import GradingControl from '@/components/GradingControl';

export const dynamic = 'force-dynamic';

const statusText: Record<string, string> = {
  in_progress: '答题中',
  grading: '批改中',
  graded: '已批改',
};

export default async function PapersPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>;
}) {
  const { module } = await searchParams;
  const moduleRows = await prisma.paper.findMany({
    select: { courseModule: true },
    distinct: ['courseModule'],
    orderBy: { courseModule: 'asc' },
  });
  const modules = moduleRows.map((r) => r.courseModule).filter((m): m is string => Boolean(m));

  const papers = await prisma.paper.findMany({
    where: module ? { courseModule: module } : {},
    orderBy: { importedAt: 'desc' },
    include: {
      attempts: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { id: true, status: true, totalScore: true, maxScore: true },
      },
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">试卷</h1>
          <p className="mt-1 text-sm text-slate-500">优先按网站原卷练习，答案与解析随题包保存。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form method="get" className="flex items-center gap-2">
            <select
              name="module"
              defaultValue={module || ''}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700"
            >
              <option value="">全部模块</option>
              {modules.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">
              筛选
            </button>
            {module ? (
              <Link href="/papers" className="text-xs text-slate-500 hover:underline">
                清除
              </Link>
            ) : null}
          </form>
          <GradingControl />
          <Link href="/import" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">
            导入题包
          </Link>
        </div>
      </div>

      {papers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-slate-600">还没有试卷</p>
          <p className="mt-1 text-sm text-slate-500">先到「导入题包」上传油猴导出的 JSON / ZIP。</p>
        </div>
      ) : (
        <div className="space-y-3">
          {papers.map((paper) => {
            const attempt = paper.attempts[0];
            return (
              <div key={paper.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">{paper.title}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {[paper.courseModule, paper.courseName].filter(Boolean).join(' · ')}
                      {' · '}
                      {paper.questionCount} 题 · {paper.totalScore} 分
                    </div>
                    {attempt ? (
                      <div className="mt-2 text-xs text-slate-500">
                        最近作答：{statusText[attempt.status] || attempt.status}
                        {attempt.status !== 'in_progress' && attempt.totalScore != null
                          ? ` · 得分 ${attempt.totalScore} / ${attempt.maxScore}`
                          : ''}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {attempt && attempt.status !== 'in_progress' ? (
                      <Link
                        href={`/results/${attempt.id}`}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        查看结果
                      </Link>
                    ) : null}
                    <StartButton
                      paperId={paper.id}
                      label={attempt && attempt.status === 'in_progress' ? '继续答题' : '开始答题'}
                    />
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
