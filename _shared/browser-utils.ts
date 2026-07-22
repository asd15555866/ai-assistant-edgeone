/**
 * 浏览器工具函数（共享模块）
 *
 * 从 agents/chat-assistant/index.ts 和 functions/api/cron-trigger.ts 中提取，
 * 消除约 200 行重复代码。两处功能完全一致：
 *   - saveBrowserCookies：浏览器 Cookie 提取并保存到 KV
 *   - restoreBrowserCookies：从 KV 恢复 Cookie 到浏览器
 *   - detectLoginChallenge：检测登录后是否遇到验证码/二次验证
 */

import { KVStore } from './kv';

/**
 * 从浏览器提取 Cookies 并保存到 KV，附带最早过期时间。
 *
 * 存储格式：{ raw, expires_at, saved_at }
 * - raw: document.cookie 字符串
 * - expires_at: 保守估算 7 天后的时间戳（document.cookie 无法获取精确过期时间）
 * - saved_at: 保存时间戳
 *
 * 注意：document.cookie 无法获取 httpOnly 的 Cookie，
 * 对于需要完整会话保持的场景，建议使用 browser.cdpUrl 配合外部 Playwright 接管浏览器。
 */
export async function saveBrowserCookies(
  sandbox: any,
  kv: KVStore,
  cookiesKey: string,
  trace: string[]
): Promise<void> {
  try {
    let raw = '';
    let earliestExpiry: number | null = null;

    if (sandbox?.browser?.evaluate) {
      raw = await sandbox.browser.evaluate('document.cookie');
      if (raw) {
        earliestExpiry = Date.now() + 7 * 86400000; // 保守估算 7 天
      }
    }

    if (raw) {
      const payload = JSON.stringify({
        raw,
        expires_at: earliestExpiry,
        saved_at: Date.now(),
      });
      await kv.setSetting(cookiesKey, payload);
      const expiryInfo = earliestExpiry
        ? `最早过期: ${new Date(earliestExpiry).toLocaleString('zh-CN')}`
        : '会话 Cookie（无过期时间）';
      trace.push(`[cookies] Cookies 已保存 (${raw.length} 字符, ${expiryInfo})`);
    }
  } catch (e) {
    trace.push(`[cookies] 保存 Cookies 失败: ${(e as Error).message}`);
  }
}

/**
 * 从 KV 恢复 Cookies 到浏览器。
 *
 * 过期检测逻辑：
 * 1. 读取保存的 payload，提取 expires_at
 * 2. 如果 expires_at 存在且 < 当前时间 → Cookies 已过期 → 返回 false
 * 3. 未过期 → 恢复 Cookies 到浏览器
 *
 * 返回 true 表示恢复成功，false 表示 Cookies 已过期或不存在。
 */
export async function restoreBrowserCookies(
  sandbox: any,
  cookiesStr: string,
  trace: string[]
): Promise<boolean> {
  if (!cookiesStr) return false;

  try {
    let raw: string;
    let expiresAt: number | null = null;

    if (cookiesStr.startsWith('{') && cookiesStr.includes('"raw"')) {
      const payload = JSON.parse(cookiesStr);
      raw = payload.raw;
      expiresAt = payload.expires_at || null;
    } else {
      raw = cookiesStr; // 兼容旧格式
    }

    // 过期检测
    if (expiresAt && expiresAt < Date.now()) {
      trace.push(`[cookies] ⚠ Cookies 已过期 (过期时间: ${new Date(expiresAt).toLocaleString('zh-CN')})`);
      return false;
    }

    // 通过 evaluate 注入 Cookie
    if (sandbox?.browser?.evaluate) {
      const pairs = raw.split(';').filter(Boolean);
      for (const pair of pairs) {
        await sandbox.browser.evaluate(`document.cookie = ${JSON.stringify(pair.trim())}`);
      }
      trace.push(`[cookies] 已恢复 ${pairs.length} 个 Cookie`);
      return true;
    }
  } catch (e) {
    trace.push(`[cookies] 恢复 Cookies 失败: ${(e as Error).message}`);
  }
  return false;
}

/**
 * 检测登录后是否遇到验证码/二次验证。
 * 通过检查页面 URL 和内容中的 40+ 关键词来判断。
 *
 * 常见触发场景：
 * - 人机验证：滑块验证、点击验证、选图验证、reCAPTCHA
 * - 二次验证：短信验证码、邮箱验证码、Authenticator 扫码、2FA
 * - 安全检查："检测到新设备登录"、"确认这是你本人吗"
 */
export async function detectLoginChallenge(sandbox: any, trace: string[]): Promise<boolean> {
  try {
    let currentUrl = '';
    let pageContent = '';

    if (sandbox?.browser?.evaluate) {
      currentUrl = await sandbox.browser.evaluate('window.location.href');
    }
    if (sandbox?.browser?.getContent) {
      const result = await sandbox.browser.getContent();
      pageContent = result.content || '';
    } else if (sandbox?.browser?.evaluate) {
      pageContent = await sandbox.browser.evaluate('document.body.innerText.substring(0, 3000)');
    }

    const combined = (currentUrl + ' ' + pageContent).toLowerCase();

    const challengeKeywords = [
      '验证码', '安全验证', '人机验证', '请完成验证', '滑动验证',
      '点击验证', '请按住滑块', '拼图验证',
      '二次验证', '两步验证', '双重验证', '2fa', 'two-factor',
      '短信验证', '手机验证', '邮箱验证', '验证码已发送',
      'authenticator', 'google authenticator',
      '确认身份', '验证身份', '安全检查', '可疑登录',
      '新设备', '确认这是你', '请确认', 'verify your identity',
      'captcha', 'recaptcha', 'hcaptcha', "verify you're human",
      'security check', 'enter the code', 'verification code',
      'two-factor authentication', 'sms code',
    ];

    for (const keyword of challengeKeywords) {
      if (combined.includes(keyword)) {
        trace.push(`[detect] 检测到验证/挑战: "${keyword}"`);
        return true;
      }
    }
    return false;
  } catch (e) {
    trace.push(`[detect] 检测失败（不影响主流程）: ${(e as Error).message}`);
    return false;
  }
}
