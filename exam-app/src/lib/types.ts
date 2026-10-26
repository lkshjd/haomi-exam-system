export type PackOption = { id: string; html: string };

export type PackAttachment = {
  filename: string;
  originalName?: string;
  size?: number;
  mimeType?: string;
  localPath?: string;
  url?: string;
};

export type StructuredFieldRule = {
  score?: number;
  ignore_case?: boolean;
  ignore_space?: boolean;
  ignore_newline?: boolean;
  ignore_chars_enabled?: boolean;
  ignore_chars?: string[];
};

export type StructuredCell =
  | { type: 'text'; text: string }
  | { type: 'input'; name: string; width?: string };

export type StructuredOptions = {
  mode: 'structured';
  rows: StructuredCell[][];
  fields?: Record<string, StructuredFieldRule>;
  version?: number;
};

export type PackQuestion = {
  sourceQuestionId: string;
  parentSourceId?: string | null;
  type: string;
  typeName?: string;
  typeRaw?: number;
  order?: number;
  stemHtml?: string;
  options?: PackOption[];
  optionsRaw?: unknown;
  answer?: string[];
  answerRaw?: string;
  analysisHtml?: string;
  maxScore?: number;
  attachments?: PackAttachment[];
  answerSource?: string;
  missingAnswer?: boolean;
  missingAnalysis?: boolean;
};

export type PackPaper = {
  examId: string;
  sourcePaperId?: string;
  examName: string;
  title?: string;
  publishRecordId?: string | number;
  courseModule?: string;
  courseName?: string;
  statusText?: string;
  submitTime?: string;
  sourceUrl?: string;
  totalScore?: number | null;
  questionCount?: number;
  questions: PackQuestion[];
};

export type Pack = {
  schemaVersion: string;
  source: { site: string; origin?: string; collectedAt?: string; examId?: string; examName?: string };
  papers: PackPaper[];
};

export type AnswerValue =
  | { kind: 'choice'; ids: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'structured'; values: Record<string, string> };

export type SnapshotQuestion = {
  externalId: string;
  parentExternalId: string | null;
  type: string;
  typeName: string;
  order: number;
  stemHtml: string;
  options: PackOption[];
  structured: StructuredOptions | null;
  answer: string[];
  answerRaw: string;
  analysisHtml: string;
  maxScore: number;
  attachments: PackAttachment[];
};

export type Snapshot = {
  paper: { id: string; title: string; totalScore: number };
  questions: SnapshotQuestion[];
  gradingVersion: string;
  frozenAt: string;
};

export function parseAnswerValue(raw: string | null | undefined): AnswerValue | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    if (v.kind === 'choice' && Array.isArray(v.ids)) return { kind: 'choice', ids: v.ids.map(String) };
    if (v.kind === 'text') return { kind: 'text', text: String(v.text ?? '') };
    if (v.kind === 'structured' && v.values && typeof v.values === 'object') {
      return { kind: 'structured', values: v.values as Record<string, string> };
    }
    return null;
  } catch {
    return null;
  }
}

export function answerText(value: AnswerValue | null): string {
  if (!value) return '';
  if (value.kind === 'text') return value.text;
  if (value.kind === 'choice') return value.ids.join(', ');
  return Object.entries(value.values)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

export function isEmptyAnswer(value: AnswerValue | null): boolean {
  if (!value) return true;
  if (value.kind === 'choice') return value.ids.length === 0;
  if (value.kind === 'text') return value.text.trim().length === 0;
  return Object.values(value.values).every((v) => !String(v).trim());
}
