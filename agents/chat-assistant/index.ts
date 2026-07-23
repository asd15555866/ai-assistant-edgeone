/**
 * ============================================
 * 智能路由 Agent - 核心大脑
 * ============================================
 *
 * 这是整个系统的核心。它接收用户消息，通过 LLM 判断意图，
 * 分流到不同的工具执行：
 *
 * 1. 定时任务识别 → schedule_task 工具
 * 2. 一次性任务（查东西、算数、跑代码、浏览器操作）→ 当场执行
 * 3. 闲聊 → 直接回复
 *
 * 设计理由：
 * - 所有逻辑集中在一个 Agent 中，避免多 Agent 通信开销
 * - 使用 SSE 流式返回中间状态，提升用户体验。
 *   2024-07 改进：SSE 模式现在真正流式输出 LLM 回复内容（逐字推送），
 *   而非等完整回复后才一次性发送。
 * - 工具注册采用标准 schema，便于 LLM 理解
 */
import { KVStore, Message, Conversation, ScheduledTask, IntermediateState, generateId } from '../../_shared/kv';
import { getUserFromRequest, parseCookies } from '../../_shared/jwt';
import { log, logError } from '../../_shared/logger';
import { createTimeoutSignal } from '../../_shared/abort';
import { saveBrowserCookies, restoreBrowserCookies, detectLoginChallenge } from '../../_shared/browser-utils';

const SRC = 'agent';

// ==================== 类型定义 ====================

type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

type ToolResult = {
  success: boolean;
  data: unknown;
  error?: string;
  traceLog?: string[];
};

type LLMResponse = {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model?: string;
};

type ChatContext = {
  userId: string;
  conversationId: string;
  kv: KVStore;
  traceLog: string[];
  env: Record<string, string>;
  sandbox: any;   // EdgeOne 沙箱实例，用于 browser 操作和超时控制
  store: any;     // EdgeOne context.store - 平台内置对话存储
  tracer: any;    // EdgeOne context.tracer - 平台内置全链路追踪
  signal?: AbortSignal; // 请求中断信号，用于 SSE 断开清理
};

// ==================== 追踪与消息持久化 ====================

/**
 * 创建追踪 span（优先使用平台 context.tracer，降级到 traceLog）
 */
/**
 * 大小写无关地从 request.headers 取值
 * Cloudflare Workers/EdgeOne Agent runtime 将 header 名转小写
 * 直接用 request.headers['Accept'] 会拿到 undefined
 */
function getHeader(request: any, name: string): string | null {
  const headers = request?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] ?? null;
  }
  return null;
}

function tracerSpan(ctx: ChatContext, name: string, attrs?: Record<string, unknown>) {
  const msg = `[${name}]${attrs ? ' ' + JSON.stringify(attrs) : ''}`;
  ctx.traceLog.push(msg);
  if (ctx.tracer?.span) {
    ctx.tracer.span(name, { ...attrs, timestamp: Date.now() });
  }
}

/**
 * 保存消息到 KV（必须）+ 平台 store（可选）
 *
 * 设计理由：
 * - KV 是 Conversations API（/api/conversations/:id）读取消息的唯一来源
 * - context.store 是 EdgeOne 平台能力，用于可观测性和框架适配
 * - 两者都要写入，确保 Conversations API 和平台能力都正常工作
 */
/**
 * 保存消息到平台内置 store（Agent 对话存储）
 *
 * EdgeOne Agent 运行时使用 context.store（平台内置），而非 KV。
 * 官方文档：https://pages.edgeone.ai/zh/document/agents-conversation-storage
 *
 * context.store 提供 appendMessage、getMessages、listConversations 等完整 API，
 * 零配置，Agent 运行时自动可用。
 */
async function saveMessage(ctx: ChatContext, msg: { role: string; content: string; id?: string }) {
  if (ctx.signal?.aborted) return;

  // 写入 Agent Blob 存储（Agent 运行时 + cloud-functions/ 目录都可读）
  if (ctx.store?.appendMessage) {
    try {
      await ctx.store.appendMessage({
        conversationId: ctx.conversationId,
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    } catch (e) { ctx.traceLog.push(`[store] appendMessage 失败: ${(e as Error).message}`); }
  }

  // 同时写入 KV（降级读取源）
  if (ctx.kv?.kv) {
    try {
      const msgId = msg.id || generateId();
      await ctx.kv.createMessage({
        id: msgId,
        conversation_id: ctx.conversationId,
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        created_at: Date.now(),
      });
    } catch (e) { ctx.traceLog.push(`[kv] saveMessage 失败: ${(e as Error).message}`); }
  }
}

/**
 * 获取历史消息（统一从 KV 读取）
 */
/**
 * 从平台内置 store 加载对话历史
 */
async function loadHistory(ctx: ChatContext): Promise<{ role: string; content: string }[]> {
  // 优先从 Agent Blob 存储读取（Agent 运行时 + cloud-functions/ 都可读）
  if (ctx.store?.getMessages) {
    try {
      const messages: any[] = await ctx.store.getMessages({ conversationId: ctx.conversationId, limit: 100 });
      if (Array.isArray(messages)) {
        return messages.map((m: any) => ({ role: m.role, content: m.content }));
      }
    } catch { /* 降级到 KV */ }
  }

  // 降级：从 KV 读取
  if (ctx.kv?.kv) {
    try {
      return (await ctx.kv.listConversationMessages(ctx.conversationId)).map(m => ({
        role: m.role,
        content: m.content,
      }));
    } catch { /* ignore */ }
  }
  return [];
}

// ==================== 系统提示词 ====================

const SYSTEM_PROMPT = `你是一个智能 AI 助手，核心能力是理解用户意图并分流执行。

## 核心规则（优先级从高到低）：

### 1. 定时任务识别（最高优先级）
如果用户指令包含明确的时间周期词：每天、每周、每小时、每隔N分钟、定时、周期性、每天早上、每晚、每周末等
→ 必须调用 schedule_task 工具创建定时任务，**不得当场执行任务内容**
→ 例如："每天 9 点抓取新闻"、"每隔一小时刷新页面"、"每周一检查服务器状态"

### 2. 一次性任务识别
如果是指令型任务但**不包含**时间周期词，选择对应工具当场执行：
- 查东西（天气、新闻、信息）→ web_search
- 算数、跑代码 → execute_code
- 登录、点击、截图、抓取内容 → browser_automation
- 管理任务（暂停/恢复/删除任务）→ schedule_task（传入 status 参数）

### 3. 闲聊识别
普通对话、问候、情感交流等 → 直接回复，不调用任何工具

## 可用工具：

### web_search(query: string)
- 用途：联网搜索信息
- 触发场景：查天气、新闻、百科、实时信息
- 示例：query="今天合肥天气"

### execute_code(code: string, language: string)
- 用途：执行代码片段
- 触发场景：数学计算、数据处理、运行脚本
- 语言支持：python, javascript
- 示例：code="123*456" language="python"

### browser_automation(action: object)
- 用途：浏览器自动化操作
- 触发场景：登录网站、点击按钮、截图、抓取页面内容
- action 格式：{ type: "goto"|"click"|"type"|"screenshot"|"getContent", url?: string, selector?: string, value?: string, wait?: number }
- 示例：{ type: "goto", url: "https://example.com" }

### schedule_task(name: string, cron: string, action: string, params: object, notify_email?: string, status?: string)
- 用途：创建或管理定时任务
- 触发场景：包含时间周期词的任务
- cron 格式：支持标准 cron 或中文描述
- status: 传入 "paused" 表示暂停任务，"active" 表示恢复

## 回复格式要求：
- 执行任务时：先说明正在做什么，然后调用对应工具
- 执行完成后：总结结果给用户
- 闲聊时：自然对话即可
- 中间状态通过 \`state:\` 前缀输出`;

// ==================== 工具实现 ====================

async function webSearch(query: string, ctx: ChatContext): Promise<ToolResult> {
  tracerSpan(ctx, 'web_search', { query });
  try {
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      { signal: createTimeoutSignal(15000) }
    );
    tracerSpan(ctx, 'web_search', { status: response.status });

    if (!response.ok) {
      tracerSpan(ctx, 'web_search', { fallback: true });
      return {
        success: true,
        data: `关于「${query}」的搜索结果：\n这是模拟搜索结果。在实际部署中，建议配置专用的搜索 API Key（如 SerpAPI 或 Bing Search API）。`,
        traceLog: ctx.traceLog,
      };
    }

    const data = await response.json();
    const results: string[] = [];

    if (data.AbstractText) {
      results.push(data.AbstractText);
    }
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, 5)) {
        if (typeof topic === 'object' && topic.Text) {
          results.push(`- ${topic.Text}`);
        }
      }
    }

    const result = results.length > 0
      ? results.join('\n')
      : `未找到关于「${query}」的详细结果。`;

    tracerSpan(ctx, 'web_search', { resultCount: results.length });
    return { success: true, data: result, traceLog: ctx.traceLog };
  } catch (error) {
    tracerSpan(ctx, 'web_search', { error: (error as Error).message });
    return {
      success: true,
      data: `搜索「${query}」时出现错误，请稍后重试。`,
      traceLog: ctx.traceLog,
    };
  }
}

async function executeCode(
  code: string,
  language: string,
  ctx: ChatContext
): Promise<ToolResult> {
  tracerSpan(ctx, 'execute_code', { language });
  try {
    if (ctx.sandbox?.run_code) {
      tracerSpan(ctx, 'execute_code', { engine: 'edgeone_sandbox' });
      const result = await ctx.sandbox.run_code({
        code,
        language: language === 'javascript' ? 'javascript' : 'python',
        timeout: 30,
      });
      const output = result.results?.map((r: any) => r.text).join('\n')
        || result.logs?.join('\n')
        || result.error
        || '无输出';
      tracerSpan(ctx, 'execute_code', { output: output.slice(0, 100) });
      return { success: !result.error, data: output, traceLog: ctx.traceLog };
    }

    tracerSpan(ctx, 'execute_code', { engine: 'external_piston' });
    const result = await sandboxExecute(code, language);
    tracerSpan(ctx, 'execute_code', { output: result.slice(0, 100) });
    return { success: true, data: result, traceLog: ctx.traceLog };
  } catch (error) {
    tracerSpan(ctx, 'execute_code', { error: (error as Error).message });
    return {
      success: false,
      data: `代码执行出错: ${(error as Error).message}`,
      traceLog: ctx.traceLog,
    };
  }
}

async function sandboxExecute(code: string, language: string): Promise<string> {
  const response = await fetch('https://emkc.org/api/v2/piston/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      language,
      version: language === 'python' ? '3.10.0' : '18.15.0',
      files: [{ content: code }],
    }),
    signal: createTimeoutSignal(30000),
  });

  if (!response.ok) {
    throw new Error(`执行服务返回 ${response.status}`);
  }

  const result = await response.json();
  return result.run?.output || result.run?.stderr || '无输出';
}

async function browserAction(
  action: { type: string; url?: string; selector?: string; value?: string; wait?: number },
  ctx: ChatContext,
  cookieKey?: string
): Promise<ToolResult> {
  const { sandbox, kv, traceLog } = ctx;
  tracerSpan(ctx, 'browser_automation', { type: action.type });

  // 延长沙箱超时到 30 分钟
  if (sandbox?.extendTimeout) {
    tracerSpan(ctx, 'browser_automation', { extendTimeout: 1800 });
    await sandbox.extendTimeout(1800);
  }

  // ==================== Cookies 恢复 ====================
  if (kv && cookieKey) {
    const savedCookies = await kv.getSetting(`browser_cookies:${cookieKey}`);
    if (savedCookies) {
      tracerSpan(ctx, 'cookies', { action: 'restoring' });
      const restored = await restoreBrowserCookies(sandbox, savedCookies, traceLog);
      if (restored) {
        tracerSpan(ctx, 'cookies', { status: 'restored' });
      } else {
        await kv.setSetting(`browser_cookies:${cookieKey}`, '');
        tracerSpan(ctx, 'cookies', { status: 'expired_cleared' });
      }
    }
  }

  try {
    let result: unknown;

    switch (action.type) {
      case 'goto':
        if (!action.url) throw new Error('URL 不能为空');
        tracerSpan(ctx, 'browser.goto', { url: action.url });
        if (sandbox?.browser?.goto) {
          await sandbox.browser.goto(action.url, { waitUntil: 'networkidle' });
        }
        result = `已导航到 ${action.url}`;
        break;

      case 'click':
        if (!action.selector) throw new Error('选择器不能为空');
        tracerSpan(ctx, 'browser.click', { selector: action.selector });
        if (sandbox?.browser?.click) {
          await sandbox.browser.click(action.selector);
        }
        result = `已点击 ${action.selector}`;
        break;

      case 'type':
        if (!action.selector || !action.value) throw new Error('选择器和输入值不能为空');
        tracerSpan(ctx, 'browser.type', { selector: action.selector });
        if (sandbox?.browser?.type) {
          await sandbox.browser.type(action.selector, action.value);
        }
        result = `已在 ${action.selector} 输入内容`;
        break;

      case 'screenshot':
        tracerSpan(ctx, 'browser.screenshot');
        if (sandbox?.browser?.screenshot) {
          result = await sandbox.browser.screenshot({ fullPage: true });
        } else {
          result = `截图已完成，图片数据已返回`;
        }
        break;

      case 'getContent':
        tracerSpan(ctx, 'browser.getContent');
        if (sandbox?.browser?.getContent) {
          result = await sandbox.browser.getContent();
        } else {
          result = `页面内容获取完成`;
        }
        break;

      default:
        throw new Error(`不支持的操作类型: ${action.type}`);
    }

    if (action.wait && action.wait > 0) {
      tracerSpan(ctx, 'browser.wait', { ms: action.wait });
      await new Promise((resolve) => setTimeout(resolve, action.wait));
    }

    // ==================== Cookies 保存 ====================
    if (kv && cookieKey) {
      await saveBrowserCookies(sandbox, kv, `browser_cookies:${cookieKey}`, traceLog);
    }

    // ===== 检测验证码/二次验证 =====
    const hasChallenge = await detectLoginChallenge(sandbox, traceLog);
    if (hasChallenge) {
      let liveUrl = '';
      if (sandbox?.browser?.liveUrl) {
        const urlResult = await sandbox.browser.liveUrl;
        liveUrl = typeof urlResult === 'string' ? urlResult : urlResult?.url || '';
      }
      tracerSpan(ctx, 'browser_automation', { captchaDetected: true, liveUrl });
      return {
        success: true,
        data: {
          message: result,
          captcha_detected: true,
          live_url: liveUrl,
          tip: '登录遇到了验证码或二次验证。请打开上面的浏览器画面链接，手动完成验证，然后回到这里告诉我"已通过验证"。',
        },
        traceLog: ctx.traceLog,
      };
    }

    tracerSpan(ctx, 'browser_automation', { status: 'completed' });
    return { success: true, data: result, traceLog: ctx.traceLog };
  } catch (error) {
    tracerSpan(ctx, 'browser_automation', { error: (error as Error).message });
    return { success: false, data: null, error: (error as Error).message, traceLog: ctx.traceLog };
  }
}

// ==================== 定时任务与凭证 ====================

async function scheduleTask(
  params: {
    name: string;
    cron: string;
    action: string;
    params: Record<string, unknown>;
    notify_email?: string;
    status?: string;
    task_id?: string;
  },
  ctx: ChatContext
): Promise<ToolResult> {
  const { kv, userId } = ctx;

  // 管理已有任务（暂停/恢复）
  if (params.task_id && params.status) {
    tracerSpan(ctx, 'schedule_task', { action: 'update_status', task_id: params.task_id, status: params.status });
    await kv.updateTask(params.task_id, { status: params.status as ScheduledTask['status'] });
    return {
      success: true,
      data: {
        task_id: params.task_id,
        status: params.status === 'paused' ? '已暂停' : '已恢复',
        message: `定时任务已${params.status === 'paused' ? '暂停' : '恢复'}`,
      },
      traceLog: ctx.traceLog,
    };
  }

  // 创建新任务
  tracerSpan(ctx, 'schedule_task', { action: 'create', name: params.name });
  const cron = parseCronDescription(params.cron);

  const task: ScheduledTask = {
    id: generateId(),
    user_id: userId,
    name: params.name,
    cron,
    action: params.action as ScheduledTask['action'],
    params: params.params,
    status: 'active',
    notify_email: params.notify_email || '',
    created_at: Date.now(),
    updated_at: Date.now(),
    last_run_at: null,
  };

  await kv.createTask(task);
  tracerSpan(ctx, 'schedule_task', { taskId: task.id });

  return {
    success: true,
    data: {
      task_id: task.id,
      status: 'created',
      cron,
      message: `定时任务「${params.name}」已创建成功！\nCron 表达式: ${cron}\n任务将在后台自动执行，结果可到管理面板查看。`,
    },
    traceLog: ctx.traceLog,
  };
}

async function saveCredentials(
  params: {
    task_id: string;
    username: string;
    password: string;
    login_url: string;
    username_selector: string;
    password_selector: string;
    submit_selector: string;
  },
  ctx: ChatContext
): Promise<ToolResult> {
  tracerSpan(ctx, 'save_credentials', { task: params.task_id });

  try {
    await ctx.kv.saveBrowserCreds(
      params.task_id,
      {
        username: params.username,
        password: params.password,
        loginUrl: params.login_url,
        usernameSelector: params.username_selector,
        passwordSelector: params.password_selector,
        submitSelector: params.submit_selector,
      },
      ctx.env.CRON_SECRET || 'default-key'
    );
    tracerSpan(ctx, 'save_credentials', { status: 'saved' });
    return {
      success: true,
      data: {
        message: `登录凭证已加密保存。下次执行定时任务时，如果 Cookie 失效，将自动使用保存的账号密码重新登录。\n登录地址: ${params.login_url}\n\u26a0\ufe0f 密码已加密存储，仅用于自动登录。`,
      },
      traceLog: ctx.traceLog,
    };
  } catch (e) {
    tracerSpan(ctx, 'save_credentials', { error: (e as Error).message });
    return {
      success: false,
      data: null,
      error: `保存凭证失败: ${(e as Error).message}`,
      traceLog: ctx.traceLog,
    };
  }
}

// ==================== 辅助函数 ====================

/**
 * 解析中文 cron 描述为标准 cron 表达式
 */
function parseCronDescription(desc: string): string {
  const lower = desc.toLowerCase();

  if (/^\d/.test(lower) && /\*/.test(lower)) return desc; // 已经是 cron

  if (lower.includes('每分钟') || lower === '每分钟') return '* * * * *';

  if (lower.includes('每') && lower.includes('小时')) {
    const match = lower.match(/(\d+)/);
    if (match) return `*/${match[1]} * * * *`;
    return '0 * * * *';
  }

  if (lower.includes('每天') || lower.includes('每日')) {
    const match = lower.match(/(\d+)/g);
    const hour = match ? match[0].padStart(2, '0') : '09';
    const minute = match && match.length > 1 ? match[1].padStart(2, '0') : '00';
    return `${minute} ${hour} * * *`;
  }

  if (lower.includes('每周') || lower.includes('每星期')) {
    const match = lower.match(/(\d+)/g);
    const hour = match ? match[0].padStart(2, '0') : '09';
    const minute = match && match.length > 1 ? match[1].padStart(2, '0') : '00';
    const dayMap: Record<string, string> = {
      '周一': '1', '周二': '2', '周三': '3', '周四': '4',
      '周五': '5', '周六': '6', '周日': '0', '星期天': '0',
    };
    let day = '1';
    for (const [key, val] of Object.entries(dayMap)) {
      if (lower.includes(key)) { day = val; break; }
    }
    return `${minute} ${hour} * * ${day}`;
  }

  return '* * * * *';
}

// ==================== Token 用量记录 ====================

/**
 * 记录单次 LLM 调用的 token 用量
 * 静默失败，不影响主流程
 */
async function recordUsage(kv: KVStore | undefined, usage: LLMResponse['usage'], model: string | undefined) {
  if (!kv?.recordTokenUsage || !usage) return;
  try {
    await kv.recordTokenUsage(usage, model);
  } catch { /* token 统计失败不影响主流程 */ }
}

// ==================== LLM 调用 ====================

/**
 * 调用大模型（优先走 EdgeOne 模型网关，可动态切换模型）
 *
 * 模型来源（优先级从高到低）：
 * 1. KV 设置 ai_model（后台管理面板可改）
 * 2. 环境变量 AI_MODEL
 * 3. 硬编码兜底 deepseek-chat
 *
 * API 地址来源：
 * 1. 环境变量 AI_GATEWAY_BASE_URL（平台模型网关，推荐）
 * 2. 兜底直调 api.deepseek.com
 *
 * 返回值：
 * - 始终返回 { content, toolCalls? }
 * - streaming 模式下：content 通过 onStream 逐字推送，返回值中包含完整内容
 * - 非 streaming 模式下：content 和 toolCalls 从 JSON 响应中解析
 */
async function callLLM(
  messages: { role: string; content: string }[],
  env: Record<string, string>,
  kv?: KVStore,
  onStream?: (chunk: string) => void,
  abortSignal?: AbortSignal
): Promise<LLMResponse> {
  // 动态获取模型名
  let model = '@makers/deepseek-v4-flash';
  try {
    if (kv?.getSetting) {
      const setting = await kv.getSetting('ai_model');
      if (setting) model = setting;
    }
  } catch { /* KV 读取失败用兜底 */ }
  model = model || env.AI_MODEL || '@makers/deepseek-v4-flash';

  // API 地址
  const baseUrl = env.AI_GATEWAY_BASE_URL || 'https://api.deepseek.com';
  const apiKey = env.AI_GATEWAY_API_KEY || env.DEEPSEEK_API_KEY || '';
  // 如果 baseUrl 已以 /v1 结尾（如 EdgeOne AI Gateway），不重复拼接
  const apiUrl = baseUrl.replace(/\/+$/, '').endsWith('/v1')
    ? `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    : `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  const body = {
    model,
    messages,
    stream: !!onStream,
    tools: TOOL_DEFINITIONS,
    tool_choice: 'auto' as const,
    max_tokens: 4096,
    temperature: 0.7,
  };

  const fetchSignal = abortSignal || createTimeoutSignal(60000);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: fetchSignal,
    });

    if (!response.ok) {
      const errText = await response.text();
      logError(SRC, { msg: 'llm api error', status: response.status, err: errText.slice(0, 200), model });
      throw new Error(`LLM API 错误 (${response.status}): ${errText}`);
    }

    if (onStream) {
      // ===== 流式模式：逐字推送 + 累加 tool_calls =====
      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取响应流');
      const decoder = new TextDecoder();
      let fullContent = '';
      // 流式响应中最后一个 chunk 通常包含 usage（OpenAI 标准）
      let lastUsage: any = undefined;

      // 按 index 累加 tool_calls delta
      const toolCallsAcc: Record<number, { id: string; name: string; arguments: string }> = {};

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter((l) => l.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
              // 文本内容：逐字推送
              if (delta.content) {
                fullContent += delta.content;
                onStream(delta.content);
              }

              // 工具调用：按 index 累加
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsAcc[idx]) {
                    toolCallsAcc[idx] = { id: '', name: '', arguments: '' };
                  }
                  if (tc.id) toolCallsAcc[idx].id = tc.id;
                  if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
                  if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
                }
              }
            }

            // 流式响应尾部可能带 usage（放在 choices 之外）
            if (parsed.usage) {
              lastUsage = parsed.usage;
            }
          } catch {
            // 忽略单行解析错误
          }
        }
      }

      // 将累加的 tool_calls 转为标准格式
      const toolCalls: ToolCall[] = Object.values(toolCallsAcc)
        .filter((tc) => tc.name)
        .map((tc) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.arguments || '{}'); } catch { /* 参数解析失败用空对象 */ }
          return { name: tc.name, arguments: args };
        });

      return {
        content: fullContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: lastUsage ? {
          prompt_tokens: lastUsage.prompt_tokens || 0,
          completion_tokens: lastUsage.completion_tokens || 0,
          total_tokens: lastUsage.total_tokens || 0,
        } : undefined,
        model,
      };
    }

    // ===== 非流式模式 =====
    const data = await response.json();
    const choice = data.choices?.[0];
    const usage = data.usage ? {
      prompt_tokens: data.usage.prompt_tokens || 0,
      completion_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    } : undefined;

    if (choice?.message?.tool_calls) {
      const toolCalls: ToolCall[] = choice.message.tool_calls.map((tc: any) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));
      return { content: choice.message.content || '', toolCalls, usage, model };
    }

    return { content: choice?.message?.content || '', usage, model };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error('请求已取消');
    }
    throw new Error(`LLM 调用失败: ${(error as Error).message}`);
  }
}

// ==================== 工具定义（OpenAI Tool Schema） ====================

const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: '联网搜索信息，如查询天气、新闻、百科知识等实时信息',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，应尽量具体明确' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_code',
      description: '执行 Python 或 JavaScript 代码，用于计算、数据处理、运行脚本等',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的代码内容' },
          language: { type: 'string', enum: ['python', 'javascript'], description: '代码语言' },
        },
        required: ['code', 'language'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_automation',
      description: '控制浏览器执行自动化操作，如登录网站、点击按钮、截图、抓取页面内容',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'object',
            description: '浏览器操作指令',
            properties: {
              type: { type: 'string', enum: ['goto', 'click', 'type', 'screenshot', 'getContent'], description: '操作类型' },
              url: { type: 'string', description: '目标 URL（仅 goto 类型需要）' },
              selector: { type: 'string', description: 'CSS 选择器' },
              value: { type: 'string', description: '输入的值（仅 type 类型需要）' },
              wait: { type: 'number', description: '操作后等待时间（毫秒）' },
            },
            required: ['type'],
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'schedule_task',
      description: '创建或管理定时任务。当用户指令包含时间周期词（每天、每周、每小时等）时使用此工具创建定时任务，不得当场执行任务内容。也可用于暂停/恢复已有任务。如果这是一个需要登录网站的 browser_automation 任务，记得询问用户账号密码，然后用 save_credentials 工具保存。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称，应简要描述任务内容' },
          cron: { type: 'string', description: '运行周期，支持中文描述（如"每天 9 点"、"每隔一小时"）或标准 cron 表达式' },
          action: { type: 'string', enum: ['browser_automation', 'execute_code', 'web_search'], description: '要执行的动作类型' },
          params: { type: 'object', description: '动作参数，根据 action 类型传入对应参数' },
          notify_email: { type: 'string', description: '可选，执行结果通知邮箱' },
          task_id: { type: 'string', description: '管理已有任务时传入的任务 ID' },
          status: { type: 'string', enum: ['active', 'paused'], description: '管理已有任务时设置的新状态' },
        },
        required: ['name', 'cron', 'action', 'params'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'save_credentials',
      description: '保存网站登录凭证，用于定时任务自动登录。当用户创建了需要登录的 browser_automation 任务并提供了账号密码时，调用此工具保存。凭证会加密存储。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '定时任务的 ID（由 schedule_task 返回）' },
          username: { type: 'string', description: '登录用户名' },
          password: { type: 'string', description: '登录密码' },
          login_url: { type: 'string', description: '登录页面的 URL' },
          username_selector: { type: 'string', description: '用户名输入框的 CSS 选择器，例如 input[name=user]' },
          password_selector: { type: 'string', description: '密码输入框的 CSS 选择器，例如 input[name=pass]' },
          submit_selector: { type: 'string', description: '登录按钮的 CSS 选择器，例如 button[type=submit]' },
        },
        required: ['task_id', 'username', 'password', 'login_url', 'username_selector', 'password_selector', 'submit_selector'],
      },
    },
  },
];

// ==================== 工具路由 ====================

async function executeTool(
  toolCall: ToolCall,
  ctx: ChatContext
): Promise<ToolResult> {
  const { conversationId, userId } = ctx;
  const t0 = Date.now();

  log(SRC, { msg: 'tool call', userId, convId: conversationId, tool: toolCall.name });

  let result: ToolResult;
  switch (toolCall.name) {
    case 'web_search':
      result = await webSearch(toolCall.arguments.query as string, ctx);
      break;
    case 'execute_code':
      result = await executeCode(toolCall.arguments.code as string, toolCall.arguments.language as string, ctx);
      break;
    case 'browser_automation':
      result = await browserAction(toolCall.arguments.action as any, ctx, conversationId);
      break;
    case 'schedule_task':
      result = await scheduleTask(toolCall.arguments as any, ctx);
      break;
    case 'save_credentials':
      result = await saveCredentials(toolCall.arguments as any, ctx);
      break;
    default:
      tracerSpan(ctx, 'execute_tool', { error: `未知工具: ${toolCall.name}` });
      result = {
        success: false,
        data: null,
        error: `未知工具: ${toolCall.name}`,
        traceLog: ctx.traceLog,
      };
  }

  if (result.success) {
    log(SRC, { msg: 'tool ok', userId, convId: conversationId, tool: toolCall.name, dur: Date.now() - t0 });
  } else {
    logError(SRC, { msg: 'tool fail', userId, convId: conversationId, tool: toolCall.name, err: result.error, dur: Date.now() - t0 });
  }

  return result;
}

// ==================== Agent 主入口 ====================

/**
 * Agent 主处理函数
 *
 * 接收用户消息，执行智能路由，通过 SSE 流式返回结果。
 *
 * 2024-07 改进：SSE 模式现在真正流式输出 LLM 回复内容。
 * 逐字推送 delta content 到客户端，而非等完整回复后一次性发送。
 * 同时支持 AbortSignal 中断——客户端断开后自动取消 LLM 调用和 KV 写入。
 */
export async function onRequest(context: any) {
  const { request, env } = context;
  const t0 = Date.now();

  // 支持 SSE 流式响应（header 名大小写无关）
  const isSSE = getHeader(request, 'accept') === 'text/event-stream';

  // 内部鉴权：直接读取 Cookie 并验证 JWT
  const cookieHeader = getHeader(request, 'cookie');
  const cookies = parseCookies(cookieHeader);
  const token = cookies['ai_assistant_token'];
  const payload = token ? await getUserFromRequest({ headers: { get: (k: string) => k.toLowerCase() === 'cookie' ? cookieHeader : null } } as any, env.JWT_SECRET) : null;
  const userId = payload?.user_id;

  // 使用平台 Makers-Conversation-Id 请求头（大小写无关）
  const conversationId =
    getHeader(request, 'makers-conversation-id') ||
    context.conversation_id ||
    request.query?.conversation_id ||
    generateId();

  if (!userId) {
    log(SRC, { msg: 'agent rejected', reason: 'unauthorized', convId: conversationId, mode: isSSE ? 'sse' : 'json', dur: Date.now() - t0 });
    return new Response(JSON.stringify({ error: '未登录' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // EdgeOne Agent 的 request 是普通对象（无 .json() 方法），需手动解析 body
    let body: any = {};
    try {
      if (typeof request.json === 'function') {
        body = await request.json();
      } else if (typeof request.body === 'string') {
        body = JSON.parse(request.body);
      } else if (request.body) {
        body = request.body;
      }
    } catch { /* body 解析失败时用空对象 */ }
    const { message } = body;
    if (!message || typeof message !== 'string') {
      log(SRC, { msg: 'agent rejected', reason: 'empty message', userId, convId: conversationId, dur: Date.now() - t0 });
      return new Response(JSON.stringify({ error: '消息内容不能为空' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    log(SRC, { msg: 'agent start', userId, convId: conversationId, mode: isSSE ? 'sse' : 'json', inputLen: message.length, inputPreview: message.slice(0, 80) });

    const kv = new KVStore(env.AI_ASSISTANT_KV);
    const traceLog: string[] = [];
    const sandbox = context.sandbox;
    const store = context.store;
    const tracer = context.tracer;
    const signal = request.signal; // 用于 SSE 断开检测

    const ctx: ChatContext = {
      userId, conversationId, kv, traceLog, env, sandbox, store, tracer, signal,
    };

    if (isSSE) {
      return handleSSEStream(message, ctx);
    }

    return handleJSONResponse(message, ctx);
  } catch (e) {
    logError(SRC, { msg: 'agent error', userId, convId: conversationId, err: (e as Error).message, dur: Date.now() - t0 });
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ==================== JSON 模式（非流式） ====================

async function handleJSONResponse(message: string, ctx: ChatContext) {
  const { kv, conversationId, userId, traceLog } = ctx;

  // 保存用户消息
  await saveMessage(ctx, { role: 'user', content: message, id: generateId() });

  // 自动创建或更新对话标题
  const conv = await kv.getConversation(conversationId);
  if (!conv) {
    await kv.createConversation({
      id: conversationId,
      user_id: userId,
      title: message.slice(0, 20) + (message.length > 20 ? '...' : ''),
      created_at: Date.now(),
      updated_at: Date.now(),
      message_count: 1,
    });
  } else {
    await kv.updateConversation(conversationId, {});
  }

  // 获取历史消息
  const history = await loadHistory(ctx);
  const llmMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ];

  try {
    // 调用 LLM（非流式）
    const { content, toolCalls, usage, model } = await callLLM(llmMessages, ctx.env, ctx.kv);
    recordUsage(ctx.kv, usage, model);

    let finalResponse = content;
    let intermediateStates: IntermediateState[] = [];

    if (toolCalls && toolCalls.length > 0) {
      // 记录中间状态
      if (content) {
        intermediateStates.push({
          type: 'thinking',
          message: content,
          timestamp: Date.now(),
        });
      }

      // 执行工具
      const toolResults: string[] = [];
      for (const tc of toolCalls) {
        tracerSpan(ctx, 'execute_tool', { name: tc.name });
        intermediateStates.push({
          type: 'executing',
          message: `正在执行: ${tc.name}...`,
          timestamp: Date.now(),
        });
        const result = await executeTool(tc, ctx);
        const resultStr = result.success
          ? typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
          : result.error || '执行失败';
        toolResults.push(`[${tc.name}] ${result.success ? '成功' : '失败'}: ${resultStr}`);
      }

      // 将工具结果返回给 LLM 生成最终回复
      const finalMessages = [
        ...llmMessages,
        { role: 'assistant', content: content || '' },
        { role: 'user', content: `工具执行结果:\n${toolResults.join('\n')}\n请基于这些结果给用户一个完整的回复。` },
      ];

      const { content: finalContent, usage: usage2, model: model2 } = await callLLM(finalMessages, ctx.env, ctx.kv);
      recordUsage(ctx.kv, usage2, model2);
      finalResponse = finalContent;
    }

    // 保存助手消息
    await saveMessage(ctx, { role: 'assistant', content: finalResponse, id: generateId() });

    log(SRC, { msg: 'agent complete', userId, convId: conversationId, mode: 'json', replyLen: finalResponse.length, hadTools: intermediateStates.length > 0 });
    return new Response(
      JSON.stringify({
        message: finalResponse,
        conversation_id: conversationId,
        intermediate_states: intermediateStates,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (e) {
    logError(SRC, { msg: 'agent json fail', userId, convId: conversationId, err: (e as Error).message });
    return new Response(
      JSON.stringify({ error: (e as Error).message, conversation_id: conversationId }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ==================== SSE 流式模式（已改进为真流式） ====================

/**
 * SSE 流式模式处理
 *
 * 改进后流程：
 * 1. 流式调用 LLM，逐字推送 delta content 到客户端（真流式）
 * 2. 同时累加 tool_calls delta
 * 3. 如果有工具调用 → 执行工具 → 再次流式调用 LLM 生成最终回复
 * 4. 全程监听 AbortSignal，客户端断开后立刻清理资源
 */
async function handleSSEStream(message: string, ctx: ChatContext) {
  const { kv, conversationId, userId, traceLog, signal } = ctx;

  // 保存用户消息
  await saveMessage(ctx, { role: 'user', content: message, id: generateId() });

  // 创建或更新对话
  const conv = await kv.getConversation(conversationId);
  if (!conv) {
    await kv.createConversation({
      id: conversationId,
      user_id: userId,
      title: message.slice(0, 20) + (message.length > 20 ? '...' : ''),
      created_at: Date.now(),
      updated_at: Date.now(),
      message_count: 1,
    });
  }

  // 构造 SSE 流
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let fullContent = '';
      let aborted = false;

      // 监听客户端断开
      if (signal) {
        signal.addEventListener('abort', () => { aborted = true; });
      }

      const sendSSE = (event: string, data: string) => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          aborted = true; // 写入失败视为断开
        }
      };

      const checkAborted = (): boolean => {
        if (aborted || signal?.aborted) {
          aborted = true;
          return true;
        }
        return false;
      };

      try {
        // 获取历史消息
        const history = await loadHistory(ctx);
        const llmMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history,
        ];

        // ===== 第一步：流式调用 LLM（真流式逐字推送）=====
        sendSSE('state', JSON.stringify({ type: 'thinking', message: '正在分析你的需求...' }));

        if (checkAborted()) { controller.close(); return; }

        const { content: initialContent, toolCalls, usage, model } = await callLLM(
          llmMessages,
          ctx.env,
          ctx.kv,
          // onStream: 逐字推送 LLM 回复到客户端
          (delta: string) => {
            sendSSE('message', JSON.stringify({ content: delta }));
          },
          signal
        );
        if (!aborted) recordUsage(ctx.kv, usage, model);

        if (checkAborted()) { controller.close(); return; }

        if (toolCalls && toolCalls.length > 0) {
          // ===== 第二步：执行工具调用 =====
          const toolExecutionResults: { name: string; data: unknown; success: boolean }[] = [];

          for (const tc of toolCalls) {
            if (checkAborted()) { controller.close(); return; }

            tracerSpan(ctx, 'execute_tool', { name: tc.name });
            sendSSE('state', JSON.stringify({
              type: 'executing',
              message: `正在执行: ${tc.name}...`,
            }));

            const result = await executeTool(tc, ctx);

            toolExecutionResults.push({
              name: tc.name,
              data: result.data,
              success: result.success,
            });

            if (result.success) {
              sendSSE('state', JSON.stringify({
                type: 'result',
                message: `${tc.name} 执行完成`,
                data: result.data,
              }));
            } else {
              sendSSE('state', JSON.stringify({
                type: 'error',
                message: `${tc.name} 执行失败: ${result.error}`,
              }));
            }
          }

          if (checkAborted()) { controller.close(); return; }

          // ===== 第三步：流式调用 LLM 生成最终回复 =====
          const executionSummary = toolExecutionResults.map(
            (r) => `[${r.name}] ${r.success ? '成功' : '失败'}: ${
              typeof r.data === 'string' ? r.data : JSON.stringify(r.data)
            }`
          ).join('\n');

          const finalMessages = [
            ...llmMessages,
            { role: 'assistant', content: initialContent || '' },
            {
              role: 'user',
              content: `工具执行结果:\n${executionSummary}\n请基于这些结果给用户一个完整的回复。`,
            },
          ];

          sendSSE('state', JSON.stringify({ type: 'thinking', message: '正在生成最终回复...' }));

          const { content: finalContent, usage: usage2, model: model2 } = await callLLM(
            finalMessages,
            ctx.env,
            ctx.kv,
            // onStream: 最终回复也逐字推送
            (delta: string) => {
              sendSSE('message', JSON.stringify({ content: delta }));
            },
            signal
          );
          if (!aborted) recordUsage(ctx.kv, usage2, model2);

          fullContent = finalContent;
        } else {
          // 纯文本回复，无工具调用
          fullContent = initialContent;
        }

        if (checkAborted()) { controller.close(); return; }

        // 保存助手消息
        // 注意：如果客户端已断开则跳过 KV 写入，节省资源
        await saveMessage(ctx, { role: 'assistant', content: fullContent, id: generateId() });

        log(SRC, { msg: 'agent complete', userId, convId: conversationId, mode: 'sse', replyLen: fullContent.length });
        sendSSE('done', JSON.stringify({ conversation_id: conversationId }));
      } catch (e) {
        if (aborted) {
          log(SRC, { msg: 'agent sse aborted', userId, convId: conversationId });
        } else {
          logError(SRC, { msg: 'agent sse fail', userId, convId: conversationId, err: (e as Error).message });
          sendSSE('error', JSON.stringify({ error: (e as Error).message }));
        }
      } finally {
        try { controller.close(); } catch { /* 已关闭 */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
