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

export default function Tokens() {
  const [tokens, setTokens] = useState<Pat[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchTokens = useCallback(async () => {
    const res = await fetch('/api/account/tokens');
    if (res.ok) {
      const data = await res.json();
      setTokens(data.tokens || []);
    }
  }, []);

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

  const createToken = async () => {
    if (!newLabel.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/account/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setCreatedToken(data.token);
        setNewLabel('');
        fetchTokens();
      }
    } finally {
      setLoading(false);
    }
  };

  const revokeToken = async (id: string) => {
    await fetch(`/api/account/tokens/${id}`, { method: 'DELETE' });
    fetchTokens();
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: 720 }}>
      <h2 style={{ marginBottom: '1rem' }}>API Tokens (PAT)</h2>
      <p style={{ fontSize: '0.875rem', color: '#666', marginBottom: '1rem' }}>
        Personal Access Tokens are used by AI agents and scripts to access the tgcloud REST API.
        Tokens inherit your instance permissions.
      </p>

      {createdToken && (
        <div style={{ background: '#e8f5e9', border: '1px solid #4caf50', borderRadius: 6, padding: '1rem', marginBottom: '1rem' }}>
          <strong>Token created! Copy it now — it won't be shown again:</strong>
          <pre style={{ margin: '0.5rem 0', wordBreak: 'break-all', background: '#fff', padding: '0.5rem', borderRadius: 4 }}>
            {createdToken}
          </pre>
          <button onClick={() => { navigator.clipboard.writeText(createdToken); }}>Copy</button>
          {' '}
          <button onClick={() => setCreatedToken(null)}>Dismiss</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <input
          type="text"
          placeholder="Token label (e.g. my-agent)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createToken()}
          style={{ flex: 1, padding: '0.5rem' }}
        />
        <button onClick={createToken} disabled={loading || !newLabel.trim()}>
          Create Token
        </button>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
            <th style={{ padding: '0.5rem' }}>Label</th>
            <th style={{ padding: '0.5rem' }}>Suffix</th>
            <th style={{ padding: '0.5rem' }}>Created</th>
            <th style={{ padding: '0.5rem' }}>Last Used</th>
            <th style={{ padding: '0.5rem' }}></th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '0.5rem' }}>{t.label}</td>
              <td style={{ padding: '0.5rem', fontFamily: 'monospace' }}>...{t.suffix}</td>
              <td style={{ padding: '0.5rem' }}>{new Date(t.createdAt).toLocaleDateString()}</td>
              <td style={{ padding: '0.5rem' }}>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : '—'}</td>
              <td style={{ padding: '0.5rem' }}>
                <button onClick={() => revokeToken(t.id)} style={{ color: 'red', border: 'none', background: 'none', cursor: 'pointer' }}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
          {tokens.length === 0 && (
            <tr><td colSpan={5} style={{ padding: '1rem', textAlign: 'center', color: '#999' }}>No active tokens</td></tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: '2rem', fontSize: '0.8rem', color: '#888' }}>
        <strong>Agent API Base URL:</strong> <code>{`${window.location.origin}/api/agent`}</code>
        <br />
        <strong>Usage:</strong> <code>{`curl -H "Authorization: Bearer tgcp_..." ${window.location.origin}/api/agent/instances`}</code>
      </div>
    </div>
  );
}
