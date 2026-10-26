import { z } from 'zod';
import type { Pack } from './types';

const OptionSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  html: z.string().optional().default(''),
});

const AttachmentSchema = z.object({
  filename: z.string(),
  originalName: z.string().optional(),
  original_name: z.string().optional(),
  size: z.number().optional().default(0),
  mimeType: z.string().optional(),
  mime_type: z.string().optional(),
  localPath: z.string().optional(),
});

const QuestionSchema = z.object({
  sourceQuestionId: z.union([z.string(), z.number()]).transform(String),
  parentSourceId: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? null : String(v))),
  type: z.string(),
  typeName: z.string().optional().default(''),
  typeRaw: z.number().optional(),
  order: z.number().optional().default(0),
  stemHtml: z.string().optional().default(''),
  options: z.array(OptionSchema).optional().default([]),
  optionsRaw: z.unknown().optional(),
  answer: z.array(z.union([z.string(), z.number()])).optional().default([]).transform((a) => a.map(String)),
  answerRaw: z.string().optional().default(''),
  analysisHtml: z.string().optional().default(''),
  maxScore: z.number().optional().default(0),
  attachments: z.array(AttachmentSchema).optional().default([]),
  answerSource: z.string().optional(),
  missingAnswer: z.boolean().optional().default(false),
  missingAnalysis: z.boolean().optional().default(false),
});

const PaperSchema = z
  .object({
    // 标准协议字段
    sourcePaperId: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    // 采集器扩展字段（向后兼容）
    examId: z.union([z.string(), z.number()]).optional(),
    examName: z.string().optional(),
    publishRecordId: z.union([z.string(), z.number()]).optional(),
    courseModule: z.string().optional(),
    courseName: z.string().optional(),
    statusText: z.string().optional(),
    submitTime: z.string().optional(),
    sourceUrl: z.string().optional(),
    totalScore: z.union([z.number(), z.string()]).nullish(),
    questionCount: z.number().optional(),
    questions: z.array(QuestionSchema).min(1),
  })
  .refine((p) => p.sourcePaperId != null || p.examId != null, {
    message: '缺少 sourcePaperId 或 examId',
  })
  .refine((p) => Boolean(p.title || p.examName), {
    message: '缺少 title 或 examName',
  });

export const PackSchema = z.object({
  schemaVersion: z.string(),
  source: z.object({
    site: z.string().default('unknown'),
    origin: z.string().optional(),
    collectedAt: z.string().optional(),
    // 标准协议字段（单套卷时采集器会写入）
    examId: z.string().optional(),
    examName: z.string().optional(),
  }),
  papers: z.array(PaperSchema).min(1),
});

export type ParsedPack = z.infer<typeof PackSchema>;

export function parsePackJson(json: unknown): { ok: true; pack: ParsedPack } | { ok: false; errors: string[] } {
  const result = PackSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  return { ok: true, pack: result.data };
}

export function toPack(parsed: ParsedPack): Pack {
  return {
    schemaVersion: parsed.schemaVersion,
    source: parsed.source,
    papers: parsed.papers.map((p) => ({
      ...p,
      examId: String(p.sourcePaperId ?? p.examId ?? ''),
      examName: p.title || p.examName || '',
      sourcePaperId: String(p.sourcePaperId ?? p.examId ?? ''),
      title: p.title || p.examName || '',
      totalScore: p.totalScore == null ? null : Number(p.totalScore),
      publishRecordId: p.publishRecordId == null ? undefined : String(p.publishRecordId),
      questions: p.questions.map((q) => ({
        ...q,
        attachments: q.attachments.map((a) => ({
          filename: a.filename,
          originalName: a.originalName || a.original_name || a.filename,
          size: a.size,
          mimeType: a.mimeType || a.mime_type || '',
          localPath: a.localPath,
        })),
      })),
    })),
  };
}
