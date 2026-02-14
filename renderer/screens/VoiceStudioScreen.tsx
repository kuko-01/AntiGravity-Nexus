import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// Types
type TtsInstallState = 'not_installed' | 'installing' | 'installed' | 'corrupted' | 'upgrade_available';
type TtsRuntimeState = 'stopped' | 'starting' | 'running' | 'error' | 'restarting';

interface TtsModel {
    id: string;
    name: string;
    styles: string[];
    defaultStyle: string;
}

interface TtsPreset {
    id: string;
    name: string;
    modelId: string;
    style: string;
    speed: number;
    pitch: number;
    intonation: number;
    emotion?: string;
    // V2
    styleWeight?: number;
    sdpRatio?: number;
    noiseScale?: number;
    noiseScaleW?: number;
}

const VoiceStudioScreen: React.FC = () => {
    const navigate = useNavigate();

    // States
    const [status, setStatus] = useState<{ installState: TtsInstallState; runtimeState: TtsRuntimeState; port?: number }>({
        installState: 'not_installed',
        runtimeState: 'stopped'
    });
    const [models, setModels] = useState<TtsModel[]>([]);
    const [presets, setPresets] = useState<TtsPreset[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const [gpuInfo, setGpuInfo] = useState<any>(null);
    const [forceCpu, setForceCpu] = useState(false);

    // Synthesis Params
    const [text, setText] = useState('こんにちは、音声合成のテストです。');
    const [selectedModel, setSelectedModel] = useState<string>('');
    const [selectedStyle, setSelectedStyle] = useState<string>('');
    const [speed, setSpeed] = useState(1.0);
    const [pitch, setPitch] = useState(0.0);
    const [intonation, setIntonation] = useState(1.0);

    // V2 Params
    const [styleWeight, setStyleWeight] = useState(1.0);
    const [sdpRatio, setSdpRatio] = useState(0.2);
    const [noiseScale, setNoiseScale] = useState(0.6);
    const [noiseScaleW, setNoiseScaleW] = useState(0.8);
    const [assistText, setAssistText] = useState('');
    const [phonemeText, setPhonemeText] = useState('');

    const [isSynthesizing, setIsSynthesizing] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [isAutoPlay, setIsAutoPlay] = useState(false);

    // UI Toggles
    const [showBasicSettings, setShowBasicSettings] = useState(true);
    const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

    // Audio Post-Processing
    const [postFilter, setPostFilter] = useState(false);
    const [filterStrength, setFilterStrength] = useState(0.5);

    // Path Config
    const [pathsConfig, setPathsConfig] = useState<{ datasetRoot: string; assetsRoot: string } | null>(null);

    // Initial Load
    useEffect(() => {
        refreshStatus();
        loadPresets();
        loadPathsConfig();
        checkGpu();
        const interval = setInterval(refreshStatus, 5000);
        return () => clearInterval(interval);
    }, []);

    const loadPathsConfig = async () => {
        try {
            const config = await window.electronAPI.ttsGetPathsConfig();
            setPathsConfig(config);
        } catch (e) {
            console.error(e);
        }
    };

    const handleChangeModelDir = async () => {
        const path = await window.electronAPI.utilSelectDirectory();
        if (path && pathsConfig) {
            const newConfig = { ...pathsConfig, assetsRoot: path };
            addLog(`Changing model directory to: ${path}`);
            await window.electronAPI.ttsSetPathsConfig(newConfig);
            setPathsConfig(newConfig);

            if (status.runtimeState === 'running') {
                addLog('Restarting server to apply changes...');
                await window.electronAPI.ttsStopServer();
                // Wait a bit
                setTimeout(async () => {
                    await window.electronAPI.ttsStartServer({ forceCpu });
                    addLog('Server restarted with new models path.');
                }, 2000);
            } else {
                addLog('Model directory updated. Start server to use new models.');
            }

            // Reload models list after change
            setTimeout(loadModels, 3000);
        }
    };

    const checkGpu = async () => {
        try {
            const info = await window.electronAPI.ttsGetGpuInfo();
            setGpuInfo(info);
        } catch (e) {
            console.error('Failed to get GPU info:', e);
        }
    };

    const handleToggleForceCpu = async () => {
        const newValue = !forceCpu;
        setForceCpu(newValue);

        // Restart server with new setting if running
        if (status.runtimeState === 'running') {
            addLog(`Restarting server in ${newValue ? 'CPU' : 'Auto/GPU'} mode...`);
            await window.electronAPI.ttsStopServer();
            // Wait a bit
            await new Promise(r => setTimeout(r, 1000));
            await window.electronAPI.ttsStartServer({ forceCpu: newValue });
            addLog('Server restarted with new config.');
        } else {
            addLog(`Config changed. Next start will use ${newValue ? 'CPU' : 'Auto/GPU'} mode.`);
        }
    };

    // Load models when server is running
    useEffect(() => {
        if (status.runtimeState === 'running') {
            loadModels();
        }
    }, [status.runtimeState]);

    const addLog = (msg: string) => {
        setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50));
    };

    const refreshStatus = async () => {
        try {
            const s = await window.electronAPI.ttsGetStatus();
            setStatus(s);
        } catch (e) {
            console.error(e);
        }
    };

    const loadModels = async () => {
        try {
            const m = await window.electronAPI.ttsListModels();
            setModels(m);
            if (m.length > 0 && !selectedModel) {
                // Select first model by default
                setSelectedModel(m[0].id);
                setSelectedStyle(m[0].defaultStyle || m[0].styles[0]);
                // Notify backend
                await window.electronAPI.ttsSetModel(m[0].id);
            }
        } catch (e) {
            console.error(e);
            addLog(`Error loading models: ${e}`);
        }
    };

    const loadPresets = async () => {
        try {
            const p = await window.electronAPI.ttsGetPresets();
            setPresets(p);
        } catch (e) {
            console.error(e);
        }
    };

    // Actions
    const handleInstall = async () => {
        setIsLoading(true);
        addLog('Starting installation...');
        try {
            const res = await window.electronAPI.ttsInstall();
            if (res.success) {
                addLog('Installation successful!');
                refreshStatus();
            } else {
                addLog(`Installation failed: ${res.error?.message}`);
            }
        } catch (e) {
            addLog(`Error: ${e}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleStartServer = async () => {
        setIsLoading(true);
        addLog('Starting TTS Server...');
        try {
            const res = await window.electronAPI.ttsStartServer();
            if (res.success) {
                addLog('Server started!');
                refreshStatus();
            } else {
                addLog(`Start failed: ${res.error?.message}`);
            }
        } catch (e) {
            addLog(`Error: ${e}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleStopServer = async () => {
        setIsLoading(true);
        try {
            await window.electronAPI.ttsStopServer();
            addLog('Server stopped.');
            refreshStatus();
        } catch (e) {
            addLog(`Error: ${e}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleModelChange = async (modelId: string) => {
        setSelectedModel(modelId);
        const model = models.find(m => m.id === modelId);
        if (model) {
            setSelectedStyle(model.defaultStyle || model.styles[0]);
        }
        // Notify backend to switch model
        addLog(`Switching model to ${modelId}...`);
        try {
            await window.electronAPI.ttsSetModel(modelId);
            addLog('Model switched.');
        } catch (e) {
            addLog(`Model switch failed: ${e}`);
        }
    };

    const handleAnalyze = async () => {
        if (!text) return;
        setIsAnalyzing(true);
        addLog('Analyzing text...');
        try {
            const res = await window.electronAPI.ttsAnalyzeText(text);
            if (Array.isArray(res)) {
                setPhonemeText(res.join(' '));
                addLog('Text analyzed successfully.');
            } else if (res && 'error' in res) {
                addLog(`Analysis failed: ${res.error}`);
            } else {
                addLog('Analysis failed: Unknown response format');
            }
        } catch (e: any) {
            addLog(`Error: ${e.message}`);
        } finally {
            setIsAnalyzing(false);
        }
    };

    const handleSynthesize = async () => {
        addLog('Synthesize requested...');
        if (!selectedModel) {
            addLog('Error: No model selected. Please select a model first.');
            if (models.length === 0) {
                addLog('Warning: No models found. Please check logic/models directory.');
            }
            return;
        }
        setIsSynthesizing(true);
        setAudioUrl(null);

        try {
            const start = Date.now();
            const res = await window.electronAPI.ttsSynthesize({
                text: phonemeText || text, // Use phonemes if corrected/available? Or assume backend handles logic?
                // Usually if we send phonemes, we might need to tell backend it's phonemes or update backend to detect.
                // However, user requirement said "User can edit phonemes".
                // If user edits phonemes, we should probably send that.
                // But generally SBV2 takes raw text. 
                // If we want to support direct phoneme input, we might need to support it in backend.
                // User spec: "Synthesize button ... text input OR phoneme input".
                // Let's assume for now we send 'text' parameter. 
                // But wait, if backend implementation of `voice` expects text, and we send phonemes...
                // Standard SBV2 `voice` endpoint expects raw text and does G2P internally.
                // If we want to use pre-calculated phonemes, we usually need a different way or specific markup.
                // However, for this task, let's Stick to checking if phonemeText is modified?
                // Actually, let's just send `text` for now unless we implement "Phoneme Mode".
                // Re-reading spec: "Input text... convert to intermediate text... User can edit...".
                // If user edits intermediate text, we MUST send that to synthesize.
                // Does SBV2 support direct phoneme input?
                // Looking at `server_fastapi.py`, `voice` endpoint takes `text`.
                // If `text` is phonemes, does it work? 
                // Usually G2P is idempotent-ish or we need to mark it.
                // BUT, simply passing `phonemeText` if available might be risky if G2P tries to re-convert katakana to phonemes.
                // Let's stick to `text` for now to be safe, OR if user explicitly wants to use the phoneme box.
                // Let's assume we pass `text` from the main input, and `assistText` as guide.
                // IMPLEMENTATION DECISION: We will send `text` property as `phonemeText` IF `phonemeText` is present/edited.
                // But to be safe, I will just send `text` variable from the main input for now, 
                // and if the user wants to use the phoneme result, they should probably copy it back to text input?
                // OR, simpler: We send `text` param. If user edited Phoneme box, we use THAT as `text`.
                // Let's do: `const textToSend = phonemeText || text;` -> This assumes phonemeText is fully valid for synthesis.
                // SBV2's `infer` method usually takes raw text. If it takes Katakana, it generally works fine for JP.
                // So, let's use `phonemeText` if it's not empty, otherwise `text`.



                modelId: selectedModel,
                style: selectedStyle,
                speed,
                pitch,
                intonation,
                // V2
                styleWeight,
                sdpRatio,
                noiseScale,
                noiseScaleW,
                assistText,
                // Audio Enhancement
                postFilter,
                filterStrength,
            });
            const elapsed = Date.now() - start;

            if (res.success && res.wavPath) {
                addLog(`Synthesized in ${elapsed}ms`);

                if (res.audioBase64) {
                    addLog(`Audio received directly (${res.audioBase64.length} chars)`);
                    try {
                        const url = `data:audio/wav;base64,${res.audioBase64}`;
                        setAudioUrl(url);
                    } catch (err) {
                        addLog(`Error setting audio URL: ${err}`);
                    }
                } else {
                    addLog(`Reading audio file: ${res.wavPath}`);
                    const audioData = await window.electronAPI.readAudioFile(res.wavPath!);
                    if (audioData.success && audioData.base64) {
                        const url = `data:audio/wav;base64,${audioData.base64}`;
                        setAudioUrl(url);
                    } else {
                        addLog(`Failed to read audio file: ${audioData.error}`);
                    }
                }
            } else {
                addLog(`Synthesis failed: ${res.error?.message}`);
            }
        } catch (e: any) {
            addLog(`Error: ${e.message}`);
        } finally {
            setIsSynthesizing(false);
        }
    };

    const handleSavePreset = async () => {
        const name = prompt('Preset Name:', 'My Preset');
        if (!name) return;

        try {
            await window.electronAPI.ttsSavePreset({
                name,
                modelId: selectedModel,
                style: selectedStyle,
                speed,
                pitch,
                intonation,
                // V2
                styleWeight,
                sdpRatio,
                noiseScale,
                noiseScaleW,
            });
            loadPresets();
            addLog(`Preset "${name}" saved.`);
        } catch (e) {
            addLog(`Failed to save preset: ${e}`);
        }
    };

    const handleLoadPreset = (preset: TtsPreset) => {
        setSelectedModel(preset.modelId);
        setSelectedStyle(preset.style);
        setSpeed(preset.speed);
        setPitch(preset.pitch);
        setIntonation(preset.intonation);

        // V2
        if (preset.styleWeight !== undefined) setStyleWeight(preset.styleWeight);
        if (preset.sdpRatio !== undefined) setSdpRatio(preset.sdpRatio);
        if (preset.noiseScale !== undefined) setNoiseScale(preset.noiseScale);
        if (preset.noiseScaleW !== undefined) setNoiseScaleW(preset.noiseScaleW);

        // Ensure backend model is switched too if needed
        if (selectedModel !== preset.modelId) {
            handleModelChange(preset.modelId);
        }
        addLog(`Loaded preset "${preset.name}"`);
    };

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column', // flex-col
            height: '100vh',
            padding: '24px',
            backgroundColor: 'var(--color-bg-secondary)', // bg-neutral-900
            color: 'var(--color-text)', // text-white
            fontFamily: 'Inter, sans-serif'
        }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <button onClick={() => navigate('/')} style={btnStyle('secondary')}>
                        ← Back
                    </button>
                    <h1 style={{ fontSize: '24px', fontWeight: 'bold' }}>Voice Studio</h1>
                    {/* Status Badge */}
                    <div style={{
                        padding: '4px 12px',
                        borderRadius: '999px',
                        fontSize: '12px',
                        backgroundColor: status.runtimeState === 'running' ? '#10b981' : '#ef4444',
                        color: 'white'
                    }}>
                        {status.runtimeState.toUpperCase()}
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                    {status.installState === 'not_installed' && (
                        <button onClick={handleInstall} disabled={isLoading} style={btnStyle('primary')}>
                            {isLoading ? 'Installing...' : 'Install Engine'}
                        </button>
                    )}

                    {(status.installState === 'installed' && status.runtimeState !== 'running') && (
                        <button onClick={handleStartServer} disabled={isLoading} style={btnStyle('primary')}>
                            {isLoading ? 'Starting...' : 'Start Server'}
                        </button>
                    )}

                    {status.runtimeState === 'running' && (
                        <button onClick={handleStopServer} disabled={isLoading} style={btnStyle('danger')}>
                            Stop Server
                        </button>
                    )}
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '24px', flex: 1, minHeight: 0 }}>
                {/* Sidebar: Controls */}
                <div style={cardStyle}>
                    <h2 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '16px' }}>Controls</h2>

                    <div style={fieldGroupStyle}>
                        <label style={labelStyle}>Model</label>
                        <select
                            value={selectedModel}
                            onChange={(e) => handleModelChange(e.target.value)}
                            style={inputStyle}
                            disabled={status.runtimeState !== 'running'}
                        >
                            {models.map(m => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                    </div>

                    <div style={fieldGroupStyle}>
                        <label style={labelStyle}>Style</label>
                        <select
                            value={selectedStyle}
                            onChange={(e) => setSelectedStyle(e.target.value)}
                            style={inputStyle}
                            disabled={status.runtimeState !== 'running'}
                        >
                            {models.find(m => m.id === selectedModel)?.styles.map(s => (
                                <option key={s} value={s}>{s}</option>
                            ))}
                        </select>
                    </div>

                    {/* Basic Settings */}
                    <div style={{ marginBottom: '16px' }}>
                        <button
                            onClick={() => setShowBasicSettings(!showBasicSettings)}
                            style={{
                                background: 'none', border: 'none', color: '#d1d5db',
                                cursor: 'pointer', display: 'flex', alignItems: 'center',
                                fontSize: '14px', fontWeight: '600', marginBottom: '8px'
                            }}
                        >
                            {showBasicSettings ? '▼' : '▶'} Basic Settings
                        </button>

                        {showBasicSettings && (
                            <>
                                <div style={fieldGroupStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <label style={labelStyle}>Speed</label>
                                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>{speed.toFixed(1)}</span>
                                    </div>
                                    <input
                                        type="range" min="0.5" max="2.0" step="0.1"
                                        value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))}
                                        style={{ width: '100%' }}
                                    />
                                </div>

                                <div style={fieldGroupStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <label style={labelStyle}>Pitch</label>
                                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>{pitch.toFixed(1)}</span>
                                    </div>
                                    <input
                                        type="range" min="-12" max="12" step="0.5"
                                        value={pitch} onChange={(e) => setPitch(parseFloat(e.target.value))}
                                        style={{ width: '100%' }}
                                    />
                                </div>

                                <div style={fieldGroupStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <label style={labelStyle}>Intonation</label>
                                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>{intonation.toFixed(1)}</span>
                                    </div>
                                    <input
                                        type="range" min="0.0" max="2.0" step="0.1"
                                        value={intonation} onChange={(e) => setIntonation(parseFloat(e.target.value))}
                                        style={{ width: '100%' }}
                                    />
                                </div>
                            </>
                        )}
                    </div>

                    {/* Advanced Settings */}
                    <div style={{ marginBottom: '16px' }}>
                        <button
                            onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
                            style={{
                                background: 'none', border: 'none', color: '#d1d5db',
                                cursor: 'pointer', display: 'flex', alignItems: 'center',
                                fontSize: '14px', fontWeight: '600', marginBottom: '8px'
                            }}
                        >
                            {showAdvancedSettings ? '▼' : '▶'} Advanced Settings
                        </button>

                        {showAdvancedSettings && (
                            <>
                                <div style={fieldGroupStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <label style={labelStyle}>Style Weight</label>
                                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>{styleWeight.toFixed(1)}</span>
                                    </div>
                                    <input
                                        type="range" min="0.1" max="10.0" step="0.1"
                                        value={styleWeight} onChange={(e) => setStyleWeight(parseFloat(e.target.value))}
                                        style={{ width: '100%' }}
                                    />
                                </div>

                                <div style={fieldGroupStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <label style={labelStyle}>Rhythm / Fluctuation (SDP)</label>
                                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>{sdpRatio.toFixed(2)}</span>
                                    </div>
                                    <input
                                        type="range" min="0.0" max="1.0" step="0.05"
                                        value={sdpRatio} onChange={(e) => setSdpRatio(parseFloat(e.target.value))}
                                        style={{ width: '100%' }}
                                    />
                                </div>

                                <div style={fieldGroupStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <label style={labelStyle}>Breathiness (Noise)</label>
                                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>{noiseScale.toFixed(2)}</span>
                                    </div>
                                    <input
                                        type="range" min="0.1" max="1.0" step="0.05"
                                        value={noiseScale} onChange={(e) => setNoiseScale(parseFloat(e.target.value))}
                                        style={{ width: '100%' }}
                                    />
                                </div>

                                <div style={fieldGroupStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <label style={labelStyle}>Phoneme Length (Noise W)</label>
                                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>{noiseScaleW.toFixed(2)}</span>
                                    </div>
                                    <input
                                        type="range" min="0.1" max="1.0" step="0.05"
                                        value={noiseScaleW} onChange={(e) => setNoiseScaleW(parseFloat(e.target.value))}
                                        style={{ width: '100%' }}
                                    />
                                </div>
                            </>
                        )}
                    </div>

                    {/* Audio Post-Processing Section */}
                    <div style={{
                        marginTop: '16px',
                        background: 'rgba(59, 130, 246, 0.1)',
                        borderRadius: '12px',
                        padding: '16px',
                        border: '1px solid rgba(59, 130, 246, 0.3)'
                    }}>
                        <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: postFilter ? '16px' : '0'
                        }}>
                            <div>
                                <span style={{ fontSize: '14px', fontWeight: '600', color: '#e2e8f0' }}>
                                    ✨ Auto-Enhance
                                </span>
                                <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>
                                    DeepFilterNet + Normalization
                                </div>
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={postFilter}
                                    onChange={(e) => setPostFilter(e.target.checked)}
                                    style={{ marginRight: '8px' }}
                                />
                                <span style={{ fontSize: '12px', color: postFilter ? '#60a5fa' : '#6b7280' }}>
                                    {postFilter ? 'ON' : 'OFF'}
                                </span>
                            </label>
                        </div>

                        {postFilter && (
                            <div style={fieldGroupStyle}>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <label style={labelStyle}>
                                        Denoise Strength
                                        <span style={{
                                            fontSize: '10px',
                                            color: '#f59e0b',
                                            marginLeft: '8px',
                                            cursor: 'help'
                                        }} title="Low (0.3) for Whisper/Breathy voices. High (0.8) for clear speech.">
                                            ⓘ
                                        </span>
                                    </label>
                                    <span style={{ fontSize: '12px', color: '#9ca3af' }}>{filterStrength.toFixed(2)}</span>
                                </div>
                                <input
                                    type="range" min="0.1" max="1.0" step="0.05"
                                    value={filterStrength} onChange={(e) => setFilterStrength(parseFloat(e.target.value))}
                                    style={{ width: '100%' }}
                                />
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#6b7280' }}>
                                    <span>Whisper (0.3)</span>
                                    <span>Clear (0.8)</span>
                                </div>
                            </div>
                        )}
                    </div>

                    <div style={{ marginTop: 'auto', paddingTop: '24px' }}>
                        <h3 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '8px' }}>Presets</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto' }}>
                            {presets.map(p => (
                                <button key={p.id} onClick={() => handleLoadPreset(p)} style={presetBtnStyle}>
                                    {p.name}
                                </button>
                            ))}
                            <button onClick={handleSavePreset} style={{ ...btnStyle('secondary'), marginTop: '8px', fontSize: '12px' }}>
                                + Save Current Settings
                            </button>
                        </div>

                        <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #4b5563' }}>
                            <div style={labelStyle}>Environment Info</div>
                            <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '8px' }}>
                                Device: {gpuInfo?.currentDevice || 'Unknown'} <br />
                                PyTorch: {gpuInfo?.torchVersion || '-'} <br />
                                CUDA: {gpuInfo?.cudaAvailable ? `Yes (${gpuInfo.cudaVersion})` : 'No'}
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', marginTop: '8px' }}>
                                <input
                                    type="checkbox"
                                    id="forceCpu"
                                    checked={forceCpu}
                                    onChange={handleToggleForceCpu}
                                    style={{ marginRight: '8px' }}
                                />
                                <label htmlFor="forceCpu" style={{ fontSize: '13px', color: 'white', cursor: 'pointer' }}>
                                    Force CPU Mode
                                </label>
                            </div>

                            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #4b5563' }}>
                                <div style={labelStyle}>Model Directory</div>
                                <div style={{ fontSize: '11px', color: '#9ca3af', wordBreak: 'break-all', marginBottom: '6px' }}>
                                    {pathsConfig?.assetsRoot ? (
                                        pathsConfig.assetsRoot.length > 40
                                            ? '...' + pathsConfig.assetsRoot.slice(-40)
                                            : pathsConfig.assetsRoot
                                    ) : 'Loading...'}
                                </div>
                                <button
                                    onClick={handleChangeModelDir}
                                    style={{ ...btnStyle('secondary'), fontSize: '11px', width: '100%', padding: '6px' }}
                                    title={pathsConfig?.assetsRoot}
                                >
                                    Choose Folder...
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Main: Preview & Logs */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

                    {/* Synthesis Area */}
                    <div style={{ ...cardStyle, flex: 2, display: 'flex', flexDirection: 'column' }}>
                        <h3 style={{ marginTop: 0, marginBottom: '8px', fontSize: '14px', color: '#9ca3af' }}>Text to Synthesize</h3>
                        <textarea
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder="Enter text here..."
                            style={{
                                height: '100px',
                                minHeight: '80px',
                                backgroundColor: '#111827',
                                color: '#f3f4f6',
                                border: '1px solid #374151',
                                borderRadius: '6px',
                                padding: '12px',
                                fontSize: '16px',
                                resize: 'vertical',
                                marginBottom: '12px',
                                fontFamily: '"Yu Gothic", sans-serif'
                            }}
                        />

                        {/* Assist Text */}
                        <div style={{ marginBottom: '12px' }}>
                            <label style={{ ...labelStyle, marginBottom: '4px' }}>Assist Text (Emotion/Tone Guide)</label>
                            <input
                                type="text"
                                style={{
                                    width: '100%',
                                    backgroundColor: '#1f2937',
                                    color: '#f3f4f6',
                                    border: '1px solid #374151',
                                    borderRadius: '6px',
                                    padding: '8px',
                                    fontSize: '14px'
                                }}
                                placeholder="Example: 悲しそうに, 怒ったように..."
                                value={assistText}
                                onChange={(e) => setAssistText(e.target.value)}
                            />
                        </div>

                        {/* Analyze & Phoneme Display */}
                        <div style={{ marginBottom: '16px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                <label style={labelStyle}>Phoneme / Intermediate Text</label>
                                <button
                                    onClick={handleAnalyze}
                                    disabled={isAnalyzing || !text}
                                    style={{
                                        backgroundColor: (isAnalyzing || !text) ? '#4b5563' : '#374151',
                                        color: '#f3f4f6',
                                        border: 'none',
                                        borderRadius: '4px',
                                        padding: '4px 8px',
                                        cursor: (isAnalyzing || !text) ? 'not-allowed' : 'pointer',
                                        fontSize: '12px'
                                    }}
                                >
                                    {isAnalyzing ? '...' : 'Analyze'}
                                </button>
                            </div>
                            <textarea
                                style={{
                                    width: '100%',
                                    height: '60px',
                                    backgroundColor: '#000000',
                                    color: '#10b981', // Terminal green
                                    border: '1px solid #374151',
                                    borderRadius: '6px',
                                    padding: '8px',
                                    fontSize: '14px',
                                    fontFamily: 'monospace',
                                    resize: 'vertical'
                                }}
                                placeholder="Analysis result will appear here..."
                                value={phonemeText}
                                onChange={(e) => setPhonemeText(e.target.value)}
                            />
                        </div>


                        {/* Assist Text & Analysis */}
                        <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
                            <input
                                type="text"
                                value={assistText}
                                onChange={(e) => setAssistText(e.target.value)}
                                placeholder="Assist Text (e.g. 'Excitedly', 'Sadness')"
                                style={{ ...inputStyle, flex: 1 }}
                            />
                            <button
                                onClick={handleAnalyze}
                                disabled={isAnalyzing || !text || status.runtimeState !== 'running'}
                                style={btnStyle('secondary')}
                            >
                                {isAnalyzing ? '...' : 'Analyze'}
                            </button>
                        </div>

                        {/* Phoneme/Intermediate text input (Visible if populated) */}
                        {phonemeText && (
                            <div style={{ marginBottom: '16px' }}>
                                <label style={{ ...labelStyle, fontSize: '12px' }}>Phoneme / Intermediate Text (Editable)</label>
                                <textarea
                                    value={phonemeText}
                                    onChange={(e) => setPhonemeText(e.target.value)}
                                    style={{
                                        width: '100%',
                                        height: '60px',
                                        backgroundColor: '#1f2937',
                                        color: '#e5e7eb',
                                        border: '1px solid #4b5563',
                                        borderRadius: '6px',
                                        padding: '8px',
                                        fontSize: '14px',
                                        fontFamily: 'monospace',
                                        resize: 'vertical'
                                    }}
                                />
                            </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            {audioUrl ? (
                                <audio
                                    key={audioUrl}
                                    controls
                                    src={audioUrl}
                                    autoPlay={isAutoPlay}
                                    onError={(e) => {
                                        const target = e.target as HTMLAudioElement;
                                        addLog(`Audio Playback Error: ${target.error?.message || 'Unknown'} (Code: ${target.error?.code})`);
                                    }}
                                    style={{ flex: 1, marginRight: '16px' }}
                                />
                            ) : (
                                <div style={{ flex: 1 }}></div>
                            )}

                            <div style={{ display: 'flex', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', marginRight: '16px' }}>
                                    <input
                                        type="checkbox"
                                        id="autoPlayCheck"
                                        checked={isAutoPlay}
                                        onChange={(e) => setIsAutoPlay(e.target.checked)}
                                        style={{ accentColor: '#4f46e5', cursor: 'pointer' }}
                                    />
                                    <label htmlFor="autoPlayCheck" style={{ marginLeft: '6px', fontSize: '13px', color: '#d1d5db', cursor: 'pointer' }}>
                                        Auto Play
                                    </label>
                                </div>

                                <button
                                    onClick={handleSynthesize}
                                    disabled={isSynthesizing || status.runtimeState !== 'running'}
                                    style={{ ...btnStyle('primary'), padding: '12px 32px', fontSize: '16px' }}
                                >
                                    {isSynthesizing ? 'Generating...' : 'Synthesize'}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Logs */}
                    <div style={{ ...cardStyle, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                            <h3 style={{ fontSize: '14px', fontWeight: 'bold' }}>Logs</h3>
                            <button onClick={() => setLogs([])} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer' }}>Clear</button>
                        </div>
                        <div style={{
                            flex: 1,
                            overflowY: 'auto',
                            fontFamily: 'monospace',
                            fontSize: '12px',
                            color: '#d1d5db',
                            backgroundColor: '#111827',
                            padding: '12px',
                            borderRadius: '4px'
                        }}>
                            {logs.map((log, i) => (
                                <div key={i} style={{ marginBottom: '4px' }}>{log}</div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// Styles
const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-surface)',
    borderRadius: '16px',
    padding: '24px',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
    border: '1px solid var(--color-border)',
};

const fieldGroupStyle: React.CSSProperties = {
    marginBottom: '16px'
};

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '14px',
    fontWeight: '500',
    marginBottom: '4px',
    color: '#d1d5db'
};

const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: '6px',
    border: '1px solid #4b5563',
    backgroundColor: '#374151',
    color: 'white',
    fontSize: '14px'
};

const presetBtnStyle: React.CSSProperties = {
    width: '100%',
    textAlign: 'left',
    padding: '8px 12px',
    borderRadius: '6px',
    backgroundColor: '#374151',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    transition: 'background 0.2s',
};

const btnStyle = (variant: 'primary' | 'secondary' | 'danger') => {
    const base: React.CSSProperties = {
        padding: '8px 16px',
        borderRadius: '8px',
        border: 'none',
        cursor: 'pointer',
        fontWeight: '600',
        transition: 'all 0.2s',
    };

    switch (variant) {
        case 'primary':
            return { ...base, backgroundColor: '#4f46e5', color: 'white' }; // Indigo-600
        case 'secondary':
            return { ...base, backgroundColor: '#374151', color: 'white' }; // Gray-700
        case 'danger':
            return { ...base, backgroundColor: '#ef4444', color: 'white' }; // Red-500
    }
};

export default VoiceStudioScreen;
