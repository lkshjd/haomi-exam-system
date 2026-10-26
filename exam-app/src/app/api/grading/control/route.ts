import { NextResponse } from 'next/server';
import { isGradingPaused, setGradingPaused } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ paused: await isGradingPaused() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const paused = await setGradingPaused(Boolean(body?.paused));
    return NextResponse.json({ paused });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '设置失败' },
      { status: 400 }
    );
  }
}
