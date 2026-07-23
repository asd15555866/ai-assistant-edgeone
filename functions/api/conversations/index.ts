/**
 * 对话管理 API - 列表与创建
 *
 * 路径: /api/conversations（精确匹配，无尾斜杠）
 * 路由：EdgeOne 把非 catch-all 的 index.ts 编译为 ^/api/conversations$
 * 因此列表端点（无 ID）必须放在这里
 *
 * GET  /api/conversations  - 列表
 * POST /api/conversations  - 创建
 */
import { KVStore, Conversation, generateId } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'conversations-index';

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const conversations = await kv.listUserConversations(userId);
  log(SRC, { method: 'GET', path: pathname, userId, count: conversations.length, status: 200, dur: Date.now() - t0 });
  return json(200, { conversations });
}

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
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
  log(SRC, { method: 'POST', path: pathname, userId, convId: conversation.id, status: 201, dur: Date.now() - t0 });
  return json(201, { conversation });
}
