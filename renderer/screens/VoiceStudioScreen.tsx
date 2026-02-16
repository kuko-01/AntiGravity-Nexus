import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

type StudioMode = 'sbv2' | 'rvc' | 'sbv2+rvc';
type TtsInstallState = 'not_installed' | 'installing' | 'installed' | 'corrupted' | 'upgrade_available';
type TtsRuntimeState = 'stopped' | 'starting' | 'running' | 'error' | 'restarting';
type RvcF0Method = 'rmvpe' | 'harvest' | 'crepe';

interface TtsStatus {
    installState: TtsInstallState;
    runtimeState: TtsRuntimeState;
    port?: number;
}

interface RvcStatus {
    installState: TtsInstallState;
    runtimeState: TtsRuntimeState;
    port?: number;
}

interface TtsModel {
    id: string;
    name: string;
    styles: string[];
    defaultStyle: string;
}

interface RvcModel {
    id: string;
    name: string;
    path: string;
    hasIndex: boolean;
}

interface TtsPreset {
    id: string;
    name: string;
    modelId: string;
    style: string;
    speed: number;
    pitch: number;
    intonation: number;
    styleWeight?: number;
    sdpRatio?: number;
    noiseScale?: number;
    noiseScaleW?: number;
}

interface RvcPreset {
    id: string;
    name: string;
    modelId: string;
    f0Method: RvcF0Method;
    transpose: number;
    indexRate: number;
    protect: number;
    filterRadius: number;
    rmsMixRate: number;
    resampleSr: number;
}

const VoiceStudioScreen: React.FC = () => {
    const navigate = useNavigate();

    const [mode, setMode] = useState<StudioMode>('sbv2');
    const [isLoading, setIsLoading] = useState(false);
    const [isRunningAction, setIsRunningAction] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const [useCpuMode, setUseCpuMode] = useState(false); // default: GPU/Auto

    // SBV2
    const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ installState: 'not_installed', runtimeState: 'stopped' });
    const [ttsModels, setTtsModels] = useState<TtsModel[]>([]);
    const [ttsPresets, setTtsPresets] = useState<TtsPreset[]>([]);
    const [selectedTtsModel, setSelectedTtsModel] = useState('');
    const [selectedStyle, setSelectedStyle] = useState('');
    const [text, setText] = useState('こんにちは、音声合成のテストです。');
    const [assistText, setAssistText] = useState('');
    const [speed, setSpeed] = useState(1.0);
    const [pitch, setPitch] = useState(0.0);
    const [intonation, setIntonation] = useState(1.0);
    const [styleWeight, setStyleWeight] = useState(1.0);
    const [sdpRatio, setSdpRatio] = useState(0.2);
    const [noiseScale, setNoiseScale] = useState(0.6);
    const [noiseScaleW, setNoiseScaleW] = useState(0.8);

    // RVC
    const [rvcStatus, setRvcStatus] = useState<RvcStatus>({ installState: 'not_installed', runtimeState: 'stopped' });
    const [rvcModels, setRvcModels] = useState<RvcModel[]>([]);
    const [rvcPresets, setRvcPresets] = useState<RvcPreset[]>([]);
    const [selectedRvcModel, setSelectedRvcModel] = useState('');
    const [rvcInputPath, setRvcInputPath] = useState('');
    const [rvcF0Method, setRvcF0Method] = useState<RvcF0Method>('rmvpe');
    const [rvcTranspose, setRvcTranspose] = useState(0);
    const [rvcIndexRate, setRvcIndexRate] = useState(0.75);
    const [rvcProtect, setRvcProtect] = useState(0.33);
    const [rvcFilterRadius, setRvcFilterRadius] = useState(3);
    const [rvcRmsMixRate, setRvcRmsMixRate] = useState(0.25);
    const [rvcResampleSr, setRvcResampleSr] = useState(0);

    // Output
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [intermediateAudioUrl, setIntermediateAudioUrl] = useState<string | null>(null);
    const [lastSbv2WavPath, setLastSbv2WavPath] = useState<string | null>(null);

    const activeStatus = useMemo(() => {
        if (mode === 'rvc') return rvcStatus;
        if (mode === 'sbv2+rvc') {
            if (ttsStatus.runtimeState === 'running' && rvcStatus.runtimeState === 'running') {
                return { installState: 'installed', runtimeState: 'running' };
            }
            return { installState: 'installed', runtimeState: 'stopped' };
        }
        return ttsStatus;
    }, [mode, ttsStatus, rvcStatus]);

    const addLog = (message: string) => {
        setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev].slice(0, 80));
    };

    const refreshStatus = async () => {
        try {
            const [tts, rvc] = await Promise.all([
                window.electronAPI.ttsGetStatus(),
                window.electronAPI.rvcGetStatus(),
            ]);
            setTtsStatus(tts);
            setRvcStatus(rvc);
        } catch (error) {
            addLog(`Status refresh failed: ${String(error)}`);
        }
    };

    const loadTtsModels = async () => {
        try {
            const models = await window.electronAPI.ttsListModels();
            setTtsModels(models);
            if (models.length > 0 && !selectedTtsModel) {
                setSelectedTtsModel(models[0].id);
                setSelectedStyle(models[0].defaultStyle || models[0].styles[0] || 'Neutral');
                await window.electronAPI.ttsSetModel(models[0].id);
            }
        } catch (error) {
            addLog(`SBV2 model load failed: ${String(error)}`);
        }
    };

    const loadRvcModels = async () => {
        try {
            const models = await window.electronAPI.rvcListModels();
            setRvcModels(models);
            if (models.length > 0 && !selectedRvcModel) {
                setSelectedRvcModel(models[0].id);
                await window.electronAPI.rvcSetModel(models[0].id);
            }
        } catch (error) {
            addLog(`RVC model load failed: ${String(error)}`);
        }
    };

    const loadPresets = async () => {
        try {
            const [tts, rvc] = await Promise.all([
                window.electronAPI.ttsGetPresets(),
                window.electronAPI.rvcGetPresets(),
            ]);
            setTtsPresets(tts);
            setRvcPresets(rvc);
        } catch {
            // non-fatal
        }
    };

    useEffect(() => {
        refreshStatus();
        loadPresets();
        const timer = setInterval(refreshStatus, 5000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (ttsStatus.runtimeState === 'running') {
            loadTtsModels();
        }
    }, [ttsStatus.runtimeState]);

    useEffect(() => {
        if (rvcStatus.runtimeState === 'running') {
            loadRvcModels();
        }
    }, [rvcStatus.runtimeState]);

    const handleInstallTts = async () => {
        setIsLoading(true);
        addLog('Installing SBV2...');
        const res = await window.electronAPI.ttsInstall();
        addLog(res.success ? 'SBV2 installed.' : `SBV2 install failed: ${res.error?.message || 'Unknown error'}`);
        await refreshStatus();
        setIsLoading(false);
    };

    const handleStartTts = async () => {
        setIsLoading(true);
        addLog(`Starting SBV2 server (${useCpuMode ? 'CPU' : 'GPU/Auto'})...`);
        const res = await window.electronAPI.ttsStartServer({ forceCpu: useCpuMode });
        addLog(res.success ? 'SBV2 server started.' : `SBV2 start failed: ${res.error?.message || 'Unknown error'}`);
        await refreshStatus();
        setIsLoading(false);
    };

    const handleStopTts = async () => {
        setIsLoading(true);
        await window.electronAPI.ttsStopServer();
        addLog('SBV2 server stopped.');
        await refreshStatus();
        setIsLoading(false);
    };

    const handleInstallRvc = async () => {
        setIsLoading(true);
        addLog('Installing RVC...');
        const res = await window.electronAPI.rvcInstall();
        addLog(res.success ? 'RVC installed.' : `RVC install failed: ${res.error?.message || 'Unknown error'}`);
        await refreshStatus();
        setIsLoading(false);
    };

    const handleStartRvc = async () => {
        setIsLoading(true);
        addLog(`Starting RVC server (${useCpuMode ? 'CPU' : 'GPU/Auto'})...`);
        const res = await window.electronAPI.rvcStartServer({ forceCpu: useCpuMode });
        addLog(res.success ? 'RVC server started.' : `RVC start failed: ${res.error?.message || 'Unknown error'}`);
        await refreshStatus();
        setIsLoading(false);
    };

    const handleStopRvc = async () => {
        setIsLoading(true);
        await window.electronAPI.rvcStopServer();
        addLog('RVC server stopped.');
        await refreshStatus();
        setIsLoading(false);
    };

    const handlePickRvcInput = async () => {
        const selected = await window.electronAPI.selectFile(['wav'], false);
        if (selected.success && selected.path) {
            setRvcInputPath(selected.path);
            addLog(`RVC input: ${selected.path}`);
        }
    };

    const handleToggleComputeMode = async () => {
        const nextUseCpu = !useCpuMode;
        setUseCpuMode(nextUseCpu);
        addLog(`Compute mode changed: ${nextUseCpu ? 'CPU' : 'GPU/Auto'} (default is GPU/Auto).`);

        const ttsRunning = ttsStatus.runtimeState === 'running';
        const rvcRunning = rvcStatus.runtimeState === 'running';
        if (!ttsRunning && !rvcRunning) {
            addLog('Mode will apply on next server start.');
            return;
        }

        setIsLoading(true);
        try {
            if (ttsRunning) {
                addLog('Restarting SBV2 server to apply compute mode...');
                await window.electronAPI.ttsStopServer();
                await window.electronAPI.ttsStartServer({ forceCpu: nextUseCpu });
            }
            if (rvcRunning) {
                addLog('Restarting RVC server to apply compute mode...');
                await window.electronAPI.rvcStopServer();
                await window.electronAPI.rvcStartServer({ forceCpu: nextUseCpu });
            }
            addLog('Compute mode applied.');
        } catch (error) {
            addLog(`Failed to apply compute mode: ${String(error)}`);
        } finally {
            await refreshStatus();
            setIsLoading(false);
        }
    };

    const applyTtsPreset = async (preset: TtsPreset) => {
        setSelectedTtsModel(preset.modelId);
        setSelectedStyle(preset.style);
        setSpeed(preset.speed);
        setPitch(preset.pitch);
        setIntonation(preset.intonation);
        setStyleWeight(preset.styleWeight ?? 1.0);
        setSdpRatio(preset.sdpRatio ?? 0.2);
        setNoiseScale(preset.noiseScale ?? 0.6);
        setNoiseScaleW(preset.noiseScaleW ?? 0.8);
        await window.electronAPI.ttsSetModel(preset.modelId);
        addLog(`SBV2 preset loaded: ${preset.name}`);
    };

    const applyRvcPreset = async (preset: RvcPreset) => {
        setSelectedRvcModel(preset.modelId);
        setRvcF0Method(preset.f0Method);
        setRvcTranspose(preset.transpose);
        setRvcIndexRate(preset.indexRate);
        setRvcProtect(preset.protect);
        setRvcFilterRadius(preset.filterRadius);
        setRvcRmsMixRate(preset.rmsMixRate);
        setRvcResampleSr(preset.resampleSr);
        await window.electronAPI.rvcSetModel(preset.modelId);
        addLog(`RVC preset loaded: ${preset.name}`);
    };

    const readAudioAsDataUrl = async (wavPath: string | undefined): Promise<string | null> => {
        if (!wavPath) return null;
        const audioData = await window.electronAPI.readAudioFile(wavPath);
        if (!audioData.success || !audioData.base64) {
            return null;
        }
        return `data:audio/wav;base64,${audioData.base64}`;
    };

    const handleSynthesize = async () => {
        setIsRunningAction(true);
        setAudioUrl(null);
        setIntermediateAudioUrl(null);

        try {
            if (mode === 'sbv2') {
                const res = await window.electronAPI.ttsSynthesize({
                    text,
                    modelId: selectedTtsModel,
                    style: selectedStyle,
                    speed,
                    pitch,
                    intonation,
                    styleWeight,
                    sdpRatio,
                    noiseScale,
                    noiseScaleW,
                    assistText,
                });

                if (!res.success) {
                    addLog(`SBV2 synthesis failed: ${res.error?.message || 'Unknown error'}`);
                    return;
                }

                setLastSbv2WavPath(res.wavPath || null);
                if (res.audioBase64) {
                    setAudioUrl(`data:audio/wav;base64,${res.audioBase64}`);
                } else {
                    setAudioUrl(await readAudioAsDataUrl(res.wavPath));
                }
                addLog('SBV2 synthesis complete.');
                return;
            }

            if (mode === 'rvc') {
                const inputPath = rvcInputPath || lastSbv2WavPath || undefined;
                if (!inputPath) {
                    addLog('RVC input WAV を選択してください。');
                    return;
                }

                const res = await window.electronAPI.rvcConvert({
                    inputPath,
                    modelId: selectedRvcModel,
                    f0Method: rvcF0Method,
                    transpose: rvcTranspose,
                    indexRate: rvcIndexRate,
                    protect: rvcProtect,
                    filterRadius: rvcFilterRadius,
                    rmsMixRate: rvcRmsMixRate,
                    resampleSr: rvcResampleSr,
                });

                if (!res.success) {
                    addLog(`RVC convert failed: ${res.error?.message || 'Unknown error'}`);
                    return;
                }

                if (res.audioBase64) {
                    setAudioUrl(`data:audio/wav;base64,${res.audioBase64}`);
                } else {
                    setAudioUrl(await readAudioAsDataUrl(res.wavPath));
                }
                addLog('RVC conversion complete.');
                return;
            }

            const pipelineRes = await window.electronAPI.voiceSynthesize({
                text,
                mode: 'sbv2+rvc',
                sbv2: {
                    modelId: selectedTtsModel,
                    style: selectedStyle,
                    speed,
                    pitch,
                    intonation,
                    styleWeight,
                    sdpRatio,
                    noiseScale,
                    noiseScaleW,
                    assistText,
                },
                rvc: {
                    modelId: selectedRvcModel,
                    f0Method: rvcF0Method,
                    transpose: rvcTranspose,
                    indexRate: rvcIndexRate,
                    protect: rvcProtect,
                    filterRadius: rvcFilterRadius,
                    rmsMixRate: rvcRmsMixRate,
                    resampleSr: rvcResampleSr,
                },
            });

            if (!pipelineRes.success) {
                addLog(`Pipeline failed: ${pipelineRes.error?.message || 'Unknown error'}`);
                return;
            }

            if (pipelineRes.intermediateWavPath) {
                setIntermediateAudioUrl(await readAudioAsDataUrl(pipelineRes.intermediateWavPath));
                setLastSbv2WavPath(pipelineRes.intermediateWavPath);
            }

            if (pipelineRes.audioBase64) {
                setAudioUrl(`data:audio/wav;base64,${pipelineRes.audioBase64}`);
            } else {
                setAudioUrl(await readAudioAsDataUrl(pipelineRes.wavPath));
            }
            addLog('SBV2 + RVC pipeline complete.');
        } catch (error) {
            addLog(`Action failed: ${String(error)}`);
        } finally {
            setIsRunningAction(false);
        }
    };

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            padding: '24px',
            gap: '16px',
            backgroundColor: 'var(--color-bg-secondary)',
            color: 'var(--color-text)',
            fontFamily: 'Inter, sans-serif',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button onClick={() => navigate('/')} style={btnStyle('secondary')}>← Back</button>
                    <h1 style={{ margin: 0, fontSize: '24px' }}>Voice Studio</h1>
                    <span style={{ ...badgeStyle, backgroundColor: activeStatus.runtimeState === 'running' ? '#10b981' : '#ef4444' }}>
                        {activeStatus.runtimeState.toUpperCase()}
                    </span>
                </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => setMode('sbv2')} style={tabStyle(mode === 'sbv2')}>SBV2 Only</button>
                <button onClick={() => setMode('rvc')} style={tabStyle(mode === 'rvc')}>RVC Only</button>
                <button onClick={() => setMode('sbv2+rvc')} style={tabStyle(mode === 'sbv2+rvc')}>SBV2 + RVC</button>
            </div>

            <div style={{ ...cardStyle, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: '13px', color: '#cbd5e1' }}>
                    Compute Mode: <strong>{useCpuMode ? 'CPU' : 'GPU/Auto (Default)'}</strong>
                </div>
                <button onClick={handleToggleComputeMode} disabled={isLoading} style={btnStyle('secondary')}>
                    Switch to {useCpuMode ? 'GPU/Auto' : 'CPU'}
                </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: '16px', minHeight: 0, flex: 1 }}>
                <div style={{ ...cardStyle, overflowY: 'auto' }}>
                    {(mode === 'sbv2' || mode === 'sbv2+rvc') && (
                        <>
                            <h3 style={sectionTitleStyle}>SBV2</h3>
                            <div style={rowStyle}>
                                {ttsStatus.installState === 'not_installed' ? (
                                    <button disabled={isLoading} onClick={handleInstallTts} style={btnStyle('primary')}>Install SBV2</button>
                                ) : ttsStatus.runtimeState !== 'running' ? (
                                    <button disabled={isLoading} onClick={handleStartTts} style={btnStyle('primary')}>Start SBV2</button>
                                ) : (
                                    <button disabled={isLoading} onClick={handleStopTts} style={btnStyle('danger')}>Stop SBV2</button>
                                )}
                            </div>

                            <label style={labelStyle}>Model</label>
                            <select
                                value={selectedTtsModel}
                                onChange={async (e) => {
                                    const modelId = e.target.value;
                                    setSelectedTtsModel(modelId);
                                    const model = ttsModels.find((m) => m.id === modelId);
                                    if (model) {
                                        setSelectedStyle(model.defaultStyle || model.styles[0] || 'Neutral');
                                    }
                                    await window.electronAPI.ttsSetModel(modelId);
                                }}
                                style={inputStyle}
                                disabled={ttsStatus.runtimeState !== 'running'}
                            >
                                <option value="">(select)</option>
                                {ttsModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>

                            <label style={labelStyle}>Style</label>
                            <select value={selectedStyle} onChange={(e) => setSelectedStyle(e.target.value)} style={inputStyle}>
                                {(ttsModels.find((m) => m.id === selectedTtsModel)?.styles || []).map((s) => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>

                            <label style={labelStyle}>Speed: {speed.toFixed(2)}</label>
                            <input type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>Pitch: {pitch.toFixed(1)}</label>
                            <input type="range" min="-12" max="12" step="0.5" value={pitch} onChange={(e) => setPitch(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>Intonation: {intonation.toFixed(2)}</label>
                            <input type="range" min="0" max="2" step="0.05" value={intonation} onChange={(e) => setIntonation(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>Style Weight: {styleWeight.toFixed(2)}</label>
                            <input type="range" min="0.1" max="5" step="0.1" value={styleWeight} onChange={(e) => setStyleWeight(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>SDP Ratio: {sdpRatio.toFixed(2)}</label>
                            <input type="range" min="0" max="1" step="0.01" value={sdpRatio} onChange={(e) => setSdpRatio(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>Noise: {noiseScale.toFixed(2)}</label>
                            <input type="range" min="0.1" max="1" step="0.01" value={noiseScale} onChange={(e) => setNoiseScale(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>NoiseW: {noiseScaleW.toFixed(2)}</label>
                            <input type="range" min="0.1" max="1" step="0.01" value={noiseScaleW} onChange={(e) => setNoiseScaleW(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>SBV2 Presets</label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                                {ttsPresets.map((preset) => (
                                    <button key={preset.id} onClick={() => applyTtsPreset(preset)} style={presetBtnStyle}>{preset.name}</button>
                                ))}
                            </div>
                        </>
                    )}

                    {(mode === 'rvc' || mode === 'sbv2+rvc') && (
                        <>
                            <h3 style={sectionTitleStyle}>RVC</h3>
                            <div style={rowStyle}>
                                {rvcStatus.installState === 'not_installed' ? (
                                    <button disabled={isLoading} onClick={handleInstallRvc} style={btnStyle('primary')}>Install RVC</button>
                                ) : rvcStatus.runtimeState !== 'running' ? (
                                    <button disabled={isLoading} onClick={handleStartRvc} style={btnStyle('primary')}>Start RVC</button>
                                ) : (
                                    <button disabled={isLoading} onClick={handleStopRvc} style={btnStyle('danger')}>Stop RVC</button>
                                )}
                            </div>

                            <label style={labelStyle}>RVC Model</label>
                            <select
                                value={selectedRvcModel}
                                onChange={async (e) => {
                                    const modelId = e.target.value;
                                    setSelectedRvcModel(modelId);
                                    await window.electronAPI.rvcSetModel(modelId);
                                }}
                                style={inputStyle}
                                disabled={rvcStatus.runtimeState !== 'running'}
                            >
                                <option value="">(select)</option>
                                {rvcModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>

                            <label style={labelStyle}>F0 Method</label>
                            <select value={rvcF0Method} onChange={(e) => setRvcF0Method(e.target.value as RvcF0Method)} style={inputStyle}>
                                <option value="rmvpe">rmvpe</option>
                                <option value="harvest">harvest</option>
                                <option value="crepe">crepe</option>
                            </select>

                            <label style={labelStyle}>Transpose: {rvcTranspose}</label>
                            <input type="range" min="-12" max="12" step="1" value={rvcTranspose} onChange={(e) => setRvcTranspose(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>Index Rate: {rvcIndexRate.toFixed(2)}</label>
                            <input type="range" min="0" max="1" step="0.01" value={rvcIndexRate} onChange={(e) => setRvcIndexRate(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>Protect: {rvcProtect.toFixed(2)}</label>
                            <input type="range" min="0" max="0.5" step="0.01" value={rvcProtect} onChange={(e) => setRvcProtect(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>Filter Radius: {rvcFilterRadius}</label>
                            <input type="range" min="0" max="7" step="1" value={rvcFilterRadius} onChange={(e) => setRvcFilterRadius(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>RMS Mix Rate: {rvcRmsMixRate.toFixed(2)}</label>
                            <input type="range" min="0" max="1" step="0.01" value={rvcRmsMixRate} onChange={(e) => setRvcRmsMixRate(Number(e.target.value))} style={rangeStyle} />

                            <label style={labelStyle}>Resample SR</label>
                            <input type="number" value={rvcResampleSr} onChange={(e) => setRvcResampleSr(Number(e.target.value) || 0)} style={inputStyle} />

                            <label style={labelStyle}>RVC Presets</label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {rvcPresets.map((preset) => (
                                    <button key={preset.id} onClick={() => applyRvcPreset(preset)} style={presetBtnStyle}>{preset.name}</button>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minHeight: 0 }}>
                    <div style={cardStyle}>
                        {(mode === 'sbv2' || mode === 'sbv2+rvc') && (
                            <>
                                <label style={labelStyle}>Text</label>
                                <textarea
                                    value={text}
                                    onChange={(e) => setText(e.target.value)}
                                    style={{ ...inputStyle, minHeight: '90px', resize: 'vertical', marginBottom: '10px' }}
                                />
                                <label style={labelStyle}>Assist Text</label>
                                <input value={assistText} onChange={(e) => setAssistText(e.target.value)} style={inputStyle} />
                            </>
                        )}

                        {mode === 'rvc' && (
                            <>
                                <label style={labelStyle}>Input WAV</label>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <input value={rvcInputPath} onChange={(e) => setRvcInputPath(e.target.value)} style={{ ...inputStyle, flex: 1 }} placeholder="C:\\path\\to\\input.wav" />
                                    <button onClick={handlePickRvcInput} style={btnStyle('secondary')}>Browse</button>
                                    <button onClick={() => setRvcInputPath(lastSbv2WavPath || '')} style={btnStyle('secondary')} disabled={!lastSbv2WavPath}>Use SBV2</button>
                                </div>
                            </>
                        )}

                        <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
                            <button
                                onClick={handleSynthesize}
                                disabled={isRunningAction}
                                style={{ ...btnStyle('primary'), padding: '12px 26px', fontSize: '15px' }}
                            >
                                {isRunningAction ? 'Processing...' : (mode === 'rvc' ? 'Convert' : 'Synthesize')}
                            </button>
                        </div>
                    </div>

                    <div style={cardStyle}>
                        <h3 style={sectionTitleStyle}>Audio Output</h3>
                        {mode === 'sbv2+rvc' && intermediateAudioUrl && (
                            <div style={{ marginBottom: '12px' }}>
                                <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>Intermediate (SBV2)</div>
                                <audio controls src={intermediateAudioUrl} style={{ width: '100%' }} />
                            </div>
                        )}
                        {audioUrl ? (
                            <audio controls src={audioUrl} style={{ width: '100%' }} />
                        ) : (
                            <div style={{ color: '#9ca3af', fontSize: '13px' }}>No audio generated yet.</div>
                        )}
                    </div>

                    <div style={{ ...cardStyle, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={sectionTitleStyle}>Logs</h3>
                            <button onClick={() => setLogs([])} style={btnStyle('secondary')}>Clear</button>
                        </div>
                        <div style={{
                            marginTop: '8px',
                            flex: 1,
                            overflowY: 'auto',
                            backgroundColor: '#111827',
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            padding: '10px',
                            fontFamily: 'Consolas, monospace',
                            fontSize: '12px',
                        }}>
                            {logs.map((log, i) => <div key={`${i}-${log}`}>{log}</div>)}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '14px',
    padding: '16px',
};

const sectionTitleStyle: React.CSSProperties = {
    margin: 0,
    marginBottom: '10px',
    fontSize: '14px',
    color: '#cbd5e1',
};

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '12px',
    color: '#94a3b8',
    marginBottom: '4px',
    marginTop: '10px',
};

const inputStyle: React.CSSProperties = {
    width: '100%',
    backgroundColor: '#1f2937',
    border: '1px solid #374151',
    color: '#f9fafb',
    borderRadius: '8px',
    padding: '8px 10px',
};

const rangeStyle: React.CSSProperties = {
    width: '100%',
};

const rowStyle: React.CSSProperties = {
    display: 'flex',
    gap: '8px',
    marginBottom: '8px',
};

const presetBtnStyle: React.CSSProperties = {
    width: '100%',
    textAlign: 'left',
    padding: '8px',
    backgroundColor: '#374151',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
};

const badgeStyle: React.CSSProperties = {
    color: '#fff',
    fontSize: '11px',
    borderRadius: '999px',
    padding: '4px 10px',
    fontWeight: 700,
};

const tabStyle = (active: boolean): React.CSSProperties => ({
    border: '1px solid #374151',
    borderRadius: '8px',
    padding: '8px 12px',
    cursor: 'pointer',
    backgroundColor: active ? '#2563eb' : '#1f2937',
    color: '#fff',
    fontWeight: 600,
});

const btnStyle = (variant: 'primary' | 'secondary' | 'danger'): React.CSSProperties => {
    const base: React.CSSProperties = {
        border: 'none',
        borderRadius: '8px',
        padding: '8px 12px',
        cursor: 'pointer',
        color: '#fff',
        fontWeight: 600,
    };
    if (variant === 'primary') return { ...base, backgroundColor: '#2563eb' };
    if (variant === 'danger') return { ...base, backgroundColor: '#dc2626' };
    return { ...base, backgroundColor: '#374151' };
};

export default VoiceStudioScreen;
