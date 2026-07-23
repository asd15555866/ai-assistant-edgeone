/**
 * 健康检查端点
 *
 * 路径: GET /api/health
 * 用途：平台健康检查、监控告警、负载均衡器探测
 * 响应：{ status: "ok", uptime: "..." }
 */

export function onRequest() {
  return new Response(
    JSON.stringify({
      status: 'ok',
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
