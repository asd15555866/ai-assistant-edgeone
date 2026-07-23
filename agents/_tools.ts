/**
 * Agent Tool Registry
 * ====================
 *
 * 按照官方模板（TencentEdgeOne/node-agent-starter）的方案：
 * 从 context.tools.all() 动态加载 EdgeOne 平台原生工具，
 * descriptions 由 EdgeOne 工程师为 -flash 模型调优。
 *
 * 设计要点（来自官方模板）：
 * 1. **手动挑选字段**，不要 spread item — 防止网关静默拒绝
 * 2. **降级兼容**：name/description/parameters 字段名多源 fallback
 * 3. **同步/异步 handler 透明**
 *
 * 自定义工具（schedule_task、save_credentials、web_search）：
 * 平台不提供这些，自己注册到同一个 registry
 */

type ToolSchema = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
};

type ToolHandler = (args: any) => Promise<any> | any;

export class ToolRegistry {
  private schemas: ToolSchema[] = [];
  private handlers: Map<string, ToolHandler> = new Map();

  /** 是否注册了任何工具 */
  hasTools(): boolean {
    return this.schemas.length > 0;
  }

  /** 注册一个工具（同名只注册一次） */
  register(schema: ToolSchema, handler: ToolHandler): void {
    const name = schema.function.name;
    if (this.handlers.has(name)) return; // 同名不重复注册
    this.schemas.push(schema);
    this.handlers.set(name, handler);
  }

  /** 转为 OpenAI function-calling 格式的 tools 数组 */
  toOpenAITools(): ToolSchema[] {
    return this.schemas;
  }

  /** 执行工具，返回 { success, data, error } */
  async execute(
    name: string,
    args: any
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return { success: false, error: `Unknown tool: ${name}` };
    }
    try {
      const parsedArgs = typeof args === 'string' ? JSON.parse(args || '{}') : args;
      const result = await handler(parsedArgs);
      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }
}

/**
 * 构造工具注册表：合并 EdgeOne 平台原生工具 + 自定义工具
 */
export function buildToolRegistry(context: any, customTools: Record<string, { schema: Omit<ToolSchema, 'type'>; handler: ToolHandler }>): ToolRegistry {
  const registry = new ToolRegistry();

  // 1. 从 EdgeOne 平台沙箱加载原生工具
  if (context?.tools?.all && typeof context.tools.all === 'function') {
    const rawTools = context.tools.all();
    for (const item of rawTools || []) {
      // 多源 fallback 字段名
      const name: string = item?.name ?? item?.function?.name;
      const handler: any = item?.execute ?? item?.handler ?? item?.invoke;
      if (!name || typeof handler !== 'function') continue;

      const description = item?.function?.description ?? item?.description ?? '';
      const parameters =
        item?.function?.parameters ??
        item?.parameters ??
        item?.inputSchema ??
        item?.input_schema ??
        { type: 'object', properties: {} };

      // ⚠️ 关键：手动挑选字段重建 schema，绝不 ...item 展开
      // EdgeOne 工具对象带 execute/inputSchema/type='tool' 等额外字段，
      // 严格网关会静默丢弃整个 tools 数组
      registry.register(
        { type: 'function', function: { name, description, parameters } },
        async (args: any) => handler(args)
      );
    }
  }

  // 2. 注册自定义工具（schedule_task、save_credentials 等平台没有的）
  for (const [name, { schema, handler }] of Object.entries(customTools)) {
    registry.register({ type: 'function', function: schema }, handler);
  }

  return registry;
}

/**
 * 自定义工具集合（平台不提供，需要我们自己实现）
 */
export function getCustomTools(ctx: any): Record<string, { schema: Omit<ToolSchema, 'type'>; handler: ToolHandler }> {
  return {
    web_search: {
      schema: {
        name: 'web_search',
        description: 'Search the web for current information: news, weather, prices, current events. Examples: "今天合肥天气", "iPhone 16 价格". NOT for math calculations.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keywords' },
          },
          required: ['query'],
        },
      },
      handler: async (args: any) => {
        // 调 DuckDuckGo
        const query = args?.query || '';
        try {
          const res = await fetch(
            `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
            { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined as any }
          );
          if (!res.ok) {
            return `搜索「${query}」暂时不可用，请稍后再试。`;
          }
          const data: any = await res.json();
          const results: string[] = [];
          if (data.AbstractText) results.push(data.AbstractText);
          if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
            for (const topic of data.RelatedTopics.slice(0, 5)) {
              if (typeof topic === 'object' && topic.Text) {
                results.push(`- ${topic.Text}`);
              }
            }
          }
          return results.length > 0
            ? results.join('\n')
            : `未找到关于「${query}」的详细结果。`;
        } catch {
          return `搜索「${query}」暂时不可用，请稍后再试。`;
        }
      },
    },

    schedule_task: {
      schema: {
        name: 'schedule_task',
        description: 'Create or manage a scheduled task. Use when user request contains time-period keywords (every day/week/hour, recurring, 每天/每周/每隔/定时). DO NOT execute the task immediately — only schedule it.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Task name' },
            cron: { type: 'string', description: 'Cron expression or Chinese description (e.g. "每天 9 点", "每隔一小时")' },
            action: { type: 'string', enum: ['browser_automation', 'execute_code', 'web_search'], description: 'Action type to execute' },
            params: { type: 'object', description: 'Action-specific parameters' },
            notify_email: { type: 'string', description: 'Optional notification email' },
            task_id: { type: 'string', description: 'Existing task ID (for management)' },
            status: { type: 'string', enum: ['active', 'paused'], description: 'New status (for management)' },
          },
          required: ['name', 'cron', 'action', 'params'],
        },
      },
      handler: async (args: any) => {
        const { kv } = ctx;
        if (!kv?.kv) return { error: 'KV not available' };

        // 管理已有任务（暂停/恢复）
        if (args.task_id && args.status) {
          await kv.updateTask(args.task_id, { status: args.status });
          return { task_id: args.task_id, status: args.status === 'paused' ? '已暂停' : '已恢复' };
        }

        // 创建新任务
        const task = {
          id: generateId(),
          user_id: ctx.userId,
          name: args.name,
          cron: args.cron,
          action: args.action,
          params: args.params,
          status: 'active' as const,
          notify_email: args.notify_email || '',
          created_at: Date.now(),
          updated_at: Date.now(),
          last_run_at: null,
        };
        await kv.createTask(task);
        return {
          task_id: task.id,
          status: 'created',
          cron: task.cron,
          message: `定时任务「${task.name}」已创建成功！`,
        };
      },
    },

    save_credentials: {
      schema: {
        name: 'save_credentials',
        description: 'Save website login credentials for scheduled tasks that need auto-login. Call after user provides username/password for a browser_automation task.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Scheduled task ID' },
            username: { type: 'string', description: 'Login username' },
            password: { type: 'string', description: 'Login password' },
            login_url: { type: 'string', description: 'Login page URL' },
            username_selector: { type: 'string', description: 'CSS selector for username input' },
            password_selector: { type: 'string', description: 'CSS selector for password input' },
            submit_selector: { type: 'string', description: 'CSS selector for submit button' },
          },
          required: ['task_id', 'username', 'password', 'login_url', 'username_selector', 'password_selector', 'submit_selector'],
        },
      },
      handler: async (args: any) => {
        const { kv, env } = ctx;
        if (!kv?.kv) return { error: 'KV not available' };
        await kv.saveBrowserCreds(
          args.task_id,
          {
            username: args.username,
            password: args.password,
            loginUrl: args.login_url,
            usernameSelector: args.username_selector,
            passwordSelector: args.password_selector,
            submitSelector: args.submit_selector,
          },
          env.CRON_SECRET || 'default-key'
        );
        return { message: '登录凭证已加密保存。' };
      },
    },
  };
}