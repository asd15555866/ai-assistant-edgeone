/**
 * KV 调试端点（临时）
 * 返回 KV list 的实际结构，方便调试
 */
export async function onRequestGet(context: any) {
  const kv = (globalThis as any).AI_ASSISTANT_KV;

  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV not found' }), { status: 200 });
  }

  // 写入测试数据
  try {
    await kv.put('__test_a', '1');
    await kv.put('__test_b', '2');
  } catch (e) {
    return new Response(JSON.stringify({ error: 'put failed: ' + (e as Error).message }), { status: 200 });
  }

  // 列出所有
  let listResult: any = null;
  let listError: any = null;
  try {
    listResult = await kv.list();
  } catch (e) {
    listError = (e as Error).message;
  }

  // 用 prefix
  let prefixResult: any = null;
  let prefixError: any = null;
  try {
    prefixResult = await kv.list({ prefix: '__test_' });
  } catch (e) {
    prefixError = (e as Error).message;
  }

  // 直接 get
  const valA = await kv.get('__test_a');

  // 清理
  await kv.delete('__test_a');
  await kv.delete('__test_b');

  return new Response(JSON.stringify({
    kvType: kv.constructor?.name,
    listResultRaw: listResult,
    listResultKeys: listResult ? Object.keys(listResult) : null,
    listError,
    prefixResultRaw: prefixResult,
    prefixError,
    getValue: valA,
  }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
