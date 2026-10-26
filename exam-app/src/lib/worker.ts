import { prisma } from './db';
import { GRADING_VERSION, recomputeAttempt } from './grading';
import { gradeWithAI } from './ai-grader';
import { isGradingPaused, getAIConfig } from './settings';
import { parseAnswerValue, answerText, type Snapshot } from './types';

const LEASE_MS = 5 * 60 * 1000;
const MAX_TRIES = 3;

function workerId(): string {
  return `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

async function processTask(task: { attemptId: string; questionExternalId: string }) {
  const attempt = await prisma.attempt.findUnique({ where: { id: task.attemptId } });
  if (!attempt || !attempt.snapshotJson) throw new Error('作答快照不存在');

  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(attempt.snapshotJson) as Snapshot;
  } catch {
    throw new Error('作答快照无法解析');
  }

  const question = snapshot.questions.find((q) => q.externalId === task.questionExternalId);
  if (!question) throw new Error('快照中找不到题目 ' + task.questionExternalId);

  const answer = await prisma.answer.findUnique({
    where: {
      attemptId_questionExternalId: {
        attemptId: task.attemptId,
        questionExternalId: task.questionExternalId,
      },
    },
  });
  const value = parseAnswerValue(answer?.answerJson || null);
  const studentAnswer = answerText(value);

  const parent = question.parentExternalId
    ? snapshot.questions.find((q) => q.externalId === question.parentExternalId)
    : undefined;

  const { grade, method, model, steps, promptVersion, rubricSource, limits, context } = await gradeWithAI({
    questionExternalId: question.externalId,
    stemHtml: question.stemHtml,
    studentAnswer,
    referenceAnswer: question.answerRaw || question.answer.join('\n'),
    analysisHtml: question.analysisHtml,
    sharedMaterialHtml: parent?.stemHtml,
    maxScore: question.maxScore,
    attachments: question.attachments,
    onToolEvent: (event) => {
      // Codex 式事件日志：只记录工具名、步数与长度，不落题目原文
      void prisma.eventLog
        .create({
          data: {
            attemptId: task.attemptId,
            type: 'grading_tool',
            payloadJson: JSON.stringify({
              questionExternalId: task.questionExternalId,
              ...event,
            }),
          },
        })
        .catch(() => undefined);
    },
  });

  const detail = {
    hitPoints: grade.hitPoints,
    missedPoints: grade.missedPoints,
    deductions: grade.deductions,
    advice: grade.advice,
    reviewReason: grade.reviewReason,
    model: model || null,
    mock: method === 'mock',
    promptVersion,
    gradingVersion: GRADING_VERSION,
    rubricSource,
    steps: steps ?? null,
    limits,
    context,
  };

  await prisma.grade.upsert({
    where: {
      attemptId_questionExternalId_gradingVersion: {
        attemptId: task.attemptId,
        questionExternalId: task.questionExternalId,
        gradingVersion: GRADING_VERSION,
      },
    },
    update: {
      score: grade.score,
      maxScore: question.maxScore,
      isCorrect: null,
      method,
      detailJson: JSON.stringify(detail),
      needsReview: grade.needsReview,
    },
    create: {
      attemptId: task.attemptId,
      questionExternalId: task.questionExternalId,
      gradingVersion: GRADING_VERSION,
      score: grade.score,
      maxScore: question.maxScore,
      isCorrect: null,
      method,
      detailJson: JSON.stringify(detail),
      needsReview: grade.needsReview,
    },
  });

  await prisma.eventLog.create({
    data: {
      attemptId: task.attemptId,
      type: 'graded',
      payloadJson: JSON.stringify({
        questionExternalId: task.questionExternalId,
        method,
        score: grade.score,
        maxScore: question.maxScore,
      }),
    },
  });
}

async function ensurePendingGrade(attemptId: string, questionExternalId: string, reason: string) {
  const existing = await prisma.grade.findUnique({
    where: {
      attemptId_questionExternalId_gradingVersion: {
        attemptId,
        questionExternalId,
        gradingVersion: GRADING_VERSION,
      },
    },
  });
  if (existing) {
    await prisma.grade.update({
      where: { id: existing.id },
      data: { needsReview: true, method: 'pending', detailJson: JSON.stringify({ reason }) },
    });
    return;
  }
  await prisma.grade.create({
    data: {
      attemptId,
      questionExternalId,
      gradingVersion: GRADING_VERSION,
      score: 0,
      maxScore: 0,
      method: 'pending',
      needsReview: true,
      detailJson: JSON.stringify({ reason }),
    },
  });
}

/** 处理一批待批任务；返回实际处理数量 */
export async function runGradingOnce(options: { limit?: number } = {}) {
  if (await isGradingPaused()) return 0;

  const limit = options.limit ?? 5;
  const wid = workerId();
  let processed = 0;

  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const task = await prisma.gradingTask.findFirst({
      where: {
        OR: [{ status: 'pending' }, { status: 'running', leaseUntil: { lt: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!task) break;

    const claimed = await prisma.gradingTask.updateMany({
      where: {
        id: task.id,
        OR: [{ status: 'pending' }, { status: 'running', leaseUntil: { lt: now } }],
      },
      data: {
        status: 'running',
        workerId: wid,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        tries: { increment: 1 },
      },
    });
    if (claimed.count === 0) continue;

    const fresh = await prisma.gradingTask.findUnique({ where: { id: task.id } });
    if (!fresh) continue;

    await prisma.eventLog.create({
      data: {
        attemptId: fresh.attemptId,
        type: 'grading_claim',
        payloadJson: JSON.stringify({
          questionExternalId: fresh.questionExternalId,
          workerId: wid,
          tries: fresh.tries,
        }),
      },
    });

    // 长任务续租：避免模型处理超过租约时长时被其它 worker 重复领取
    const heartbeat = setInterval(() => {
      void prisma.gradingTask
        .updateMany({
          where: { id: fresh.id, status: 'running' },
          data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
        })
        .catch(() => undefined);
    }, 60_000);

    try {
      await processTask({ attemptId: fresh.attemptId, questionExternalId: fresh.questionExternalId });
      await prisma.gradingTask.update({
        where: { id: fresh.id },
        data: { status: 'done', lastError: null, leaseUntil: null, workerId: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = fresh.tries >= MAX_TRIES;
      await prisma.gradingTask.update({
        where: { id: fresh.id },
        data: {
          status: failed ? 'failed' : 'pending',
          lastError: message.slice(0, 500),
          leaseUntil: null,
          workerId: null,
        },
      });
      if (failed) {
        await ensurePendingGrade(fresh.attemptId, fresh.questionExternalId, '批改失败，需人工复核：' + message);
      }
      await prisma.eventLog.create({
        data: {
          attemptId: fresh.attemptId,
          type: 'grading_error',
          payloadJson: JSON.stringify({ questionExternalId: fresh.questionExternalId, message: message.slice(0, 500), tries: fresh.tries }),
        },
      });
    } finally {
      clearInterval(heartbeat);
    }

    await recomputeAttempt(fresh.attemptId);
    processed++;
  }

  return processed;
}

export async function countPendingGradingTasks(): Promise<number> {
  return prisma.gradingTask.count({ where: { status: { in: ['pending', 'running'] } } });
}

async function markWorkerSeen(workerLabel: string) {
  const now = new Date().toISOString();
  await prisma.appSetting.upsert({
    where: { key: 'grading_worker_seen' },
    update: { value: now },
    create: { key: 'grading_worker_seen', value: now },
  });
  await prisma.appSetting.upsert({
    where: { key: 'grading_worker_id' },
    update: { value: workerLabel },
    create: { key: 'grading_worker_id', value: workerLabel },
  });
}

export async function startWorkerLoop() {
  const config = await getAIConfig();
  const label = workerId();
  console.log(
    `[grader] started id=${label}, source=${config.source}, model=${config.model || '(none)'}, ` +
      `maxSteps=${config.maxSteps}, timeout=${config.timeoutMs}ms, contextChars=${config.contextChars}`
  );
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    console.log('[grader] stopping…');
  });

  while (!stopping) {
    try {
      await markWorkerSeen(label);
      const count = await runGradingOnce({ limit: 3 });
      if (count === 0) await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error('[grader] loop error', err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await prisma.$disconnect();
}
