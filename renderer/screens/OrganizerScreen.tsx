import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { folderOrganizerService } from '../../services/folderOrganizer';
import type { OrganizerFile, OrganizerStats, SuggestedStructure } from '../../types';

const OrganizerScreen: React.FC = () => {
    const navigate = useNavigate();
    const [apiKey, setApiKey] = useState<string>('');

    // Status
    const [step, setStep] = useState<1 | 2 | 3 | 4>(1); // 1:Select, 2:Analyze/Plan, 3:Review, 4:Execute
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Data
    const [sourcePath, setSourcePath] = useState<string | null>(null);
    const [files, setFiles] = useState<OrganizerFile[]>([]);
    const [stats, setStats] = useState<OrganizerStats | null>(null);
    const [plan, setPlan] = useState<SuggestedStructure | null>(null);
    const [destinationPath, setDestinationPath] = useState<string | null>(null);

    // Execution Results
    const [executionResult, setExecutionResult] = useState<any>(null);

    // Settings
    const [useDeepAnalysis, setUseDeepAnalysis] = useState(false);

    useEffect(() => {
        // Init service
        window.electronAPI.getApiKey().then(key => {
            if (key) {
                setApiKey(key);
                folderOrganizerService.initialize(key);
            }
        });
    }, []);

    const handleSetApiKey = (key: string) => {
        setApiKey(key);
        folderOrganizerService.initialize(key);
    };

    // Step 1: Select Folder
    const handleSelectSource = async () => {
        try {
            const result = await window.electronAPI.selectSaveFolder(); // Reusing folder selector
            if (result.success && result.path) {
                setSourcePath(result.path);
                setIsLoading(true);
                setError(null);

                // Analyze immediately
                const analysis = await folderOrganizerService.analyzeFolder(result.path);
                setFiles(analysis.files);
                setStats(analysis.stats);
                setStep(2);
            }
        } catch (err) {
            setError(String(err));
        } finally {
            setIsLoading(false);
        }
    };

    // Step 2: Generate Plan
    const handleGeneratePlan = async (mode: 'conservative' | 'standard' | 'aggressive') => {
        if (!sourcePath || files.length === 0) return;

        try {
            setIsLoading(true);
            // AI Suggestion
            const suggestion = await folderOrganizerService.suggestStructure(files, mode, mode === 'aggressive' ? useDeepAnalysis : false);
            setPlan(suggestion);
            setStep(3);
        } catch (err) {
            setError('Plan generation failed: ' + String(err));
        } finally {
            setIsLoading(false);
        }
    };

    // Step 3: Select Destination & Execute
    const handleSelectDestination = async () => {
        const result = await window.electronAPI.selectSaveFolder();
        if (result.success && result.path) {
            // Prevent same dir
            if (result.path === sourcePath) {
                setError('出力先は元のフォルダと別の場所を指定してください（安全のため）');
                return;
            }
            setDestinationPath(result.path);
        }
    };

    const handleExecute = async () => {
        if (!plan || !destinationPath) return;

        try {
            setIsLoading(true);
            const result = await folderOrganizerService.executeCopy(plan.items, destinationPath);
            setExecutionResult(result);
            setStep(4);
        } catch (err) {
            setError('Execution failed: ' + String(err));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div style={{ padding: '24px', height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-primary)', color: 'var(--color-text)' }}>
            {/* Header */}
            <div style={{ marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '16px' }}>
                <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}>🏠</button>
                <h1 style={{ margin: 0 }}>📂 フォルダ整理エージェント</h1>
            </div>

            {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>⚠️ {error}</div>}

            {/* Main Content */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

                {/* Step 0: API Key Input (if missing) */}
                {!apiKey && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
                        <div style={{ fontSize: '4rem', marginBottom: '16px' }}>🔑</div>
                        <h2>Gemini API キーが必要です</h2>
                        <p style={{ color: 'var(--color-text-secondary)', marginBottom: '32px' }}>
                            フォルダ整理の提案機能を使用するには、Google Gemini API キーが必要です。
                        </p>
                        <input
                            type="password"
                            placeholder="API Key (AIza...)"
                            style={{ padding: '12px', width: '300px', borderRadius: '8px', border: '1px solid var(--color-border)', color: 'black', marginBottom: '16px' }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSetApiKey(e.currentTarget.value);
                            }}
                        />
                        <button
                            onClick={(e) => {
                                const input = e.currentTarget.previousSibling as HTMLInputElement;
                                handleSetApiKey(input.value);
                            }}
                            style={{ padding: '12px 24px', fontSize: '1.1rem', borderRadius: '8px', background: 'var(--color-primary)', color: 'white', border: 'none', cursor: 'pointer' }}
                        >
                            設定して開始
                        </button>
                    </div>
                )}

                {/* Step 1: Select Source */}
                {step === 1 && apiKey && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
                        <div style={{ fontSize: '4rem', marginBottom: '16px' }}>🧹</div>
                        <h2>整理したいフォルダを選択してください</h2>
                        <p style={{ color: 'var(--color-text-secondary)', marginBottom: '32px' }}>
                            デスクトップやダウンロードフォルダなど、散らかったフォルダをAIが整理します。
                        </p>
                        <button
                            onClick={handleSelectSource}
                            disabled={isLoading}
                            style={{ padding: '12px 24px', fontSize: '1.1rem', borderRadius: '8px', background: 'var(--color-primary)', color: 'white', border: 'none', cursor: 'pointer' }}
                        >
                            {isLoading ? '解析中...' : 'フォルダを選択'}
                        </button>
                    </div>
                )}

                {/* Step 2: Analysis Result & Plan Mode */}
                {step === 2 && stats && (
                    <div style={{ maxWidth: '800px', margin: '0 auto', width: '100%' }}>
                        <div style={{ background: 'var(--color-surface)', padding: '24px', borderRadius: '12px', marginBottom: '24px' }}>
                            <h3>📊 解析結果</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginTop: '16px' }}>
                                <div>
                                    <div style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>ファイル数</div>
                                    <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{stats.fileCount}</div>
                                </div>
                                <div>
                                    <div style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>合計サイズ</div>
                                    <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{(stats.totalSize / 1024 / 1024).toFixed(1)} MB</div>
                                </div>
                                <div>
                                    <div style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>パス</div>
                                    <div style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{sourcePath}</div>
                                </div>
                            </div>
                        </div>

                        <h3>🛠️ 整理モードを選択</h3>

                        <div style={{ marginBottom: '16px', marginTop: '16px' }}>
                            <label
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '12px',
                                    padding: '16px',
                                    background: 'var(--color-surface-hover)',
                                    borderRadius: '8px',
                                    border: '1px solid var(--color-border)',
                                    cursor: 'pointer'
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={useDeepAnalysis}
                                    onChange={(e) => setUseDeepAnalysis(e.target.checked)}
                                    style={{ width: '20px', height: '20px', accentColor: 'var(--color-primary)' }}
                                />
                                <div>
                                    <div style={{ fontWeight: 'bold' }}>詳細解析モード (Deep Analysis)</div>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                                        PDF, Word, Excel, PPTの中身も読み取って分類します（「AI積極活用」時のみ有効・処理時間が長くなります）
                                    </div>
                                </div>
                            </label>
                        </div>
                        <div style={{ display: 'grid', gap: '16px', marginTop: '16px' }}>
                            {[
                                { id: 'conservative', icon: '🛡️', label: '保守的', desc: '種類別（拡張子）に分けるだけの最小限の変更です。' },
                                { id: 'standard', icon: '✨', label: '標準 (推奨)', desc: '日付や一般的なカテゴリ（Documents, Images等）で整理します。' },
                                { id: 'aggressive', icon: '🧠', label: 'AI積極活用', desc: 'ファイル名から内容を推測し、細かくフォルダ分けします。' },
                            ].map((m) => (
                                <button
                                    key={m.id}
                                    onClick={() => handleGeneratePlan(m.id as any)}
                                    disabled={isLoading}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '16px', padding: '20px',
                                        background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '12px',
                                        cursor: 'pointer', textAlign: 'left',
                                        color: 'white' // Explicitly set to white as requested
                                    }}
                                >
                                    <span style={{ fontSize: '2rem' }}>{m.icon}</span>
                                    <div>
                                        <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{m.label}</div>
                                        <div style={{ color: '#d1d5db' }}>{m.desc}</div> {/* Light gray for description */}
                                    </div>
                                    <div style={{ marginLeft: 'auto', fontSize: '1.5rem', opacity: 0.5 }}>→</div>
                                </button>
                            ))}
                        </div>
                        {isLoading && <p style={{ textAlign: 'center', marginTop: '20px', color: 'var(--color-primary)' }}>AIが整理案を考えています...</p>}
                    </div>
                )}

                {/* Step 3: Review & Execute */}
                {step === 3 && plan && (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        <div style={{ display: 'flex', gap: '24px', flex: 1, minHeight: 0 }}>
                            {/* Left: Summary */}
                            <div style={{ flex: 1, overflowY: 'auto' }}>
                                <div style={{ background: 'var(--color-surface)', padding: '20px', borderRadius: '12px', marginBottom: '20px' }}>
                                    <h3>💡 提案の概要</h3>
                                    <p>{plan.summary}</p>
                                </div>

                                <h4>移動プレビュー ({plan.items.length} ファイル)</h4>
                                <div style={{ background: '#1e1e2e', borderRadius: '8px', padding: '12px', fontSize: '0.9rem', height: '400px', overflowY: 'auto' }}>
                                    {plan.items.map((item, idx) => (
                                        <div key={idx} style={{ display: 'flex', marginBottom: '8px', borderBottom: '1px solid #333', paddingBottom: '4px' }}>
                                            <div style={{ flex: 1, color: '#9ca3af', wordBreak: 'break-all' }}>{item.sourcePath.split(/[/\\]/).pop()}</div>
                                            <div style={{ margin: '0 8px' }}>→</div>
                                            <div style={{ flex: 1, color: '#4ade80', fontWeight: 'bold', wordBreak: 'break-all' }}>{item.destinationPath}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Right: Actions */}
                            <div style={{ width: '300px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                <div style={{ background: 'var(--color-surface)', padding: '20px', borderRadius: '12px' }}>
                                    <h3>🚀 実行設定</h3>
                                    <p style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>
                                        ファイルは<strong>コピー</strong>されます。元ファイルは削除されません。
                                    </p>

                                    <div style={{ marginBottom: '16px' }}>
                                        <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem' }}>出力先フォルダ</label>
                                        <button
                                            onClick={handleSelectDestination}
                                            style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-bg-primary)', color: 'var(--color-text)', cursor: 'pointer', textAlign: 'left' }}
                                        >
                                            {destinationPath ? destinationPath.split(/[/\\]/).pop() : '選択してください...'}
                                        </button>
                                        {destinationPath && <div style={{ fontSize: '0.8rem', marginTop: '4px', color: '#4ade80', wordBreak: 'break-all' }}>{destinationPath}</div>}
                                    </div>

                                    <button
                                        onClick={handleExecute}
                                        disabled={!destinationPath || isLoading}
                                        style={{
                                            width: '100%', padding: '16px', borderRadius: '8px',
                                            background: (!destinationPath || isLoading) ? '#4b5563' : 'linear-gradient(135deg, #10b981, #059669)',
                                            color: 'white', border: 'none', fontWeight: 'bold', cursor: (!destinationPath || isLoading) ? 'not-allowed' : 'pointer',
                                            fontSize: '1.1rem'
                                        }}
                                    >
                                        {isLoading ? 'コピー中...' : '整理を実行 (コピー)'}
                                    </button>
                                </div>
                                <button onClick={() => setStep(2)} style={{ padding: '12px', background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text)', borderRadius: '8px', cursor: 'pointer' }}>
                                    戻る
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Step 4: Result */}
                {step === 4 && executionResult && (
                    <div style={{ textAlign: 'center', padding: '48px' }}>
                        <div style={{ fontSize: '5rem', marginBottom: '24px' }}>🎉</div>
                        <h2>整理が完了しました！</h2>
                        <p style={{ fontSize: '1.2rem', marginBottom: '32px' }}>
                            成功: {executionResult.successCount} 件 / 失敗: {executionResult.failCount} 件
                        </p>

                        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
                            <button
                                onClick={() => window.electronAPI.organizerOpenFolder(destinationPath!)}
                                style={{ padding: '12px 24px', fontSize: '1.1rem', borderRadius: '8px', background: 'var(--color-primary)', color: 'white', border: 'none', cursor: 'pointer' }}
                            >
                                📂 整理されたフォルダを開く
                            </button>
                            <button
                                onClick={() => { setStep(1); setSourcePath(null); setFiles([]); setPlan(null); setDestinationPath(null); }}
                                style={{ padding: '12px 24px', fontSize: '1.1rem', borderRadius: '8px', background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)', cursor: 'pointer' }}
                            >
                                🔄 最初に戻る
                            </button>
                        </div>

                        {executionResult.failCount > 0 && (
                            <div style={{ marginTop: '32px', textAlign: 'left', maxWidth: '600px', margin: '32px auto 0' }}>
                                <h4>エラー詳細:</h4>
                                <pre style={{ background: '#1e1e2e', padding: '12px', borderRadius: '8px', overflow: 'auto', maxHeight: '200px' }}>
                                    {JSON.stringify(executionResult.errors, null, 2)}
                                </pre>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default OrganizerScreen;
