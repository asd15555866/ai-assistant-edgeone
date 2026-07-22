/**
 * JWT 工具函数（从 middleware.js 抽出）
 *
 * 不再作为 Edge Function 部署，仅作为 cloud-functions 和 agents 的 import 模块。
 * 鉴权由每个端点内部调用 getUserFromRequest 完成。
 */

function base64UrlEncode(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

async function signJWT(data, secret) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
  } catch {
    try {
      const { createHmac } = await import('node:crypto');
      const hmac = createHmac('sha256', secret);
      hmac.update(data);
      return base64UrlEncode(hmac.digest('base64url'));
    } catch {
      const hash = Array.from(new TextEncoder().encode(data + secret))
        .map((b) => String.fromCharCode(b))
        .join('');
      return base64UrlEncode(hash);
    }
  }
}

export async function createJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload = { ...payload, iat: now, exp: now + 86400 * 7 };
  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(tokenPayload));
  const signature = await signJWT(headerEncoded + '.' + payloadEncoded, secret);
  return headerEncoded + '.' + payloadEncoded + '.' + signature;
}

export async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerEncoded, payloadEncoded, signature] = parts;
    const expectedSignature = await signJWT(headerEncoded + '.' + payloadEncoded, secret);
    if (signature !== expectedSignature) return null;
    const payload = JSON.parse(base64UrlDecode(payloadEncoded));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader) {
  const result = {};
  cookieHeader.split(';').forEach((cookie) => {
    const [key, ...rest] = cookie.trim().split('=');
    if (key) result[key.trim()] = rest.join('=').trim();
  });
  return result;
}

/**
 * 从请求头中提取并验证 JWT，返回用户信息（失败返回 null）
 */
export async function getUserFromRequest(request, secret) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = parseCookies(cookieHeader);
  const token = cookies['ai_assistant_token'];
  if (!token) return null;
  return await verifyJWT(token, secret);
}
