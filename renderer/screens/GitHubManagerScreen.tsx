import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface RepoProfile {
    path: string;
    isPrivate: boolean;
    hasChanges?: boolean;
}

const GitHubManagerScreen: React.FC = () => {
    const navigate = useNavigate();
    const [token, setToken] = useState('');
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [repos, setRepos] = useState<RepoProfile[]>([]);
    const [message, setMessage] = useState<string | null>(null);

    // New Repo State
    const [newRepoPath, setNewRepoPath] = useState('');
    const [newRepoName, setNewRepoName] = useState('');

    const handleAuth = async () => {
        try {
            await window.electronAPI.githubInitialize(token);
            setIsAuthenticated(true);
            setMessage('認証成功！');
        } catch (err) {
            setMessage('認証失敗: ' + String(err));
        }
    };

    const handleInitRepo = async () => {
        if (!newRepoPath || !newRepoName) return;
        try {
            setMessage('非公開リポジトリを作成中... (Private)');
            const result = await window.electronAPI.githubInitRepo(newRepoPath, newRepoName);
            if (result.success) {
                setMessage(`成功！ Privateリポジトを作成しました: ${result.url}`);
                setRepos([...repos, { path: newRepoPath, isPrivate: true }]);
            } else {
                setMessage('エラー: ' + result.error);
            }
        } catch (err) {
            setMessage('エラー: ' + String(err));
        }
    };

    const handleSelectFolder = async () => {
        const result = await window.electronAPI.selectSaveFolder(); // Reuse folder selector
        if (result.success && result.path) {
            setNewRepoPath(result.path);
        }
    };

    return (
        <div style={{ padding: '24px', height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-primary)', color: 'var(--color-text)' }}>
            <div style={{ marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '16px' }}>
                <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}>🏠</button>
                <h1 style={{ margin: 0 }}>🐙 GitHub Manager</h1>
            </div>

            {message && <div style={{ background: '#3b82f6', color: 'white', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>{message}</div>}

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>

                {/* Authentication */}
                {!isAuthenticated && (
                    <div style={{ background: 'var(--color-surface)', padding: '24px', borderRadius: '12px' }}>
                        <h3>GitHub 認証</h3>
                        <p style={{ color: 'var(--color-text-secondary)' }}>GitHubで発行した `repo` スコープ付きの Personal Access Token (PAT) を入力してください。</p>
                        <div style={{ display: 'flex', gap: '12px' }}>
                            <input
                                type="password"
                                value={token}
                                onChange={(e) => setToken(e.target.value)}
                                placeholder="ghp_..."
                                style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid var(--color-border)', color: 'black' }}
                            />
                            <button
                                onClick={handleAuth}
                                style={{ padding: '12px 24px', background: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
                            >
                                接続
                            </button>
                        </div>
                    </div>
                )}

                {/* Main Interface */}
                {isAuthenticated && (
                    <div style={{ display: 'flex', gap: '24px', flex: 1 }}>
                        {/* New Repo Form */}
                        <div style={{ flex: 1, background: 'var(--color-surface)', padding: '24px', borderRadius: '12px' }}>
                            <h3>プロジェクト追加 / リポジトリ作成</h3>
                            <div style={{ marginBottom: '16px' }}>
                                <label style={{ display: 'block', marginBottom: '8px' }}>ローカルフォルダ</label>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <input
                                        type="text"
                                        value={newRepoPath}
                                        readOnly
                                        style={{ flex: 1, padding: '8px', color: 'black' }}
                                    />
                                    <button onClick={handleSelectFolder} style={{ padding: '8px' }}>参照</button>
                                </div>
                            </div>
                            <div style={{ marginBottom: '16px' }}>
                                <label style={{ display: 'block', marginBottom: '8px' }}>リポジトリ名 (GitHub)</label>
                                <input
                                    type="text"
                                    value={newRepoName}
                                    onChange={(e) => setNewRepoName(e.target.value)}
                                    placeholder="my-private-project"
                                    style={{ width: '100%', padding: '8px', color: 'black' }}
                                />
                            </div>

                            <div style={{ background: '#fef3c7', color: '#92400e', padding: '12px', borderRadius: '8px', marginBottom: '16px', fontSize: '0.9rem' }}>
                                🔒 セキュリティポリシー: 新規リポジトリは強制的に <strong>Private (非公開)</strong> として作成されます。
                            </div>

                            <button
                                onClick={handleInitRepo}
                                disabled={!newRepoPath || !newRepoName}
                                style={{ width: '100%', padding: '12px', background: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', opacity: (!newRepoPath || !newRepoName) ? 0.5 : 1 }}
                            >
                                初期化 & GitHubへPush
                            </button>
                        </div>

                        {/* Managed Repos List */}
                        <div style={{ flex: 1, background: 'var(--color-surface)', padding: '24px', borderRadius: '12px' }}>
                            <h3>管理中のリポジトリ</h3>
                            {repos.length === 0 ? (
                                <div style={{ color: 'var(--color-text-secondary)', textAlign: 'center', marginTop: '24px' }}>
                                    管理中のリポジトリはありません。
                                </div>
                            ) : (
                                <ul>
                                    {repos.map((repo, i) => (
                                        <li key={i} style={{ marginBottom: '8px', padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
                                            <div style={{ fontWeight: 'bold' }}>{repo.path.split(/[/\\]/).pop()}</div>
                                            <div style={{ fontSize: '0.8rem', color: '#4ade80' }}>{repo.isPrivate ? '🔒 Private' : '⚠️ Public'}</div>
                                            <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>{repo.path}</div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default GitHubManagerScreen;
