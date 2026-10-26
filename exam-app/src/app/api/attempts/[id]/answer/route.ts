import { NextResponse } from 'next/server';
import { saveAnswer } from '@/lib/attempts';
import type { AnswerValue } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isAnswerValue(value: unknown): value is AnswerValue {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'choice') return Array.isArray(v.ids);
  if (v.kind === 'text') return typeof v.text === 'string';
  if (v.kind === 'structured') return Boolean(v.values) && typeof v.values === 'object';
  return false;
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const questionExternalId = String(body?.questionExternalId || '');
    if (!questionExternalId || !isAnswerValue(body?.value)) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 });
    }
    await saveAnswer(id, questionExternalId, body.value);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '保存失败' },
      { status: 400 }
    );
  }
}
