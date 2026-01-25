import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AudioDeviceSelector } from '../../components/AudioDeviceSelector';
import { ToggleSwitch } from '../../components/ToggleSwitch';
import { LogView } from '../../components/LogView';
import { ResearchPanel } from '../../components/ResearchPanel';
import { ResearchButton } from '../../components/ResearchButton';
import { audioCaptureService } from '../../services/audioCapture';
import { speechToTextService } from '../../services/speechToText';
import { webSpeechToTextService } from '../../services/webSpeechToText';
import { researchService } from '../../services/research';
import type { AudioDevice, AudioProcess, LogEntry, ResearchResult } from '../../types';

// ユニークID生成
const generateId = (): string => {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

// 音声認識モード
type SpeechMode = 'webSpeech' | 'gemini' | 'gcp' | 'whisper';

// キャプチャソース
type CaptureSource = 'device' | 'system' | 'app';

// 音声コンテキストタグ
type AudioContextTag = 'meeting' | 'presentation' | 'phone' | 'lecture' | 'news' | 'free';

// コンテキストタグ定義（GCPヒント用）
const CONTEXT_TAGS: { value: AudioContextTag; label: string; hints: string[] }[] = [
    { value: 'free', label: '🆓 指定なし', hints: [] },
    { value: 'meeting', label: '🤝 会議', hints: ['議題', '決定事項', 'アクションアイテム', '確認', '承認', '検討'] },
    { value: 'presentation', label: '📊 プレゼン', hints: ['スライド', '資料', '次ページ', 'ご覧ください', '説明'] },
    { value: 'phone', label: '📞 電話', hints: ['もしもし', 'お電話', '折り返し', 'ご連絡', 'お忙しい'] },
    { value: 'lecture', label: '📚 講義', hints: ['重要', 'ポイント', '覚えて', '例えば', '要約すると'] },
    { value: 'news', label: '📺 ニュース', hints: ['速報', '報道', 'ニュース', '発表', '情報'] },
];

const CaptureScreen: React.FC = () => {
    const navigate = useNavigate();

    // State
    const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
    const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
    const [isCapturing, setIsCapturing] = useState(false);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [selectedText, setSelectedText] = useState('');
    const [researchResult, setResearchResult] = useState<ResearchResult | null>(null);
    const [isResearching, setIsResearching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isInitialized, setIsInitialized] = useState(false);
    const [speechMode, setSpeechMode] = useState<SpeechMode>('gcp');
    const [interimText, setInterimText] = useState('');
    const [isAppPlaying, setIsAppPlaying] = useState(false); // 新規: アプリ内再生中フラグ
    const [captureSource, setCaptureSource] = useState<CaptureSource>('device');
    const [audioProcesses, setAudioProcesses] = useState<AudioProcess[]>([]);
    const [selectedProcessPid, setSelectedProcessPid] = useState<number | null>(null);
    const [includeMic, setIncludeMic] = useState(false); // 特定アプリキャプチャ時にマイクも含める
    const [audioContextTag, setAudioContextTag] = useState<AudioContextTag>('free'); // 音声コンテキストタグ
    const [customTopic, setCustomTopic] = useState(''); // カスタムトピック（例: 経済, IT, 自動車）
    const [currentSessionPath, setCurrentSessionPath] = useState<string | null>(null);


    // 初期化
    useEffect(() => {
        const initialize = async () => {
            try {
                // API キー取得
                const apiKey = await window.electronAPI.getApiKey();

                // Auto-Save セッション開始
                const sessionResult = await window.electronAPI.startSession();
                if (sessionResult.success && sessionResult.sessionPath) {
                    setCurrentSessionPath(sessionResult.sessionPath);
                    console.log('Session started:', sessionResult.sessionPath);
                }

                if (!apiKey) {
                    setError('Gemini API キーが設定されていません。.env ファイルを確認してください。');
                    return;
                }

                // サービス初期化
                speechToTextService.initialize(apiKey);
                researchService.initialize(apiKey);

                // オーディオデバイス一覧取得
                await refreshAudioDevices();

                setIsInitialized(true);
            } catch (err) {
                console.error('Initialization error:', err);
                setError('初期化に失敗しました。');
            }
        };

        initialize();

        // クリーンアップ
        return () => {
            audioCaptureService.stopCapture();
            webSpeechToTextService.stopListening();
        };
    }, []);

    // オーディオデバイス一覧を更新
    const refreshAudioDevices = useCallback(async () => {
        try {
            const devices = await audioCaptureService.getAudioDevices();
            const deviceList: AudioDevice[] = devices.map(d => ({
                deviceId: d.deviceId,
                label: d.label,
                kind: d.kind,
            }));
            setAudioDevices(deviceList);

            // デフォルト選択 (未選択かつデバイスがある場合)
            if (deviceList.length > 0) {
                setSelectedDeviceId(prev => prev || deviceList[0].deviceId);
            }
        } catch (err) {
            console.error('Failed to get audio devices:', err);
            setError('オーディオデバイス一覧の取得に失敗しました。');
        }
    }, []);

    // 音声出力中のプロセス一覧を更新
    const refreshAudioProcesses = useCallback(async () => {
        try {
            const result = await window.electronAPI.getAudioProcesses();
            if (result.success && result.processes) {
                setAudioProcesses(result.processes);
            } else {
                console.error('Failed to get audio processes:', result.error);
            }
        } catch (err) {
            console.error('Failed to get audio processes:', err);
        }
    }, []);

    const addLogEntry = useCallback(async (
        text: string,
        speakerTag?: number,
        audioBuffer?: number[],
        sampleRate?: number,
        channels?: number,
        isEdited: boolean = false,
        customLabel?: string
    ) => {
        if (!text.trim()) return;

        const id = generateId();
        const entry: LogEntry = {
            id,
            timestamp: new Date(),
            text: text.trim(),
            speakerTag,
            audioBuffer,
            sampleRate,
            channels,
            isEdited,
            customLabel
        };

        // Auto-Save: 個別の音声チャンク保存は廃止（連続録音ファイルがあるため不要＆重い）
        /*
        if (audioBuffer && audioBuffer.length > 0) {
            try {
                const result = await window.electronAPI.saveAudioChunk(id, audioBuffer, sampleRate || 16000, channels || 1);
                if (result.success && result.filePath) {
                    entry.audioFile = result.filePath;
                }
            } catch (e) {
                console.error('Auto-save audio failed:', e);
            }
        }
        */

        setLogs((prev) => {
            const updatedLogs = [...prev, entry];

            // Auto-Save: JSONを更新 (Fire & Forget)
            // ここでaudioBufferなどの巨大データを含むとIPCが重くなるため、
            // 保存用の軽量なオブジェクトを作成して送る
            const logsToSave = updatedLogs.map(log => {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { audioBuffer, ...logWithoutBuffer } = log;
                return logWithoutBuffer;
            });

            window.electronAPI.updateLogsJson(logsToSave).catch(e => console.error('Auto-save JSON failed:', e));
            return updatedLogs;
        });
    }, []);

    // ログエントリを編集
    const handleEditLog = useCallback((id: string, newText: string) => {
        setLogs((prev) => prev.map(log =>
            log.id === id
                ? { ...log, text: newText, isEdited: true }
                : log
        ));
    }, []);

    // キャプチャ開始/停止
    const handleToggle = useCallback(async (isOn: boolean) => {
        if (isOn) {
            setError(null);

            if (speechMode === 'webSpeech') {
                // Web Speech API モード（マイク入力）
                if (!webSpeechToTextService.isSupported()) {
                    setError('Web Speech API はこのブラウザでサポートされていません。');
                    return;
                }

                webSpeechToTextService.startListening({
                    onResult: (text, isFinal) => {
                        if (isFinal) {
                            addLogEntry(text);
                            setInterimText('');
                        } else {
                            setInterimText(text);
                        }
                    },
                    onError: (err) => {
                        console.error('Web Speech error:', err);
                        setError(err.message);
                        setIsCapturing(false);
                    },
                });
                setIsCapturing(true);
            } else if (speechMode === 'gcp') {
                // Google Cloud Speech-to-Text モード
                if (captureSource === 'device' && !selectedDeviceId) {
                    setError('オーディオデバイスを選択してください。');
                    return;
                }
                if (captureSource === 'app' && !selectedProcessPid) {
                    setError('アプリを選択してください。');
                    return;
                }

                try {
                    setIsCapturing(true); // 即座にフラグを立てて二重起動防止

                    if (captureSource === 'system') {
                        // システム音声 + マイク (GCPモード)
                        let audioBuffer: number[] = [];
                        let micAudioBuffer: number[] = [];
                        let lastTranscribeTime = Date.now();
                        const TRANSCRIBE_INTERVAL = 10000;

                        const micDeviceId = selectedDeviceId ? selectedDeviceId : undefined;

                        await audioCaptureService.startCaptureFromSystemAudio({
                            onError: (err) => {
                                console.error('Audio capture error:', err);
                                setError(err.message);
                                setIsCapturing(false);
                            },
                            onRawAudioData: async (data) => {
                                if (data.source === 'mic') {
                                    micAudioBuffer = micAudioBuffer.concat(data.buffer);
                                } else {
                                    // アプリ内で音声再生中はキャプチャしない (自己ループ防止)
                                    if (!isAppPlaying) {
                                        audioBuffer = audioBuffer.concat(data.buffer);
                                    }
                                }

                                const now = Date.now();
                                const diff = now - lastTranscribeTime;

                                if (diff >= TRANSCRIBE_INTERVAL) {
                                    lastTranscribeTime = now;

                                    // 1. システム音声 (GCP)
                                    if (audioBuffer.length > 0) {
                                        const bufferToSend = [...audioBuffer];
                                        audioBuffer = []; // CLEAR

                                        try {
                                            // Int16[] -> Uint8[] に変換して送信 (IPCでのデータ破損防止)
                                            const i16 = new Int16Array(bufferToSend);
                                            const u8 = new Uint8Array(i16.buffer);
                                            const bytesToSend = Array.from(u8);

                                            const result = await window.electronAPI.transcribeLinear16(
                                                bytesToSend,
                                                data.sampleRate,
                                                data.channels
                                            );
                                            if (result.success && result.text) {
                                                // 修正: 再生・保存用にバイト配列とサンプルレートを渡す
                                                addLogEntry(result.text, undefined, bytesToSend, data.sampleRate, data.channels);
                                            }
                                        } catch (err) {
                                            console.error('[GCP/System] Error:', err);
                                        }
                                    }

                                    // 2. マイク音声 (GCP)
                                    if (micAudioBuffer.length > 0) {
                                        const bufferToSend = [...micAudioBuffer];
                                        micAudioBuffer = []; // CLEAR

                                        try {
                                            // Int16[] -> Uint8[] に変換
                                            const i16 = new Int16Array(bufferToSend);
                                            const u8 = new Uint8Array(i16.buffer);
                                            const bytesToSend = Array.from(u8);

                                            const result = await window.electronAPI.transcribeLinear16(
                                                bytesToSend,
                                                data.sampleRate,
                                                data.channels
                                            );
                                            if (result.success && result.text) {
                                                // 修正: 再生・保存用にバイト配列とサンプルレートを渡す
                                                // マイクとしてラベル付け
                                                addLogEntry(result.text, undefined, bytesToSend, data.sampleRate, data.channels, false, 'マイク');
                                            }
                                        } catch (err) {
                                            console.error('[GCP/Mic] Error:', err);
                                        }
                                    }
                                }
                            }
                        }, micDeviceId);
                    } else if (captureSource === 'app') {
                        // プロセスが選択されている場合のみプロセスキャプチャを開始
                        if (selectedProcessPid) {
                            // プロセスキャプチャを開始（連続録音ファイル方式）
                            const startResult = await window.electronAPI.startProcessCapture(selectedProcessPid);
                            if (!startResult.success) {
                                throw new Error(startResult.error || 'プロセスキャプチャの開始に失敗しました');
                            }

                            // 連続録音方式: ファイルに録音し、10秒ごとにセグメントを読み取って文字起こし
                            let lastTranscribedSamples = 0;
                            let lastTranscribeTime = Date.now();
                            const TRANSCRIBE_INTERVAL = 10000;
                            let isTranscribing = false;

                            window.electronAPI.onProcessAudioMetadata((metadata) => {
                                const now = Date.now();
                                const newSamples = metadata.totalSamples - lastTranscribedSamples;
                                const minSamples = metadata.sampleRate * 5; // 最低5秒分

                                if (now - lastTranscribeTime >= TRANSCRIBE_INTERVAL && newSamples >= minSamples && !isTranscribing) {
                                    const startSample = lastTranscribedSamples;
                                    const endSample = metadata.totalSamples;
                                    lastTranscribedSamples = endSample;
                                    lastTranscribeTime = now;

                                    // UIスレッドをブロックしないよう非同期で実行
                                    isTranscribing = true;
                                    setTimeout(async () => {
                                        try {
                                            const result = await window.electronAPI.transcribeRecordingSegment(startSample, endSample);

                                            if (result.success && result.text) {
                                                // 音声バッファも取得できるので再生可能
                                                addLogEntry(result.text, undefined, result.audioBuffer, metadata.sampleRate, metadata.channels);
                                            }
                                        } catch (err) {
                                            console.error('[App] Failed to transcribe segment:', err);
                                        } finally {
                                            isTranscribing = false;
                                        }
                                    }, 0);
                                }
                            });
                        }

                        // includeMic がオンの場合、マイク音声も同時にキャプチャ（連続録音方式）
                        if (includeMic && selectedDeviceId) {
                            // マイク連続録音を開始
                            const micStartResult = await window.electronAPI.startMicContinuousRecording();
                            if (!micStartResult.success) {
                                console.error('[App] Failed to start mic continuous recording:', micStartResult.error);
                            }

                            let lastMicTranscribedSamples = 0;
                            let lastMicTranscribeTime = Date.now();
                            const MIC_TRANSCRIBE_INTERVAL = 15000;
                            let isMicTranscribing = false;

                            // IPC呼び出し頻度を下げるためのバッファリング
                            let micLocalBuffer: number[] = [];
                            let lastMicFlushTime = Date.now();
                            const MIC_FLUSH_INTERVAL = 1000; // 1秒ごとにフラッシュ
                            let currentMicSampleRate = 44100;
                            let totalMicSamples = 0;

                            await audioCaptureService.startMicOnlyCapture(selectedDeviceId, {
                                onError: (err) => console.error('[App] Mic capture error:', err),
                                onRawAudioData: (data) => {
                                    // ローカルバッファに蓄積（IPCを毎回呼ばない）
                                    micLocalBuffer.push(...data.buffer);
                                    currentMicSampleRate = data.sampleRate;

                                    const now = Date.now();
                                    // 1秒ごとにメインプロセスに送信
                                    if (now - lastMicFlushTime >= MIC_FLUSH_INTERVAL && micLocalBuffer.length > 0) {
                                        const bufferToSend = micLocalBuffer;
                                        micLocalBuffer = [];
                                        lastMicFlushTime = now;

                                        // IPCを非同期で実行（UIブロックしない）
                                        window.electronAPI.appendMicAudio(bufferToSend, currentMicSampleRate, 1).then((appendResult) => {
                                            if (!appendResult.success) return;
                                            totalMicSamples = appendResult.totalSamples || 0;

                                            const newSamples = totalMicSamples - lastMicTranscribedSamples;
                                            const minSamples = currentMicSampleRate * 5; // 最低5秒分

                                            if (Date.now() - lastMicTranscribeTime >= MIC_TRANSCRIBE_INTERVAL && newSamples >= minSamples && !isMicTranscribing) {
                                                const startSample = lastMicTranscribedSamples;
                                                const endSample = totalMicSamples;
                                                lastMicTranscribedSamples = endSample;
                                                lastMicTranscribeTime = Date.now();

                                                // 文字起こしを非同期で実行
                                                isMicTranscribing = true;
                                                setTimeout(async () => {
                                                    try {
                                                        const result = await window.electronAPI.transcribeMicSegment(startSample, endSample);
                                                        if (result.success && result.text) {
                                                            addLogEntry(result.text, undefined, result.audioBuffer, currentMicSampleRate, 1, false, 'マイク');
                                                        }
                                                    } catch (e) {
                                                        console.error('[App] Mic transcribe segment error:', e);
                                                    } finally {
                                                        isMicTranscribing = false;
                                                    }
                                                }, 0);
                                            }
                                        });
                                    }
                                }
                            });
                        }
                    } else {
                        // マイクのみキャプチャ (GCP)
                        const audioCallbacks = {
                            onAudioData: async (audioBlob: Blob) => {
                                try {
                                    const buffer = await audioBlob.arrayBuffer();
                                    const result = await window.electronAPI.transcribeAudio(buffer);
                                    if (result.success && result.text) {
                                        addLogEntry(result.text);
                                    }
                                } catch (err) {
                                    console.error('GCP Transcription error:', err);
                                }
                            },
                            onError: (err: Error) => {
                                console.error('Audio capture error:', err);
                                setError(err.message);
                                setIsCapturing(false);
                            },
                        };
                        await audioCaptureService.startCaptureFromDevice(selectedDeviceId!, audioCallbacks);
                    }
                } catch (err) {
                    console.error('Failed to start capture:', err);
                    setError(err instanceof Error ? err.message : 'キャプチャの開始に失敗しました。');
                    setIsCapturing(false);
                }
            } else {
                // Gemini API モード
                if (captureSource === 'device' && !selectedDeviceId) {
                    setError('オーディオデバイスを選択してください。');
                    return;
                }
                if (captureSource === 'app' && !selectedProcessPid) {
                    setError('アプリを選択してください。');
                    return;
                }

                try {
                    const audioCallbacks = {
                        onAudioData: async (audioBlob: Blob) => {
                            try {
                                const text = await speechToTextService.transcribe(audioBlob);
                                if (text) {
                                    addLogEntry(text);
                                }
                            } catch (err) {
                                console.error('Transcription error:', err);
                            }
                        },
                        onError: (err: Error) => {
                            console.error('Audio capture error:', err);
                            setError(err.message);
                            setIsCapturing(false);
                        },
                    };

                    if (captureSource === 'system') {
                        // システム音声 + マイクのキャプチャ（PCMデータとして処理）
                        let audioBuffer: number[] = [];
                        let micAudioBuffer: number[] = []; // マイク用バッファ
                        let lastTranscribeTime = Date.now();
                        const TRANSCRIBE_INTERVAL = 15000;

                        // 選択されたデバイスIDを渡す（なければundefined）
                        const micDeviceId = selectedDeviceId ? selectedDeviceId : undefined;

                        await audioCaptureService.startCaptureFromSystemAudio({
                            onError: (err) => {
                                console.error('Audio capture error:', err);
                                setError(err.message);
                                setIsCapturing(false);
                            },
                            onRawAudioData: async (data) => {
                                // Debug: データの到着を確認 (頻度が高いのでコメントアウト推奨だがデバッグ中は出す)
                                // if (Math.random() < 0.05) console.log('[App] Audio Data incoming:', data.source, data.buffer.length);

                                if (data.source === 'mic') {
                                    micAudioBuffer = micAudioBuffer.concat(data.buffer);
                                } else {
                                    audioBuffer = audioBuffer.concat(data.buffer);
                                }

                                const now = Date.now();
                                const diff = now - lastTranscribeTime;

                                if (diff >= TRANSCRIBE_INTERVAL) {
                                    lastTranscribeTime = now;

                                    // 1. システム音声の処理
                                    if (audioBuffer.length > 0) {
                                        const bufferToSend = [...audioBuffer];
                                        audioBuffer = [];

                                        try {
                                            const pcmData = new Int16Array(bufferToSend);
                                            const audioBlob = new Blob([pcmData], { type: 'audio/wav' });

                                            speechToTextService.transcribe(audioBlob).then(text => {
                                                if (text) {
                                                    addLogEntry(text, undefined, bufferToSend);
                                                }
                                            }).catch(err => console.error('[Gemini/System] Transcription error:', err));
                                        } catch (err) {
                                            console.error('[Gemini/System] Error:', err);
                                        }
                                    }

                                    // 2. マイク音声の処理
                                    if (micAudioBuffer.length > 0) {
                                        const bufferToSend = [...micAudioBuffer];
                                        micAudioBuffer = [];

                                        try {
                                            const pcmData = new Int16Array(bufferToSend);
                                            const audioBlob = new Blob([pcmData], { type: 'audio/wav' });

                                            speechToTextService.transcribe(audioBlob).then(text => {
                                                if (text) {
                                                    // マイクとしてラベル付け
                                                    addLogEntry(text, undefined, bufferToSend, undefined, undefined, false, 'マイク');
                                                }
                                            }).catch(err => console.error('[Gemini/Mic] Transcription error:', err));
                                        } catch (err) {
                                            console.error('[Gemini/Mic] Error:', err);
                                        }
                                    }
                                }
                            }
                        }, micDeviceId);
                    } else if (captureSource === 'app') {
                        // Geminiモードでのプロセスキャプチャ
                        const startResult = await window.electronAPI.startProcessCapture(selectedProcessPid!);
                        if (!startResult.success) {
                            throw new Error(startResult.error || 'プロセスキャプチャの開始に失敗しました');
                        }

                        // 30秒ごとにGemini APIでテキスト化（コメント修正忘れずに）
                        let audioBuffer: number[] = [];
                        let lastTranscribeTime = Date.now();
                        const TRANSCRIBE_INTERVAL = 15000;

                        window.electronAPI.onProcessAudioData(async (data) => {
                            audioBuffer = audioBuffer.concat(data.buffer);

                            const now = Date.now();
                            if (now - lastTranscribeTime >= TRANSCRIBE_INTERVAL && audioBuffer.length > 0) {
                                lastTranscribeTime = now;
                                const bufferToSend = [...audioBuffer];
                                audioBuffer = [];

                                try {
                                    // PCMデータをWAV Blobに変換
                                    const uint8Array = new Uint8Array(bufferToSend);
                                    const audioBlob = new Blob([uint8Array], { type: 'audio/wav' });
                                    const text = await speechToTextService.transcribe(audioBlob);
                                    if (text) {
                                        addLogEntry(text, undefined, bufferToSend);
                                    }
                                } catch (err) {
                                    console.error('[Gemini] Transcription error:', err);
                                }
                            }
                        });
                    } else {
                        await audioCaptureService.startCaptureFromDevice(selectedDeviceId!, audioCallbacks);
                    }
                    setIsCapturing(true);
                } catch (err) {
                    console.error('Failed to start capture:', err);
                    setError(err instanceof Error ? err.message : 'キャプチャの開始に失敗しました。');
                    setIsCapturing(false);
                }
            }
        } else {
            // 停止
            try {
                if (speechMode === 'webSpeech') {
                    webSpeechToTextService.stopListening();
                    setInterimText('');
                } else {
                    if (captureSource === 'app') {
                        try {
                            await window.electronAPI.stopProcessCapture();
                        } catch (err) {
                            console.error('[App] Error stopping process capture:', err);
                        }
                        try {
                            window.electronAPI.offProcessAudioData();
                        } catch (err) {
                            console.error('[App] Error removing audio listener:', err);
                        }
                        // マイクキャプチャも停止 (AudioCaptureServiceを使用するように変更したため)
                        await audioCaptureService.stopCapture();
                    } else {
                        await audioCaptureService.stopCapture();
                    }
                }
            } catch (err) {
                console.error('[App] Error during stop:', err);
            }

            setIsCapturing(false);
        }
    }, [selectedDeviceId, selectedProcessPid, addLogEntry, speechMode, captureSource]);

    // テキスト選択
    const handleTextSelect = useCallback((text: string) => {
        setSelectedText(text);
    }, []);

    // 調査実行
    const handleResearch = useCallback(async () => {
        if (!selectedText.trim()) return;

        setIsResearching(true);
        setError(null);

        try {
            const result = await researchService.research(selectedText);
            setResearchResult(result);
        } catch (err) {
            console.error('Research error:', err);
            setResearchResult({
                query: selectedText,
                summary: '',
                details: [],
                error: err instanceof Error ? err.message : '調査中にエラーが発生しました。',
            });
        } finally {
            setIsResearching(false);
        }
    }, [selectedText]);

    // デバイス変更時
    const handleDeviceChange = useCallback(async (deviceId: string) => {
        // キャプチャ中なら停止
        if (isCapturing) {
            await audioCaptureService.stopCapture();
            setIsCapturing(false);
        }
        setSelectedDeviceId(deviceId);
    }, [isCapturing]);

    // ログ保存（フォルダを開く）
    const handleSaveLogs = useCallback(async () => {
        if (currentSessionPath) {
            await window.electronAPI.openFolder(currentSessionPath);
        } else {
            // セッションがない場合（旧互換）、これまでの保存処理をするかエラーにする
            setError('セッションがありません。データは一時バッファのみです。');
            // ここで以前のZIP保存処理をフォールバックとして残してもいいが、
            // 基本的にセッションはあるはず。
        }
    }, [currentSessionPath]);

    // ログを読み込み
    const handleLoadLogs = useCallback(async () => {
        try {
            const result = await window.electronAPI.loadLogs();
            if (result.success && result.logs) {
                // ISO文字列をDateに復元
                const deserializedLogs = result.logs.map(log => ({
                    ...log,
                    timestamp: new Date(log.timestamp),
                }));
                setLogs(deserializedLogs);
                console.log('Logs loaded from:', result.filePath);

                // ロードしたファイルの親ディレクトリをセッションパスとして設定
                // これにより、相対パスで保存された音声ファイルを正しく読み込める
                if (result.filePath) {
                    // logs.json の親ディレクトリがセッションパス
                    const sessionDir = result.filePath.replace(/[/\\][^/\\]+$/, '');
                    setCurrentSessionPath(sessionDir);
                    console.log('Session path set from loaded file:', sessionDir);

                    // メインプロセスにもセッションパスを設定（フォルダ作成なし）
                    await window.electronAPI.setSessionPath(sessionDir);
                }
            } else if (result.error) {
                setError(`読み込みエラー: ${result.error}`);
            }
        } catch (err) {
            console.error('Load logs error:', err);
            setError('ログの読み込みに失敗しました。');
        }
    }, []);

    // ログの音声を各行ごとに再テキスト化（タイムスタンプ・構造を維持）
    const handleReTranscribe = useCallback(async () => {
        // 音声データを持つログのみ取得
        const audioLogs = logs.filter(log => log.audioBuffer && log.audioBuffer.length > 0);
        if (audioLogs.length === 0) {
            setError('再テキスト化する音声データがありません。');
            return;
        }

        try {
            console.log('[App] Re-transcribing', audioLogs.length, 'log entries individually');

            // 既存のテキストをコンテキストとして構築（前後の文脈情報）
            const contextText = logs.map(log => log.text).join(' ');
            console.log('[App] Context text for re-transcription:', contextText.substring(0, 100), '...');

            // 各ログエントリを個別に再テキスト化
            const updatedLogs: LogEntry[] = [];

            for (const log of logs) {
                if (log.audioBuffer && log.audioBuffer.length > 0) {
                    try {
                        console.log('[App] Re-transcribing entry:', log.id, 'audio size:', log.audioBuffer.length);

                        const result = await window.electronAPI.transcribeLinear16(
                            log.audioBuffer,
                            log.sampleRate || 44100,
                            log.channels || 2
                        );

                        if (result.success && result.text) {
                            // テキストが改善された場合のみ更新
                            const newText = result.text.trim();
                            const oldText = log.text.trim();

                            // テキストが変化したかチェック
                            const textChanged = newText !== oldText;

                            updatedLogs.push({
                                ...log,
                                text: textChanged ? `${newText} (旧: ${oldText.substring(0, 20)}...)` : log.text,
                            });
                            console.log('[App] Updated entry:', log.id, textChanged ? 'changed' : 'unchanged');
                        } else {
                            // エラーの場合は元のログを維持
                            updatedLogs.push(log);
                            console.warn('[App] Re-transcribe failed for entry:', log.id, result.error);
                        }
                    } catch (err) {
                        // エラーの場合は元のログを維持
                        updatedLogs.push(log);
                        console.error('[App] Re-transcribe error for entry:', log.id, err);
                    }
                } else {
                    // 音声データがないログはそのまま維持
                    updatedLogs.push(log);
                }
            }

            // 更新されたログを設定
            setLogs(updatedLogs);
            console.log('[App] Re-transcription complete for all entries');

        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[App] Re-transcribe error:', errorMsg);
            setError(`再テキスト化に失敗しました: ${errorMsg}`);
        }
    }, [logs]);

    // 要約を生成
    const handleGenerateSummary = useCallback(async () => {
        if (logs.length === 0) {
            setError('要約するログがありません。');
            return;
        }

        try {
            setIsResearching(true);
            const allText = logs.map(log => log.text).join('\n');
            const tagLabel = CONTEXT_TAGS.find(t => t.value === audioContextTag)?.label || '';
            const context = [tagLabel, customTopic].filter(Boolean).join(' - ');

            const summary = await researchService.generateSummary(allText, context);

            setResearchResult({
                query: customTopic ? `要約 (トピック: ${customTopic})` : '要約',
                summary: summary,
                details: [],
            });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            setError(`要約生成に失敗しました: ${errorMsg}`);
        } finally {
            setIsResearching(false);
        }
    }, [logs, audioContextTag, customTopic]);

    // 議事録を生成
    const handleGenerateMeetingNotes = useCallback(async () => {
        if (logs.length === 0) {
            setError('議事録を生成するログがありません。');
            return;
        }

        try {
            setIsResearching(true);
            const allText = logs.map(log => log.text).join('\n');
            const tagLabel = CONTEXT_TAGS.find(t => t.value === audioContextTag)?.label || '';
            const context = [tagLabel, customTopic].filter(Boolean).join(' - ');

            const notes = await researchService.generateMeetingNotes(allText, context);

            setResearchResult({
                query: customTopic ? `議事録 (トピック: ${customTopic})` : '議事録',
                summary: notes,
                details: [],
            });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            setError(`議事録生成に失敗しました: ${errorMsg}`);
        } finally {
            setIsResearching(false);
        }
    }, [logs, audioContextTag, customTopic]);

    return (
        <div className="app-container">
            {/* Header - 二段構成 */}
            <header className="app-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
                {/* 1段目: タイトル + ファイル操作 + コンテキスト設定 */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <button
                            onClick={() => navigate('/')}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                fontSize: '1.2rem',
                                cursor: 'pointer',
                                padding: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                color: 'var(--color-text)',
                            }}
                            title="ホームへ戻る"
                        >
                            🏠
                        </button>
                        <h1 className="app-title" style={{ margin: 0 }}>音声キャプチャ・テキスト化</h1>
                    </div>
                    {/* 保存/読込ボタン + コンテキスト */}
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                            onClick={handleLoadLogs}
                            disabled={isCapturing}
                            title="ログを開く"
                            style={{
                                padding: '6px 10px',
                                borderRadius: '8px',
                                border: '1px solid var(--color-border)',
                                cursor: isCapturing ? 'not-allowed' : 'pointer',
                                background: 'var(--color-surface)',
                                color: 'var(--color-text-secondary)',
                                fontSize: '0.85rem',
                            }}
                        >
                            📂 開く
                        </button>
                        <button
                            onClick={handleSaveLogs}
                            disabled={!currentSessionPath}
                            title={currentSessionPath ? `保存先: ${currentSessionPath}` : '自動保存先フォルダを開く'}
                            style={{
                                padding: '6px 10px',
                                borderRadius: '8px',
                                border: '1px solid var(--color-border)',
                                cursor: !currentSessionPath ? 'not-allowed' : 'pointer',
                                background: 'var(--color-surface)',
                                color: 'var(--color-text-secondary)',
                                fontSize: '0.85rem',
                            }}
                        >
                            📂 保存先
                        </button>
                        <button
                            onClick={async () => {
                                const result = await window.electronAPI.selectSaveFolder();
                                if (result.success && result.path) {
                                    // 新しいセッションを開始
                                    const sessionResult = await window.electronAPI.startSession(result.path);
                                    if (sessionResult.success && sessionResult.sessionPath) {
                                        setCurrentSessionPath(sessionResult.sessionPath);
                                        setLogs([]); // ログをクリア
                                        alert(`保存先を変更しました:\n${sessionResult.sessionPath}`);
                                    }
                                }
                            }}
                            title="保存フォルダを選択"
                            style={{
                                padding: '6px 10px',
                                borderRadius: '8px',
                                border: '1px solid var(--color-border)',
                                cursor: 'pointer',
                                background: 'var(--color-primary)',
                                color: 'white',
                                fontSize: '0.85rem',
                            }}
                        >
                            📁 変更
                        </button>
                        {/* 音声コンテキストタグ選択 */}
                        <select
                            value={audioContextTag}
                            onChange={(e) => setAudioContextTag(e.target.value as AudioContextTag)}
                            title="音声の種類を選択（認識精度向上に使用）"
                            style={{
                                padding: '6px 10px',
                                borderRadius: '8px',
                                border: '1px solid var(--color-border)',
                                cursor: 'pointer',
                                background: 'var(--color-surface)',
                                color: 'var(--color-text)',
                                fontSize: '0.85rem',
                            }}
                        >
                            {CONTEXT_TAGS.map((tag) => (
                                <option key={tag.value} value={tag.value}>
                                    {tag.label}
                                </option>
                            ))}
                        </select>
                        {/* カスタムトピック入力 */}
                        <input
                            type="text"
                            value={customTopic}
                            onChange={(e) => setCustomTopic(e.target.value)}
                            placeholder="📌 トピック"
                            title="カスタムトピックを入力（要約・議事録に反映）"
                            style={{
                                padding: '6px 10px',
                                borderRadius: '8px',
                                border: '1px solid var(--color-border)',
                                background: 'var(--color-surface)',
                                color: 'var(--color-text)',
                                fontSize: '0.85rem',
                                width: '120px',
                            }}
                        />
                        {/* 要約・議事録生成ボタン */}
                        <button
                            onClick={handleGenerateSummary}
                            disabled={isResearching || logs.length === 0}
                            title="ログを要約"
                            style={{
                                padding: '6px 10px',
                                borderRadius: '8px',
                                border: 'none',
                                cursor: (isResearching || logs.length === 0) ? 'not-allowed' : 'pointer',
                                background: 'var(--color-primary)',
                                color: 'white',
                                opacity: (isResearching || logs.length === 0) ? 0.5 : 1,
                                fontSize: '0.85rem',
                            }}
                        >
                            📝 要約
                        </button>
                        <button
                            onClick={handleGenerateMeetingNotes}
                            disabled={isResearching || logs.length === 0}
                            title="議事録を生成"
                            style={{
                                padding: '6px 10px',
                                borderRadius: '8px',
                                border: 'none',
                                cursor: (isResearching || logs.length === 0) ? 'not-allowed' : 'pointer',
                                background: 'var(--color-secondary, #10b981)',
                                color: 'white',
                                opacity: (isResearching || logs.length === 0) ? 0.5 : 1,
                                fontSize: '0.85rem',
                            }}
                        >
                            📋 議事録
                        </button>
                    </div>
                </div>
                {/* 2段目: 音声認識モード + キャプチャソース + デバイス選択 + トグル */}
                <div className="header-controls" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    {/* 音声認識モード切り替え */}
                    <div style={{ display: 'flex', gap: '8px', marginRight: '16px' }}>
                        <button
                            onClick={() => setSpeechMode('webSpeech')}
                            disabled={isCapturing}
                            style={{
                                padding: '8px 16px',
                                borderRadius: '8px',
                                border: 'none',
                                cursor: isCapturing ? 'not-allowed' : 'pointer',
                                background: speechMode === 'webSpeech' ? 'var(--color-primary)' : 'var(--color-surface)',
                                color: speechMode === 'webSpeech' ? 'white' : 'var(--color-text-secondary)',
                                fontWeight: speechMode === 'webSpeech' ? 'bold' : 'normal',
                            }}
                        >
                            🎤 マイク
                        </button>
                        <button
                            onClick={() => setSpeechMode('gcp')}
                            disabled={isCapturing}
                            style={{
                                padding: '8px 16px',
                                borderRadius: '8px',
                                border: 'none',
                                cursor: isCapturing ? 'not-allowed' : 'pointer',
                                background: speechMode === 'gcp' ? 'var(--color-primary)' : 'var(--color-surface)',
                                color: speechMode === 'gcp' ? 'white' : 'var(--color-text-secondary)',
                                fontWeight: speechMode === 'gcp' ? 'bold' : 'normal',
                            }}
                        >
                            ☁️ Google Cloud
                        </button>
                        <button
                            onClick={() => setSpeechMode('gemini')}
                            disabled={isCapturing}
                            style={{
                                padding: '8px 16px',
                                borderRadius: '8px',
                                border: 'none',
                                cursor: isCapturing ? 'not-allowed' : 'pointer',
                                background: speechMode === 'gemini' ? 'var(--color-primary)' : 'var(--color-surface)',
                                color: speechMode === 'gemini' ? 'white' : 'var(--color-text-secondary)',
                                fontWeight: speechMode === 'gemini' ? 'bold' : 'normal',
                            }}
                        >
                            ✨ Gemini
                        </button>
                        <button
                            onClick={() => setSpeechMode('whisper')}
                            disabled={isCapturing}
                            style={{
                                padding: '8px 16px',
                                borderRadius: '8px',
                                border: 'none',
                                cursor: isCapturing ? 'not-allowed' : 'pointer',
                                background: speechMode === 'whisper' ? 'var(--color-primary)' : 'var(--color-surface)',
                                color: speechMode === 'whisper' ? 'white' : 'var(--color-text-secondary)',
                                fontWeight: speechMode === 'whisper' ? 'bold' : 'normal',
                            }}
                        >
                            🖥️ オフライン
                        </button>
                    </div>

                    {/* マイク以外の場合のみキャプチャソース選択を表示 */}
                    {speechMode !== 'webSpeech' && (
                        <>
                            {/* キャプチャソース切り替え */}
                            <div style={{ display: 'flex', gap: '4px', marginRight: '8px' }}>
                                <button
                                    onClick={() => setCaptureSource('device')}
                                    disabled={isCapturing}
                                    style={{
                                        padding: '6px 12px',
                                        borderRadius: '6px',
                                        border: 'none',
                                        cursor: isCapturing ? 'not-allowed' : 'pointer',
                                        background: captureSource === 'device' ? 'var(--color-secondary, #10b981)' : 'var(--color-surface)',
                                        color: captureSource === 'device' ? 'white' : 'var(--color-text-secondary)',
                                        fontSize: '0.85rem',
                                    }}
                                >
                                    🎤 デバイス
                                </button>
                                <button
                                    onClick={() => setCaptureSource('system')}
                                    disabled={isCapturing}
                                    style={{
                                        padding: '6px 12px',
                                        borderRadius: '6px',
                                        border: 'none',
                                        cursor: isCapturing ? 'not-allowed' : 'pointer',
                                        background: captureSource === 'system' ? 'var(--color-secondary, #10b981)' : 'var(--color-surface)',
                                        color: captureSource === 'system' ? 'white' : 'var(--color-text-secondary)',
                                        fontSize: '0.85rem',
                                    }}
                                >
                                    🔊 システム音声
                                </button>
                                <button
                                    onClick={() => { setCaptureSource('app'); refreshAudioProcesses(); }}
                                    disabled={isCapturing}
                                    style={{
                                        padding: '6px 12px',
                                        borderRadius: '6px',
                                        border: 'none',
                                        cursor: isCapturing ? 'not-allowed' : 'pointer',
                                        background: captureSource === 'app' ? 'var(--color-secondary, #10b981)' : 'var(--color-surface)',
                                        color: captureSource === 'app' ? 'white' : 'var(--color-text-secondary)',
                                        fontSize: '0.85rem',
                                    }}
                                >
                                    📦 特定アプリ
                                </button>
                            </div>
                            {/* デバイスモードの場合のみデバイス選択を表示 */}
                            {captureSource === 'device' && (
                                <AudioDeviceSelector
                                    devices={audioDevices}
                                    selectedDeviceId={selectedDeviceId}
                                    onDeviceChange={handleDeviceChange}
                                    disabled={isCapturing}
                                    onRefresh={refreshAudioDevices}
                                />
                            )}
                            {/* アプリモードの場合のみプロセス選択を表示 */}
                            {captureSource === 'app' && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div className="select-wrapper">
                                        <select
                                            className="select"
                                            value={selectedProcessPid ?? ''}
                                            onChange={(e) => setSelectedProcessPid(e.target.value ? Number(e.target.value) : null)}
                                            disabled={isCapturing}
                                        >
                                            <option value="" disabled>
                                                アプリを選択
                                            </option>
                                            {audioProcesses.map((proc) => (
                                                <option key={proc.pid} value={proc.pid}>
                                                    {proc.title || proc.name} (PID: {proc.pid})
                                                </option>
                                            ))}
                                        </select>
                                        <span className="select-arrow">▼</span>
                                    </div>
                                    <button
                                        className="btn btn-icon"
                                        onClick={refreshAudioProcesses}
                                        disabled={isCapturing}
                                        title="アプリ一覧を更新"
                                        style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)' }}
                                    >
                                        🔄
                                    </button>
                                    {/* マイクトグルスイッチ */}
                                    <ToggleSwitch
                                        isOn={includeMic}
                                        onChange={setIncludeMic}
                                        disabled={isCapturing}
                                        label="🎤 マイク"
                                    />
                                </div>
                            )}
                            {/* アプリモードでマイク有効時もデバイス選択を表示 */}
                            {captureSource === 'app' && includeMic && (
                                <div style={{ marginLeft: '8px' }}>
                                    <AudioDeviceSelector
                                        devices={audioDevices}
                                        selectedDeviceId={selectedDeviceId}
                                        onDeviceChange={setSelectedDeviceId}
                                        disabled={isCapturing}
                                        onRefresh={refreshAudioDevices}
                                    />
                                </div>
                            )}
                        </>
                    )}
                    <ToggleSwitch
                        isOn={isCapturing}
                        onChange={handleToggle}
                        disabled={
                            !isInitialized ||
                            (speechMode !== 'webSpeech' && captureSource === 'device' && !selectedDeviceId) ||
                            (speechMode !== 'webSpeech' && captureSource === 'app' && !selectedProcessPid)
                        }
                        label={speechMode === 'webSpeech' ? '録音' : 'キャプチャ'}
                    />
                </div>
            </header>

            {/* Error Alert */}
            {error && (
                <div className="error-alert" style={{ margin: '16px 24px 0' }}>
                    <span className="error-alert-icon">⚠️</span>
                    {error}
                    <button
                        onClick={() => setError(null)}
                        style={{
                            marginLeft: 'auto',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--color-error)',
                            cursor: 'pointer',
                        }}
                    >
                        ✕
                    </button>
                </div>
            )}

            {/* Main Content */}
            <main className="app-main">
                <div className="main-content">
                    {/* Web Speech モードで中間テキスト表示 */}
                    {speechMode === 'webSpeech' && interimText && (
                        <div style={{
                            padding: '12px 16px',
                            background: 'rgba(99, 102, 241, 0.1)',
                            borderRadius: '8px',
                            marginBottom: '16px',
                            color: 'var(--color-text-secondary)',
                            fontStyle: 'italic',
                        }}>
                            🎤 認識中: {interimText}
                        </div>
                    )}
                    <div className="log-container">
                        <LogView
                            logs={logs}
                            onTextSelect={handleTextSelect}
                            onPlaybackStatusChange={setIsAppPlaying}
                            onEditLog={handleEditLog}
                        />
                    </div>
                    <ResearchButton
                        selectedText={selectedText}
                        isLoading={isResearching}
                        onClick={handleResearch}
                    />
                </div>

                {/* Side Panel */}
                <aside className="side-panel">
                    <div className="side-panel-header">
                        🔍 調査結果
                    </div>
                    <div className="side-panel-content">
                        <ResearchPanel
                            result={researchResult}
                            isLoading={isResearching}
                        />
                    </div>
                </aside>
            </main>
        </div>
    );
};

export default CaptureScreen;
