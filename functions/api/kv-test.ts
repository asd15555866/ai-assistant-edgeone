/**
 * KV 绑定测试端点（临时）
 *
 * 用途：验证 AI_ASSISTANT_KV 命名空间是否正确绑定到 Edge Functions。
 * 访问 GET /api/kv-test 会尝试读取 KV 中 'hello' 键的值。
 *
 * 正常绑定：返回 { bound: true, value: "world" }
 * 未绑定或读取失败：返回 { bound: false, error: "..." }
 */
export async function onRequestGet(context: any) {
  const { env } = context;

  // 检查 KV 绑定是否存在
  if (!env.AI_ASSISTANT_KV) {
    return new Response(
      JSON.stringify({
        bound: false,
        error: 'env.AI_ASSISTANT_KV is undefined - KV 绑定未生效',
        envKeys: Object.keys(env),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const value = await env.AI_ASSISTANT_KV.get('hello');
    return new Response(
      JSON.stringify({
        bound: true,
        key: 'hello',
        value: value,
        kvType: env.AI_ASSISTANT_KV.constructor?.name || 'unknown',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({
        bound: true,
        readError: (e as Error).message,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
