/**
 * 用户认证 API - 登录/注册/登出/当前用户
 *
 * 路径: /api/auth/login, /api/auth/register, /api/auth/me, /api/auth/logout
 * 不受 middleware.js 鉴权拦截
 */

import { KVStore, User, generateId } from '../../../_shared/kv';
import { json } from '../../../_shared/response';
import { createJWT, getUserFromRequest } from '../../../_shared/jwt';
import { log, logError } from '../../../_shared/logger';

const SRC = 'cloud-functions';

/**
 * 匹配 auth 路径后缀，兼容 EdgeOne 云函数可能去掉 /api 前缀的情况
 */
function matchAuthPath(pathname: string, suffix: string): boolean {
  return pathname.endsWith(suffix) || pathname.endsWith('/api' + suffix);
}

export async function onRequestGet(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);
  const t0 = Date.now();

  if (matchAuthPath(pathname, '/auth/me')) {
    const kv = new KVStore(env.AI_ASSISTANT_KV);
    const payload = await getUserFromRequest(request, env.JWT_SECRET);
    if (!payload) return json(401, { error: '未登录' });
    const user = await kv.getUser(payload.user_id);
    if (!user) return json(404, { error: '用户不存在' });
    log(SRC, { method: 'GET', path: pathname, userId: user.id, status: 200, dur: Date.now() - t0 });
    return json(200, { id: user.id, username: user.username, role: user.role });
  }

  log(SRC, { method: 'GET', path: pathname, status: 404, dur: Date.now() - t0 });
  return json(404, { error: 'Not Found' });
}

export async function onRequestPost(context: any) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);

  if (matchAuthPath(pathname, '/auth/login')) {
    return handleLogin(request, env);
  }
  if (matchAuthPath(pathname, '/auth/register')) {
    return handleRegister(request, env);
  }
  if (matchAuthPath(pathname, '/auth/logout')) {
    log(SRC, { method: 'POST', path: pathname, msg: 'logout' });
    const response = json(200, { message: '已退出登录' });
    response.headers.append(
      'Set-Cookie',
      'ai_assistant_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax'
    );
    return response;
  }

  return json(404, { error: 'Not Found' });
}

async function handleLogin(request: Request, env: any) {
  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const t0 = Date.now();
  try {
    const { username, password } = await request.json();
    if (!username || !password) {
      log(SRC, { method: 'POST', path: '/api/auth/login', status: 400, msg: 'empty credentials', dur: Date.now() - t0 });
      return json(400, { error: '用户名和密码不能为空' });
    }

    const user = await kv.getUserByUsername(username);
    if (!user) {
      log(SRC, { method: 'POST', path: '/api/auth/login', status: 401, msg: 'user not found', username, dur: Date.now() - t0 });
      return json(401, { error: '用户名或密码错误' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      log(SRC, { method: 'POST', path: '/api/auth/login', status: 401, msg: 'invalid password', userId: user.id, dur: Date.now() - t0 });
      return json(401, { error: '用户名或密码错误' });
    }

    // 如果还是旧版 DJB2 哈希，自动升级到新版
    if (!user.password_hash.startsWith('sha256$')) {
      const newHash = await hashPassword(password);
      await kv.updateUserHash(user.id, newHash);
    }

    const token = await createJWT(
      { user_id: user.id, username: user.username, role: user.role },
      env.JWT_SECRET
    );
    log(SRC, { method: 'POST', path: '/api/auth/login', userId: user.id, status: 200, dur: Date.now() - t0 });
    const response = json(200, {
      user: { id: user.id, username: user.username, role: user.role },
      token,
    });
    response.headers.append(
      'Set-Cookie',
      `ai_assistant_token=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${env.NODE_ENV === 'production' ? '; Secure' : ''}`
    );
    return response;
  } catch (e) {
    logError(SRC, { method: 'POST', path: '/api/auth/login', err: (e as Error).message, dur: Date.now() - t0 });
    return json(500, { error: '登录失败: ' + (e as Error).message });
  }
}

async function handleRegister(request: Request, env: any) {
  const kv = new KVStore(env.AI_ASSISTANT_KV);
  const t0 = Date.now();
  try {
    const { username, password } = await request.json();
    if (!username || !password) return json(400, { error: '用户名和密码不能为空' });
    if (username.length < 2 || username.length > 20) return json(400, { error: '用户名长度应在 2-20 个字符之间' });
    if (password.length < 6) return json(400, { error: '密码长度至少 6 个字符' });

    const existing = await kv.getUserByUsername(username);
    if (existing) {
      log(SRC, { method: 'POST', path: '/api/auth/register', status: 409, msg: 'username exists', username, dur: Date.now() - t0 });
      return json(409, { error: '用户名已存在' });
    }

    const existingUsers = await kv.listUsers();
    const role = existingUsers.length === 0 ? 'admin' : 'user';

    const user: User = {
      id: generateId(),
      username,
      password_hash: await hashPassword(password),
      role,
      created_at: Date.now(),
    };
    await kv.createUser(user);
    log(SRC, { method: 'POST', path: '/api/auth/register', userId: user.id, role, status: 201, dur: Date.now() - t0 });

    const token = await createJWT(
      { user_id: user.id, username: user.username, role: user.role },
      env.JWT_SECRET
    );
    const response = json(201, {
      user: { id: user.id, username: user.username, role: user.role },
      token,
    });
    response.headers.append(
      'Set-Cookie',
      `ai_assistant_token=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${env.NODE_ENV === 'production' ? '; Secure' : ''}`
    );
    return response;
  } catch (e) {
    logError(SRC, { method: 'POST', path: '/api/auth/register', err: (e as Error).message, dur: Date.now() - t0 });
    return json(500, { error: '注册失败: ' + (e as Error).message });
  }
}

/**
 * 使用 Web Crypto API 进行密码哈希（SHA-256 + 随机 salt）
 * 格式: "sha256$<salt>$<hash>"
 */
async function hashPassword(password: string): Promise<string> {
  try {
    const salt = generateSalt();
    const hash = await sha256(salt + password);
    return `sha256$${salt}$${hash}`;
  } catch {
    // 降级到 DJB2
    return simpleHash(password);
  }
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // 新格式: sha256$salt$hash
  if (stored.startsWith('sha256$')) {
    const parts = stored.split('$');
    if (parts.length === 3) {
      const [, salt, expectedHash] = parts;
      const actualHash = await sha256(salt + password);
      return actualHash === expectedHash;
    }
    return false;
  }
  // 兼容旧 DJB2 格式
  return stored === simpleHash(password);
}

/** 生成 16 字符密码学安全随机 salt */
function generateSalt(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randomValues = new Uint8Array(16);
  crypto.getRandomValues(randomValues);
  let salt = '';
  for (let i = 0; i < 16; i++) {
    salt += chars.charAt(randomValues[i] % chars.length);
  }
  return salt;
}

/** SHA-256 哈希（hex） */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 旧 DJB2 哈希（保持向后兼容） */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return 'v2_' + Math.abs(hash).toString(36);
}
