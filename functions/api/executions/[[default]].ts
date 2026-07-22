/**
 * 任务执行记录 API
 *
 * 路径: /api/executions
 * 鉴权：管理员
 */

import { KVStore } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'cloud-functions';

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const url = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  if (payload.role !== 'admin') return json(403, { error: '仅管理员可查看执行记录' });

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const status = url.searchParams.get('status') || undefined;
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const limit = parseInt(url.searchParams.get('limit') || '100');
  const executions = await kv.getAllExecutions({ status, offset, limit });

  log(SRC, { method: 'GET', path: '/api/executions', userId: payload.user_id, status, offset, limit, execCount: executions.length, dur: Date.now() - t0 });
  return json(200, { executions });
}
