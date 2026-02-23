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
import * as http from 'http';
import * as https from 'https';
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
const CONVERT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const HIGH_PITCH_SAFETY_MIN_DURATION_MS = 1500;
const HIGH_PITCH_SAFETY_MAX_DURATION_MS = 12 * 60 * 1000;
const HIGH_PITCH_SAFETY_THRESHOLD_HZ = 460;
const LOCAL_ARTIFACT_SCAN_FRAME_MS = 12;
const LOCAL_ARTIFACT_SCAN_HOP_MS = 6;
const LOCAL_ARTIFACT_MARGIN_MS = 10;

interface ParsedPcm16WavFile {
    source: Buffer;
    sampleRate: number;
    channels: number;
    dataOffset: number;
    dataLength: number;
    samples: Int16Array;
    totalFrames: number;
    durationMs: number;
}

interface HighPitchRiskRegion {
    startFrame: number; // source timeline
    endFrame: number;   // source timeline (exclusive)
    peakHz: number;
    avgHz: number;
}

interface HighPitchSafetyPlan {
    regions: HighPitchRiskRegion[];
    dropSemitones: number;
    maxDetectedPitchHz: number;
    analyzedDurationMs: number;
}

interface LocalArtifactRegion {
    startFrame: number;
    endFrame: number;
    severity: number;
    clipRatioMax: number;
    nearClipRatioMax: number;
    highBandRatioMax: number;
}

export class RvcService {
    private static instance: RvcService | null = null;

    private bootstrapper: RvcBootstrapper;
    private runtime: RvcRuntime;
    private installPath: string;
    private verboseLogs = false;

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

        if (typeof options?.verboseLogs === 'boolean') {
            this.setVerboseLogs(options.verboseLogs);
        }

        return this.runtime.start(options);
    }

    async stopServer(): Promise<{ success: boolean }> {
        return this.runtime.stop();
    }

    async getGpuInfo(): Promise<GpuInfo> {
        return await this.runtime.getGpuInfo();
    }

    setVerboseLogs(enabled: boolean): void {
        this.verboseLogs = !!enabled;
        this.runtime.setVerboseLogs(this.verboseLogs);
    }

    getVerboseLogs(): boolean {
        return this.verboseLogs;
    }

    // ========================================
    // Models
    // ========================================

    getModelsPath(): string {
        return path.join(this.installPath, 'models');
    }

    private findModelPthPath(model: RvcModel): string | null {
        if (model.path.toLowerCase().endsWith('.pth') && fs.existsSync(model.path)) {
            return model.path;
        }
        if (!fs.existsSync(model.path) || !fs.statSync(model.path).isDirectory()) {
            return null;
        }
        const files = fs.readdirSync(model.path);
        const pth = files.find((f) => f.toLowerCase().endsWith('.pth'));
        if (!pth) return null;
        return path.join(model.path, pth);
    }

    private listIndexFilesInDirectory(dirPath: string): string[] {
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
            return [];
        }
        const files = fs.readdirSync(dirPath)
            .filter((f) => {
                const lower = f.toLowerCase();
                const isIndex = lower.endsWith('.index') || lower.endsWith('.ivf');
                if (!isIndex) return false;
                // RVC inference should use "added_*.index" style, not "trained_*.index".
                if (lower.includes('trained')) return false;
                return true;
            })
            .map((f) => path.join(dirPath, f));
        files.sort((a, b) => {
            const an = path.basename(a).toLowerCase();
            const bn = path.basename(b).toLowerCase();
            const as = an.includes('added') ? 0 : 1;
            const bs = bn.includes('added') ? 0 : 1;
            if (as !== bs) return as - bs;
            return an.localeCompare(bn);
        });
        return files;
    }

    async listModels(): Promise<RvcModel[]> {
        const modelsPath = this.getModelsPath();

        if (!fs.existsSync(modelsPath)) {
            return [];
        }

        const models: RvcModel[] = [];
        const entries = fs.readdirSync(modelsPath, { withFileTypes: true });

        for (const entry of entries) {
            // Support model file directly under models/ (e.g. ayako-02.pth)
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.pth')) {
                const fullPath = path.join(modelsPath, entry.name);
                const modelId = path.parse(entry.name).name;
                const indexFiles = this.listIndexFilesInDirectory(path.dirname(fullPath));
                models.push({
                    id: modelId,
                    name: modelId,
                    path: fullPath,
                    hasIndex: indexFiles.length > 0,
                });
                continue;
            }

            if (!entry.isDirectory()) {
                continue;
            }

            const modelDir = path.join(modelsPath, entry.name);
            const files = fs.readdirSync(modelDir);
            const pthFile = files.find((f) => f.toLowerCase().endsWith('.pth'));

            // A valid RVC model directory must have at least one .pth file.
            if (!pthFile) {
                continue;
            }

            const hasIndex = this.listIndexFilesInDirectory(modelDir).length > 0;

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

        return models;
    }

    async listModelIndexes(modelId: string): Promise<string[]> {
        const models = await this.listModels();
        const model = models.find((m) => m.id === modelId);
        if (!model) {
            return [];
        }
        const pthPath = this.findModelPthPath(model);
        if (!pthPath) {
            return [];
        }
        const modelDir = path.dirname(pthPath);
        return this.listIndexFilesInDirectory(modelDir);
    }

    async setModel(modelId: string): Promise<{ success: boolean; error?: RvcError; speaker_count?: number }> {
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
                const result = await response.json().catch(() => ({} as any));
                const speakerCountRaw = Number((result as any).speaker_count);
                const speakerCount = Number.isFinite(speakerCountRaw) && speakerCountRaw > 0
                    ? Math.floor(speakerCountRaw)
                    : undefined;
                this.activeModelId = modelId;
                return { success: true, speaker_count: speakerCount };
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
            this.runtime.beginConversion();
            let requestBody = this.buildConvertRequestBody(params);
            const warningParts: string[] = [];

            let highPitchRiskHintHz = 0;
            if (this.shouldApplyHighPitchQualityProtect(params)) {
                const tuned = this.maybeTuneRequestForHighPitchRisk(params, requestBody);
                requestBody = tuned.requestBody;
                if (tuned.warning) {
                    warningParts.push(tuned.warning);
                }
                if (typeof tuned.maxDetectedPitchHz === 'number' && tuned.maxDetectedPitchHz > 0) {
                    highPitchRiskHintHz = tuned.maxDetectedPitchHz;
                }
            }

            const baseResponse = await this.requestConvertBinary(`${endpoint}/convert`, requestBody);
            if (!baseResponse.success || !baseResponse.buffer) {
                return {
                    success: false,
                    error: {
                        code: 'E_CONVERT_FAILED',
                        message: baseResponse.error || 'Conversion failed',
                    },
                };
            }

            let finalBuffer = baseResponse.buffer;
            const harshnessGuard = this.applyOutputHarshnessGuardIfNeeded(finalBuffer, {
                enabled: this.shouldApplyHighPitchQualityProtect(params),
                highPitchHintHz: highPitchRiskHintHz,
            });
            if (harshnessGuard.buffer) {
                finalBuffer = harshnessGuard.buffer;
            }
            if (harshnessGuard.warning) {
                warningParts.push(harshnessGuard.warning);
            }

            const localArtifactRepair = this.applyLocalizedArtifactRepairIfNeeded(finalBuffer, {
                enabled: this.shouldApplyHighPitchQualityProtect(params),
                highPitchHintHz: highPitchRiskHintHz,
            });
            if (localArtifactRepair.buffer) {
                finalBuffer = localArtifactRepair.buffer;
            }
            if (localArtifactRepair.warning) {
                warningParts.push(localArtifactRepair.warning);
            }

            const clipGuard = this.applyOutputClipGuardIfNeeded(finalBuffer);
            if (clipGuard.buffer) {
                finalBuffer = clipGuard.buffer;
            }
            if (clipGuard.warning) {
                warningParts.push(clipGuard.warning);
            }

            return this.createConvertResultFromWavBuffer(finalBuffer, warningParts.join(' | ') || undefined);

        } catch (err) {
            return {
                success: false,
                error: {
                    code: 'E_CONVERT_FAILED',
                    message: err instanceof Error ? err.message : String(err),
                },
            };
        } finally {
            this.runtime.endConversion();
        }
    }

    private buildConvertRequestBody(
        params: RvcConvertParams,
        overrides?: Partial<Pick<RvcConvertParams, 'transpose'>>,
    ): Record<string, unknown> {
        return {
            model_id: params.modelId || this.activeModelId,
            index_path: params.indexPath,
            speaker_id: params.speakerId ?? 0,
            input_path: params.inputPath,
            input_base64: params.inputBase64,
            f0_method: params.f0Method || 'rmvpe',
            transpose: overrides?.transpose ?? params.transpose ?? 0,
            index_rate: params.indexRate ?? 0.75,
            protect: params.protect ?? 0.33,
            filter_radius: params.filterRadius ?? 3,
            rms_mix_rate: params.rmsMixRate ?? 0.25,
            resample_sr: params.resampleSr ?? 0,
        };
    }

    private async requestConvertBinary(
        urlString: string,
        requestBody: Record<string, unknown>,
    ): Promise<{ success: boolean; buffer?: Buffer; error?: string }> {
        if (this.verboseLogs) {
            console.log('[RvcService] Convert request:', {
                ...requestBody,
                input_base64: requestBody.input_base64 ? '(base64 data)' : undefined,
            });
        }

        const response = await this.postJsonForBinary(
            urlString,
            requestBody,
            CONVERT_REQUEST_TIMEOUT_MS,
        );

        if (response.statusCode < 200 || response.statusCode >= 300) {
            return {
                success: false,
                error: `Conversion failed: ${response.body.toString('utf-8')}`,
            };
        }

        return {
            success: true,
            buffer: response.body,
        };
    }

    private createConvertResultFromWavBuffer(buffer: Buffer, warning?: string): RvcConvertResult {
        const audioBuffer = buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer;

        const cacheDir = path.join(this.installPath, CACHE_DIR);
        fs.mkdirSync(cacheDir, { recursive: true });

        const wavPath = path.join(cacheDir, `rvc_${Date.now()}.wav`);
        fs.writeFileSync(wavPath, buffer);

        const wavInfo = this.parseWavHeader(audioBuffer);
        return {
            success: true,
            wavPath,
            audioBase64: Buffer.from(audioBuffer).toString('base64'),
            durationMs: wavInfo.durationMs,
            sampleRate: wavInfo.sampleRate,
            warning,
        };
    }

    private maybeTuneRequestForHighPitchRisk(
        params: RvcConvertParams,
        requestBody: Record<string, unknown>,
    ): { requestBody: Record<string, unknown>; warning?: string; maxDetectedPitchHz?: number } {
        const sourcePath = String(params.inputPath || '').trim();
        if (!sourcePath) {
            return { requestBody };
        }

        let sourceParsed: ParsedPcm16WavFile;
        try {
            sourceParsed = this.parsePcm16WavFile(sourcePath);
        } catch {
            return { requestBody };
        }

        if (
            sourceParsed.durationMs < HIGH_PITCH_SAFETY_MIN_DURATION_MS
            || sourceParsed.durationMs > HIGH_PITCH_SAFETY_MAX_DURATION_MS
        ) {
            return { requestBody };
        }

        const plan = this.analyzeHighPitchSafetyPlan(sourceParsed);
        if (!plan || plan.regions.length === 0) {
            return { requestBody };
        }

        const nextBody: Record<string, unknown> = { ...requestBody };
        const changes: string[] = [];

        const currentF0 = String(nextBody.f0_method || 'rmvpe').trim().toLowerCase();
        if (currentF0 !== 'rmvpe') {
            nextBody.f0_method = 'rmvpe';
            changes.push(`f0:${currentF0}->rmvpe`);
        }

        const currentProtect = this.clampFloat(Number(nextBody.protect), 0, 0.5, 0.33);
        const protectFloor = plan.maxDetectedPitchHz >= 650 ? 0.46 : 0.42;
        const tunedProtect = this.clampFloat(Math.max(currentProtect, protectFloor), 0, 0.5, currentProtect);
        if (Math.abs(tunedProtect - currentProtect) >= 0.005) {
            nextBody.protect = Number(tunedProtect.toFixed(2));
            changes.push(`protect:${currentProtect.toFixed(2)}->${tunedProtect.toFixed(2)}`);
        }

        const currentIndexRate = this.clampFloat(Number(nextBody.index_rate), 0, 1, 0.75);
        const indexCap = plan.maxDetectedPitchHz >= 700 ? 0.42 : 0.55;
        const tunedIndexRate = this.clampFloat(Math.min(currentIndexRate, indexCap), 0, 1, currentIndexRate);
        if (Math.abs(tunedIndexRate - currentIndexRate) >= 0.01) {
            nextBody.index_rate = Number(tunedIndexRate.toFixed(2));
            changes.push(`index:${currentIndexRate.toFixed(2)}->${tunedIndexRate.toFixed(2)}`);
        }

        const currentFilterRadius = this.clampInt(Number(nextBody.filter_radius), 0, 7, 3);
        const filterFloor = plan.maxDetectedPitchHz >= 650 ? 5 : 4;
        const tunedFilterRadius = this.clampInt(Math.max(currentFilterRadius, filterFloor), 0, 7, currentFilterRadius);
        if (tunedFilterRadius !== currentFilterRadius) {
            nextBody.filter_radius = tunedFilterRadius;
            changes.push(`filter:${currentFilterRadius}->${tunedFilterRadius}`);
        }

        const currentRmsMix = this.clampFloat(Number(nextBody.rms_mix_rate), 0, 1, 0.25);
        const rmsCap = plan.maxDetectedPitchHz >= 700 ? 0.60 : 0.70;
        const tunedRmsMix = this.clampFloat(Math.min(currentRmsMix, rmsCap), 0, 1, currentRmsMix);
        if (Math.abs(tunedRmsMix - currentRmsMix) >= 0.01) {
            nextBody.rms_mix_rate = Number(tunedRmsMix.toFixed(2));
            changes.push(`rmsMix:${currentRmsMix.toFixed(2)}->${tunedRmsMix.toFixed(2)}`);
        }

        if (changes.length === 0) {
            return {
                requestBody,
                maxDetectedPitchHz: plan.maxDetectedPitchHz,
            };
        }

        return {
            requestBody: nextBody,
            warning: `High-note safeguard tuned params (${changes.join(', ')}; maxPitch≈${Math.round(plan.maxDetectedPitchHz)}Hz)`,
            maxDetectedPitchHz: plan.maxDetectedPitchHz,
        };
    }

    private applyOutputHarshnessGuardIfNeeded(
        buffer: Buffer,
        options: { enabled: boolean; highPitchHintHz?: number },
    ): { buffer?: Buffer; warning?: string } {
        if (!options.enabled) {
            return {};
        }

        let parsed: ParsedPcm16WavFile;
        try {
            parsed = this.parsePcm16WavBuffer(buffer);
        } catch {
            return {};
        }

        const before = this.measureHighBandHarshnessStats(parsed);
        const peakStats = this.measureWavPeakStats(parsed);
        const highPitchHintHz = Math.max(0, Number(options.highPitchHintHz || 0));

        const severityByHighRatio = Math.max(0, (before.highBandRatio - 0.34) / 0.24);
        const severityByHighPeak = Math.max(0, (before.highBandPeak - 0.28) / 0.32);
        const severityByNearClip = Math.max(0, (peakStats.nearClipRatio - 0.0015) / 0.008);
        const severityByPitchHint = highPitchHintHz > 0 ? Math.max(0, (highPitchHintHz - 460) / 360) : 0;
        const severity = Math.max(
            severityByHighRatio,
            severityByHighPeak,
            severityByNearClip,
            severityByPitchHint * 0.85,
        );

        const shouldRun = (
            highPitchHintHz >= 460
            || before.highBandRatio >= 0.40
            || before.highBandPeak >= 0.42
            || peakStats.nearClipRatio >= 0.002
        );
        if (!shouldRun || severity <= 0.05) {
            return {};
        }

        const threshold = this.clampFloat(
            before.highBandRms * (highPitchHintHz >= 620 ? 1.35 : 1.55) + 0.010,
            0.012,
            0.20,
            0.045,
        );
        const ratio = this.clampFloat(2.5 + severity * 3.0, 2.2, 6.0, 3.5);
        const maxReduction = this.clampFloat(0.18 + severity * 0.30, 0.16, 0.48, 0.28);
        const cutoffHz = this.clampFloat(highPitchHintHz >= 650 ? 3600 : 4200, 2800, 7000, 4200);
        const attackMs = 0.8;
        const releaseMs = this.clampFloat(highPitchHintHz >= 650 ? 34 : 24, 12, 60, 24);

        const working = this.parsePcm16WavBuffer(buffer);
        const changed = this.applySplitBandDeEsser(working, {
            cutoffHz,
            threshold,
            ratio,
            maxReduction,
            attackMs,
            releaseMs,
        });
        if (!changed) {
            return {};
        }

        const after = this.measureHighBandHarshnessStats(working);
        const afterPeakStats = this.measureWavPeakStats(working);
        const rmsLossDb = 20 * Math.log10((after.fullRms + 1e-9) / (before.fullRms + 1e-9));
        const improved = (
            after.highBandRatio <= before.highBandRatio * 0.96
            || after.highBandPeak <= before.highBandPeak - 0.03
            || afterPeakStats.nearClipRatio <= peakStats.nearClipRatio * 0.75
        ) && rmsLossDb > -1.8;

        if (!improved) {
            return {};
        }

        const output = this.encodePcm16WavBuffer(working);
        return {
            buffer: output,
            warning: `Harshness guard applied (highRatio ${before.highBandRatio.toFixed(3)}->${after.highBandRatio.toFixed(3)}, highPeak ${before.highBandPeak.toFixed(3)}->${after.highBandPeak.toFixed(3)})`,
        };
    }

    private applyLocalizedArtifactRepairIfNeeded(
        buffer: Buffer,
        options: { enabled: boolean; highPitchHintHz?: number },
    ): { buffer?: Buffer; warning?: string } {
        if (!options.enabled) {
            return {};
        }

        let parsed: ParsedPcm16WavFile;
        try {
            parsed = this.parsePcm16WavBuffer(buffer);
        } catch {
            return {};
        }

        const beforePeak = this.measureWavPeakStats(parsed);
        const beforeHarsh = this.measureHighBandHarshnessStats(parsed);
        const highPitchHintHz = Math.max(0, Number(options.highPitchHintHz || 0));
        const regions = this.scanLocalArtifactRegions(parsed, highPitchHintHz);
        if (regions.length === 0) {
            return {};
        }

        const working = this.parsePcm16WavBuffer(buffer);
        let repairedClipRuns = 0;
        let changed = false;
        const maxRegionsToRepair = 32;
        const targetRegions = regions.slice(0, maxRegionsToRepair);

        for (const region of targetRegions) {
            repairedClipRuns += this.repairClippedRunsInRegion(working, region.startFrame, region.endFrame);
            if (this.applyLocalizedRegionRepair(working, region, highPitchHintHz)) {
                changed = true;
            }
        }

        if (!changed && repairedClipRuns <= 0) {
            return {};
        }

        const afterPeak = this.measureWavPeakStats(working);
        const afterHarsh = this.measureHighBandHarshnessStats(working);
        const residualRegions = this.scanLocalArtifactRegions(working, highPitchHintHz);
        const rmsLossDb = 20 * Math.log10((afterHarsh.fullRms + 1e-9) / (beforeHarsh.fullRms + 1e-9));
        const improved = (
            afterPeak.clipRatio <= beforePeak.clipRatio * 0.95
            || afterPeak.nearClipRatio <= beforePeak.nearClipRatio * 0.90
            || residualRegions.length < regions.length
            || afterHarsh.highBandPeak <= beforeHarsh.highBandPeak - 0.025
        ) && rmsLossDb > -2.2;

        if (!improved) {
            return {};
        }

        return {
            buffer: this.encodePcm16WavBuffer(working),
            warning: `Local artifact repair applied (segments ${targetRegions.length}${regions.length > targetRegions.length ? `/${regions.length}` : ''}, clipRuns ${repairedClipRuns}, residual ${residualRegions.length})`,
        };
    }

    private applyOutputClipGuardIfNeeded(
        buffer: Buffer,
    ): { buffer?: Buffer; warning?: string } {
        let parsed: ParsedPcm16WavFile;
        try {
            parsed = this.parsePcm16WavBuffer(buffer);
        } catch {
            return {};
        }

        const statsBefore = this.measureWavPeakStats(parsed);
        const needsLimiter = statsBefore.clipRatio > 0
            || statsBefore.peak >= 0.998
            || statsBefore.nearClipRatio >= 0.0025;
        if (!needsLimiter) {
            return {};
        }

        const applied = this.applySoftLimiter(parsed);
        if (!applied) {
            return {};
        }

        const statsAfter = this.measureWavPeakStats(parsed);
        const output = this.encodePcm16WavBuffer(parsed);
        return {
            buffer: output,
            warning: `Clip guard applied (peak ${statsBefore.peak.toFixed(3)}->${statsAfter.peak.toFixed(3)}, clip ${(statsBefore.clipRatio * 100).toFixed(3)}%->${(statsAfter.clipRatio * 100).toFixed(3)}%)`,
        };
    }

    private measureWavPeakStats(parsed: ParsedPcm16WavFile): { peak: number; clipRatio: number; nearClipRatio: number } {
        const total = Math.max(1, parsed.samples.length);
        let peak = 0;
        let clipCount = 0;
        let nearClipCount = 0;
        for (let i = 0; i < parsed.samples.length; i += 1) {
            const v = Math.abs(parsed.samples[i] / 32768);
            if (v > peak) peak = v;
            if (v >= 0.999) clipCount += 1;
            if (v >= 0.985) nearClipCount += 1;
        }
        return {
            peak,
            clipRatio: clipCount / total,
            nearClipRatio: nearClipCount / total,
        };
    }

    private measureHighBandHarshnessStats(parsed: ParsedPcm16WavFile): {
        fullRms: number;
        highBandRms: number;
        highBandRatio: number;
        highBandPeak: number;
    } {
        const total = parsed.samples.length;
        if (total <= 0 || parsed.channels <= 0 || parsed.sampleRate <= 0) {
            return { fullRms: 0, highBandRms: 0, highBandRatio: 0, highBandPeak: 0 };
        }

        const cutoffHz = 4200;
        const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / parsed.sampleRate);
        const lowState = new Float32Array(parsed.channels);
        let fullEnergy = 0;
        let highEnergy = 0;
        let highPeak = 0;

        for (let i = 0; i < total; i += 1) {
            const ch = i % parsed.channels;
            const x = parsed.samples[i] / 32768;
            const low = lowState[ch] + alpha * (x - lowState[ch]);
            lowState[ch] = low;
            const high = x - low;
            const ah = Math.abs(high);
            fullEnergy += x * x;
            highEnergy += high * high;
            if (ah > highPeak) highPeak = ah;
        }

        const fullRms = Math.sqrt(fullEnergy / Math.max(1, total));
        const highBandRms = Math.sqrt(highEnergy / Math.max(1, total));
        const highBandRatio = highBandRms / (fullRms + 1e-9);
        return {
            fullRms,
            highBandRms,
            highBandRatio,
            highBandPeak: highPeak,
        };
    }

    private scanLocalArtifactRegions(
        parsed: ParsedPcm16WavFile,
        highPitchHintHz: number,
    ): LocalArtifactRegion[] {
        if (parsed.totalFrames <= 0 || parsed.channels <= 0 || parsed.sampleRate <= 0) {
            return [];
        }

        const frameLen = this.clampInt(
            Math.round((parsed.sampleRate * LOCAL_ARTIFACT_SCAN_FRAME_MS) / 1000),
            128,
            2048,
            512,
        );
        const hop = this.clampInt(
            Math.round((parsed.sampleRate * LOCAL_ARTIFACT_SCAN_HOP_MS) / 1000),
            64,
            frameLen,
            256,
        );
        const marginFrames = this.clampInt(
            Math.round((parsed.sampleRate * LOCAL_ARTIFACT_MARGIN_MS) / 1000),
            16,
            4096,
            441,
        );
        if (parsed.totalFrames < Math.max(32, Math.floor(frameLen / 2))) {
            return [];
        }

        const cutoffHz = this.clampFloat(highPitchHintHz >= 620 ? 3600 : 4200, 2800, 8000, 4200);
        const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / parsed.sampleRate);
        const candidates: LocalArtifactRegion[] = [];

        for (let startFrame = 0; startFrame < parsed.totalFrames; startFrame += hop) {
            const endFrame = Math.min(parsed.totalFrames, startFrame + frameLen);
            const frameCount = endFrame - startFrame;
            if (frameCount < 32) {
                break;
            }

            let clipCount = 0;
            let nearClipCount = 0;
            let peak = 0;
            let fullEnergy = 0;
            let highEnergy = 0;
            let prevMono = 0;
            let zc = 0;
            let firstMono = true;
            let lowMono = 0;

            for (let frame = startFrame; frame < endFrame; frame += 1) {
                const base = frame * parsed.channels;
                let mono = 0;
                for (let ch = 0; ch < parsed.channels; ch += 1) {
                    const s = parsed.samples[base + ch] / 32768;
                    const absS = Math.abs(s);
                    if (absS > peak) peak = absS;
                    if (absS >= 0.999) clipCount += 1;
                    if (absS >= 0.985) nearClipCount += 1;
                    mono += s;
                }
                mono /= parsed.channels;
                fullEnergy += mono * mono;
                lowMono = lowMono + alpha * (mono - lowMono);
                const high = mono - lowMono;
                highEnergy += high * high;

                if (!firstMono) {
                    if ((prevMono >= 0 && mono < 0) || (prevMono < 0 && mono >= 0)) {
                        zc += 1;
                    }
                } else {
                    firstMono = false;
                }
                prevMono = mono;
            }

            const totalSamples = frameCount * parsed.channels;
            const clipRatio = clipCount / Math.max(1, totalSamples);
            const nearClipRatio = nearClipCount / Math.max(1, totalSamples);
            const fullRms = Math.sqrt(fullEnergy / Math.max(1, frameCount));
            const highRms = Math.sqrt(highEnergy / Math.max(1, frameCount));
            const highBandRatio = highRms / (fullRms + 1e-9);
            const zcr = zc / Math.max(1, frameCount - 1);

            const severityClip = (clipRatio * 450) + (nearClipRatio * 28);
            const severityHarsh = (
                Math.max(0, highBandRatio - 0.33) * 2.8
                + Math.max(0, zcr - 0.16) * 4.0
                + Math.max(0, peak - 0.86) * 2.0
            );
            const pitchBias = highPitchHintHz > 0 ? Math.max(0, (highPitchHintHz - 460) / 350) * 0.45 : 0;
            const severity = this.clampFloat(Math.max(severityClip, severityHarsh) + pitchBias, 0, 4, 0);

            const flagged = (
                clipRatio > 0
                || (nearClipRatio >= 0.006 && (highBandRatio >= 0.34 || zcr >= 0.18))
                || (highBandRatio >= 0.58 && zcr >= 0.19 && peak >= 0.78)
            );

            if (!flagged || severity < 0.35) {
                continue;
            }

            candidates.push({
                startFrame: Math.max(0, startFrame - marginFrames),
                endFrame: Math.min(parsed.totalFrames, endFrame + marginFrames),
                severity,
                clipRatioMax: clipRatio,
                nearClipRatioMax: nearClipRatio,
                highBandRatioMax: highBandRatio,
            });
        }

        if (candidates.length === 0) {
            return [];
        }

        const merged: LocalArtifactRegion[] = [];
        const mergeGap = marginFrames + hop;
        for (const candidate of candidates) {
            const last = merged[merged.length - 1];
            if (last && candidate.startFrame <= last.endFrame + mergeGap) {
                last.endFrame = Math.max(last.endFrame, candidate.endFrame);
                last.severity = Math.max(last.severity, candidate.severity);
                last.clipRatioMax = Math.max(last.clipRatioMax, candidate.clipRatioMax);
                last.nearClipRatioMax = Math.max(last.nearClipRatioMax, candidate.nearClipRatioMax);
                last.highBandRatioMax = Math.max(last.highBandRatioMax, candidate.highBandRatioMax);
                continue;
            }
            merged.push({ ...candidate });
        }

        const maxCoverage = Math.floor(parsed.totalFrames * 0.65);
        let coveredFrames = 0;
        const limited: LocalArtifactRegion[] = [];
        for (const region of merged) {
            const len = Math.max(0, region.endFrame - region.startFrame);
            if (len <= 0) continue;
            if (limited.length >= 48) break;
            if (coveredFrames + len > maxCoverage && region.clipRatioMax <= 0 && region.nearClipRatioMax < 0.01) {
                continue;
            }
            limited.push(region);
            coveredFrames += len;
        }
        return limited;
    }

    private repairClippedRunsInRegion(parsed: ParsedPcm16WavFile, startFrame: number, endFrame: number): number {
        if (parsed.channels <= 0 || parsed.totalFrames <= 0) return 0;
        const start = Math.max(0, Math.min(parsed.totalFrames, startFrame));
        const end = Math.max(start, Math.min(parsed.totalFrames, endFrame));
        if (end - start < 2) return 0;

        let repairedRuns = 0;
        const threshold = 32750;

        for (let ch = 0; ch < parsed.channels; ch += 1) {
            let frame = start;
            while (frame < end) {
                const idx = frame * parsed.channels + ch;
                if (Math.abs(parsed.samples[idx]) < threshold) {
                    frame += 1;
                    continue;
                }

                const runStart = frame;
                while (frame < end) {
                    const runIdx = frame * parsed.channels + ch;
                    if (Math.abs(parsed.samples[runIdx]) < threshold) break;
                    frame += 1;
                }
                const runEnd = frame; // exclusive
                const beforeFrame = runStart - 1;
                const afterFrame = runEnd;
                if (runEnd - runStart <= 0) {
                    continue;
                }

                if (beforeFrame >= 0 && afterFrame < parsed.totalFrames) {
                    const a = parsed.samples[beforeFrame * parsed.channels + ch];
                    const b = parsed.samples[afterFrame * parsed.channels + ch];
                    const len = runEnd - runStart;
                    for (let k = 0; k < len; k += 1) {
                        const t = (k + 1) / (len + 1);
                        const interp = a + ((b - a) * t);
                        parsed.samples[(runStart + k) * parsed.channels + ch] = Math.max(-32768, Math.min(32767, Math.round(interp)));
                    }
                } else {
                    for (let k = runStart; k < runEnd; k += 1) {
                        const runIdx = k * parsed.channels + ch;
                        parsed.samples[runIdx] = Math.max(-32768, Math.min(32767, Math.round(parsed.samples[runIdx] * 0.88)));
                    }
                }
                repairedRuns += 1;
            }
        }

        return repairedRuns;
    }

    private applyLocalizedRegionRepair(
        parsed: ParsedPcm16WavFile,
        region: LocalArtifactRegion,
        highPitchHintHz: number,
    ): boolean {
        const startFrame = Math.max(0, Math.min(parsed.totalFrames, region.startFrame));
        const endFrame = Math.max(startFrame, Math.min(parsed.totalFrames, region.endFrame));
        if (endFrame - startFrame < 4 || parsed.channels <= 0) {
            return false;
        }

        const severityBase = this.clampFloat(region.severity + (highPitchHintHz >= 620 ? 0.18 : 0), 0.15, 2.5, 0.6);
        const fadeFrames = this.clampInt(Math.round(parsed.sampleRate * 0.006), 8, 1024, 256);
        const cutoffHz = this.clampFloat((highPitchHintHz >= 650 ? 3300 : 3900) - severityBase * 260, 2500, 7000, 3800);
        const lpAlpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / parsed.sampleRate);
        const lowState = new Float32Array(parsed.channels);
        const tanhDrive = this.clampFloat(1.18 + severityBase * 0.75, 1.05, 3.2, 1.6);
        const tanhNorm = Math.tanh(tanhDrive);
        const highGainMin = this.clampFloat(1 - (0.20 + 0.18 * severityBase), 0.45, 0.90, 0.72);
        const baseGainMin = this.clampFloat(1 - (0.05 + 0.05 * severityBase), 0.78, 0.98, 0.90);
        const wetBase = this.clampFloat(0.58 + 0.14 * severityBase, 0.45, 0.95, 0.68);

        let changed = false;
        for (let frame = startFrame; frame < endFrame; frame += 1) {
            const localHead = frame - startFrame;
            const localTail = (endFrame - 1) - frame;
            let env = 1;
            if (localHead < fadeFrames) {
                env = Math.min(env, (localHead + 1) / fadeFrames);
            }
            if (localTail < fadeFrames) {
                env = Math.min(env, (localTail + 1) / fadeFrames);
            }
            if (env <= 0) continue;

            const base = frame * parsed.channels;
            for (let ch = 0; ch < parsed.channels; ch += 1) {
                const idx = base + ch;
                const x = parsed.samples[idx] / 32768;
                const low = lowState[ch] + lpAlpha * (x - lowState[ch]);
                lowState[ch] = low;
                const high = x - low;
                const absX = Math.abs(x);
                const absHigh = Math.abs(high);
                const dyn = this.clampFloat(
                    severityBase
                    + (absX > 0.92 ? 0.45 : 0)
                    + (absHigh > 0.16 ? 0.25 : 0)
                    + (region.clipRatioMax > 0 ? 0.35 : 0),
                    0.15,
                    3.0,
                    severityBase,
                );
                const wet = this.clampFloat(wetBase + (absX > 0.95 ? 0.12 : 0), 0.4, 1, wetBase) * env;
                const highGain = this.clampFloat(1 - (1 - highGainMin) * env * Math.min(1.2, dyn), 0.35, 1, highGainMin);
                const baseGain = this.clampFloat(1 - (1 - baseGainMin) * 0.65 * env * Math.min(1.0, dyn), 0.72, 1, baseGainMin);

                let y = (low * baseGain) + (high * highGain);
                if (absX > 0.80 || absHigh > 0.11) {
                    y = Math.tanh(y * tanhDrive) / tanhNorm;
                }

                const out = (x * (1 - wet)) + (y * wet);
                const q = Math.max(-32768, Math.min(32767, Math.round(out * 32767)));
                if (q !== parsed.samples[idx]) {
                    parsed.samples[idx] = q;
                    changed = true;
                }
            }
        }

        return changed;
    }

    private applySoftLimiter(parsed: ParsedPcm16WavFile): boolean {
        if (parsed.samples.length === 0) return false;

        const threshold = 0.93;
        const knee = 3.2;
        const tanhNorm = Math.tanh(knee);
        let modified = false;
        let peakAfter = 0;

        for (let i = 0; i < parsed.samples.length; i += 1) {
            let x = parsed.samples[i] / 32768;
            const sign = x < 0 ? -1 : 1;
            const ax = Math.abs(x);

            if (ax > threshold) {
                const over = Math.min(1, Math.max(0, (ax - threshold) / (1 - threshold)));
                const compressed = threshold + (1 - threshold) * (Math.tanh(over * knee) / tanhNorm);
                x = sign * compressed;
                modified = true;
            }

            if (Math.abs(x) > peakAfter) {
                peakAfter = Math.abs(x);
            }

            const q = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
            if (q !== parsed.samples[i]) {
                parsed.samples[i] = q;
                modified = true;
            }
        }

        if (!modified) {
            return false;
        }

        const targetPeak = 0.968;
        if (peakAfter > targetPeak && peakAfter > 1e-6) {
            const gain = targetPeak / peakAfter;
            for (let i = 0; i < parsed.samples.length; i += 1) {
                const x = (parsed.samples[i] / 32768) * gain;
                parsed.samples[i] = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
            }
        }

        return true;
    }

    private applySplitBandDeEsser(
        parsed: ParsedPcm16WavFile,
        settings: {
            cutoffHz: number;
            threshold: number;
            ratio: number;
            maxReduction: number;
            attackMs: number;
            releaseMs: number;
        },
    ): boolean {
        if (parsed.samples.length === 0 || parsed.channels <= 0 || parsed.sampleRate <= 0) {
            return false;
        }

        const cutoffHz = this.clampFloat(settings.cutoffHz, 2500, 8000, 4200);
        const threshold = this.clampFloat(settings.threshold, 0.008, 0.25, 0.045);
        const ratio = this.clampFloat(settings.ratio, 1.2, 10, 3.5);
        const maxReduction = this.clampFloat(settings.maxReduction, 0.05, 0.85, 0.30);
        const attackMs = this.clampFloat(settings.attackMs, 0.1, 20, 0.8);
        const releaseMs = this.clampFloat(settings.releaseMs, 2, 200, 24);

        const lpAlpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / parsed.sampleRate);
        const attackCoeff = Math.exp(-1 / Math.max(1, (attackMs / 1000) * parsed.sampleRate));
        const releaseCoeff = Math.exp(-1 / Math.max(1, (releaseMs / 1000) * parsed.sampleRate));
        const minGain = Math.max(0.02, 1 - maxReduction);

        const lowState = new Float32Array(parsed.channels);
        const envState = new Float32Array(parsed.channels);
        let changed = false;

        for (let i = 0; i < parsed.samples.length; i += 1) {
            const ch = i % parsed.channels;
            const x = parsed.samples[i] / 32768;
            const low = lowState[ch] + lpAlpha * (x - lowState[ch]);
            lowState[ch] = low;
            const high = x - low;

            const level = Math.abs(high);
            let env = envState[ch];
            if (level > env) {
                env = (attackCoeff * env) + ((1 - attackCoeff) * level);
            } else {
                env = (releaseCoeff * env) + ((1 - releaseCoeff) * level);
            }
            envState[ch] = env;

            let gain = 1;
            if (env > threshold) {
                const over = env / Math.max(threshold, 1e-6);
                const compressedEnv = threshold * Math.pow(over, 1 / ratio);
                gain = compressedEnv / Math.max(env, 1e-6);
                if (gain < minGain) gain = minGain;
            }

            const y = low + (high * gain);
            const q = Math.max(-32768, Math.min(32767, Math.round(y * 32767)));
            if (q !== parsed.samples[i]) {
                parsed.samples[i] = q;
                changed = true;
            }
        }

        return changed;
    }

    private shouldApplyHighPitchQualityProtect(params: RvcConvertParams): boolean {
        // Opt-in only (currently enabled from file-conversion UI path). We use safe
        // parameter tuning and clip guard, not pitch-shift blending.
        if (params.autoHighPitchQualityProtect !== true) {
            return false;
        }
        if (params.inputBase64) {
            return false;
        }
        const inputPath = String(params.inputPath || '').trim();
        if (!inputPath) {
            return false;
        }
        if (path.extname(inputPath).toLowerCase() !== '.wav') {
            return false;
        }
        return fs.existsSync(inputPath);
    }

    private analyzeHighPitchSafetyPlan(parsed: ParsedPcm16WavFile): HighPitchSafetyPlan | null {
        const sourceFrames = parsed.totalFrames;
        if (sourceFrames <= 0 || parsed.channels <= 0 || parsed.sampleRate <= 0) {
            return null;
        }

        const decimation = Math.max(1, Math.floor(parsed.sampleRate / 16000));
        const analysisSampleRate = parsed.sampleRate / decimation;
        const analysisFrameCount = Math.floor(sourceFrames / decimation);
        if (analysisFrameCount < Math.floor(analysisSampleRate * 0.5)) {
            return null;
        }

        const mono = new Float32Array(analysisFrameCount);
        let globalEnergy = 0;
        for (let i = 0; i < analysisFrameCount; i += 1) {
            const sourceFrame = i * decimation;
            const sampleBase = sourceFrame * parsed.channels;
            let sum = 0;
            for (let ch = 0; ch < parsed.channels; ch += 1) {
                sum += parsed.samples[sampleBase + ch] || 0;
            }
            const normalized = (sum / parsed.channels) / 32768;
            mono[i] = normalized;
            globalEnergy += normalized * normalized;
        }
        const globalRms = Math.sqrt(globalEnergy / Math.max(1, mono.length));
        const rmsThreshold = Math.max(0.010, globalRms * 0.55);

        const frameSize = this.clampInt(Math.round(analysisSampleRate * 0.032), 256, 1024, 512);
        const hopSize = this.clampInt(Math.round(analysisSampleRate * 0.016), 96, 512, 256);
        if (mono.length < frameSize + 8) {
            return null;
        }

        const minFreqHz = 160;
        const maxFreqHz = 1100;
        const lagMin = this.clampInt(Math.floor(analysisSampleRate / maxFreqHz), 2, frameSize - 4, 6);
        const lagMax = this.clampInt(Math.floor(analysisSampleRate / minFreqHz), lagMin + 1, frameSize - 2, 80);

        const zcrGateHz = HIGH_PITCH_SAFETY_THRESHOLD_HZ * 0.72;
        const candidates: Array<{ startFrame: number; endFrame: number; pitchHz: number }> = [];
        let maxDetectedPitchHz = 0;

        for (let start = 0; start + frameSize <= mono.length; start += hopSize) {
            let energy = 0;
            let zc = 0;
            let prev = mono[start];
            for (let i = 1; i < frameSize; i += 1) {
                const s = mono[start + i];
                energy += s * s;
                if ((prev >= 0 && s < 0) || (prev < 0 && s >= 0)) {
                    zc += 1;
                }
                prev = s;
            }
            const rms = Math.sqrt(energy / Math.max(1, frameSize - 1));
            if (rms < rmsThreshold) {
                continue;
            }

            const zcrHzApprox = (zc / Math.max(1, frameSize - 1)) * analysisSampleRate * 0.5;
            if (zcrHzApprox < zcrGateHz) {
                continue;
            }

            const pitch = this.estimateFramePitchHzByAutocorrelation(
                mono,
                start,
                frameSize,
                analysisSampleRate,
                lagMin,
                lagMax,
            );
            if (!pitch || pitch.confidence < 0.28 || pitch.hz < HIGH_PITCH_SAFETY_THRESHOLD_HZ) {
                continue;
            }

            const srcStartFrame = Math.max(0, Math.floor(start * decimation));
            const srcEndFrame = Math.min(sourceFrames, Math.ceil((start + frameSize) * decimation));
            if (srcEndFrame - srcStartFrame < Math.floor(parsed.sampleRate * 0.02)) {
                continue;
            }
            candidates.push({
                startFrame: srcStartFrame,
                endFrame: srcEndFrame,
                pitchHz: pitch.hz,
            });
            if (pitch.hz > maxDetectedPitchHz) {
                maxDetectedPitchHz = pitch.hz;
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        const marginFrames = Math.floor(parsed.sampleRate * 0.045);
        const mergeGapFrames = Math.floor(parsed.sampleRate * 0.07);
        const minRegionFrames = Math.floor(parsed.sampleRate * 0.09);
        const regions: HighPitchRiskRegion[] = [];
        let current:
            | (HighPitchRiskRegion & { sumHz: number; count: number })
            | null = null;

        for (const candidate of candidates) {
            const startFrame = Math.max(0, candidate.startFrame - marginFrames);
            const endFrame = Math.min(sourceFrames, candidate.endFrame + marginFrames);
            if (!current) {
                current = {
                    startFrame,
                    endFrame,
                    peakHz: candidate.pitchHz,
                    avgHz: candidate.pitchHz,
                    sumHz: candidate.pitchHz,
                    count: 1,
                };
                continue;
            }
            if (startFrame <= current.endFrame + mergeGapFrames) {
                current.endFrame = Math.max(current.endFrame, endFrame);
                current.peakHz = Math.max(current.peakHz, candidate.pitchHz);
                current.sumHz += candidate.pitchHz;
                current.count += 1;
                current.avgHz = current.sumHz / current.count;
                continue;
            }
            if (current.endFrame - current.startFrame >= minRegionFrames) {
                regions.push({
                    startFrame: current.startFrame,
                    endFrame: current.endFrame,
                    peakHz: current.peakHz,
                    avgHz: current.avgHz,
                });
            }
            current = {
                startFrame,
                endFrame,
                peakHz: candidate.pitchHz,
                avgHz: candidate.pitchHz,
                sumHz: candidate.pitchHz,
                count: 1,
            };
        }
        if (current && current.endFrame - current.startFrame >= minRegionFrames) {
            regions.push({
                startFrame: current.startFrame,
                endFrame: current.endFrame,
                peakHz: current.peakHz,
                avgHz: current.avgHz,
            });
        }

        if (regions.length === 0) {
            return null;
        }

        let totalRegionFrames = 0;
        let p90Accumulator: number[] = [];
        for (const region of regions) {
            totalRegionFrames += Math.max(0, region.endFrame - region.startFrame);
            p90Accumulator.push(region.peakHz);
        }
        p90Accumulator = p90Accumulator.sort((a, b) => a - b);
        const p90 = p90Accumulator[Math.max(0, Math.floor((p90Accumulator.length - 1) * 0.9))] || maxDetectedPitchHz;
        const coverage = totalRegionFrames / Math.max(1, sourceFrames);

        let dropSemitones = 1;
        if (p90 >= 620 || coverage >= 0.16) {
            dropSemitones = 2;
        }
        if (p90 >= 760) {
            dropSemitones = 3;
        }

        return {
            regions,
            dropSemitones,
            maxDetectedPitchHz,
            analyzedDurationMs: parsed.durationMs,
        };
    }

    private estimateFramePitchHzByAutocorrelation(
        mono: Float32Array,
        start: number,
        frameSize: number,
        sampleRate: number,
        lagMin: number,
        lagMax: number,
    ): { hz: number; confidence: number } | null {
        if (start < 0 || start + frameSize > mono.length || lagMax <= lagMin) {
            return null;
        }

        let bestLag = -1;
        let bestScore = -Infinity;
        for (let lag = lagMin; lag <= lagMax; lag += 1) {
            let ab = 0;
            let aa = 0;
            let bb = 0;
            const len = frameSize - lag;
            for (let i = 0; i < len; i += 1) {
                const a = mono[start + i];
                const b = mono[start + i + lag];
                ab += a * b;
                aa += a * a;
                bb += b * b;
            }
            if (aa <= 1e-9 || bb <= 1e-9) {
                continue;
            }
            const score = ab / Math.sqrt(aa * bb);
            if (score > bestScore) {
                bestScore = score;
                bestLag = lag;
            }
        }

        if (bestLag <= 0 || !Number.isFinite(bestScore) || bestScore <= 0) {
            return null;
        }
        return {
            hz: sampleRate / bestLag,
            confidence: Math.max(0, Math.min(1, bestScore)),
        };
    }

    private parsePcm16WavFile(filePath: string): ParsedPcm16WavFile {
        const source = fs.readFileSync(filePath);
        return this.parsePcm16WavBuffer(source);
    }

    private parsePcm16WavBuffer(source: Buffer): ParsedPcm16WavFile {
        if (source.length < 44) {
            throw new Error('WAV payload too short');
        }
        if (source.toString('ascii', 0, 4) !== 'RIFF' || source.toString('ascii', 8, 12) !== 'WAVE') {
            throw new Error('Invalid WAV header');
        }

        let offset = 12;
        let audioFormat = 1;
        let channels = 1;
        let sampleRate = 44100;
        let bitsPerSample = 16;
        let dataOffset = -1;
        let dataLength = 0;

        while (offset + 8 <= source.length) {
            const chunkId = source.toString('ascii', offset, offset + 4);
            const chunkSize = source.readUInt32LE(offset + 4);
            const chunkDataStart = offset + 8;
            const chunkDataEnd = chunkDataStart + chunkSize;
            if (chunkDataEnd > source.length) {
                break;
            }

            if (chunkId === 'fmt ' && chunkSize >= 16) {
                audioFormat = source.readUInt16LE(chunkDataStart);
                channels = source.readUInt16LE(chunkDataStart + 2) || 1;
                sampleRate = source.readUInt32LE(chunkDataStart + 4) || 44100;
                bitsPerSample = source.readUInt16LE(chunkDataStart + 14) || 16;
            } else if (chunkId === 'data') {
                dataOffset = chunkDataStart;
                dataLength = chunkSize;
                break;
            }

            offset = chunkDataEnd + (chunkSize % 2);
        }

        if (dataOffset < 0) {
            throw new Error('WAV data chunk not found');
        }
        if (audioFormat !== 1) {
            throw new Error(`Unsupported WAV format: ${audioFormat}`);
        }
        if (bitsPerSample !== 16) {
            throw new Error(`Unsupported WAV bits per sample: ${bitsPerSample}`);
        }
        if (channels <= 0) {
            throw new Error(`Invalid WAV channels: ${channels}`);
        }
        if (dataOffset + dataLength > source.length) {
            dataLength = source.length - dataOffset;
        }
        if (dataLength < 2) {
            throw new Error('WAV data chunk is empty');
        }
        if (dataLength % 2 !== 0) {
            dataLength -= 1;
        }

        const sampleCount = Math.floor(dataLength / 2);
        const samples = new Int16Array(sampleCount);
        let pointer = dataOffset;
        for (let i = 0; i < sampleCount; i += 1) {
            samples[i] = source.readInt16LE(pointer);
            pointer += 2;
        }

        const totalFrames = Math.floor(sampleCount / channels);
        const durationMs = sampleRate > 0 && channels > 0
            ? Math.round((sampleCount / (sampleRate * channels)) * 1000)
            : 0;

        return {
            source,
            sampleRate,
            channels,
            dataOffset,
            dataLength,
            samples,
            totalFrames,
            durationMs,
        };
    }

    private encodePcm16WavBuffer(parsed: ParsedPcm16WavFile): Buffer {
        const output = Buffer.from(parsed.source);
        const maxSamples = Math.min(parsed.samples.length, Math.floor(parsed.dataLength / 2));
        let pointer = parsed.dataOffset;
        for (let i = 0; i < maxSamples; i += 1) {
            output.writeInt16LE(parsed.samples[i], pointer);
            pointer += 2;
        }
        return output;
    }

    private clampInt(value: number, min: number, max: number, fallback: number): number {
        if (!Number.isFinite(value)) return fallback;
        const rounded = Math.round(value);
        if (rounded < min) return min;
        if (rounded > max) return max;
        return rounded;
    }

    private clampFloat(value: number, min: number, max: number, fallback: number): number {
        if (!Number.isFinite(value)) return fallback;
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    private postJsonForBinary(urlString: string, payload: unknown, timeoutMs: number): Promise<{ statusCode: number; body: Buffer }> {
        return new Promise((resolve, reject) => {
            const url = new URL(urlString);
            const body = Buffer.from(JSON.stringify(payload), 'utf-8');
            const transport = url.protocol === 'https:' ? https : http;

            const req = transport.request({
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                path: `${url.pathname}${url.search}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.byteLength,
                },
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode ?? 0,
                        body: Buffer.concat(chunks),
                    });
                });
            });

            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`RVC convert timeout after ${Math.floor(timeoutMs / 1000)}s`));
            });

            req.on('error', (error) => {
                reject(error);
            });

            req.write(body);
            req.end();
        });
    }

    private parseWavHeader(buffer: ArrayBuffer): { sampleRate: number; durationMs: number } {
        if (buffer.byteLength < 44) {
            return { sampleRate: 44100, durationMs: 0 };
        }
        const view = new DataView(buffer);
        const sampleRate = view.getUint32(24, true);
        const bitsPerSample = view.getUint16(34, true);
        const numChannels = view.getUint16(22, true);
        const dataSize = buffer.byteLength - 44;
        const bytesPerSecond = sampleRate * numChannels * (bitsPerSample / 8);
        const durationMs = bytesPerSecond > 0
            ? Math.round((dataSize / bytesPerSecond) * 1000)
            : 0;
        return { sampleRate: sampleRate || 44100, durationMs };
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
