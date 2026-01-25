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
    START_PROCESS_CAPTURE: 'start-process-capture',
    STOP_PROCESS_CAPTURE: 'stop-process-capture',
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
    startProcessCapture: (pid: number) => Promise<{ success: boolean; recordingPath?: string; error?: string }>;
    stopProcessCapture: () => Promise<{ success: boolean; finalRecordingPath?: string; error?: string }>;
    onProcessAudioData: (callback: (data: ProcessAudioData) => void) => void;
    offProcessAudioData: () => void;
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
    readAudioFile: (path: string) => Promise<{ success: boolean; buffer?: number[]; sampleRate?: number; channels?: number; bitsPerSample?: number; error?: string }>;
    selectSaveFolder: () => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
    // Folder Organizer
    organizerAnalyzeFolder: (path: string) => Promise<{ success: boolean; files?: OrganizerFile[]; stats?: OrganizerStats; error?: string }>;
    organizerExecuteCopy: (plan: CopyPlanItem[], outputRoot: string) => Promise<CopyExecutionResult>;
    organizerOpenFolder: (path: string) => Promise<{ success: boolean; error?: string }>;
    organizerReadContent: (path: string) => Promise<{ success: boolean; text?: string; error?: string }>;
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
