import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listAIModels } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const InputSchema = z.object({
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: '参数不正确' }, { status: 400 });
    }
    const models = await listAIModels(parsed.data);
    return NextResponse.json({ models });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '获取模型列表失败' },
      { status: 400 }
    );
  }
}
