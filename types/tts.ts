/**
 * Style-Bert-VITS2 Local TTS Runtime Types
 */

// ========================================
// Installation & Runtime States
// ========================================

export type TtsInstallState =
    | 'not_installed'
    | 'installing'
    | 'installed'
    | 'corrupted'
    | 'upgrade_available';

export type TtsRuntimeState =
    | 'stopped'
    | 'starting'
    | 'running'
    | 'error'
    | 'restarting';

// ========================================
// Error Codes
// ========================================

export type TtsErrorCode =
    | 'E_BUNDLE_CORRUPT'
    | 'E_NO_DISK_SPACE'
    | 'E_NO_PERMISSION'
    | 'E_UNZIP_FAILED'
    | 'E_VENV_FAILED'
    | 'E_PIP_FAILED'
    | 'E_MODEL_FAILED'
    | 'E_SERVER_FAILED'
    | 'E_HEALTH_FAILED'
    | 'E_PORT_IN_USE'
    | 'E_UNKNOWN';

export interface TtsError {
    code: TtsErrorCode;
    message: string;
    details?: string;
}

// ========================================
// Bundle Manifest
// ========================================

export interface BundleFileEntry {
    path: string;
    size: number;
    sha256: string;
}

export interface BundleManifest {
    bundleVersion: string;
    createdAt: string;
    files: BundleFileEntry[];
    requiredDiskSpaceBytes: number;
}

// ========================================
// Install Manifest (written after install)
// ========================================

export interface InstallManifest {
    bundleVersion: string;
    installedAt: string;
    pythonPath: string;
    venvPath: string;
    sbv2Path: string;
    modelsPath: string;
    lastHealthCheck?: string;
    port?: number;
}

// ========================================
// Status Response
// ========================================

export interface TtsStatus {
    installState: TtsInstallState;
    runtimeState: TtsRuntimeState;
    port?: number;
    activeModel?: string;
    lastError?: TtsError;
    bundleVersion?: string;
    installedVersion?: string;
}

// ========================================
// Install Options
// ========================================

export interface TtsInstallOptions {
    dryRun?: boolean;
    force?: boolean;
}

export interface TtsInstallResult {
    success: boolean;
    error?: TtsError;
    dryRunPassed?: boolean;
    steps?: TtsInstallStep[];
}

export interface TtsInstallStep {
    name: string;
    status: 'pending' | 'running' | 'done' | 'failed';
    message?: string;
}

// ========================================
// Model & Style
// ========================================

export interface TtsModel {
    id: string;
    name: string;
    path: string;
    styles: string[];
    defaultStyle: string;
}

// ========================================
// Synthesis
// ========================================

export interface TtsSynthesizeParams {
    text: string;
    modelId?: string;
    style?: string;
    speed?: number;       // 0.5 - 2.0, default 1.0
    pitch?: number;       // -12 to +12 semitones, default 0
    intonation?: number;  // 0.0 - 2.0, default 1.0
    emotion?: string;     // emotion tag

    // V2.0 Advanced Params
    styleWeight?: number; // 0.1 - 10.0, default 1.0
    sdpRatio?: number;    // 0.0 - 1.0, default 0.2
    noiseScale?: number;  // 0.1 - 1.0, default 0.6
    noiseScaleW?: number; // 0.1 - 1.0, default 0.8
    assistText?: string;  // prompt for emotion/tone guide
    assistTextWeight?: number; // 0.0 - 2.0, default 1.0

    // Audio Enhancement (Post-Processing)
    postFilter?: boolean;      // Apply DeepFilterNet post-processing
    filterStrength?: number;   // 0.0 - 1.0, denoise strength (0.3-0.5 for whisper)

    // Singing-oriented synthesis hints
    preserveLineBreaks?: boolean; // keep lyric line boundaries when chunking text
    chunkPauseMs?: number;        // pause between generated chunks (ms)
    lineSplit?: boolean;          // let SBV2 split by line breaks internally
    splitInterval?: number;       // seconds between SBV2 internal line splits
}

export interface TtsSynthesizeResult {
    success: boolean;
    wavPath?: string;
    audioBase64?: string;
    durationMs?: number;
    sampleRate?: number;
    error?: TtsError;
}

// ========================================
// Preset
// ========================================

export interface TtsPreset {
    id: string;
    name: string;
    modelId: string;
    style: string;
    speed: number;
    pitch: number;
    intonation: number;
    emotion?: string;
    createdAt: string;
    updatedAt: string;
}

// ========================================
// Health Check
// ========================================

export interface TtsHealthResponse {
    status: 'ok' | 'error';
    message?: string;
}

// ========================================
// GPU & Environment Info
// ========================================

export interface GpuInfo {
    cudaAvailable: boolean;
    cudaVersion: string | null;
    torchVersion: string;
    deviceCount: number;
    currentDevice: string;
    devices: string[];
}

// ========================================
// Dataset Preparation
// ========================================

export interface SliceOptions {
    minSec?: number;
    maxSec?: number;
    minSilenceDurMs?: number;
    timeSuffix?: boolean;
}

export interface TranscribeOptions {
    initialPrompt?: string;
    language?: 'ja' | 'en' | 'zh';
    model?: string;
    device?: 'cuda' | 'cpu';
    computeType?: string;
    batchSize?: number;
    numBeams?: number;
}

export interface TtsStartOptions {
    forceCpu?: boolean;
}
