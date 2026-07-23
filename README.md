# AI 智能助手 (AI Assistant)

全栈 AI 对话助手，基于 EdgeOne Makers 平台，支持 Web 搜索、代码执行、浏览器自动化、定时任务等功能。

## 技术栈

- **前端**: React 18 + Vite 5 + Tailwind 3 + Recharts
- **后端**: EdgeOne Cloud Functions (Edge Functions)
- **AI 代理**: EdgeOne Agents (OpenAI 兼容格式)
- **存储**: Agent 对话存储 (`context.store` / `context.agent.store`) + KV (用户/密码/设置/任务)
- **鉴权**: JWT (HMAC-SHA256) + HttpOnly Cookie
- **部署**: GitHub → EdgeOne Makers (全栈类型, Node 22)

---

## 架构

```
dodo.341222.xyz
  ├─ / (React SPA)              → frontend/dist 静态文件
  ├─ /api/auth/*                → Cloud Functions (登录/注册/登出)
  ├─ /api/conversations*        → Cloud Functions + context.agent.store
  ├─ /api/tasks*                → Cloud Functions + KV
  ├─ /api/settings              → Cloud Functions + KV
  ├─ /api/stats                 → Cloud Functions + KV
  ├─ /api/executions            → Cloud Functions + KV
  ├─ /api/models                → Cloud Functions (查询 AI 网关)
  ├─ /api/health                → 健康检查
  ├─ /api/kv-test               → KV 调试验证
  └─ /chat-assistant             → EdgeOne Agent (SSE 流式对话)
```

---

## ⚠️ EdgeOne Makers 平台注意事项

### 1. 两个独立的运行时

| 运行时 | 目录 | 可访问的 API |
|--------|------|------------|
| **Cloud Functions** | `functions/` | `env.AI_ASSISTANT_KV` (KV 绑定), `env.JWT_SECRET` 等字符串 env |
| **Agent 沙箱** | `agents/` | `context.store` (内置对话存储), **不支持 KV** |

Agent 运行时**没有** KV 命名空间绑定。对话存储应使用 `context.store`（平台内置，零配置），**不是** `env.AI_ASSISTANT_KV`。

### 2. KV 绑定的正确访问方式

EdgeOne Makers 通过**全局变量**注入 KV 绑定（不是 `env` 对象）：

```typescript
// ✅ 正确（EdgeOne 模板源码中使用的方式）
const kv = (globalThis as any).AI_ASSISTANT_KV;

// ❌ 错误（之前用这个，永远 undefined）
const kv = env.AI_ASSISTANT_KV;   // undefined
```

KVStore 构造函数已内置 `globalThis` 回退：
```typescript
// _shared/kv.ts
constructor(kv: any) {
    if (!kv) kv = (globalThis as any).AI_ASSISTANT_KV;
    if (!kv) kv = {/* no-op mock */};
    this.kv = kv;
}
```

### 3. 路由模式：不可用 `[[default]].ts` 做列表端点

EdgeOne 将 `^/api/conversations/(.*)$` 编译为 `^/api/conversations/(.+?)$`（`+` 要求至少 1 字符），所以无子路径的列表端点永远 404。

**解决方法**：每个端点拆成两个文件：
- `index.ts` → 精确匹配列表路径（如 `/api/conversations`）
- `[[default]].ts` → catch-all 匹配子路径（如 `/api/conversations/:id`）

### 4. Agent runtime 中的 Request 对象

EdgeOne Agent 传给 `onRequest(context)` 的 `context.request` 是**普通对象**，不是标准 `Request`：

- `request.headers` 是普通对象，且键为**小写**（`'accept'` 而非 `'Accept'`）
- `request.json()` **不存在**，需手动解析 `request.body` 或 `request.text()`
- `request.signal` 可能不存在
- 各 agent 代码中已通过 `getHeader()` 辅助函数和 body 解析 fallback 处理

### 5. AbortSignal.timeout() 不可用

EdgeOne Agent 运行时基于 Cloudflare Workers，不支持 `AbortSignal.timeout()`（Node.js 17.3+ 独有）。改用 `_shared/abort.ts` 中的 `createTimeoutSignal()`：

```typescript
import { createTimeoutSignal } from '../../_shared/abort';
fetch(url, { signal: createTimeoutSignal(10000) });
```

### 6. AI Gateway 模型命名

EdgeOne AI Gateway 要求模型名带提供商前缀：

| 类型 | 格式 | 示例 |
|------|------|------|
| 内置免费模型 | `@makers/<model>` | `@makers/deepseek-v4-flash` |
| 自费厂商模型 | `<provider>/<model>` | `deepseek/deepseek-v4-pro` |

当前项目使用内置免费模型，默认 `@makers/deepseek-v4-flash`。

### 7. Agent 对话存储

Agent 运行时使用 `context.store`（内置 Blob 存储）：
- `context.store.appendMessage({ conversationId, role, content })`
- `context.store.getMessages({ conversationId, limit })`

Cloud Functions 通过 `context.agent.store` 读取同一对话数据：
- `context.agent.store.listConversations({ userId })`
- `context.agent.store.getMessages({ conversationId })`

配置在 `edgeone.json` 中：
```json
"agents": {
    "dir": "agents",
    "framework": "openai",
    "timeout": 300,
    "sandbox": { "timeout": 600 }
}
```

---

## 部署流程

### 方式 1：GitHub → EdgeOne Makers（当前使用）

1. 本地修改代码后：
   ```bash
   git add -A
   git commit -m "描述"
   git push origin main
   ```
2. EdgeOne Makers 控制台会自动检测 GitHub push 并重新部署
3. 部署完成后在控制台点击「预览」获取带 `?eo_token=` 的完整 URL

### 方式 2：CloudStudio（备用预览）

```bash
# 前端预览（静态），无需后端环境
cd frontend && npm run build
# 然后通过 CloudStudio 的 deploy_sandbox 工具部署 dist/ 目录
```

---

## 域名绑定

自定义域名 `dodo.341222.xyz` 已绑定到 `ai-assistant` 项目。
EdgeOne 控制台 → 域名管理 → 添加自定义域名并配置 CNAME。

---

## 环境变量（EdgeOne 控制台配置）

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `AI_GATEWAY_API_KEY` | 密钥 | AI 网关 API Key |
| `AI_GATEWAY_BASE_URL` | 密钥 | AI 网关地址 |
| `JWT_SECRET` | 密钥 | JWT 签名密钥 |
| `CRON_SECRET` | 密钥 | 定时任务鉴权 |
| `AI_MODEL` | 环境变量 | 默认模型名，当前 `@makers/deepseek-v4-flash` |
| `AI_ASSISTANT_KV` | **KV 命名空间绑定**（非普通 env） | 用于用户、任务、设置等持久化 |

注意：KV 绑定必须在控制台「项目 → 存储 → KV → 绑定命名空间」中设置，变量名 `AI_ASSISTANT_KV`。

---

## 关键文件说明

| 文件 | 说明 |
|------|------|
| `edgeone.json` | 项目部署配置 |
| `_shared/kv.ts` | KV 存储封装（含 Worker 兼容的 ID 生成、凭证加密、Cron 匹配） |
| `_shared/browser-utils.ts` | 浏览器 Cookie 管理（保存/恢复/验证码检测） |
| `_shared/jwt.ts` | JWT 工具（HMAC-SHA256，Web Crypto API） |
| `_shared/abort.ts` | 超时 Signal（兼容 Workers） |
| `_shared/logger.ts` | 统一 JSON 日志 |
| `_shared/response.ts` | JSON 响应辅助函数 |
| `agents/chat-assistant/index.ts` | 核心 Agent（SSE 流式/JSON 双模式、意图路由、5 个工具） |
| `functions/api/auth/[[default]].ts` | 用户认证（SHA-256+salt 密码哈希） |
| `functions/api/conversations/index.ts` | 对话列表/创建（通过 `context.agent.store`） |
| `functions/api/cron-trigger.ts` | 定时任务触发器（Token 鉴权、分批执行、自动登录） |
| `functions/api/health.ts` | 健康检查端点 |
| `frontend/src/components/AdminPanel.tsx` | 后台管理面板（统计/任务/日志/设置） |

---

## 已知历史问题（已修复）

1. **SSE 伪流式** → 改为真 SSE 流式逐字输出
2. **注册失败: KV 未绑定** → KVStore 升级 `globalThis.AI_ASSISTANT_KV` + 无 KV 时优雅降级
3. **对话列表 404** → 每个端点拆分 `index.ts`（列表）+ `[[default]].ts`（详情）
4. **Agent body 解析失败** → 兼容普通对象 Request
5. **AbortSignal.timeout 报错** → 替换为 `createTimeoutSignal`
6. **AI Gateway /v1 路径重复** → 检测 base URL 是否已以 `/v1` 结尾
7. **Agent header 名大小写** → `getHeader()` 辅助函数
8. **模型名格式** → `@makers/` 前缀（内置）或 `provider/model`（自费）
9. **密码 Salt 随机源** → `Math.random()` → `crypto.getRandomValues()`
10. **浏览器工具函数重复** → 抽取到 `_shared/browser-utils.ts`
