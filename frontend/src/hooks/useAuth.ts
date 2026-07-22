/**
 * 认证管理 Hook
 * 处理登录、注册、登出、当前用户状态
 */
import { useState, useEffect, useCallback } from 'react';

type User = {
  id: string;
  username: string;
  role: 'admin' | 'user';
};

type AuthState = {
  user: User | null;
  loading: boolean;
  error: string | null;
};

const API_BASE = '/api';

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
  });

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        credentials: 'include',
      });
      if (res.ok) {
        const user = await res.json();
        setState({ user, loading: false, error: null });
      } else {
        setState({ user: null, loading: false, error: null });
      }
    } catch {
      setState({ user: null, loading: false, error: '网络错误' });
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = async (username: string, password: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok) {
        setState({ user: data.user, loading: false, error: null });
        return true;
      } else {
        setState((s) => ({ ...s, loading: false, error: data.error }));
        return false;
      }
    } catch {
      setState((s) => ({ ...s, loading: false, error: '登录失败，请重试' }));
      return false;
    }
  };

  const register = async (username: string, password: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok) {
        setState({ user: data.user, loading: false, error: null });
        return true;
      } else {
        setState((s) => ({ ...s, loading: false, error: data.error }));
        return false;
      }
    } catch {
      setState((s) => ({ ...s, loading: false, error: '注册失败，请重试' }));
      return false;
    }
  };

  const logout = async () => {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    setState({ user: null, loading: false, error: null });
  };

  return { ...state, login, register, logout, checkAuth };
}
