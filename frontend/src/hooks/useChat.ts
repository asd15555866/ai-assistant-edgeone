/**
 * 聊天 Hook
 * 处理消息发送、SSE 流式接收、历史消息加载
 */
import { useState, useCallback, useRef } from 'react';

export type Message = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  intermediate_states?: Array<{ type: string; message: string; timestamp: number }>;
  created_at: number;
};

type ChatState = {
  messages: Message[];
  isStreaming: boolean;
  currentStreamContent: string;
  currentState: string | null;
  error: string | null;
};

export function useChat() {
  const [state, setState] = useState<ChatState>({
    messages: [],
    isStreaming: false,
    currentStreamContent: '',
    currentState: null,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setState((prev) => ({
          ...prev,
          messages: data.messages || [],
          error: null,
        }));
      }
    } catch (e) {
      setState((prev) => ({ ...prev, error: (e as Error).message }));
    }
  }, []);

  const sendMessage = useCallback(
    async (message: string, conversationId: string) => {
      // 添加用户消息
      const userMsg: Message = {
        id: 'temp-' + Date.now(),
        conversation_id: conversationId,
        role: 'user',
        content: message,
        created_at: Date.now(),
      };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMsg],
        isStreaming: true,
        currentStreamContent: '',
        currentState: '正在思考...',
        error: null,
      }));

      // 尝试 SSE 流式
      try {
        const controller = new AbortController();
        abortRef.current = controller;

        const res = await fetch(
          `/agents/chat-assistant`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              // 使用平台 Makers-Conversation-Id 请求头驱动会话粘性路由和对话存储
              'Makers-Conversation-Id': conversationId,
            },
            body: JSON.stringify({ message }),
            credentials: 'include',
            signal: controller.signal,
          }
        );

        if (!res.ok) {
          // 回退到非流式
          throw new Error('SSE not available');
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('No reader');

        const decoder = new TextDecoder();
        let fullContent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          let currentEvent = 'message'; // 默认事件类型

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
              continue;
            }
            if (line.startsWith('data: ')) {
              const data = line.slice(6);

              // 根据事件类型处理数据
              switch (currentEvent) {
                case 'state': {
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'executing') {
                      setState((prev) => ({ ...prev, currentState: parsed.message }));
                    } else if (parsed.type === 'error') {
                      setState((prev) => ({ ...prev, error: parsed.message }));
                    } else if (parsed.type === 'thinking') {
                      setState((prev) => ({ ...prev, currentState: parsed.message }));
                    }
                  } catch { /* ignore parse errors */ }
                  break;
                }

                case 'message': {
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.content !== undefined) {
                      fullContent += parsed.content;
                      setState((prev) => ({ ...prev, currentStreamContent: fullContent }));
                    }
                  } catch {
                    fullContent += data;
                    setState((prev) => ({ ...prev, currentStreamContent: fullContent }));
                  }
                  break;
                }

                case 'done': {
                  try {
                    const parsed = JSON.parse(data);
                    const assistantMsg: Message = {
                      id: 'msg-' + Date.now(),
                      conversation_id: conversationId,
                      role: 'assistant',
                      content: fullContent,
                      created_at: Date.now(),
                    };
                    setState((prev) => ({
                      ...prev,
                      messages: [...prev.messages, assistantMsg],
                      isStreaming: false,
                      currentStreamContent: '',
                      currentState: null,
                    }));
                  } catch { /* ignore */ }
                  break;
                }

                case 'error': {
                  try {
                    const parsed = JSON.parse(data);
                    setState((prev) => ({
                      ...prev,
                      error: parsed.error || parsed.message || '未知错误',
                      isStreaming: false,
                      currentState: null,
                    }));
                  } catch { /* ignore */ }
                  break;
                }

                default: {
                  // 无事件类型或未知事件类型，尝试直接解析 JSON
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.content !== undefined) {
                      fullContent += parsed.content;
                      setState((prev) => ({ ...prev, currentStreamContent: fullContent }));
                    } else if (parsed.conversation_id) {
                      const assistantMsg: Message = {
                        id: 'msg-' + Date.now(),
                        conversation_id: conversationId,
                        role: 'assistant',
                        content: fullContent,
                        created_at: Date.now(),
                      };
                      setState((prev) => ({
                        ...prev,
                        messages: [...prev.messages, assistantMsg],
                        isStreaming: false,
                        currentStreamContent: '',
                        currentState: null,
                      }));
                    }
                  } catch {
                    fullContent += data;
                    setState((prev) => ({ ...prev, currentStreamContent: fullContent }));
                  }
                }
              }
              // 处理完 data 后重置事件类型
              currentEvent = 'message';
            }
          }
        }
      } catch (e) {
        // SSE 失败，使用 JSON 回退
        try {
          const res = await fetch(
            `/agents/chat-assistant`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Makers-Conversation-Id': conversationId,
              },
              body: JSON.stringify({ message }),
              credentials: 'include',
            }
          );
          const data = await res.json();
          const assistantMsg: Message = {
            id: 'msg-' + Date.now(),
            conversation_id: conversationId,
            role: 'assistant',
            content: data.message || data.error || '处理失败',
            intermediate_states: data.intermediate_states,
            created_at: Date.now(),
          };
          setState((prev) => ({
            ...prev,
            messages: [...prev.messages, assistantMsg],
            isStreaming: false,
            currentStreamContent: '',
            currentState: null,
            error: data.error || null,
          }));
        } catch (err) {
          setState((prev) => ({
            ...prev,
            isStreaming: false,
            error: (err as Error).message,
            currentState: null,
          }));
        }
      }
    },
    []
  );

  const clearMessages = useCallback(() => {
    setState({
      messages: [],
      isStreaming: false,
      currentStreamContent: '',
      currentState: null,
      error: null,
    });
  }, []);

  return {
    ...state,
    sendMessage,
    loadMessages,
    clearMessages,
    abort: () => abortRef.current?.abort(),
  };
}
