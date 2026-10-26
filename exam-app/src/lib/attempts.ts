import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { GRADING_VERSION, buildSnapshot, gradeByRule, recomputeAttempt, attemptMaxScore } from './grading';
import { parseAnswerValue, type AnswerValue } from './types';

export async function createOrResumeAttempt(paperId: string) {
  const existing = await prisma.attempt.findFirst({
    where: { paperId, status: 'in_progress' },
    orderBy: { startedAt: 'desc' },
  });
  if (existing) return existing;

  const paper = await prisma.paper.findUnique({ where: { id: paperId }, include: { questions: true } });
  if (!paper) throw new Error('试卷不存在');

  return prisma.attempt.create({
    data: {
      paperId,
      status: 'in_progress',
      maxScore: attemptMaxScore(paper.questions),
    },
  });
}

export async function saveAnswer(attemptId: string, questionExternalId: string, value: AnswerValue) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new Error('作答不存在');
  if (attempt.status !== 'in_progress') throw new Error('试卷已提交，不能再修改答案');

  const answerJson = JSON.stringify(value);
  await prisma.answer.upsert({
    where: {
      attemptId_questionExternalId: { attemptId, questionExternalId },
    },
    update: { answerJson },
    create: { attemptId, questionExternalId, answerJson },
  });
}

export async function submitAttempt(attemptId: string, finalAnswers?: Record<string, AnswerValue>) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      paper: { include: { questions: true } },
      answers: true,
    },
  });
  if (!attempt) throw new Error('作答不存在');
  if (attempt.status !== 'in_progress') {
    return { alreadySubmitted: true as const, status: attempt.status };
  }

  const questions = [...attempt.paper.questions].sort((a, b) => a.order - b.order);
  const snapshot = buildSnapshot(attempt.paper, questions);

  const answerMap = new Map<string, string>();
  for (const a of attempt.answers) answerMap.set(a.questionExternalId, a.answerJson);
  if (finalAnswers) {
    for (const [qid, value] of Object.entries(finalAnswers)) {
      answerMap.set(qid, JSON.stringify(value));
    }
  }

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const subjectiveIds: string[] = [];
  let maxScore = 0;

  for (const q of snapshot.questions) {
    if (q.type === 'material_group') continue;
    maxScore += Number(q.maxScore) || 0;

    const value = parseAnswerValue(answerMap.get(q.externalId) || null);
    const ruleGrade = gradeByRule(q, value);

    if (ruleGrade) {
      const detailJson = JSON.stringify(ruleGrade.detail);
      ops.push(
        prisma.grade.upsert({
          where: {
            attemptId_questionExternalId_gradingVersion: {
              attemptId,
              questionExternalId: q.externalId,
              gradingVersion: GRADING_VERSION,
            },
          },
          update: {
            score: ruleGrade.score,
            maxScore: ruleGrade.maxScore,
            isCorrect: ruleGrade.isCorrect,
            method: ruleGrade.method,
            detailJson,
            needsReview: ruleGrade.needsReview,
          },
          create: {
            attemptId,
            questionExternalId: q.externalId,
            gradingVersion: GRADING_VERSION,
            score: ruleGrade.score,
            maxScore: ruleGrade.maxScore,
            isCorrect: ruleGrade.isCorrect,
            method: ruleGrade.method,
            detailJson,
            needsReview: ruleGrade.needsReview,
          },
        })
      );
    } else {
      subjectiveIds.push(q.externalId);
      ops.push(
        prisma.grade.upsert({
          where: {
            attemptId_questionExternalId_gradingVersion: {
              attemptId,
              questionExternalId: q.externalId,
              gradingVersion: GRADING_VERSION,
            },
          },
          update: {
            score: 0,
            maxScore: q.maxScore,
            isCorrect: null,
            method: 'pending',
            detailJson: JSON.stringify({ reason: '已排队，等待 AI 批改' }),
            needsReview: true,
          },
          create: {
            attemptId,
            questionExternalId: q.externalId,
            gradingVersion: GRADING_VERSION,
            score: 0,
            maxScore: q.maxScore,
            isCorrect: null,
            method: 'pending',
            detailJson: JSON.stringify({ reason: '已排队，等待 AI 批改' }),
            needsReview: true,
          },
        })
      );
    }
  }

  for (const qid of subjectiveIds) {
    ops.push(
      prisma.gradingTask.upsert({
        where: { attemptId_questionExternalId: { attemptId, questionExternalId: qid } },
        update: { status: 'pending', lastError: null, leaseUntil: null, workerId: null },
        create: { attemptId, questionExternalId: qid, status: 'pending' },
      })
    );
  }

  ops.push(
    prisma.attempt.update({
      where: { id: attemptId },
      data: {
        status: subjectiveIds.length ? 'grading' : 'graded',
        submittedAt: new Date(),
        snapshotJson: JSON.stringify(snapshot),
        maxScore: Math.round(maxScore * 100) / 100,
      },
    })
  );

  ops.push(
    prisma.eventLog.create({
      data: {
        attemptId,
        type: 'submitted',
        payloadJson: JSON.stringify({
          questions: snapshot.questions.length,
          subjective: subjectiveIds.length,
          gradingVersion: GRADING_VERSION,
        }),
      },
    })
  );

  await prisma.$transaction(ops);
  const summary = await recomputeAttempt(attemptId);
  return { alreadySubmitted: false as const, ...summary };
}
