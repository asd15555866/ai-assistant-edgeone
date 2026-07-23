/**
 * 可用模型列表 API
 * 路径: GET /api/models（精确匹配）
 * 鉴权：管理员
 *
 * 设计：
 * - 内置免费模型：静态列表，始终可用
 * - 自费厂商模型：探测网关（每个厂商选一个代表模型），
 *   可用的厂商才展开该厂商的全部模型
 *
 * 为什么不直接调 /v1/models？
 * - EdgeOne AI Gateway（ai-gateway.edgeone.link）不暴露 /v1/models 端点
 * - 改用 chat/completions 探测，每个厂商一次请求即可
 */
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log, logError } from '../../../_shared/logger';
import { createTimeoutSignal } from '../../../_shared/abort';

const SRC = 'models';

// 内置免费模型（EdgeOne Makers 官方提供，无需 API Key）
const BUILTIN_MODELS = [
  '@makers/hy3',
  '@makers/hy3-preview',
  '@makers/deepseek-v4-pro',
  '@makers/deepseek-v4-flash',
  '@makers/minimax-m3',
  '@makers/minimax-m2.7',
  '@makers/kimi-k2.6',
];

// 自费厂商模型：每个厂商选一个最便宜的代表模型做探测
// 探测成功的厂商 → 展开显示该厂商的全部模型
// 模型名以 EdgeOne 官方文档为准：https://pages.edgeone.ai/zh/document/models-vendors-overview
const VENDOR_PROBES: Record<string, { probe: string; models: string[] }> = {
  'OpenAI': {
    probe: 'openai/gpt-5.4-nano',
    models: [
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
      'openai/gpt-5.5',
      'openai/gpt-5.5-pro',
      'openai/gpt-5.4',
      'openai/gpt-5.4-pro',
      'openai/gpt-5.4-mini',
      'openai/gpt-5.4-nano',
    ],
  },
  'Anthropic': {
    probe: 'anthropic/claude-haiku-4-5-20251001',
    models: [
      'anthropic/claude-fable-5',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-5-20251101',
      'anthropic/claude-haiku-4-5-20251001',
      'anthropic/claude-sonnet-4-5-20250929',
    ],
  },
  'Google': {
    probe: 'google/gemini-2.5-flash-lite',
    models: [
      'google/gemini-3.5-flash',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.1-flash-lite',
      'google/gemini-3-flash-preview',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-flash-lite',
    ],
  },
  'DeepSeek': {
    probe: 'deepseek/deepseek-v4-flash',
    models: [
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-pro',
    ],
  },
  'MiniMax': {
    probe: 'minimax/minimax-m2.5-highspeed',
    models: [
      'minimax/minimax-m3',
      'minimax/minimax-m2.7',
      'minimax/minimax-m2.7-highspeed',
      'minimax/minimax-m2.5',
      'minimax/minimax-m2.5-highspeed',
    ],
  },
  '混元': {
    probe: 'hunyuan/hy3-preview',
    models: [
      'hunyuan/hy3',
      'hunyuan/hy3-preview',
      'hunyuan/hunyuan-role-latest',
    ],
  },
  '智谱': {
    probe: 'zai/glm-4.7-flashx',
    models: [
      'zai/glm-5.2',
      'zai/glm-5.1',
      'zai/glm-5',
      'zai/glm-4.7',
      'zai/glm-4.7-flashx',
      'zai/glm-4.6',
    ],
  },
  '月之暗面': {
    probe: 'moonshot/kimi-k2.6',
    models: [
      'moonshot/kimi-k3',
      'moonshot/kimi-k2.7-code',
      'moonshot/kimi-k2.7-code-highspeed',
      'moonshot/kimi-k2.6',
      'moonshot/kimi-k2.5',
    ],
  },
};

/**
 * 探测单个模型是否可用（返回 200 即视为可用）
 * 用最小请求：max_tokens=1，单条 test 消息
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
      signal: createTimeoutSignal(8000),
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

  // 未配置 AI_GATEWAY_API_KEY：仅返回内置模型
  if (!apiKey) {
    log(SRC, { method: 'GET', path: '/api/models', userId: payload.user_id, source: 'none', dur: Date.now() - t0 });
    return json(200, {
      models: BUILTIN_MODELS,
      builtin: BUILTIN_MODELS,
      vendorModels: {},
      source: 'none',
      count: BUILTIN_MODELS.length,
      message: '未配置网关 API Key，仅显示内置免费模型。',
    });
  }

  try {
    // 并发探测每个厂商的代表模型（探测失败的视为该厂商 API Key 未绑定）
    const probes = Object.entries(VENDOR_PROBES).map(async ([vendor, info]) => {
      const available = await probeModel(baseUrl, apiKey, info.probe);
      return { vendor, available, models: info.models };
    });
    const results = await Promise.all(probes);

    const vendorModels: Record<string, string[]> = {};
    for (const r of results) {
      if (r.available) vendorModels[r.vendor] = r.models;
    }
    const allModels = [...BUILTIN_MODELS, ...Object.values(vendorModels).flat()];

    log(SRC, {
      method: 'GET', path: '/api/models', userId: payload.user_id,
      source: 'probed',
      builtinCount: BUILTIN_MODELS.length,
      vendorCount: Object.keys(vendorModels).length,
      probedVendors: Object.keys(VENDOR_PROBES).filter(v => !(v in vendorModels)),
      dur: Date.now() - t0,
    });
    return json(200, {
      models: allModels,
      builtin: BUILTIN_MODELS,
      vendorModels,
      source: 'probed',
      count: allModels.length,
    });
  } catch (e) {
    logError(SRC, { method: 'GET', path: '/api/models', userId: payload.user_id, err: (e as Error).message, dur: Date.now() - t0 });
    // 探测异常时降级到内置模型
    return json(200, {
      models: BUILTIN_MODELS,
      builtin: BUILTIN_MODELS,
      vendorModels: {},
      source: 'fallback',
      count: BUILTIN_MODELS.length,
      message: `探测失败: ${(e as Error).message}`,
    });
  }
}