/**
 * 后台管理面板
 *
 * 只有 3 个 Tab：
 * Tab 1: 📊 概览 - 统计数据和趋势图
 * Tab 2: 📋 执行日志 - 表格展示 + 筛选
 * Tab 3: ⚙️ 系统设置 - 配置项
 */
import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from 'recharts';
import { BarChart3, ClipboardList, Settings, X, RefreshCw, Search, Filter } from 'lucide-react';

const API_BASE = '/api';

// EdgeOne Makers 内置免费模型列表（@makers/ 前缀）
// https://pages.edgeone.ai/zh/document/models-vendors-overview
const BUILTIN_MODELS = [
  '@makers/hy3',
  '@makers/hy3-preview',
  '@makers/deepseek-v4-pro',
  '@makers/deepseek-v4-flash',
  '@makers/minimax-m3',
  '@makers/minimax-m2.7',
  '@makers/kimi-k2.6',
];

type StatsData = {
  totalExecutions: number;
  successCount: number;
  successRate: number;
  activeTasks: number;
  trend: Array<{ date: string; total: number; success: number; failed: number }>;
};

type ExecutionLog = {
  id: string;
  task_id: string;
  status: 'success' | 'failed' | 'running';
  result_summary: string;
  error_message: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  trace_log: string[];
};

type SettingsData = Record<string, string>;

type ScheduledTask = {
  id: string;
  user_id: string;
  name: string;
  cron: string;
  action: string;
  status: 'active' | 'paused' | 'deleted';
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
};

type Props = {
  onClose: () => void;
};

export default function AdminPanel({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'stats' | 'tasks' | 'logs' | 'settings'>('stats');

  return (
    <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center">
      <div className="w-[900px] h-[600px] bg-white rounded-2xl shadow-2xl border border-surface-200 flex flex-col overflow-hidden animate-fade-in">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200">
          <h2 className="text-lg font-semibold text-surface-800">后台管理</h2>
          <button onClick={onClose} className="btn-ghost !p-1.5 rounded-full">
            <X size={20} />
          </button>
        </div>

        {/* Tab 导航 */}
        <div className="flex border-b border-surface-200 px-6">
          {[
            { key: 'stats', label: '📊 概览' },
            { key: 'tasks', label: '📋 定时任务' },
            { key: 'logs', label: '📋 执行日志' },
            { key: 'settings', label: '⚙️ 系统设置' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as any)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-primary-600 text-primary-700'
                  : 'border-transparent text-surface-500 hover:text-surface-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'stats' && <StatsTab />}
          {activeTab === 'tasks' && <TasksTab />}
          {activeTab === 'logs' && <LogsTab />}
          {activeTab === 'settings' && <SettingsTab />}
        </div>
      </div>
    </div>
  );
}

function StatsTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/stats`, { credentials: 'include' })
      .then((r) => r.json())
      .then(setStats)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!stats) {
    return <div className="text-center text-surface-500 py-12">暂无数据</div>;
  }

  return (
    <div className="space-y-6">
      {/* 统计卡片 */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: '本月执行次数', value: stats.totalExecutions, color: 'text-blue-600', bg: 'bg-blue-50' },
          { label: '成功次数', value: stats.successCount, color: 'text-green-600', bg: 'bg-green-50' },
          { label: '成功率', value: `${stats.successRate}%`, color: 'text-emerald-600', bg: 'bg-emerald-50' },
          { label: '活跃任务', value: stats.activeTasks, color: 'text-purple-600', bg: 'bg-purple-50' },
        ].map((card) => (
          <div key={card.label} className={`${card.bg} rounded-xl p-4`}>
            <div className="text-xs text-surface-500 mb-1">{card.label}</div>
            <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
          </div>
        ))}
      </div>

      {/* 趋势图 */}
      <div className="card p-4">
        <h3 className="text-sm font-medium text-surface-700 mb-4">最近 7 天执行趋势</h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={stats.trend}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Line type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2} name="总次数" />
            <Line type="monotone" dataKey="success" stroke="#22c55e" strokeWidth={2} name="成功" />
            <Line type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} name="失败" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TasksTab() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', cron: '', action: '', status: '' });

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/tasks`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchTasks(); }, []);

  const updateStatus = async (id: string, status: string) => {
    await fetch(`${API_BASE}/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
      credentials: 'include',
    });
    fetchTasks();
  };

  const deleteTask = async (id: string) => {
    await fetch(`${API_BASE}/tasks/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    fetchTasks();
  };

  const startEdit = (task: ScheduledTask) => {
    setEditingId(task.id);
    setEditForm({ name: task.name, cron: task.cron, action: task.action, status: task.status });
  };

  const saveEdit = async (id: string) => {
    await fetch(`${API_BASE}/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editForm),
      credentials: 'include',
    });
    setEditingId(null);
    fetchTasks();
  };

  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (tasks.length === 0) {
    return <div className="text-center py-12 text-surface-400 text-sm">暂无定时任务</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-surface-500">共 {tasks.length} 个任务</span>
        <button onClick={fetchTasks} className="btn-ghost !p-1.5"><RefreshCw size={16} /></button>
      </div>
      {tasks.map((task) => (
        <div key={task.id} className="card p-4 space-y-2">
          {editingId === task.id ? (
            /* ===== 编辑模式 ===== */
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-surface-500 mb-1">任务名称</label>
                  <input className="input-field text-sm" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs text-surface-500 mb-1">Cron 表达式</label>
                  <input className="input-field text-sm" value={editForm.cron} onChange={(e) => setEditForm({ ...editForm, cron: e.target.value })} placeholder="0 9 * * *" />
                </div>
                <div>
                  <label className="block text-xs text-surface-500 mb-1">动作类型</label>
                  <select className="input-field text-sm" value={editForm.action} onChange={(e) => setEditForm({ ...editForm, action: e.target.value })}>
                    <option value="web_search">web_search</option>
                    <option value="browser_automation">browser_automation</option>
                    <option value="execute_code">execute_code</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-surface-500 mb-1">状态</label>
                  <select className="input-field text-sm" value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
                    <option value="active">运行中</option>
                    <option value="paused">已暂停</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditingId(null)} className="btn-secondary !text-xs">取消</button>
                <button onClick={() => saveEdit(task.id)} className="btn-primary !text-xs">保存</button>
              </div>
            </div>
          ) : (
            /* ===== 查看模式 ===== */
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${task.status === 'active' ? 'bg-green-400' : task.status === 'paused' ? 'bg-yellow-400' : 'bg-red-400'}`} />
                  <span className="font-medium text-sm">{task.name}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-surface-100 text-surface-500">{task.action}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => startEdit(task)} className="btn-ghost !text-xs !py-1 text-primary-600 hover:bg-primary-50" title="编辑">
                    编辑
                  </button>
                  {task.status === 'active' ? (
                    <button onClick={() => updateStatus(task.id, 'paused')} className="btn-ghost !text-xs !py-1 text-yellow-600 hover:bg-yellow-50" title="暂停">
                      暂停
                    </button>
                  ) : task.status === 'paused' ? (
                    <button onClick={() => updateStatus(task.id, 'active')} className="btn-ghost !text-xs !py-1 text-green-600 hover:bg-green-50" title="恢复">
                      恢复
                    </button>
                  ) : null}
                  <button onClick={() => deleteTask(task.id)} className="btn-ghost !text-xs !py-1 text-red-500 hover:bg-red-50" title="删除">
                    删除
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs text-surface-400">
                <span>Cron: {task.cron}</span>
                <span>创建: {new Date(task.created_at).toLocaleDateString('zh-CN')}</span>
                <span>上次执行: {task.last_run_at ? new Date(task.last_run_at).toLocaleString('zh-CN') : '从未'}</span>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function LogsTab() {
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchLogs = async (status?: string) => {
    setLoading(true);
    const params = status ? `?status=${status}` : '';
    try {
      const res = await fetch(`${API_BASE}/executions${params}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.executions || []);
      }
    } catch {
      // 静默失败
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  return (
    <div className="space-y-4">
      {/* 筛选 */}
      <div className="flex items-center gap-2">
        <Filter size={16} className="text-surface-400" />
        {['', 'success', 'failed'].map((status) => (
          <button
            key={status}
            onClick={() => {
              setStatusFilter(status);
              fetchLogs(status || undefined);
            }}
            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
              statusFilter === status
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'border-surface-200 text-surface-500 hover:bg-surface-50'
            }`}
          >
            {status === '' ? '全部' : status === 'success' ? '✅ 成功' : '❌ 失败'}
          </button>
        ))}
        <button
          onClick={() => fetchLogs(statusFilter)}
          className="ml-auto btn-ghost !p-1.5"
          title="刷新"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 表格 */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-12 text-surface-400 text-sm">
          暂无执行记录
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => (
            <div key={log.id} className="card overflow-hidden">
              <div
                className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-surface-50 transition-colors"
                onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
              >
                <span>{log.status === 'success' ? '✅' : log.status === 'failed' ? '❌' : '🔄'}</span>
                <span className="flex-1 text-sm truncate">{log.result_summary || log.error_message || '-'}</span>
                <span className="text-xs text-surface-400">
                  {log.duration_ms ? `${(log.duration_ms / 1000).toFixed(1)}s` : '-'}
                </span>
                <span className="text-xs text-surface-400">
                  {new Date(log.started_at).toLocaleString('zh-CN')}
                </span>
              </div>
              {expandedId === log.id && (
                <div className="px-4 py-3 bg-surface-50 border-t border-surface-200 text-xs space-y-1">
                  <div className="text-surface-500">
                    任务 ID: {log.task_id}
                  </div>
                  {log.error_message && (
                    <div className="text-red-500">错误: {log.error_message}</div>
                  )}
                  {log.trace_log && log.trace_log.length > 0 && (
                    <div className="mt-2">
                      <div className="text-surface-500 mb-1">执行追踪:</div>
                      {log.trace_log.map((trace, i) => (
                        <div key={i} className="text-surface-600 font-mono pl-2 border-l-2 border-primary-200 mb-0.5">
                          {trace}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState<SettingsData>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsInfo, setModelsInfo] = useState<{ source?: string; message?: string; count?: number }>({});
  const [selectedProvider, setSelectedProvider] = useState<string>('');

  useEffect(() => {
    fetch(`${API_BASE}/settings`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (data.settings) setSettings(data.settings);
      })
      .finally(() => setLoading(false));

    // 动态获取网关中已配置 API Key 的模型列表
    // 失败时静默回退到内置 @makers/ 模型（用户可手动填入）
    fetch(`${API_BASE}/models`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (data.models) {
          setAvailableModels(data.models);
          setModelsInfo({ source: data.source, message: data.message, count: data.count });
        } else {
          setAvailableModels(BUILTIN_MODELS);
        }
      })
      .catch(() => {
        // 网关未配置或不可用，回退到 EdgeOne Makers 内置免费模型
        setAvailableModels(BUILTIN_MODELS);
        setModelsInfo({ source: 'builtin', message: '使用 EdgeOne Makers 内置模型（@makers/ 前缀，免费）' });
      });
  }, []);

  // 按厂商分组模型（基于模型名前缀模式匹配）
  const providerGroups: Record<string, string[]> = {};
  for (const m of availableModels) {
    const provider = detectProvider(m);
    if (!providerGroups[provider]) providerGroups[provider] = [];
    providerGroups[provider].push(m);
  }
  const providers = Object.keys(providerGroups).sort();

  // 厂商变化时自动重置模型选择
  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
        credentials: 'include',
      });
      if (res.ok) {
        setMessage('设置已保存');
        setTimeout(() => setMessage(''), 3000);
      }
    } catch {
      setMessage('保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-lg space-y-6">
      <div className="space-y-4">
        {/* 模型选择 - 两级：厂商 → 模型 */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700">
              AI 模型
            </label>
            <button
              type="button"
              onClick={() => {
                setModelsInfo({ source: undefined });
                fetch(`${API_BASE}/models`, { credentials: 'include' })
                  .then((r) => r.json())
                  .then((data) => {
                    if (data.models) {
                      setAvailableModels(data.models);
                      setModelsInfo({ source: data.source, message: data.message, count: data.count });
                    }
                  })
                  .catch(() => {
                    setAvailableModels(BUILTIN_MODELS);
                    setModelsInfo({ source: 'builtin', message: '使用 EdgeOne Makers 内置模型（@makers/ 前缀，免费）' });
                  });
              }}
              className="text-xs text-primary-600 hover:text-primary-700"
            >
              🔄 刷新列表
            </button>
          </div>
          {(modelsInfo.source === 'gateway' || modelsInfo.source === 'probed') && providers.length > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <select
                  className="input-field"
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                >
                  <option value="">— 选择厂商 —</option>
                  {providers.map((p) => (
                    <option key={p} value={p}>{p} ({providerGroups[p].length})</option>
                  ))}
                </select>
                <select
                  className="input-field"
                  value={settings.ai_model || ''}
                  onChange={(e) => setSettings({ ...settings, ai_model: e.target.value })}
                  disabled={!selectedProvider}
                >
                  <option value="">— 选择模型 —</option>
                  {selectedProvider && providerGroups[selectedProvider]?.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-gray-400">
                ✅ 已识别 <b>{modelsInfo.count}</b> 个可用模型（厂商 API Key 已绑定的才会显示）
              </p>
            </>
          ) : (
            <>
              <input
                className="input-field"
                value={settings.ai_model || '@makers/deepseek-v4-flash'}
                onChange={(e) => setSettings({ ...settings, ai_model: e.target.value })}
                placeholder="@makers/deepseek-v4-flash"
              />
              <p className="text-xs text-gray-400 mt-1">
                {modelsInfo.source === 'none' && '⚠️ 未配置网关 API Key，请到 EdgeOne 控制台 → Models 添加'}
                {modelsInfo.source === 'error' && '❌ 网关调用失败：' + modelsInfo.message}
                {modelsInfo.source === 'unsupported' && 'ℹ️ ' + modelsInfo.message}
                {modelsInfo.source === 'fallback' && 'ℹ️ ' + modelsInfo.message}
                {!modelsInfo.source && '⏳ 正在获取可用模型...'}
                {(modelsInfo.source === 'gateway' || modelsInfo.source === 'probed') && providers.length === 0 && '网关已配置但暂无可用模型，请检查 API Key'}
              </p>
            </>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            定时任务扫描间隔（秒）
          </label>
          <input
            type="number"
            value={settings.cron_scan_interval || '60'}
            onChange={(e) => setSettings({ ...settings, cron_scan_interval: e.target.value })}
            className="input-field"
            min={10}
          />
          <p className="text-xs text-gray-400 mt-1">建议 30-300 秒之间</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">通知邮箱</label>
          <input
            type="email"
            value={settings.notification_email || ''}
            onChange={(e) => setSettings({ ...settings, notification_email: e.target.value })}
            className="input-field"
            placeholder="admin@example.com"
          />
          <p className="text-xs text-gray-400 mt-1">定时任务执行结果将通过此邮箱发送通知</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">全局默认超时时间（毫秒）</label>
          <input
            type="number"
            value={settings.default_timeout_ms || '30000'}
            onChange={(e) => setSettings({ ...settings, default_timeout_ms: e.target.value })}
            className="input-field"
            min={5000}
            max={120000}
          />
          <p className="text-xs text-gray-400 mt-1">浏览器操作、代码执行等任务的超时限制</p>
        </div>
      </div>

      <button onClick={handleSave} disabled={saving} className="btn-primary">
        {saving ? '保存中...' : '保存设置'}
      </button>

      {message && (
        <div className={`text-sm px-3 py-2 rounded-lg ${message === '设置已保存' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
          {message}
        </div>
      )}
    </div>
  );
}

/**
 * 根据模型名识别厂商（基于 EdgeOne 网关的命名约定）
 */
function detectProvider(modelName: string): string {
  const m = modelName.toLowerCase();
  if (m.startsWith('@makers/')) return 'EdgeOne 内置';
  if (m.startsWith('gpt-') || m.includes('openai') || m.startsWith('o1-') || m.startsWith('o3-')) return 'OpenAI';
  if (m.startsWith('claude-')) return 'Anthropic';
  if (m.startsWith('gemini-') || m.startsWith('gemma-')) return 'Google';
  if (m.startsWith('deepseek-')) return 'DeepSeek';
  if (m.includes('glm') || m.startsWith('zaigl') || m.startsWith('chatglm')) return '智谱';
  if (m.startsWith('moonshot-') || m.startsWith('kimi-')) return '月之暗面';
  if (m.startsWith('hunyuan-')) return '腾讯混元';
  if (m.startsWith('abab') || m.startsWith('minimax-') || m.startsWith('speech-')) return 'MiniMax';
  if (m.startsWith('doubao-') || m.startsWith('ep-')) return '字节豆包';
  if (m.startsWith('qwen-') || m.startsWith('qwq-')) return '通义千问';
  return '其他';
}
