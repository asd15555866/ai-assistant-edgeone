/**
 * 对话管理 API - 详情、更新、删除
 *
 * 路径: /api/conversations/:id（catch-all，EdgeOne 编译为 ^/api/conversations/(.+?)$）
 * 列表/创建在 conversations/index.ts 中
 *
 * GET    /api/conversations/:id - 详情+消息
 * PUT    /api/conversations/:id - 更新
 * DELETE /api/conversations/:id - 删除
 */
import { KVStore } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'conversations-detail';

function getConvIdFromPath(pathname: string): string {
  // pathname 形如 /api/conversations/abc123
  return pathname.split('/').pop() || '';
}

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const convId = getConvIdFromPath(pathname);
  const conv = await kv.getConversation(convId);
  if (!conv || conv.user_id !== userId) {
    log(SRC, { method: 'GET', path: pathname, userId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '对话不存在' });
  }
  const messages = await kv.listConversationMessages(convId);
  log(SRC, { method: 'GET', path: pathname, userId, convId, msgCount: messages.length, status: 200, dur: Date.now() - t0 });
  return json(200, { conversation: conv, messages });
}

export async function onRequestPut(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const convId = getConvIdFromPath(pathname);
  const conv = await kv.getConversation(convId);
  if (!conv || conv.user_id !== userId) {
    log(SRC, { method: 'PUT', path: pathname, userId, convId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '对话不存在' });
  }

  const body = await request.json();
  await kv.updateConversation(convId, { title: body.title });
  const updated = await kv.getConversation(convId);
  log(SRC, { method: 'PUT', path: pathname, userId, convId, status: 200, dur: Date.now() - t0 });
  return json(200, { conversation: updated });
}

export async function onRequestDelete(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const convId = getConvIdFromPath(pathname);
  const conv = await kv.getConversation(convId);
  if (!conv || conv.user_id !== userId) {
    log(SRC, { method: 'DELETE', path: pathname, userId, convId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '对话不存在' });
  }

  await kv.deleteConversation(convId);
  log(SRC, { method: 'DELETE', path: pathname, userId, convId, status: 200, dur: Date.now() - t0 });
  return json(200, { message: '对话已删除' });
}
