# 豪密考试平台题包采集 + 本地 AI 做卷系统

把培训网站的试卷采集成本地题包，在 Windows 上导入、作答、自动保存、规则判分，并用可配置的模型逐题批改主观题。

当前是一个可运行的首版：采集器、导入器、题库、答题、结果、错题本、批改 worker、AI 设置页都已打通，并用真实题包做过端到端验证。

---

## 目录结构

```text
.
├─ Windows-AI-Exam-System-Plan.md        # 选型与整体方案
├─ haomi-exam-collector.user.js          # 油猴采集器（Tampermonkey 直接安装）
├─ haomi-papers-2026-10-26T10-50-28.zip  # 真实题包样例（7 套卷 / 256 题 / 图片与附件）
└─ exam-app/                             # 本地做题系统（Next.js + Prisma + SQLite）
   ├─ prisma/schema.prisma
   ├─ src/app/                           # 页面与 API
   ├─ src/lib/                           # 导入、判分、批改、设置
   ├─ src/worker/grader.ts               # 独立批改 worker
   ├─ scripts/                           # 冒烟、超时、AI 链路、连续性验证
   └─ start.ps1                          # 一键启动 dev server + worker
```

---

## 当前状态

### 已完成

| 模块 | 状态 |
|---|---|
| 油猴采集器 | 已考记录 / 待考试卷两种入口；标准题包 JSON/ZIP；按试卷保存进度；图片与附件打包 |
| 题包导入 | ZIP/JSON 预览后确认导入；HTML 清洗；资源本地化；重复导入幂等覆盖 |
| 题库与试卷 | 课程模块筛选；原卷练习；题目组、结构化填空、简答等题型 |
| 答题 | 600ms 防抖自动保存；刷新/重启后恢复；提交前不下发参考答案 |
| 判分 | 单选/判断、多选、填空、结构化填空按明确规则；缺答案标记待复核 |
| 主观题批改 | AI SDK 工具调用循环；独立 worker；租约/心跳/重试/待复核；可暂停继续 |
| 结果与错题 | 分数、逐题对比、逐空对错、解析、复核原因；错题本查看与重做 |
| AI 设置 | 页面配置 Base URL / Key / 模型；自动拉取 `/models` 选择；Key 只存后端并掩码显示 |
| 连续性 | 一次请求排空待批队列；start.ps1 自动起 worker；页面显示批改服务在线状态 |

### 已验证（真实题包 + 本地假模型服务）

| 项目 | 结果 |
|---|---|
| 题包导入 | 7 套卷、256 题；重复导入仍为 7 套；64 张图片、5 个附件可访问 |
| 结构化判分 | 试卷 172：14 题按逐空规则得 26 分，总分 39.5/50 |
| 规则 + 模拟 | 试卷 173：18 道主观题模拟评分，29.5/50 |
| 真实 AI 链路 | OpenAI 兼容假服务：`method=ai`、2 步工具调用、`promptVersion=v2-tools` |
| 模型超时 | 800ms 超时 → 3 次重试 → 任务 `failed`、评分待复核 |
| 批改连续性 | 手动排空：18/18 一次批完；worker 自动：18/18 无需手动触发 |
| 上下文预算 | 限制 2000 字符时全部生效，超长参考答案被截断并记录 |
| 暂停/继续 | 暂停时 `processed=0`；恢复后继续领取 |
| 安全 | `<script>`、`onerror`、`javascript:` 导入后被清除；服务仅监听 127.0.0.1 |
| 资源与幂等 | 缺失资源 404；重复运行批改 `processed=0`；重复提交被拒 |
| 恢复 | 重启服务后答题页/结果页/错题页正常，作答数据保留 |
| 构建 | `npm run build` 通过 |

### 库里当前数据

- 7 套试卷、256 道题
- 5 次作答记录、0 条待批任务
- AI 配置默认为空；未配置时主观题走模拟评分

---

## 快速开始

环境：Windows + Node.js 22 LTS。

```powershell
cd exam-app
npm install
npx prisma db push
```

启动（会同时拉起 Next.js 和批改 worker）：

```powershell
.\start.ps1
```

打开 http://127.0.0.1:3000 。

### 第一次使用

1. 浏览器安装 Tampermonkey，导入 `haomi-exam-collector.user.js`。
2. 打开 `https://mofang.haomitech.cn:40000/`，登录后进入考试平台。
   注意：必须用域名访问，IP 访问会因证书 CN 不匹配被浏览器拦截。
3. 右下角「采集」→ 默认「已考（答题记录）」→ 选择试卷 → 开始采集 → 导出 ZIP。
4. 本地系统「导入题包」→ 预览 → 确认导入。
5. 「试卷」→ 开始答题；答题过程自动保存。
6. 提交后在结果页查看判分；主观题由 worker 自动批改，也可点「批改全部待批」。

### 配置真实模型

打开「AI 设置」：

- 填 Base URL（兼容 OpenAI Chat Completions，例如 `https://api.example.com/v1`）
- 填 API Key（只写入本地 SQLite，接口只回显掩码）
- 点「获取模型」拉取列表并选择，或手动填模型名
- 「测试连接」通过后保存

配置来源优先级：数据库 → 环境变量（`.env` 里的 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`）。
未配置时主观题返回模拟评分并标记待复核，不会静默给分。

---

## 批改 Agent 设计

每道主观题是一个小范围 Agent，不是让模型维护整张卷子的清单。

```text
程序创建待批任务
  → worker 领取（租约 + 心跳）
  → 模型调用业务工具：read_grading_item / read_shared_material / read_rubric
  → save_grade 或 mark_for_review
  → 服务端校验分数范围与题目归属后落库
  → 汇总总分，全部题目终态后 attempt 标记 graded
```

约束与可靠性：

- 工具只有 5 个业务工具，没有 SQL、终端、任意文件权限；闭包限定当前作答与题目。
- 单题限制：最大工具步数、超时、输出 Token 预算、上下文字符预算。
- 上下文预算按「学生答案 → 参考答案 → 题干 → 共用材料 → 解析」分配，超出截断并记录在评分详情。
- 评分唯一键 `attemptId + questionExternalId + gradingVersion`，重试不会重复计分。
- 工具调用、任务领取、失败原因都写入 `EventLog`，可回查。
- worker 异常退出后租约过期可重新领取；3 次失败转人工复核。
- 可暂停/继续；页面显示 worker 心跳与待批数量。
- 提交时冻结试卷快照，后续重新导入题库不影响旧成绩。

---

## 技术栈

- 采集器：Tampermonkey 原生 JavaScript，单文件、无运行时依赖
- 前端/后端：Next.js 16.4.3 + React 19 + TypeScript + Tailwind CSS 4
- 数据库：SQLite + Prisma 6.19.3
- 模型接入：Vercel AI SDK 5.0.281 + `@ai-sdk/openai-compatible` 1.0.59
- 校验：Zod 4
- 批改：独立 Node worker（tsx 运行）

版本已锁定，具体见 `exam-app/package.json`。

---

## 主要接口

| 用途 | 接口 |
|---|---|
| 题包预览/导入 | `POST /api/import/preview`、`POST /api/import/commit` |
| 资源访问 | `GET /api/assets/[...path]` |
| 创建/继续作答 | `POST /api/attempts` |
| 自动保存 | `PUT /api/attempts/{id}/answer` |
| 提交 | `POST /api/attempts/{id}/submit` |
| 作答状态 | `GET /api/attempts/{id}` |
| 批改队列 | `POST /api/grading/run`（默认排空） |
| 批改状态 | `GET /api/grading/status` |
| 暂停/继续 | `POST /api/grading/control` |
| AI 配置 | `GET/POST/DELETE /api/settings/ai` |
| 模型列表 | `POST /api/settings/ai/models` |
| 连接测试 | `POST /api/settings/ai/test` |

---

## 验证脚本

```powershell
cd exam-app

# 冒烟：创建作答 → 保存 → 提交 → 批改 → 查看结果
node --env-file=.env scripts/smoke.mjs

# 批改失败与重试（需要可达/不可达的模型地址）
npx tsx --env-file=.env scripts/timeout-test.ts

# AI 工具调用链路（先启动 scripts/fake-ai-server.mjs）
npx tsx --env-file=.env scripts/ai-path-test.ts

# 连续性：排空批改 / worker 自动批改 / 上下文预算 / 工具事件
npx tsx --env-file=.env scripts/continuity-test.ts [--worker]
```

---

## 已知限制与技术差异

- 采集器是 Tampermonkey 原生 JS，没有引入 TS 构建链；文档里的 TS 是推荐项，不影响协议与功能。
- 没有安装 shadcn/ui，界面用 Tailwind 自写组件实现，减少依赖与初始化成本。
- 真实模型批改需要自备 API Key；仓库里只验证了 OpenAI 兼容协议链路，未内置任何供应商额度。
- 目前只适配「豪密考试平台」一个站点；换站点需要新增适配器。
- 组卷、错题强化、批量导出等属于下一阶段。
- 本仓库公开包含真实试卷题包，上传前请自行确认内容可以公开。

---

## 后续计划

按 `Windows-AI-Exam-System-Plan.md` 的阶段四推进：

1. 第二个网站适配器，验证题包协议复用。
2. 从题库抽题组卷。
3. 错题强化练习与批量重做。
4. 更完整的评分规则配置（多选部分得分、填空别名表）。

---

## 说明

本项目仅用于个人学习与本地练习。采集器只读取当前账号有权查看的数据；网站未下发的答案会显式标记缺失，不会由 AI 编造标准答案。
