import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  'a', 'p', 'br', 'span', 'div', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col',
  'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'blockquote', 'hr',
  'figure', 'figcaption', 'video', 'audio', 'source',
];

/** 清洗题包中的 HTML，避免脚本、事件属性与危险协议 */
export function sanitizeContent(html: string): string {
  if (!html) return '';
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': ['class', 'style', 'colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      a: ['href', 'target', 'rel'],
      video: ['src', 'controls', 'width', 'height'],
      audio: ['src', 'controls'],
      source: ['src', 'type'],
    },
    allowedSchemes: ['http', 'https', 'data'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
      }),
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });
}

/** 把题包里的 assets/... 改写到本地资源接口 */
export function rewriteAssetPaths(html: string, batchId: string): string {
  if (!html) return html;
  const prefix = `/api/assets/${batchId}/`;
  return html
    .replace(/((?:src|href)\s*=\s*["'])(assets\/)/gi, `$1${prefix}$2`)
    .replace(/(url\(\s*["']?)(assets\/)/gi, `$1${prefix}$2`);
}

/** 题包内附件的本地访问地址 */
export function attachmentUrl(batchId: string, localPath?: string): string {
  if (!localPath) return '';
  const clean = localPath.replace(/^\.?\//, '');
  return `/api/assets/${batchId}/${clean}`;
}
