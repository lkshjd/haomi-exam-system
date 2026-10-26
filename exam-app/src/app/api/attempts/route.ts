import { NextResponse } from 'next/server';
import { createOrResumeAttempt } from '@/lib/attempts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const paperId = String(body?.paperId || '');
    if (!paperId) return NextResponse.json({ error: '缺少 paperId' }, { status: 400 });
    const attempt = await createOrResumeAttempt(paperId);
    return NextResponse.json({ attemptId: attempt.id, status: attempt.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '创建作答失败' },
      { status: 400 }
    );
  }
}
