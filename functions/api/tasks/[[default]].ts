/**
 * 定时任务管理 API - 详情、更新、删除
 * 路径: GET/PUT/DELETE /api/tasks/:id（catch-all）
 * 列表/创建在 tasks/index.ts
 */
import { KVStore, ScheduledTask } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'tasks-detail';

function getTaskIdFromPath(pathname: string): string {
  return pathname.split('/').pop() || '';
}

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;
  const userRole = payload.role;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const taskId = getTaskIdFromPath(pathname);
  const task = await kv.getTask(taskId);
  if (!task) {
    log(SRC, { method: 'GET', userId, taskId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '任务不存在' });
  }
  if (task.user_id !== userId && userRole !== 'admin') {
    log(SRC, { method: 'GET', userId, taskId, status: 403, dur: Date.now() - t0 });
    return json(403, { error: '无权访问' });
  }
  const executions = await kv.listTaskExecutions(taskId, { limit: 50 });
  log(SRC, { method: 'GET', userId, taskId, execCount: executions.length, status: 200, dur: Date.now() - t0 });
  return json(200, { task, executions });
}

export async function onRequestPut(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;
  const userRole = payload.role;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const taskId = getTaskIdFromPath(pathname);
  const existing = await kv.getTask(taskId);
  if (!existing) {
    log(SRC, { method: 'PUT', userId, taskId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '任务不存在' });
  }
  if (existing.user_id !== userId && userRole !== 'admin') {
    log(SRC, { method: 'PUT', userId, taskId, status: 403, dur: Date.now() - t0 });
    return json(403, { error: '无权修改' });
  }

  const body = await request.json();
  const allowedUpdates: (keyof ScheduledTask)[] = ['name', 'cron', 'action', 'params', 'status', 'notify_email'];
  const updates: Partial<ScheduledTask> = {};
  for (const key of allowedUpdates) {
    if (body[key] !== undefined) (updates as any)[key] = body[key];
  }
  await kv.updateTask(taskId, updates);
  const updated = await kv.getTask(taskId);
  log(SRC, { method: 'PUT', userId, taskId, changes: Object.keys(updates).join(','), status: 200, dur: Date.now() - t0 });
  return json(200, { task: updated, message: '任务已更新' });
}

export async function onRequestDelete(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;
  const userRole = payload.role;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const taskId = getTaskIdFromPath(pathname);
  const existing = await kv.getTask(taskId);
  if (!existing) {
    log(SRC, { method: 'DELETE', userId, taskId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '任务不存在' });
  }
  if (existing.user_id !== userId && userRole !== 'admin') {
    log(SRC, { method: 'DELETE', userId, taskId, status: 403, dur: Date.now() - t0 });
    return json(403, { error: '无权删除' });
  }

  await kv.updateTask(taskId, { status: 'deleted' });
  log(SRC, { method: 'DELETE', userId, taskId, status: 200, dur: Date.now() - t0 });
  return json(200, { message: '任务已删除' });
}
