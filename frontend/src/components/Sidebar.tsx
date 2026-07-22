import React, { useState, useRef, useEffect } from 'react';
import { Plus, MessageSquare, Trash2, Pencil, LogOut, Settings, PanelLeftClose, PanelLeft, Search } from 'lucide-react';
import type { Conversation } from '../hooks/useConversations';

type Props = {
  conversations: Conversation[];
  activeId: string | null;
  loading: boolean;
  userRole?: string;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onLogout: () => void;
  onOpenAdmin: () => void;
  onToggle: () => void;
};

export default function Sidebar({
  conversations, activeId, loading, userRole, onCreate, onSelect, onRename, onDelete, onLogout, onOpenAdmin, onToggle,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editingId]);

  const filtered = searchQuery
    ? conversations.filter((c) => c.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : conversations;

  const handleRename = (id: string) => {
    setEditingId(id);
    setEditTitle(conversations.find((c) => c.id === id)?.title || '');
  };

  const submitRename = (id: string) => {
    if (editTitle.trim()) onRename(id, editTitle.trim());
    setEditingId(null);
  };

  return (
    <div className="h-full flex flex-col bg-gray-950 text-gray-300">
      {/* 顶部 */}
      <div className="flex items-center justify-between px-3 h-12 border-b border-gray-800 flex-shrink-0">
        <span className="text-sm font-medium text-gray-100">AI 智能助手</span>
        <button onClick={onToggle} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors">
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* 新对话按钮 */}
      <div className="p-3">
        <button onClick={onCreate} className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-gray-700/50 text-sm text-gray-300 hover:bg-gray-800 transition-colors">
          <Plus size={16} />
          新对话
        </button>
      </div>

      {/* 搜索 */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索对话..."
            className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-9 pr-3 py-2 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-600 transition-colors"
          />
        </div>
      </div>

      {/* 对话列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-xs text-gray-600">{searchQuery ? '无匹配对话' : '暂无对话'}</div>
        ) : (
          filtered.map((conv) => (
            <div
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={`group flex items-center gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer transition-colors ${
                conv.id === activeId ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-900 hover:text-gray-200'
              }`}
            >
              <MessageSquare size={14} className="flex-shrink-0 opacity-50" />
              {editingId === conv.id ? (
                <input
                  ref={inputRef}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => submitRename(conv.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitRename(conv.id); if (e.key === 'Escape') setEditingId(null); }}
                  className="flex-1 text-xs bg-gray-700 text-white rounded px-1.5 py-0.5 outline-none"
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="flex-1 text-xs truncate">{conv.title}</span>
              )}
              {editingId !== conv.id && (
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={(e) => { e.stopPropagation(); handleRename(conv.id); }}
                    className="p-1 rounded hover:bg-gray-700 text-gray-500 hover:text-gray-300 transition-colors">
                    <Pencil size={12} />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); onDelete(conv.id); }}
                    className="p-1 rounded hover:bg-red-900/50 text-gray-500 hover:text-red-400 transition-colors">
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* 底部 */}
      <div className="p-2 border-t border-gray-800 space-y-0.5">
        {userRole === 'admin' && (
          <button onClick={onOpenAdmin} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs text-gray-400 hover:bg-gray-900 hover:text-gray-200 transition-colors">
            <Settings size={14} />
            后台管理
          </button>
        )}
        <button onClick={onLogout} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs text-gray-400 hover:bg-gray-900 hover:text-gray-200 transition-colors">
          <LogOut size={14} />
          退出登录
        </button>
      </div>
    </div>
  );
}
