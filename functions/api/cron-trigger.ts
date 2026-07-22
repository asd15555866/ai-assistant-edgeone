/**
 * 定时任务触发器
 *
 * 由 EdgeOne 定时调度触发（每分钟），
 * 检查需要执行的任务并触发执行。
 *
 * 使用 EdgeOne Agents 平台能力：
 * - context.tracer：全链路追踪
 * - context.sandbox.run_code：沙箱代码执行
 * - context.sandbox.browser：浏览器自动化
 */

import { KVStore, KVOpLimiter, ScheduledTask, TaskExecution } from '../../_shared/kv';
import { log, logError } from '../../_shared/logger';
import { saveBrowserCookies, restoreBrowserCookies, detectLoginChallenge } from '../../_shared/browser-utils';

const SRC = 'cron';

// 每批处理的任务数
const BATCH_SIZE = 10;
// 批次间间隔（毫秒）
const BATCH_INTERVAL_MS = 200;
// 最大并发 KV 操作数（免费版 1000 ops/sec，设 20 留有余量）
const MAX_CONCURRENT_KV_OPS = 20;

/**
 * 创建追踪 span（优先使用平台 tracer，降级到 console）
 */
function tracerSpan(tracer: any, name: string, attrs?: Record<string, unknown>) {
  if (tracer?.span) {
    tracer.span(name, { ...attrs, timestamp: Date.now() });
  }
}

export async function onRequest(context: any) {
  const { request, env, uuid } = context;
  const requestId = uuid || 'unknown';
  const sandbox = context.sandbox; // EdgeOne 沙箱实例
  const tracer = context.tracer;   // EdgeOne 全链路追踪
  const method = request.method;
  const t0 = Date.now();

  tracerSpan(tracer, 'cron_trigger', { requestId });

  // 仅接受 POST 请求
  if (method !== 'POST') {
    log(SRC, { requestId, msg: 'method not allowed', method, dur: Date.now() - t0 });
    return new Response('Method Not Allowed', { status: 405 });
  }

  // ==================== Token 鉴权 ====================
  const url = new URL(request.url);
  const token =
    request.headers.get('X-Cron-Secret') ||
    request.headers.get('x-cron-secret') ||
    url.searchParams.get('token');

  if (!token || !env.CRON_SECRET || !safeCompare(token, env.CRON_SECRET)) {
    log(SRC, { requestId, msg: 'unauthorized', dur: Date.now() - t0 });
    return new Response(
      JSON.stringify({ error: 'Unauthorized: 无效的 cron secret' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const limiter = new KVOpLimiter(MAX_CONCURRENT_KV_OPS);
  const now = new Date();
  const results: Array<{ task_id: string; status: string; summary: string }> = [];

  try {
    // 1. 查找需要执行的任务
    const dueTasks = await kv.findDueTasks(now);
    const totalTasks = dueTasks.length;
    tracerSpan(tracer, 'cron_trigger', { tasksFound: totalTasks });
    log(SRC, { requestId, msg: 'checking tasks', due: totalTasks });

    // 2. 分批执行
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < totalTasks; i += BATCH_SIZE) {
      const batch = dueTasks.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map((task) =>
          processTask(task, kv, env, sandbox, tracer, limiter)
        )
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          results.push(r.value);
          if (r.value.status === 'success') successCount++;
          else failCount++;
        } else {
          failCount++;
          results.push({
            task_id: 'unknown',
            status: 'failed',
            summary: `批次执行错误: ${r.reason?.message || r.reason}`,
          });
        }
      }

      // 批次间错峰
      if (i + BATCH_SIZE < totalTasks) {
        await sleep(BATCH_INTERVAL_MS);
      }
    }

    tracerSpan(tracer, 'cron_trigger', { completed: true, taskCount: results.length });
    log(SRC, { requestId, msg: 'cron completed', total: totalTasks, success: successCount, failed: failCount, dur: Date.now() - t0 });

    return new Response(
      JSON.stringify({
        success: true,
        checked_at: now.toISOString(),
        tasks_found: dueTasks.length,
        results,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (e) {
    tracerSpan(tracer, 'cron_trigger', { error: (e as Error).message });
    logError(SRC, { requestId, msg: 'cron failed', err: (e as Error).message, dur: Date.now() - t0 });
    return new Response(
      JSON.stringify({
        success: false,
        error: (e as Error).message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * 处理单个定时任务
 *
 * 使用 KVOpLimiter 包装所有 KV 操作，确保并发不超过阈值。
 * 使用 createFinalizedExecution 直接写入最终状态，减少 2 次 KV 操作。
 */
async function processTask(
  task: ScheduledTask,
  kv: KVStore,
  env: any,
  sandbox: any,
  limiter: KVOpLimiter
): Promise<{ task_id: string; status: string; summary: string }> {
  const startTime = Date.now();
  const startMs = startTime;

  log(SRC, { msg: 'task start', taskId: task.id, taskName: task.name, action: task.action });

  try {
    // 执行任务（非 KV 操作不受限流器控制）
    const result = await executeTaskAction(task, env, sandbox, kv);
    const duration = Date.now() - startMs;

    // 使用限流器写入最终执行记录（跳过 intermediate "running" 状态，减少 2 次 KV 写入）
    const executionId = await limiter.run(() =>
      kv.createFinalizedExecution(
        task.id,
        'success',
        result.summary,
        '',
        duration,
        result.trace || []
      )
    );

    // 更新任务最后运行时间
    await limiter.run(() => kv.updateTask(task.id, { last_run_at: Date.now() }));

    // 异步发送通知（不阻塞主流程）
    if (task.notify_email) {
      sendNotification(task.notify_email, task.name, 'success', result.summary, env)
        .catch(() => {});
    }

    log(SRC, { msg: 'task done', taskId: task.id, status: 'success', dur: duration });
    return {
      task_id: task.id,
      status: 'success',
      summary: result.summary,
    };
  } catch (e) {
    const duration = Date.now() - startMs;
    const errorMsg = (e as Error).message;

    await limiter.run(() =>
      kv.createFinalizedExecution(
        task.id,
        'failed',
        '',
        errorMsg,
        duration,
        []
      )
    );

    if (task.notify_email) {
      sendNotification(task.notify_email, task.name, 'failed', errorMsg, env)
        .catch(() => {});
    }

    logError(SRC, { msg: 'task failed', taskId: task.id, taskName: task.name, err: errorMsg, dur: duration });
    return {
      task_id: task.id,
      status: 'failed',
      summary: errorMsg,
    };
  } finally {
    // 使用官方文档支持的 browser.close() 释放浏览器资源
    if (sandbox?.browser?.close) {
      try {
        await sandbox.browser.close();
      } catch {
        // close 失败不影响结果记录
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 根据任务类型执行对应操作
 * 使用平台能力：context.sandbox.run_code（替代外部 Piston API）
 */
async function executeTaskAction(
  task: ScheduledTask,
  env: any,
  sandbox: any,
  kv: KVStore,
  tracer?: any
): Promise<{ summary: string; trace: string[] }> {
  const trace: string[] = [];
  trace.push(`[cron] 开始执行任务: ${task.name} (${task.id})`);

  // 如果是浏览器操作，提前将沙箱超时延长到 30 分钟
  if (task.action === 'browser_automation' && sandbox?.extendTimeout) {
    trace.push(`[cron] 延长沙箱超时到 30 分钟`);
    await sandbox.extendTimeout(1800);
  }

  switch (task.action) {
    case 'web_search': {
      const query = (task.params.query as string) || task.name;
      trace.push(`[cron] web_search: ${query}`);
      const response = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
        { signal: AbortSignal.timeout(15000) }
      );
      const data = await response.json();
      const summary = data.AbstractText || `搜索「${query}」完成`;
      trace.push(`[cron] 搜索完成: ${summary.slice(0, 100)}`);
      return { summary, trace };
    }

    case 'execute_code': {
      const code = task.params.code as string;
      const language = (task.params.language as string) || 'python';
      trace.push(`[cron] execute_code (${language})`);

      // 优先使用 EdgeOne 沙箱 run_code API，降级到外部 Piston API
      let output = '无输出';
      if (sandbox?.run_code) {
        trace.push(`[cron] 使用 EdgeOne 沙箱执行代码`);
        const result = await sandbox.run_code({
          code,
          language,
          timeout: 30,
        });
        output = result.results?.map((r: any) => r.text).join('\n')
          || result.logs?.join('\n')
          || result.error
          || '无输出';
      } else {
        trace.push(`[cron] 使用外部 Piston API 执行代码`);
        const response = await fetch('https://emkc.org/api/v2/piston/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            language,
            version: language === 'python' ? '3.10.0' : '18.15.0',
            files: [{ content: code }],
          }),
          signal: AbortSignal.timeout(30000),
        });
        const result = await response.json();
        output = result.run?.output || result.run?.stderr || '无输出';
      }
      trace.push(`[cron] 代码执行完成`);
      return { summary: output.slice(0, 200), trace };
    }

    case 'browser_automation': {
      const action = task.params.action as any;
      trace.push(`[cron] browser_automation: ${action?.type || 'unknown'}`);

      const cookiesKey = `browser_cookies:${task.id}`;
      let sessionReady = false;

      // ==================== 第一步：尝试恢复 Cookies ====================
      // 对不检查 IP 的网站（个人站、内网），上次保存的 Cookie 可直接复用
      const savedCookies = await kv.getSetting(cookiesKey);
      if (savedCookies) {
        trace.push(`[cron] 发现已保存的 Cookies，正在恢复会话...`);
        sessionReady = await restoreBrowserCookies(sandbox, savedCookies, trace);
        if (sessionReady) {
          trace.push(`[cron] Cookies 恢复完成，会话已就绪`);
        } else {
          trace.push(`[cron] Cookies 已过期，已清除`);
          await kv.setSetting(cookiesKey, '');
        }
      } else {
        trace.push(`[cron] 无已保存的 Cookies`);
      }

      // ==================== 第二步：Cookie 不行，尝试自动登录 ====================
      if (!sessionReady && sandbox?.browser) {
        trace.push(`[cron] 尝试备用登录方案...`);
        const creds = await kv.getBrowserCreds(task.id, env.CRON_SECRET || '');
        if (creds) {
          trace.push(`[cron] 发现已保存的账号凭证，准备自动登录: ${creds.loginUrl}`);
          try {
            // 导航到登录页
            if (sandbox.browser.goto) {
              await sandbox.browser.goto(creds.loginUrl, { waitUntil: 'networkidle' });
              trace.push(`[cron] 已导航到登录页`);
            }
            // 输入用户名
            if (sandbox.browser.type) {
              await sandbox.browser.type(creds.usernameSelector, creds.username);
              trace.push(`[cron] 已输入用户名`);
            }
            // 输入密码
            if (sandbox.browser.type) {
              await sandbox.browser.type(creds.passwordSelector, creds.password);
              trace.push(`[cron] 已输入密码`);
            }
            // 点击登录按钮
            if (sandbox.browser.click) {
              await sandbox.browser.click(creds.submitSelector);
              trace.push(`[cron] 已点击登录按钮`);
            }
            // 等页面跳转（给验证码/二次验证留出时间）
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // ===== 检测是否遇到验证码/二次验证 =====
            // 很多网站在登录后会弹出验证码、滑块、或要求输入手机验证码。
            // 自动化无法处理这些，如实记录日志，让任务失败，
            // 用户看到后可选择手动在 liveUrl 中协助完成。
            const hasChallenge = await detectLoginChallenge(sandbox, trace);
            if (hasChallenge) {
              let liveUrl = '';
              if (sandbox.browser.liveUrl) {
                const result = await sandbox.browser.liveUrl;
                liveUrl = typeof result === 'string' ? result : result?.url || '';
              }
              trace.push(`[cron] ⚠ 登录遇到验证码/二次验证，自动登录失败`);
              trace.push(`[cron] 如需手动协助，可打开浏览器画面: ${liveUrl || '不可用'}`);
              // 不清除已有的 Cookie，下次可能 Cookie 还未过期
              sessionReady = false;
            } else {
              trace.push(`[cron] 自动登录完成`);
              sessionReady = true;
            }
          } catch (e) {
            trace.push(`[cron] 自动登录失败: ${(e as Error).message}`);
          }
        } else {
          trace.push(`[cron] 无已保存的账号凭证，无法自动登录`);
        }
      }

      // ==================== 第三步：执行实际的操作 ====================
      // 如果以上两步都失败了（无 Cookie 无凭证），
      // 仍然尝试执行 action，让任务走到登录页，下次人工补充凭证
      if (!sessionReady) {
        trace.push(`[cron] ⚠ 无有效登录态，任务可能因未登录而失败`);
      }

      try {
        switch (action?.type) {
          case 'goto':
            if (sandbox?.browser?.goto) await sandbox.browser.goto(action.url, { waitUntil: 'networkidle' });
            trace.push(`[cron] 已导航到: ${action.url}`);
            break;
          case 'click':
            if (sandbox?.browser?.click) await sandbox.browser.click(action.selector);
            trace.push(`[cron] 已点击: ${action.selector}`);
            break;
          case 'type':
            if (sandbox?.browser?.type) await sandbox.browser.type(action.selector, action.value);
            trace.push(`[cron] 已输入内容到: ${action.selector}`);
            break;
          case 'screenshot':
            if (sandbox?.browser?.screenshot) {
              await sandbox.browser.screenshot({ fullPage: true });
            }
            trace.push(`[cron] 截图完成`);
            break;
          case 'getContent':
            if (sandbox?.browser?.getContent) {
              await sandbox.browser.getContent();
            }
            trace.push(`[cron] 页面内容获取完成`);
            break;
          default:
            trace.push(`[cron] 未知操作类型: ${action?.type}`);
        }

        // ==================== Cookies 保存 ====================
        // 操作完成后保存 Cookies（登录态），供下次执行时恢复。
        // 无论是 Cookie 恢复成功的还是刚用密码登录的，都保存一份当前 Cookie。
        trace.push(`[cron] 正在保存 Cookies...`);
        await saveBrowserCookies(sandbox, kv, cookiesKey, trace);

        return { summary: `浏览器操作 ${action?.type} 执行成功`, trace };
      } catch (e) {
        trace.push(`[cron] 浏览器操作失败: ${(e as Error).message}`);
        throw e;
      }
    }

    default:
      throw new Error(`未知任务类型: ${task.action}`);
  }
}

// ==================== Cookies 管理 ====================
// saveBrowserCookies / restoreBrowserCookies / detectLoginChallenge 已抽取到 _shared/browser-utils.ts

/**
 * 发送执行结果通知（邮件）
 */
async function sendNotification(
  email: string,
  taskName: string,
  status: string,
  summary: string,
  env: any
): Promise<void> {
  try {
    const subject = `[AI Assistant] 定时任务「${taskName}」${status === 'success' ? '执行成功' : '执行失败'}`;
    const body = `
任务名称: ${taskName}
执行状态: ${status === 'success' ? '✅ 成功' : '❌ 失败'}
执行时间: ${new Date().toLocaleString('zh-CN')}
结果摘要: ${summary}
    `.trim();

    // 使用 EdgeOne 的消息通知能力
    // 实际部署时使用: env.NOTIFICATION.send({ to: email, subject, body })
    console.log(`[通知] 发送邮件到 ${email}: ${subject}`);
  } catch (e) {
    console.error(`[通知] 发送失败:`, e);
  }
}

/**
 * 时序安全的字符串比较，防止时序攻击
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // 仍然遍历以保持时间大致恒定
    let dummy = 0;
    for (let i = 0; i < (a.length > b.length ? a.length : b.length); i++) {
      dummy |= 0;
    }
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
