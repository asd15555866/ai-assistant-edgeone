/**
 * 创建超时 AbortSignal（兼容 Cloudflare Workers / EdgeOne Agent）
 *
 * 为什么不直接用 AbortSignal.timeout()：
 * - 该 API 是 Node.js 17.3+ 才有的，EdgeOne Agent 运行时基于
 *   Cloudflare Workers 不支持。
 * - 所以这里手动用 AbortController + setTimeout 实现。
 *
 * 使用示例：
 *   const signal = createTimeoutSignal(10000);
 *   fetch(url, { signal });
 */
export function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => {
    try { controller.abort(new Error('Request timeout')); } catch { /* ignore */ }
  }, ms);
  return controller.signal;
}