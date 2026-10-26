import { NextResponse } from 'next/server';
import { runGradingOnce, countPendingGradingTasks } from '@/lib/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TASKS_PER_REQUEST = 100;
const DEFAULT_TIME_BUDGET_MS = 120000;

/**
 * 默认“排空”队列：循环领取任务直到没有待批或到达时间预算。
 * 这样用户不用反复点按钮，一次请求能把整卷批完。
 */
export async function POST(request: Request) {
  try {
    let drain = true;
    let timeBudgetMs = DEFAULT_TIME_BUDGET_MS;
    try {
      const body = await request.json();
      if (body && body.drain === false) drain = false;
      if (body && Number(body.timeBudgetMs) > 0) {
        timeBudgetMs = Math.min(Number(body.timeBudgetMs), 300000);
      }
    } catch {
      /* 使用默认值 */
    }

    const started = Date.now();
    let processed = 0;

    if (drain) {
      while (processed < MAX_TASKS_PER_REQUEST && Date.now() - started < timeBudgetMs) {
        const count = await runGradingOnce({ limit: 1 });
        if (count === 0) break;
        processed += count;
      }
    } else {
      processed = await runGradingOnce({ limit: 5 });
    }

    const remaining = await countPendingGradingTasks();
    return NextResponse.json({
      processed,
      remaining,
      timedOut: remaining > 0 && Date.now() - started >= timeBudgetMs,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '批改失败' },
      { status: 500 }
    );
  }
}
