/**
 * 定时任务管理 API - 列表与创建
 * 路径: GET/POST /api/tasks（精确匹配）
 * 鉴权：所有登录用户
 * 详情/更新/删除在 tasks/[[default]].ts
 */
import { KVStore, ScheduledTask, generateId } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'tasks-index';

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const url = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;
  const userRole = payload.role;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const status = url.searchParams.get('status') || undefined;
  const tasks = await kv.listTasks({ status, userId: userRole === 'admin' ? undefined : userId });
  log(SRC, { method: 'GET', userId, role: userRole, taskCount: tasks.length, status: 200, dur: Date.now() - t0 });
  return json(200, { tasks });
}

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const body = await request.json();
  const task: ScheduledTask = {
    id: generateId(),
    user_id: userId,
    name: body.name || '未命名任务',
    cron: body.cron || '0 9 * * *',
    action: body.action || 'web_search',
    params: body.params || {},
    status: 'active',
    notify_email: body.notify_email || '',
    created_at: Date.now(),
    updated_at: Date.now(),
    last_run_at: null,
  };
  await kv.createTask(task);
  log(SRC, { method: 'POST', userId, taskId: task.id, action: task.action, status: 201, dur: Date.now() - t0 });
  return json(201, { task, message: '定时任务已创建' });
}
