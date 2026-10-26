// 冒烟测试：导入后创建作答 → 自动保存 → 提交 → 批改 → 查看结果
// 用法：node --env-file=.env scripts/smoke.mjs
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const EXAM_ID = process.env.EXAM_ID || '173';

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error || ''}`);
  return data;
}

const paper = await prisma.paper.findFirst({
  where: { externalId: EXAM_ID },
  include: { questions: { orderBy: { order: 'asc' } } },
});
if (!paper) throw new Error('未找到试卷，请先导入题包');

const created = await api('/api/attempts', {
  method: 'POST',
  body: JSON.stringify({ paperId: paper.id }),
});
const attemptId = created.attemptId;
console.log('attempt:', attemptId, 'status:', created.status);

const resumed = await api('/api/attempts', {
  method: 'POST',
  body: JSON.stringify({ paperId: paper.id }),
});
console.log('resume returns same attempt:', resumed.attemptId === attemptId);

let counts = { structured: 0, text: 0, choice: 0, skipped: 0 };
for (const q of paper.questions) {
  if (q.type === 'material_group') {
    counts.skipped++;
    continue;
  }
  let value;
  if (q.type === 'structured_fill') {
    const answerArr = JSON.parse(q.answerJson || '[]');
    const obj = JSON.parse(q.answerRaw || answerArr[0] || '{}');
    value = { kind: 'structured', values: obj };
    counts.structured++;
  } else if (q.type === 'short_answer') {
    value = { kind: 'text', text: '冒烟测试作答：验证自动保存、提交与批改链路是否正常。' };
    counts.text++;
  } else {
    value = { kind: 'choice', ids: JSON.parse(q.answerJson || '[]') };
    counts.choice++;
  }
  await api(`/api/attempts/${attemptId}/answer`, {
    method: 'PUT',
    body: JSON.stringify({ questionExternalId: q.externalId, value }),
  });
}
console.log('answers saved:', counts);

const submitted = await api(`/api/attempts/${attemptId}/submit`, { method: 'POST', body: '{}' });
console.log('submit:', JSON.stringify(submitted));

const again = await api(`/api/attempts/${attemptId}/submit`, { method: 'POST', body: '{}' });
console.log('resubmit rejected:', again.alreadySubmitted === true);

let state = await api(`/api/attempts/${attemptId}`);
if (state.status === 'grading') {
  const run = await api('/api/grading/run', { method: 'POST', body: JSON.stringify({ limit: 30 }) });
  console.log('grading processed:', run.processed);
  state = await api(`/api/attempts/${attemptId}`);
}

const methods = state.grades.reduce((m, g) => {
  m[g.method] = (m[g.method] || 0) + 1;
  return m;
}, {});
console.log('final:', {
  status: state.status,
  score: state.totalScore,
  maxScore: state.maxScore,
  grades: state.grades.length,
  methods,
  pendingTasks: state.tasks.filter((t) => t.status !== 'done' && t.status !== 'failed').length,
  needsReview: state.grades.filter((g) => g.needsReview).length,
});
console.log('result page:', `${BASE}/results/${attemptId}`);

await prisma.$disconnect();
