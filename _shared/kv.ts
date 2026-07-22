/**
 * EdgeOne KV 存储封装
 *
 * 提供统一的数据库操作接口，支持用户、对话、消息、定时任务、执行记录、设置等操作。
 *
 * 设计理由：
 * - 选择 KV 而非 Neon PostgreSQL：KV 在 EdgeOne 平台上延迟更低，无需额外数据库连接配置
 * - 每个实体类型用特定前缀区分，便于按前缀批量查询
 * - 提供完整的 CRUD + 分页 + 查询接口
 */

/**
 * EdgeOne 运行时无 crypto.randomUUID()，使用自定义 ID 生成函数。
 * 格式：时间戳(13位) + 4位随机数，保证唯一性且无需 crypto 支持。
 */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export type User = {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  created_at: number;
};

export type Conversation = {
  id: string;
  user_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
};

export type Message = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  intermediate_states?: IntermediateState[];
  created_at: number;
};

export type IntermediateState = {
  type: string;
  message: string;
  timestamp: number;
};

export type ScheduledTask = {
  id: string;
  user_id: string;
  name: string;
  cron: string;
  action: 'browser_automation' | 'execute_code' | 'web_search';
  params: Record<string, unknown>;
  status: 'active' | 'paused' | 'deleted';
  notify_email: string;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
};

export type TaskExecution = {
  id: string;
  task_id: string;
  status: 'success' | 'failed' | 'running';
  result_summary: string;
  error_message: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  trace_log: string[];
};

export type Setting = {
  key: string;
  value: string;
  updated_at: number;
};

const PREFIX = {
  user: 'user:',
  conversation: 'conv:',
  message: 'msg:',
  task: 'task:',
  execution: 'exec:',
  setting: 'setting:',
  userConversations: 'user_conv:',
  conversationMessages: 'conv_msg:',
  taskExecutions: 'task_exec:',
};

export class KVStore {
  private kv: any; // EdgeOne KV namespace

  constructor(kv: any) {
    this.kv = kv;
  }

  /**
   * 分页遍历所有 key（默认 limit=256，分批读取直到 complete=true）
   * 安全保护：最大 1000 页，防止 cursor 循环导致无限循环
   */
  private async _listAllKeys(prefix: string): Promise<string[]> {
    const allKeys: string[] = [];
    let cursor: string | undefined;
    let complete = false;
    let pageCount = 0;
    const MAX_PAGES = 1000;

    do {
      const result = await this.kv.list({ prefix, cursor });
      for (const item of result.keys) {
        allKeys.push(item.name);
      }
      cursor = result.cursor;
      complete = result.complete;
      pageCount++;
      // 安全保护：如果 KV 返回 complete=false 但 cursor 为空，强制退出
      if (!complete && !cursor) {
        break;
      }
      if (pageCount >= MAX_PAGES) {
        console.warn(`[KV] _listAllKeys 达到最大页数限制(${MAX_PAGES})，prefix=${prefix}`);
        break;
      }
    } while (!complete);

    return allKeys;
  }

  // ==================== 用户 ====================

  async createUser(user: User): Promise<void> {
    await this.kv.put(PREFIX.user + user.id, JSON.stringify(user));
    await this.kv.put(`username:${user.username}`, user.id);
  }

  async updateUserHash(userId: string, newHash: string): Promise<void> {
    const raw = await this.kv.get(PREFIX.user + userId);
    if (!raw) throw new Error('User not found');
    const user = JSON.parse(raw);
    user.password_hash = newHash;
    await this.kv.put(PREFIX.user + userId, JSON.stringify(user));
  }

  async getUser(id: string): Promise<User | null> {
    const raw = await this.kv.get(PREFIX.user + id);
    return raw ? JSON.parse(raw) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const id = await this.kv.get(`username:${username}`);
    if (!id) return null;
    return this.getUser(id);
  }

  async listUsers(): Promise<User[]> {
    const keys = await this._listAllKeys(PREFIX.user);
    const users = await Promise.all(
      keys.map((key: string) => this.kv.get(key))
    );
    return users.filter(Boolean).map((u: string) => JSON.parse(u));
  }

  // ==================== 对话 ====================

  async createConversation(conv: Conversation): Promise<void> {
    await this.kv.put(PREFIX.conversation + conv.id, JSON.stringify(conv));
    await this.kv.put(
      PREFIX.userConversations + conv.user_id + ':' + conv.id,
      conv.id
    );
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const raw = await this.kv.get(PREFIX.conversation + id);
    return raw ? JSON.parse(raw) : null;
  }

  async updateConversation(
    id: string,
    updates: Partial<Conversation>
  ): Promise<void> {
    const conv = await this.getConversation(id);
    if (!conv) throw new Error('Conversation not found');
    Object.assign(conv, updates, { updated_at: Date.now() });
    await this.kv.put(PREFIX.conversation + id, JSON.stringify(conv));
  }

  async deleteConversation(id: string): Promise<void> {
    const conv = await this.getConversation(id);
    if (!conv) return;
    await this.kv.delete(PREFIX.conversation + id);
    await this.kv.delete(
      PREFIX.userConversations + conv.user_id + ':' + id
    );
    // 删除关联消息（分页遍历所有关联 key）
    const msgKeys = await this._listAllKeys(PREFIX.conversationMessages + id + ':');
    await Promise.all(msgKeys.map((key: string) => this.kv.delete(key)));
  }

  async listUserConversations(userId: string): Promise<Conversation[]> {
    const keys = await this._listAllKeys(PREFIX.userConversations + userId + ':');
    const convs = await Promise.all(
      keys.map((key: string) => this.kv.get(PREFIX.conversation + key.split(':').pop()))
    );
    return convs
      .filter(Boolean)
      .map((c: string) => JSON.parse(c))
      .sort((a: Conversation, b: Conversation) => b.updated_at - a.updated_at);
  }

  // ==================== 消息 ====================

  async createMessage(msg: Message): Promise<void> {
    await this.kv.put(PREFIX.message + msg.id, JSON.stringify(msg));
    await this.kv.put(
      PREFIX.conversationMessages + msg.conversation_id + ':' + msg.id,
      msg.id
    );
    // 更新对话消息计数
    const conv = await this.getConversation(msg.conversation_id);
    if (conv) {
      await this.updateConversation(msg.conversation_id, {
        message_count: (conv.message_count || 0) + 1,
      });
    }
  }

  async getMessage(id: string): Promise<Message | null> {
    const raw = await this.kv.get(PREFIX.message + id);
    return raw ? JSON.parse(raw) : null;
  }

  async listConversationMessages(
    conversationId: string
  ): Promise<Message[]> {
    const keys = await this._listAllKeys(PREFIX.conversationMessages + conversationId + ':');
    const msgs = await Promise.all(
      keys.map((key: string) => this.kv.get(PREFIX.message + key.split(':').pop()))
    );
    return msgs
      .filter(Boolean)
      .map((m: string) => JSON.parse(m))
      .sort((a: Message, b: Message) => a.created_at - b.created_at);
  }

  // ==================== 定时任务 ====================

  async createTask(task: ScheduledTask): Promise<void> {
    await this.kv.put(PREFIX.task + task.id, JSON.stringify(task));
  }

  async getTask(id: string): Promise<ScheduledTask | null> {
    const raw = await this.kv.get(PREFIX.task + id);
    return raw ? JSON.parse(raw) : null;
  }

  async updateTask(
    id: string,
    updates: Partial<ScheduledTask>
  ): Promise<void> {
    const task = await this.getTask(id);
    if (!task) throw new Error('Task not found');
    Object.assign(task, updates, { updated_at: Date.now() });
    await this.kv.put(PREFIX.task + id, JSON.stringify(task));
  }

  async deleteTask(id: string): Promise<void> {
    await this.kv.delete(PREFIX.task + id);
  }

  async listTasks(
    filter?: { status?: string; userId?: string }
  ): Promise<ScheduledTask[]> {
    const keys = await this._listAllKeys(PREFIX.task);
    const tasks = await Promise.all(
      keys.map((key: string) => this.kv.get(key))
    );
    let result = tasks
      .filter(Boolean)
      .map((t: string) => JSON.parse(t));

    if (filter?.status) {
      result = result.filter(
        (t: ScheduledTask) => t.status === filter.status
      );
    }
    if (filter?.userId) {
      result = result.filter(
        (t: ScheduledTask) => t.user_id === filter.userId
      );
    }

    return result.sort(
      (a: ScheduledTask, b: ScheduledTask) => b.created_at - a.created_at
    );
  }

  async findDueTasks(now: Date): Promise<ScheduledTask[]> {
    const allTasks = await this.listTasks({ status: 'active' });
    return allTasks.filter((task) => {
      return matchesCron(task.cron, now);
    });
  }

  // // ==================== 任务执行记录 ====================

  async createExecution(exec: TaskExecution): Promise<void> {
    await this.kv.put(PREFIX.execution + exec.id, JSON.stringify(exec));
    await this.kv.put(
      PREFIX.taskExecutions + exec.task_id + ':' + exec.id,
      exec.id
    );
  }

  /**
   * 直接以最终状态创建执行记录，跳过中间"running"状态。
   * 相比 createExecution + updateExecution 的两步模式，减少 2 次 KV 操作。
   * 用于 cron-trigger 等不需要实时追踪"执行中"状态的场景。
   */
  async createFinalizedExecution(
    taskId: string,
    status: 'success' | 'failed',
    result_summary: string,
    error_message: string,
    duration_ms: number,
    trace_log: string[]
  ): Promise<string> {
    const id = generateId();
    const now = Date.now();
    const exec: TaskExecution = {
      id,
      task_id: taskId,
      status,
      result_summary,
      error_message,
      started_at: now - duration_ms,
      finished_at: now,
      duration_ms,
      trace_log,
    };
    await this.kv.put(PREFIX.execution + id, JSON.stringify(exec));
    await this.kv.put(
      PREFIX.taskExecutions + taskId + ':' + id,
      id
    );
    return id;
  }

  async updateExecution(
    id: string,
    updates: Partial<TaskExecution>
  ): Promise<void> {
    const exec = await this.kv.get(PREFIX.execution + id);
    if (!exec) throw new Error('Execution not found');
    const parsed = JSON.parse(exec);
    Object.assign(parsed, updates);
    await this.kv.put(PREFIX.execution + id, JSON.stringify(parsed));
  }

  async getExecution(id: string): Promise<TaskExecution | null> {
    const raw = await this.kv.get(PREFIX.execution + id);
    return raw ? JSON.parse(raw) : null;
  }

  async listTaskExecutions(
    taskId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<TaskExecution[]> {
    const keys = await this._listAllKeys(PREFIX.taskExecutions + taskId + ':');
    const execs = await Promise.all(
      keys.map((key: string) => this.kv.get(PREFIX.execution + key.split(':').pop()))
    );
    return execs
      .filter(Boolean)
      .map((e: string) => JSON.parse(e))
      .sort(
        (a: TaskExecution, b: TaskExecution) => b.started_at - a.started_at
      )
      .slice(options?.offset || 0, (options?.offset || 0) + (options?.limit || 50));
  }

  async getAllExecutions(
    options?: {
      limit?: number;
      offset?: number;
      status?: string;
    }
  ): Promise<TaskExecution[]> {
    const keys = await this._listAllKeys(PREFIX.execution);
    const execs = await Promise.all(
      keys.map((key: string) => this.kv.get(key))
    );
    let result = execs
      .filter(Boolean)
      .map((e: string) => JSON.parse(e));

    if (options?.status) {
      result = result.filter(
        (e: TaskExecution) => e.status === options.status
      );
    }

    return result
      .sort(
        (a: TaskExecution, b: TaskExecution) => b.started_at - a.started_at
      )
      .slice(
        options?.offset || 0,
        (options?.offset || 0) + (options?.limit || 100)
      );
  }

  async getExecutionCountByStatus(
    status: string,
    since?: number
  ): Promise<number> {
    const keys = await this._listAllKeys(PREFIX.execution);
    let count = 0;
    for (const key of keys) {
      const raw = await this.kv.get(key);
      if (raw) {
        const exec = JSON.parse(raw);
        if (exec.status === status && (!since || exec.started_at >= since)) {
          count++;
        }
      }
    }
    return count;
  }

  async getRecentExecutions(
    days: number
  ): Promise<{ date: string; total: number; success: number; failed: number }[]> {
    const now = Date.now();
    const results: Record<
      string,
      { total: number; success: number; failed: number }
    > = {};

    // 初始化最近 days 天
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      const key = d.toISOString().split('T')[0];
      results[key] = { total: 0, success: 0, failed: 0 };
    }

    const keys = await this._listAllKeys(PREFIX.execution);
    for (const key of keys) {
      const raw = await this.kv.get(key);
      if (raw) {
        const exec = JSON.parse(raw);
        const d = new Date(exec.started_at).toISOString().split('T')[0];
        if (results[d]) {
          results[d].total++;
          if (exec.status === 'success') results[d].success++;
          else if (exec.status === 'failed') results[d].failed++;
        }
      }
    }

    return Object.entries(results).map(([date, data]) => ({
      date,
      ...data,
    }));
  }

  // ==================== 系统设置 ====================

  async getSetting(key: string): Promise<string | null> {
    const raw = await this.kv.get(PREFIX.setting + key);
    return raw ? JSON.parse(raw).value : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const setting: Setting = { key, value, updated_at: Date.now() };
    await this.kv.put(PREFIX.setting + key, JSON.stringify(setting));
  }

  async getAllSettings(): Promise<Record<string, string>> {
    const keys = await this._listAllKeys(PREFIX.setting);
    const result: Record<string, string> = {};
    for (const key of keys) {
      const raw = await this.kv.get(key);
      if (raw) {
        const s = JSON.parse(raw);
        result[s.key] = s.value;
      }
    }
    return result;
  }

  // ==================== 浏览器凭证存储 ====================
  // 用于 cookie 登录失败时的备用登录（账号密码方式）。
  // 凭证用 base64 + XOR 简单加密，防止明文存储。
  // 生产环境建议使用平台 Secret 管理。

  /**
   * 保存浏览器登录凭证（加密后存储）
   * 使用 AES-GCM 加密（降级到 XOR）
   */
  async saveBrowserCreds(
    taskId: string,
    creds: { username: string; password: string; loginUrl: string; usernameSelector: string; passwordSelector: string; submitSelector: string },
    encryptKey: string
  ): Promise<void> {
    const payload = {
      username: await encryptCreds(creds.username, encryptKey),
      password: await encryptCreds(creds.password, encryptKey),
      loginUrl: creds.loginUrl,
      usernameSelector: creds.usernameSelector,
      passwordSelector: creds.passwordSelector,
      submitSelector: creds.submitSelector,
    };
    const raw = JSON.stringify(payload);
    await this.setSetting(`browser_creds:${taskId}`, raw);
  }

  /**
   * 读取浏览器登录凭证（解密后返回）
   */
  async getBrowserCreds(taskId: string, decryptKey: string): Promise<{
    username: string;
    password: string;
    loginUrl: string;
    usernameSelector: string;
    passwordSelector: string;
    submitSelector: string;
  } | null> {
    const raw = await this.getSetting(`browser_creds:${taskId}`);
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw);
      const username = await decryptCreds(payload.username, decryptKey);
      const password = await decryptCreds(payload.password, decryptKey);
      if (!username || !password) return null;
      return {
        username,
        password,
        loginUrl: payload.loginUrl,
        usernameSelector: payload.usernameSelector,
        passwordSelector: payload.passwordSelector,
        submitSelector: payload.submitSelector,
      };
    } catch {
      return null;
    }
  }
}

/**
 * 凭证加密（优先使用 AES-GCM，降级到 XOR）
 *
 * AES-GCM 格式: "aes$<iv_base64>$<ciphertext_base64>"
 * XOR 格式: "xor$<base64>"（兼容旧数据）
 *
 * 注意：使用 CRON_SECRET 作为加密密钥，**务必保证 CRON_SECRET 是强随机字符串**
 */
async function encryptCreds(plaintext: string, keyStr: string): Promise<string> {
  try {
    // 使用 AES-GCM
    const key = await deriveKey(keyStr);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const ctBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    const ivBase64 = btoa(String.fromCharCode(...iv));
    return `aes$${ivBase64}$${ctBase64}`;
  } catch {
    // 降级到 XOR（简单编码，非加密）
    return xorEncode(plaintext, keyStr);
  }
}

async function decryptCreds(encrypted: string, keyStr: string): Promise<string | null> {
  // AES-GCM 格式
  if (encrypted.startsWith('aes$')) {
    try {
      const parts = encrypted.split('$');
      if (parts.length !== 3) return null;
      const iv = Uint8Array.from(atob(parts[1]), (c) => c.charCodeAt(0));
      const ciphertext = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
      const key = await deriveKey(keyStr);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  }
  // 兼容旧 XOR 格式
  return xorDecode(encrypted, keyStr);
}

/** 从字符串密钥派生 AES-GCM 密钥 */
async function deriveKey(keyStr: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyStr));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * 简单的 XOR 编码（降级方案，非加密）
 * 格式: "xor$<base64>"
 */
function xorEncode(text: string, key: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    result += String.fromCharCode(code);
  }
  const b64 = typeof btoa === 'function' ? btoa(result) : Buffer.from(result, 'binary').toString('base64');
  return `xor$${b64}`;
}

function xorDecode(encoded: string, key: string): string | null {
  if (!encoded.includes('$')) return null; // 无效格式
  const payload = encoded.split('$').pop() || '';
  let decoded: string;
  try {
    if (typeof atob === 'function') decoded = atob(payload);
    else decoded = Buffer.from(payload, 'base64').toString('binary');
  } catch {
    return null;
  }
  let result = '';
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    result += String.fromCharCode(code);
  }
  return result;
}

/**
 * 简易 Cron 表达式匹配器
 * 支持的格式: "每分钟", "* * * * *", "0 9 * * *" 等
 * 也支持中文描述: "每天 9 点", "每隔一小时"
 */
function matchesCron(cron: string, now: Date): boolean {
  // 处理中文描述
  if (cron.includes('每分钟') || cron === '* * * * *') return true;

  if (cron.includes('每隔') || cron.includes('每') && cron.includes('小时')) {
    const match = cron.match(/(\d+)/);
    if (match) {
      const interval = parseInt(match[1]) || 1;
      return now.getMinutes() % interval === 0;
    }
    return now.getMinutes() === 0;
  }

  // 标准 cron 格式: minute hour day month weekday
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour, day, month, weekday] = parts;

  const matchField = (field: string, value: number): boolean => {
    if (field === '*') return true;
    if (field.includes(',')) {
      return field.split(',').some((f) => matchField(f.trim(), value));
    }
    if (field.includes('/')) {
      const [start, interval] = field.split('/');
      const startVal = start === '*' ? 0 : parseInt(start);
      return (value - startVal) % parseInt(interval) === 0;
    }
    if (field.includes('-')) {
      const [min, max] = field.split('-').map(Number);
      return value >= min && value <= max;
    }
    return parseInt(field) === value;
  };

  return (
    matchField(minute, now.getMinutes()) &&
    matchField(hour, now.getHours()) &&
    matchField(day, now.getDate()) &&
    matchField(month, now.getMonth() + 1) &&
    matchField(weekday, now.getDay())
  );
}

/**
 * KV 操作并发限流器
 *
 * EdgeOne KV 免费版约有 1000 ops/sec 的并发限制。
 * 当 cron-trigger 一次触发大量任务时，每任务约 4~8 次 KV 操作，
 * 如果 200 个任务同时写入，瞬间并发可能 >1000 ops 触发限流。
 *
 * 限流器的效果：
 * - 最多同时允许 maxConcurrent 个 KV 操作正在执行
 * - 超出部分排队等待
 * - 每个操作完成后从队列取出下一个执行
 *
 * 使用示例：
 *   const limiter = new KVOpLimiter(20);
 *   await limiter.run(() => kv.createExecution(exec));
 *
 * 参考 https://en.wikipedia.org/wiki/Semaphore_(programming)
 */
export class KVOpLimiter {
  private max: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(maxConcurrent = 20) {
    this.max = maxConcurrent;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      this.active++;
      try {
        return await fn();
      } finally {
        this.active--;
        this.drain();
      }
    }

    // 超出限制，排队等待
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        this.active++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          this.active--;
          this.drain();
        }
      });
    });
  }

  private drain(): void {
    while (this.queue.length > 0 && this.active < this.max) {
      const next = this.queue.shift();
      if (next) next();
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}
