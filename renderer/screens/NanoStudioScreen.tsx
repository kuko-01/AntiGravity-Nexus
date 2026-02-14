import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Preset {
    name: string;
    systemPrompt: string;
    userPrompt: string;
    negativePrompt: string;
    aspectRatio: string;
}

interface GeneratedImage {
    path: string;
    timestamp: number;
    base64?: string;
}

const NanoStudioScreen: React.FC = () => {
    const navigate = useNavigate();

    // Prompts
    const [systemPrompt, setSystemPrompt] = useState('high quality, professional photography, 8k, detailed');
    const [userPrompt, setUserPrompt] = useState('');
    const [negativePrompt, setNegativePrompt] = useState('low quality, blurry, distorted');

    // Settings
    const [aspectRatio, setAspectRatio] = useState('1:1');
    const [resolution, setResolution] = useState('1024x1024');
    const [batchCount, setBatchCount] = useState(1);
    const [referenceImages, setReferenceImages] = useState<{ path: string; preview: string }[]>([]);

    // New Settings
    const [modelKey, setModelKey] = useState('gemini3pro');
    const [customModelId, setCustomModelId] = useState('');
    const [upscaleScale, setUpscaleScale] = useState(1);
    const [outputFormat, setOutputFormat] = useState('png');
    const [outputQuality, setOutputQuality] = useState(90);

    // Comparison
    const [compareSelection, setCompareSelection] = useState<string[]>([]);
    const [showCompare, setShowCompare] = useState(false);

    // Presets
    const [presets, setPresets] = useState<Preset[]>([]);
    const [selectedPreset, setSelectedPreset] = useState<string>('');
    const [newPresetName, setNewPresetName] = useState('');

    // Generation state
    const [isGenerating, setIsGenerating] = useState(false);
    const [progress, setProgress] = useState(0);
    const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
    const [message, setMessage] = useState<string | null>(null);

    // vNext: Prompt Automation State
    const [optimizeEnabled, setOptimizeEnabled] = useState(false);
    const [finalPromptPreview, setFinalPromptPreview] = useState<string | null>(null);
    const [costEstimate, setCostEstimate] = useState<number | null>(null);
    const [budgetStatus, setBudgetStatus] = useState<{ daily: number, monthly: number, limits: { daily: number, monthly: number } } | null>(null);

    // Load presets on mount
    useEffect(() => {
        loadPresets();
    }, []);

    const loadPresets = async () => {
        try {
            const result = await window.electronAPI.nanoLoadPresets();
            if (result.success && result.presets) {
                setPresets(result.presets);
            }
        } catch (err) {
            console.error('Failed to load presets:', err);
        }
    };

    const handleLoadPreset = async (presetName: string) => {
        if (!presetName) return;
        try {
            const result = await window.electronAPI.nanoLoadPreset(presetName);
            if (result.success && result.preset) {
                const p = result.preset;
                setSystemPrompt(p.systemPrompt || '');
                setUserPrompt(p.userPrompt || '');
                setNegativePrompt(p.negativePrompt || '');
                setAspectRatio(p.aspectRatio || '1:1');
                setSelectedPreset(presetName);
                setMessage(`プリセット「${presetName}」を読み込みました`);
            }
        } catch (err) {
            setMessage('プリセット読み込み失敗: ' + String(err));
        }
    };

    const handleSavePreset = async () => {
        if (!newPresetName.trim()) {
            setMessage('プリセット名を入力してください');
            return;
        }
        try {
            const preset: Preset = {
                name: newPresetName,
                systemPrompt,
                userPrompt,
                negativePrompt,
                aspectRatio
            };
            const result = await window.electronAPI.nanoSavePreset(preset);
            if (result.success) {
                setMessage(`プリセット「${newPresetName}」を保存しました`);
                setNewPresetName('');
                loadPresets();
            } else {
                setMessage('保存失敗: ' + result.error);
            }
        } catch (err) {
            setMessage('保存失敗: ' + String(err));
        }
    };

    const handleReferenceUpload = async () => {
        try {
            const result = await window.electronAPI.selectFile(['png', 'jpg', 'jpeg', 'webp'], true);
            if (result.success && result.paths) {
                const newImages: { path: string; preview: string }[] = [];
                for (const p of result.paths) {
                    if (referenceImages.some(img => img.path === p)) continue;

                    const readRes = await window.electronAPI.readImage(p);
                    if (readRes.success && readRes.base64) {
                        const byteCharacters = atob(readRes.base64);
                        const byteNumbers = new Array(byteCharacters.length);
                        for (let i = 0; i < byteCharacters.length; i++) {
                            byteNumbers[i] = byteCharacters.charCodeAt(i);
                        }
                        const byteArray = new Uint8Array(byteNumbers);
                        const blob = new Blob([byteArray], { type: 'image/png' });
                        const url = URL.createObjectURL(blob);
                        newImages.push({ path: p, preview: url });
                    } else {
                        newImages.push({ path: p, preview: `file://${p}` });
                    }
                }
                setReferenceImages(prev => [...prev, ...newImages]);
            } else if (result.success && result.path) {
                // Fallback
                const p = result.path;
                if (!referenceImages.some(img => img.path === p)) {
                    const readRes = await window.electronAPI.readImage(p);
                    const url = readRes.success && readRes.base64 ? `data:image/png;base64,${readRes.base64}` : `file://${p}`;
                    setReferenceImages(prev => [...prev, { path: p, preview: url }]);
                }
            }
        } catch (err) {
            setMessage('画像選択失敗: ' + String(err));
        }
    };

    // State for vNext features
    const [mode, setMode] = useState<'draft' | 'production' | 'final' | 'manual'>('draft');
    const [upscaleMethod, setUpscaleMethod] = useState<'local' | 'cloud' | 'auto'>('auto');

    const [history, setHistory] = useState<any[]>([]);
    const [showHistory, setShowHistory] = useState(false);

    // Load history and calculate initial estimate
    useEffect(() => {
        loadHistory();
        loadBudget();
        updateEstimate();
    }, []);

    useEffect(() => {
        updateEstimate();
    }, [mode, modelKey, customModelId, upscaleScale, upscaleMethod, batchCount]);

    const loadHistory = async () => {
        try {
            const result = await window.electronAPI.invoke('nano:get-history');
            if (result.success) setHistory(result.history);
        } catch (e) {
            console.error(e);
        }
    };

    const loadBudget = async () => {
        try {
            const res = await window.electronAPI.invoke('nano:get-budget-status');
            if (res.success) setBudgetStatus({ ...res.status, limits: res.limits });
        } catch (e) {
            console.error(e);
        }
    };

    const updateEstimate = async () => {
        try {
            const result = await window.electronAPI.invoke('nano:estimate-cost', {
                mode,
                modelKey,
                customModelId,
                count: batchCount,
                upscaleMethod
            });
            if (result.success) setCostEstimate(result.cost);
        } catch (e) {
            console.error(e);
        }
    };

    // vNext: Auto Prompt Handler
    const handleAutoPrompt = async (type: 'base' | 'negative') => {
        if (!userPrompt.trim() && type === 'base') {
            setMessage('User Promptを入力してください (これを元にBaseを生成します)');
            return;
        }
        setMessage(`AIが ${type} Prompt を生成中...`);
        try {
            const result = await window.electronAPI.invoke('nano:auto-prompt', { type, userPrompt });
            if (result.success) {
                if (type === 'base') setSystemPrompt(result.prompt);
                else setNegativePrompt(result.prompt);
                setMessage('生成完了！');
            } else {
                setMessage('生成エラー: ' + result.error);
            }
        } catch (e) {
            setMessage('通信エラー: ' + String(e));
        }
    };

    const handleGenerate = async () => {
        if (!userPrompt.trim()) {
            setMessage('User Promptを入力してください');
            return;
        }

        setIsGenerating(true);
        setProgress(0);
        setGeneratedImages([]);
        setMessage(null);

        try {
            let effectiveUserPrompt = userPrompt;

            // vNext: Prompt Optimization (Once per batch)
            if (optimizeEnabled) {
                setMessage('プロンプトを最適化中...');
                const optResult = await window.electronAPI.invoke('nano:optimize-prompt', userPrompt);
                if (optResult.success) {
                    effectiveUserPrompt = optResult.prompt;
                    setFinalPromptPreview(effectiveUserPrompt);
                } else {
                    console.warn('Optimization failed:', optResult.error);
                }
            }

            for (let i = 0; i < batchCount; i++) {
                setProgress(((i) / batchCount) * 100);
                setMessage(`生成中... (${i + 1}/${batchCount})`);

                const combinedPrompt = [systemPrompt, effectiveUserPrompt].filter(p => p.trim()).join('\n\n');

                const result = await window.electronAPI.nanoGenerate({
                    prompt: combinedPrompt,
                    negativePrompt,
                    aspectRatio,
                    resolution,
                    referenceImages: referenceImages.map(i => i.path),
                    modelKey,
                    customModelId: modelKey === 'custom' ? customModelId : undefined,
                    upscaleScale,
                    mode,
                    upscaleMethod,
                    outputFormat,
                    outputQuality
                });

                if (result.success && result.imagePath) {
                    setGeneratedImages(prev => [...prev, { path: result.imagePath!, timestamp: Date.now(), base64: result.imageBase64 }]);
                } else {
                    setMessage('生成失敗: ' + result.error);
                    break;
                }
            }
            setProgress(100);
            setMessage(`✅ ${batchCount}枚の画像を生成しました！ Estimated Cost: $${costEstimate?.toFixed(2)}`);
            setMessage(`✅ ${batchCount}枚の画像を生成しました！ Estimated Cost: $${costEstimate?.toFixed(2)}`);
            loadHistory(); // Refresh history
            loadBudget();
        } catch (err) {
            setMessage('生成エラー: ' + String(err));
        } finally {
            setIsGenerating(false);
        }
    };

    const handleUpscale = async (path: string) => {
        if (!path) return;
        setMessage('Applying 4x Upscale (Refining details)...');
        try {
            const res = await window.electronAPI.upscaleImage(path, 4);
            if (res.success && res.path) {
                setGeneratedImages(prev => [{ path: res.path!, timestamp: Date.now() }, ...prev]);
                setMessage('Running Final Polish... Done!');
                loadHistory();
            } else {
                setMessage('Upscale failed: ' + res.error);
            }
        } catch (err) {
            setMessage('Upscale error: ' + String(err));
        }
    };

    const handleSmooth = async (path: string) => {
        if (!path) return;
        setMessage('Applying Soft Polish (Smoothing)...');
        try {
            const res = await window.electronAPI.smoothImage(path);
            if (res.success && res.path) {
                setGeneratedImages(prev => [{ path: res.path!, timestamp: Date.now() }, ...prev]);
                setMessage('Smoothing Done!');
                loadHistory();
            } else {
                setMessage('Smoothing failed: ' + res.error);
            }
        } catch (err) {
            setMessage('Smooth error: ' + String(err));
        }
    };

    const toggleCompare = (path: string) => {
        setCompareSelection(prev => {
            if (prev.includes(path)) return prev.filter(p => p !== path);
            if (prev.length >= 2) return [prev[1], path]; // Keep last 1 selection if 2 already selected? Or just block? 
            // Better behavior: If 2 selected, replace the oldest selection? Or just add.
            // Let's implement: Max 2 selection. Like "Select A, Select B". If Select C -> Remove A, Select C?
            // "Stack" behavior.
            return [...prev, path];
        });
    };

    return (
        <div style={{ display: 'flex', height: '100vh', background: 'var(--color-bg-primary)', color: 'var(--color-text)' }}>
            {/* Sidebar */}
            <div style={{ width: '300px', background: 'var(--color-surface)', padding: '16px', overflowY: 'auto', borderRight: '1px solid var(--color-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                    <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}>🏠</button>
                    <h2 style={{ margin: 0 }}>🎨 Nano Studio</h2>
                </div>

                {/* Preset Management */}
                <div style={{ marginBottom: '24px' }}>
                    <h4 style={{ marginBottom: '8px' }}>📁 プリセット</h4>
                    <select
                        value={selectedPreset}
                        onChange={(e) => handleLoadPreset(e.target.value)}
                        style={{ width: '100%', padding: '8px', marginBottom: '8px', color: 'black' }}
                    >
                        <option value="">-- 選択 --</option>
                        {presets.map((p, i) => (
                            <option key={i} value={p.name}>{p.name}</option>
                        ))}
                    </select>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                            type="text"
                            value={newPresetName}
                            onChange={(e) => setNewPresetName(e.target.value)}
                            placeholder="新規プリセット名"
                            style={{ flex: 1, padding: '8px', color: 'black' }}
                        />
                        <button onClick={handleSavePreset} style={{ padding: '8px' }}>保存</button>
                    </div>
                </div>

                {/* Reference Image */}
                <div style={{ marginBottom: '24px' }}>
                    <h4 style={{ marginBottom: '8px' }}>🖼️ 参照画像</h4>
                    <button onClick={handleReferenceUpload} style={{ width: '100%', padding: '8px', marginBottom: '8px' }}>
                        画像を選択
                    </button>
                    {referenceImages.length > 0 && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                            {referenceImages.map((img, i) => (
                                <div key={i} style={{ position: 'relative', aspectRatio: '1/1' }}>
                                    <img src={img.preview} alt="Ref" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} />
                                    <button
                                        onClick={() => setReferenceImages(prev => prev.filter(x => x.path !== img.path))}
                                        style={{ position: 'absolute', top: '2px', right: '2px', background: 'rgba(0,0,0,0.5)', color: 'white', border: 'none', borderRadius: '50%', width: '20px', height: '20px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Settings */}
                <div style={{ marginBottom: '24px' }}>
                    <h4 style={{ marginBottom: '8px' }}>⚙️ 設定</h4>

                    {/* Mode Selector */}
                    <label style={{ display: 'block', marginBottom: '8px' }}>
                        モード (Mode)
                        <select
                            value={mode}
                            onChange={(e) => setMode(e.target.value as any)}
                            style={{ width: '100%', padding: '8px', color: 'black', fontWeight: 'bold' }}
                        >
                            <option value="draft">Draft (Fast - $0.02)</option>
                            <option value="production">Production ($0.04)</option>
                            <option value="final">Final (Ultra - $0.06)</option>
                            <option value="manual">Manual (Custom)</option>
                        </select>
                    </label>

                    {/* Manual Params */}
                    {mode === 'manual' && (
                        <label style={{ display: 'block', marginBottom: '8px' }}>
                            モデル (Model)
                            <select
                                value={modelKey}
                                onChange={(e) => setModelKey(e.target.value)}
                                style={{ width: '100%', padding: '8px', color: 'black' }}
                            >
                                <option value="gemini3pro">Gemini 3 Pro Image (Preview)</option>
                                <option value="gemini-3-pro-preview">Gemini 3 Pro (Text + Vision)</option>
                                <option value="imagen4ultra">Imagen 4 Ultra</option>
                                <option value="imagen-3">Imagen 3</option>
                                <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                                <option value="gemini-2.5-flash">Gemini 2.5 Flash Image</option>
                                <option value="custom">Custom</option>
                            </select>
                            {modelKey === 'custom' && (
                                <input
                                    type="text"
                                    value={customModelId}
                                    onChange={(e) => setCustomModelId(e.target.value)}
                                    placeholder="Model ID"
                                    style={{ width: '100%', padding: '8px', marginTop: '4px', color: 'black' }}
                                />
                            )}
                        </label>
                    )}

                    <label style={{ display: 'block', marginBottom: '8px' }}>
                        アップスケール (Upscale)
                        <div style={{ display: 'flex', gap: '4px' }}>
                            <select
                                value={upscaleScale}
                                onChange={(e) => setUpscaleScale(Number(e.target.value))}
                                style={{ flex: 1, padding: '8px', color: 'black' }}
                            >
                                <option value={1}>1x (None)</option>
                                <option value={2}>2x</option>
                                <option value={4}>4x</option>
                            </select>
                            <select
                                value={upscaleMethod}
                                onChange={(e) => setUpscaleMethod(e.target.value as any)}
                                style={{ flex: 1, padding: '8px', color: 'black' }}
                            >
                                <option value="auto">Auto</option>
                                <option value="local">Local</option>
                                <option value="cloud">Cloud ($)</option>
                            </select>
                        </div>
                    </label>

                    <label style={{ display: 'block', marginBottom: '8px' }}>
                        アスペクト比
                        <select
                            value={aspectRatio}
                            onChange={(e) => setAspectRatio(e.target.value)}
                            style={{ width: '100%', padding: '8px', color: 'black' }}
                        >
                            <option value="1:1">1:1</option>
                            <option value="16:9">16:9</option>
                            <option value="9:16">9:16</option>
                            <option value="4:3">4:3</option>
                            <option value="3:4">3:4</option>
                        </select>
                    </label>

                    <label style={{ display: 'block', marginBottom: '8px' }}>
                        解像度 (Proのみ)
                        <select
                            value={resolution}
                            onChange={(e) => setResolution(e.target.value)}
                            style={{ width: '100%', padding: '8px', color: 'black' }}
                        >
                            <option value="1024x1024">1K (1024x1024)</option>
                            <option value="2048x2048">2K (2048x2048)</option>
                        </select>
                    </label>

                    <label style={{ display: 'block', marginBottom: '8px' }}>
                        出力フォーマット (Output)
                        <div style={{ display: 'flex', gap: '4px' }}>
                            <select
                                value={outputFormat}
                                onChange={(e) => setOutputFormat(e.target.value)}
                                style={{ flex: 1, padding: '8px', color: 'black' }}
                            >
                                <option value="png">PNG</option>
                                <option value="jpeg">JPEG</option>
                                <option value="webp">WebP</option>
                                <option value="tiff32">TIFF (32-bit Float)</option>
                            </select>
                            {(outputFormat === 'jpeg' || outputFormat === 'webp') && (
                                <input
                                    type="number"
                                    min="1" max="100"
                                    value={outputQuality}
                                    onChange={(e) => setOutputQuality(parseInt(e.target.value))}
                                    placeholder="Quality"
                                    style={{ width: '80px', padding: '8px', color: 'black' }}
                                />
                            )}
                        </div>
                    </label>

                    <label style={{ display: 'block', marginBottom: '8px' }}>
                        生成枚数
                        <input
                            type="number"
                            min="1"
                            max="10"
                            value={batchCount}
                            onChange={(e) => setBatchCount(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
                            style={{ width: '100%', padding: '8px', color: 'black' }}
                        />
                    </label>

                    {/* Cost Estimate */}
                    <div style={{ marginTop: '16px', padding: '12px', background: '#1f2937', borderRadius: '8px', border: '1px solid #374151' }}>
                        <div style={{ fontSize: '0.8rem', color: '#9ca3af' }}>ESTIMATED COST</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#10b981' }}>
                            ${costEstimate?.toFixed(2) || '0.00'}
                        </div>
                    </div>
                </div>

                {/* Budget Info */}
                {budgetStatus && (
                    <div style={{ marginTop: '8px', padding: '12px', background: '#1f2937', borderRadius: '8px', border: '1px solid #374151' }}>
                        <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: '4px' }}>DAILY BUDGET</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: budgetStatus.daily > budgetStatus.limits.daily ? '#ef4444' : '#60a5fa' }}>
                                ${budgetStatus.daily.toFixed(3)}
                            </div>
                            <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>/ ${budgetStatus.limits.daily.toFixed(2)}</div>
                        </div>
                        <div style={{ width: '100%', height: '4px', background: '#374151', marginTop: '8px', borderRadius: '2px', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.min(100, (budgetStatus.daily / budgetStatus.limits.daily) * 100)}%`, height: '100%', background: budgetStatus.daily > budgetStatus.limits.daily ? '#ef4444' : '#60a5fa' }} />
                        </div>
                    </div>
                )}

                {/* History Toggle */}
                <button
                    onClick={() => setShowHistory(!showHistory)}
                    style={{ width: '100%', padding: '12px', background: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', color: 'white' }}
                >
                    {showHistory ? 'Generating Mode' : 'View History'}
                </button>
            </div>

            {/* Main Area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '24px', overflowY: 'auto' }}>

                {showHistory ? (
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                            <h2 style={{ margin: 0 }}>📜 Generation History</h2>
                            {compareSelection.length >= 2 && (
                                <button onClick={() => setShowCompare(true)} style={{ background: '#f59e0b', color: 'black', fontWeight: 'bold', border: 'none', padding: '8px 16px', borderRadius: '24px', cursor: 'pointer' }}>
                                    ⚖️ Compare ({compareSelection.length})
                                </button>
                            )}
                        </div>
                        <div style={{ display: 'grid', gap: '16px' }}>
                            {history.map((record, i) => (
                                <div key={i} style={{ display: 'flex', gap: '16px', background: compareSelection.includes(record.imagePath!) ? '#374151' : 'var(--color-surface)', padding: '16px', borderRadius: '12px', border: compareSelection.includes(record.imagePath!) ? '2px solid #f59e0b' : '2px solid transparent' }}>
                                    <div style={{ display: 'flex', alignItems: 'center' }}>
                                        <input
                                            type="checkbox"
                                            checked={compareSelection.includes(record.imagePath!)}
                                            onChange={() => toggleCompare(record.imagePath!)}
                                            style={{ width: '20px', height: '20px', cursor: 'pointer' }}
                                        />
                                    </div>
                                    <div style={{ width: '120px', height: '120px', background: '#000', borderRadius: '8px', overflow: 'hidden' }}>
                                        {record.imagePath && <img src={`file://${record.imagePath.replace(/\\/g, '/')}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <h4 style={{ margin: '0 0 8px 0' }}>{new Date(record.timestamp).toLocaleString()}</h4>
                                            <span style={{ color: '#10b981', fontWeight: 'bold' }}>${Number(record.cost).toFixed(2)}</span>
                                        </div>
                                        <div style={{ fontSize: '0.9rem', color: '#ccc', marginBottom: '8px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                                            <span>Mode: {record.mode} | Model: {record.modelId} | Upscale: {record.upscale}x</span>
                                            <button onClick={() => handleUpscale(record.imagePath)} style={{ background: '#8b5cf6', color: 'white', border: 'none', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '0.8rem' }}>✨ 4x</button>
                                            <button onClick={() => handleSmooth(record.imagePath)} style={{ background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '0.8rem' }}>💧 Soft</button>
                                        </div>
                                        <div style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '600px' }}>
                                            {record.prompt}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    <>
                        {message && (
                            <div style={{ background: '#3b82f6', color: 'white', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>
                                {message}
                            </div>
                        )}

                        {/* Prompt Inputs */}
                        <div style={{ display: 'grid', gap: '16px', marginBottom: '24px' }}>
                            <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                    <label style={{ fontWeight: 'bold' }}>🎨 System / Base Prompt</label>
                                    <button
                                        onClick={() => handleAutoPrompt('base')}
                                        style={{ fontSize: '0.8rem', padding: '2px 8px', background: '#ec4899', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer' }}
                                    >
                                        ✨ Auto Base
                                    </button>
                                </div>
                                <textarea
                                    value={systemPrompt}
                                    onChange={(e) => setSystemPrompt(e.target.value)}
                                    placeholder="画風や品質タグ (例: high quality, anime style, 8k)"
                                    style={{ width: '100%', height: '80px', padding: '12px', borderRadius: '8px', resize: 'vertical', color: 'black' }}
                                />
                            </div>
                            <div>
                                <label style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>✏️ User Prompt</label>
                                <textarea
                                    value={userPrompt}
                                    onChange={(e) => setUserPrompt(e.target.value)}
                                    placeholder="生成したい画像の説明 (例: A cat sitting on a windowsill)"
                                    style={{ width: '100%', height: '120px', padding: '12px', borderRadius: '8px', resize: 'vertical', color: 'black' }}
                                />
                                {/* Optimization Toggle */}
                                <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '0.9rem' }}>
                                        <input
                                            type="checkbox"
                                            checked={optimizeEnabled}
                                            onChange={(e) => setOptimizeEnabled(e.target.checked)}
                                        />
                                        ✨ Prompt最適化して送信
                                    </label>
                                </div>
                                {finalPromptPreview && (
                                    <div style={{ marginTop: '8px', padding: '8px', background: '#374151', borderRadius: '4px', fontSize: '0.8rem' }}>
                                        <details>
                                            <summary style={{ cursor: 'pointer', color: '#10b981' }}>送信される最終Prompt ▼</summary>
                                            <p style={{ marginTop: '4px', color: '#d1d5db', whiteSpace: 'pre-wrap' }}>{finalPromptPreview}</p>
                                        </details>
                                    </div>
                                )}
                            </div>
                            <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                    <label style={{ fontWeight: 'bold' }}>🚫 Negative Prompt</label>
                                    <button
                                        onClick={() => handleAutoPrompt('negative')}
                                        style={{ fontSize: '0.8rem', padding: '2px 8px', background: '#ef4444', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer' }}
                                    >
                                        ✨ Auto Negative
                                    </button>
                                </div>
                                <textarea
                                    value={negativePrompt}
                                    onChange={(e) => setNegativePrompt(e.target.value)}
                                    placeholder="除外したい要素 (例: blurry, low quality)"
                                    style={{ width: '100%', height: '60px', padding: '12px', borderRadius: '8px', resize: 'vertical', color: 'black' }}
                                />
                            </div>
                        </div>

                        {/* Generate Button */}
                        <button
                            onClick={handleGenerate}
                            disabled={isGenerating || !userPrompt.trim()}
                            style={{
                                padding: '16px 32px',
                                fontSize: '1.2rem',
                                fontWeight: 'bold',
                                background: isGenerating ? '#6b7280' : 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                                color: 'white',
                                border: 'none',
                                borderRadius: '12px',
                                cursor: isGenerating ? 'not-allowed' : 'pointer',
                                marginBottom: '24px'
                            }}
                        >
                            {isGenerating ? '⏳ 生成中...' : '🚀 Generate'}
                        </button>

                        {/* Progress Bar */}
                        {isGenerating && (
                            <div style={{ marginBottom: '24px' }}>
                                <div style={{ background: '#374151', borderRadius: '8px', height: '8px', overflow: 'hidden' }}>
                                    <div style={{ width: `${progress}%`, height: '100%', background: 'linear-gradient(90deg, #8b5cf6, #ec4899)', transition: 'width 0.3s' }} />
                                </div>
                            </div>
                        )}

                        {/* Generated Images */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '16px' }}>
                            {generatedImages.map((img, i) => (
                                <div key={i} style={{ background: 'var(--color-surface)', borderRadius: '12px', overflow: 'hidden' }}>
                                    <img
                                        src={img.base64 ? `data:image/png;base64,${img.base64}` : `file://${img.path.replace(/\\/g, '/')}`}
                                        alt={`Generated ${i + 1}`}
                                        style={{ width: '100%', display: 'block' }}
                                    />
                                    <div style={{ padding: '8px', textAlign: 'center', fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                                        <div style={{ marginBottom: '4px' }}>{new Date(img.timestamp).toLocaleTimeString()}</div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                                            <button onClick={() => handleUpscale(img.path)} style={{ background: '#8b5cf6', color: 'white', border: 'none', borderRadius: '4px', padding: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.8rem' }}>✨ 4x</button>
                                            <button onClick={() => handleSmooth(img.path)} style={{ background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', padding: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.8rem' }}>💧 Soft</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
            {showCompare && compareSelection.length > 0 && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.95)', zIndex: 9999, display: 'flex', flexDirection: 'column', padding: '32px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                        <h2 style={{ color: 'white', margin: 0 }}>⚖️ Image Comparison</h2>
                        <button onClick={() => setShowCompare(false)} style={{ background: '#ef4444', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: 'pointer', fontSize: '1rem', fontWeight: 'bold' }}>Close</button>
                    </div>
                    <div style={{ flex: 1, display: 'flex', gap: '24px', overflow: 'hidden' }}>
                        {compareSelection.map(path => {
                            const rec = history.find(r => r.imagePath === path);
                            if (!rec) return null;
                            return (
                                <div key={path} style={{ flex: 1, background: '#1f2937', borderRadius: '16px', overflow: 'hidden', display: 'flex', flexDirection: 'column', border: '1px solid #374151' }}>
                                    <div style={{ flex: 1, position: 'relative', background: '#000' }}>
                                        <img src={`file://${path.replace(/\\/g, '/')}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                                    </div>
                                    <div style={{ padding: '24px', color: '#e5e7eb', background: '#1f2937' }}>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: '0.9rem' }}>
                                            <div style={{ color: '#9ca3af' }}>Model</div><div style={{ fontWeight: 'bold' }}>{rec.modelId}</div>
                                            <div style={{ color: '#9ca3af' }}>Mode</div><div>{rec.mode}</div>
                                            <div style={{ color: '#9ca3af' }}>Upscale</div><div>{rec.upscale}x</div>
                                            <div style={{ color: '#9ca3af' }}>Cost</div><div style={{ color: '#10b981' }}>${Number(rec.cost).toFixed(3)}</div>
                                            <div style={{ color: '#9ca3af' }}>Time</div><div>{new Date(rec.timestamp).toLocaleString()}</div>
                                        </div>
                                        <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #374151' }}>
                                            <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: '4px' }}>PROMPT</div>
                                            <div style={{ fontSize: '0.85rem', maxHeight: '100px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{rec.prompt}</div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div >
    );
};


export default NanoStudioScreen;
