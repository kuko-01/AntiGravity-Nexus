export interface AudioProcess {
    pid: number;
    name: string;
    title: string;
}

export interface CaptureResult {
    success: boolean;
    error?: string;
}

export interface AudioData {
    buffer: Buffer;
    channels: number;
    sampleRate: number;
    bytesPerSample: number;
}

/**
 * Get list of processes that are currently outputting audio
 */
export function getAudioProcesses(): AudioProcess[];

/**
 * Start capturing audio from a specific process
 * @param pid Process ID to capture audio from
 * @param callback Callback function that receives audio data chunks
 */
export function startCapture(
    pid: number,
    callback: (data: AudioData) => void
): CaptureResult;

/**
 * Start capturing system-wide audio (all applications)
 * @param callback Callback function that receives audio data chunks
 */
export function startSystemCapture(
    callback: (data: AudioData) => void
): CaptureResult;

/**
 * Stop the current audio capture
 */
export function stopCapture(): void;

/**
 * Check if capture is currently active
 */
export function isCapturing(): boolean;
