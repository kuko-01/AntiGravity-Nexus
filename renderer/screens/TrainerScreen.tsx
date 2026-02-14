import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const TrainerScreen: React.FC = () => {
    const navigate = useNavigate();
    const [currentStep, setCurrentStep] = useState(1);
    const [installing, setInstalling] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);

    // Dataset Params
    const [datasetName, setDatasetName] = useState('');
    const [inputDir, setInputDir] = useState('');
    const [processing, setProcessing] = useState(false);

    const addLog = (msg: string) => {
        setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);
    };

    const handleInstallDeps = async () => {
        if (installing) return;
        setInstalling(true);
        addLog('学習用依存関係をインストールしています... 数分かかる場合があります。');

        try {
            await window.electronAPI.ttsInstallTrainingDeps();
            addLog('学習用依存関係のインストールが完了しました！');
            // Auto advance to step 2 after success? Or let user click next?
            // Let's enable Next button or auto-advance if user wants.
        } catch (error) {
            addLog(`依存関係のインストールエラー: ${String(error)}`);
            console.error(error);
        } finally {
            setInstalling(false);
        }
    };

    const handleSelectInputDir = async () => {
        const path = await window.electronAPI.utilSelectDirectory();
        if (path) {
            setInputDir(path);
            addLog(`入力ディレクトリを選択しました: ${path}`);
        }
    };

    const handleSlice = async () => {
        if (!datasetName || !inputDir) {
            addLog('エラー: データセット名と入力ディレクトリを指定してください。');
            return;
        }
        setProcessing(true);
        addLog(`データセット ${datasetName} の音声スライスを開始します...`);
        try {
            await window.electronAPI.ttsSliceAudio(datasetName, inputDir, {
                minSec: 2,
                maxSec: 12,
                minSilenceDurMs: 700
            });
            addLog('音声スライスが完了しました！');
        } catch (error) {
            addLog(`音声スライスエラー: ${String(error)}`);
        } finally {
            setProcessing(false);
        }
    };

    const handleTranscribe = async () => {
        if (!datasetName) {
            addLog('エラー: データセット名は必須です。');
            return;
        }
        setProcessing(true);
        addLog(`データセット ${datasetName} の文字起こしを開始します...`);
        try {
            await window.electronAPI.ttsTranscribeAudio(datasetName, {
                language: 'ja',
                device: 'cuda', // TODO: Make configurable or auto-detect
                model: 'large-v3'
            });
            addLog('文字起こしが完了しました！');
        } catch (error) {
            addLog(`文字起こしエラー: ${String(error)}`);
        } finally {
            setProcessing(false);
        }
    };

    const handleCleanAudio = async () => {
        if (!datasetName) {
            addLog('エラー: データセット名は必須です。');
            return;
        }
        setProcessing(true);
        addLog(`データセット ${datasetName} の音声クリーニング (DeepFilterNet) を開始します...`);
        try {
            const result = await window.electronAPI.ttsCleanAudio(datasetName);
            if (result.success) {
                addLog(`音声クリーニングをバックグラウンドで開始しました: ${result.message || ''}`);
            } else {
                addLog(`音声クリーニングエラー: ${result.error?.message || '不明なエラー'}`);
            }
        } catch (error) {
            addLog(`音声クリーニングエラー: ${String(error)}`);
        } finally {
            setProcessing(false);
        }
    };

    const handleFilterAudio = async () => {
        if (!datasetName) {
            addLog('エラー: データセット名は必須です。');
            return;
        }
        setProcessing(true);
        addLog(`データセット ${datasetName} のAI品質チェック (Gemini) を開始します...`);
        try {
            const result = await window.electronAPI.ttsFilterAudio(datasetName);
            if (result.success) {
                addLog(`AI品質チェックをバックグラウンドで開始しました: ${result.message || ''}`);
            } else {
                addLog(`AI品質チェックエラー: ${result.error?.message || '不明なエラー'}`);
            }
        } catch (error) {
            addLog(`AI品質チェックエラー: ${String(error)}`);
        } finally {
            setProcessing(false);
        }
    };

    const steps = [
        { id: 1, title: '環境セットアップ' },
        { id: 2, title: 'データセット準備' },
        { id: 3, title: '音声処理・品質チェック' },
        { id: 4, title: '学習実行' },
    ];

    const btnStyle = (variant: 'primary' | 'secondary' | 'danger' | 'success' = 'primary', disabled = false) => ({
        padding: '10px 20px',
        borderRadius: '8px',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontWeight: 'bold' as const,
        fontSize: '14px',
        opacity: disabled ? 0.7 : 1,
        background: variant === 'primary' ? 'linear-gradient(45deg, #4f46e5, #ec4899)' :
            variant === 'secondary' ? '#374151' :
                variant === 'success' ? '#10b981' :
                    '#ef4444',
        color: 'white',
        transition: 'all 0.2s',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        boxShadow: disabled ? 'none' : '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)'
    });

    const inputStyle = {
        background: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '6px',
        padding: '10px',
        color: 'white',
        width: '100%',
        marginBottom: '16px'
    };

    const labelStyle = {
        display: 'block',
        color: '#9ca3af',
        marginBottom: '6px',
        fontSize: '14px'
    };

    return (
        <div style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            background: '#0f172a',
            color: '#f8fafc',
            fontFamily: '"Inter", sans-serif'
        }}>
            {/* Header */}
            <div style={{
                padding: '16px 24px',
                borderBottom: '1px solid #1e293b',
                display: 'flex',
                alignItems: 'center',
                background: '#1e293b'
            }}>
                <button
                    onClick={() => navigate('/')}
                    style={{
                        background: 'transparent',
                        border: '1px solid #334155',
                        color: '#9ca3af',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        marginRight: '16px',
                        fontSize: '14px'
                    }}
                >
                    ← 戻る
                </button>
                <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>Model Trainer (Beta)</h1>
            </div>

            <div style={{
                flex: 1,
                display: 'grid',
                gridTemplateColumns: '280px 1fr',
                gap: '0',
                minHeight: 0
            }}>
                {/* Sidebar */}
                <div style={{
                    background: '#1e293b',
                    padding: '24px',
                    borderRight: '1px solid #334155'
                }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {steps.map(step => (
                            <div
                                key={step.id}
                                onClick={() => setCurrentStep(step.id)}
                                style={{
                                    padding: '12px 16px',
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                    background: currentStep === step.id ? 'rgba(79, 70, 229, 0.1)' : 'transparent',
                                    borderLeft: currentStep === step.id ? '4px solid #4f46e5' : '4px solid transparent',
                                    color: currentStep === step.id ? '#818cf8' : '#64748b',
                                    transition: 'all 0.2s',
                                    fontWeight: currentStep === step.id ? 600 : 400
                                }}
                            >
                                {step.id}. {step.title}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Main Content */}
                <div style={{
                    padding: '32px',
                    background: '#0f172a',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '24px'
                }}>
                    <div style={{
                        background: '#1e293b',
                        borderRadius: '12px',
                        padding: '24px',
                        border: '1px solid #334155',
                        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
                    }}>
                        <h2 style={{ marginTop: 0, marginBottom: '24px', fontSize: '1.5rem' }}>{steps[currentStep - 1].title}</h2>

                        {currentStep === 1 && (
                            <div>
                                <p style={{ color: '#9ca3af', marginBottom: '24px', lineHeight: 1.6 }}>
                                    カスタム音声モデルの学習には、特定のPythonライブラリが必要です。<br />
                                    以下のボタンをクリックして、必要な依存関係（Style-Bert-VITS2, torchなど）をインストールしてください。
                                </p>
                                <button
                                    onClick={handleInstallDeps}
                                    style={btnStyle('primary', installing)}
                                    disabled={installing}
                                >
                                    {installing ? 'インストール中...' : '学習用依存関係をインストール'}
                                </button>
                            </div>
                        )}

                        {currentStep === 2 && (
                            <div>
                                <p style={{ color: '#9ca3af', marginBottom: '24px', lineHeight: 1.6 }}>
                                    学習用の音声ファイルを準備します。wavファイルを含むフォルダを選択してください。<br />
                                    システムが自動的に適切な長さにスライスし、文字起こしを行います。
                                </p>

                                <div style={{ maxWidth: '600px' }}>
                                    <label style={labelStyle}>データセット名 (モデル名)</label>
                                    <input
                                        type="text"
                                        value={datasetName}
                                        onChange={(e) => setDatasetName(e.target.value)}
                                        placeholder="例: my_voice_v1"
                                        style={inputStyle}
                                    />

                                    <label style={labelStyle}>入力音声ディレクトリ</label>
                                    <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                                        <input
                                            type="text"
                                            value={inputDir}
                                            readOnly
                                            placeholder="フォルダを選択..."
                                            style={{ ...inputStyle, marginBottom: 0, flex: 1, cursor: 'default' }}
                                        />
                                        <button
                                            onClick={handleSelectInputDir}
                                            style={btnStyle('secondary')}
                                        >
                                            フォルダ選択
                                        </button>
                                    </div>

                                    <div style={{ display: 'flex', gap: '16px', marginTop: '32px' }}>
                                        <button
                                            onClick={handleSlice}
                                            style={btnStyle('primary', processing || !datasetName || !inputDir)}
                                            disabled={processing || !datasetName || !inputDir}
                                        >
                                            1. 音声スライス実行
                                        </button>
                                        <button
                                            onClick={handleTranscribe}
                                            style={btnStyle('primary', processing || !datasetName)}
                                            disabled={processing || !datasetName}
                                        >
                                            2. 文字起こし実行
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {currentStep === 3 && (
                            <div>
                                <p style={{ color: '#9ca3af', marginBottom: '24px', lineHeight: 1.6 }}>
                                    音声データの品質を向上させ、低品質ファイルを自動で除外します。
                                </p>

                                <div style={{
                                    background: '#1e293b',
                                    borderRadius: '12px',
                                    padding: '20px',
                                    marginBottom: '20px',
                                    border: '1px solid #334155'
                                }}>
                                    <h3 style={{ color: '#e2e8f0', margin: '0 0 16px 0', fontSize: '16px' }}>
                                        🎧 音声クリーニング (DeepFilterNet)
                                    </h3>
                                    <p style={{ color: '#94a3b8', fontSize: '14px', marginBottom: '16px' }}>
                                        BGM、リバーブ、ホワイトノイズを AI で自動除去します。
                                        RVCで生成した音声や、ノイズが多い録音に効果的です。
                                    </p>
                                    <button
                                        onClick={handleCleanAudio}
                                        style={btnStyle('primary', processing || !datasetName)}
                                        disabled={processing || !datasetName}
                                    >
                                        🔇 音声をクリーニング
                                    </button>
                                </div>

                                <div style={{
                                    background: '#1e293b',
                                    borderRadius: '12px',
                                    padding: '20px',
                                    border: '1px solid #334155'
                                }}>
                                    <h3 style={{ color: '#e2e8f0', margin: '0 0 16px 0', fontSize: '16px' }}>
                                        🤖 AI 品質チェック (Gemini 1.5 Flash)
                                    </h3>
                                    <p style={{ color: '#94a3b8', fontSize: '14px', marginBottom: '8px' }}>
                                        Gemini AI が音声を聴いて、TTS学習に適さないファイルを自動判定し除外します。
                                    </p>
                                    <p style={{
                                        color: '#f59e0b',
                                        fontSize: '12px',
                                        marginBottom: '16px',
                                        background: 'rgba(245, 158, 11, 0.1)',
                                        padding: '8px 12px',
                                        borderRadius: '6px',
                                        border: '1px solid rgba(245, 158, 11, 0.3)'
                                    }}>
                                        ⚠️ GOOGLE_API_KEY 環境変数の設定が必要です
                                    </p>
                                    <button
                                        onClick={handleFilterAudio}
                                        style={btnStyle('secondary', processing || !datasetName)}
                                        disabled={processing || !datasetName}
                                    >
                                        🔍 AI 品質チェック実行
                                    </button>
                                </div>
                            </div>
                        )}

                        {currentStep === 4 && (
                            <div style={{ color: '#64748b', fontStyle: 'italic' }}>
                                学習実行機能は準備中です...
                            </div>
                        )}
                    </div>

                    {/* Logs Panel */}
                    <div style={{
                        marginTop: 'auto',
                        background: '#020617',
                        borderRadius: '12px',
                        padding: '16px',
                        height: '240px',
                        display: 'flex',
                        flexDirection: 'column',
                        border: '1px solid #1e293b'
                    }}>
                        <div style={{
                            color: '#94a3b8',
                            fontSize: '12px',
                            fontWeight: 600,
                            marginBottom: '8px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em'
                        }}>
                            処理ログ
                        </div>
                        <div style={{
                            flex: 1,
                            overflowY: 'auto',
                            fontFamily: 'Consolas, "Monaco", monospace',
                            fontSize: '13px',
                            color: '#e2e8f0',
                            whiteSpace: 'pre-wrap'
                        }}>
                            {logs.length === 0 ? (
                                <span style={{ color: '#475569', fontStyle: 'italic' }}>待機中...</span>
                            ) : (
                                logs.map((log, i) => (
                                    <div key={i} style={{
                                        marginBottom: '4px',
                                        color: log.toLowerCase().includes('error') ? '#ef4444' :
                                            log.toLowerCase().includes('success') ? '#10b981' : 'inherit'
                                    }}>{log}</div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TrainerScreen;
