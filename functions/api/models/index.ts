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
const VENDOR_PROBES: Record<string, { probe: string; models: string[] }> = {
  'OpenAI': {
    probe: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/gpt-4-turbo', 'openai/gpt-3.5-turbo'],
  },
  'Anthropic': {
    probe: 'anthropic/claude-3-5-haiku-latest',
    models: ['anthropic/claude-3-5-sonnet-latest', 'anthropic/claude-3-5-haiku-latest', 'anthropic/claude-3-opus-latest'],
  },
  'Google': {
    probe: 'google/gemini-1.5-flash-latest',
    models: ['google/gemini-1.5-pro-latest', 'google/gemini-1.5-flash-latest'],
  },
  'DeepSeek': {
    probe: 'deepseek/deepseek-chat',
    models: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'],
  },
  '混元': {
    probe: 'hunyuan/hunyuan-standard',
    models: ['hunyuan/hunyuan-pro', 'hunyuan/hunyuan-standard'],
  },
  '智谱': {
    probe: 'zai/glm-4.7-flashx',
    models: ['zai/glm-5.1', 'zai/glm-5', 'zai/glm-5-turbo', 'zai/glm-4.7', 'zai/glm-4.7-flashx', 'zai/glm-4.6'],
  },
  '月之暗面': {
    probe: 'moonshot/moonshot-v1-8k',
    models: ['moonshot/moonshot-v1-8k', 'moonshot/moonshot-v1-32k', 'moonshot/moonshot-v1-128k'],
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