/**
 * RvcService - RVC (Retrieval-based Voice Conversion) Main Controller
 *
 * Singleton service that orchestrates:
 * - Installation (via RvcBootstrapper)
 * - Runtime management (via RvcRuntime)
 * - Voice conversion requests
 * - Model/Preset management
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { RvcBootstrapper } from './RvcBootstrapper';
import { RvcRuntime } from './RvcRuntime';
import {
    RvcStatus,
    RvcInstallOptions,
    RvcInstallResult,
    RvcInstallState,
    RvcConvertParams,
    RvcConvertResult,
    RvcModel,
    RvcModelMeta,
    RvcPreset,
    RvcError,
    RvcStartOptions,
} from '../../../types/rvc';
import { GpuInfo } from '../../../types/tts';

// ========================================
// Constants
// ========================================

const PRESETS_FILENAME = 'rvc_presets.json';
const CACHE_DIR = 'audio_cache';

export class RvcService {
    private static instance: RvcService | null = null;

    private bootstrapper: RvcBootstrapper;
    private runtime: RvcRuntime;
    private installPath: string;

    private presets: RvcPreset[] = [];
    private activeModelId: string | null = null;

    private constructor(resourcesPath: string) {
        this.installPath = path.join(
            process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
            'AntiGravity',
            'tts',
            'rvc'
        );

        this.bootstrapper = new RvcBootstrapper(resourcesPath);
        this.runtime = new RvcRuntime(this.installPath);

        this.loadPresets();
    }

    static getInstance(resourcesPath?: string): RvcService {
        if (!RvcService.instance) {
            const resPath = resourcesPath || (
                app.isPackaged
                    ? process.resourcesPath
                    : path.join(__dirname, '../../../resources')
            );
            RvcService.instance = new RvcService(resPath);
        }
        return RvcService.instance;
    }

    // ========================================
    // Status
    // ========================================

    getStatus(): RvcStatus {
        const installCheck = this.bootstrapper.checkInstalled();

        let installState: RvcInstallState = 'not_installed';
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

    async install(options?: RvcInstallOptions): Promise<RvcInstallResult> {
        return this.bootstrapper.install(options);
    }

    async repair(): Promise<RvcInstallResult> {
        await this.runtime.stop();
        return this.bootstrapper.repair();
    }

    async uninstall(): Promise<{ success: boolean; error?: RvcError }> {
        await this.runtime.stop();
        return this.bootstrapper.uninstall();
    }

    // ========================================
    // Runtime
    // ========================================

    async startServer(options?: RvcStartOptions): Promise<{ success: boolean; port?: number; error?: RvcError }> {
        const installCheck = this.bootstrapper.checkInstalled();
        if (!installCheck.installed) {
            return {
                success: false,
                error: {
                    code: 'E_SERVER_FAILED',
                    message: 'RVC is not installed. Please install first.',
                },
            };
        }

        return this.runtime.start(options);
    }

    async stopServer(): Promise<{ success: boolean }> {
        return this.runtime.stop();
    }

    async getGpuInfo(): Promise<GpuInfo> {
        return await this.runtime.getGpuInfo();
    }

    // ========================================
    // Models
    // ========================================

    async listModels(): Promise<RvcModel[]> {
        const modelsPath = path.join(this.installPath, 'models');

        if (!fs.existsSync(modelsPath)) {
            return [];
        }

        const models: RvcModel[] = [];
        const entries = fs.readdirSync(modelsPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const modelDir = path.join(modelsPath, entry.name);
                const modelPthPath = path.join(modelDir, 'model.pth');

                // A valid RVC model must have model.pth
                if (!fs.existsSync(modelPthPath)) {
                    continue;
                }

                const hasIndex = fs.existsSync(path.join(modelDir, 'index.ivf'));

                // Read optional meta.json
                let meta: RvcModelMeta | undefined;
                const metaPath = path.join(modelDir, 'meta.json');
                if (fs.existsSync(metaPath)) {
                    try {
                        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                    } catch {
                        // Ignore meta parse errors
                    }
                }

                models.push({
                    id: entry.name,
                    name: meta?.displayName || entry.name,
                    path: modelDir,
                    hasIndex,
                    meta,
                });
            }
        }

        return models;
    }

    async setModel(modelId: string): Promise<{ success: boolean; error?: RvcError }> {
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

        // If server is running, notify it
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
    // Voice Conversion
    // ========================================

    async convert(params: RvcConvertParams): Promise<RvcConvertResult> {
        if (this.runtime.getState() !== 'running') {
            return {
                success: false,
                error: {
                    code: 'E_SERVER_FAILED',
                    message: 'RVC server is not running',
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
            const requestBody = {
                model_id: params.modelId || this.activeModelId,
                input_path: params.inputPath,
                input_base64: params.inputBase64,
                f0_method: params.f0Method || 'rmvpe',
                transpose: params.transpose ?? 0,
                index_rate: params.indexRate ?? 0.75,
                protect: params.protect ?? 0.33,
                filter_radius: params.filterRadius ?? 3,
                rms_mix_rate: params.rmsMixRate ?? 0.25,
                resample_sr: params.resampleSr ?? 0,
            };

            console.log('[RvcService] Convert request:', { ...requestBody, input_base64: requestBody.input_base64 ? '(base64 data)' : undefined });

            const response = await fetch(`${endpoint}/convert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const errorText = await response.text();
                return {
                    success: false,
                    error: {
                        code: 'E_CONVERT_FAILED',
                        message: `Conversion failed: ${errorText}`,
                    },
                };
            }

            // Get audio data
            const audioBuffer = await response.arrayBuffer();

            // Save to cache
            const cacheDir = path.join(this.installPath, CACHE_DIR);
            fs.mkdirSync(cacheDir, { recursive: true });

            const wavPath = path.join(cacheDir, `rvc_${Date.now()}.wav`);
            fs.writeFileSync(wavPath, Buffer.from(audioBuffer));

            const durationMs = this.estimateWavDuration(audioBuffer);

            return {
                success: true,
                wavPath,
                audioBase64: Buffer.from(audioBuffer).toString('base64'),
                durationMs,
                sampleRate: 44100,
            };

        } catch (err) {
            return {
                success: false,
                error: {
                    code: 'E_CONVERT_FAILED',
                    message: err instanceof Error ? err.message : String(err),
                },
            };
        }
    }

    private estimateWavDuration(buffer: ArrayBuffer): number {
        const dataSize = buffer.byteLength - 44;
        const bytesPerSecond = 44100 * 2;
        return Math.round((dataSize / bytesPerSecond) * 1000);
    }

    // ========================================
    // Presets
    // ========================================

    getPresets(): RvcPreset[] {
        return [...this.presets];
    }

    savePreset(preset: Omit<RvcPreset, 'id' | 'createdAt' | 'updatedAt'>): RvcPreset {
        const now = new Date().toISOString();
        const newPreset: RvcPreset = {
            ...preset,
            id: `rvc_preset_${Date.now()}`,
            createdAt: now,
            updatedAt: now,
        };

        this.presets.push(newPreset);
        this.persistPresets();
        return newPreset;
    }

    updatePreset(id: string, updates: Partial<RvcPreset>): RvcPreset | null {
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
