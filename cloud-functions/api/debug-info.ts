/**
 * 调试端点：返回请求的所有信息
 * 访问 /api/debug-info 看 EdgeOne 实际传递的 path 是什么
 */
import { KVStore } from '../../_shared/kv';

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const url = new URL(request.url);
  const convId = url.searchParams.get('convId');

  const info: any = {
    pathname: url.pathname,
    search: url.search,
    host: url.host,
    method: request.method,
    agentStoreAvailable: !!context.agent?.store,
  };

  // 尝试 agent.store 能力
  if (context.agent?.store) {
    const methods = ['getMessages', 'listConversations', 'appendMessage', 'deleteConversation'];
    for (const m of methods) {
      info[`agent.store.${m}`] = typeof context.agent.store[m];
    }

    // 如果传了 convId，尝试读消息
    if (convId && context.agent.store.getMessages) {
      try {
        const result = await context.agent.store.getMessages({ conversationId: convId, limit: 10 });
        info['agent.store.getMessages.result'] = JSON.stringify(result).slice(0, 500);
      } catch (e) {
        info['agent.store.getMessages.error'] = (e as Error).message;
      }
    }

    // 尝试 listConversations
    if (context.agent.store.listConversations) {
      try {
        const list = await context.agent.store.listConversations({});
        info['agent.store.listConversations'] = JSON.stringify(list).slice(0, 500);
      } catch (e) {
        info['agent.store.listConversations.error'] = (e as Error).message;
      }
    }
  }

  // KV 数据（如果有 convId）
  const kv = new KVStore(env.AI_ASSISTANT_KV);
  if (convId) {
    const conv = await kv.getConversation(convId);
    const msgs = await kv.listConversationMessages(convId);
    info.kv = {
      conversationExists: !!conv,
      messageCount: msgs.length,
      messageSample: msgs.slice(0, 2),
    };
  }

  // 列出 KV 中所有对话（最近 20 条）
  try {
    const allKeys = await kv['_listAllKeys']('conv:');
    info.kvConversations = allKeys.slice(0, 20);
  } catch { /* ignore */ }

  return new Response(JSON.stringify(info, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
