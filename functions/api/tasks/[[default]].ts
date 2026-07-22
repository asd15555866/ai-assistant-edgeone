/**
 * 定时任务管理 API
 *
 * 路径: /api/tasks
 * 鉴权：每个端点内部鉴权
 */

import { KVStore, ScheduledTask, generateId } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'cloud-functions';

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;
  const userRole = payload.role;

  const kv = new KVStore(env.AI_ASSISTANT_KV);

  // GET /api/tasks - 列表
  if (path.endsWith('/tasks')) {
    const status = url.searchParams.get('status') || undefined;
    const tasks = await kv.listTasks({ status, userId: userRole === 'admin' ? undefined : userId });
    log(SRC, { method: 'GET', path, userId, role: userRole, taskCount: tasks.length, status: 200, dur: Date.now() - t0 });
    return json(200, { tasks });
  }

  // GET /api/tasks/:id - 详情+执行记录
  const taskId = path.split('/').pop();
  const task = await kv.getTask(taskId!);
  if (!task) {
    log(SRC, { method: 'GET', path, userId, taskId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '任务不存在' });
  }
  if (task.user_id !== userId && userRole !== 'admin') {
    log(SRC, { method: 'GET', path, userId, taskId, status: 403, dur: Date.now() - t0 });
    return json(403, { error: '无权访问' });
  }
  const executions = await kv.listTaskExecutions(taskId!, { limit: 50 });
  log(SRC, { method: 'GET', path, userId, taskId, execCount: executions.length, status: 200, dur: Date.now() - t0 });
  return json(200, { task, executions });
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
  log(SRC, { method: 'POST', path: '/api/tasks', userId, taskId: task.id, action: task.action, status: 201, dur: Date.now() - t0 });
  return json(201, { task, message: '定时任务已创建' });
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
  const taskId = pathname.split('/').pop();
  const existing = await kv.getTask(taskId!);
  if (!existing) {
    log(SRC, { method: 'PUT', path: pathname, userId, taskId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '任务不存在' });
  }
  if (existing.user_id !== userId && userRole !== 'admin') {
    log(SRC, { method: 'PUT', path: pathname, userId, taskId, status: 403, dur: Date.now() - t0 });
    return json(403, { error: '无权修改' });
  }

  const body = await request.json();
  const allowedUpdates: (keyof ScheduledTask)[] = ['name', 'cron', 'action', 'params', 'status', 'notify_email'];
  const updates: Partial<ScheduledTask> = {};
  for (const key of allowedUpdates) {
    if (body[key] !== undefined) (updates as any)[key] = body[key];
  }
  await kv.updateTask(taskId!, updates);
  const updated = await kv.getTask(taskId!);
  log(SRC, { method: 'PUT', path: pathname, userId, taskId, changes: Object.keys(updates).join(','), status: 200, dur: Date.now() - t0 });
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
  const taskId = pathname.split('/').pop();
  const existing = await kv.getTask(taskId!);
  if (!existing) {
    log(SRC, { method: 'DELETE', path: pathname, userId, taskId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '任务不存在' });
  }
  if (existing.user_id !== userId && userRole !== 'admin') {
    log(SRC, { method: 'DELETE', path: pathname, userId, taskId, status: 403, dur: Date.now() - t0 });
    return json(403, { error: '无权删除' });
  }

  await kv.updateTask(taskId!, { status: 'deleted' });
  log(SRC, { method: 'DELETE', path: pathname, userId, taskId, status: 200, dur: Date.now() - t0 });
  return json(200, { message: '任务已删除' });
}
