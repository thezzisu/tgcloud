import { useState, useEffect, useCallback } from 'react';

interface Pat {
  id: string;
  label: string;
  suffix: string;
  instanceIds?: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export function TokensModal({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<Pat[]>([]);
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const fetchTokens = useCallback(async () => {
    const res = await fetch('/api/account/tokens');
    if (res.ok) {
      const data = await res.json();
      setTokens(data.tokens || []);
    }
  }, []);

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

  const createToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/account/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel.trim() }),
      });
      if (!res.ok) { setErr('创建失败'); return; }
      const data = await res.json();
      setCreatedToken(data.token);
      setNewLabel('');
      setCreating(false);
      fetchTokens();
    } catch { setErr('网络错误'); } finally { setBusy(false); }
  };

  const revokeToken = async (id: string) => {
    await fetch(`/api/account/tokens/${id}`, { method: 'DELETE' });
    fetchTokens();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h2>API 令牌</h2>
        <div className="muted small" style={{ marginBottom: 12 }}>
          Personal Access Token 用于 AI Agent 和脚本通过 REST API 访问微信数据，继承你的实例权限。
        </div>

        {createdToken && (
          <div className="token-created" style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, padding: '10px 12px', marginBottom: 12 }}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>令牌已创建，请立即复制（不会再次显示）：</div>
            <code className="token-value" style={{ display: 'block', wordBreak: 'break-all', fontSize: 12, background: '#fff', padding: '6px 8px', borderRadius: 4, marginBottom: 6 }}>
              {createdToken}
            </code>
            <button className="btn" onClick={() => { navigator.clipboard.writeText(createdToken); setCreatedToken(null); }}>
              复制并关闭
            </button>
          </div>
        )}

        {tokens.length > 0 && (
          <div className="list" style={{ marginBottom: 12 }}>
            {tokens.map((t) => (
              <div key={t.id} className="list-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border, #eee)' }}>
                <div>
                  <span style={{ fontWeight: 500 }}>{t.label}</span>
                  <span className="muted small" style={{ marginLeft: 8 }}>...{t.suffix}</span>
                  {t.lastUsedAt && <span className="muted small" style={{ marginLeft: 8 }}>最近使用 {new Date(t.lastUsedAt).toLocaleDateString()}</span>}
                </div>
                <button className="btn-text danger" onClick={() => revokeToken(t.id)}>吊销</button>
              </div>
            ))}
          </div>
        )}
        {tokens.length === 0 && !creating && (
          <div className="muted small" style={{ padding: '12px 0' }}>暂无有效令牌</div>
        )}

        {creating ? (
          <form onSubmit={createToken} style={{ marginTop: 8 }}>
            <input className="input" placeholder="令牌标签（如 my-agent）" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} autoFocus />
            {err && <div className="error">{err}</div>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setCreating(false)}>取消</button>
              <button className="btn btn-primary" disabled={busy || !newLabel.trim()}>创建</button>
            </div>
          </form>
        ) : (
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>关闭</button>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>+ 新建令牌</button>
          </div>
        )}

        <div className="muted small" style={{ marginTop: 12, borderTop: '1px solid var(--border, #eee)', paddingTop: 8 }}>
          Base URL: <code>{window.location.origin}/api/agent</code>
        </div>
      </div>
    </div>
  );
}
