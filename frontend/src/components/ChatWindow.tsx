import React, { useRef, useEffect } from 'react';
import { Send, Square, Sparkles, Globe, Terminal, MousePointerClick, Clock, Plus } from 'lucide-react';
import MessageBubble from './MessageBubble';
import type { Message as MessageType } from '../hooks/useChat';

type Props = {
  messages: MessageType[];
  isStreaming: boolean;
  currentStreamContent: string;
  currentState: string | null;
  error: string | null;
  input: string;
  onInputChange: (val: string) => void;
  onSend: () => void;
  onStop: () => void;
  onNewChat: () => void;
};

const suggestions = [
  { icon: Globe, text: '帮我查一下今天的新闻' },
  { icon: Terminal, text: '算一下 123 × 456' },
  { icon: MousePointerClick, text: '登录 example.com 看看' },
  { icon: Clock, text: '每天 9 点抓取新闻' },
];

export default function ChatWindow({
  messages, isStreaming, currentStreamContent, currentState, error, input, onInputChange, onSend, onStop, onNewChat,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const showWelcome = messages.length === 0 && !isStreaming;

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, currentStreamContent, currentState]);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 150) + 'px';
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white">
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto">
        {showWelcome ? (
          <div className="flex flex-col items-center justify-center min-h-full px-6 py-12">
            {/* Logo */}
            <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-blue-200">
              <Sparkles size={32} className="text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">有什么我可以帮助你的？</h1>
            <p className="text-sm text-gray-400 mb-8">我可以搜索信息、执行代码、操作浏览器，还能设置定时任务</p>

            {/* 建议卡片 */}
            <div className="grid grid-cols-2 gap-3 max-w-lg w-full">
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  onClick={() => { onInputChange(s.text); inputRef.current?.focus(); }}
                  className="flex items-start gap-3 p-4 rounded-2xl border border-gray-100 bg-white hover:border-blue-200 hover:shadow-sm transition-all text-left group"
                >
                  <s.icon size={18} className="text-gray-400 group-hover:text-blue-500 flex-shrink-0 mt-0.5 transition-colors" />
                  <span className="text-sm text-gray-600 group-hover:text-gray-900 leading-relaxed transition-colors">{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} {...msg} />
            ))}
            {isStreaming && currentStreamContent && (
              <MessageBubble role="assistant" content={currentStreamContent} isStreaming />
            )}
            {isStreaming && !currentStreamContent && currentState && (
              <MessageBubble role="assistant" content="" isStreaming currentState={currentState} />
            )}
            {error && (
              <div className="text-center text-sm text-red-500 bg-red-50 rounded-xl px-4 py-2.5 mx-4">{error}</div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区域 */}
      <div className="border-t border-gray-100 bg-white px-4 py-3">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-2 bg-gray-50 rounded-2xl border border-gray-200 px-4 py-2.5 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 transition-all">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入消息..."
              rows={1}
              disabled={isStreaming}
              className="flex-1 bg-transparent resize-none text-sm text-gray-900 placeholder-gray-400 outline-none max-h-[150px] leading-relaxed"
            />
            {isStreaming ? (
              <button onClick={onStop} className="flex-shrink-0 p-2 rounded-xl bg-gray-200 hover:bg-gray-300 text-gray-600 transition-colors" title="停止">
                <Square size={16} className="fill-current" />
              </button>
            ) : (
              <button
                onClick={onSend}
                disabled={!input.trim()}
                className="flex-shrink-0 p-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:bg-gray-200 disabled:text-gray-400 transition-all"
                title="发送"
              >
                <Send size={16} />
              </button>
            )}
          </div>
          <div className="text-center mt-2 text-xs text-gray-300">
            Enter 发送 · Shift+Enter 换行
          </div>
        </div>
      </div>
    </div>
  );
}
