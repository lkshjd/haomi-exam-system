// 本地假模型服务：模拟 OpenAI Chat Completions 的工具调用，用于验证批改链路。
// 用法：node scripts/fake-ai-server.mjs
import http from 'node:http';

const PORT = Number(process.env.FAKE_AI_PORT || 8787);
const DELAY_MS = Number(process.env.FAKE_AI_DELAY_MS || 0);
let callSeq = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'fake-grader', object: 'model' },
          { id: 'fake-grader-mini', object: 'model' },
        ],
      })
    );
    return;
  }
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* ignore */
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    callSeq += 1;

    const plainResponse = {
      id: `chatcmpl-${callSeq}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'fake-grader',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'OK' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    };

    const response = !hasTools
      ? plainResponse
      : hasToolResult
      ? {
          id: `chatcmpl-${callSeq}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'fake-grader',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '已完成评分。' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      : {
          id: `chatcmpl-${callSeq}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'fake-grader',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call_${callSeq}`,
                    type: 'function',
                    function: {
                      name: 'save_grade',
                      arguments: JSON.stringify({
                        score: 2,
                        hitPoints: ['命中要点一'],
                        missedPoints: ['遗漏要点二'],
                        deductions: ['按参考答案推导'],
                        advice: '补充要点二',
                        needsReview: true,
                        reviewReason: '假模型测试',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    setTimeout(() => res.end(JSON.stringify(response)), DELAY_MS);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-ai] listening on http://127.0.0.1:${PORT}/v1`);
});
