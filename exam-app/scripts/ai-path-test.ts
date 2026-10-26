// 验证真实 AI 批改链路（工具调用 → save_grade → 落库），使用本地假模型服务。
// 用法：先启动 scripts/fake-ai-server.mjs，再设置 AI_* 环境变量运行本脚本。
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
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error || ''}`);
  return data;
}

async function main() {
  const paper = await prisma.paper.findFirst({ where: { externalId: '173' }, include: { questions: true } });
  if (!paper) throw new Error('缺少测试试卷');

  const { attemptId } = await api('/api/attempts', { paperId: paper.id });
  const target = paper.questions.find((q) => q.type === 'short_answer');
  if (!target) throw new Error('缺少主观题');
  await api(
    `/api/attempts/${attemptId}/answer`,
    { questionExternalId: target.externalId, value: { kind: 'text', text: '测试工具调用批改' } },
    'PUT'
  );
  await api(`/api/attempts/${attemptId}/submit`, {});

  const processed = await runGradingOnce({ limit: 1 });
  const grade = await prisma.grade.findFirst({
    where: { attemptId, questionExternalId: target.externalId },
  });
  if (!grade) throw new Error('没有生成评分');
  const detail = grade.detailJson ? JSON.parse(grade.detailJson) : {};

  console.log({
    processed,
    method: grade.method,
    score: grade.score,
    maxScore: grade.maxScore,
    needsReview: grade.needsReview,
    promptVersion: detail.promptVersion,
    rubricSource: detail.rubricSource,
    steps: detail.steps,
    model: detail.model,
  });

  if (grade.method !== 'ai') throw new Error('预期走 AI 批改路径，实际为 ' + grade.method);
  if (!detail.steps || detail.steps < 2) throw new Error('预期至少两次工具步骤');
  if (detail.promptVersion !== 'v2-tools') throw new Error('提示词版本不符');

  await prisma.attempt.delete({ where: { id: attemptId } });
  console.log('AI 路径验证通过，测试作答已清理');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
