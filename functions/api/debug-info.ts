/**
 * 调试端点：返回请求的所有信息
 * 访问 /api/debug-info 看 EdgeOne 实际传递的 path 是什么
 */
export async function onRequestGet(context: any) {
  const { request, env } = context;
  const url = new URL(request.url);
  return new Response(JSON.stringify({
    pathname: url.pathname,
    search: url.search,
    href: url.href,
    host: url.host,
    method: request.method,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost(context: any) {
  return onRequestGet(context);
}
