import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const attempt = await prisma.attempt.findUnique({
    where: { id },
    include: {
      paper: { select: { id: true, title: true } },
      grades: true,
      tasks: { select: { questionExternalId: true, status: true, tries: true, lastError: true } },
    },
  });
  if (!attempt) return NextResponse.json({ error: '作答不存在' }, { status: 404 });

  return NextResponse.json({
    id: attempt.id,
    paperId: attempt.paperId,
    paperTitle: attempt.paper.title,
    status: attempt.status,
    totalScore: attempt.totalScore,
    maxScore: attempt.maxScore,
    submittedAt: attempt.submittedAt,
    tasks: attempt.tasks,
    grades: attempt.grades.map((g) => ({
      questionExternalId: g.questionExternalId,
      score: g.score,
      maxScore: g.maxScore,
      isCorrect: g.isCorrect,
      method: g.method,
      needsReview: g.needsReview,
      detail: g.detailJson ? JSON.parse(g.detailJson) : null,
    })),
  });
}
