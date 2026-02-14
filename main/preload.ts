import { contextBridge, ipcRenderer } from 'electron';

// Renderer プロセスに安全に API を公開
contextBridge.exposeInMainWorld('electronAPI', {
    // 画面ソース一覧を取得
    getSources: async () => {
        return await ipcRenderer.invoke('get-sources');
    },

    // API キーを取得
    getApiKey: async () => {
        return await ipcRenderer.invoke('get-api-key');
    },

    // [New] Google Cloud Speech-to-Text で音声をテキスト化
    transcribeAudio: async (audioData: ArrayBuffer) => {
        // IPC経由で送信するために Uint8Array に変換
        const uint8Array = new Uint8Array(audioData);
        return await ipcRenderer.invoke('transcribe-audio', uint8Array);
    },

    // ログを保存
    saveLogs: async (logs: { id: string; timestamp: string; text: string }[]) => {
        return await ipcRenderer.invoke('save-logs', logs);
    },

    // ログを読み込み
    loadLogs: async () => {
        return await ipcRenderer.invoke('load-logs');
    },

    // LINEAR16 PCM音声をテキスト化（Per-App Capture用）
    transcribeLinear16: async (audioData: number[], sampleRate: number, channels: number) => {
        return await ipcRenderer.invoke('transcribe-linear16', audioData, sampleRate, channels);
    },

    // ============================================
    // Per-App Audio Capture APIs
    // ============================================

    // 音声を出力しているプロセス一覧を取得
    getAudioProcesses: async () => {
        return await ipcRenderer.invoke('get-audio-processes');
    },

    // プロセスの音声キャプチャを開始
    startProcessCapture: async (pid: number) => {
        return await ipcRenderer.invoke('start-process-capture', pid);
    },

    // システム全体の音声キャプチャを開始 (New: Native WASAPI loopback)
    startSystemCapture: async () => {
        return await ipcRenderer.invoke('start-system-capture');
    },

    // プロセスの音声キャプチャを停止
    stopProcessCapture: async () => {
        return await ipcRenderer.invoke('stop-process-capture');
    },

    // プロセス音声データのリスナーを登録（旧方式・互換用）
    onProcessAudioData: (callback: (data: { buffer: number[]; channels: number; sampleRate: number; bytesPerSample: number }) => void) => {
        ipcRenderer.on('process-audio-data', (_event, data) => callback(data));
    },

    // プロセス音声データのリスナーを解除
    offProcessAudioData: () => {
        ipcRenderer.removeAllListeners('process-audio-data');
        ipcRenderer.removeAllListeners('process-audio-metadata');
    },

    // プロセス音声メタデータのリスナーを登録（連続録音方式）
    onProcessAudioMetadata: (callback: (data: { totalSamples: number; sampleRate: number; channels: number }) => void) => {
        ipcRenderer.on('process-audio-metadata', (_event, data) => callback(data));
    },

    // 連続録音から指定区間を読み取って文字起こし
    transcribeRecordingSegment: async (startSample: number, endSample: number) => {
        return await ipcRenderer.invoke('transcribe-recording-segment', startSample, endSample);
    },

    // 連続録音の現在の状態を取得
    getRecordingStatus: async () => {
        return await ipcRenderer.invoke('get-recording-status');
    },

    // ============================================
    // Mic Continuous Recording APIs
    // ============================================

    // マイク連続録音を開始
    startMicContinuousRecording: async () => {
        return await ipcRenderer.invoke('start-mic-continuous-recording');
    },

    // マイク音声データを連続録音ファイルに追記
    appendMicAudio: async (audioData: number[], sampleRate: number, channels: number) => {
        return await ipcRenderer.invoke('append-mic-audio', audioData, sampleRate, channels);
    },

    // マイク連続録音からセグメントを読み取って文字起こし
    transcribeMicSegment: async (startSample: number, endSample: number) => {
        return await ipcRenderer.invoke('transcribe-mic-segment', startSample, endSample);
    },

    // マイク連続録音の状態を取得
    getMicRecordingStatus: async () => {
        return await ipcRenderer.invoke('get-mic-recording-status');
    },

    // マイク連続録音を停止
    stopMicContinuousRecording: async () => {
        return await ipcRenderer.invoke('stop-mic-continuous-recording');
    },

    // ============================================
    // Streaming Speech-to-Text APIs
    // ============================================

    // ストリーミング認識を開始
    startStreamingRecognition: async (config: { sampleRate: number; channels: number; enableDiarization?: boolean }) => {
        return await ipcRenderer.invoke('start-streaming-recognition', config);
    },

    // ストリーミングに音声データを送信
    sendStreamingAudio: async (audioData: number[]) => {
        return await ipcRenderer.invoke('send-streaming-audio', audioData);
    },

    // ストリーミング認識を停止
    stopStreamingRecognition: async () => {
        return await ipcRenderer.invoke('stop-streaming-recognition');
    },

    // ストリーミング結果のリスナーを登録
    onStreamingResult: (callback: (result: { transcript: string; isFinal: boolean; speakerTag?: number }) => void) => {
        ipcRenderer.on('streaming-transcription-result', (_event, result) => callback(result));
    },

    // ストリーミングエラーのリスナーを登録
    onStreamingError: (callback: (error: { message: string }) => void) => {
        ipcRenderer.on('streaming-transcription-error', (_event, error) => callback(error));
    },

    // ストリーミングリスナーを解除
    offStreamingListeners: () => {
        ipcRenderer.removeAllListeners('streaming-transcription-result');
        ipcRenderer.removeAllListeners('streaming-transcription-error');
    },

    // ============================================
    // Whisper Offline Speech-to-Text APIs
    // ============================================

    // Whisper 状態取得
    whisperGetStatus: async () => {
        return await ipcRenderer.invoke('whisper-get-status');
    },

    // Whisper モデルダウンロード
    whisperDownloadModel: async (model: string) => {
        return await ipcRenderer.invoke('whisper-download-model', model);
    },

    // Whisper 文字起こし
    whisperTranscribe: async (audioData: number[], sampleRate: number, channels: number) => {
        return await ipcRenderer.invoke('whisper-transcribe', audioData, sampleRate, channels);
    },

    // Whisper モデル設定
    whisperSetModel: async (model: string) => {
        return await ipcRenderer.invoke('whisper-set-model', model);
    },

    // ============================================
    // Auto-Save / Session APIs
    // ============================================

    startSession: async (customRoot?: string) => {
        return await ipcRenderer.invoke('start-session', customRoot);
    },

    setSessionPath: async (sessionPath: string) => {
        return await ipcRenderer.invoke('set-session-path', sessionPath);
    },

    saveAudioChunk: async (logId: string, buffer: number[], sampleRate: number, channels: number) => {
        return await ipcRenderer.invoke('save-audio-chunk', logId, buffer, sampleRate, channels);
    },

    updateLogsJson: async (logs: any[]) => {
        return await ipcRenderer.invoke('update-logs-json', logs);
    },

    openFolder: async (path: string) => {
        return await ipcRenderer.invoke('open-folder', path);
    },

    getCurrentSessionPath: async () => {
        return await ipcRenderer.invoke('get-current-session-path');
    },

    readAudioFile: async (path: string) => {
        return await ipcRenderer.invoke('read-audio-file', path);
    },

    selectSaveFolder: async () => {
        return await ipcRenderer.invoke('select-save-folder');
    },

    // ============================================
    // Folder Organizer APIs
    // ============================================

    organizerAnalyzeFolder: async (path: string) => {
        return await ipcRenderer.invoke('organizer:analyze-folder', path);
    },

    organizerExecuteCopy: async (plan: any[], outputRoot: string) => {
        return await ipcRenderer.invoke('organizer:execute-copy', plan, outputRoot);
    },

    organizerOpenFolder: async (path: string) => {
        return await ipcRenderer.invoke('organizer:open-folder', path);
    },

    organizerReadContent: async (path: string) => {
        return await ipcRenderer.invoke('organizer:read-content', path);
    },

    // ============================================
    // Nano Studio APIs
    // ============================================
    // Generic invoke for vNext features (history, cost, etc)
    invoke: async (channel: string, ...args: any[]) => {
        return await ipcRenderer.invoke(channel, ...args);
    },

    selectFile: async (extensions: string[], multi: boolean = false) => {
        return await ipcRenderer.invoke('nano:select-file', extensions, multi);
    },
    readImage: async (path: string) => {
        return await ipcRenderer.invoke('nano:read-image', path);
    },
    nanoLoadPresets: async () => {
        return await ipcRenderer.invoke('nano:load-presets');
    },
    nanoLoadPreset: async (name: string) => {
        return await ipcRenderer.invoke('nano:load-preset', name);
    },
    nanoSavePreset: async (preset: any) => {
        return await ipcRenderer.invoke('nano:save-preset', preset);
    },
    nanoGenerate: async (params: {
        prompt: string;
        negativePrompt?: string;
        aspectRatio?: string;
        resolution?: string;
        referenceImage?: string | null;
        referenceImages?: string[];
        modelKey?: string;
        customModelId?: string;
        upscaleScale?: number;
        mode?: string;
        upscaleMethod?: string;
        outputFormat?: string;
        outputQuality?: number;
    }) => {
        return await ipcRenderer.invoke('nano:generate', params);
    },
    upscaleImage: async (path: string, scale: number) => {
        return await ipcRenderer.invoke('nano:upscale-image', { imagePath: path, scale });
    },
    smoothImage: async (path: string) => {
        return await ipcRenderer.invoke('nano:smooth-image', path);
    },
    // Live2D
    cubismSendCommand: async (type: string, name: string, payload: any) => {
        return await ipcRenderer.invoke('cubism:send-command', type, name, payload);
    },
    cubismGetStatus: async () => {
        return await ipcRenderer.invoke('cubism:get-status');
    },
    cubismOnEvent: (callback: (event: any) => void) => {
        const handler = (_: any, event: any) => callback(event);
        ipcRenderer.on('cubism:event', handler);
        ipcRenderer.on('cubism:response', handler);
        return () => {
            ipcRenderer.removeListener('cubism:event', handler);
            ipcRenderer.removeListener('cubism:response', handler);
        };
    },

    // ============================================
    // TTS (Style-Bert-VITS2) APIs
    // ============================================

    // TTS ステータス取得
    ttsGetStatus: async () => {
        return await ipcRenderer.invoke('tts-get-status');
    },

    // TTS インストール
    ttsInstall: async (options?: { dryRun?: boolean; force?: boolean }) => {
        return await ipcRenderer.invoke('tts-install', options);
    },

    // TTS 修復
    ttsRepair: async () => {
        return await ipcRenderer.invoke('tts-repair');
    },

    // TTS アンインストール
    ttsUninstall: async () => {
        return await ipcRenderer.invoke('tts-uninstall');
    },

    // TTS サーバー開始
    ttsStartServer: async (options?: { forceCpu?: boolean }) => {
        return await ipcRenderer.invoke('tts-start-server', options);
    },

    // TTS サーバー停止
    ttsStopServer: async () => {
        return await ipcRenderer.invoke('tts-stop-server');
    },

    // モデル一覧取得
    ttsListModels: async () => {
        return await ipcRenderer.invoke('tts-list-models');
    },

    // モデル設定
    ttsSetModel: async (modelId: string) => {
        return await ipcRenderer.invoke('tts-set-model', modelId);
    },

    // 音声合成
    ttsAnalyzeText: async (text: string) => {
        return await ipcRenderer.invoke('tts-analyze-text', text);
    },

    ttsSynthesize: async (params: {
        text: string;
        modelId?: string;
        style?: string;
        speed?: number;
        pitch?: number;
        intonation?: number;
        emotion?: string;
    }) => {
        return await ipcRenderer.invoke('tts-synthesize', params);
    },

    // プリセット一覧取得
    ttsGetPresets: async () => {
        return await ipcRenderer.invoke('tts-get-presets');
    },

    // プリセット保存
    ttsSavePreset: async (preset: {
        name: string;
        modelId: string;
        style: string;
        speed: number;
        pitch: number;
        intonation: number;
        emotion?: string;
    }) => {
        return await ipcRenderer.invoke('tts-save-preset', preset);
    },

    // プリセット更新
    ttsUpdatePreset: async (id: string, updates: any) => {
        return await ipcRenderer.invoke('tts-update-preset', id, updates);
    },

    // プリセット削除
    ttsDeletePreset: async (id: string) => {
        return await ipcRenderer.invoke('tts-delete-preset', id);
    },

    // GPU情報取得
    ttsGetGpuInfo: async () => {
        return await ipcRenderer.invoke('tts-get-gpu-info');
    },

    ttsInstallTrainingDeps: async () => {
        return await ipcRenderer.invoke('tts:install-training-deps');
    },

    ttsSliceAudio: async (datasetName: string, inputDir: string, options?: any) => {
        return await ipcRenderer.invoke('tts-slice-audio', datasetName, inputDir, options);
    },

    ttsTranscribeAudio: async (datasetName: string, options?: any) => {
        return await ipcRenderer.invoke('tts-transcribe-audio', datasetName, options);
    },

    ttsSaveTranscription: async (datasetName: string, content: string) => {
        return await ipcRenderer.invoke('tts-save-transcription', datasetName, content);
    },

    ttsInitializeTrainingConfig: async (datasetName: string) => {
        return await ipcRenderer.invoke('tts-init-training-config', datasetName);
    },

    ttsGenerateBert: async (datasetName: string) => {
        return await ipcRenderer.invoke('tts-generate-bert', datasetName);
    },

    ttsTrainModel: async (datasetName: string, options?: { speedup?: boolean; noProgressBar?: boolean; epochs?: number }) => {
        return await ipcRenderer.invoke('tts-train-model', datasetName, options);
    },

    ttsCleanAudio: async (datasetName: string) => {
        return await ipcRenderer.invoke('tts-clean-audio', datasetName);
    },

    ttsFilterAudio: async (datasetName: string) => {
        return await ipcRenderer.invoke('tts-filter-audio', datasetName);
    },

    utilSelectDirectory: async () => {
        return await ipcRenderer.invoke('util-select-directory');
    },

    ttsGetPathsConfig: async () => {
        return await ipcRenderer.invoke('tts-get-paths-config');
    },

    ttsSetPathsConfig: async (config: { datasetRoot: string; assetsRoot: string }) => {
        return await ipcRenderer.invoke('tts-set-paths-config', config);
    },
});
