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

    async synthesize(params: TtsSynthesizeParams): Promise<TtsSynthesizeResult> {
        // Check runtime
        if (this.runtime.getState() !== 'running') {
            return {
                success: false,
                error: {
                    code: 'E_SERVER_FAILED',
                    message: 'TTS server is not running',
                },
            };
        }

        const endpoint = this.runtime.getEndpoint();
        if (!endpoint) {
            return {
                success: false,
                error: {
                    code: 'E_SERVER_FAILED',
                    message: 'No server endpoint available',
                },
            };
        }

        try {
            // Build synthesis request as query parameters (SBV2 API uses query params, not JSON body)
            const queryParams = new URLSearchParams();
            queryParams.set('text', params.text);
            if (params.modelId || this.activeModelId) {
                queryParams.set('model_name', params.modelId || this.activeModelId || '');
            }
            if (params.style) {
                queryParams.set('style', params.style);
            }
            // SBV2 uses 'length' for speed (1.0 is normal, higher = slower)
            if (params.speed !== undefined) {
                queryParams.set('length', String(params.speed));
            }
            if (params.pitch !== undefined) {
                // Pitch is handled by style vectors or separateparam?
                // Standard SBV2 API doesn't have direct 'pitch' query param in default server_fastapi.py,
                // but some forks do. Standard one usually relies on style. 
                // IF server_fastapi.py doesn't support it, we might need to rely on SSML or style modification.
                // However, based on user request, let's pass it if supported or used in modified server.
                // Checking server_fastapi.py: It doesn't seem to have pitch/intonation params in the `voice` endpoint sig.
                // Wait, user requirements said "Pitch", "Intonation".
                // Let's check server_fastapi.py again.
                // It has: sdp_ratio, noise, noisew, length, language, auto_split, split_interval, assist_text, assist_text_weight, style, style_weight.
                // It DOES NOT have pitch or intonation.
                // BUT, VITS2 models usually infer pitch/intonation from text/style.
                // If user wants pitch/intonation control, we might need to modify server_fastapi.py deeper or use simple post-processing (unlikely for intonation).
                // FOR NOW, we will implement the V2 params that ARE supported:
            }

            // V2.0 Params
            if (params.styleWeight !== undefined) queryParams.set('style_weight', String(params.styleWeight));
            if (params.sdpRatio !== undefined) queryParams.set('sdp_ratio', String(params.sdpRatio));
            if (params.noiseScale !== undefined) queryParams.set('noise', String(params.noiseScale));
            if (params.noiseScaleW !== undefined) queryParams.set('noisew', String(params.noiseScaleW));

            if (params.assistText) {
                queryParams.set('assist_text', params.assistText);
                // We could also expose assist_text_weight, default to 1.0 or user defined?
                // User spec didn't strictly ask for weight slider, but good to have default.
                queryParams.set('assist_text_weight', '1.0');
            }

            // Audio Enhancement (Post-Processing)
            if (params.postFilter !== undefined) {
                queryParams.set('post_filter', String(params.postFilter));
            }
            if (params.filterStrength !== undefined) {
                queryParams.set('filter_strength', String(params.filterStrength));
            }

            const requestUrl = `${endpoint}/voice?${queryParams.toString()}`;
            console.log('[Sbv2Service] Synthesize Request Params:', Object.fromEntries(queryParams.entries()));
            console.log(`[Sbv2Service] Sending Request: ${requestUrl}`);

            const response = await fetch(requestUrl, {
                method: 'POST',
            });

            if (!response.ok) {
                const errorText = await response.text();
                return {
                    success: false,
                    error: {
                        code: 'E_SERVER_FAILED',
                        message: `Synthesis failed: ${errorText}`,
                    },
                };
            }

            // Get audio data
            const audioBuffer = await response.arrayBuffer();

            // Save to cache
            const cacheDir = path.join(this.installPath, CACHE_DIR);
            fs.mkdirSync(cacheDir, { recursive: true });

            const wavPath = path.join(cacheDir, `synth_${Date.now()}.wav`);
            fs.writeFileSync(wavPath, Buffer.from(audioBuffer));

            // Parse WAV header for duration (simplified)
            const durationMs = this.estimateWavDuration(audioBuffer);

            return {
                success: true,
                wavPath,
                audioBase64: Buffer.from(audioBuffer).toString('base64'),
                durationMs,
                sampleRate: 44100, // Default, should be read from header
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
        // Simple WAV duration estimation
        // Assumes 44100Hz, 16-bit, mono for estimation
        const dataSize = buffer.byteLength - 44; // Subtract header
        const bytesPerSecond = 44100 * 2; // 16-bit = 2 bytes
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
