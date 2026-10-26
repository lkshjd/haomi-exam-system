import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parsePackJson, toPack } from './pack-schema';
import { sanitizeContent, rewriteAssetPaths, attachmentUrl } from './html';
import { prisma } from './db';
import type { Pack, PackPaper } from './types';

export const STORAGE_ROOT = path.join(process.cwd(), 'storage', 'imports');

export type PaperSummary = {
  examId: string;
  title: string;
  courseModule?: string;
  questionCount: number;
  totalQuestions: number;
  missingAnswers: number;
  totalScore: number;
};

export type StageSummary = {
  batchId: string;
  site: string;
  papers: PaperSummary[];
  assets: { images: number; attachments: number };
  errors: string[];
  warnings: string[];
};

function safeRelPath(input: string): string {
  return input
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

function countAnswerable(questions: { type: string; missingAnswer?: boolean }[]) {
  const answerable = questions.filter((q) => q.type !== 'material_group');
  return {
    totalQuestions: questions.length,
    questionCount: answerable.length,
    missingAnswers: answerable.filter((q) => q.missingAnswer).length,
  };
}

/** 解析上传文件，写入 staging 目录并返回预览摘要（不落库） */
export async function stageImport(input: { buffer: Buffer; filename: string }): Promise<StageSummary> {
  const batchId = randomUUID();
  const batchDir = path.join(STORAGE_ROOT, batchId);
  await fs.mkdir(path.join(batchDir, 'assets'), { recursive: true });

  const errors: string[] = [];
  const warnings: string[] = [];
  const assets = { images: 0, attachments: 0 };
  let rawJson: unknown;

  if (/\.zip$/i.test(input.filename)) {
    let zip: AdmZip;
    try {
      zip = new AdmZip(input.buffer);
    } catch {
      throw new Error('ZIP 文件无法解析');
    }
    const entries = zip.getEntries();
    const packEntry =
      entries.find((e) => /(^|\/)pack\.json$/i.test(e.entryName)) ||
      entries.find((e) => e.entryName.toLowerCase().endsWith('.json') && !/manifest\.json$/i.test(e.entryName));
    if (!packEntry) throw new Error('ZIP 中没有找到 pack.json');
    try {
      rawJson = JSON.parse(packEntry.getData().toString('utf8'));
    } catch {
      throw new Error('pack.json 不是合法 JSON');
    }

    for (const entry of entries) {
      if (entry.isDirectory || !entry.entryName.startsWith('assets/')) continue;
      const rel = safeRelPath(entry.entryName.slice('assets/'.length));
      if (!rel) continue;
      const dest = path.join(batchDir, 'assets', rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, entry.getData());
      if (rel.startsWith('images/')) assets.images++;
      else if (rel.startsWith('attachments/')) assets.attachments++;
    }
  } else {
    try {
      rawJson = JSON.parse(input.buffer.toString('utf8'));
    } catch {
      throw new Error('JSON 文件无法解析');
    }
  }

  const parsed = parsePackJson(rawJson);
  if (!parsed.ok) throw new Error('题包结构校验失败：' + parsed.errors.join('；'));
  const pack = toPack(parsed.pack);

  const seen = new Map<string, Set<string>>();
  for (const paper of pack.papers) {
    const ids = new Set<string>();
    const key = `${paper.examId}#${paper.publishRecordId ?? 0}`;
    seen.set(key, ids);
    if (!paper.questions.length) errors.push(`《${paper.examName}》没有题目`);

    for (const q of paper.questions) {
      if (ids.has(q.sourceQuestionId)) warnings.push(`《${paper.examName}》题目 ${q.sourceQuestionId} 重复，已保留最后一条`);
      ids.add(q.sourceQuestionId);

      q.stemHtml = sanitizeContent(rewriteAssetPaths(q.stemHtml || '', batchId));
      q.analysisHtml = sanitizeContent(rewriteAssetPaths(q.analysisHtml || '', batchId));
      q.options = (q.options || []).map((o) => ({
        id: o.id,
        html: sanitizeContent(rewriteAssetPaths(o.html || '', batchId)),
      }));
      q.attachments = (q.attachments || []).map((a) => ({
        ...a,
        url: attachmentUrl(batchId, a.localPath),
      }));

      if (q.type !== 'material_group' && !(q.answer || []).length && !q.missingAnswer) {
        q.missingAnswer = true;
        warnings.push(`《${paper.examName}》题目 ${q.sourceQuestionId} 没有参考答案，已标记`);
      }
    }
  }

  await fs.writeFile(path.join(batchDir, 'pack.json'), JSON.stringify(pack), 'utf8');

  return {
    batchId,
    site: pack.source.site,
    papers: pack.papers.map((p) => {
      const counts = countAnswerable(p.questions);
      return {
        examId: p.examId,
        title: p.examName,
        courseModule: p.courseModule,
        ...counts,
        totalScore: Number(p.totalScore ?? p.questions.reduce((s, q) => s + (Number(q.maxScore) || 0), 0)),
      };
    }),
    assets,
    errors,
    warnings,
  };
}

function toQuestionRows(paper: PackPaper) {
  return paper.questions.map((q, index) => {
    const structured =
      q.type === 'structured_fill' &&
      q.optionsRaw &&
      typeof q.optionsRaw === 'object' &&
      !Array.isArray(q.optionsRaw) &&
      (q.optionsRaw as { mode?: string }).mode === 'structured'
        ? JSON.stringify(q.optionsRaw)
        : null;

    return {
      externalId: q.sourceQuestionId,
      parentExternalId: q.parentSourceId || null,
      type: q.type,
      typeName: q.typeName || '',
      order: q.order || index + 1,
      stemHtml: q.stemHtml || '',
      optionsJson: JSON.stringify(q.options || []),
      structuredJson: structured,
      answerJson: JSON.stringify(q.answer || []),
      answerRaw: q.answerRaw || (q.answer || []).join('\n'),
      analysisHtml: q.analysisHtml || '',
      maxScore: Number(q.maxScore) || 0,
      attachmentsJson: JSON.stringify(q.attachments || []),
      answerSource: q.answerSource || '',
      missingAnswer: !!q.missingAnswer,
      missingAnalysis: !!q.missingAnalysis,
    };
  });
}

/** 把 staging 中的题包写入数据库（重复导入按 site+examId+publishRecordId 覆盖） */
export async function commitImport(batchId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('导入批次无效');
  const raw = await fs.readFile(path.join(STORAGE_ROOT, batchId, 'pack.json'), 'utf8');
  const pack = JSON.parse(raw) as Pack;
  const results: { paperId: string; title: string; created: boolean }[] = [];

  for (const paper of pack.papers) {
    const publishRecordId = String(paper.publishRecordId ?? '0');
    const counts = countAnswerable(paper.questions);
    const totalScore = Number(
      paper.totalScore ?? paper.questions.reduce((s, q) => s + (Number(q.maxScore) || 0), 0)
    );

    const saved = await prisma.$transaction(async (tx) => {
      const existing = await tx.paper.findUnique({
        where: {
          site_externalId_publishRecordId: {
            site: pack.source.site,
            externalId: paper.examId,
            publishRecordId,
          },
        },
      });

      const data = {
        title: paper.examName,
        courseModule: paper.courseModule || '',
        courseName: paper.courseName || '',
        totalScore,
        questionCount: counts.questionCount,
        sourceStatus: paper.statusText || '',
        sourceUrl: paper.sourceUrl || '',
      };

      let paperId: string;
      if (existing) {
        paperId = existing.id;
        await tx.question.deleteMany({ where: { paperId } });
        await tx.paper.update({ where: { id: paperId }, data });
      } else {
        const created = await tx.paper.create({
          data: {
            ...data,
            site: pack.source.site,
            externalId: paper.examId,
            publishRecordId,
          },
        });
        paperId = created.id;
      }

      await tx.question.createMany({
        data: toQuestionRows(paper).map((row) => ({ ...row, paperId })),
      });
      return { paperId, title: paper.examName, created: !existing };
    });

    results.push(saved);
  }

  return results;
}
