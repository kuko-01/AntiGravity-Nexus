import { TtsError, SliceOptions, TranscribeOptions } from './tts';
import { RvcConvertParams, RvcPreset, VoiceSynthesizeParams } from './rvc';
import { CharacterChatRequest, CharacterChatResponse } from './character';

// 画面/ウィンドウソース情報
export interface DesktopSource {
    id: string;
    name: string;
    thumbnailDataUrl?: string;
}


// オーディオデバイス情報
export interface AudioDevice {
    deviceId: string;
    label: string;
    kind: string;
}

// ログエントリ
export interface LogEntry {
    id: string;
    timestamp: Date;
    text: string;
    speakerTag?: number; // Speaker Diarization 用
    audioBuffer?: number[]; // 音声データ（PCM）
    audioFile?: string; // 保存されたWAVファイルのパス（Auto-Save用）
    sampleRate?: number; // サンプルレート
    channels?: number; // チャンネル数
    isEdited?: boolean; // 手動編集済みフラグ
    customLabel?: string; // カスタムラベル（例: "マイク"）
}

// 単語と話者情報
export interface WordWithSpeaker {
    word: string;
    speakerTag: number;
}

// 調査結果
export interface ResearchResult {
    query: string;
    summary: string;
    details: string[];
    relatedLinks?: { title: string; url: string }[];
    error?: string;
}

// アプリケーション状態
export interface AppState {
    sources: DesktopSource[];
    selectedSourceId: string | null;
    isCapturing: boolean;
    logs: LogEntry[];
    selectedText: string;
    researchResult: ResearchResult | null;
    isResearching: boolean;
}

export interface CharacterLearningSeparationMethodProfile {
    method: 'uvr-ultimate' | 'demucs' | 'uvr5' | 'ffmpeg-fallback';
    scoreEma: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    leakageEma: number;
    speechActivityEma: number;
    rmsDbEma: number;
    updatedAt: string;
}

export interface CharacterLearningSeparationProfileResponse {
    success: boolean;
    characterId: string;
    preferredMethod: 'uvr-ultimate' | 'demucs' | 'uvr5' | 'ffmpeg-fallback';
    updatedAt: string;
    methods: CharacterLearningSeparationMethodProfile[];
    profilePath: string;
    error?: string;
}

// 音声を出力しているプロセス情報
export interface AudioProcess {
    pid: number;
    name: string;
    title: string;
}

// プロセス音声データ
export interface ProcessAudioData {
    buffer: number[];
    channels: number;
    sampleRate: number;
    bytesPerSample: number;
}

// IPC チャンネル
export const IPC_CHANNELS = {
    GET_SOURCES: 'get-sources',
    GET_API_KEY: 'get-api-key',
    TRANSCRIBE_AUDIO: 'transcribe-audio',
    SAVE_LOGS: 'save-logs',
    LOAD_LOGS: 'load-logs',
    GET_AUDIO_PROCESSES: 'get-audio-processes',
    SET_PROCESS_MUTE: 'set-process-mute',
    GET_PROCESS_MUTE: 'get-process-mute',
    START_PROCESS_CAPTURE: 'start-process-capture',
    START_PROCESS_CAPTURE_STREAM: 'start-process-capture-stream',
    STOP_PROCESS_CAPTURE: 'stop-process-capture',
    STOP_PROCESS_CAPTURE_STREAM: 'stop-process-capture-stream',
    // TTS Training
    TTS_SLICE_AUDIO: 'tts-slice-audio',
    TTS_TRANSCRIBE_AUDIO: 'tts-transcribe-audio',
    TTS_SAVE_TRANSCRIPTION: 'tts-save-transcription',
    TTS_INIT_TRAINING_CONFIG: 'tts-init-training-config',
    TTS_GENERATE_BERT: 'tts-generate-bert',
    // RVC
    RVC_GET_STATUS: 'rvc-get-status',
    RVC_INSTALL: 'rvc-install',
    RVC_REPAIR: 'rvc-repair',
    RVC_UNINSTALL: 'rvc-uninstall',
    RVC_START_SERVER: 'rvc-start-server',
    RVC_SET_VERBOSE_LOGS: 'rvc-set-verbose-logs',
    RVC_GET_VERBOSE_LOGS: 'rvc-get-verbose-logs',
    RVC_STOP_SERVER: 'rvc-stop-server',
    RVC_GET_GPU_INFO: 'rvc-get-gpu-info',
    RVC_LIST_MODELS: 'rvc-list-models',
    RVC_LIST_MODEL_INDEXES: 'rvc-list-model-indexes',
    RVC_SET_MODEL: 'rvc-set-model',
    RVC_CONVERT: 'rvc-convert',
    RVC_GET_PRESETS: 'rvc-get-presets',
    RVC_SAVE_PRESET: 'rvc-save-preset',
    RVC_UPDATE_PRESET: 'rvc-update-preset',
    RVC_DELETE_PRESET: 'rvc-delete-preset',
    // Pipeline
    VOICE_SYNTHESIZE: 'voice-synthesize',
    CHARACTER_CHAT_SEND: 'character-chat-send',
    CHARACTER_CHAT_RESET: 'character-chat-reset',
} as const;

// ログ保存用の型（DateをstringにシリアライズするためLogEntryとは別）
export interface SerializedLogEntry {
    id: string;
    timestamp: string;
    text: string;
}

// Electron API（preload で公開）
export interface ElectronAPI {
    getSources: () => Promise<DesktopSource[]>;
    getApiKey: () => Promise<string>;
    transcribeAudio: (audioData: ArrayBuffer) => Promise<{ success: boolean; text?: string; error?: string }>;
    transcribeLinear16: (audioData: number[], sampleRate: number, channels: number) => Promise<{ success: boolean; text?: string; words?: WordWithSpeaker[]; error?: string }>;
    saveLogs: (logs: SerializedLogEntry[]) => Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }>;
    loadLogs: () => Promise<{ success: boolean; logs?: SerializedLogEntry[]; filePath?: string; canceled?: boolean; error?: string }>;
    // Per-App Audio Capture
    getAudioProcesses: () => Promise<{ success: boolean; processes?: AudioProcess[]; error?: string }>;
    setProcessMute: (pid: number, mute: boolean) => Promise<{ success: boolean; error?: string }>;
    getProcessMute: (pid: number) => Promise<{ success: boolean; found: boolean; muted: boolean; error?: string }>;
    startProcessCapture: (pid: number) => Promise<{ success: boolean; recordingPath?: string; error?: string }>;
    startProcessCaptureStream: (pid: number) => Promise<{ success: boolean; error?: string }>;
    startSystemCapture: () => Promise<{ success: boolean; recordingPath?: string; error?: string }>;
    stopProcessCapture: () => Promise<{ success: boolean; finalRecordingPath?: string; error?: string }>;
    stopProcessCaptureStream: () => Promise<{ success: boolean; error?: string }>;
    onProcessAudioData: (callback: (data: ProcessAudioData) => void) => void;
    onProcessAudioStream: (callback: (data: ProcessAudioData) => void) => void;
    offProcessAudioData: () => void;
    offProcessAudioStream: () => void;
    // 連続録音方式用API
    onProcessAudioMetadata: (callback: (data: { totalSamples: number; sampleRate: number; channels: number }) => void) => void;
    transcribeRecordingSegment: (startSample: number, endSample: number) => Promise<{ success: boolean; text?: string; words?: WordWithSpeaker[]; startSample?: number; endSample?: number; audioBuffer?: number[]; error?: string }>;
    getRecordingStatus: () => Promise<{ isRecording: boolean; totalSamples: number; lastTranscribedSamples: number; sampleRate: number; channels: number; recordingPath: string | null }>;
    // マイク連続録音方式用API
    startMicContinuousRecording: () => Promise<{ success: boolean; recordingPath?: string; error?: string }>;
    appendMicAudio: (audioData: number[], sampleRate: number, channels: number) => Promise<{ success: boolean; totalSamples?: number; error?: string }>;
    transcribeMicSegment: (startSample: number, endSample: number) => Promise<{ success: boolean; text?: string; words?: WordWithSpeaker[]; startSample?: number; endSample?: number; audioBuffer?: number[]; error?: string }>;
    getMicRecordingStatus: () => Promise<{ isRecording: boolean; totalSamples: number; sampleRate: number; channels: number; recordingPath: string | null }>;
    stopMicContinuousRecording: () => Promise<{ success: boolean; finalRecordingPath?: string; error?: string }>;
    // Streaming Speech-to-Text
    startStreamingRecognition: (config: { sampleRate: number; channels: number; enableDiarization?: boolean }) => Promise<{ success: boolean; error?: string }>;
    sendStreamingAudio: (audioData: number[]) => Promise<{ success: boolean; error?: string }>;
    stopStreamingRecognition: () => Promise<{ success: boolean; error?: string }>;
    onStreamingResult: (callback: (result: StreamingResult) => void) => void;
    onStreamingError: (callback: (error: { message: string }) => void) => void;
    offStreamingListeners: () => void;
    // Whisper Offline Speech-to-Text
    whisperGetStatus: () => Promise<WhisperStatus>;
    whisperDownloadModel: (model: string) => Promise<{ success: boolean; error?: string }>;
    whisperTranscribe: (audioData: number[], sampleRate: number, channels: number) => Promise<{ success: boolean; text?: string; error?: string }>;
    whisperSetModel: (model: string) => Promise<{ success: boolean; error?: string }>;
    // Auto-Save / Session
    startSession: (customRoot?: string) => Promise<{ success: boolean; sessionPath?: string; error?: string }>;
    setSessionPath: (sessionPath: string) => Promise<{ success: boolean }>;
    saveAudioChunk: (logId: string, buffer: number[], sampleRate: number, channels: number) => Promise<{ success: boolean; filePath?: string; error?: string }>;
    updateLogsJson: (logs: any[]) => Promise<{ success: boolean; error?: string }>;
    openFolder: (path: string) => Promise<{ success: boolean; error?: string }>;
    getCurrentSessionPath: () => Promise<string | null>;
    readAudioFile: (path: string) => Promise<{ success: boolean; base64?: string; error?: string }>;
    selectSaveFolder: () => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
    // Folder Organizer
    organizerAnalyzeFolder: (path: string) => Promise<{ success: boolean; files?: OrganizerFile[]; stats?: OrganizerStats; error?: string }>;
    organizerExecuteCopy: (plan: CopyPlanItem[], outputRoot: string) => Promise<CopyExecutionResult>;
    organizerOpenFolder: (path: string) => Promise<{ success: boolean; error?: string }>;
    organizerReadContent: (path: string) => Promise<{ success: boolean; text?: string; error?: string }>;
    // Generic invoke for vNext features
    invoke: (channel: string, ...args: any[]) => Promise<any>;

    // Nano Studio
    selectFile: (extensions: string[], multi?: boolean) => Promise<{ success: boolean; path?: string; paths?: string[]; error?: string }>;
    readImage: (path: string) => Promise<{ success: boolean; base64?: string; error?: string }>;
    nanoLoadPresets: () => Promise<{ success: boolean; presets?: NanoPreset[]; error?: string }>;
    nanoLoadPreset: (name: string) => Promise<{ success: boolean; preset?: NanoPreset; error?: string }>;
    nanoSavePreset: (preset: NanoPreset) => Promise<{ success: boolean; error?: string }>;
    nanoGenerate: (params: NanoGenerateParams) => Promise<{ success: boolean; imagePath?: string; imageBase64?: string; error?: string }>;
    upscaleImage: (path: string, scale: number) => Promise<{ success: boolean; path?: string; error?: string }>;
    smoothImage: (path: string) => Promise<{ success: boolean; path?: string; error?: string }>;

    // Live2D
    cubismSendCommand: (type: string, name: string, payload?: any) => Promise<{ success: boolean; msgId?: string; error?: string }>;
    cubismGetStatus: () => Promise<any>;
    cubismOnEvent: (callback: (event: any) => void) => () => void; // Returns unsubscribe function

    // TTS APIs
    ttsGetStatus: () => Promise<any>;
    ttsInstall: (options?: any) => Promise<any>;
    ttsRepair: () => Promise<any>;
    ttsUninstall: () => Promise<any>;
    ttsStartServer: (options?: { forceCpu?: boolean }) => Promise<any>;
    ttsStopServer: () => Promise<any>;
    ttsGetGpuInfo: () => Promise<any>;

    ttsInstallTrainingDeps: () => Promise<void>;
    ttsSliceAudio: (datasetName: string, inputDir: string, options?: SliceOptions) => Promise<{ success: boolean; error?: TtsError }>;
    ttsTranscribeAudio: (datasetName: string, options?: TranscribeOptions) => Promise<{ success: boolean; error?: TtsError }>;
    ttsSaveTranscription: (datasetName: string, content: string) => Promise<{ success: boolean; error?: TtsError }>;
    ttsInitializeTrainingConfig: (datasetName: string) => Promise<{ success: boolean; error?: TtsError }>;
    ttsGenerateBert: (datasetName: string) => Promise<{ success: boolean; error?: TtsError }>;
    ttsTrainModel: (datasetName: string, options?: { speedup?: boolean; noProgressBar?: boolean; epochs?: number }) => Promise<{ success: boolean; error?: { code: string; message: string } }>;
    ttsCleanAudio: (datasetName: string) => Promise<{ success: boolean; message?: string; error?: { code: string; message: string } }>;
    ttsFilterAudio: (datasetName: string) => Promise<{ success: boolean; message?: string; error?: { code: string; message: string } }>;
    utilSelectDirectory: () => Promise<string | null>;
    ttsListModels: () => Promise<any[]>;
    ttsSetModel: (modelId: string) => Promise<any>;
    ttsAnalyzeText: (text: string) => Promise<string[] | { error: string }>;
    ttsSynthesize: (params: any) => Promise<any>;
    ttsGetPresets: () => Promise<any[]>;
    ttsSavePreset: (preset: any) => Promise<any>;
    ttsUpdatePreset: (id: string, updates: any) => Promise<any>;
    ttsDeletePreset: (id: string) => Promise<boolean>;
    ttsGetPathsConfig: () => Promise<{ datasetRoot: string; assetsRoot: string }>;
    ttsSetPathsConfig: (config: { datasetRoot: string; assetsRoot: string }) => Promise<{ success: boolean; error?: string }>;

    // RVC (Voice Conversion) APIs
    rvcGetStatus: () => Promise<any>;
    rvcInstall: (options?: { dryRun?: boolean; force?: boolean }) => Promise<any>;
    rvcRepair: () => Promise<any>;
    rvcUninstall: () => Promise<any>;
    rvcStartServer: (options?: { forceCpu?: boolean; verboseLogs?: boolean }) => Promise<any>;
    rvcSetVerboseLogs: (enabled: boolean) => Promise<{ success: boolean; verboseLogs?: boolean; requiresRestart?: boolean; error?: string }>;
    rvcGetVerboseLogs: () => Promise<{ success: boolean; verboseLogs: boolean; error?: string }>;
    rvcStopServer: () => Promise<any>;
    rvcGetGpuInfo: () => Promise<any>;
    rvcListModels: () => Promise<any[]>;
    rvcListModelIndexes: (modelId: string) => Promise<string[]>;
    rvcOpenModelsFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
    rvcSetModel: (modelId: string) => Promise<any>;
    rvcConvert: (params: RvcConvertParams) => Promise<any>;
    rvcGetPresets: () => Promise<RvcPreset[]>;
    rvcSavePreset: (preset: Omit<RvcPreset, 'id' | 'createdAt' | 'updatedAt'>) => Promise<any>;
    rvcUpdatePreset: (id: string, updates: Partial<RvcPreset>) => Promise<any>;
    rvcDeletePreset: (id: string) => Promise<boolean>;

    // Voice Pipeline (SBV2 + RVC)
    voiceSynthesize: (params: VoiceSynthesizeParams) => Promise<any>;

    // AI Character Chat
    characterChatSend: (params: CharacterChatRequest) => Promise<CharacterChatResponse>;
    characterChatReset: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    characterLearningGetSeparationProfile: (characterId: string) => Promise<CharacterLearningSeparationProfileResponse>;
    characterLearningResetSeparationProfile: (characterId: string) => Promise<CharacterLearningSeparationProfileResponse>;
    dialogueExtractFromYoutube: (params: {
        characterId: string;
        sourceUrl: string;
        startSec?: number;
        durationSec: number;
        separationPreference?: string;
        ytDlpCookiesFile?: string;
    }) => Promise<{
        success: boolean;
        startSec: number;
        durationSec: number;
        vocalWavPath?: string;
        method?: string;
        warning?: string;
        error?: string;
    }>;
    onDialogueExtractProgress: (callback: (progress: { stage: string; message: string }) => void) => (() => void) | void;
    dialogueLoadWavFile: (filePath: string) => Promise<{
        success: boolean;
        base64?: string;
        fileName?: string;
        error?: string;
    }>;
    dialogueSaveTrainingMaterial: (params: {
        characterId: string;
        base64: string;
        fileName: string;
    }) => Promise<{ success: boolean; savedPath?: string; error?: string }>;
}

// Nano Studio Types
export interface NanoPreset {
    name: string;
    systemPrompt: string;
    userPrompt: string;
    negativePrompt: string;
    aspectRatio: string;
}

export interface NanoGenerateParams {
    prompt: string;
    negativePrompt?: string;
    aspectRatio?: string;
    resolution?: string; // '1024x1024', '2048x2048'
    referenceImage?: string | null;
    referenceImages?: string[];
    modelKey?: string;
    customModelId?: string;
    upscaleScale?: number;
    mode?: string;
    upscaleMethod?: string;
    outputFormat?: string;
    outputQuality?: number;
}

// Whisper ステータス
export interface WhisperStatus {
    success: boolean;
    isInitialized: boolean;
    currentModel: string;
    downloadedModels: string[];
}

// ストリーミング結果
export interface StreamingResult {
    transcript: string;
    isFinal: boolean;
    speakerTag?: number;
}

// フォルダ解析結果のファイル情報
export interface OrganizerFile {
    path: string;
    name: string;
    extension: string;
    size: number;
    mtime: Date;
    atime: Date;
    birthtime: Date;
}

// フォルダ統計
export interface OrganizerStats {
    totalSize: number;
    fileCount: number;
    skippedCount: number;
}

// 解析結果
export interface AnalysisResult {
    files: OrganizerFile[];
    stats: OrganizerStats;
}

// コピー計画項目
export interface CopyPlanItem {
    sourcePath: string;
    destinationPath: string; // 出力ルートからの相対パス
    reason?: string; // AIによる理由（オプション）
}

// コピー実行結果
export interface CopyExecutionResult {
    success: boolean;
    successCount?: number;
    failCount?: number;
    errors?: { path: string; error: string }[];
    error?: string;
}

// 推奨構造案（AI）
export interface SuggestedStructure {
    items: CopyPlanItem[];
    summary: string;
}

// Window に Electron API を追加
declare global {
    interface Window {
        electronAPI: ElectronAPI;
    }
}
