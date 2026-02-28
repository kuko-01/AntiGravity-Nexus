/**
 * RVC (Retrieval-based Voice Conversion) Types
 */

// ========================================
// Installation & Runtime States
// ========================================

export type RvcInstallState =
    | 'not_installed'
    | 'installing'
    | 'installed'
    | 'corrupted'
    | 'upgrade_available';

export type RvcRuntimeState =
    | 'stopped'
    | 'starting'
    | 'running'
    | 'error'
    | 'restarting';

// ========================================
// Error Codes
// ========================================

export type RvcErrorCode =
    | 'E_BUNDLE_CORRUPT'
    | 'E_NO_DISK_SPACE'
    | 'E_NO_PERMISSION'
    | 'E_UNZIP_FAILED'
    | 'E_PIP_FAILED'
    | 'E_MODEL_FAILED'
    | 'E_SERVER_FAILED'
    | 'E_HEALTH_FAILED'
    | 'E_PORT_IN_USE'
    | 'E_CONVERT_FAILED'
    | 'E_NO_GPU'
    | 'E_UNKNOWN';

export interface RvcError {
    code: RvcErrorCode;
    message: string;
    details?: string;
}

// ========================================
// Bundle Manifest
// ========================================

export interface RvcBundleFileEntry {
    path: string;
    size: number;
    sha256: string;
}

export interface RvcBundleManifest {
    bundleVersion: string;
    createdAt: string;
    files: RvcBundleFileEntry[];
    requiredDiskSpaceBytes: number;
}

// ========================================
// Install Manifest (written after install)
// ========================================

export interface RvcInstallManifest {
    bundleVersion: string;
    installedAt: string;
    pythonPath: string;
    rvcPath: string;
    modelsPath: string;
    lastHealthCheck?: string;
    port?: number;
}

// ========================================
// Status Response
// ========================================

export interface RvcStatus {
    installState: RvcInstallState;
    runtimeState: RvcRuntimeState;
    port?: number;
    activeModel?: string;
    lastError?: RvcError;
    bundleVersion?: string;
    installedVersion?: string;
}

// ========================================
// Install Options
// ========================================

export interface RvcInstallOptions {
    dryRun?: boolean;
    force?: boolean;
}

export interface RvcInstallResult {
    success: boolean;
    error?: RvcError;
    dryRunPassed?: boolean;
    steps?: RvcInstallStep[];
}

export interface RvcInstallStep {
    name: string;
    status: 'pending' | 'running' | 'done' | 'failed';
    message?: string;
}

// ========================================
// Model
// ========================================

export interface RvcModel {
    id: string;
    name: string;
    path: string;
    hasIndex: boolean;
    meta?: RvcModelMeta;
}

export interface RvcModelMeta {
    displayName?: string;
    description?: string;
    f0Method?: RvcF0Method;
    defaultTranspose?: number;
    sampleRate?: number;
    createdAt?: string;
}

// ========================================
// Convert Parameters
// ========================================

export type RvcF0Method = 'rmvpe' | 'harvest' | 'crepe';

export interface RvcConvertParams {
    inputPath?: string;         // WAV file path to convert
    inputBase64?: string;       // OR base64-encoded WAV
    modelId?: string;
    indexPath?: string;         // optional index file path selected by user
    speakerId?: number;         // speaker id (sid) for multi-speaker models, default: 0
    f0Method?: RvcF0Method;     // default: 'rmvpe'
    transpose?: number;         // semitones shift (-12 to +12), default: 0
    indexRate?: number;          // 0.0-1.0, how much to use index, default: 0.75
    protect?: number;           // 0.0-0.5, consonant protection, default: 0.33
    filterRadius?: number;      // 0-7, median filter for f0, default: 3
    rmsMixRate?: number;        // 0.0-1.0, envelope mixing, default: 0.25
    resampleSr?: number;        // output sample rate (0 = no resample)
    autoHighPitchQualityProtect?: boolean; // file WAV only: blend lower-transpose output on detected high-note regions
    latencyPriority?: boolean;  // prefer low latency (chat/interactive use) over heavy quality safeguards/archive
}

export interface RvcConvertResult {
    success: boolean;
    wavPath?: string;
    archivedPath?: string;
    audioBase64?: string;
    durationMs?: number;
    sampleRate?: number;
    learningProfileId?: string;
    warning?: string;
    error?: RvcError;
}

// ========================================
// Preset
// ========================================

export interface RvcPreset {
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
    createdAt: string;
    updatedAt: string;
}

// ========================================
// Start Options
// ========================================

export interface RvcStartOptions {
    forceCpu?: boolean;
    verboseLogs?: boolean;
}

// ========================================
// Pipeline (SBV2 + RVC)
// ========================================

export type VoicePipelineMode = 'sbv2' | 'rvc' | 'sbv2+rvc';

export type VoiceEmotionLabelHint =
    | 'neutral' | 'joy' | 'sad' | 'angry' | 'excited'
    | 'fear' | 'surprise' | 'love' | 'embarrassed' | 'curious';

export interface VoiceSbv2WaveEditSettings {
    vibratoDepth?: number;
    vibratoRateHz?: number;
    dynamicBoost?: number;
}

export interface VoiceExpressionSettings {
    singing?: boolean;
    autoEmotionRefine?: boolean;
    emotionLabelHint?: VoiceEmotionLabelHint;
    emotionIntensityHint?: number;
    sbv2WaveEdit?: VoiceSbv2WaveEditSettings;
}

export interface VoiceOutputSettings {
    format?: 'wav' | 'flac';
    sampleRate?: number;
    normalize?: boolean;
    enhanceFinalAudio?: boolean;
    autoAnalyzeAndEnhance?: boolean;
    persistQualityLearning?: boolean;
    qualityProfileId?: string;
}

export interface VoiceAudioQualityMetrics {
    sampleRate: number;
    channels: number;
    durationMs: number;
    peakDb: number;
    rmsDb: number;
    crestFactorDb: number;
    clippingRatio: number;
    nearClipRatio: number;
    silenceRatio: number;
    dcOffset: number;
    zeroCrossRate: number;
    qualityScore: number;
}

export interface VoiceAudioEnhancementReport {
    analyzed: boolean;
    autoEnhanced: boolean;
    actions: string[];
    warnings?: string[];
    profileId?: string;
    before?: VoiceAudioQualityMetrics;
    after?: VoiceAudioQualityMetrics;
}

export interface VoiceSynthesizeParams {
    text: string;
    mode: VoicePipelineMode;
    sbv2?: {
        modelId?: string;
        style?: string;
        speed?: number;
        pitch?: number;
        intonation?: number;
        styleWeight?: number;
        sdpRatio?: number;
        noiseScale?: number;
        noiseScaleW?: number;
        assistText?: string;
        assistTextWeight?: number;
        postFilter?: boolean;
        filterStrength?: number;
        preserveLineBreaks?: boolean;
        chunkPauseMs?: number;
        lineSplit?: boolean;
        splitInterval?: number;
    };
    rvc?: RvcConvertParams;
    expression?: VoiceExpressionSettings;
    output?: VoiceOutputSettings;
}

export interface VoiceSynthesizeResult {
    success: boolean;
    audioBase64?: string;
    wavPath?: string;
    durationMs?: number;
    sampleRate?: number;
    intermediateWavPath?: string;
    stages?: {
        sbv2Ms?: number;
        rvcMs?: number;
        analysisMs?: number;
        totalMs?: number;
    };
    analysis?: VoiceAudioEnhancementReport;
    error?: { code: string; message: string };
}
