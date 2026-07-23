/**
 * 对话管理 API - 详情、更新、删除
 *
 * 路径: GET/PUT/DELETE /api/conversations/:id
 * 通过 context.agent.store 读取 Agent 对话数据（Blob 存储）
 *
 * 官方文档：https://pages.edgeone.ai/zh/document/agents-conversation-storage
 *
 * 注意事项：
 * - getMessages 返回 Array<Message> 直接（不是 { items } 对象）
 * - limit 上限 100（之前写 500 会抛 MemoryValidationError）
 * - Message 字段：messageId, role, content, createdAt（驼峰命名）
 * - ConversationMeta 字段：conversationId, createdAt, lastMessageAt, messageCount
 *   没有 title 字段，标题只能写在 metadata 里
 */
import { KVStore } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'conversations-detail';

function getConvIdFromPath(pathname: string): string {
  return pathname.split('/').pop() || '';
}

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  const convId = getConvIdFromPath(pathname);

  // 从 context.agent.store 读取消息（Blob 存储）
  // API 返回值是 Array<Message> 直接，不是 { items }
  if (context.agent?.store?.getMessages) {
    try {
      const messages: any[] = await context.agent.store.getMessages({
        conversationId: convId,
        limit: 100,  // 文档上限 100
        order: 'asc',
      });
      if (Array.isArray(messages) && messages.length > 0) {
        log(SRC, { method: 'GET', path: pathname, convId, msgCount: messages.length, source: 'agent.store', status: 200, dur: Date.now() - t0 });
        return json(200, {
          conversation: { id: convId },
          messages: messages.map((m: any) => ({
            role: m.role,
            content: m.content,
            created_at: m.createdAt || m.created_at,
            message_id: m.messageId,
          })),
        });
      }
      log(SRC, { method: 'GET', path: pathname, convId, msgCount: 0, source: 'agent.store.empty', dur: Date.now() - t0 });
    } catch (e) {
      log(SRC, { method: 'GET', path: pathname, convId, source: 'agent.store.error', error: (e as Error).message, dur: Date.now() - t0 });
    }
  } else {
    log(SRC, { method: 'GET', path: pathname, convId, source: 'agent.store.unavailable', dur: Date.now() - t0 });
  }

  // 降级：从 KV 读取
  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const conv = await kv.getConversation(convId);
  if (!conv) return json(404, { error: '对话不存在' });
  const messages = await kv.listConversationMessages(convId);
  log(SRC, { method: 'GET', path: pathname, convId, msgCount: messages.length, source: 'kv', status: 200, dur: Date.now() - t0 });
  return json(200, { conversation: conv, messages });
}

export async function onRequestPut(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const convId = getConvIdFromPath(pathname);
  const body = await request.json();

  if (context.agent?.store?.updateConversation) {
    try {
      await context.agent.store.updateConversation({ conversationId: convId, metadata: { title: body.title } });
      return json(200, { conversation: { id: convId, title: body.title }, message: '已更新' });
    } catch { /* fallback */ }
  }

  await kv.updateConversation(convId, { title: body.title });
  return json(200, { message: '已更新' });
}

export async function onRequestDelete(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });

  const convId = getConvIdFromPath(pathname);

  if (context.agent?.store?.deleteConversation) {
    try {
      await context.agent.store.deleteConversation(convId);
      return json(200, { message: '已删除' });
    } catch { /* fallback */ }
  }

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  await kv.deleteConversation(convId);
  return json(200, { message: '已删除' });
}
