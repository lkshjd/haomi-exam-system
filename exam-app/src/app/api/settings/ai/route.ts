import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPublicAIConfig, saveAISettings, clearAIKey } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const InputSchema = z.object({
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  maxSteps: z.number().optional(),
  timeoutMs: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  contextChars: z.number().optional(),
  clearKey: z.boolean().optional(),
});

function validBaseURL(value: string): boolean {
  if (!value) return true; // 允许清空
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function GET() {
  return NextResponse.json(await getPublicAIConfig());
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join('；') },
        { status: 400 }
      );
    }
    if (parsed.data.baseURL !== undefined && !validBaseURL(parsed.data.baseURL.trim())) {
      return NextResponse.json({ error: 'Base URL 必须是 http:// 或 https:// 地址' }, { status: 400 });
    }
    const config = await saveAISettings(parsed.data);
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '保存失败' },
      { status: 400 }
    );
  }
}

export async function DELETE() {
  try {
    return NextResponse.json(await clearAIKey());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '清除失败' },
      { status: 400 }
    );
  }
}
