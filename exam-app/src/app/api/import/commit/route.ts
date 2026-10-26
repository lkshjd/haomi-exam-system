import { NextResponse } from 'next/server';
import { commitImport } from '@/lib/importer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const batchId = String(body?.batchId || '');
    if (!batchId) return NextResponse.json({ error: '缺少 batchId' }, { status: 400 });
    const result = await commitImport(batchId);
    return NextResponse.json({ imported: result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '导入失败' },
      { status: 400 }
    );
  }
}
