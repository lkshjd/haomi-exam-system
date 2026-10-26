import { NextResponse } from 'next/server';
import { testAIConfiguration } from '@/lib/ai-grader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    return NextResponse.json(await testAIConfiguration());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '连接测试失败' },
      { status: 400 }
    );
  }
}
