import React from 'react';
import { User, Sparkles, Loader2 } from 'lucide-react';

type IntermediateState = { type: string; message: string; timestamp: number };
type Props = {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  intermediateStates?: IntermediateState[];
  currentState?: string | null;
};

export default function MessageBubble({ role, content, isStreaming, intermediateStates, currentState }: Props) {
  const isUser = role === 'user';

  return (
    <div className={`flex gap-4 animate-[fadeIn_0.3s_ease-out] ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* 头像 */}
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
        isUser ? 'bg-gray-100 text-gray-600' : 'bg-blue-600 text-white shadow-sm'
      }`}>
        {isUser ? <User size={15} /> : <Sparkles size={15} />}
      </div>

      {/* 内容 */}
      <div className={`max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div className={`text-sm leading-relaxed ${
          isUser ? 'bg-blue-600 text-white rounded-2xl rounded-tr-md px-4 py-2.5' : 'text-gray-800 py-1'
        }`}>
          {isStreaming && !content ? (
            <div className="flex gap-1.5 py-1.5">
              <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0s' }} />
              <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.15s' }} />
              <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.3s' }} />
            </div>
          ) : (
            <div className="whitespace-pre-wrap">
              {content}
              {isStreaming && <span className="inline-block w-2 h-4 bg-blue-500 ml-0.5 animate-pulse" />}
            </div>
          )}
        </div>

        {/* 中间状态 */}
        {!isUser && intermediateStates && intermediateStates.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {intermediateStates.map((state, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs text-gray-400">
                <span className="w-1 h-1 rounded-full bg-blue-400" />
                {state.message}
              </div>
            ))}
          </div>
        )}

        {!isUser && currentState && !content && (
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-blue-500">
            <Loader2 size={12} className="animate-spin" />
            {currentState}
          </div>
        )}
      </div>
    </div>
  );
}
