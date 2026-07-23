/**
 * KV 绑定测试端点（临时）
 *
 * 读写测试：写入 test_key → 读取 test_key → 返回结果
 * 成功 = KV 完整可用，失败 = KV 只读/未绑定
 */
export async function onRequestGet(context: any) {
  const kv = (globalThis as any).AI_ASSISTANT_KV;

  if (!kv) {
    return new Response(JSON.stringify({ ok: false, error: 'KV not found in globalThis' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const testKey = 'kv_test_write';
  try {
    // 写入
    await kv.put(testKey, JSON.stringify({ ts: Date.now(), msg: 'hello from edgeone' }));
    // 读取
    const value = await kv.get(testKey);
    // 删除
    await kv.delete(testKey);

    return new Response(JSON.stringify({
      ok: true,
      read: value ? JSON.parse(value) : null,
      kvType: kv.constructor?.name || typeof kv,
      message: 'KV 读写删除全部正常！',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: (e as Error).message,
      operation: 'read/write/delete',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
}
