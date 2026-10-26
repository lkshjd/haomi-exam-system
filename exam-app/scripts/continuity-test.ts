// 批改连续性验证：
// 1) 手动“排空”模式：一次请求批完整卷；
// 2) --worker 模式：不手动触发，等待 worker 自动批完；
// 同时检查工具事件日志与单题上下文截断记录。
// 用法：npx tsx --env-file=.env scripts/continuity-test.ts [--worker]
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = 'http://127.0.0.1:3000';
const useWorker = process.argv.includes('--worker');

async function api(path: string, body: unknown = {}, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error || ''}`);
  return data;
}

async function main() {
  const paper = await prisma.paper.findFirst({ where: { externalId: '173' }, include: { questions: true } });
  if (!paper) throw new Error('缺少测试试卷');

  const { attemptId } = await api('/api/attempts', { paperId: paper.id });
  const answerable = paper.questions.filter((q) => q.type !== 'material_group');
  for (const q of answerable) {
    await api(
      `/api/attempts/${attemptId}/answer`,
      { questionExternalId: q.externalId, value: { kind: 'text', text: '连续性测试作答' } },
      'PUT'
    );
  }
  await api(`/api/attempts/${attemptId}/submit`, {});

  let runResult: { processed: number; remaining: number; timedOut: boolean } | null = null;
  if (useWorker) {
    const started = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const state = await api(`/api/attempts/${attemptId}`, {}, 'GET');
      if (state.status === 'graded') break;
      if (Date.now() - started > 90000) throw new Error('等待 worker 批改超时');
    }
  } else {
    runResult = await api('/api/grading/run', { drain: true, timeBudgetMs: 60000 });
  }

  // 不用手动触发，等待 worker 自动批完
  const state = await api(`/api/attempts/${attemptId}`, {}, 'GET');
  const toolEvents = await prisma.eventLog.count({ where: { attemptId, type: 'grading_tool' } });
  const claims = await prisma.eventLog.count({ where: { attemptId, type: 'grading_claim' } });
  const contexts = state.grades
    .map((g: { detail?: { context?: { limitChars: number; usedChars: number; truncatedFields: string[] } } }) => g.detail?.context)
    .filter(Boolean);

  const truncated = contexts.filter((c: { truncatedFields: string[] }) => c.truncatedFields.length > 0);
  console.log({
    mode: useWorker ? 'worker-auto' : 'manual-drain',
    runResult,
    status: state.status,
    score: `${state.totalScore}/${state.maxScore}`,
    grades: state.grades.length,
    methods: state.grades.reduce(
      (m: Record<string, number>, g: { method: string }) => ({ ...m, [g.method]: (m[g.method] || 0) + 1 }),
      {}
    ),
    pendingTasks: state.tasks.filter((t: { status: string }) => t.status === 'pending' || t.status === 'running').length,
    toolEvents,
    claims,
    contextSamples: contexts.slice(0, 3),
    truncatedCount: truncated.length,
  });

  if (state.status !== 'graded') throw new Error('试卷未完成批改');
  if (!contexts.length) throw new Error('评分详情缺少上下文预算记录');
  if (!contexts.every((c: { limitChars: number }) => c.limitChars === 2000)) throw new Error('上下文预算未按设置生效');
  if (truncated.length === 0) throw new Error('预期至少有一题发生上下文截断');
  if (toolEvents < state.grades.length) throw new Error('工具事件日志少于评分数量');

  await prisma.attempt.delete({ where: { id: attemptId } });
  console.log('连续性验证通过，测试作答已清理');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
