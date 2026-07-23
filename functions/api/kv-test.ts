/**
 * KV 绑定测试端点（临时）
 *
 * 用途：验证 AI_ASSISTANT_KV 是否通过全局变量注入（而非 env 对象）。
 * 根据 EdgeOne 官方 KV 模板源码，KV 绑定以全局变量形式存在，不是 env.xxx。
 */
export async function onRequestGet(context: any) {
  const { env } = context;

  // 方式 1：env 对象（之前一直用的方式，始终 undefined）
  const fromEnv = env.AI_ASSISTANT_KV;

  // 方式 2：全局变量（EdgeOne 模板源码采用的正确方式）
  const fromGlobal = (globalThis as any).AI_ASSISTANT_KV || (globalThis as any).ai_assistant_kv;

  // 方式 3：尝试所有可能的全局变量名
  const globalKeys = Object.getOwnPropertyNames(globalThis).filter(k =>
    k.toLowerCase().includes('kv') || k.toLowerCase().includes('assistant')
  );

  return new Response(
    JSON.stringify({
      fromEnv: fromEnv ? typeof fromEnv : null,
      fromGlobal: fromGlobal ? typeof fromGlobal : null,
      globalKeys,
      envKeys: Object.keys(env).filter(k => k.toUpperCase().includes('KV') || k.includes('kv')),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
