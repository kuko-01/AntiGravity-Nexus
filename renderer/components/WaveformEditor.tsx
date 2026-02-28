import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AudioProcess } from '../../types';

interface WaveformEditorProps {
    wavBase64?: string;
    fileName?: string;
    characterId?: string;
    rvcConfig?: {
        modelId?: string;
        speakerId?: number;
        indexPath?: string;
    };
    onClose: () => void;
}

// Encode Float32Array PCM samples to a standard WAV ArrayBuffer (PCM 16-bit)
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
    const numSamples = samples.length;
    const byteRate = sampleRate * 2;
    const blockAlign = 2;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
}

export const WaveformEditor: React.FC<WaveformEditorProps> = ({ wavBase64, fileName, characterId, rvcConfig, onClose }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const audioElRef = useRef<HTMLAudioElement | null>(null);
    const animFrameRef = useRef<number>(0);
    const playOffsetRef = useRef<number>(0);
    const isDraggingRef = useRef<'start' | 'end' | 'seek' | null>(null);
    const popupWindowRef = useRef<Window | null>(null);
    const popupContainerRef = useRef<HTMLDivElement | null>(null);
    const suppressPopupCloseEventRef = useRef(false);
    const onCloseRef = useRef(onClose);

    const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTimeSec, setCurrentTimeSec] = useState(0);
    const [trimStartRatio, setTrimStartRatio] = useState(0);
    const [trimEndRatio, setTrimEndRatio] = useState(1);
    const [statusMsg, setStatusMsg] = useState('');
    const [currentBase64, setCurrentBase64] = useState(wavBase64 || '');
    const [currentFileName, setCurrentFileName] = useState(fileName || 'audio.wav');
    const [popupReady, setPopupReady] = useState(false);
    const [isSpeakerAnalyzing, setIsSpeakerAnalyzing] = useState(false);
    const [speakerDiarizationText, setSpeakerDiarizationText] = useState('');
    const [isRvcConverting, setIsRvcConverting] = useState(false);
    const [audioProcesses, setAudioProcesses] = useState<AudioProcess[]>([]);
    const [selectedCaptureProcessPid, setSelectedCaptureProcessPid] = useState<number | null>(null);
    const [isRefreshingAudioProcesses, setIsRefreshingAudioProcesses] = useState(false);
    const [isAppRecording, setIsAppRecording] = useState(false);
    const [appRecordingStatus, setAppRecordingStatus] = useState('');
    const isAppRecordingRef = useRef(false);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        let popup = popupWindowRef.current;
        if (!popup || popup.closed) {
            popup = window.open('', `waveform-editor-${Date.now()}`, 'width=860,height=620,resizable=yes,scrollbars=yes');
        }
        if (!popup) {
            setStatusMsg((prev) => prev || '別ウィンドウを開けませんでした。');
            return;
        }

        popupWindowRef.current = popup;
        suppressPopupCloseEventRef.current = false;
        popup.document.title = currentFileName || 'Waveform Editor';
        popup.document.body.style.margin = '0';
        popup.document.body.style.background = '#0f172a';
        popup.document.body.style.color = '#e2e8f0';
        popup.document.body.style.fontFamily = '"Segoe UI", sans-serif';

        let container = popupContainerRef.current;
        if (!container || !popup.document.body.contains(container)) {
            popup.document.body.innerHTML = '';
            container = popup.document.createElement('div');
            container.style.padding = '12px';
            container.style.boxSizing = 'border-box';
            popup.document.body.appendChild(container);
            popupContainerRef.current = container;
        }

        const handleBeforeUnload = () => {
            if (suppressPopupCloseEventRef.current) return;
            onCloseRef.current();
        };
        popup.addEventListener('beforeunload', handleBeforeUnload);
        try { popup.focus(); } catch { /* ignore */ }
        setPopupReady(true);

        return () => {
            popup.removeEventListener('beforeunload', handleBeforeUnload);
            if (!popup.closed) {
                suppressPopupCloseEventRef.current = true;
                try { popup.close(); } catch { /* ignore */ }
            }
            popupWindowRef.current = null;
            popupContainerRef.current = null;
        };
    }, []);

    useEffect(() => {
        const popup = popupWindowRef.current;
        if (!popup || popup.closed) return;
        popup.document.title = currentFileName ? `Waveform Editor - ${currentFileName}` : 'Waveform Editor';
    }, [currentFileName]);

    // Load audio from base64
    const loadAudio = useCallback(async (b64: string) => {
        const normalized = String(b64 || '').trim();
        if (!normalized) {
            if (audioElRef.current) {
                audioElRef.current.pause();
                audioElRef.current.removeAttribute('src');
            }
            setAudioBuffer(null);
            setIsPlaying(false);
            setCurrentTimeSec(0);
            setTrimStartRatio(0);
            setTrimEndRatio(1);
            playOffsetRef.current = 0;
            setStatusMsg('WAVを読み込んでください。');
            return;
        }
        setStatusMsg('読み込み中...');
        try {
            if (audioElRef.current) {
                audioElRef.current.pause();
                audioElRef.current.src = `data:audio/wav;base64,${normalized}`;
                audioElRef.current.currentTime = 0;
            }
            if (audioCtxRef.current) {
                await audioCtxRef.current.close();
            }
            const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AudioContextCtor) {
                throw new Error('AudioContext is not available');
            }
            audioCtxRef.current = new AudioContextCtor();
            const arrayBuf = base64ToArrayBuffer(normalized);
            const decoded = await audioCtxRef.current.decodeAudioData(arrayBuf);
            setAudioBuffer(decoded);
            setCurrentTimeSec(0);
            setTrimStartRatio(0);
            setTrimEndRatio(1);
            playOffsetRef.current = 0;
            setStatusMsg('');
        } catch (e) {
            setStatusMsg(`読み込みエラー: ${String(e)}`);
        }
    }, []);

    useEffect(() => {
        const popup = popupWindowRef.current;
        const AudioCtor = popup?.Audio || window.Audio;
        const audio = new AudioCtor();
        audio.preload = 'auto';
        const handleTimeUpdate = () => {
            const t = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
            playOffsetRef.current = t;
            setCurrentTimeSec(t);
        };
        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => setIsPlaying(false);
        const handleEnded = () => {
            setIsPlaying(false);
            setCurrentTimeSec(0);
            playOffsetRef.current = 0;
        };
        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('play', handlePlay);
        audio.addEventListener('pause', handlePause);
        audio.addEventListener('ended', handleEnded);
        audioElRef.current = audio;

        return () => {
            cancelAnimationFrame(animFrameRef.current);
            try {
                audio.pause();
                audio.removeAttribute('src');
            } catch {
                // ignore
            }
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('play', handlePlay);
            audio.removeEventListener('pause', handlePause);
            audio.removeEventListener('ended', handleEnded);
            audioElRef.current = null;
            if (audioCtxRef.current) { void audioCtxRef.current.close(); }
        };
    }, []);

    useEffect(() => {
        const nextBase64 = wavBase64 || '';
        setCurrentBase64(nextBase64);
        setCurrentFileName(fileName || 'audio.wav');
        void loadAudio(nextBase64);
    }, [wavBase64, fileName, loadAudio]);

    const sortedAudioProcesses = useMemo(() => (
        [...audioProcesses].sort((a, b) => {
            const labelA = `${String(a.title || '').trim()} ${String(a.name || '').trim()}`.trim();
            const labelB = `${String(b.title || '').trim()} ${String(b.name || '').trim()}`.trim();
            return labelA.localeCompare(labelB);
        })
    ), [audioProcesses]);

    const refreshAudioProcesses = useCallback(async (options?: { silent?: boolean }) => {
        if (!window.electronAPI?.getAudioProcesses) {
            setAppRecordingStatus('アプリ録音機能は利用できません。');
            return;
        }
        if (!options?.silent) {
            setIsRefreshingAudioProcesses(true);
            setAppRecordingStatus('音声出力中のアプリ一覧を取得中...');
        }
        try {
            const result = await window.electronAPI.getAudioProcesses();
            if (!result.success || !Array.isArray(result.processes)) {
                if (!options?.silent) {
                    setAppRecordingStatus(`アプリ一覧取得失敗: ${result.error || '不明'}`);
                }
                return;
            }
            setAudioProcesses(result.processes);
            setSelectedCaptureProcessPid((prev) => {
                if (prev && result.processes.some((p) => p.pid === prev)) return prev;
                return result.processes[0]?.pid ?? null;
            });
            if (!options?.silent) {
                setAppRecordingStatus(`アプリ一覧を更新しました (${result.processes.length}件)。`);
            }
        } catch (e) {
            if (!options?.silent) {
                setAppRecordingStatus(`アプリ一覧取得エラー: ${String(e)}`);
            }
        } finally {
            if (!options?.silent) {
                setIsRefreshingAudioProcesses(false);
            }
        }
    }, []);

    const stopAppRecordingAndLoad = useCallback(async (options?: { silent?: boolean }) => {
        if (!window.electronAPI?.stopProcessCapture) {
            setAppRecordingStatus('停止APIが利用できません。');
            return;
        }
        try {
            const result = await window.electronAPI.stopProcessCapture();
            isAppRecordingRef.current = false;
            setIsAppRecording(false);
            if (!result.success) {
                if (!options?.silent) {
                    setAppRecordingStatus(`録音停止失敗: ${result.error || '不明'}`);
                }
                return;
            }
            const finalPath = String(result.finalRecordingPath || '').trim();
            if (!finalPath) {
                if (!options?.silent) {
                    setAppRecordingStatus('録音停止完了（出力ファイルなし）。');
                }
                return;
            }
            if (!window.electronAPI?.dialogueLoadWavFile) {
                if (!options?.silent) {
                    setAppRecordingStatus(`録音停止完了: ${finalPath}（dialogueLoadWavFile APIなし）`);
                }
                return;
            }
            if (!options?.silent) {
                setAppRecordingStatus('録音停止。WAVを読み込み中...');
            }
            const loaded = await window.electronAPI.dialogueLoadWavFile(finalPath);
            if (!loaded.success || !loaded.base64) {
                if (!options?.silent) {
                    setAppRecordingStatus(`録音WAV読み込み失敗: ${loaded.error || '不明'}`);
                }
                return;
            }
            setCurrentBase64(loaded.base64);
            setCurrentFileName(loaded.fileName || `capture_${Date.now()}.wav`);
            await loadAudio(loaded.base64);
            if (!options?.silent) {
                setAppRecordingStatus(`録音WAVを読み込みました: ${loaded.fileName || finalPath}`);
            }
        } catch (e) {
            isAppRecordingRef.current = false;
            setIsAppRecording(false);
            if (!options?.silent) {
                setAppRecordingStatus(`録音停止エラー: ${String(e)}`);
            }
        }
    }, [loadAudio]);

    const handleToggleAppRecording = useCallback(async () => {
        if (isAppRecordingRef.current) {
            setAppRecordingStatus('録音停止中...');
            await stopAppRecordingAndLoad();
            return;
        }
        if (!window.electronAPI?.startProcessCapture) {
            setAppRecordingStatus('アプリ録音開始APIが利用できません。');
            return;
        }
        if (!selectedCaptureProcessPid) {
            setAppRecordingStatus('録音対象アプリを選択してください。');
            return;
        }
        try {
            if (window.electronAPI?.startSession) {
                const sessionResult = await window.electronAPI.startSession();
                if (!sessionResult?.success) {
                    setAppRecordingStatus(`録音準備失敗: ${sessionResult?.error || 'セッション作成失敗'}`);
                    return;
                }
            }
            setAppRecordingStatus(`録音開始中... (PID:${selectedCaptureProcessPid})`);
            const startResult = await window.electronAPI.startProcessCapture(selectedCaptureProcessPid);
            if (!startResult.success) {
                setAppRecordingStatus(`録音開始失敗: ${startResult.error || '不明'}`);
                isAppRecordingRef.current = false;
                setIsAppRecording(false);
                return;
            }
            isAppRecordingRef.current = true;
            setIsAppRecording(true);
            setAppRecordingStatus(`録音中... (PID:${selectedCaptureProcessPid}) トグルで停止して読み込み`);
        } catch (e) {
            isAppRecordingRef.current = false;
            setIsAppRecording(false);
            setAppRecordingStatus(`録音開始エラー: ${String(e)}`);
        }
    }, [selectedCaptureProcessPid, stopAppRecordingAndLoad]);

    useEffect(() => {
        void refreshAudioProcesses({ silent: true });
    }, [refreshAudioProcesses]);

    useEffect(() => {
        return () => {
            if (isAppRecordingRef.current) {
                void stopAppRecordingAndLoad({ silent: true });
            }
        };
    }, [stopAppRecordingAndLoad]);

    // Draw waveform on canvas
    useEffect(() => {
        if (!audioBuffer || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const W = canvas.width;
        const H = canvas.height;
        const samples = audioBuffer.getChannelData(0);
        const totalSamples = samples.length;
        const samplesPerPx = Math.max(1, Math.floor(totalSamples / W));

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, W, H);

        // Trim region highlight
        const trimStartPx = Math.floor(trimStartRatio * W);
        const trimEndPx = Math.floor(trimEndRatio * W);
        ctx.fillStyle = 'rgba(99, 179, 237, 0.15)';
        ctx.fillRect(trimStartPx, 0, trimEndPx - trimStartPx, H);

        // Waveform bars
        const midY = H / 2;
        for (let x = 0; x < W; x++) {
            let peak = 0;
            const start = x * samplesPerPx;
            const end = Math.min(start + samplesPerPx, totalSamples);
            for (let i = start; i < end; i++) {
                const abs = Math.abs(samples[i]);
                if (abs > peak) peak = abs;
            }
            const barH = peak * midY * 0.95;
            const xRatio = x / W;
            const inTrim = xRatio >= trimStartRatio && xRatio <= trimEndRatio;
            ctx.fillStyle = inTrim ? '#63b3ed' : '#4a5568';
            ctx.fillRect(x, midY - barH, 1, barH * 2);
        }

        // Trim markers
        ctx.strokeStyle = '#f6e05e';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(trimStartPx, 0);
        ctx.lineTo(trimStartPx, H);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(trimEndPx, 0);
        ctx.lineTo(trimEndPx, H);
        ctx.stroke();

        // Playhead
        const playheadX = Math.floor((currentTimeSec / audioBuffer.duration) * W);
        ctx.strokeStyle = '#fc8181';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, H);
        ctx.stroke();
    }, [audioBuffer, trimStartRatio, trimEndRatio, currentTimeSec]);

    // Animate playhead during playback
    useEffect(() => {
        const audio = audioElRef.current;
        if (!isPlaying || !audioBuffer || !audio) return;
        const animate = () => {
            const newTime = Math.min(audio.currentTime || 0, audioBuffer.duration);
            setCurrentTimeSec(newTime);
            if (!audio.paused && !audio.ended && newTime < audioBuffer.duration) {
                animFrameRef.current = requestAnimationFrame(animate);
            }
        };
        animFrameRef.current = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(animFrameRef.current);
    }, [isPlaying, audioBuffer]);

    const stopPlayback = useCallback(() => {
        if (audioElRef.current) {
            try {
                audioElRef.current.pause();
            } catch {
                // ignore
            }
        }
        cancelAnimationFrame(animFrameRef.current);
        setIsPlaying(false);
    }, []);

    const handlePlay = useCallback(() => {
        if (!audioBuffer) return;
        if (isPlaying) {
            if (audioElRef.current) {
                playOffsetRef.current = Number.isFinite(audioElRef.current.currentTime) ? audioElRef.current.currentTime : currentTimeSec;
                audioElRef.current.pause();
            } else {
                playOffsetRef.current = currentTimeSec;
            }
            stopPlayback();
            return;
        }
        void (async () => {
            try {
                if (audioCtxRef.current?.state === 'suspended') {
                    await audioCtxRef.current.resume();
                }
                const audio = audioElRef.current;
                if (!audio) {
                    setStatusMsg('再生エラー: audio element not initialized');
                    return;
                }
                const startAt = Math.max(0, Math.min(playOffsetRef.current, Math.max(0, audioBuffer.duration - 0.01)));
                audio.currentTime = startAt;
                await audio.play();
                setIsPlaying(true);
                setStatusMsg('');
            } catch (e) {
                setStatusMsg(`再生エラー: ${String(e)}`);
                setIsPlaying(false);
            }
        })();
    }, [audioBuffer, isPlaying, currentTimeSec, stopPlayback]);

    const handleStop = useCallback(() => {
        stopPlayback();
        if (audioElRef.current) {
            try {
                audioElRef.current.currentTime = 0;
            } catch {
                // ignore
            }
        }
        setCurrentTimeSec(0);
        playOffsetRef.current = 0;
    }, [stopPlayback]);

    const getRatioFromMouseX = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const rect = canvasRef.current!.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    };

    const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!audioBuffer) return;
        const ratio = getRatioFromMouseX(e);
        const startPx = trimStartRatio * canvasRef.current!.getBoundingClientRect().width;
        const endPx = trimEndRatio * canvasRef.current!.getBoundingClientRect().width;
        const mouseX = e.clientX - canvasRef.current!.getBoundingClientRect().left;
        const SNAP = 8;
        if (Math.abs(mouseX - startPx) <= SNAP) {
            isDraggingRef.current = 'start';
        } else if (Math.abs(mouseX - endPx) <= SNAP) {
            isDraggingRef.current = 'end';
        } else {
            isDraggingRef.current = 'seek';
            const newTime = ratio * audioBuffer.duration;
            setCurrentTimeSec(newTime);
            playOffsetRef.current = newTime;
            if (audioElRef.current) {
                try {
                    audioElRef.current.currentTime = newTime;
                } catch {
                    // ignore
                }
            }
        }
    }, [audioBuffer, trimStartRatio, trimEndRatio]);

    const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!isDraggingRef.current || !audioBuffer) return;
        const ratio = getRatioFromMouseX(e);
        if (isDraggingRef.current === 'start') {
            setTrimStartRatio(Math.min(ratio, trimEndRatio - 0.01));
        } else if (isDraggingRef.current === 'end') {
            setTrimEndRatio(Math.max(ratio, trimStartRatio + 0.01));
        }
    }, [audioBuffer, trimStartRatio, trimEndRatio]);

    const handleCanvasMouseUp = useCallback(() => {
        isDraggingRef.current = null;
    }, []);

    const handleLoadWav = useCallback(async () => {
        const result = await window.electronAPI.selectFile(['wav'], false);
        if (!result?.success || !result.path) return;
        const loaded = await window.electronAPI.dialogueLoadWavFile(result.path);
        if (loaded.success && loaded.base64) {
            setCurrentBase64(loaded.base64);
            setCurrentFileName(loaded.fileName || 'audio.wav');
            await loadAudio(loaded.base64);
        } else {
            setStatusMsg(`WAV読み込みエラー: ${loaded.error || '不明'}`);
        }
    }, [loadAudio]);

    const handleSaveToTraining = useCallback(async () => {
        if (!audioBuffer) return;
        setStatusMsg('保存中...');
        try {
            const samples = audioBuffer.getChannelData(0);
            const startIdx = Math.floor(trimStartRatio * samples.length);
            const endIdx = Math.floor(trimEndRatio * samples.length);
            const trimmed = samples.slice(startIdx, endIdx);
            const wavBuffer = encodeWav(trimmed, audioBuffer.sampleRate);
            const b64 = arrayBufferToBase64(wavBuffer);
            const ts = Date.now();
            const saveName = `dialogue_${ts}.wav`;
            const result = await window.electronAPI.dialogueSaveTrainingMaterial({
                characterId: characterId || 'default',
                base64: b64,
                fileName: saveName,
            });
            if (result.success) {
                setStatusMsg(`保存完了: ${result.savedPath || saveName}`);
            } else {
                setStatusMsg(`保存エラー: ${result.error || '不明'}`);
            }
        } catch (e) {
            setStatusMsg(`保存エラー: ${String(e)}`);
        }
    }, [audioBuffer, trimStartRatio, trimEndRatio, characterId]);

    const getSelectedMonoSamples = useCallback((): Float32Array | null => {
        if (!audioBuffer) return null;
        const samples = audioBuffer.getChannelData(0);
        const startIdx = Math.max(0, Math.min(samples.length, Math.floor(trimStartRatio * samples.length)));
        const endIdx = Math.max(startIdx + 1, Math.min(samples.length, Math.floor(trimEndRatio * samples.length)));
        return samples.slice(startIdx, endIdx);
    }, [audioBuffer, trimStartRatio, trimEndRatio]);

    const handleSpeakerDiarization = useCallback(async () => {
        if (!audioBuffer) return;
        if (!window.electronAPI?.transcribeLinear16) {
            setStatusMsg('話者分離エラー: transcribeLinear16 API が利用できません。');
            return;
        }
        const selected = getSelectedMonoSamples();
        if (!selected || selected.length <= 0) {
            setStatusMsg('話者分離エラー: 選択範囲が空です。');
            return;
        }
        setIsSpeakerAnalyzing(true);
        setStatusMsg('話者分離（話者タグ解析）中...');
        try {
            const pcm16 = Array.from(selected, (v) => {
                const s = Math.max(-1, Math.min(1, v));
                return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
            });
            const result = await window.electronAPI.transcribeLinear16(pcm16, audioBuffer.sampleRate, 1);
            if (!result.success) {
                setStatusMsg(`話者分離エラー: ${result.error || '不明'}`);
                return;
            }
            const words = Array.isArray(result.words) ? result.words : [];
            const transcript = String(result.text || '').trim();
            if (words.length === 0) {
                const fallback = transcript || '(文字起こし結果なし)';
                setSpeakerDiarizationText(`話者タグなし\n${fallback}`);
                setStatusMsg('話者分離完了（話者タグは検出されませんでした）。');
                return;
            }
            const segments: Array<{ speakerTag: number; text: string }> = [];
            let currentTag: number | null = null;
            let currentWords: string[] = [];
            const speakerWordCounts = new Map<number, number>();
            for (const w of words) {
                const tag = Number.isFinite(w?.speakerTag) ? Number(w.speakerTag) : 0;
                const word = String(w?.word || '').trim();
                if (!word) continue;
                speakerWordCounts.set(tag, (speakerWordCounts.get(tag) || 0) + 1);
                if (currentTag === null) {
                    currentTag = tag;
                    currentWords = [word];
                    continue;
                }
                if (tag !== currentTag) {
                    segments.push({ speakerTag: currentTag, text: currentWords.join(' ') });
                    currentTag = tag;
                    currentWords = [word];
                } else {
                    currentWords.push(word);
                }
            }
            if (currentTag !== null && currentWords.length > 0) {
                segments.push({ speakerTag: currentTag, text: currentWords.join(' ') });
            }
            const speakerSummary = Array.from(speakerWordCounts.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([tag, count]) => `Speaker ${tag}: ${count} words`)
                .join('\n');
            const segmentText = segments
                .map((seg, index) => `${index + 1}. [Speaker ${seg.speakerTag}] ${seg.text}`)
                .join('\n');
            setSpeakerDiarizationText(`${speakerSummary}\n\n${segmentText || transcript || '(no transcript)'}`);
            setStatusMsg(`話者分離完了: ${speakerWordCounts.size} 話者候補 / ${words.length}語`);
        } catch (e) {
            setStatusMsg(`話者分離エラー: ${String(e)}`);
        } finally {
            setIsSpeakerAnalyzing(false);
        }
    }, [audioBuffer, getSelectedMonoSamples]);

    const handleRvcConvert = useCallback(async () => {
        if (!audioBuffer) return;
        if (!window.electronAPI?.rvcConvert) {
            setStatusMsg('RVC変換エラー: rvcConvert API が利用できません。');
            return;
        }
        const modelId = String(rvcConfig?.modelId || '').trim();
        if (!modelId) {
            setStatusMsg('RVC変換エラー: RVCモデルが未設定です（AIキャラクターUI側のRVC Model IDを設定してください）。');
            return;
        }
        const selected = getSelectedMonoSamples();
        if (!selected || selected.length <= 0) {
            setStatusMsg('RVC変換エラー: 選択範囲が空です。');
            return;
        }
        setIsRvcConverting(true);
        setStatusMsg('RVC変換中...');
        try {
            const wavBuffer = encodeWav(selected, audioBuffer.sampleRate);
            const inputBase64 = arrayBufferToBase64(wavBuffer);
            const result = await window.electronAPI.rvcConvert({
                inputBase64,
                modelId,
                speakerId: Number.isFinite(rvcConfig?.speakerId) ? rvcConfig?.speakerId : 0,
                indexPath: String(rvcConfig?.indexPath || '').trim() || undefined,
                latencyPriority: true,
            });
            if (!result?.success) {
                const message = result?.error?.message || result?.error || '不明';
                setStatusMsg(`RVC変換エラー: ${String(message)}`);
                return;
            }

            let convertedBase64 = '';
            let convertedFileName = `rvc_${Date.now()}.wav`;
            if (typeof result.audioBase64 === 'string' && result.audioBase64.trim()) {
                convertedBase64 = result.audioBase64;
            } else if (typeof result.wavPath === 'string' && result.wavPath.trim() && window.electronAPI?.dialogueLoadWavFile) {
                const loaded = await window.electronAPI.dialogueLoadWavFile(result.wavPath);
                if (loaded.success && loaded.base64) {
                    convertedBase64 = loaded.base64;
                    convertedFileName = loaded.fileName || convertedFileName;
                } else {
                    setStatusMsg(`RVC変換後の読み込みエラー: ${loaded.error || '不明'}`);
                    return;
                }
            } else {
                setStatusMsg('RVC変換エラー: 変換結果のWAV取得に失敗しました。');
                return;
            }

            setCurrentBase64(convertedBase64);
            setCurrentFileName(convertedFileName);
            await loadAudio(convertedBase64);
            const warningText = String(result.warning || '').trim();
            setStatusMsg(warningText ? `RVC変換完了 (${warningText})` : 'RVC変換完了');
        } catch (e) {
            setStatusMsg(`RVC変換エラー: ${String(e)}`);
        } finally {
            setIsRvcConverting(false);
        }
    }, [audioBuffer, getSelectedMonoSamples, loadAudio, rvcConfig]);

    const duration = audioBuffer?.duration ?? 0;
    const trimStartSec = trimStartRatio * duration;
    const trimEndSec = trimEndRatio * duration;

    const editorPanel = useMemo(() => (
        <div style={{
            background: '#1a1a2e', border: '1px solid #2d3748', borderRadius: '12px',
            padding: '20px', width: '100%', maxWidth: '820px', boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column', gap: '12px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#e2e8f0' }}>
                        Waveform Editor
                    </div>
                    <div style={{ fontSize: '12px', color: '#718096', flex: 1, marginLeft: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {currentFileName}
                    </div>
                    <button
                        onClick={onClose}
                        style={{ background: 'none', border: 'none', color: '#a0aec0', cursor: 'pointer', fontSize: '18px', lineHeight: 1, padding: '0 4px' }}
                    >
                        ×
                    </button>
                </div>

                {/* Waveform Canvas */}
                <div style={{ position: 'relative' }}>
                    <canvas
                        ref={canvasRef}
                        width={680}
                        height={140}
                        style={{ width: '100%', height: '140px', borderRadius: '8px', cursor: 'crosshair', display: 'block' }}
                        onMouseDown={handleCanvasMouseDown}
                        onMouseMove={handleCanvasMouseMove}
                        onMouseUp={handleCanvasMouseUp}
                        onMouseLeave={handleCanvasMouseUp}
                    />
                    {!audioBuffer && (
                        <div style={{
                            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: '#718096', fontSize: '13px',
                        }}>
                            {statusMsg || '波形を読み込み中...'}
                        </div>
                    )}
                </div>

                {/* Time Info */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#718096' }}>
                    <span>現在: {formatTime(currentTimeSec)}</span>
                    <span>選択: {formatTime(trimStartSec)} ～ {formatTime(trimEndSec)} ({formatTime(trimEndSec - trimStartSec)})</span>
                    <span>合計: {formatTime(duration)}</span>
                </div>

                {/* Trim hint */}
                <div style={{ fontSize: '11px', color: '#4a5568' }}>
                    黄色マーカーをドラッグしてトリム範囲を調整 / 波形クリックで再生位置を変更
                </div>

                {/* App Capture Recording */}
                <div style={{ padding: '8px', borderRadius: '8px', border: '1px solid #334155', background: '#111827' }}>
                    <div style={{ fontSize: '11px', color: '#cbd5e1', marginBottom: '6px' }}>
                        特定アプリ録音（音声キャプチャ流用）
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <select
                            value={selectedCaptureProcessPid ?? ''}
                            onChange={(e) => setSelectedCaptureProcessPid(e.target.value ? Number(e.target.value) : null)}
                            disabled={isAppRecording}
                            style={{ flex: 1, minWidth: '260px' }}
                        >
                            <option value="">録音対象アプリを選択</option>
                            {sortedAudioProcesses.map((proc) => (
                                <option key={proc.pid} value={proc.pid}>
                                    {`${proc.title?.trim() || proc.name} (PID:${proc.pid})`}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={() => { void refreshAudioProcesses(); }}
                            disabled={isRefreshingAudioProcesses || isAppRecording}
                            style={{ padding: '7px 10px', borderRadius: '6px', border: '1px solid #4a5568', background: '#2d3748', color: '#cbd5e1', cursor: (isRefreshingAudioProcesses || isAppRecording) ? 'not-allowed' : 'pointer', opacity: (isRefreshingAudioProcesses || isAppRecording) ? 0.7 : 1, fontSize: '12px' }}
                        >
                            {isRefreshingAudioProcesses ? '更新中...' : '更新'}
                        </button>
                        <button
                            onClick={() => { void handleToggleAppRecording(); }}
                            disabled={isRefreshingAudioProcesses || (!isAppRecording && !selectedCaptureProcessPid)}
                            style={{
                                padding: '7px 12px',
                                borderRadius: '6px',
                                border: `1px solid ${isAppRecording ? '#fca5a5' : '#86efac'}`,
                                background: isAppRecording ? '#3f1d1d' : '#17321f',
                                color: isAppRecording ? '#fca5a5' : '#86efac',
                                cursor: (isRefreshingAudioProcesses || (!isAppRecording && !selectedCaptureProcessPid)) ? 'not-allowed' : 'pointer',
                                opacity: (isRefreshingAudioProcesses || (!isAppRecording && !selectedCaptureProcessPid)) ? 0.7 : 1,
                                fontSize: '12px',
                                fontWeight: 'bold',
                            }}
                            title="トグルで録音開始/停止。停止時にWAVを波形エディタへ読み込みます。"
                        >
                            {isAppRecording ? '■ 録音停止' : '● 録音開始'}
                        </button>
                    </div>
                    <div style={{ fontSize: '11px', color: isAppRecording ? '#fca5a5' : '#94a3b8', marginTop: '6px', wordBreak: 'break-all' }}>
                        {appRecordingStatus || 'トグルで特定アプリの音声録音を開始/停止します。'}
                    </div>
                </div>

                {/* Playback Controls */}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                        onClick={handlePlay}
                        disabled={!audioBuffer}
                        style={{ padding: '7px 16px', borderRadius: '6px', border: '1px solid #4a5568', background: isPlaying ? '#2d4a70' : '#2d3748', color: '#e2e8f0', cursor: audioBuffer ? 'pointer' : 'not-allowed', fontSize: '13px' }}
                    >
                        {isPlaying ? '⏸ Pause' : '▶ Play'}
                    </button>
                    <button
                        onClick={handleStop}
                        disabled={!audioBuffer}
                        style={{ padding: '7px 14px', borderRadius: '6px', border: '1px solid #4a5568', background: '#2d3748', color: '#e2e8f0', cursor: audioBuffer ? 'pointer' : 'not-allowed', fontSize: '13px' }}
                    >
                        ■ Stop
                    </button>
                    <div style={{ flex: 1 }} />
                    <button
                        onClick={handleLoadWav}
                        style={{ padding: '7px 14px', borderRadius: '6px', border: '1px solid #4a5568', background: '#2d3748', color: '#a0aec0', cursor: 'pointer', fontSize: '13px' }}
                    >
                        Load WAV
                    </button>
                    <button
                        onClick={() => { void handleSpeakerDiarization(); }}
                        disabled={!audioBuffer || isSpeakerAnalyzing}
                        style={{ padding: '7px 14px', borderRadius: '6px', border: '1px solid #f6e05e', background: '#3c3313', color: '#f6e05e', cursor: (!audioBuffer || isSpeakerAnalyzing) ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: (!audioBuffer || isSpeakerAnalyzing) ? 0.7 : 1 }}
                        title="選択範囲を話者タグ付き文字起こし（話者分離解析）"
                    >
                        {isSpeakerAnalyzing ? '話者分離中...' : '話者分離'}
                    </button>
                    <button
                        onClick={() => { void handleRvcConvert(); }}
                        disabled={!audioBuffer || isRvcConverting}
                        style={{ padding: '7px 14px', borderRadius: '6px', border: '1px solid #60a5fa', background: '#102b46', color: '#93c5fd', cursor: (!audioBuffer || isRvcConverting) ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: (!audioBuffer || isRvcConverting) ? 0.7 : 1 }}
                        title="選択範囲を現在のRVC設定で変換"
                    >
                        {isRvcConverting ? 'RVC変換中...' : 'RVC変換'}
                    </button>
                    <button
                        onClick={() => { void handleSaveToTraining(); }}
                        disabled={!audioBuffer}
                        style={{ padding: '7px 14px', borderRadius: '6px', border: '1px solid #68d391', background: '#1a3a2a', color: '#68d391', cursor: audioBuffer ? 'pointer' : 'not-allowed', fontSize: '13px', fontWeight: 'bold' }}
                    >
                        Save to Training
                    </button>
                </div>

                {/* Status */}
                {statusMsg && audioBuffer && (
                    <div style={{ fontSize: '11px', color: '#a0aec0', padding: '4px 8px', background: '#2d3748', borderRadius: '4px', wordBreak: 'break-all' }}>
                        {statusMsg}
                    </div>
                )}
                {speakerDiarizationText && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div style={{ fontSize: '11px', color: '#cbd5e1' }}>話者分離結果（話者タグ解析）</div>
                        <textarea
                            readOnly
                            value={speakerDiarizationText}
                            rows={8}
                            style={{
                                width: '100%',
                                resize: 'vertical',
                                borderRadius: '6px',
                                border: '1px solid #334155',
                                background: '#0f172a',
                                color: '#e2e8f0',
                                fontSize: '11px',
                                lineHeight: 1.45,
                                padding: '8px',
                                boxSizing: 'border-box',
                            }}
                        />
                    </div>
                )}
        </div>
    ), [
        currentFileName,
        audioBuffer,
        trimStartSec,
        trimEndSec,
        duration,
        currentTimeSec,
        trimStartRatio,
        trimEndRatio,
        statusMsg,
        isPlaying,
        handleCanvasMouseDown,
        handleCanvasMouseMove,
        handleCanvasMouseUp,
        handlePlay,
        handleStop,
        selectedCaptureProcessPid,
        sortedAudioProcesses,
        isRefreshingAudioProcesses,
        isAppRecording,
        appRecordingStatus,
        refreshAudioProcesses,
        handleToggleAppRecording,
        handleLoadWav,
        handleSpeakerDiarization,
        handleRvcConvert,
        handleSaveToTraining,
        onClose,
        isSpeakerAnalyzing,
        isRvcConverting,
        speakerDiarizationText,
    ]);

    if (popupReady && popupContainerRef.current) {
        return createPortal(editorPanel, popupContainerRef.current);
    }

    return (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, width: 'min(820px, calc(100vw - 32px))' }}>
            {editorPanel}
        </div>
    );
};
