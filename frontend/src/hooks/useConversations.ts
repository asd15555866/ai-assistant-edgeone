/**
 * 对话管理 Hook
 * 处理对话列表的 CRUD 操作
 */
import { useState, useEffect, useCallback } from 'react';

export type Conversation = {
  id: string;
  user_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
};

const API_BASE = '/api';

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConversations = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/conversations/`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('获取对话列表失败');
      const data = await res.json();
      setConversations(data.conversations || []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const createConversation = async (title?: string): Promise<Conversation | null> => {
    try {
      const res = await fetch(`${API_BASE}/conversations/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || '新对话' }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error('创建对话失败');
      const data = await res.json();
      setConversations((prev) => [data.conversation, ...prev]);
      return data.conversation;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const renameConversation = async (id: string, title: string) => {
    try {
      const res = await fetch(`${API_BASE}/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error('重命名失败');
      const data = await res.json();
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? data.conversation : c))
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteConversation = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/conversations/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('删除失败');
      setConversations((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return {
    conversations,
    loading,
    error,
    fetchConversations,
    createConversation,
    renameConversation,
    deleteConversation,
  };
}
