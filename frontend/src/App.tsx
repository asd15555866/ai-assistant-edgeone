import React, { useState, useCallback, useEffect } from 'react';
import { useAuth } from './hooks/useAuth';
import { useConversations } from './hooks/useConversations';
import { useChat } from './hooks/useChat';
import Sidebar from './components/Sidebar';
import ChatWindow from './components/ChatWindow';
import AdminPanel from './components/AdminPanel';
import { Loader2, Sparkles } from 'lucide-react';

export default function App() {
  const { user, loading: authLoading, error: authError, login, register, logout } = useAuth();
  const { conversations, loading: convsLoading, createConversation, renameConversation, deleteConversation } = useConversations();
  const { messages, isStreaming, currentStreamContent, currentState, error: chatError, sendMessage, loadMessages, clearMessages, abort } = useChat();

  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [showAdmin, setShowAdmin] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConvId(id);
    loadMessages(id);
  }, [loadMessages]);

  const handleCreateConversation = useCallback(async () => {
    const conv = await createConversation();
    if (conv) {
      setActiveConvId(conv.id);
      clearMessages();
    }
  }, [createConversation, clearMessages]);

  const handleDeleteConversation = useCallback((id: string) => {
    deleteConversation(id);
    if (activeConvId === id) {
      setActiveConvId(null);
      clearMessages();
      const next = conversations.find((c) => c.id !== id);
      if (next) { setActiveConvId(next.id); loadMessages(next.id); }
    }
  }, [activeConvId, deleteConversation, clearMessages, conversations, loadMessages]);

  const handleSend = useCallback(() => {
    if (!input.trim() || isStreaming) return;
    const msg = input.trim();
    setInput('');
    if (!activeConvId) {
      createConversation(msg.slice(0, 20)).then((conv) => {
        if (conv) { setActiveConvId(conv.id); sendMessage(msg, conv.id); }
      });
    } else {
      sendMessage(msg, activeConvId);
    }
  }, [input, isStreaming, activeConvId, createConversation, sendMessage]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-center">
          <Loader2 size={28} className="animate-spin text-blue-500 mx-auto mb-3" />
          <div className="text-sm text-gray-400">加载中...</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthPage onLogin={login} onRegister={register} error={authError} />;
  }

  return (
    <div className="min-h-screen flex bg-white">
      {/* 侧边栏 */}
      <div className={`${sidebarOpen ? 'w-72' : 'w-0'} transition-all duration-300 overflow-hidden flex-shrink-0`}>
        <Sidebar
          conversations={conversations}
          activeId={activeConvId}
          loading={convsLoading}
          userRole={user.role}
          onCreate={handleCreateConversation}
          onSelect={handleSelectConversation}
          onRename={renameConversation}
          onDelete={handleDeleteConversation}
          onLogout={logout}
          onOpenAdmin={() => setShowAdmin(true)}
          onToggle={() => setSidebarOpen(!sidebarOpen)}
        />
      </div>

      {/* 主区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 顶栏 */}
        <div className="h-12 flex items-center px-4 border-b border-gray-100 bg-white flex-shrink-0">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="btn-ghost !p-1.5 mr-2" title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {sidebarOpen ? <><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></> : <><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/></>}
            </svg>
          </button>
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <Sparkles size={15} className="text-blue-500" />
            AI 智能助手
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-gray-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            {user.username}
          </div>
        </div>

        <ChatWindow
          messages={messages}
          isStreaming={isStreaming}
          currentStreamContent={currentStreamContent}
          currentState={currentState}
          error={chatError}
          input={input}
          onInputChange={setInput}
          onSend={handleSend}
          onStop={abort}
          onNewChat={handleCreateConversation}
        />
      </div>

      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
    </div>
  );
}

// ==================== 登录/注册页面（DeepSeek 风格） ====================

function AuthPage({ onLogin, onRegister, error }: {
  onLogin: (u: string, p: string) => Promise<boolean>;
  onRegister: (u: string, p: string) => Promise<boolean>;
  error: string | null;
}) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!username.trim() || !password.trim()) { setLocalError('请填写用户名和密码'); return; }
    if (!isLogin && password !== confirmPassword) { setLocalError('两次密码不一致'); return; }
    setSubmitting(true);
    const success = isLogin ? await onLogin(username, password) : await onRegister(username, password);
    setSubmitting(false);
    if (!success && !error) setLocalError(isLogin ? '登录失败' : '注册失败');
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-blue-200">
            <Sparkles size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">AI 智能助手</h1>
          <p className="text-sm text-gray-500 mt-1.5">
            {isLogin ? '登录你的账号' : '创建新账号'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
              className="input-field" placeholder="用户名" autoComplete="username" />
          </div>
          <div>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="input-field" placeholder="密码" autoComplete={isLogin ? 'current-password' : 'new-password'} />
          </div>
          {!isLogin && (
            <div>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                className="input-field" placeholder="确认密码" autoComplete="new-password" />
            </div>
          )}
          {(localError || error) && (
            <div className="text-sm text-red-600 bg-red-50 rounded-xl px-4 py-2.5">{localError || error}</div>
          )}
          <button type="submit" disabled={submitting} className="btn-primary w-full text-base py-3">
            {submitting ? <Loader2 size={18} className="animate-spin mx-auto" /> : isLogin ? '登录' : '注册'}
          </button>
          <div className="text-center pt-2">
            <button type="button" onClick={() => { setIsLogin(!isLogin); setLocalError(null); }}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors">
              {isLogin ? '还没有账号？去注册' : '已有账号？去登录'}
            </button>
          </div>
        </form>
      </div>
      <div className="mt-auto pt-16 pb-6 text-xs text-gray-300">AI 智能助手 v1.0</div>
    </div>
  );
}
