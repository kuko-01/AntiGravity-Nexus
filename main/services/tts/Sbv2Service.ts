/**
 * Sbv2Service - Style-Bert-VITS2 Main Controller
 * 
 * Singleton service that orchestrates:
 * - Installation (via Bootstrapper)
 * - Runtime management (via Runtime)
 * - Synthesis requests
 * - Model/Preset management
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { Sbv2Bootstrapper } from './Sbv2Bootstrapper';
import { Sbv2Runtime } from './Sbv2Runtime';
import {
    TtsStatus,
    TtsInstallOptions,
    TtsInstallResult,
    TtsSynthesizeParams,
    TtsSynthesizeResult,
    TtsModel,
    TtsPreset,
    TtsError,
    TtsInstallState,
    GpuInfo,
    TtsStartOptions,
    SliceOptions,
    TranscribeOptions,
} from '../../../types/tts';

// ... (lines omitted)

// ... (lines omitted)

// ========================================
// Constants
// ========================================

const PRESETS_FILENAME = 'presets.json';
const CACHE_DIR = 'audio_cache';

export class Sbv2Service {
    private static instance: Sbv2Service | null = null;

    private bootstrapper: Sbv2Bootstrapper;
    private runtime: Sbv2Runtime;
    private installPath: string;

    private presets: TtsPreset[] = [];
    private activeModelId: string | null = null;

    private constructor(resourcesPath: string) {

        this.installPath = path.join(
            process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
            'AntiGravity',
            'tts',
            'sbv2'
        );

        this.bootstrapper = new Sbv2Bootstrapper(resourcesPath);
        this.runtime = new Sbv2Runtime(this.installPath);

        this.loadPresets();
    }

    static getInstance(resourcesPath?: string): Sbv2Service {
        if (!Sbv2Service.instance) {
            const resPath = resourcesPath || (
                app.isPackaged
                    ? process.resourcesPath
                    : path.join(__dirname, '../../../resources')
            );
            Sbv2Service.instance = new Sbv2Service(resPath);
        }
        return Sbv2Service.instance;
    }

    // ========================================
    // Status
    // ========================================

    getStatus(): TtsStatus {
        const installCheck = this.bootstrapper.checkInstalled();

        let installState: TtsInstallState = 'not_installed';
        if (installCheck.installed) {
            installState = 'installed';
        }

        return {
            installState,
            runtimeState: this.runtime.getState(),
            port: this.runtime.getPort() || undefined,
            activeModel: this.activeModelId || undefined,
            lastError: this.runtime.getLastError() || undefined,
            installedVersion: installCheck.version,
        };
    }


    // ========================================
    // Installation
    // ========================================

    async install(options?: TtsInstallOptions): Promise<TtsInstallResult> {
        return this.bootstrapper.install(options);
    }

    async repair(): Promise<TtsInstallResult> {
        await this.runtime.stop();
        return this.bootstrapper.repair();
    }

    async uninstall(): Promise<{ success: boolean; error?: TtsError }> {
        await this.runtime.stop();
        return this.bootstrapper.uninstall();
    }

    // ========================================
    // Runtime
    // ========================================

    async startServer(options?: TtsStartOptions): Promise<{ success: boolean; port?: number; error?: TtsError }> {
        // Check if installed first
        const installCheck = this.bootstrapper.checkInstalled();
        if (!installCheck.installed) {
            return {
                success: false,
                error: {
                    code: 'E_SERVER_FAILED',
                    message: 'SBV2 is not installed. Please install first.',
                },
            };
        }

        return this.runtime.start(options);
    }

    async stopServer(): Promise<{ success: boolean }> {
        return this.runtime.stop();
    }

    async getGpuInfo(): Promise<GpuInfo> {
        if (!this.runtime) throw new Error('Runtime not initialized');
        return await this.runtime.getGpuInfo();
    }

    // ========================================
    // Paths Config
    // ========================================

    async getPathsConfig(): Promise<{ datasetRoot: string; assetsRoot: string }> {
        if (!this.runtime) throw new Error('Runtime not initialized');
        return await this.runtime.getPathsConfig();
    }

    async setPathsConfig(config: { datasetRoot: string; assetsRoot: string }): Promise<void> {
        if (!this.runtime) throw new Error('Runtime not initialized');
        return await this.runtime.setPathsConfig(config);
    }

    // ========================================
    // Slice & Transcribe
    // ========================================


    async installTrainingDependencies(): Promise<void> {
        if (!this.runtime) throw new Error('Runtime not initialized');
        return this.runtime.installTrainingDependencies();
    }

    async trainModel(
        datasetName: string,
        options?: { speedup?: boolean; noProgressBar?: boolean; epochs?: number }
    ): Promise<{ success: boolean; error?: { code: string; message: string } }> {
        if (!this.runtime) throw new Error('Runtime not initialized');
        return this.runtime.trainModel(datasetName, options);
    }

    async cleanAudio(datasetName: string): Promise<{ success: boolean; message?: string; error?: { code: string; message: string } }> {
        if (!this.runtime) throw new Error('Runtime not initialized');
        return this.runtime.cleanAudio(datasetName);
    }

    async filterAudio(datasetName: string): Promise<{ success: boolean; message?: string; error?: { code: string; message: string } }> {
        if (!this.runtime) throw new Error('Runtime not initialized');
        return this.runtime.filterAudio(datasetName);
    }

    // ========================================
    // Models
    // ========================================

    async listModels(): Promise<TtsModel[]> {
        // Style-Bert-VITS2 stores models in sbv2/model_assets, not models/
        // Get path from config if possible, otherwise use default
        let assetsRoot = 'model_assets';
        try {
            const config = await this.getPathsConfig();
            assetsRoot = config.assetsRoot;
        } catch {
            // Use default if runtime method fails (e.g. methods not added yet) or read fails
        }

        // Handle relative paths (relative to sbv2 root) vs absolute paths
        let modelsPath = assetsRoot;
        if (!path.isAbsolute(assetsRoot)) {
            modelsPath = path.join(this.installPath, 'sbv2', assetsRoot);
        }

        if (!fs.existsSync(modelsPath)) {
            return [];
        }

        const models: TtsModel[] = [];
        const entries = fs.readdirSync(modelsPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const modelDir = path.join(modelsPath, entry.name);
                const configPath = path.join(modelDir, 'config.json');
                const styleVectorsPath = path.join(modelDir, 'style_vectors.npy');

                // Skip directories that don't look like SBV2 models
                // A valid SBV2 model should have config.json and style_vectors.npy
                if (!fs.existsSync(configPath) || !fs.existsSync(styleVectorsPath)) {
                    continue;
                }

                let styles = ['Neutral'];
                let defaultStyle = 'Neutral';

                // Try to read model config for styles
                try {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    if (config.data && config.data.style2id) {
                        styles = Object.keys(config.data.style2id);
                        defaultStyle = styles[0] || 'Neutral';
                    }
                } catch {
                    // Ignore config errors
                }

                models.push({
                    id: entry.name,
                    name: entry.name,
                    path: modelDir,
                    styles,
                    defaultStyle,
                });
            }
        }

        return models;
    }

    async setModel(modelId: string): Promise<{ success: boolean; error?: TtsError }> {
        const models = await this.listModels();
        const model = models.find(m => m.id === modelId);

        if (!model) {
            return {
                success: false,
                error: {
                    code: 'E_MODEL_FAILED',
                    message: `Model not found: ${modelId}`,
                },
            };
        }

        // If server is running, send model change request
        const endpoint = this.runtime.getEndpoint();
        if (endpoint && this.runtime.getState() === 'running') {
            try {
                const response = await fetch(`${endpoint}/models/set`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model_id: modelId }),
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    return {
                        success: false,
                        error: {
                            code: 'E_MODEL_FAILED',
                            message: `Failed to set model: ${errorText}`,
                        },
                    };
                }
            } catch (err) {
                return {
                    success: false,
                    error: {
                        code: 'E_MODEL_FAILED',
                        message: err instanceof Error ? err.message : String(err),
                    },
                };
            }
        }

        this.activeModelId = modelId;
        return { success: true };
    }

    // ========================================
    // Analysis
    // ========================================

    async analyzeText(text: string): Promise<string> {
        if (this.runtime.getState() !== 'running') {
            throw new Error('TTS server is not running');
        }
        const endpoint = this.runtime.getEndpoint();
        if (!endpoint) throw new Error('No server endpoint');

        // /g2p endpoint expects 'text' query param
        const response = await fetch(`${endpoint}/g2p?text=${encodeURIComponent(text)}`, {
            method: 'POST',
        });

        if (!response.ok) {
            throw new Error(`Analysis failed: ${await response.text()}`);
        }

        const data = await response.json();
        // Server returns list of strings (phonemes) or just a string?
        // server_fastapi.py: g2kata_tone returns list[str] or str?
        // g2kata_tone usually returns a list of phonemes/katakana with accents.
        // Let's assume it returns a JSON that we can stringify or just the raw text.
        // Actually g2kata_tone returns a list of strings.
        if (Array.isArray(data)) {
            return data.join(' ');
        }
        return String(data);
    }

    // ========================================
    // Synthesis
    // ========================================

    /**
     * Split long text into chunks suitable for SBV2 synthesis (max ~90 chars).
     * Removes newlines and splits at natural Japanese sentence boundaries.
     */
    private splitTextForSynthesis(rawText: string, maxLen: number = 90, preserveLineBreaks: boolean = false): string[] {
        if (preserveLineBreaks) {
            const lines = rawText
                .split(/\r?\n+/)
                .map((line) => line.trim())
                .filter(Boolean);
            const merged: string[] = [];
            for (const line of lines) {
                const chunks = this.splitTextForSynthesis(line, maxLen, false);
                for (const chunk of chunks) {
                    if (chunk) {
                        merged.push(chunk);
                    }
                }
            }
            if (merged.length > 0) {
                return merged;
            }
        }

        // Remove newlines and collapse whitespace
        const cleaned = rawText.replace(/[\r\n]+/g, '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return [];
        if (cleaned.length <= maxLen) return [cleaned];

        const chunks: string[] = [];
        let remaining = cleaned;

        // Split priority: 。！？  then 、  then space  then force-cut
        while (remaining.length > maxLen) {
            let cutAt = -1;

            // Try to find sentence-ending punctuation within maxLen
            for (let i = maxLen - 1; i >= 10; i--) {
                const ch = remaining[i];
                if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '.' ) {
                    cutAt = i + 1;
                    break;
                }
            }

            // Fallback: comma / clause boundary
            if (cutAt < 0) {
                for (let i = maxLen - 1; i >= 10; i--) {
                    const ch = remaining[i];
                    if (ch === '、' || ch === ',' || ch === '；' || ch === ';') {
                        cutAt = i + 1;
                        break;
                    }
                }
            }

            // Fallback: space
            if (cutAt < 0) {
                for (let i = maxLen - 1; i >= 10; i--) {
                    if (remaining[i] === ' ' || remaining[i] === '　') {
                        cutAt = i + 1;
                        break;
                    }
                }
            }

            // Force cut
            if (cutAt < 0) {
                cutAt = maxLen;
            }

            const chunk = remaining.slice(0, cutAt).trim();
            if (chunk) chunks.push(chunk);
            remaining = remaining.slice(cutAt).trim();
        }

        if (remaining) chunks.push(remaining);
        return chunks;
    }

    /**
     * Synthesize a single text chunk (no splitting).
     */
    private async synthesizeChunk(params: TtsSynthesizeParams, endpoint: string): Promise<{ success: boolean; buffer?: ArrayBuffer; error?: TtsError }> {
        const queryParams = new URLSearchParams();
        queryParams.set('text', params.text);
        if (params.modelId || this.activeModelId) {
            queryParams.set('model_name', params.modelId || this.activeModelId || '');
        }
        if (params.style) {
            queryParams.set('style', params.style);
        }
        if (params.speed !== undefined) {
            queryParams.set('length', String(params.speed));
        }

        // V2.0 Params
        if (params.styleWeight !== undefined) queryParams.set('style_weight', String(params.styleWeight));
        if (params.sdpRatio !== undefined) queryParams.set('sdp_ratio', String(params.sdpRatio));
        if (params.noiseScale !== undefined) queryParams.set('noise', String(params.noiseScale));
        if (params.noiseScaleW !== undefined) queryParams.set('noisew', String(params.noiseScaleW));

        if (params.assistText) {
            queryParams.set('assist_text', params.assistText);
            queryParams.set('assist_text_weight', String(params.assistTextWeight ?? 1.0));
        }

        if (params.postFilter !== undefined) {
            queryParams.set('post_filter', String(params.postFilter));
        }
        if (params.filterStrength !== undefined) {
            queryParams.set('filter_strength', String(params.filterStrength));
        }
        if (params.lineSplit === true) {
            queryParams.set('line_split', 'true');
        }
        if (params.splitInterval !== undefined) {
            const interval = Number(params.splitInterval);
            if (Number.isFinite(interval)) {
                queryParams.set('split_interval', String(Math.max(0.01, Math.min(2, interval))));
            }
        }

        const requestUrl = `${endpoint}/voice?${queryParams.toString()}`;
        console.log('[Sbv2Service] Synthesize chunk:', params.text.slice(0, 40) + (params.text.length > 40 ? '...' : ''));

        const response = await fetch(requestUrl, { method: 'POST' });

        if (!response.ok) {
            const errorText = await response.text();
            return {
                success: false,
                error: { code: 'E_SERVER_FAILED', message: `Synthesis failed: ${errorText}` },
            };
        }

        return { success: true, buffer: await response.arrayBuffer() };
    }

    /**
     * Concatenate multiple WAV buffers (assumes same format) into one.
     */
    private parseWavFormat(buffer: ArrayBuffer): { sampleRate: number; channels: number; bitsPerSample: number } {
        if (buffer.byteLength < 44) {
            return { sampleRate: 44100, channels: 1, bitsPerSample: 16 };
        }
        const view = new DataView(buffer);
        const channels = view.getUint16(22, true);
        const sampleRate = view.getUint32(24, true);
        const bitsPerSample = view.getUint16(34, true);
        return {
            sampleRate: sampleRate || 44100,
            channels: channels || 1,
            bitsPerSample: bitsPerSample || 16,
        };
    }

    private concatWavBuffers(buffers: ArrayBuffer[], pauseMs: number = 0): Buffer {
        if (buffers.length === 1 && pauseMs <= 0) return Buffer.from(buffers[0]);

        const format = this.parseWavFormat(buffers[0]);
        const bytesPerSample = Math.max(1, Math.floor(format.bitsPerSample / 8));
        const bytesPerFrame = Math.max(1, format.channels * bytesPerSample);
        const silenceFrames = pauseMs > 0
            ? Math.max(0, Math.round((format.sampleRate * pauseMs) / 1000))
            : 0;
        const silenceBytes = silenceFrames * bytesPerFrame;
        const pauseBuffer = silenceBytes > 0 ? Buffer.alloc(silenceBytes, 0) : null;

        // Extract raw PCM data from each WAV (skip 44-byte header)
        const pcmChunks: Buffer[] = [];
        let totalDataLen = 0;
        for (let i = 0; i < buffers.length; i += 1) {
            const buf = buffers[i];
            const data = Buffer.from(buf).subarray(44);
            pcmChunks.push(data);
            totalDataLen += data.length;
            if (pauseBuffer && i < buffers.length - 1) {
                pcmChunks.push(pauseBuffer);
                totalDataLen += pauseBuffer.length;
            }
        }

        // Build new WAV from first buffer's header
        const firstHeader = Buffer.from(buffers[0]).subarray(0, 44);
        const result = Buffer.alloc(44 + totalDataLen);
        firstHeader.copy(result, 0, 0, 44);

        // Update RIFF chunk size (offset 4, little-endian uint32)
        result.writeUInt32LE(36 + totalDataLen, 4);
        // Update data chunk size (offset 40, little-endian uint32)
        result.writeUInt32LE(totalDataLen, 40);

        let offset = 44;
        for (const chunk of pcmChunks) {
            chunk.copy(result, offset);
            offset += chunk.length;
        }

        return result;
    }

    async synthesize(params: TtsSynthesizeParams): Promise<TtsSynthesizeResult> {
        if (this.runtime.getState() !== 'running') {
            return {
                success: false,
                error: { code: 'E_SERVER_FAILED', message: 'TTS server is not running' },
            };
        }

        const endpoint = this.runtime.getEndpoint();
        if (!endpoint) {
            return {
                success: false,
                error: { code: 'E_SERVER_FAILED', message: 'No server endpoint available' },
            };
        }

        try {
            // Split long text into chunks, removing newlines
            const preserveLineBreaks = params.preserveLineBreaks === true;
            const lineSplit = params.lineSplit === true;
            const pauseMsRaw = Number(params.chunkPauseMs);
            const pauseMs = Number.isFinite(pauseMsRaw)
                ? Math.max(0, Math.min(1500, Math.floor(pauseMsRaw)))
                : 0;
            const splitIntervalRaw = Number(params.splitInterval);
            const splitInterval = Number.isFinite(splitIntervalRaw)
                ? Math.max(0.01, Math.min(2, splitIntervalRaw))
                : (pauseMs > 0 ? Math.max(0.05, Math.min(1.5, pauseMs / 1000)) : undefined);

            if (lineSplit && preserveLineBreaks && /[\r\n]/.test(params.text)) {
                const lineSplitResult = await this.synthesizeChunk(
                    {
                        ...params,
                        lineSplit: true,
                        splitInterval,
                    },
                    endpoint,
                );
                if (lineSplitResult.success && lineSplitResult.buffer) {
                    const directBuffer = Buffer.from(lineSplitResult.buffer);
                    const cacheDir = path.join(this.installPath, CACHE_DIR);
                    fs.mkdirSync(cacheDir, { recursive: true });
                    const wavPath = path.join(cacheDir, `synth_${Date.now()}.wav`);
                    fs.writeFileSync(wavPath, directBuffer);

                    const abuf = directBuffer.buffer.slice(
                        directBuffer.byteOffset,
                        directBuffer.byteOffset + directBuffer.byteLength,
                    ) as ArrayBuffer;
                    const durationMs = this.estimateWavDuration(abuf);
                    const wavFormat = this.parseWavFormat(abuf);

                    return {
                        success: true,
                        wavPath,
                        audioBase64: directBuffer.toString('base64'),
                        durationMs,
                        sampleRate: wavFormat.sampleRate,
                    };
                }
                console.warn('[Sbv2Service] line_split synthesis failed, fallback to local chunk concat');
            }

            const chunks = this.splitTextForSynthesis(params.text, 90, preserveLineBreaks);
            if (chunks.length === 0) {
                return {
                    success: false,
                    error: { code: 'E_SERVER_FAILED', message: 'Empty text after cleanup' },
                };
            }

            console.log(`[Sbv2Service] Text split into ${chunks.length} chunk(s)`);

            const wavBuffers: ArrayBuffer[] = [];
            for (let i = 0; i < chunks.length; i++) {
                const chunkParams = { ...params, text: chunks[i], lineSplit: false };
                const result = await this.synthesizeChunk(chunkParams, endpoint);
                if (!result.success || !result.buffer) {
                    return {
                        success: false,
                        error: result.error || { code: 'E_SERVER_FAILED', message: `Chunk ${i + 1}/${chunks.length} failed` },
                    };
                }
                wavBuffers.push(result.buffer);
            }

            // Concatenate all WAV chunks
            const combinedBuffer = this.concatWavBuffers(wavBuffers, pauseMs);

            // Save to cache
            const cacheDir = path.join(this.installPath, CACHE_DIR);
            fs.mkdirSync(cacheDir, { recursive: true });
            const wavPath = path.join(cacheDir, `synth_${Date.now()}.wav`);
            fs.writeFileSync(wavPath, combinedBuffer);

            const abuf = combinedBuffer.buffer.slice(combinedBuffer.byteOffset, combinedBuffer.byteOffset + combinedBuffer.byteLength) as ArrayBuffer;
            const durationMs = this.estimateWavDuration(abuf);
            const wavFormat = this.parseWavFormat(abuf);

            return {
                success: true,
                wavPath,
                audioBase64: combinedBuffer.toString('base64'),
                durationMs,
                sampleRate: wavFormat.sampleRate,
            };

        } catch (err) {
            return {
                success: false,
                error: {
                    code: 'E_SERVER_FAILED',
                    message: err instanceof Error ? err.message : String(err),
                },
            };
        }
    }

    private estimateWavDuration(buffer: ArrayBuffer): number {
        const format = this.parseWavFormat(buffer);
        const dataSize = Math.max(0, buffer.byteLength - 44);
        const bytesPerSample = Math.max(1, Math.floor(format.bitsPerSample / 8));
        const bytesPerSecond = Math.max(1, format.sampleRate * format.channels * bytesPerSample);
        return Math.round((dataSize / bytesPerSecond) * 1000);
    }

    // ========================================
    // Presets
    // ========================================

    getPresets(): TtsPreset[] {
        return [...this.presets];
    }

    savePreset(preset: Omit<TtsPreset, 'id' | 'createdAt' | 'updatedAt'>): TtsPreset {
        const now = new Date().toISOString();
        const newPreset: TtsPreset = {
            ...preset,
            id: `preset_${Date.now()}`,
            createdAt: now,
            updatedAt: now,
        };

        this.presets.push(newPreset);
        this.persistPresets();
        return newPreset;
    }

    updatePreset(id: string, updates: Partial<TtsPreset>): TtsPreset | null {
        const index = this.presets.findIndex(p => p.id === id);
        if (index === -1) return null;

        this.presets[index] = {
            ...this.presets[index],
            ...updates,
            updatedAt: new Date().toISOString(),
        };

        this.persistPresets();
        return this.presets[index];
    }



    // ========================================
    // Training / Dataset Prep
    // ========================================

    async sliceAudio(datasetName: string, inputDir: string, options?: SliceOptions): Promise<void> {
        await this.runtime.sliceAudio(datasetName, inputDir, options);
    }

    async transcribeAudio(datasetName: string, options?: TranscribeOptions): Promise<void> {
        await this.runtime.transcribeAudio(datasetName, options);
    }

    async saveTranscription(datasetName: string, content: string): Promise<void> {
        await this.runtime.saveTranscription(datasetName, content);
    }

    async initializeTrainingConfig(datasetName: string): Promise<void> {
        await this.runtime.initializeTrainingConfig(datasetName);
    }

    async generateBert(datasetName: string): Promise<void> {
        await this.runtime.generateBert(datasetName);
    }

    deletePreset(id: string): boolean {
        const index = this.presets.findIndex(p => p.id === id);
        if (index === -1) return false;

        this.presets.splice(index, 1);
        this.persistPresets();
        return true;
    }

    private loadPresets(): void {
        const presetsPath = path.join(this.installPath, 'config', PRESETS_FILENAME);
        if (!fs.existsSync(presetsPath)) {
            this.presets = [];
            return;
        }

        try {
            this.presets = JSON.parse(fs.readFileSync(presetsPath, 'utf-8'));
        } catch {
            this.presets = [];
        }
    }

    private persistPresets(): void {
        const configDir = path.join(this.installPath, 'config');
        fs.mkdirSync(configDir, { recursive: true });

        const presetsPath = path.join(configDir, PRESETS_FILENAME);
        fs.writeFileSync(presetsPath, JSON.stringify(this.presets, null, 2));
    }

    // ========================================
    // Cleanup
    // ========================================

    async shutdown(): Promise<void> {
        await this.runtime.stop();
    }
}
