/**
 * 统一日志工具
 *
 * 接入 EdgeOne Pages 平台日志：https://pages.edgeone.ai/zh/document/log-analysis
 *
 * 日志来源分为三类，可在控制台按来源筛选：
 * - Cloud Functions：cloud-functions/ 目录下的函数日志
 * - Agents：agents/ 目录下的 Agent 日志
 * - 全部日志：以上之和
 *
 * 只需使用 console.log / console.error / console.warn，
 * 平台自动捕获并展示在"日志分析"页面。
 *
 * 日志字段约定（便于检索）：
 * - reqId: 请求/执行 ID
 * - userId: 用户 ID
 * - msg: 消息描述
 * - dur: 耗时（毫秒）
 * - err: 错误信息
 */

export type LogSource = 'cloud-functions' | 'agent' | 'cron';

export function log(src: LogSource, fields: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    src,
    ...fields,
  };
  console.log(JSON.stringify(entry));
}

export function logError(src: LogSource, fields: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    src,
    level: 'error',
    ...fields,
  };
  console.error(JSON.stringify(entry));
}
