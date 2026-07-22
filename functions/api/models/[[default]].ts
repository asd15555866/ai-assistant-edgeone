/**
 * 可用模型列表 API
 *
 * 路径: /api/models
 * 鉴权：管理员
 */

import { getUserFromRequest } from '../../../_shared/jwt';
import { log, logError } from '../../../_shared/logger';

const SRC = 'cloud-functions';

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  if (payload.role !== 'admin') return json(403, { error: '仅管理员可查询' });

  const baseUrl = env.AI_GATEWAY_BASE_URL || 'https://api.deepseek.com';
  const apiKey = env.AI_GATEWAY_API_KEY || env.DEEPSEEK_API_KEY || '';

  if (!apiKey) {
    log(SRC, { method: 'GET', path: '/api/models', userId: payload.user_id, source: 'none', dur: Date.now() - t0 });
    return json(200, {
      models: [],
      source: 'none',
      message: '未配置网关 API Key（AI_GATEWAY_API_KEY），请到 EdgeOne 控制台 Models 页面配置。',
    });
  }

  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      log(SRC, { method: 'GET', path: '/api/models', userId: payload.user_id, source: 'gateway_error', gatewayStatus: response.status, dur: Date.now() - t0 });
      return json(200, {
        models: [],
        source: 'error',
        message: `网关返回 ${response.status}：${await response.text().catch(() => '')}`,
      });
    }

    const data: any = await response.json();
    // OpenAI 兼容格式：{ data: [{ id: "model-name" }, ...] }
    const models: string[] = (data.data || []).map((m: any) => m.id).filter(Boolean);

    log(SRC, { method: 'GET', path: '/api/models', userId: payload.user_id, source: 'gateway', modelCount: models.length, dur: Date.now() - t0 });
    return json(200, { models, source: 'gateway', count: models.length });
  } catch (e) {
    logError(SRC, { method: 'GET', path: '/api/models', userId: payload.user_id, err: (e as Error).message, dur: Date.now() - t0 });
    return json(200, {
      models: [],
      source: 'error',
      message: `调用网关失败: ${(e as Error).message}`,
    });
  }
}

function json(status: number, data: any) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
