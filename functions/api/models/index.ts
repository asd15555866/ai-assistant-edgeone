/**
 * 可用模型列表 API
 * 路径: GET /api/models（精确匹配）
 * 鉴权：管理员
 *
 * 设计：按模型粒度探测，每个模型独立发 chat/completions 请求，
 * 只有返回 200 的模型才显示。
 *
 * 为什么不按厂商探测？
 * - 同一厂商的不同模型可能有不同的可用性（免费模型超时、旧模型下线等）
 * - 用户需求：能正常对话的才显示，不能的要隐藏
 */
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log, logError } from '../../../_shared/logger';
import { createTimeoutSignal } from '../../../_shared/abort';

const SRC = 'models';

// 所有已知模型列表（不分厂商，逐个探测）
// EdgeOne 官方文档：https://pages.edgeone.ai/zh/document/models-vendors-overview
const ALL_KNOWN_MODELS = [
  // === 内置免费模型（@makers/ 前缀）===
  '@makers/hy3',
  '@makers/hy3-preview',
  '@makers/deepseek-v4-pro',
  '@makers/deepseek-v4-flash',
  '@makers/minimax-m3',
  '@makers/minimax-m2.7',
  '@makers/kimi-k2.6',

  // === OpenAI ===
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.5',
  'openai/gpt-5.5-pro',
  'openai/gpt-5.4',
  'openai/gpt-5.4-pro',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',

  // === Anthropic ===
  'anthropic/claude-fable-5',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-4-8',
  'anthropic/claude-opus-4-7',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-opus-4-5-20251101',
  'anthropic/claude-haiku-4-5-20251001',
  'anthropic/claude-sonnet-4-5-20250929',

  // === Google ===
  'google/gemini-3.5-flash',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',

  // === DeepSeek ===
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',

  // === MiniMax ===
  'minimax/minimax-m3',
  'minimax/minimax-m2.7',
  'minimax/minimax-m2.7-highspeed',
  'minimax/minimax-m2.5',
  'minimax/minimax-m2.5-highspeed',

  // === 混元 ===
  'hunyuan/hy3',
  'hunyuan/hy3-preview',
  'hunyuan/hunyuan-role-latest',

  // === 智谱 ===
  'zai/glm-5.2',
  'zai/glm-5.1',
  'zai/glm-5',
  'zai/glm-4.7',
  'zai/glm-4.7-flashx',
  'zai/glm-4.6',

  // === 月之暗面 ===
  'moonshot/kimi-k3',
  'moonshot/kimi-k2.7-code',
  'moonshot/kimi-k2.7-code-highspeed',
  'moonshot/kimi-k2.6',
  'moonshot/kimi-k2.5',
];

/**
 * 探测单个模型（必须返回 200 才视为可用）
 */
async function probeModel(baseUrl: string, apiKey: string, model: string): Promise<boolean> {
  const isGateway = baseUrl.replace(/\/+$/, '').endsWith('/v1');
  const url = isGateway
    ? `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    : `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
      }),
      signal: createTimeoutSignal(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

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
      count: 0,
      message: '未配置网关 API Key（AI_GATEWAY_API_KEY）。',
    });
  }

  try {
    // 并发探测所有模型（Promise.allSettled 避免单个超时影响整体）
    const probePromises = ALL_KNOWN_MODELS.map(async (model) => {
      const ok = await probeModel(baseUrl, apiKey, model);
      return { model, ok };
    });
    const results = await Promise.allSettled(probePromises);

    const workingModels: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) {
        workingModels.push(r.value.model);
      }
    }

    log(SRC, {
      method: 'GET', path: '/api/models', userId: payload.user_id,
      source: 'probed',
      total: ALL_KNOWN_MODELS.length,
      working: workingModels.length,
      dur: Date.now() - t0,
    });
    return json(200, {
      models: workingModels,
      source: 'probed',
      count: workingModels.length,
    });
  } catch (e) {
    logError(SRC, { method: 'GET', path: '/api/models', userId: payload.user_id, err: (e as Error).message, dur: Date.now() - t0 });
    return json(200, {
      models: [],
      source: 'fallback',
      count: 0,
      message: `探测失败: ${(e as Error).message}`,
    });
  }
}