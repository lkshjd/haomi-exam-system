import type { Question, Paper, Attempt } from '@prisma/client';
import { prisma } from './db';
import type {
  AnswerValue,
  Snapshot,
  SnapshotQuestion,
  StructuredFieldRule,
  StructuredOptions,
} from './types';

export const GRADING_VERSION = 'v1';

export type RuleGrade = {
  score: number;
  maxScore: number;
  isCorrect: boolean | null;
  method: 'rule' | 'pending';
  detail: Record<string, unknown>;
  needsReview: boolean;
};

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toSnapshotQuestion(q: Question): SnapshotQuestion {
  return {
    externalId: q.externalId,
    parentExternalId: q.parentExternalId,
    type: q.type,
    typeName: q.typeName || '',
    order: q.order,
    stemHtml: q.stemHtml,
    options: safeJson(q.optionsJson, []),
    structured: safeJson<StructuredOptions | null>(q.structuredJson, null),
    answer: safeJson<string[]>(q.answerJson, []),
    answerRaw: q.answerRaw || '',
    analysisHtml: q.analysisHtml,
    maxScore: q.maxScore,
    attachments: safeJson(q.attachmentsJson, []),
  };
}

export function buildSnapshot(paper: Paper, questions: Question[]): Snapshot {
  return {
    paper: { id: paper.id, title: paper.title, totalScore: paper.totalScore },
    questions: questions.map(toSnapshotQuestion).sort((a, b) => a.order - b.order),
    gradingVersion: GRADING_VERSION,
    frozenAt: new Date().toISOString(),
  };
}

function normalizeText(value: string): string {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeBlank(value: string, rule: StructuredFieldRule): string {
  let s = String(value ?? '');
  if (rule.ignore_space) s = s.replace(/[ \t\u3000]+/g, '');
  if (rule.ignore_newline) s = s.replace(/\r?\n/g, '');
  if (!rule.ignore_space && !rule.ignore_newline) s = s.trim();
  if (rule.ignore_chars_enabled && Array.isArray(rule.ignore_chars)) {
    for (const ch of rule.ignore_chars) {
      if (ch) s = s.split(ch).join('');
    }
  }
  if (rule.ignore_case) s = s.toLowerCase();
  return s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 客观题与结构化填空判分；返回 null 表示需要 AI 批改 */
export function gradeByRule(q: SnapshotQuestion, value: AnswerValue | null): RuleGrade | null {
  if (q.type === 'material_group') return null;

  const reference = (q.answer || []).map((a) => String(a)).filter((a) => a.trim() !== '');
  if (!reference.length) {
    return {
      score: 0,
      maxScore: q.maxScore,
      isCorrect: null,
      method: 'rule',
      detail: { reason: '缺少参考答案，需人工复核' },
      needsReview: true,
    };
  }

  if (q.type === 'single_choice' || q.type === 'true_false') {
    const expected = String(q.answer[0] ?? '').trim();
    const got =
      value?.kind === 'choice'
        ? String(value.ids[0] ?? '').trim()
        : value?.kind === 'text'
          ? value.text.trim()
          : '';
    const correct = expected !== '' && got === expected;
    return {
      score: correct ? q.maxScore : 0,
      maxScore: q.maxScore,
      isCorrect: correct,
      method: 'rule',
      detail: { expected, got, policy: 'exact' },
      needsReview: false,
    };
  }

  if (q.type === 'multiple_choice') {
    const expected = q.answer.map((s) => String(s).trim()).filter(Boolean).sort();
    const gotRaw =
      value?.kind === 'choice'
        ? value.ids
        : value?.kind === 'text'
          ? value.text.split(/[,，、\s]+/)
          : [];
    const got = gotRaw.map((s) => String(s).trim()).filter(Boolean).sort();
    const correct =
      expected.length > 0 && expected.length === got.length && expected.every((v, i) => v === got[i]);
    return {
      score: correct ? q.maxScore : 0,
      maxScore: q.maxScore,
      isCorrect: correct,
      method: 'rule',
      detail: { expected, got, policy: 'all_or_nothing' },
      needsReview: false,
    };
  }

  if (q.type === 'fill_blank') {
    const expected = normalizeText(q.answer.join(' | '));
    const got = normalizeText(
      value?.kind === 'text' ? value.text : value?.kind === 'choice' ? value.ids.join('|') : ''
    );
    const correct = expected !== '' && expected === got;
    return {
      score: correct ? q.maxScore : 0,
      maxScore: q.maxScore,
      isCorrect: correct,
      method: 'rule',
      detail: { expected: q.answer.join(' | '), got, policy: 'normalized_text' },
      needsReview: false,
    };
  }

  if (q.type === 'structured_fill') {
    const expectedObj = safeJson<Record<string, unknown>>(q.answerRaw || q.answer[0] || '', {});
    const names = Object.keys(expectedObj);
    if (!names.length) {
      return {
        score: 0,
        maxScore: q.maxScore,
        isCorrect: null,
        method: 'rule',
        detail: { reason: '结构化答案缺失，需人工复核' },
        needsReview: true,
      };
    }

    const values = value?.kind === 'structured' ? value.values : {};
    const fields = q.structured?.fields || {};
    const blanks: {
      name: string;
      expected: string;
      got: string;
      correct: boolean;
      score: number;
      maxScore: number;
    }[] = [];

    let score = 0;
    let maxScore = 0;
    for (const name of names) {
      const rule = fields[name] || {};
      const blankMax = Number(rule.score ?? q.maxScore / names.length) || 0;
      const expected = String(expectedObj[name] ?? '');
      const got = String(values[name] ?? '');
      const correct = normalizeBlank(expected, rule) !== '' && normalizeBlank(expected, rule) === normalizeBlank(got, rule);
      blanks.push({ name, expected, got, correct, score: correct ? blankMax : 0, maxScore: blankMax });
      score += correct ? blankMax : 0;
      maxScore += blankMax;
    }

    if (!maxScore) maxScore = q.maxScore;
    return {
      score: round2(score),
      maxScore: round2(maxScore),
      isCorrect: Math.abs(score - maxScore) < 1e-6,
      method: 'rule',
      detail: { blanks },
      needsReview: false,
    };
  }

  return null;
}

export async function recomputeAttempt(attemptId: string) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: { grades: true, tasks: true },
  });
  if (!attempt) throw new Error('作答不存在');

  const totalScore = attempt.grades.reduce((s, g) => s + g.score, 0);
  const pending = attempt.tasks.filter((t) => t.status === 'pending' || t.status === 'running').length;
  const failed = attempt.tasks.filter((t) => t.status === 'failed').length;
  const status = pending > 0 ? 'grading' : 'graded';

  await prisma.attempt.update({
    where: { id: attemptId },
    data: { totalScore: round2(totalScore), status },
  });
  return { totalScore: round2(totalScore), pending, failed, status };
}

export function attemptMaxScore(questions: Question[]): number {
  return round2(
    questions.filter((q) => q.type !== 'material_group').reduce((s, q) => s + (Number(q.maxScore) || 0), 0)
  );
}

export type AttemptWithData = Attempt & { paper: Paper; questions: Question[] };
