/**
 * 对话管理 API - CRUD
 *
 * 路径: /api/conversations
 * 鉴权：每个端点内部调用 getUserFromRequest
 */

import { KVStore, Conversation, generateId } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'cloud-functions';

// ==================== GET ====================

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const kv = new KVStore(env.AI_ASSISTANT_KV);

  // GET /api/conversations - 列表
  if (pathname.endsWith('/conversations')) {
    const conversations = await kv.listUserConversations(userId);
    log(SRC, { method: 'GET', path: pathname, userId, count: conversations.length, status: 200, dur: Date.now() - t0 });
    return json(200, { conversations });
  }

  // GET /api/conversations/:id - 详情+消息
  const convId = pathname.split('/').pop();
  const conv = await kv.getConversation(convId!);
  if (!conv || conv.user_id !== userId) {
    log(SRC, { method: 'GET', path: pathname, userId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '对话不存在' });
  }
  const messages = await kv.listConversationMessages(convId!);
  log(SRC, { method: 'GET', path: pathname, userId, convId, msgCount: messages.length, status: 200, dur: Date.now() - t0 });
  return json(200, { conversation: conv, messages });
}

// ==================== POST ====================

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const body = await request.json().catch(() => ({}));
  const conversation: Conversation = {
    id: generateId(),
    user_id: userId,
    title: body.title || '新对话',
    created_at: Date.now(),
    updated_at: Date.now(),
    message_count: 0,
  };
  await kv.createConversation(conversation);
  log(SRC, { method: 'POST', path: '/api/conversations', userId, convId: conversation.id, status: 201, dur: Date.now() - t0 });
  return json(201, { conversation });
}

// ==================== PUT ====================

export async function onRequestPut(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const convId = pathname.split('/').pop();
  const conv = await kv.getConversation(convId!);
  if (!conv || conv.user_id !== userId) {
    log(SRC, { method: 'PUT', path: pathname, userId, convId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '对话不存在' });
  }

  const body = await request.json();
  await kv.updateConversation(convId!, { title: body.title });
  const updated = await kv.getConversation(convId!);
  log(SRC, { method: 'PUT', path: pathname, userId, convId, status: 200, dur: Date.now() - t0 });
  return json(200, { conversation: updated });
}

// ==================== DELETE ====================

export async function onRequestDelete(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const convId = pathname.split('/').pop();
  const conv = await kv.getConversation(convId!);
  if (!conv || conv.user_id !== userId) {
    log(SRC, { method: 'DELETE', path: pathname, userId, convId, status: 404, dur: Date.now() - t0 });
    return json(404, { error: '对话不存在' });
  }

  await kv.deleteConversation(convId!);
  log(SRC, { method: 'DELETE', path: pathname, userId, convId, status: 200, dur: Date.now() - t0 });
  return json(200, { message: '对话已删除' });
}
