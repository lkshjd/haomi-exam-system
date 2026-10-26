// 批改失败路径验证：模型不可达时应有限重试，最终标记待复核。
// 用法：$env:AI_BASE_URL='http://127.0.0.1:9'; npx tsx --env-file=.env scripts/timeout-test.ts
import { PrismaClient } from '@prisma/client';
import { runGradingOnce } from '../src/lib/worker';

const prisma = new PrismaClient();
const BASE = 'http://localhost:3000';

async function api(path: string, body: unknown, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${path} -> ${res.status} 非 JSON 响应：${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error || ''}`);
  if (!text) throw new Error(`${path} -> ${res.status} 响应为空`);
  return data;
}

async function main() {
  const paper = await prisma.paper.findFirst({ where: { externalId: '173' }, include: { questions: true } });
  if (!paper) throw new Error('缺少测试试卷');

  const { attemptId } = await api('/api/attempts', { paperId: paper.id });
  const target = paper.questions.find((q) => q.type === 'short_answer');
  if (!target) throw new Error('缺少主观题');
  await api(`/api/attempts/${attemptId}/answer`, {
    questionExternalId: target.externalId,
    value: { kind: 'text', text: '超时测试答案' },
  }, 'PUT');
  await api(`/api/attempts/${attemptId}/submit`, {});

  for (let i = 0; i < 3; i++) {
    const processed = await runGradingOnce({ limit: 1 });
    console.log('run', i + 1, 'processed', processed);
  }

  const tasks = await prisma.gradingTask.findMany({ where: { attemptId }, orderBy: { createdAt: 'asc' } });
  console.log(
    'tasks:',
    tasks.slice(0, 3).map((t) => ({ status: t.status, tries: t.tries, error: (t.lastError || '').slice(0, 50) }))
  );
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const pendingGrades = await prisma.grade.findMany({ where: { attemptId, method: 'pending' } });
  console.log(
    'failed tasks:',
    failed,
    'pending grades:',
    pendingGrades.length,
    'needsReview:',
    pendingGrades.filter((g) => g.needsReview).length
  );

  await prisma.attempt.delete({ where: { id: attemptId } });
  console.log('cleanup done');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
