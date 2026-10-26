// ==UserScript==
// @name         豪密考试平台题包采集器
// @namespace    local.haomi.exam.collector
// @version      0.1.0
// @description  从豪密密码实验平台「考试平台」采集试卷、参考答案与解析，导出标准题包 JSON / ZIP
// @author       local
// @match        https://mofang.haomitech.cn/*
// @match        https://103.90.176.202/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 通用工具
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = 'haomi_exam_pack_v1';
  const PAPER_KEY_PREFIX = 'haomi_paper_v1_';
  const SAVED_IDS_KEY = 'haomi_saved_paper_ids';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sanitizeFileName(name) {
    return String(name || 'pack').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  // ---------------------------------------------------------------------------
  // 站点适配器：豪密考试平台
  // ---------------------------------------------------------------------------

  const API_BASE = '/exam-platform/api';

  const adapter = {
    id: 'haomi-exam-platform',
    name: '豪密考试平台',

    detect() {
      return location.pathname.indexOf('/exam-platform') === 0;
    },

    // 文档 3.1 的 SiteAdapter 接口（具体实现见下方同名函数）
    listExams() {
      return listExams();
    },
    listPapers(exam) {
      return Promise.resolve([exam]);
    },
    readQuestions(exam) {
      return fetchPreview(exam);
    },

    // 令牌由主平台跳转时带入，随后持久化在 localStorage
    getToken() {
      for (const key of ['exam_student_user', 'user']) {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const obj = JSON.parse(raw);
          if (obj && obj.token) return obj.token;
        } catch (e) { /* 忽略解析失败 */ }
      }
      return '';
    },
  };

  function requireToken() {
    const token = adapter.getToken();
    if (!token) throw new Error('未检测到考试平台登录状态，请重新登录后再试');
    return token;
  }

  async function apiGet(path, params, retries) {
    const url = new URL(API_BASE + path, location.origin);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      url.searchParams.set(k, String(v));
    });

    const max = retries == null ? 2 : retries;
    let lastErr;
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          headers: { Authorization: requireToken() },
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.status === 401 || res.status === 403) {
          throw new Error('登录状态已失效，请重新登录');
        }
        if (!res.ok) throw new Error('接口 HTTP ' + res.status + '：' + path);
        const json = await res.json();
        if (json && json.code !== 0) {
          throw new Error('接口返回错误 code=' + json.code + '：' + (json.msg || path));
        }
        return json ? json.data : null;
      } catch (err) {
        lastErr = err;
        if (attempt < max) await sleep(600 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  async function fetchBinary(path, withAuth) {
    const url = /^https?:\/\//i.test(path) ? path : location.origin + path;
    const headers = withAuth ? { Authorization: requireToken() } : {};
    const res = await fetch(url, { headers, credentials: 'same-origin' });
    if (!res.ok) throw new Error('文件下载失败 HTTP ' + res.status + '：' + path);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---------------------------------------------------------------------------
  // 数据读取
  // ---------------------------------------------------------------------------

  /** 考试（测验）列表：一条即一套卷 */
  async function listExams() {
    const data = await apiGet('/student/exams');
    return Array.isArray(data) ? data : [];
  }

  /** 试卷题目（预览接口，部分考试同时返回答案与解析） */
  async function fetchPreview(exam) {
    return apiGet('/student/exam/preview', {
      bank_id: exam.id,
      publish_record_id: exam.publish_record_id || 0,
    });
  }

  /** 全部答题记录（用于补齐答案，分页读取） */
  async function listAllResults(progress) {
    const out = [];
    let page = 1;
    for (;;) {
      const data = await apiGet('/student/results', { page, page_size: 50 });
      const list = (data && data.list) || [];
      out.push(...list);
      if (progress) progress('读取答题记录 ' + out.length + '/' + ((data && data.total) || out.length));
      if (!data || !data.total || out.length >= data.total || list.length === 0) break;
      page++;
    }
    return out;
  }

  /** 同题库的答题明细：question_id -> 参考答案/解析/附件 */
  async function loadResultAnswers(bankId, records, progress) {
    const map = new Map();
    const related = records
      .filter((r) => Number(r.bank_id) === Number(bankId))
      .sort((a, b) => String(b.submit_time || '').localeCompare(String(a.submit_time || '')))
      .slice(0, 3); // 只取最近 3 次，避免无意义的重复请求

    for (const rec of related) {
      const detail = await apiGet('/student/results/' + rec.id);
      for (const item of (detail && detail.answers) || []) {
        if (!item || !item.question_id) continue;
        const prev = map.get(item.question_id);
        const entry = {
          answer: item.correct_answer || '',
          analysis: item.analysis || item.user_analysis || '',
          attachments: item.attachments || [],
          source: 'answer_record',
        };
        if (!prev) {
          map.set(item.question_id, entry);
        } else {
          if (!prev.answer && entry.answer) prev.answer = entry.answer;
          if (!prev.analysis && entry.analysis) prev.analysis = entry.analysis;
          if ((!prev.attachments || !prev.attachments.length) && entry.attachments && entry.attachments.length) {
            prev.attachments = entry.attachments;
          }
        }
      }
      if (progress) progress('读取答题明细（记录 ' + rec.id + '）');
    }
    return map;
  }

  /** 错题本：question_id -> 答案/解析（兜底来源） */
  async function loadErrorBook(progress) {
    const map = new Map();
    let page = 1;
    let got = 0;
    for (;;) {
      const data = await apiGet('/student/error-book', { page, page_size: 100 });
      const list = (data && data.list) || [];
      for (const item of list) {
        const q = item.question || {};
        const qid = item.question_id || (q && q.id);
        if (!qid) continue;
        if (!map.has(qid)) {
          map.set(qid, {
            answer: q.answer || '',
            analysis: q.analysis || item.user_analysis || '',
            attachments: q.attachments || [],
            source: 'error_book',
          });
        }
      }
      got += list.length;
      if (progress) progress('读取错题本 ' + got + '/' + ((data && data.total) || got));
      if (!data || !data.total || got >= data.total || list.length === 0) break;
      page++;
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // 题目归一化
  // ---------------------------------------------------------------------------

  function parseJsonMaybe(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (e) { return value; }
  }

  function isStructuredOptions(options) {
    const opts = parseJsonMaybe(options);
    return !!opts && typeof opts === 'object' && !Array.isArray(opts) && opts.mode === 'structured';
  }

  const TYPE_MAP = {
    0: 'material_group',
    1: 'single_choice',
    2: 'multiple_choice',
    3: 'true_false',
    4: 'fill_blank',
    5: 'short_answer',
  };

  function mapType(rawType, structured) {
    if (Number(rawType) === 5 && structured) return 'structured_fill';
    return TYPE_MAP[Number(rawType)] || 'unknown';
  }

  function normalizeOptions(options) {
    const opts = parseJsonMaybe(options);
    if (!Array.isArray(opts)) return [];
    return opts.map((opt, i) => {
      if (opt && typeof opt === 'object') {
        const id = opt.label != null ? opt.label : (opt.id != null ? opt.id : String.fromCharCode(65 + i));
        const html = opt.content != null ? opt.content : (opt.html != null ? opt.html : (opt.text || ''));
        return { id: String(id), html: String(html) };
      }
      return { id: String.fromCharCode(65 + i), html: String(opt == null ? '' : opt) };
    });
  }

  function normalizeAnswer(rawAnswer, type) {
    if (rawAnswer == null || rawAnswer === '') return [];
    const text = String(rawAnswer);
    if (type === 'multiple_choice') {
      return text.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    }
    if (type === 'single_choice' || type === 'true_false') return [text.trim()];
    return [text];
  }

  function normalizeQuestion(q, previewAnswer, resultAnswer, errorAnswer) {
    const structured = isStructuredOptions(q.options);
    const type = mapType(q.type, structured);
    const options = parseJsonMaybe(q.options);

    let answerRaw = '';
    let analysisHtml = '';
    let answerSource = 'none';
    const attachments = [];

    const pushAttachments = (list) => {
      for (const att of list || []) {
        if (!att || !att.filename) continue;
        if (attachments.some((x) => x.filename === att.filename)) continue;
        attachments.push({
          filename: att.filename,
          originalName: att.original_name || att.filename,
          size: att.size || 0,
          mimeType: att.mime_type || '',
        });
      }
    };

    if (previewAnswer && (previewAnswer.answer || previewAnswer.analysis)) {
      answerRaw = previewAnswer.answer || '';
      analysisHtml = previewAnswer.analysis || '';
      if (answerRaw) answerSource = 'preview';
    }
    if (!answerRaw && resultAnswer && resultAnswer.answer) {
      answerRaw = resultAnswer.answer;
      answerSource = 'answer_record';
    }
    if (!analysisHtml && resultAnswer && resultAnswer.analysis) analysisHtml = resultAnswer.analysis;
    if (!answerRaw && errorAnswer && errorAnswer.answer) {
      answerRaw = errorAnswer.answer;
      answerSource = 'error_book';
    }
    if (!analysisHtml && errorAnswer && errorAnswer.analysis) analysisHtml = errorAnswer.analysis;
    if (!answerRaw && q.answer) {
      answerRaw = q.answer;
      answerSource = 'question_inline';
    }
    if (!analysisHtml && q.analysis) analysisHtml = q.analysis;

    pushAttachments(q.attachments);
    if (resultAnswer) pushAttachments(resultAnswer.attachments);
    if (errorAnswer) pushAttachments(errorAnswer.attachments);

    return {
      sourceQuestionId: String(q.id),
      parentSourceId: q.parent_id ? String(q.parent_id) : null,
      type,
      typeName: q.type_name || '',
      typeRaw: Number(q.type),
      order: Number(q.sort_order) || 0,
      stemHtml: q.content || '',
      options: structured ? [] : options,
      optionsRaw: structured ? options : undefined,
      answer: normalizeAnswer(answerRaw, type),
      answerRaw: answerRaw,
      analysisHtml: analysisHtml,
      maxScore: Number(q.score) || 0,
      attachments,
      answerSource,
      missingAnswer: !answerRaw,
      missingAnalysis: !analysisHtml,
    };
  }

  // ---------------------------------------------------------------------------
  // 采集主流程
  // ---------------------------------------------------------------------------

  async function collectExam(exam, ctx, progress) {
    progress('读取《' + exam.name + '》题目…');
    const preview = await fetchPreview(exam);
    const questions = (preview && preview.questions) || [];
    const previewAnswers = (preview && preview.answers) || {};
    const resultAnswers = await loadResultAnswers(exam.id, ctx.results, progress);

    const normalized = questions.map((q) => {
      const qid = q.id;
      return normalizeQuestion(
        q,
        previewAnswers[qid] || previewAnswers[String(qid)],
        resultAnswers.get(qid),
        ctx.errorBook.get(qid)
      );
    });

    // 保持服务端返回顺序（与页面显示一致），并以此作为题序
    normalized.forEach((q, i) => { q.order = i + 1; });

    const answered = normalized.filter((q) => q.type !== 'material_group');
    const missing = answered.filter((q) => q.missingAnswer);

    return {
      examId: String(exam.id),
      sourcePaperId: String(exam.id),
      examName: exam.name || '',
      title: exam.name || '',
      publishRecordId: exam.publish_record_id || 0,
      courseModule: exam.course_module || '',
      courseName: exam.course_name || '',
      statusText: exam.status_text || '',
      sourceUrl: location.origin + '/exam-platform/student/exams',
      startTime: exam.start_time || '',
      endTime: exam.end_time || '',
      totalScore: exam.total_score != null ? exam.total_score : null,
      // 平台口径的“题目数”不含题目组，这里与平台保持一致
      questionCount: answered.length,
      rawQuestionCount: questions.length,
      answerCoverage: {
        total: answered.length,
        answered: answered.length - missing.length,
        missing: missing.length,
      },
      questions: normalized,
    };
  }

  /** 已考卷：直接从答题记录详情取题目 + 参考答案 + 解析 */
  async function collectRecord(record, progress) {
    progress('读取《' + (record.bank_name || record.id) + '》答题明细…');
    const detail = await apiGet('/student/results/' + record.id);
    const answers = (detail && detail.answers) || [];

    const normalized = answers.map((a) => {
      const q = {
        id: a.question_id,
        type: a.question_type,
        type_name: a.question_type_name,
        content: a.question_content,
        options: a.options,
        answer: '',
        analysis: '',
        score: a.question_score,
        sort_order: a.sort_order,
        parent_id: a.parent_id,
        attachments: a.attachments,
      };
      const resultAnswer = {
        answer: a.correct_answer || '',
        analysis: a.analysis || a.user_analysis || '',
        attachments: a.attachments || [],
      };
      return normalizeQuestion(q, null, resultAnswer, null);
    });

    normalized.forEach((q, i) => { q.order = i + 1; });

    const answered = normalized.filter((q) => q.type !== 'material_group');
    const missing = answered.filter((q) => q.missingAnswer);

    return {
      examId: String(record.bank_id),
      sourcePaperId: String(record.bank_id),
      examName: record.bank_name || '',
      title: record.bank_name || '',
      publishRecordId: record.publish_record_id || 0,
      recordId: record.id,
      courseModule: record.course_module || '',
      courseName: record.course_name || '',
      statusText: record.status_name || '',
      sourceUrl: location.origin + '/exam-platform/student/results',
      submitTime: record.submit_time || '',
      totalScore: record.total_score_full != null
        ? record.total_score_full
        : (record.total_score != null ? record.total_score : null),
      questionCount: answered.length,
      rawQuestionCount: answers.length,
      answerCoverage: {
        total: answered.length,
        answered: answered.length - missing.length,
        missing: missing.length,
      },
      questions: normalized,
    };
  }

  function buildPack(papers) {
    const source = {
      site: adapter.id,
      origin: location.origin,
      appVersion: 'exam-platform',
      collectedAt: new Date().toISOString(),
    };
    // 单套卷时同时写入标准协议里的 source.examId / examName
    if (papers.length === 1) {
      source.examId = papers[0].examId;
      source.examName = papers[0].examName;
    }
    return {
      schemaVersion: '1.0',
      source,
      papers,
    };
  }

  // ---------------------------------------------------------------------------
  // 资源打包（图片 / 附件）与 ZIP（store 模式，无第三方依赖）
  // ---------------------------------------------------------------------------

  const IMAGE_URL_RE = /src\s*=\s*["'](\/exam-platform\/(?:api\/)?[^"']+?\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?[^"']*)?)["']/gi;
  const CSS_IMAGE_RE = /url\(\s*["']?(\/exam-platform\/(?:api\/)?[^"')]+?\.(?:png|jpe?g|gif|webp|svg|bmp))["']?\s*\)/gi;

  function scanImageUrls(html) {
    if (!html) return [];
    const urls = [];
    const add = (u) => { if (u && urls.indexOf(u) === -1) urls.push(u); };
    let m;
    IMAGE_URL_RE.lastIndex = 0;
    while ((m = IMAGE_URL_RE.exec(html))) add(m[1]);
    CSS_IMAGE_RE.lastIndex = 0;
    while ((m = CSS_IMAGE_RE.exec(html))) add(m[1]);
    return urls;
  }

  function basename(path) {
    const clean = String(path).split('?')[0].split('#')[0];
    const name = clean.substring(clean.lastIndexOf('/') + 1);
    return sanitizeFileName(name || 'file');
  }

  function rewriteAssets(paper, urlToLocal) {
    const rewrite = (html) => {
      if (!html) return html;
      let out = String(html);
      urlToLocal.forEach((local, url) => {
        out = out.split(url).join(local);
        out = out.split(encodeURI(url)).join(local);
      });
      return out;
    };
    for (const q of paper.questions) {
      q.stemHtml = rewrite(q.stemHtml);
      q.analysisHtml = rewrite(q.analysisHtml);
      q.options = (q.options || []).map((o) => ({ id: o.id, html: rewrite(o.html) }));
      if (q.optionsRaw) q.optionsRaw = JSON.parse(rewrite(JSON.stringify(q.optionsRaw)));
    }
  }

  async function buildZip(pack, progress) {
    const urlToLocal = new Map(); // 远程 URL -> zip 内路径
    const files = [];            // { name, data }
    const usedNames = new Set();

    const uniqueName = (path, base) => {
      let name = path + base;
      let i = 1;
      while (usedNames.has(name)) {
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : '';
        name = path + stem + '_' + i + ext;
        i++;
      }
      usedNames.add(name);
      return name;
    };

    // 1. 收集 HTML 中的图片
    const imageUrls = [];
    for (const paper of pack.papers) {
      for (const q of paper.questions) {
        for (const html of [q.stemHtml, q.analysisHtml, ...(q.options || []).map((o) => o.html)]) {
          for (const u of scanImageUrls(html)) {
            if (imageUrls.indexOf(u) === -1) imageUrls.push(u);
          }
        }
      }
    }

    let done = 0;
    for (const url of imageUrls) {
      try {
        progress('下载图片 ' + (++done) + '/' + imageUrls.length);
        const data = await fetchBinary(url, false);
        const local = uniqueName('assets/images/', basename(url));
        files.push({ name: local, data });
        urlToLocal.set(url, local);
      } catch (err) {
        progress('图片下载失败：' + basename(url));
      }
      await sleep(120);
    }

    // 2. 收集附件（需登录态）
    const attachmentKeys = new Set();
    const attachmentList = [];
    for (const paper of pack.papers) {
      for (const q of paper.questions) {
        for (const att of q.attachments || []) {
          const key = att.filename;
          if (!key || attachmentKeys.has(key)) continue;
          attachmentKeys.add(key);
          attachmentList.push({ key, att, q });
        }
      }
    }

    let adone = 0;
    for (const item of attachmentList) {
      const att = item.att;
      try {
        progress('下载附件 ' + (++adone) + '/' + attachmentList.length);
        const data = await fetchBinary(
          API_BASE + '/student/attachments/' + encodeURIComponent(att.filename),
          true
        );
        const local = uniqueName('assets/attachments/', basename(att.filename));
        files.push({ name: local, data });
        att.localPath = local;
      } catch (err) {
        progress('附件下载失败：' + att.originalName);
        att.localPath = '';
      }
      await sleep(200);
    }

    // 3. 重写 pack 内的资源路径
    for (const paper of pack.papers) rewriteAssets(paper, urlToLocal);

    const manifest = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      source: pack.source,
      papers: pack.papers.map((p) => ({
        examId: p.examId,
        examName: p.examName,
        publishRecordId: p.publishRecordId,
        questionCount: p.questionCount,
      })),
      images: Array.from(urlToLocal.entries()).map(([url, local]) => ({ source: url, path: local })),
      attachments: attachmentList.map((it) => ({
        questionId: it.q.sourceQuestionId,
        originalName: it.att.originalName,
        path: it.att.localPath || '',
      })),
    };

    const encoder = new TextEncoder();
    files.push({ name: 'pack.json', data: encoder.encode(JSON.stringify(pack, null, 2)) });
    files.push({ name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) });

    return zipStore(files);
  }

  let crcTable = null;
  function crc32(data) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zipStore(fileList) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of fileList) {
      const nameBytes = encoder.encode(f.name);
      const crc = crc32(f.data);

      const local = new Uint8Array(30 + nameBytes.length);
      const ldv = new DataView(local.buffer);
      ldv.setUint32(0, 0x04034B50, true);
      ldv.setUint16(4, 20, true);
      ldv.setUint16(6, 0x0800, true); // UTF-8 文件名
      ldv.setUint16(8, 0, true);      // store
      ldv.setUint16(10, dosTime, true);
      ldv.setUint16(12, dosDate, true);
      ldv.setUint32(14, crc, true);
      ldv.setUint32(18, f.data.length, true);
      ldv.setUint32(22, f.data.length, true);
      ldv.setUint16(26, nameBytes.length, true);
      ldv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, f.data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cd.buffer);
      cdv.setUint32(0, 0x02014B50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, dosTime, true);
      cdv.setUint16(14, dosDate, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, f.data.length, true);
      cdv.setUint32(24, f.data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint16(30, 0, true);
      cdv.setUint16(32, 0, true);
      cdv.setUint16(34, 0, true);
      cdv.setUint16(36, 0, true);
      cdv.setUint32(38, 0, true);
      cdv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + f.data.length;
    }

    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054B50, true);
    edv.setUint16(4, 0, true);
    edv.setUint16(6, 0, true);
    edv.setUint16(8, fileList.length, true);
    edv.setUint16(10, fileList.length, true);
    edv.setUint32(12, centralSize, true);
    edv.setUint32(16, offset, true);
    edv.setUint16(20, 0, true);

    return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
  }

  // ---------------------------------------------------------------------------
  // 界面
  // ---------------------------------------------------------------------------

  const state = {
    mode: 'records', // records = 已考（答题记录）；exams = 待考（我的测验）
    records: [],
    exams: [],
    selected: new Set(),
    loading: false,
    pack: null,
    panelOpen: false,
  };

  const ui = {};

  function currentItems() {
    return state.mode === 'records' ? state.records : state.exams;
  }

  function itemKey(item) {
    return (state.mode === 'records' ? 'r' : 'e') + item.id;
  }

  function itemExamId(item) {
    return String(state.mode === 'records' ? item.bank_id : item.id);
  }

  function loadSavedPaper(examId) {
    try {
      const raw = GM_getValue(PAPER_KEY_PREFIX + examId, '');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function savePaperProgress(paper) {
    try {
      GM_setValue(PAPER_KEY_PREFIX + paper.examId, JSON.stringify(paper));
      const ids = JSON.parse(GM_getValue(SAVED_IDS_KEY, '[]') || '[]');
      if (ids.indexOf(paper.examId) === -1) {
        ids.push(paper.examId);
        GM_setValue(SAVED_IDS_KEY, JSON.stringify(ids));
      }
    } catch (e) { /* 存储失败不影响本次导出 */ }
  }

  function listSavedPapers() {
    try {
      const ids = JSON.parse(GM_getValue(SAVED_IDS_KEY, '[]') || '[]');
      return ids.map(loadSavedPaper).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function itemTitle(item) {
    return state.mode === 'records' ? (item.bank_name || ('试卷 ' + item.bank_id)) : (item.name || ('试卷 ' + item.id));
  }

  function itemMeta(item) {
    if (state.mode === 'records') {
      return [
        item.status_name || '',
        item.submit_time || '',
        (item.question_count != null ? item.question_count : '?') + ' 题',
        (item.total_score_full != null ? item.total_score_full : item.total_score) + ' 分',
        item.course_name || '',
      ].filter(Boolean).join(' · ');
    }
    return [
      item.status_text || '',
      (item.question_count != null ? item.question_count : '?') + ' 题',
      (item.total_score != null ? item.total_score : '?') + ' 分',
      item.course_name || '',
    ].filter(Boolean).join(' · ');
  }

  /** 同一套卷重复交卷只保留最近一次 */
  function dedupeRecords(list) {
    const map = new Map();
    for (const r of list) {
      const key = String(r.bank_id) + '#' + String(r.publish_record_id || 0);
      const prev = map.get(key);
      if (!prev || String(r.submit_time || '').localeCompare(String(prev.submit_time || '')) > 0) {
        map.set(key, r);
      }
    }
    return Array.from(map.values()).sort((a, b) => String(b.submit_time || '').localeCompare(String(a.submit_time || '')));
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function appendLog(text) {
    if (!ui.log) return;
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
    ui.log.appendChild(line);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function renderItems() {
    if (!ui.list) return;
    ui.list.innerHTML = '';
    const items = currentItems();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.mode === 'records' ? '没有已考记录' : '没有待考试卷';
      ui.list.appendChild(empty);
      updateSelectionInfo();
      return;
    }
    for (const item of items) {
      const key = itemKey(item);
      const row = document.createElement('label');
      row.className = 'exam-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.has(key);
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(key);
        else state.selected.delete(key);
        updateSelectionInfo();
      });

      const main = document.createElement('div');
      main.className = 'exam-main';

      const title = document.createElement('div');
      title.className = 'exam-title';
      title.textContent = itemTitle(item);

      const meta = document.createElement('div');
      meta.className = 'exam-meta';
      meta.textContent = itemMeta(item);
      if (loadSavedPaper(itemExamId(item))) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '已采集';
        meta.appendChild(badge);
      }

      main.appendChild(title);
      main.appendChild(meta);
      row.appendChild(cb);
      row.appendChild(main);
      ui.list.appendChild(row);
    }
    updateSelectionInfo();
  }

  function updateSelectionInfo() {
    if (!ui.selectionInfo) return;
    ui.selectionInfo.textContent = '已选 ' + state.selected.size + ' / ' + currentItems().length + ' 套';
  }

  async function refreshItems() {
    if (state.loading) return;
    state.loading = true;
    try {
      if (state.mode === 'records') {
        setStatus('读取答题记录…');
        const all = await listAllResults((t) => setStatus(t));
        state.records = dedupeRecords(all);
        state.selected = new Set(state.records.map(itemKey));
        setStatus('已考 ' + state.records.length + ' 套（原始记录 ' + all.length + ' 条，已按试卷去重）');
      } else {
        setStatus('读取待考试卷…');
        const exams = await listExams();
        state.exams = exams;
        state.selected = new Set(exams.map(itemKey));
        setStatus('待考 ' + exams.length + ' 套（未开始的试卷一般取不到答案）');
      }
      renderItems();
    } catch (err) {
      setStatus('读取失败：' + err.message);
      appendLog('读取列表失败：' + err.message);
    } finally {
      state.loading = false;
    }
  }

  async function collectSelected() {
    if (state.loading) return;
    const targets = currentItems().filter((it) => state.selected.has(itemKey(it)));
    if (!targets.length) {
      setStatus('请先选择要采集的试卷');
      return;
    }

    state.loading = true;
    ui.collectBtn.disabled = true;
    ui.exportBtn.disabled = true;
    const papers = [];
    try {
      let ctx = null;
      if (state.mode === 'exams') {
        setStatus('准备答题记录与错题本…');
        const records = await listAllResults((t) => setStatus(t));
        const errorBook = await loadErrorBook((t) => setStatus(t));
        ctx = { results: records, errorBook };
      }

      for (let i = 0; i < targets.length; i++) {
        const item = targets[i];
        const title = itemTitle(item);
        if (ui.skipSaved && ui.skipSaved.checked) {
          const saved = loadSavedPaper(itemExamId(item));
          if (saved) {
            papers.push(saved);
            appendLog('跳过已采集《' + title + '》，使用本地进度');
            continue;
          }
        }
        setStatus('采集 ' + (i + 1) + '/' + targets.length + '：' + title);
        appendLog('开始采集《' + title + '》');
        try {
          const paper = state.mode === 'records'
            ? await collectRecord(item, (t) => appendLog(t))
            : await collectExam(item, ctx, (t) => appendLog(t));
          papers.push(paper);
          savePaperProgress(paper);
          appendLog(
            '完成《' + paper.examName + '》：' + paper.questionCount + ' 题，答案 ' +
            paper.answerCoverage.answered + '/' + paper.answerCoverage.total +
            (paper.answerCoverage.missing ? '（缺 ' + paper.answerCoverage.missing + '）' : '')
          );
        } catch (err) {
          appendLog('采集失败《' + title + '》：' + err.message);
        }
        await sleep(250);
      }

      if (!papers.length) {
        setStatus('没有成功采集的试卷');
        return;
      }

      state.pack = buildPack(papers);
      try {
        GM_setValue(STORAGE_KEY, JSON.stringify(state.pack));
      } catch (e) { /* 存储失败不影响导出 */ }

      const totalMissing = papers.reduce((s, p) => s + p.answerCoverage.missing, 0);
      const totalQ = papers.reduce((s, p) => s + p.answerCoverage.total, 0);
      setStatus('采集完成：' + papers.length + ' 套 / ' + totalQ + ' 题，缺答案 ' + totalMissing + ' 题');
      ui.exportBtn.disabled = false;
    } catch (err) {
      setStatus('采集中断：' + err.message);
      appendLog('采集中断：' + err.message);
    } finally {
      state.loading = false;
      ui.collectBtn.disabled = false;
      if (state.pack) ui.exportBtn.disabled = false;
    }
  }

  async function exportPack() {
    if (!state.pack) {
      setStatus('请先采集或载入上次结果');
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    ui.exportBtn.disabled = true;
    try {
      if (ui.zipToggle && ui.zipToggle.checked) {
        setStatus('打包资源…');
        const zipBlob = await buildZip(JSON.parse(JSON.stringify(state.pack)), (t) => setStatus(t));
        download(zipBlob, 'haomi-papers-' + stamp + '.zip');
        setStatus('已导出 ZIP 题包');
      } else {
        const blob = new Blob([JSON.stringify(state.pack, null, 2)], { type: 'application/json' });
        download(blob, 'haomi-papers-' + stamp + '.json');
        setStatus('已导出 JSON 题包');
      }
    } catch (err) {
      setStatus('导出失败：' + err.message);
      appendLog('导出失败：' + err.message);
    } finally {
      ui.exportBtn.disabled = false;
    }
  }

  function loadLastPack() {
    try {
      // 优先按试卷读取本地进度，支持“继续上次”
      let papers = listSavedPapers();
      if (!papers.length) {
        const raw = GM_getValue(STORAGE_KEY, '');
        if (!raw) {
          setStatus('没有找到上次的采集结果');
          return;
        }
        const savedPack = JSON.parse(raw);
        papers = (savedPack && savedPack.papers) || [];
      }
      if (!papers.length) {
        setStatus('没有找到上次的采集结果');
        return;
      }
      state.pack = buildPack(papers);
      setStatus('已载入上次结果：' + papers.length + ' 套试卷，可直接导出');
      appendLog('载入上次结果：' + papers.map((p) => p.examName).join('、'));
      ui.exportBtn.disabled = false;
    } catch (err) {
      setStatus('载入失败：' + err.message);
    }
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'haomi-collector-host';
    host.style.all = 'initial';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .fab {
          position: fixed; right: 24px; bottom: 24px; z-index: 2147483000;
          width: 56px; height: 56px; border-radius: 50%;
          background: #0052d9; color: #fff; border: none; cursor: pointer;
          box-shadow: 0 6px 18px rgba(0,0,0,.24); font-size: 13px; line-height: 1.2;
        }
        .fab:hover { background: #266fe8; }
        .panel {
          position: fixed; right: 24px; bottom: 92px; z-index: 2147483000;
          width: 420px; max-height: 70vh; display: none; flex-direction: column;
          background: #fff; color: #1f2329; border-radius: 10px;
          box-shadow: 0 12px 40px rgba(0,0,0,.28);
          font: 13px/1.5 -apple-system, "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
          overflow: hidden;
        }
        .panel.open { display: flex; }
        .head { padding: 12px 14px; background: #f5f7fa; display: flex; align-items: center; justify-content: space-between; }
        .head strong { font-size: 14px; }
        .close { border: none; background: transparent; font-size: 18px; cursor: pointer; color: #646a73; }
        .body { padding: 10px 14px; overflow: auto; }
        .status { padding: 8px 14px; background: #f0f4ff; color: #0052d9; font-size: 12px; border-top: 1px solid #e7e9ec; border-bottom: 1px solid #e7e9ec; }
        .list { max-height: 240px; overflow: auto; border: 1px solid #e7e9ec; border-radius: 6px; }
        .exam-row { display: flex; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #f2f3f5; cursor: pointer; }
        .exam-row:last-child { border-bottom: none; }
        .exam-row:hover { background: #f9fafb; }
        .exam-main { min-width: 0; }
        .exam-title { font-weight: 600; }
        .exam-meta { color: #646a73; font-size: 12px; margin-top: 2px; }
        .badge { margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: #e8f5e9; color: #2e7d32; font-size: 11px; }
        .empty { padding: 16px; text-align: center; color: #8f959e; }
        .row { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; }
        .mode { display: flex; gap: 14px; margin: 2px 0 8px; }
        .hint { color: #646a73; font-size: 12px; }
        .log { height: 96px; overflow: auto; background: #0f172a; color: #cbd5e1; border-radius: 6px; padding: 6px 8px; font: 11px/1.6 Consolas, monospace; }
        .log-line { white-space: pre-wrap; word-break: break-all; }
        .foot { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid #e7e9ec; background: #fafbfc; flex-wrap: wrap; }
        button.act {
          padding: 6px 12px; border-radius: 5px; border: 1px solid #c5c8ce; background: #fff;
          color: #1f2329; cursor: pointer; font-size: 12px;
        }
        button.primary { background: #0052d9; border-color: #0052d9; color: #fff; }
        button:disabled { opacity: .5; cursor: not-allowed; }
        label.chk { display: inline-flex; align-items: center; gap: 4px; color: #646a73; font-size: 12px; }
      </style>
      <button class="fab" id="fab">采集</button>
      <div class="panel" id="panel">
        <div class="head">
          <strong>题包采集器</strong>
          <button class="close" id="close">×</button>
        </div>
        <div class="status" id="status">准备就绪</div>
        <div class="body">
          <div class="mode">
            <label class="chk"><input type="radio" name="collectMode" id="modeRecords" checked> 已考（答题记录）</label>
            <label class="chk"><input type="radio" name="collectMode" id="modeExams"> 待考（我的测验）</label>
          </div>
          <div class="row">
            <span class="hint" id="selectionInfo">已选 0 / 0 套</span>
            <span>
              <button class="act" id="selectAll">全选</button>
              <button class="act" id="refresh">刷新列表</button>
            </span>
          </div>
          <div class="list" id="list"></div>
          <div class="row">
            <label class="chk"><input type="checkbox" id="zipToggle" checked> 导出 ZIP（含图片与附件）</label>
            <label class="chk"><input type="checkbox" id="skipSaved" checked> 跳过已采集</label>
          </div>
          <div class="log" id="log"></div>
        </div>
        <div class="foot">
          <button class="act primary" id="collect">开始采集</button>
          <button class="act" id="export" disabled>导出题包</button>
          <button class="act" id="loadLast">载入上次</button>
        </div>
      </div>
    `;

    ui.fab = root.getElementById('fab');
    ui.panel = root.getElementById('panel');
    ui.status = root.getElementById('status');
    ui.list = root.getElementById('list');
    ui.log = root.getElementById('log');
    ui.selectionInfo = root.getElementById('selectionInfo');
    ui.collectBtn = root.getElementById('collect');
    ui.exportBtn = root.getElementById('export');
    ui.zipToggle = root.getElementById('zipToggle');
    ui.skipSaved = root.getElementById('skipSaved');
    ui.modeRecords = root.getElementById('modeRecords');
    ui.modeExams = root.getElementById('modeExams');

    const switchMode = (mode) => {
      if (state.mode === mode && currentItems().length) return;
      state.mode = mode;
      state.selected = new Set();
      renderItems();
      updateSelectionInfo();
      refreshItems();
    };
    ui.modeRecords.addEventListener('change', () => { if (ui.modeRecords.checked) switchMode('records'); });
    ui.modeExams.addEventListener('change', () => { if (ui.modeExams.checked) switchMode('exams'); });

    ui.fab.addEventListener('click', () => {
      state.panelOpen = !state.panelOpen;
      ui.panel.classList.toggle('open', state.panelOpen);
      ui.fab.textContent = state.panelOpen ? '收起' : '采集';
      if (state.panelOpen && !currentItems().length && !state.loading) refreshItems();
    });
    root.getElementById('close').addEventListener('click', () => {
      state.panelOpen = false;
      ui.panel.classList.remove('open');
      ui.fab.textContent = '采集';
    });
    root.getElementById('refresh').addEventListener('click', refreshItems);
    root.getElementById('selectAll').addEventListener('click', () => {
      const items = currentItems();
      if (state.selected.size === items.length) state.selected.clear();
      else state.selected = new Set(items.map(itemKey));
      renderItems();
    });
    ui.collectBtn.addEventListener('click', collectSelected);
    ui.exportBtn.addEventListener('click', exportPack);
    root.getElementById('loadLast').addEventListener('click', loadLastPack);
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  function boot() {
    if (!adapter.detect()) return;
    if (document.getElementById('haomi-collector-host')) return;
    buildUI();

    if (!adapter.getToken()) {
      setStatus('未检测到登录状态，请从主平台重新进入考试平台');
      return;
    }
    setStatus('已登录，默认读取已考记录');
    setTimeout(refreshItems, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
