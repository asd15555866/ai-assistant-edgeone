/**
 * 对话管理 API - 列表与创建
 *
 * 路径: GET/POST /api/conversations
 * 在 Cloud Functions 中通过 context.agent.store 访问 Agent 的对话数据
 * 官方文档: https://pages.edgeone.ai/zh/document/agents-conversation-storage
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

  // context.agent.store 在 Cloud Functions 中不可用，直接走 KV
  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const conversations = await kv.listUserConversations(userId);
  log(SRC, { method: 'GET', path: pathname, userId, count: conversations.length, source: 'kv', status: 200, dur: Date.now() - t0 });
  return json(200, { conversations });
}

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const userId = payload.user_id;

  const body = await request.json().catch(() => ({}));

  // 在 KV 创建对话（Blob 不可读，全线走 KV）
  const conversationId = generateId();
  const title = body.title || '新对话';
  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const conversation: Conversation = {
    id: conversationId,
    user_id: userId,
    title,
    created_at: Date.now(),
    updated_at: Date.now(),
    message_count: 0,
  };
  await kv.createConversation(conversation);
  log(SRC, { method: 'POST', path: pathname, userId, convId: conversationId, source: 'kv', status: 201, dur: Date.now() - t0 });
  return json(201, { conversation });
}
