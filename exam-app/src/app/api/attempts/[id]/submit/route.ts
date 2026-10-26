import { NextResponse } from 'next/server';
import { submitAttempt } from '@/lib/attempts';
import type { AnswerValue } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    let answers: Record<string, AnswerValue> | undefined;
    try {
      const body = await request.json();
      if (body && typeof body.answers === 'object' && body.answers) {
        answers = body.answers as Record<string, AnswerValue>;
      }
    } catch {
      answers = undefined;
    }
    const result = await submitAttempt(id, answers);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '提交失败' },
      { status: 400 }
    );
  }
}
