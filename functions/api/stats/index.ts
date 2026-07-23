/**
 * 统计数据 API
 * 路径: GET /api/stats（精确匹配）
 * 鉴权：管理员
 */
import { KVStore } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'stats';

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  if (payload.role !== 'admin') return json(403, { error: '仅管理员可查看统计数据' });

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const now = Date.now();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartTs = monthStart.getTime();

  const totalExecutions =
    (await kv.getExecutionCountByStatus('success', monthStartTs)) +
    (await kv.getExecutionCountByStatus('failed', monthStartTs));
  const successCount = await kv.getExecutionCountByStatus('success', monthStartTs);
  const successRate = totalExecutions > 0 ? parseFloat(((successCount / totalExecutions) * 100).toFixed(1)) : 0;
  const trend = await kv.getRecentExecutions(7);
  const activeTasks = (await kv.listTasks({ status: 'active' })).length;

  // Token 用量：本月
  const monthStartDate = new Date(monthStartTs).toISOString().slice(0, 10);
  const todayDate = new Date(now).toISOString().slice(0, 10);
  const monthUsage = await kv.aggregateTokenUsage(monthStartDate, todayDate);

  // 当天用量
  const todayUsage = await kv.getTokenUsage(todayDate);

  log(SRC, { method: 'GET', path: '/api/stats', userId: payload.user_id, totalExecutions, activeTasks, successRate, monthTokens: monthUsage.total.total_tokens, dur: Date.now() - t0 });
  return json(200, {
    totalExecutions, successCount, successRate, activeTasks, trend,
    tokenUsage: {
      today: todayUsage ? {
        total_tokens: todayUsage.total_tokens,
        prompt_tokens: todayUsage.prompt_tokens,
        completion_tokens: todayUsage.completion_tokens,
        count: todayUsage.count,
      } : { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, count: 0 },
      month: monthUsage.total,
      days: monthUsage.days,
      byModel: monthUsage.byModel,
    },
  });
}
