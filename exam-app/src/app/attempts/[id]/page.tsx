import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import TakeClient, { type ClientQuestion, type AnswerValue } from '@/components/TakeClient';

export const dynamic = 'force-dynamic';

export default async function TakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const attempt = await prisma.attempt.findUnique({
    where: { id },
    include: {
      paper: { include: { questions: { orderBy: { order: 'asc' } } } },
      answers: true,
    },
  });
  if (!attempt) notFound();
  if (attempt.status !== 'in_progress') redirect(`/results/${attempt.id}`);

  const questions: ClientQuestion[] = attempt.paper.questions.map((q) => ({
    externalId: q.externalId,
    parentExternalId: q.parentExternalId,
    type: q.type,
    typeName: q.typeName || '',
    order: q.order,
    stemHtml: q.stemHtml,
    options: JSON.parse(q.optionsJson || '[]'),
    structured: q.structuredJson ? JSON.parse(q.structuredJson) : null,
    maxScore: q.maxScore,
    attachments: JSON.parse(q.attachmentsJson || '[]'),
  }));

  const initialAnswers: Record<string, AnswerValue> = {};
  for (const a of attempt.answers) {
    try {
      initialAnswers[a.questionExternalId] = JSON.parse(a.answerJson);
    } catch {
      /* 忽略损坏的答案 */
    }
  }

  return (
    <TakeClient
      attemptId={attempt.id}
      title={attempt.paper.title}
      totalScore={attempt.paper.totalScore}
      questions={questions}
      initialAnswers={initialAnswers}
    />
  );
}
