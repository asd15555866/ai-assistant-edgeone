/**
 * 共享响应辅助函数
 *
 * 所有 Cloud Functions 统一使用此函数构造 JSON 响应，
 * 避免每个文件重复定义 json()。
 */
export function json(status: number, data: any) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
