/**
 * 系统设置 API
 * 路径: GET/PUT /api/settings（精确匹配）
 * 鉴权：管理员
 */
import { KVStore } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { getUserFromRequest } from '../../../_shared/jwt';
import { log } from '../../../_shared/logger';

const SRC = 'settings';

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  if (payload.role !== 'admin') return json(403, { error: '仅管理员可管理系统设置' });

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const settings = await kv.getAllSettings();
  log(SRC, { method: 'GET', path: '/api/settings', userId: payload.user_id, keyCount: Object.keys(settings).length, dur: Date.now() - t0 });
  return json(200, { settings });
}

export async function onRequestPut(context: any) {
  const { request, env } = context;
  const t0 = Date.now();
  const payload = await getUserFromRequest(request, env.JWT_SECRET);
  if (!payload) return json(401, { error: '未登录' });
  if (payload.role !== 'admin') return json(403, { error: '仅管理员可管理系统设置' });

  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const body = await request.json();
  const allowedKeys = ['cron_scan_interval', 'notification_email', 'default_timeout_ms', 'ai_model'];

  for (const [key, value] of Object.entries(body)) {
    if (allowedKeys.includes(key)) {
      await kv.setSetting(key, String(value));
    }
  }

  const settings = await kv.getAllSettings();
  log(SRC, { method: 'PUT', path: '/api/settings', userId: payload.user_id, keys: Object.keys(body).join(','), dur: Date.now() - t0 });
  return json(200, { settings, message: '设置已更新' });
}
