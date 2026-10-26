import { NextResponse } from 'next/server';
import { stageImport } from '@/lib/importer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_SIZE = 200 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '请选择题包文件（.zip 或 .json）' }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: '文件过大（上限 200MB）' }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const summary = await stageImport({ buffer, filename: file.name });
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '解析失败' },
      { status: 400 }
    );
  }
}
