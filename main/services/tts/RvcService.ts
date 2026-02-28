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
import { spawn } from 'child_process';
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
const QUALITY_LEARNING_FILENAME = 'rvc_quality_learning_profiles.json';
const CACHE_DIR = 'audio_cache';
const CONVERSION_ARCHIVE_DIR = 'conversion_history';
const CONVERT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const HIGH_PITCH_SAFETY_MIN_DURATION_MS = 1500;
const HIGH_PITCH_SAFETY_MAX_DURATION_MS = 12 * 60 * 1000;
const HIGH_PITCH_SAFETY_THRESHOLD_HZ = 460;
const LOCAL_ARTIFACT_SCAN_FRAME_MS = 12;
const LOCAL_ARTIFACT_SCAN_HOP_MS = 6;
const LOCAL_ARTIFACT_MARGIN_MS = 10;
const POST_GUARD_BALANCED_DURATION_MS = 30_000;
const POST_GUARD_SPEED_DURATION_MS = 90_000;

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

interface ArtifactSnapshotMetrics {
    sampleRate: number;
    channels: number;
    durationMs: number;
    peak: number;
    clipRatio: number;
    nearClipRatio: number;
    highBandRatio: number;
    highBandPeak: number;
    localArtifactRegions: number;
    highPitchHintHz: number;
}

interface RvcQualityLearningTuning {
    protectBoost: number;
    indexRateCapDelta: number;
    filterRadiusBoost: number;
    rmsMixRateCapDelta: number;
    deesserBias: number;
    localRepairBias: number;
    ffmpegRestoreBias: number;
}

interface RvcQualityLearningProfile {
    id: string;
    modelId: string;
    speakerId: number;
    indexEnabled: boolean;
    f0Method: string;
    totalConversions: number;
    recentIssueScoreEma: number;
    residualArtifactRegionsEma: number;
    finalNearClipRatioEma: number;
    finalClipRatioEma: number;
    finalHighBandRatioEma: number;
    finalHighBandPeakEma: number;
    improvementScoreEma: number;
    tuning: RvcQualityLearningTuning;
    updatedAt: string;
}

interface RvcQualityLearningStore {
    version: number;
    entries: Record<string, RvcQualityLearningProfile>;
}

export class RvcService {
    private static instance: RvcService | null = null;

    private bootstrapper: RvcBootstrapper;
    private runtime: RvcRuntime;
    private installPath: string;
    private verboseLogs = false;
    private ffmpegResolutionTried = false;
    private ffmpegCommandPath: string | null = null;
    private readonly qualityLearningStorePath: string;
    private readonly conversionArchiveRoot: string;
    private qualityLearningProfiles = new Map<string, RvcQualityLearningProfile>();
    private qualityLearningDirty = false;
    private qualityLearningLastPersistAt = 0;

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
        this.qualityLearningStorePath = path.join(this.installPath, 'config', QUALITY_LEARNING_FILENAME);
        this.conversionArchiveRoot = path.join(this.installPath, CONVERSION_ARCHIVE_DIR);

        this.loadPresets();
        this.loadQualityLearningProfiles();
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

        const tempCleanupPaths: string[] = [];
        try {
            this.runtime.beginConversion();
            const warningParts: string[] = [];
            const inputRewritten = this.maybeResolveInputPathFromConversionArchive(params);
            const effectiveParams = inputRewritten.params;
            const latencyPriority = effectiveParams.latencyPriority === true;
            if (inputRewritten.warning) {
                warningParts.push(inputRewritten.warning);
            }

            const learningProfile = latencyPriority
                ? undefined
                : this.getOrCreateQualityLearningProfile(effectiveParams);
            const inputConditioned = latencyPriority
                ? { params: effectiveParams, warnings: [] as string[], cleanupPaths: [] as string[] }
                : await this.maybePreconditionInputVocalForRvc(effectiveParams, learningProfile);
            for (const warning of inputConditioned.warnings) {
                warningParts.push(warning);
            }
            for (const p of inputConditioned.cleanupPaths) {
                tempCleanupPaths.push(p);
            }
            const requestParams = inputConditioned.params;

            let requestBody = this.buildConvertRequestBody(requestParams);

            let highPitchRiskHintHz = 0;
            if (!latencyPriority && this.shouldApplyHighPitchQualityProtect(requestParams)) {
                const tuned = this.maybeTuneRequestForHighPitchRisk(requestParams, requestBody, learningProfile);
                requestBody = tuned.requestBody;
                if (tuned.warning) {
                    warningParts.push(tuned.warning);
                }
                if (typeof tuned.maxDetectedPitchHz === 'number' && tuned.maxDetectedPitchHz > 0) {
                    highPitchRiskHintHz = tuned.maxDetectedPitchHz;
                }
            }

            const baseResponse = await this.requestConvertBinary(`${endpoint}/convert`, requestBody);
            if (baseResponse.warning) {
                warningParts.push(baseResponse.warning);
            }
            if (!baseResponse.success || !baseResponse.buffer) {
                return {
                    success: false,
                    error: {
                        code: 'E_CONVERT_FAILED',
                        message: baseResponse.error || 'Conversion failed',
                    },
                };
            }

            if (latencyPriority) {
                let finalBuffer = baseResponse.buffer;
                const quickClipGuard = this.applyOutputClipGuardIfNeeded(finalBuffer);
                if (quickClipGuard.buffer) {
                    finalBuffer = quickClipGuard.buffer;
                }
                if (quickClipGuard.warning) {
                    warningParts.push(`fast ${quickClipGuard.warning}`);
                }
                warningParts.push('RVC latency-priority mode (skipped heavy post-processing/archive)');

                return this.createConvertResultFromWavBuffer(finalBuffer, warningParts.join(' | ') || undefined);
            }

            const baseSnapshot = this.captureArtifactSnapshot(baseResponse.buffer, highPitchRiskHintHz);
            const mainRepair = await this.applyPostConvertQualitySafeguards(
                baseResponse.buffer,
                effectiveParams,
                highPitchRiskHintHz,
                learningProfile,
            );
            let finalBuffer = mainRepair.buffer;
            warningParts.push(...mainRepair.warnings);

            let finalSnapshot = this.captureArtifactSnapshot(finalBuffer, highPitchRiskHintHz);

            const rescueRetry = await this.maybeRunHighPitchRescueRetry({
                endpoint,
                params: effectiveParams,
                requestBody,
                highPitchRiskHintHz,
                learningProfile,
                currentFinalBuffer: finalBuffer,
                currentFinalSnapshot: finalSnapshot,
            });
            if (rescueRetry.buffer) {
                finalBuffer = rescueRetry.buffer;
            }
            if (rescueRetry.snapshot) {
                finalSnapshot = rescueRetry.snapshot;
            } else if (rescueRetry.buffer) {
                finalSnapshot = this.captureArtifactSnapshot(finalBuffer, highPitchRiskHintHz);
            }
            if (rescueRetry.warnings.length > 0) {
                warningParts.push(...rescueRetry.warnings);
            }
            this.updateQualityLearningProfileFromConversion(learningProfile, {
                base: baseSnapshot,
                final: finalSnapshot,
                warnings: warningParts,
            });
            const archive = this.archiveConvertedOutput(finalBuffer, effectiveParams, {
                warning: warningParts.join(' | ') || undefined,
                base: baseSnapshot,
                final: finalSnapshot,
                learningProfile,
            });
            if (archive.warning) {
                warningParts.push(archive.warning);
            }

            const result = this.createConvertResultFromWavBuffer(finalBuffer, warningParts.join(' | ') || undefined);
            if (archive.path) {
                result.archivedPath = archive.path;
            }
            if (learningProfile?.id) {
                result.learningProfileId = learningProfile.id;
            }
            return result;

        } catch (err) {
            return {
                success: false,
                error: {
                    code: 'E_CONVERT_FAILED',
                    message: err instanceof Error ? err.message : String(err),
                },
            };
        } finally {
            try {
                // Clean up temporary conditioned input files created for this convert request.
                for (const p of tempCleanupPaths) {
                    if (p && fs.existsSync(p)) {
                        fs.unlinkSync(p);
                    }
                }
            } catch {
                // Ignore cleanup failures.
            }
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

    private async maybeRunHighPitchRescueRetry(options: {
        endpoint: string;
        params: RvcConvertParams;
        requestBody: Record<string, unknown>;
        highPitchRiskHintHz: number;
        learningProfile?: RvcQualityLearningProfile;
        currentFinalBuffer: Buffer;
        currentFinalSnapshot?: ArtifactSnapshotMetrics;
    }): Promise<{ buffer?: Buffer; snapshot?: ArtifactSnapshotMetrics; warnings: string[] }> {
        const warnings: string[] = [];
        if (!this.shouldApplyHighPitchQualityProtect(options.params)) {
            return { warnings };
        }

        const highPitch = Math.max(0, options.highPitchRiskHintHz || 0);
        if (highPitch < 850) {
            return { warnings };
        }
        const currentSnapshot = options.currentFinalSnapshot;
        if (!currentSnapshot) {
            return { warnings };
        }

        const severeResidual = currentSnapshot.localArtifactRegions >= (highPitch >= 1050 ? 12 : 14)
            || currentSnapshot.highBandPeak >= (highPitch >= 1050 ? 0.30 : 0.34);
        const moderateResidual = currentSnapshot.localArtifactRegions >= 8
            || currentSnapshot.highBandPeak >= 0.28;
        if (!severeResidual && !moderateResidual) {
            return { warnings };
        }

        const durationMs = Math.max(0, Number(currentSnapshot.durationMs || 0));
        if (durationMs >= POST_GUARD_SPEED_DURATION_MS) {
            const extremeResidual = currentSnapshot.localArtifactRegions >= 20
                || currentSnapshot.highBandPeak >= 0.34
                || currentSnapshot.clipRatio > 0
                || currentSnapshot.nearClipRatio >= 0.004;
            if (!extremeResidual) {
                return { warnings };
            }
        } else if (durationMs >= POST_GUARD_BALANCED_DURATION_MS && !severeResidual) {
            return { warnings };
        }

        const retryBody: Record<string, unknown> = { ...options.requestBody };
        const retryChanges: string[] = [];

        const currentF0 = String(retryBody.f0_method || 'rmvpe').trim().toLowerCase();
        if (currentF0 !== 'rmvpe') {
            retryBody.f0_method = 'rmvpe';
            retryChanges.push(`f0:${currentF0}->rmvpe`);
        }

        const currentProtect = this.clampFloat(Number(retryBody.protect), 0, 0.5, 0.33);
        const retryProtectFloor = highPitch >= 1050 ? 0.49 : 0.47;
        const retryProtect = this.clampFloat(Math.max(currentProtect, retryProtectFloor), 0, 0.5, currentProtect);
        if (Math.abs(retryProtect - currentProtect) >= 0.005) {
            retryBody.protect = Number(retryProtect.toFixed(2));
            retryChanges.push(`protect:${currentProtect.toFixed(2)}->${retryProtect.toFixed(2)}`);
        }

        const hasIndexPath = typeof retryBody.index_path === 'string' && String(retryBody.index_path).trim().length > 0;
        const currentIndexRate = this.clampFloat(Number(retryBody.index_rate), 0, 1, 0.75);
        if (hasIndexPath) {
            const retryIndexCap = severeResidual
                ? (highPitch >= 1050 ? 0.08 : 0.12)
                : (highPitch >= 1050 ? 0.12 : 0.18);
            const retryIndex = this.clampFloat(Math.min(currentIndexRate, retryIndexCap), 0, 1, currentIndexRate);
            if (Math.abs(retryIndex - currentIndexRate) >= 0.01) {
                retryBody.index_rate = Number(retryIndex.toFixed(2));
                retryChanges.push(`index:${currentIndexRate.toFixed(2)}->${retryIndex.toFixed(2)}`);
            }
        }

        const currentFilterRadius = this.clampInt(Number(retryBody.filter_radius), 0, 7, 3);
        const retryFilterFloor = severeResidual ? 7 : 6;
        const retryFilter = this.clampInt(Math.max(currentFilterRadius, retryFilterFloor), 0, 7, currentFilterRadius);
        if (retryFilter !== currentFilterRadius) {
            retryBody.filter_radius = retryFilter;
            retryChanges.push(`filter:${currentFilterRadius}->${retryFilter}`);
        }

        const currentRmsMix = this.clampFloat(Number(retryBody.rms_mix_rate), 0, 1, 0.25);
        const retryRmsCap = severeResidual
            ? (highPitch >= 1050 ? 0.34 : 0.40)
            : (highPitch >= 1050 ? 0.40 : 0.46);
        const retryRmsMix = this.clampFloat(Math.min(currentRmsMix, retryRmsCap), 0, 1, currentRmsMix);
        if (Math.abs(retryRmsMix - currentRmsMix) >= 0.01) {
            retryBody.rms_mix_rate = Number(retryRmsMix.toFixed(2));
            retryChanges.push(`rmsMix:${currentRmsMix.toFixed(2)}->${retryRmsMix.toFixed(2)}`);
        }

        if (retryChanges.length === 0) {
            return { warnings };
        }

        const retryResp = await this.requestConvertBinary(`${options.endpoint}/convert`, retryBody);
        if (retryResp.warning) {
            warnings.push(retryResp.warning);
        }
        if (!retryResp.success || !retryResp.buffer) {
            warnings.push(`High-pitch rescue retry failed (${retryResp.error || 'conversion failed'})`);
            return { warnings };
        }

        const retryRepair = await this.applyPostConvertQualitySafeguards(
            retryResp.buffer,
            options.params,
            highPitch,
            options.learningProfile,
            'retry',
        );
        const retryFinalBuffer = retryRepair.buffer;
        const retryFinalSnapshot = this.captureArtifactSnapshot(retryFinalBuffer, highPitch);

        const currentScore = this.computeArtifactIssueScoreFromSnapshot(currentSnapshot);
        const retryScore = this.computeArtifactIssueScoreFromSnapshot(retryFinalSnapshot);
        const currentRegions = currentSnapshot.localArtifactRegions;
        const retryRegions = retryFinalSnapshot?.localArtifactRegions ?? Number.POSITIVE_INFINITY;
        const currentPeak = currentSnapshot.highBandPeak;
        const retryPeak = retryFinalSnapshot?.highBandPeak ?? Number.POSITIVE_INFINITY;
        const improved = (
            retryScore <= currentScore - Math.max(1.2, currentScore * 0.03)
            || retryRegions <= currentRegions - 3
            || retryPeak <= currentPeak - 0.025
        );

        if (!improved) {
            warnings.push(`High-pitch rescue retry not adopted (${retryChanges.join(', ')}, score ${currentScore.toFixed(1)}->${retryScore.toFixed(1)}, regions ${currentRegions}->${retryRegions})`);
            return { warnings };
        }

        warnings.push(`High-pitch rescue retry applied (${retryChanges.join(', ')}, score ${currentScore.toFixed(1)}->${retryScore.toFixed(1)}, regions ${currentRegions}->${retryRegions})`);
        warnings.push(...retryRepair.warnings);
        return {
            buffer: retryFinalBuffer,
            snapshot: retryFinalSnapshot,
            warnings,
        };
    }

    private maybeResolveInputPathFromConversionArchive(
        params: RvcConvertParams,
    ): { params: RvcConvertParams; warning?: string } {
        const inputPath = String(params.inputPath || '').trim();
        if (!inputPath || !fs.existsSync(inputPath)) {
            return { params };
        }

        const traced = this.traceOriginalSourceFromConversionArchive(inputPath);
        if (!traced || traced.depth <= 0 || !traced.effectivePath || traced.effectivePath === inputPath) {
            return { params };
        }

        return {
            params: { ...params, inputPath: traced.effectivePath },
            warning: `Archive source rewind applied (depth ${traced.depth}; using original source instead of converted WAV)`,
        };
    }

    private traceOriginalSourceFromConversionArchive(
        inputPath: string,
    ): { effectivePath: string; depth: number } | null {
        const maxDepth = 12;
        let currentPath = path.resolve(inputPath);
        let depth = 0;
        const seen = new Set<string>();

        for (let i = 0; i < maxDepth; i += 1) {
            const currentKey = currentPath.toLowerCase();
            if (seen.has(currentKey)) {
                break;
            }
            seen.add(currentKey);

            if (!this.isPathInside(currentPath, this.conversionArchiveRoot)) {
                break;
            }
            if (path.extname(currentPath).toLowerCase() !== '.wav') {
                break;
            }

            const metaPath = currentPath.replace(/\.wav$/i, '.json');
            if (!fs.existsSync(metaPath)) {
                break;
            }

            try {
                const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
                    source?: { inputPath?: unknown };
                };
                const nextPathRaw = typeof raw?.source?.inputPath === 'string'
                    ? raw.source.inputPath.trim()
                    : '';
                if (!nextPathRaw) {
                    break;
                }
                const nextPath = path.resolve(nextPathRaw);
                if (!fs.existsSync(nextPath)) {
                    break;
                }
                if (nextPath.toLowerCase() === currentPath.toLowerCase()) {
                    break;
                }
                currentPath = nextPath;
                depth += 1;
            } catch {
                break;
            }
        }

        if (depth <= 0) {
            return null;
        }
        return { effectivePath: currentPath, depth };
    }

    private isPathInside(candidatePath: string, parentPath: string): boolean {
        try {
            const rel = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
            return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        } catch {
            return false;
        }
    }

    private async maybePreconditionInputVocalForRvc(
        params: RvcConvertParams,
        learningProfile?: RvcQualityLearningProfile,
    ): Promise<{ params: RvcConvertParams; warnings: string[]; cleanupPaths: string[] }> {
        const warnings: string[] = [];
        const cleanupPaths: string[] = [];

        if (params.autoHighPitchQualityProtect !== true) {
            return { params, warnings, cleanupPaths };
        }

        const inputPath = String(params.inputPath || '').trim();
        const hasBase64 = typeof params.inputBase64 === 'string' && params.inputBase64.trim().length > 0;
        if (!inputPath && !hasBase64) {
            return { params, warnings, cleanupPaths };
        }
        if (inputPath && path.extname(inputPath).toLowerCase() !== '.wav') {
            return { params, warnings, cleanupPaths };
        }

        let sourceBuffer: Buffer;
        let sourceParsed: ParsedPcm16WavFile;
        try {
            if (inputPath) {
                sourceBuffer = fs.readFileSync(inputPath);
            } else {
                sourceBuffer = Buffer.from(String(params.inputBase64 || ''), 'base64');
            }
            sourceParsed = this.parsePcm16WavBuffer(sourceBuffer);
        } catch {
            return { params, warnings, cleanupPaths };
        }

        const plan = this.analyzeHighPitchSafetyPlan(sourceParsed);
        const highPitchHintHz = Math.max(0, plan?.maxDetectedPitchHz || 0);
        const basePeak = this.measureWavPeakStats(sourceParsed);
        const baseHarsh = this.measureHighBandHarshnessStats(sourceParsed);
        const baseRegions = this.scanLocalArtifactRegions(sourceParsed, highPitchHintHz, 0).length;

        const shouldPrecondition = (
            highPitchHintHz >= 460
            || baseRegions >= 3
            || baseHarsh.highBandPeak >= 0.30
            || baseHarsh.highBandRatio >= 0.20
            || basePeak.nearClipRatio > 0
        );
        if (!shouldPrecondition) {
            return { params, warnings, cleanupPaths };
        }

        let working = sourceBuffer;
        const stageWarnings: string[] = [];

        const harsh = this.applyOutputHarshnessGuardIfNeeded(working, {
            enabled: true,
            highPitchHintHz,
            learningProfile,
        });
        if (harsh.buffer) working = harsh.buffer;
        if (harsh.warning) stageWarnings.push(`input ${harsh.warning}`);

        const localRepair = this.applyLocalizedArtifactRepairIfNeeded(working, {
            enabled: true,
            highPitchHintHz,
            learningProfile,
        });
        if (localRepair.buffer) working = localRepair.buffer;
        if (localRepair.warning) stageWarnings.push(`input ${localRepair.warning}`);

        const ffmpegRestore = await this.applyFfmpegRestorationPassIfNeeded(working, {
            enabled: true,
            highPitchHintHz,
            learningProfile,
        });
        if (ffmpegRestore.buffer) working = ffmpegRestore.buffer;
        if (ffmpegRestore.warning) stageWarnings.push(`input ${ffmpegRestore.warning}`);

        const clipGuard = this.applyOutputClipGuardIfNeeded(working);
        if (clipGuard.buffer) working = clipGuard.buffer;
        if (clipGuard.warning) stageWarnings.push(`input ${clipGuard.warning}`);

        if (working === sourceBuffer && stageWarnings.length === 0) {
            return { params, warnings, cleanupPaths };
        }

        let finalParsed: ParsedPcm16WavFile;
        try {
            finalParsed = this.parsePcm16WavBuffer(working);
        } catch {
            return { params, warnings, cleanupPaths };
        }
        const finalPeak = this.measureWavPeakStats(finalParsed);
        const finalHarsh = this.measureHighBandHarshnessStats(finalParsed);
        const finalRegions = this.scanLocalArtifactRegions(finalParsed, highPitchHintHz, 0).length;
        const baseScore = this.computeArtifactIssueScore(basePeak, baseHarsh, baseRegions, highPitchHintHz);
        const finalScore = this.computeArtifactIssueScore(finalPeak, finalHarsh, finalRegions, highPitchHintHz);
        const rmsLossDb = 20 * Math.log10((finalHarsh.fullRms + 1e-9) / (baseHarsh.fullRms + 1e-9));

        const improved = (
            finalScore < baseScore - Math.max(0.8, baseScore * 0.02)
            || finalRegions < baseRegions
            || finalHarsh.highBandPeak < baseHarsh.highBandPeak - 0.02
        ) && rmsLossDb > -3.5;
        if (!improved) {
            if (stageWarnings.length > 0 && (baseRegions >= 12 || highPitchHintHz >= 900)) {
                warnings.push(`Input vocal precondition not adopted (score ${baseScore.toFixed(1)}->${finalScore.toFixed(1)}, regions ${baseRegions}->${finalRegions})`);
            }
            return { params, warnings, cleanupPaths };
        }

        const cacheDir = path.join(this.installPath, CACHE_DIR);
        fs.mkdirSync(cacheDir, { recursive: true });
        const tmpInputPath = path.join(cacheDir, `rvc_srcopt_${Date.now()}_${Math.floor(Math.random() * 100000)}.wav`);
        try {
            fs.writeFileSync(tmpInputPath, working);
        } catch {
            return { params, warnings, cleanupPaths };
        }
        cleanupPaths.push(tmpInputPath);

        warnings.push(
            `Input vocal precondition applied (score ${baseScore.toFixed(1)}->${finalScore.toFixed(1)}, regions ${baseRegions}->${finalRegions}, highPeak ${baseHarsh.highBandPeak.toFixed(3)}->${finalHarsh.highBandPeak.toFixed(3)})`,
        );
        for (const w of stageWarnings) {
            warnings.push(w);
        }

        return {
            params: {
                ...params,
                inputPath: tmpInputPath,
                inputBase64: undefined,
            },
            warnings,
            cleanupPaths,
        };
    }

    private async requestConvertBinary(
        urlString: string,
        requestBody: Record<string, unknown>,
    ): Promise<{ success: boolean; buffer?: Buffer; error?: string; warning?: string }> {
        if (this.verboseLogs) {
            console.log('[RvcService] Convert request:', {
                ...requestBody,
                input_base64: requestBody.input_base64 ? '(base64 data)' : undefined,
            });
        }

        let response: { statusCode: number; body: Buffer };
        try {
            response = await this.postJsonForBinary(
                urlString,
                requestBody,
                CONVERT_REQUEST_TIMEOUT_MS,
            );
        } catch (error) {
            const recovered = await this.tryRecoverFromConvertTransportError(urlString, error);
            if (!recovered.retriedUrl) {
                return {
                    success: false,
                    error: this.formatConvertTransportError(error),
                    warning: recovered.warning,
                };
            }
            try {
                response = await this.postJsonForBinary(
                    recovered.retriedUrl,
                    requestBody,
                    CONVERT_REQUEST_TIMEOUT_MS,
                );
            } catch (retryError) {
                return {
                    success: false,
                    error: `${this.formatConvertTransportError(retryError)}${recovered.warning ? ` (${recovered.warning})` : ''}`,
                    warning: recovered.warning,
                };
            }
            if (this.verboseLogs) {
                console.log('[RvcService] Convert transport recovered and retried:', recovered.warning || '(no detail)');
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
                return {
                    success: false,
                    error: `Conversion failed: ${response.body.toString('utf-8')}`,
                    warning: recovered.warning,
                };
            }
            return {
                success: true,
                buffer: response.body,
                warning: recovered.warning,
            };
        }

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

    private async tryRecoverFromConvertTransportError(
        urlString: string,
        error: unknown,
    ): Promise<{ retriedUrl?: string; warning?: string }> {
        if (!this.isRecoverableConvertTransportError(error)) {
            return {};
        }

        const endpointBefore = this.runtime.getEndpoint();
        if (this.verboseLogs) {
            console.warn('[RvcService] Convert transport error; attempting runtime restart:', this.formatConvertTransportError(error));
        }
        const restarted = await this.runtime.restart({ verboseLogs: this.verboseLogs });
        if (!restarted.success) {
            const reason = restarted.error?.message || 'restart failed';
            return {
                warning: `RVC transport recovery failed (${reason})`,
            };
        }

        const endpointAfter = this.runtime.getEndpoint();
        if (!endpointAfter) {
            return {
                warning: 'RVC transport recovery failed (no endpoint after restart)',
            };
        }

        const retriedUrl = this.rebindUrlToEndpoint(urlString, endpointAfter);
        const warning = endpointAfter !== endpointBefore
            ? `RVC server auto-restarted after transport reset (${endpointBefore || 'unknown'} -> ${endpointAfter})`
            : 'RVC server auto-restarted after transport reset';
        return { retriedUrl, warning };
    }

    private isRecoverableConvertTransportError(error: unknown): boolean {
        const code = String((error as { code?: unknown })?.code || '').toUpperCase();
        const message = this.formatConvertTransportError(error).toLowerCase();
        return (
            code === 'ECONNRESET'
            || code === 'ECONNREFUSED'
            || code === 'EPIPE'
            || code === 'UND_ERR_SOCKET'
            || message.includes('econnreset')
            || message.includes('socket hang up')
            || message.includes('econnrefused')
            || message.includes('read epipe')
        );
    }

    private formatConvertTransportError(error: unknown): string {
        if (error instanceof Error) {
            return error.message || error.name || String(error);
        }
        return String(error);
    }

    private rebindUrlToEndpoint(urlString: string, endpoint: string): string {
        try {
            const original = new URL(urlString);
            const base = new URL(endpoint);
            return new URL(`${original.pathname}${original.search}`, base).toString();
        } catch {
            const suffix = urlString.replace(/^https?:\/\/[^/]+/i, '');
            return `${endpoint}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
        }
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

    private getQualityLearningProfileKey(params: RvcConvertParams): string {
        const modelId = String(params.modelId || this.activeModelId || 'unknown_model').trim() || 'unknown_model';
        const speakerId = this.clampInt(Number(params.speakerId ?? 0), 0, 4096, 0);
        const indexEnabled = Boolean(String(params.indexPath || '').trim());
        const f0Method = String(params.f0Method || 'rmvpe').trim().toLowerCase() || 'rmvpe';
        return `${modelId}__sid${speakerId}__idx${indexEnabled ? 1 : 0}__f0_${f0Method}`;
    }

    private getDefaultQualityLearningTuning(): RvcQualityLearningTuning {
        return {
            protectBoost: 0,
            indexRateCapDelta: 0,
            filterRadiusBoost: 0,
            rmsMixRateCapDelta: 0,
            deesserBias: 0,
            localRepairBias: 0,
            ffmpegRestoreBias: 0,
        };
    }

    private getDefaultQualityLearningProfile(paramsOrKey: RvcConvertParams | string): RvcQualityLearningProfile {
        const now = new Date().toISOString();
        if (typeof paramsOrKey === 'string') {
            return {
                id: paramsOrKey,
                modelId: 'unknown_model',
                speakerId: 0,
                indexEnabled: false,
                f0Method: 'rmvpe',
                totalConversions: 0,
                recentIssueScoreEma: 0.18,
                residualArtifactRegionsEma: 0,
                finalNearClipRatioEma: 0,
                finalClipRatioEma: 0,
                finalHighBandRatioEma: 0.28,
                finalHighBandPeakEma: 0.16,
                improvementScoreEma: 0.05,
                tuning: this.getDefaultQualityLearningTuning(),
                updatedAt: now,
            };
        }
        const params = paramsOrKey;
        const profileId = this.getQualityLearningProfileKey(params);
        return {
            id: profileId,
            modelId: String(params.modelId || this.activeModelId || 'unknown_model').trim() || 'unknown_model',
            speakerId: this.clampInt(Number(params.speakerId ?? 0), 0, 4096, 0),
            indexEnabled: Boolean(String(params.indexPath || '').trim()),
            f0Method: String(params.f0Method || 'rmvpe').trim().toLowerCase() || 'rmvpe',
            totalConversions: 0,
            recentIssueScoreEma: 0.18,
            residualArtifactRegionsEma: 0,
            finalNearClipRatioEma: 0,
            finalClipRatioEma: 0,
            finalHighBandRatioEma: 0.28,
            finalHighBandPeakEma: 0.16,
            improvementScoreEma: 0.05,
            tuning: this.getDefaultQualityLearningTuning(),
            updatedAt: now,
        };
    }

    private sanitizeQualityLearningProfile(raw: Partial<RvcQualityLearningProfile>, key: string): RvcQualityLearningProfile {
        const base = this.getDefaultQualityLearningProfile(key);
        const tuningRaw = raw.tuning || {};
        return {
            id: String(raw.id || key),
            modelId: String(raw.modelId || base.modelId),
            speakerId: this.clampInt(Number(raw.speakerId), 0, 4096, base.speakerId),
            indexEnabled: typeof raw.indexEnabled === 'boolean' ? raw.indexEnabled : base.indexEnabled,
            f0Method: String(raw.f0Method || base.f0Method || 'rmvpe'),
            totalConversions: this.clampInt(Number(raw.totalConversions), 0, 10_000_000, base.totalConversions),
            recentIssueScoreEma: this.clampFloat(Number(raw.recentIssueScoreEma), 0, 10, base.recentIssueScoreEma),
            residualArtifactRegionsEma: this.clampFloat(Number(raw.residualArtifactRegionsEma), 0, 200, base.residualArtifactRegionsEma),
            finalNearClipRatioEma: this.clampFloat(Number(raw.finalNearClipRatioEma), 0, 1, base.finalNearClipRatioEma),
            finalClipRatioEma: this.clampFloat(Number(raw.finalClipRatioEma), 0, 1, base.finalClipRatioEma),
            finalHighBandRatioEma: this.clampFloat(Number(raw.finalHighBandRatioEma), 0, 4, base.finalHighBandRatioEma),
            finalHighBandPeakEma: this.clampFloat(Number(raw.finalHighBandPeakEma), 0, 4, base.finalHighBandPeakEma),
            improvementScoreEma: this.clampFloat(Number(raw.improvementScoreEma), -10, 10, base.improvementScoreEma),
            tuning: {
                protectBoost: this.clampFloat(Number((tuningRaw as Partial<RvcQualityLearningTuning>).protectBoost), -0.05, 0.14, 0),
                indexRateCapDelta: this.clampFloat(Number((tuningRaw as Partial<RvcQualityLearningTuning>).indexRateCapDelta), -0.28, 0.10, 0),
                filterRadiusBoost: this.clampFloat(Number((tuningRaw as Partial<RvcQualityLearningTuning>).filterRadiusBoost), -1, 2, 0),
                rmsMixRateCapDelta: this.clampFloat(Number((tuningRaw as Partial<RvcQualityLearningTuning>).rmsMixRateCapDelta), -0.28, 0.12, 0),
                deesserBias: this.clampFloat(Number((tuningRaw as Partial<RvcQualityLearningTuning>).deesserBias), -0.10, 0.28, 0),
                localRepairBias: this.clampFloat(Number((tuningRaw as Partial<RvcQualityLearningTuning>).localRepairBias), -0.25, 0.75, 0),
                ffmpegRestoreBias: this.clampFloat(Number((tuningRaw as Partial<RvcQualityLearningTuning>).ffmpegRestoreBias), -0.25, 0.45, 0),
            },
            updatedAt: String(raw.updatedAt || base.updatedAt),
        };
    }

    private loadQualityLearningProfiles(): void {
        if (!fs.existsSync(this.qualityLearningStorePath)) {
            return;
        }
        try {
            const rawText = fs.readFileSync(this.qualityLearningStorePath, 'utf-8');
            const parsed = JSON.parse(rawText) as Partial<RvcQualityLearningStore>;
            const entries = parsed.entries;
            if (!entries || typeof entries !== 'object') {
                return;
            }
            for (const [key, value] of Object.entries(entries)) {
                const profile = this.sanitizeQualityLearningProfile(value || {}, key);
                this.qualityLearningProfiles.set(key, profile);
            }
        } catch (error) {
            console.warn('[RvcService] Failed to load quality learning profiles:', error);
        }
    }

    private persistQualityLearningProfiles(force: boolean = false): void {
        if (!this.qualityLearningDirty) return;
        const nowMs = Date.now();
        if (!force && nowMs - this.qualityLearningLastPersistAt < 1500) {
            return;
        }
        try {
            const configDir = path.join(this.installPath, 'config');
            fs.mkdirSync(configDir, { recursive: true });
            const entries: Record<string, RvcQualityLearningProfile> = {};
            for (const [key, profile] of this.qualityLearningProfiles.entries()) {
                entries[key] = profile;
            }
            const payload: RvcQualityLearningStore = {
                version: 1,
                entries,
            };
            fs.writeFileSync(this.qualityLearningStorePath, JSON.stringify(payload, null, 2), 'utf-8');
            this.qualityLearningDirty = false;
            this.qualityLearningLastPersistAt = nowMs;
        } catch (error) {
            console.warn('[RvcService] Failed to persist quality learning profiles:', error);
        }
    }

    private getOrCreateQualityLearningProfile(params: RvcConvertParams): RvcQualityLearningProfile {
        const key = this.getQualityLearningProfileKey(params);
        const existing = this.qualityLearningProfiles.get(key);
        if (existing) {
            return existing;
        }
        const created = this.getDefaultQualityLearningProfile(params);
        this.qualityLearningProfiles.set(key, created);
        this.qualityLearningDirty = true;
        this.persistQualityLearningProfiles();
        return created;
    }

    private captureArtifactSnapshot(buffer: Buffer, highPitchHintHz: number): ArtifactSnapshotMetrics | undefined {
        try {
            const parsed = this.parsePcm16WavBuffer(buffer);
            const peak = this.measureWavPeakStats(parsed);
            const harsh = this.measureHighBandHarshnessStats(parsed);
            const localRegions = this.scanLocalArtifactRegions(parsed, highPitchHintHz).length;
            return {
                sampleRate: parsed.sampleRate,
                channels: parsed.channels,
                durationMs: parsed.durationMs,
                peak: this.roundNumber(peak.peak, 6),
                clipRatio: this.roundNumber(peak.clipRatio, 6),
                nearClipRatio: this.roundNumber(peak.nearClipRatio, 6),
                highBandRatio: this.roundNumber(harsh.highBandRatio, 6),
                highBandPeak: this.roundNumber(harsh.highBandPeak, 6),
                localArtifactRegions: localRegions,
                highPitchHintHz: this.roundNumber(highPitchHintHz || 0, 2),
            };
        } catch {
            return undefined;
        }
    }

    private computeArtifactIssueScore(
        peak: { peak: number; clipRatio: number; nearClipRatio: number },
        harsh: { fullRms: number; highBandRms: number; highBandRatio: number; highBandPeak: number },
        localRegions: number,
        highPitchHintHz: number,
    ): number {
        const highPitch = highPitchHintHz >= 900;
        const ultraHighPitch = highPitchHintHz >= 1050;
        const localWeight = ultraHighPitch ? 1.45 : highPitch ? 1.20 : 0.90;
        const highRatioTarget = ultraHighPitch ? 0.16 : highPitch ? 0.18 : 0.28;
        const highPeakTarget = ultraHighPitch ? 0.24 : highPitch ? 0.28 : 0.32;
        const peakTarget = highPitch ? 0.975 : 0.985;

        return (
            (localRegions * localWeight)
            + (peak.clipRatio * 1600)
            + (peak.nearClipRatio * 180)
            + Math.max(0, harsh.highBandRatio - highRatioTarget) * (highPitch ? 18 : 10)
            + Math.max(0, harsh.highBandPeak - highPeakTarget) * (highPitch ? 26 : 14)
            + Math.max(0, peak.peak - peakTarget) * 10
        );
    }

    private computeArtifactIssueScoreFromSnapshot(snapshot: ArtifactSnapshotMetrics | undefined): number {
        if (!snapshot) return Number.POSITIVE_INFINITY;
        const highPitch = snapshot.highPitchHintHz >= 900;
        const ultraHighPitch = snapshot.highPitchHintHz >= 1050;
        const localWeight = ultraHighPitch ? 1.45 : highPitch ? 1.20 : 0.90;
        const highRatioTarget = ultraHighPitch ? 0.16 : highPitch ? 0.18 : 0.28;
        const highPeakTarget = ultraHighPitch ? 0.24 : highPitch ? 0.28 : 0.32;
        const peakTarget = highPitch ? 0.975 : 0.985;
        return (
            (snapshot.localArtifactRegions * localWeight)
            + (snapshot.clipRatio * 1600)
            + (snapshot.nearClipRatio * 180)
            + Math.max(0, snapshot.highBandRatio - highRatioTarget) * (highPitch ? 18 : 10)
            + Math.max(0, snapshot.highBandPeak - highPeakTarget) * (highPitch ? 26 : 14)
            + Math.max(0, snapshot.peak - peakTarget) * 10
        );
    }

    private updateQualityLearningProfileFromConversion(
        profile: RvcQualityLearningProfile | undefined,
        payload: {
            base?: ArtifactSnapshotMetrics;
            final?: ArtifactSnapshotMetrics;
            warnings: string[];
        },
    ): void {
        if (!profile || !payload.final) {
            return;
        }
        const now = new Date().toISOString();
        const base = payload.base;
        const final = payload.final;
        const emaFast = (prev: number, next: number) => (prev * 0.78) + (next * 0.22);
        profile.totalConversions += 1;
        profile.finalNearClipRatioEma = this.clampFloat(emaFast(profile.finalNearClipRatioEma, final.nearClipRatio), 0, 1, profile.finalNearClipRatioEma);
        profile.finalClipRatioEma = this.clampFloat(emaFast(profile.finalClipRatioEma, final.clipRatio), 0, 1, profile.finalClipRatioEma);
        profile.finalHighBandRatioEma = this.clampFloat(emaFast(profile.finalHighBandRatioEma, final.highBandRatio), 0, 4, profile.finalHighBandRatioEma);
        profile.finalHighBandPeakEma = this.clampFloat(emaFast(profile.finalHighBandPeakEma, final.highBandPeak), 0, 4, profile.finalHighBandPeakEma);
        profile.residualArtifactRegionsEma = this.clampFloat(emaFast(profile.residualArtifactRegionsEma, final.localArtifactRegions), 0, 200, profile.residualArtifactRegionsEma);

        const residualIssueScore = (
            final.clipRatio * 450
            + final.nearClipRatio * 40
            + Math.max(0, final.highBandRatio - 0.32) * 2.4
            + Math.max(0, final.highBandPeak - 0.30) * 2.0
            + Math.max(0, final.localArtifactRegions) * 0.18
        );
        profile.recentIssueScoreEma = this.clampFloat(emaFast(profile.recentIssueScoreEma, residualIssueScore), 0, 10, profile.recentIssueScoreEma);

        let improvementScore = 0;
        if (base) {
            improvementScore =
                (base.localArtifactRegions - final.localArtifactRegions) * 0.6
                + ((base.nearClipRatio - final.nearClipRatio) * 80)
                + ((base.clipRatio - final.clipRatio) * 500)
                + ((base.highBandPeak - final.highBandPeak) * 3.0);
            profile.improvementScoreEma = this.clampFloat(emaFast(profile.improvementScoreEma, improvementScore), -10, 10, profile.improvementScoreEma);
        }

        const warningText = payload.warnings.join(' | ').toLowerCase();
        const usedHarsh = warningText.includes('harshness guard applied');
        const usedLocalRepair = warningText.includes('local artifact repair applied');
        const usedFfmpeg = warningText.includes('ffmpeg restoration applied');

        // Heuristic online tuning from residual problems / over-processing.
        const finalHighPitch = final.highPitchHintHz >= 900;
        const finalUltraHighPitch = final.highPitchHintHz >= 1050;
        const residualHeavy = (
            final.localArtifactRegions >= 2
            || final.nearClipRatio > 0.004
            || final.highBandPeak > 0.42
            || (finalHighPitch && final.highBandPeak > (finalUltraHighPitch ? 0.34 : 0.36))
            || (finalHighPitch && final.highBandRatio > (finalUltraHighPitch ? 0.20 : 0.22))
        );
        const residualModerate = (
            final.localArtifactRegions >= 1
            || final.nearClipRatio > 0.002
            || final.highBandRatio > 0.42
            || (finalHighPitch && final.highBandPeak > 0.30)
            || (finalHighPitch && final.highBandRatio > 0.18)
        );
        const veryClean = (
            final.localArtifactRegions === 0
            && final.nearClipRatio < 0.0008
            && final.highBandPeak < (finalHighPitch ? 0.24 : 0.28)
            && final.highBandRatio < (finalHighPitch ? 0.17 : 0.30)
        );
        const overProcessed = base
            ? (final.highBandRatio < Math.max(0.12, base.highBandRatio * 0.68) && improvementScore < 0.4)
            : false;

        if (residualHeavy) {
            profile.tuning.protectBoost = this.clampFloat(profile.tuning.protectBoost + 0.01, -0.05, 0.14, 0);
            profile.tuning.indexRateCapDelta = this.clampFloat(profile.tuning.indexRateCapDelta - 0.015, -0.28, 0.10, 0);
            profile.tuning.filterRadiusBoost = this.clampFloat(profile.tuning.filterRadiusBoost + 0.12, -1, 2, 0);
            profile.tuning.rmsMixRateCapDelta = this.clampFloat(profile.tuning.rmsMixRateCapDelta - 0.012, -0.28, 0.12, 0);
            profile.tuning.deesserBias = this.clampFloat(profile.tuning.deesserBias + 0.012, -0.10, 0.28, 0);
            profile.tuning.localRepairBias = this.clampFloat(profile.tuning.localRepairBias + 0.03, -0.25, 0.75, 0);
            profile.tuning.ffmpegRestoreBias = this.clampFloat(profile.tuning.ffmpegRestoreBias + 0.02, -0.25, 0.45, 0);
        } else if (residualModerate) {
            profile.tuning.protectBoost = this.clampFloat(profile.tuning.protectBoost + 0.004, -0.05, 0.14, 0);
            profile.tuning.indexRateCapDelta = this.clampFloat(profile.tuning.indexRateCapDelta - 0.006, -0.28, 0.10, 0);
            profile.tuning.deesserBias = this.clampFloat(profile.tuning.deesserBias + 0.004, -0.10, 0.28, 0);
            profile.tuning.localRepairBias = this.clampFloat(profile.tuning.localRepairBias + 0.01, -0.25, 0.75, 0);
        }

        if (veryClean) {
            profile.tuning.protectBoost = this.clampFloat(profile.tuning.protectBoost - 0.003, -0.05, 0.14, 0);
            profile.tuning.indexRateCapDelta = this.clampFloat(profile.tuning.indexRateCapDelta + 0.004, -0.28, 0.10, 0);
            profile.tuning.deesserBias = this.clampFloat(profile.tuning.deesserBias - 0.004, -0.10, 0.28, 0);
            profile.tuning.localRepairBias = this.clampFloat(profile.tuning.localRepairBias - 0.01, -0.25, 0.75, 0);
            profile.tuning.ffmpegRestoreBias = this.clampFloat(profile.tuning.ffmpegRestoreBias - 0.01, -0.25, 0.45, 0);
        }

        if (overProcessed) {
            profile.tuning.deesserBias = this.clampFloat(profile.tuning.deesserBias - 0.012, -0.10, 0.28, 0);
            profile.tuning.localRepairBias = this.clampFloat(profile.tuning.localRepairBias - 0.02, -0.25, 0.75, 0);
            if (usedFfmpeg && improvementScore <= 0.3) {
                profile.tuning.ffmpegRestoreBias = this.clampFloat(profile.tuning.ffmpegRestoreBias - 0.03, -0.25, 0.45, 0);
            }
        }

        if (!usedHarsh && residualModerate) {
            profile.tuning.deesserBias = this.clampFloat(profile.tuning.deesserBias + 0.004, -0.10, 0.28, 0);
        }
        if (!usedLocalRepair && final.localArtifactRegions > 0) {
            profile.tuning.localRepairBias = this.clampFloat(profile.tuning.localRepairBias + 0.01, -0.25, 0.75, 0);
        }
        if (!usedFfmpeg && (final.localArtifactRegions >= 2 || final.nearClipRatio > 0.004 || (finalHighPitch && final.highBandPeak > 0.30))) {
            profile.tuning.ffmpegRestoreBias = this.clampFloat(profile.tuning.ffmpegRestoreBias + 0.01, -0.25, 0.45, 0);
        }

        profile.updatedAt = now;
        this.qualityLearningProfiles.set(profile.id, profile);
        this.qualityLearningDirty = true;
        this.persistQualityLearningProfiles();
    }

    private archiveConvertedOutput(
        buffer: Buffer,
        params: RvcConvertParams,
        payload: {
            warning?: string;
            base?: ArtifactSnapshotMetrics;
            final?: ArtifactSnapshotMetrics;
            learningProfile?: RvcQualityLearningProfile;
        },
    ): { path?: string; warning?: string } {
        try {
            const now = new Date();
            const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const timestamp = `${dateDir.replace(/-/g, '')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}_${String(now.getMilliseconds()).padStart(3, '0')}`;
            const modelId = String(params.modelId || this.activeModelId || 'unknown_model').trim() || 'unknown_model';
            const speakerId = this.clampInt(Number(params.speakerId ?? 0), 0, 4096, 0);
            const baseName = `${timestamp}_${this.sanitizeFilename(modelId)}_sid${speakerId}`;

            const dir = path.join(this.conversionArchiveRoot, dateDir);
            fs.mkdirSync(dir, { recursive: true });
            const wavPath = path.join(dir, `${baseName}.wav`);
            const metaPath = path.join(dir, `${baseName}.json`);
            fs.writeFileSync(wavPath, buffer);

            const metadata = {
                createdAt: now.toISOString(),
                wavPath,
                modelId,
                speakerId,
                f0Method: String(params.f0Method || 'rmvpe'),
                transpose: Number(params.transpose ?? 0),
                indexPath: String(params.indexPath || ''),
                indexEnabled: Boolean(String(params.indexPath || '').trim()),
                protect: Number(params.protect ?? 0.33),
                indexRate: Number(params.indexRate ?? 0.75),
                filterRadius: Number(params.filterRadius ?? 3),
                rmsMixRate: Number(params.rmsMixRate ?? 0.25),
                resampleSr: Number(params.resampleSr ?? 0),
                warning: payload.warning,
                source: {
                    inputPath: String(params.inputPath || ''),
                    inputBase64: params.inputBase64 ? '(base64-provided)' : '',
                },
                analysis: {
                    base: payload.base,
                    final: payload.final,
                },
                learningProfile: payload.learningProfile
                    ? {
                        id: payload.learningProfile.id,
                        totalConversions: payload.learningProfile.totalConversions,
                        tuning: payload.learningProfile.tuning,
                        updatedAt: payload.learningProfile.updatedAt,
                    }
                    : undefined,
            };
            fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');
            return { path: wavPath };
        } catch (error) {
            return {
                warning: `auto_archive_failed(${error instanceof Error ? error.message : String(error)})`,
            };
        }
    }

    private sanitizeFilename(value: string): string {
        const cleaned = String(value || '')
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
        return cleaned || 'unknown';
    }

    private maybeTuneRequestForHighPitchRisk(
        params: RvcConvertParams,
        requestBody: Record<string, unknown>,
        learningProfile?: RvcQualityLearningProfile,
    ): { requestBody: Record<string, unknown>; warning?: string; maxDetectedPitchHz?: number } {
        const sourcePath = String(params.inputPath || '').trim();
        let sourceParsed: ParsedPcm16WavFile;
        if (sourcePath) {
            try {
                sourceParsed = this.parsePcm16WavFile(sourcePath);
            } catch {
                return { requestBody };
            }
        } else if (typeof params.inputBase64 === 'string' && params.inputBase64.trim()) {
            try {
                sourceParsed = this.parsePcm16WavBuffer(Buffer.from(params.inputBase64, 'base64'));
            } catch {
                return { requestBody };
            }
        } else {
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
        const learningProtectBoost = this.clampFloat(learningProfile?.tuning.protectBoost ?? 0, -0.04, 0.14, 0);
        const protectFloor = (plan.maxDetectedPitchHz >= 650 ? 0.46 : 0.42) + learningProtectBoost;
        const tunedProtect = this.clampFloat(Math.max(currentProtect, protectFloor), 0, 0.5, currentProtect);
        if (Math.abs(tunedProtect - currentProtect) >= 0.005) {
            nextBody.protect = Number(tunedProtect.toFixed(2));
            changes.push(`protect:${currentProtect.toFixed(2)}->${tunedProtect.toFixed(2)}`);
        }

        const currentIndexRate = this.clampFloat(Number(nextBody.index_rate), 0, 1, 0.75);
        const learningIndexDelta = this.clampFloat(learningProfile?.tuning.indexRateCapDelta ?? 0, -0.28, 0.08, 0);
        const indexCap = (plan.maxDetectedPitchHz >= 700 ? 0.42 : 0.55) + learningIndexDelta;
        const tunedIndexRate = this.clampFloat(Math.min(currentIndexRate, indexCap), 0, 1, currentIndexRate);
        if (Math.abs(tunedIndexRate - currentIndexRate) >= 0.01) {
            nextBody.index_rate = Number(tunedIndexRate.toFixed(2));
            changes.push(`index:${currentIndexRate.toFixed(2)}->${tunedIndexRate.toFixed(2)}`);
        }

        const currentFilterRadius = this.clampInt(Number(nextBody.filter_radius), 0, 7, 3);
        const learningFilterBoost = this.clampInt(Math.round(learningProfile?.tuning.filterRadiusBoost ?? 0), -1, 2, 0);
        const filterFloor = (plan.maxDetectedPitchHz >= 650 ? 5 : 4) + learningFilterBoost;
        const tunedFilterRadius = this.clampInt(Math.max(currentFilterRadius, filterFloor), 0, 7, currentFilterRadius);
        if (tunedFilterRadius !== currentFilterRadius) {
            nextBody.filter_radius = tunedFilterRadius;
            changes.push(`filter:${currentFilterRadius}->${tunedFilterRadius}`);
        }

        const currentRmsMix = this.clampFloat(Number(nextBody.rms_mix_rate), 0, 1, 0.25);
        const learningRmsDelta = this.clampFloat(learningProfile?.tuning.rmsMixRateCapDelta ?? 0, -0.28, 0.10, 0);
        const rmsCap = (plan.maxDetectedPitchHz >= 700 ? 0.60 : 0.70) + learningRmsDelta;
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

    private async applyPostConvertQualitySafeguards(
        buffer: Buffer,
        params: RvcConvertParams,
        highPitchRiskHintHz: number,
        learningProfile: RvcQualityLearningProfile | undefined,
        warningPrefix?: string,
    ): Promise<{ buffer: Buffer; warnings: string[] }> {
        const warnings: string[] = [];
        let finalBuffer = buffer;
        const protectEnabled = this.shouldApplyHighPitchQualityProtect(params);
        const prefix = warningPrefix ? `${warningPrefix} ` : '';

        const harshnessGuard = this.applyOutputHarshnessGuardIfNeeded(finalBuffer, {
            enabled: protectEnabled,
            highPitchHintHz: highPitchRiskHintHz,
            learningProfile,
        });
        if (harshnessGuard.buffer) {
            finalBuffer = harshnessGuard.buffer;
        }
        if (harshnessGuard.warning) {
            warnings.push(`${prefix}${harshnessGuard.warning}`);
        }

        const localArtifactRepair = this.applyLocalizedArtifactRepairIfNeeded(finalBuffer, {
            enabled: protectEnabled,
            highPitchHintHz: highPitchRiskHintHz,
            learningProfile,
        });
        if (localArtifactRepair.buffer) {
            finalBuffer = localArtifactRepair.buffer;
        }
        if (localArtifactRepair.warning) {
            warnings.push(`${prefix}${localArtifactRepair.warning}`);
        }

        const ffmpegRestore = await this.applyFfmpegRestorationPassIfNeeded(finalBuffer, {
            enabled: protectEnabled,
            highPitchHintHz: highPitchRiskHintHz,
            learningProfile,
        });
        if (ffmpegRestore.buffer) {
            finalBuffer = ffmpegRestore.buffer;
        }
        if (ffmpegRestore.warning) {
            warnings.push(`${prefix}${ffmpegRestore.warning}`);
        }

        const clipGuard = this.applyOutputClipGuardIfNeeded(finalBuffer);
        if (clipGuard.buffer) {
            finalBuffer = clipGuard.buffer;
        }
        if (clipGuard.warning) {
            warnings.push(`${prefix}${clipGuard.warning}`);
        }

        return { buffer: finalBuffer, warnings };
    }

    private applyOutputHarshnessGuardIfNeeded(
        buffer: Buffer,
        options: { enabled: boolean; highPitchHintHz?: number; learningProfile?: RvcQualityLearningProfile },
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
        const learningDeesserBiasRaw = this.clampFloat(options.learningProfile?.tuning.deesserBias ?? 0, -0.10, 0.28, 0);
        const learningDeesserBias = (highPitchHintHz >= 900)
            ? this.clampFloat(learningDeesserBiasRaw, highPitchHintHz >= 1050 ? 0.01 : -0.01, 0.28, 0)
            : learningDeesserBiasRaw;

        const severityByHighRatio = Math.max(0, (before.highBandRatio - 0.34) / 0.24);
        const severityByHighPeak = Math.max(0, (before.highBandPeak - 0.28) / 0.32);
        const severityByNearClip = Math.max(0, (peakStats.nearClipRatio - 0.0015) / 0.008);
        const severityByPitchHint = highPitchHintHz > 0 ? Math.max(0, (highPitchHintHz - 460) / 360) : 0;
        const severity = Math.max(
            severityByHighRatio,
            severityByHighPeak,
            severityByNearClip,
            severityByPitchHint * 0.85,
        ) + Math.max(-0.12, Math.min(0.22, learningDeesserBias * 0.9));

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
        const ratio = this.clampFloat(2.5 + severity * 3.0 + learningDeesserBias * 4.5, 2.2, 6.5, 3.5);
        const maxReduction = this.clampFloat(0.18 + severity * 0.30 + learningDeesserBias * 0.24, 0.14, 0.56, 0.28);
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
        options: { enabled: boolean; highPitchHintHz?: number; learningProfile?: RvcQualityLearningProfile },
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
        const durationMs = Math.max(0, Number(parsed.durationMs || 0));
        const highPitchMode = highPitchHintHz >= 900;
        const ultraHighPitchMode = highPitchHintHz >= 1050;
        const obviousNeed = (
            beforePeak.clipRatio > 0
            || beforePeak.nearClipRatio >= (highPitchMode ? 0.003 : 0.0045)
            || beforeHarsh.highBandPeak >= (highPitchMode ? 0.31 : 0.36)
            || beforeHarsh.highBandRatio >= (highPitchMode ? 0.23 : 0.32)
        );
        if (durationMs >= POST_GUARD_SPEED_DURATION_MS && !obviousNeed) {
            return {};
        }
        if (durationMs >= POST_GUARD_BALANCED_DURATION_MS && !highPitchMode && !obviousNeed) {
            return {};
        }
        const learningLocalBiasRaw = this.clampFloat(options.learningProfile?.tuning.localRepairBias ?? 0, -0.25, 0.75, 0);
        const learningLocalBias = highPitchMode
            ? this.clampFloat(learningLocalBiasRaw, ultraHighPitchMode ? 0.02 : -0.02, 0.75, 0)
            : learningLocalBiasRaw;
        const regions = this.scanLocalArtifactRegions(parsed, highPitchHintHz, learningLocalBias);
        if (regions.length === 0) {
            return {};
        }

        const working = this.parsePcm16WavBuffer(buffer);
        let repairedClipRuns = 0;
        let changed = false;
        let maxRegionsToRepair = highPitchMode
            ? this.clampInt(
                Math.max(
                    40,
                    Math.round(regions.length * (ultraHighPitchMode ? 0.95 : 0.88)) + Math.round(learningLocalBias * 8),
                ),
                20,
                64,
                48,
            )
            : this.clampInt(32 + Math.round(learningLocalBias * 10), 12, 64, 32);
        const durationScale = durationMs >= POST_GUARD_SPEED_DURATION_MS
            ? (ultraHighPitchMode ? 0.70 : 0.45)
            : durationMs >= POST_GUARD_BALANCED_DURATION_MS
                ? (highPitchMode ? 0.88 : 0.70)
                : 1;
        if (durationScale < 0.999) {
            maxRegionsToRepair = this.clampInt(
                Math.round(maxRegionsToRepair * durationScale),
                highPitchMode ? 16 : 10,
                64,
                maxRegionsToRepair,
            );
        }
        const targetRegions = regions.slice(0, maxRegionsToRepair);

        for (const region of targetRegions) {
            repairedClipRuns += this.repairClippedRunsInRegion(working, region.startFrame, region.endFrame);
            if (this.applyLocalizedRegionRepair(working, region, highPitchHintHz, learningLocalBias)) {
                changed = true;
            }
        }

        if (!changed && repairedClipRuns <= 0) {
            return {};
        }

        const afterPeak = this.measureWavPeakStats(working);
        const afterHarsh = this.measureHighBandHarshnessStats(working);
        const residualRegions = this.scanLocalArtifactRegions(working, highPitchHintHz, learningLocalBias);
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

    private async applyFfmpegRestorationPassIfNeeded(
        buffer: Buffer,
        options: { enabled: boolean; highPitchHintHz?: number; learningProfile?: RvcQualityLearningProfile },
    ): Promise<{ buffer?: Buffer; warning?: string }> {
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
        const durationMs = Math.max(0, Number(parsed.durationMs || 0));
        const learningFfmpegBiasRaw = this.clampFloat(options.learningProfile?.tuning.ffmpegRestoreBias ?? 0, -0.25, 0.45, 0);
        const learningFfmpegBias = (highPitchHintHz >= 900)
            ? this.clampFloat(learningFfmpegBiasRaw, highPitchHintHz >= 1050 ? 0.02 : -0.02, 0.45, 0)
            : learningFfmpegBiasRaw;
        const cheapSevereSignal = (
            beforePeak.clipRatio > 0
            || beforePeak.nearClipRatio >= (highPitchHintHz >= 900 ? 0.003 : 0.005)
            || beforeHarsh.highBandPeak >= (highPitchHintHz >= 900 ? 0.33 : 0.38)
            || beforeHarsh.highBandRatio >= (highPitchHintHz >= 900 ? 0.24 : 0.34)
        );
        const cheapModerateSignal = (
            beforePeak.nearClipRatio >= 0.002
            || beforeHarsh.highBandPeak >= (highPitchHintHz >= 900 ? 0.28 : 0.34)
            || beforeHarsh.highBandRatio >= (highPitchHintHz >= 900 ? 0.20 : 0.30)
        );
        if (durationMs >= POST_GUARD_SPEED_DURATION_MS && !cheapSevereSignal) {
            return {};
        }
        if (durationMs >= POST_GUARD_BALANCED_DURATION_MS && !cheapModerateSignal) {
            return {};
        }
        const beforeRegions = this.scanLocalArtifactRegions(parsed, highPitchHintHz, learningFfmpegBias * 0.6);

        const extremeHighPitch = highPitchHintHz >= 900;
        const ultraHighPitch = highPitchHintHz >= 1050;
        const harshRatioTrigger = this.clampFloat(
            (ultraHighPitch ? 0.19 : extremeHighPitch ? 0.22 : 0.34) - learningFfmpegBias * 0.10,
            0.16,
            0.46,
            0.34,
        );
        const harshPeakTrigger = this.clampFloat(
            (ultraHighPitch ? 0.28 : extremeHighPitch ? 0.31 : 0.34) - learningFfmpegBias * 0.08,
            0.24,
            0.46,
            0.34,
        );
        const shouldRun = (
            beforeRegions.length > 0
            || beforePeak.clipRatio > 0
            || beforePeak.nearClipRatio >= Math.max(0.0014, 0.003 - learningFfmpegBias * 0.002)
            || beforeHarsh.highBandRatio >= harshRatioTrigger
            || beforeHarsh.highBandPeak >= harshPeakTrigger
        );
        if (!shouldRun) {
            return {};
        }

        const ffmpeg = await this.resolveFfmpegCommand();
        if (!ffmpeg) {
            const severeCase = beforeRegions.length >= (extremeHighPitch ? 8 : 12)
                || beforeHarsh.highBandPeak >= (extremeHighPitch ? 0.30 : 0.38);
            return severeCase ? { warning: 'FFmpeg restoration skipped (ffmpeg not found)' } : {};
        }

        const cacheDir = path.join(this.installPath, CACHE_DIR);
        fs.mkdirSync(cacheDir, { recursive: true });
        const tmpId = `ffrestore_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        const inputPath = path.join(cacheDir, `${tmpId}_in.wav`);
        const outputBasePath = path.join(cacheDir, `${tmpId}_out`);

        try {
            fs.writeFileSync(inputPath, buffer);

            const declipThreshold = beforePeak.clipRatio > 0 ? 6 : 10;
            const adeclickThreshold = extremeHighPitch ? (beforeRegions.length >= 3 ? 1 : 2) : (beforeRegions.length >= 4 ? 2 : 3);
            const deesserIntensity = this.clampFloat(
                0.12
                + Math.max(0, beforeHarsh.highBandRatio - (extremeHighPitch ? 0.20 : 0.34)) * (extremeHighPitch ? 0.78 : 0.55)
                + (highPitchHintHz >= 620 ? 0.06 : 0)
                + (extremeHighPitch ? 0.04 : 0),
                0.08,
                extremeHighPitch ? 0.42 : 0.35,
                0.18,
            ) + this.clampFloat(learningFfmpegBias * 0.08, -0.03, 0.08, 0);
            const deesserFreq = this.clampFloat(highPitchHintHz >= 650 ? 0.62 : 0.54, 0, 1, 0.54);
            const deesserMode = this.clampFloat(highPitchHintHz >= 620 ? 0.45 : 0.35, 0, 1, 0.35);
            const limiterLimit = 0.965;
            const filterCandidates: Array<{ label: string; chain: string }> = [];
            filterCandidates.push({
                label: 'std',
                chain: [
                    `adeclip=t=${declipThreshold}:w=55:o=75:a=8:m=s`,
                    `adeclick=t=${adeclickThreshold}:w=55:o=75:a=2:m=a`,
                    `deesser=i=${deesserIntensity.toFixed(3)}:m=${deesserMode.toFixed(3)}:f=${deesserFreq.toFixed(3)}:s=o`,
                    `alimiter=limit=${limiterLimit}:attack=3:release=30:level=0:asc=1:latency=1`,
                ].join(','),
            });

            const allowAggressiveCandidate = (
                durationMs < POST_GUARD_BALANCED_DURATION_MS
                || ultraHighPitch
                || beforeRegions.length >= 18
                || beforeHarsh.highBandPeak >= 0.38
                || beforePeak.clipRatio > 0
            );
            if (allowAggressiveCandidate && (extremeHighPitch || beforeRegions.length >= 12 || beforeHarsh.highBandPeak >= 0.34)) {
                const strongDeesser = this.clampFloat(deesserIntensity + (ultraHighPitch ? 0.06 : 0.04), 0.10, ultraHighPitch ? 0.52 : 0.46, deesserIntensity);
                const secondDeesser = this.clampFloat(strongDeesser * (ultraHighPitch ? 0.62 : 0.52), 0.06, 0.34, 0.12);
                const secondFreq = this.clampFloat(deesserFreq + (ultraHighPitch ? 0.12 : 0.08), 0, 1, deesserFreq);
                const secondMode = this.clampFloat(deesserMode + 0.08, 0, 1, deesserMode);
                const strongAdeclick = Math.max(1, adeclickThreshold - 1);
                const optionalLowpass = ultraHighPitch && beforeHarsh.highBandPeak >= 0.38
                    ? [`lowpass=f=14500:p=2`]
                    : [];
                filterCandidates.push({
                    label: ultraHighPitch ? 'aggr_hp2' : 'aggr_hp',
                    chain: [
                        `adeclip=t=${Math.max(5, declipThreshold - 1)}:w=65:o=85:a=8:m=s`,
                        `adeclick=t=${strongAdeclick}:w=70:o=85:a=3:m=a`,
                        `deesser=i=${strongDeesser.toFixed(3)}:m=${deesserMode.toFixed(3)}:f=${deesserFreq.toFixed(3)}:s=o`,
                        `deesser=i=${secondDeesser.toFixed(3)}:m=${secondMode.toFixed(3)}:f=${secondFreq.toFixed(3)}:s=o`,
                        ...optionalLowpass,
                        `alimiter=limit=${limiterLimit}:attack=3:release=35:level=0:asc=1:latency=1`,
                    ].join(','),
                });
            }

            const beforeScore = this.computeArtifactIssueScore(beforePeak, beforeHarsh, beforeRegions.length, highPitchHintHz);
            let bestCandidate: {
                label: string;
                buffer: Buffer;
                peak: ReturnType<RvcService['measureWavPeakStats']>;
                harsh: ReturnType<RvcService['measureHighBandHarshnessStats']>;
                regions: number;
                rmsLossDb: number;
                score: number;
            } | null = null;

            for (let i = 0; i < filterCandidates.length; i += 1) {
                const candidate = filterCandidates[i];
                const outputPath = `${outputBasePath}_${candidate.label}_${i}.wav`;

                const result = await this.runProcess(ffmpeg, [
                    '-hide_banner',
                    '-loglevel', 'error',
                    '-y',
                    '-i', inputPath,
                    '-af', candidate.chain,
                    '-c:a', 'pcm_s16le',
                    outputPath,
                ], 60_000);

                if (result.code !== 0 || !fs.existsSync(outputPath)) {
                    if (this.verboseLogs) {
                        console.log('[RvcService] FFmpeg restoration candidate failed:', candidate.label, result.stderr || result.stdout || `code=${result.code}`);
                    }
                    continue;
                }

                try {
                    const restoredBuffer = fs.readFileSync(outputPath);
                    const restoredParsed = this.parsePcm16WavBuffer(restoredBuffer);
                    const afterPeak = this.measureWavPeakStats(restoredParsed);
                    const afterHarsh = this.measureHighBandHarshnessStats(restoredParsed);
                    const afterRegions = this.scanLocalArtifactRegions(restoredParsed, highPitchHintHz, learningFfmpegBias * 0.6);
                    const rmsLossDb = 20 * Math.log10((afterHarsh.fullRms + 1e-9) / (beforeHarsh.fullRms + 1e-9));
                    const score = this.computeArtifactIssueScore(afterPeak, afterHarsh, afterRegions.length, highPitchHintHz);

                    if (!bestCandidate || score < bestCandidate.score) {
                        bestCandidate = {
                            label: candidate.label,
                            buffer: restoredBuffer,
                            peak: afterPeak,
                            harsh: afterHarsh,
                            regions: afterRegions.length,
                            rmsLossDb,
                            score,
                        };
                    }
                } catch {
                    // Ignore malformed candidate output.
                } finally {
                    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
                }
            }

            if (!bestCandidate) {
                const severeResidualNoCandidate = beforeRegions.length >= (extremeHighPitch ? 18 : 24);
                return severeResidualNoCandidate
                    ? { warning: `FFmpeg restoration not adopted (no valid candidate; regions=${beforeRegions.length})` }
                    : {};
            }

            const scoreGain = beforeScore - bestCandidate.score;
            const scoreGainRatio = scoreGain / Math.max(0.5, beforeScore);
            const severeResidual = beforeRegions.length >= (extremeHighPitch ? 16 : 12)
                || beforeHarsh.highBandPeak >= (extremeHighPitch ? 0.30 : 0.36);
            const improved = (
                bestCandidate.regions < beforeRegions.length
                || bestCandidate.peak.clipRatio < beforePeak.clipRatio
                || bestCandidate.peak.nearClipRatio <= beforePeak.nearClipRatio * 0.85
                || bestCandidate.harsh.highBandPeak <= beforeHarsh.highBandPeak - (extremeHighPitch ? 0.012 : 0.03)
                || (extremeHighPitch && bestCandidate.harsh.highBandRatio <= beforeHarsh.highBandRatio - 0.008)
                || scoreGainRatio >= (severeResidual ? 0.015 : 0.025)
                || (severeResidual && scoreGain >= 1.5)
            ) && bestCandidate.rmsLossDb > (extremeHighPitch ? -3.4 : -2.5);

            if (!improved) {
                return severeResidual
                    ? { warning: `FFmpeg restoration not adopted (best ${bestCandidate.label}; regions ${beforeRegions.length}->${bestCandidate.regions}, score ${beforeScore.toFixed(1)}->${bestCandidate.score.toFixed(1)})` }
                    : {};
            }

            return {
                buffer: bestCandidate.buffer,
                warning: `FFmpeg restoration applied (${bestCandidate.label}, regions ${beforeRegions.length}->${bestCandidate.regions}, score ${beforeScore.toFixed(1)}->${bestCandidate.score.toFixed(1)})`,
            };
        } catch (error) {
            if (this.verboseLogs) {
                console.log('[RvcService] FFmpeg restoration error:', error);
            }
            return {};
        } finally {
            try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
        }
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
        learningBias: number = 0,
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
        const highPitchMode = highPitchHintHz >= 900;
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
            let highPeak = 0;
            let diffEnergy = 0;
            let jerkEnergy = 0;
            let prevMono = 0;
            let prevDiff = 0;
            let zc = 0;
            let diffSignFlips = 0;
            let firstMono = true;
            let firstDiff = true;
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
                const absHigh = Math.abs(high);
                if (absHigh > highPeak) highPeak = absHigh;
                highEnergy += high * high;

                if (!firstMono) {
                    const diff = mono - prevMono;
                    diffEnergy += diff * diff;
                    if (!firstDiff) {
                        const jerk = diff - prevDiff;
                        jerkEnergy += jerk * jerk;
                        if ((prevDiff >= 0 && diff < 0) || (prevDiff < 0 && diff >= 0)) {
                            diffSignFlips += 1;
                        }
                    } else {
                        firstDiff = false;
                    }
                    prevDiff = diff;
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
            const diffRms = Math.sqrt(diffEnergy / Math.max(1, frameCount - 1));
            const jerkRms = Math.sqrt(jerkEnergy / Math.max(1, frameCount - 2));
            const highBandRatio = highRms / (fullRms + 1e-9);
            const zcr = zc / Math.max(1, frameCount - 1);
            const diffRatio = diffRms / (fullRms + 1e-9);
            const jerkRatio = jerkRms / (diffRms + 1e-9);
            const diffFlipRatio = diffSignFlips / Math.max(1, frameCount - 2);
            const highCrest = highPeak / (highRms + 1e-9);
            const highPeakToRms = peak / (fullRms + 1e-9);
            const voicedLike = fullRms >= (highPitchMode ? 0.010 : 0.016) || peak >= (highPitchMode ? 0.24 : 0.32);

            const severityClip = (clipRatio * 450) + (nearClipRatio * 28);
            const severityHarsh = (
                Math.max(0, highBandRatio - 0.33) * 2.8
                + Math.max(0, zcr - 0.16) * 4.0
                + Math.max(0, diffRatio - 0.72) * 1.8
                + Math.max(0, peak - 0.86) * 2.0
            );
            const severityBuzz = (
                Math.max(0, diffRatio - (highPitchMode ? 0.55 : 0.68)) * 2.4
                + Math.max(0, zcr - (highPitchMode ? 0.11 : 0.15)) * 3.6
                + Math.max(0, highPeakToRms - (highPitchMode ? 5.4 : 6.2)) * 0.55
                + Math.max(0, highBandRatio - (highPitchMode ? 0.22 : 0.28)) * 2.1
            );
            const severityRough = (
                Math.max(0, jerkRatio - (highPitchMode ? 1.35 : 1.55)) * 1.7
                + Math.max(0, diffFlipRatio - (highPitchMode ? 0.17 : 0.23)) * 2.2
                + Math.max(0, highCrest - (highPitchMode ? 3.5 : 4.2)) * 0.22
                + Math.max(0, highBandRatio - (highPitchMode ? 0.16 : 0.24)) * 1.3
            );
            const pitchBias = highPitchHintHz > 0 ? Math.max(0, (highPitchHintHz - 460) / 350) * 0.45 : 0;
            const severity = this.clampFloat(
                Math.max(severityClip, severityHarsh, severityBuzz, severityRough) + pitchBias + this.clampFloat(learningBias, -0.35, 0.8, 0) * 0.5,
                0,
                4,
                0,
            );

            const flagged = (
                clipRatio > 0
                || (nearClipRatio >= Math.max(0.002, (highPitchMode ? 0.004 : 0.006) - learningBias * 0.003) && (highBandRatio >= (highPitchMode ? 0.24 : 0.34) || zcr >= (highPitchMode ? 0.14 : 0.18)))
                || (highBandRatio >= Math.max(highPitchMode ? 0.24 : 0.44, (highPitchMode ? 0.36 : 0.58) - learningBias * 0.10) && zcr >= (highPitchMode ? 0.12 : 0.19) && peak >= (highPitchMode ? 0.64 : 0.78))
                || (highPitchMode && diffRatio >= 0.62 && zcr >= 0.12 && highBandRatio >= 0.20 && peak >= 0.58)
                || (highPitchMode && diffRatio >= 0.74 && highPeakToRms >= 5.2)
                || (highPitchMode && voicedLike && highBandRatio >= 0.15 && peak >= 0.36 && jerkRatio >= 1.45 && (diffFlipRatio >= 0.16 || highCrest >= 3.3))
                || (highPitchHintHz >= 1000 && voicedLike && highBandRatio >= 0.13 && peak >= 0.32 && jerkRatio >= 1.35 && highPeakToRms >= 4.4)
            );

            const severityThreshold = highPitchHintHz >= 1000 ? 0.12 : (highPitchMode ? 0.17 : 0.35);
            if (!flagged || severity < severityThreshold) {
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
        learningBias: number = 0,
    ): boolean {
        const startFrame = Math.max(0, Math.min(parsed.totalFrames, region.startFrame));
        const endFrame = Math.max(startFrame, Math.min(parsed.totalFrames, region.endFrame));
        if (endFrame - startFrame < 4 || parsed.channels <= 0) {
            return false;
        }

        const severityBase = this.clampFloat(
            region.severity + (highPitchHintHz >= 620 ? 0.18 : 0) + this.clampFloat(learningBias, -0.2, 0.8, 0) * 0.55,
            0.15,
            2.8,
            0.6,
        );
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
        // Opt-in only. We apply safe parameter tuning + post-generation repair.
        if (params.autoHighPitchQualityProtect !== true) {
            return false;
        }
        const hasInputBase64 = typeof params.inputBase64 === 'string' && params.inputBase64.trim().length > 0;
        if (hasInputBase64) {
            return true;
        }
        const inputPath = String(params.inputPath || '').trim();
        if (!inputPath) return false;
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

    private roundNumber(value: number, digits: number): number {
        if (!Number.isFinite(value)) return 0;
        const d = this.clampInt(digits, 0, 8, 3);
        const s = 10 ** d;
        return Math.round(value * s) / s;
    }

    private async resolveFfmpegCommand(): Promise<string | null> {
        if (this.ffmpegResolutionTried) {
            return this.ffmpegCommandPath;
        }
        this.ffmpegResolutionTried = true;

        const candidates: string[] = [];
        const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        candidates.push(exeName);

        const localCandidates = [
            path.join(this.installPath, 'ffmpeg', 'bin', exeName),
            path.join(this.installPath, 'bin', exeName),
            path.join(process.env.LOCALAPPDATA || '', 'AntiGravity', 'tts', 'ffmpeg', 'bin', exeName),
            path.join(process.env.LOCALAPPDATA || '', 'AntiGravity', 'tts', 'singing_learning', 'runtime', 'ffmpeg', 'bin', exeName),
            path.join(process.env.LOCALAPPDATA || '', 'AntiGravity', 'tts', 'singing_learning', 'runtime', 'ffmpeg', 'extract', 'ffmpeg-master-latest-win64-lgpl', 'bin', exeName),
            path.join(process.env.LOCALAPPDATA || '', 'AntiGravity', 'tts', 'singing_learning', 'runtime', 'ffmpeg', 'extract', 'ffmpeg-master-latest-win64-lgpl-shared', 'bin', exeName),
        ];
        for (const candidate of localCandidates) {
            if (candidate && !candidates.includes(candidate)) {
                candidates.push(candidate);
            }
        }

        for (const command of candidates) {
            try {
                const probe = await this.runProcess(command, ['-version'], 4000);
                if (probe.code === 0) {
                    this.ffmpegCommandPath = command;
                    return command;
                }
            } catch {
                // Try next candidate.
            }
        }

        this.ffmpegCommandPath = null;
        return null;
    }

    private runProcess(
        command: string,
        args: string[],
        timeoutMs: number,
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let settled = false;

            const child = spawn(command, args, {
                windowsHide: true,
                shell: false,
            });

            const finish = (payload: { code: number; stdout: string; stderr: string }) => {
                if (settled) return;
                settled = true;
                resolve(payload);
            };

            const timer = setTimeout(() => {
                try {
                    child.kill();
                } catch {
                    // ignore
                }
                finish({ code: -1, stdout, stderr: `${stderr}\nProcess timeout after ${timeoutMs}ms`.trim() });
            }, Math.max(1000, timeoutMs));

            child.stdout.on('data', (chunk) => {
                stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
            });
            child.stderr.on('data', (chunk) => {
                stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
            });

            child.on('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });

            child.on('close', (code) => {
                clearTimeout(timer);
                finish({ code: typeof code === 'number' ? code : -1, stdout, stderr });
            });
        });
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
        this.persistQualityLearningProfiles(true);
        await this.runtime.stop();
    }
}
