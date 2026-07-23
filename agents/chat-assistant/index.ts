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
 * 工具来源：EdgeOne 平台原生工具 (context.tools.all()) + 自定义工具 (agents/_tools.ts)
 */
import { KVStore, Message, Conversation, ScheduledTask, IntermediateState, generateId } from '../../_shared/kv';
import { getUserFromRequest, parseCookies } from '../../_shared/jwt';
import { log, logError } from '../../_shared/logger';
import { createTimeoutSignal } from '../../_shared/abort';
import { buildToolRegistry, getCustomTools, ToolRegistry } from '../_tools';

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
  sandbox: any;
  store: any;
  tracer: any;
  signal?: AbortSignal;
};

// ==================== 辅助函数 ====================

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

async function saveMessage(ctx: ChatContext, msg: { role: string; content: string; id?: string }) {
  if (ctx.signal?.aborted) return;
  if (!ctx.kv?.kv) return;
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

async function loadHistory(ctx: ChatContext): Promise<{ role: string; content: string }[]> {
  if (!ctx.kv?.kv) return [];
  try {
    return (await ctx.kv.listConversationMessages(ctx.conversationId)).map(m => ({
      role: m.role,
      content: m.content,
    }));
  } catch {
    return [];
  }
}

function looksLikePromiseButNoTool(
  content: string,
  toolCalls: ToolCall[] | undefined
): boolean {
  if (toolCalls && toolCalls.length > 0) return false;
  if (!content || content.length < 5) return false;
  const promises = /(我来|让我|我先|马上|这就去|去|准备)?\s*(查|搜索|搜一搜|看看|搜搜|查询|抓取|截屏|截图|执行|跑一下|运行)/i;
  const filler = /^(好的|行|好)[，,:。\s]/;
  return promises.test(content) || (filler.test(content) && /(查|搜索|看看|搜搜|查询|抓取|执行)/.test(content));
}

// ==================== 系统提示词 ====================

const SYSTEM_PROMPT = [
  'You are an intelligent AI assistant. Your job is to understand the user\'s intent and use tools correctly.',
  '',
  'Rules:',
  '1. NEVER invent or simulate tool results. If you cannot call a tool, do not pretend to have done so.',
  '2. Real-time info (news, weather, prices) MUST come from a tool call. Do not guess.',
  '3. When a tool fails, state the failure clearly. Do not fabricate a fallback answer.',
  '4. For greetings or casual chat, reply naturally without calling any tool.',
  '5. For scheduled tasks (with time keywords like 每天/每周/定时), create via schedule_task. DO NOT execute the task immediately.',
  '6. For web searches, use the browser tool to open https://www.bing.com/search?q=关键词 and then extract results.',
  '7. Before calling a tool, briefly state what you are about to do. After getting the result, summarize for the user.',
  '8. If the user asks in Chinese, reply in Chinese. If in English, reply in English.',
].join('\n');

// ==================== Cron 解析 ====================

function parseCronDescription(desc: string): string {
  const lower = desc.toLowerCase();
  if (/^\d/.test(lower) && /\*/.test(lower)) return desc;
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

async function recordUsage(kv: KVStore | undefined, usage: LLMResponse['usage'], model: string | undefined) {
  if (!kv?.recordTokenUsage || !usage) return;
  try {
    await kv.recordTokenUsage(usage, model);
  } catch { /* token 统计失败不影响主流程 */ }
}

// ==================== LLM 调用 ====================

async function callLLM(
  messages: { role: string; content: string }[],
  env: Record<string, string>,
  kv?: KVStore,
  onStream?: (chunk: string) => void,
  abortSignal?: AbortSignal,
  tools?: any[]
): Promise<LLMResponse> {
  let model = '@makers/deepseek-v4-pro';
  try {
    if (kv?.getSetting) {
      const setting = await kv.getSetting('ai_model');
      if (setting) model = setting;
    }
  } catch { /* KV 读取失败用兜底 */ }
  model = model || env.AI_MODEL || '@makers/deepseek-v4-pro';

  const baseUrl = env.AI_GATEWAY_BASE_URL || 'https://api.deepseek.com';
  const apiKey = env.AI_GATEWAY_API_KEY || env.DEEPSEEK_API_KEY || '';
  const apiUrl = baseUrl.replace(/\/+$/, '').endsWith('/v1')
    ? `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    : `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  const body: any = {
    model,
    messages,
    stream: !!onStream,
    tool_choice: 'auto' as const,
    max_tokens: 1024,
    temperature: 0.9,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (onStream) body.stream_options = { include_usage: true };

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
      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取响应流');
      const decoder = new TextDecoder();
      let fullContent = '';
      let lastUsage: any = undefined;
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
              if (delta.content) {
                fullContent += delta.content;
                onStream(delta.content);
              }
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
            if (parsed.usage) lastUsage = parsed.usage;
          } catch { /* 忽略单行解析错误 */ }
        }
      }

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
    if ((error as Error).name === 'AbortError') throw new Error('请求已取消');
    throw new Error(`LLM 调用失败: ${(error as Error).message}`);
  }
}

// ==================== 工具路由 ====================

async function executeTool(
  toolCall: ToolCall,
  registry: ToolRegistry,
  ctx: ChatContext
): Promise<ToolResult> {
  const { conversationId, userId } = ctx;
  const t0 = Date.now();
  log(SRC, { msg: 'tool call', userId, convId: conversationId, tool: toolCall.name });

  const r = await registry.execute(toolCall.name, toolCall.arguments);

  const result: ToolResult = {
    success: r.success,
    data: r.data ?? null,
    error: r.success ? undefined : r.error,
    traceLog: ctx.traceLog,
  };

  if (result.success) {
    log(SRC, { msg: 'tool ok', userId, convId: conversationId, tool: toolCall.name, dur: Date.now() - t0 });
  } else {
    logError(SRC, { msg: 'tool fail', userId, convId: conversationId, tool: toolCall.name, err: result.error, dur: Date.now() - t0 });
  }
  return result;
}

// ==================== Agent 主入口 ====================

export async function onRequest(context: any) {
  const { request, env } = context;
  const t0 = Date.now();

  const isSSE = getHeader(request, 'accept') === 'text/event-stream';

  const cookieHeader = getHeader(request, 'cookie');
  const cookies = parseCookies(cookieHeader);
  const token = cookies['ai_assistant_token'];
  const payload = token ? await getUserFromRequest({ headers: { get: (k: string) => k.toLowerCase() === 'cookie' ? cookieHeader : null } } as any, env.JWT_SECRET) : null;
  const userId = payload?.user_id;

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
    const signal = request.signal;

    const ctx: ChatContext = {
      userId, conversationId, kv, traceLog, env, sandbox, store, tracer, signal,
    };

    if (isSSE) return handleSSEStream(message, ctx);
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

  await saveMessage(ctx, { role: 'user', content: message, id: generateId() });

  const conv = await kv.getConversation(conversationId);
  if (!conv) {
    await kv.createConversation({
      id: conversationId, user_id: userId,
      title: message.slice(0, 20) + (message.length > 20 ? '...' : ''),
      created_at: Date.now(), updated_at: Date.now(), message_count: 1,
    });
  } else {
    await kv.updateConversation(conversationId, {});
  }

  const history = await loadHistory(ctx);
  const llmMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ];

  const registry = buildToolRegistry(context, getCustomTools({ ...ctx, userId }));
  const tools = registry.toOpenAITools();

  try {
    let { content, toolCalls, usage, model } = await callLLM(llmMessages, ctx.env, ctx.kv, undefined, undefined, tools);
    recordUsage(ctx.kv, usage, model);

    if (looksLikePromiseButNoTool(content, toolCalls)) {
      tracerSpan(ctx, 'consistency_retry', { reason: 'promise_no_tool' });
      llmMessages.push({ role: 'assistant', content: content || '' });
      llmMessages.push({ role: 'user', content: '你没有真正调用任何工具就给出了回复。如需搜索，用浏览器打开 bing.com。闲聊就直说。请重试。' });
      const retry = await callLLM(llmMessages, ctx.env, ctx.kv, undefined, undefined, tools);
      recordUsage(ctx.kv, retry.usage, retry.model);
      content = retry.content;
      toolCalls = retry.toolCalls;
    }

    let finalResponse = content;
    let intermediateStates: IntermediateState[] = [];

    if (toolCalls && toolCalls.length > 0) {
      if (content) {
        intermediateStates.push({ type: 'thinking', message: content, timestamp: Date.now() });
      }

      const toolResults: string[] = [];
      for (const tc of toolCalls) {
        tracerSpan(ctx, 'execute_tool', { name: tc.name });
        intermediateStates.push({ type: 'executing', message: `正在执行: ${tc.name}...`, timestamp: Date.now() });
        const result = await executeTool(tc, registry, ctx);
        const resultStr = result.success
          ? typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
          : result.error || '执行失败';
        toolResults.push(`[${tc.name}] ${result.success ? '成功' : '失败'}: ${resultStr}`);
      }

      const finalMessages = [
        ...llmMessages,
        { role: 'assistant', content: content || '' },
        { role: 'user', content: `工具执行结果:\n${toolResults.join('\n')}\n请基于这些结果给用户一个完整的回复。` },
      ];

      const { content: finalContent, usage: usage2, model: model2 } = await callLLM(finalMessages, ctx.env, ctx.kv, undefined, undefined, tools);
      recordUsage(ctx.kv, usage2, model2);
      finalResponse = finalContent;
    }

    await saveMessage(ctx, { role: 'assistant', content: finalResponse, id: generateId() });

    log(SRC, { msg: 'agent complete', userId, convId: conversationId, mode: 'json', replyLen: finalResponse.length, hadTools: intermediateStates.length > 0 });
    return new Response(
      JSON.stringify({ message: finalResponse, conversation_id: conversationId, intermediate_states: intermediateStates }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    logError(SRC, { msg: 'agent json fail', userId, convId: conversationId, err: (e as Error).message });
    return new Response(
      JSON.stringify({ error: (e as Error).message, conversation_id: conversationId }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ==================== SSE 流式模式 ====================

async function handleSSEStream(message: string, ctx: ChatContext) {
  const { kv, conversationId, userId, traceLog, signal } = ctx;

  await saveMessage(ctx, { role: 'user', content: message, id: generateId() });

  const conv = await kv.getConversation(conversationId);
  if (!conv) {
    await kv.createConversation({
      id: conversationId, user_id: userId,
      title: message.slice(0, 20) + (message.length > 20 ? '...' : ''),
      created_at: Date.now(), updated_at: Date.now(), message_count: 1,
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let fullContent = '';
      let aborted = false;

      const registry = buildToolRegistry(context, getCustomTools({ ...ctx, userId }));
      const tools = registry.toOpenAITools();

      if (signal) {
        signal.addEventListener('abort', () => { aborted = true; });
      }

      const sendSSE = (event: string, data: string) => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch { aborted = true; }
      };

      const checkAborted = (): boolean => {
        if (aborted || signal?.aborted) { aborted = true; return true; }
        return false;
      };

      try {
        const history = await loadHistory(ctx);
        const llmMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history,
        ];

        sendSSE('state', JSON.stringify({ type: 'thinking', message: '正在分析你的需求...' }));
        if (checkAborted()) { controller.close(); return; }

        const { content: initialContent, toolCalls, usage, model } = await callLLM(
          llmMessages, ctx.env, ctx.kv,
          (delta: string) => { sendSSE('message', JSON.stringify({ content: delta })); },
          signal, tools
        );
        if (!aborted) recordUsage(ctx.kv, usage, model);
        if (checkAborted()) { controller.close(); return; }

        if (toolCalls && toolCalls.length > 0) {
          const toolExecutionResults: { name: string; data: unknown; success: boolean }[] = [];

          for (const tc of toolCalls) {
            if (checkAborted()) { controller.close(); return; }
            tracerSpan(ctx, 'execute_tool', { name: tc.name });
            sendSSE('state', JSON.stringify({ type: 'executing', message: `正在执行: ${tc.name}...` }));

            const result = await executeTool(tc, registry, ctx);
            toolExecutionResults.push({ name: tc.name, data: result.data, success: result.success });

            if (result.success) {
              sendSSE('state', JSON.stringify({ type: 'result', message: `${tc.name} 执行完成`, data: result.data }));
            } else {
              sendSSE('state', JSON.stringify({ type: 'error', message: `${tc.name} 执行失败: ${result.error}` }));
            }
          }

          if (checkAborted()) { controller.close(); return; }

          const executionSummary = toolExecutionResults.map(
            (r) => `[${r.name}] ${r.success ? '成功' : '失败'}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}`
          ).join('\n');

          const finalMessages = [
            ...llmMessages,
            { role: 'assistant', content: initialContent || '' },
            { role: 'user', content: `工具执行结果:\n${executionSummary}\n请基于这些结果给用户一个完整的回复。` },
          ];

          sendSSE('state', JSON.stringify({ type: 'thinking', message: '正在生成最终回复...' }));

          const { content: finalContent, usage: usage2, model: model2 } = await callLLM(
            finalMessages, ctx.env, ctx.kv,
            (delta: string) => { sendSSE('message', JSON.stringify({ content: delta })); },
            signal, tools
          );
          if (!aborted) recordUsage(ctx.kv, usage2, model2);
          fullContent = finalContent;
        } else {
          fullContent = initialContent;
        }

        if (checkAborted()) { controller.close(); return; }
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
