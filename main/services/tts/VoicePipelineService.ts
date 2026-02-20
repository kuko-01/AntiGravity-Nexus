import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Sbv2Service } from './Sbv2Service';
import { RvcService } from './RvcService';
import {
    VoiceAudioEnhancementReport,
    VoiceAudioQualityMetrics,
    VoiceEmotionLabelHint,
    VoiceExpressionSettings,
    VoiceOutputSettings,
    VoiceSynthesizeParams,
    VoiceSynthesizeResult,
} from '../../../types/rvc';

const INT16_MAX = 32767;
const INT16_MIN = -32768;
const TWO_PI = Math.PI * 2;
const SINGING_VIBRATO_MIN_HZ = 4.2;
const SINGING_VIBRATO_MAX_HZ = 7.2;
const ANALYSIS_SILENCE_THRESHOLD = 0.0035;
const ANALYSIS_NEAR_CLIP_THRESHOLD = 0.965;
const ANALYSIS_CLIP_THRESHOLD = 0.995;
const DB_FLOOR = -120;
const QUALITY_PROFILE_FILE = 'voice_quality_profiles.json';
const QUALITY_PROFILE_VERSION = 1;
const QUALITY_PROFILE_MAX_ENTRIES = 180;

interface PersistentQualityProfile {
    id: string;
    updatedAt: string;
    sampleCount: number;
    gainBias: number;
    limiterDriveBias: number;
    targetPeakBias: number;
    qualityScoreEma: number;
    rmsDbEma: number;
    clippingRatioEma: number;
    nearClipRatioEma: number;
    dcOffsetEma: number;
}

interface PersistedQualityProfileStore {
    version: number;
    entries: Record<string, PersistentQualityProfile>;
}

interface ParsedPcm16Wav {
    source: Buffer;
    sampleRate: number;
    channels: number;
    dataOffset: number;
    dataLength: number;
    samples: Int16Array;
    durationMs: number;
}

interface ResolvedExpressionSettings {
    singing: boolean;
    autoEmotionRefine: boolean;
    emotionLabelHint: VoiceEmotionLabelHint;
    emotionIntensityHint: number;
    waveEdit: {
        vibratoDepth: number;
        vibratoRateHz: number;
        dynamicBoost: number;
    };
}

interface AudioProcessResult {
    audioBase64: string;
    sampleRate?: number;
    durationMs?: number;
    applied: boolean;
    fallbackUsed: boolean;
    analysis?: VoiceAudioEnhancementReport;
}

interface InternalAudioMetrics {
    peak: number;
    rms: number;
    mean: number;
    clippingRatio: number;
    nearClipRatio: number;
    silenceRatio: number;
    zeroCrossRate: number;
    crestFactorDb: number;
    qualityScore: number;
    metrics: VoiceAudioQualityMetrics;
}

/**
 * VoicePipelineService
 * Orchestrates SBV2-only, RVC-only, and SBV2+RVC synthesis paths.
 */
export class VoicePipelineService {
    private static instance: VoicePipelineService | null = null;

    private sbv2: Sbv2Service;
    private rvc: RvcService;
    private readonly qualityStorePath: string;
    private readonly qualityProfiles = new Map<string, PersistentQualityProfile>();
    private qualityProfilesDirty = false;

    private constructor(resourcesPath: string) {
        this.sbv2 = Sbv2Service.getInstance(resourcesPath);
        this.rvc = RvcService.getInstance(resourcesPath);
        this.qualityStorePath = path.join(app.getPath('userData'), QUALITY_PROFILE_FILE);
        this.loadQualityProfiles();
    }

    static getInstance(resourcesPath?: string): VoicePipelineService {
        if (!VoicePipelineService.instance) {
            const resPath = resourcesPath || (
                app.isPackaged
                    ? process.resourcesPath
                    : path.join(__dirname, '../../../resources')
            );
            VoicePipelineService.instance = new VoicePipelineService(resPath);
        }
        return VoicePipelineService.instance;
    }

    private normalizeProfileIdSegment(value: unknown, fallback: string): string {
        const source = String(value || '').trim().toLowerCase();
        const normalized = source
            .replace(/\s+/g, '_')
            .replace(/[^\p{L}\p{N}_-]+/gu, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 80);
        return normalized || fallback;
    }

    private resolveQualityProfileId(params: VoiceSynthesizeParams): string | undefined {
        if (params.output?.persistQualityLearning === false) {
            return undefined;
        }
        const explicit = String(params.output?.qualityProfileId || '').trim();
        if (explicit) {
            return this.normalizeProfileIdSegment(explicit, 'voice_profile');
        }

        const mode = this.normalizeProfileIdSegment(params.mode, 'sbv2_rvc');
        const sbv2Model = this.normalizeProfileIdSegment(params.sbv2?.modelId, 'sbv2_auto');
        const rvcModel = this.normalizeProfileIdSegment(params.rvc?.modelId, 'rvc_auto');
        return `auto_${mode}_${sbv2Model}_${rvcModel}`;
    }

    private getDefaultQualityProfile(profileId: string): PersistentQualityProfile {
        return {
            id: profileId,
            updatedAt: new Date().toISOString(),
            sampleCount: 0,
            gainBias: 1,
            limiterDriveBias: 1,
            targetPeakBias: 1,
            qualityScoreEma: 75,
            rmsDbEma: -19,
            clippingRatioEma: 0,
            nearClipRatioEma: 0,
            dcOffsetEma: 0,
        };
    }

    private sanitizePersistentProfile(raw: Partial<PersistentQualityProfile>, fallbackId: string): PersistentQualityProfile {
        const base = this.getDefaultQualityProfile(fallbackId);
        return {
            id: this.normalizeProfileIdSegment(raw.id || fallbackId, fallbackId),
            updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : base.updatedAt,
            sampleCount: Math.max(0, Math.floor(this.clampNumber(raw.sampleCount, 0, 1_000_000, 0))),
            gainBias: this.clampNumber(raw.gainBias, 0.72, 1.22, base.gainBias),
            limiterDriveBias: this.clampNumber(raw.limiterDriveBias, 0.9, 1.55, base.limiterDriveBias),
            targetPeakBias: this.clampNumber(raw.targetPeakBias, 0.9, 1.08, base.targetPeakBias),
            qualityScoreEma: this.clampNumber(raw.qualityScoreEma, 0, 100, base.qualityScoreEma),
            rmsDbEma: this.clampNumber(raw.rmsDbEma, -80, 0, base.rmsDbEma),
            clippingRatioEma: this.clampNumber(raw.clippingRatioEma, 0, 1, base.clippingRatioEma),
            nearClipRatioEma: this.clampNumber(raw.nearClipRatioEma, 0, 1, base.nearClipRatioEma),
            dcOffsetEma: this.clampNumber(raw.dcOffsetEma, 0, 1, base.dcOffsetEma),
        };
    }

    private loadQualityProfiles(): void {
        try {
            if (!fs.existsSync(this.qualityStorePath)) {
                return;
            }
            const raw = fs.readFileSync(this.qualityStorePath, 'utf-8');
            const parsed = JSON.parse(raw) as PersistedQualityProfileStore;
            const entries = parsed?.entries;
            if (!entries || typeof entries !== 'object') {
                return;
            }

            for (const [key, value] of Object.entries(entries)) {
                if (!value || typeof value !== 'object') continue;
                const normalizedId = this.normalizeProfileIdSegment(key, 'voice_profile');
                const profile = this.sanitizePersistentProfile(value, normalizedId);
                this.qualityProfiles.set(normalizedId, profile);
            }
        } catch (error) {
            console.warn('[VoicePipeline] Failed to load quality profiles:', error);
        }
    }

    private persistQualityProfiles(force: boolean = false): void {
        if (!force && !this.qualityProfilesDirty) {
            return;
        }
        try {
            const allEntries = Array.from(this.qualityProfiles.values()).sort(
                (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
            );
            const trimmed = allEntries.slice(0, QUALITY_PROFILE_MAX_ENTRIES);
            const entries: Record<string, PersistentQualityProfile> = {};
            this.qualityProfiles.clear();
            for (const entry of trimmed) {
                const sanitized = this.sanitizePersistentProfile(entry, entry.id);
                entries[sanitized.id] = sanitized;
                this.qualityProfiles.set(sanitized.id, sanitized);
            }

            const payload: PersistedQualityProfileStore = {
                version: QUALITY_PROFILE_VERSION,
                entries,
            };
            fs.mkdirSync(path.dirname(this.qualityStorePath), { recursive: true });
            fs.writeFileSync(this.qualityStorePath, JSON.stringify(payload, null, 2), 'utf-8');
            this.qualityProfilesDirty = false;
        } catch (error) {
            console.warn('[VoicePipeline] Failed to save quality profiles:', error);
        }
    }

    private getOrCreateQualityProfile(profileId: string): PersistentQualityProfile {
        const normalizedId = this.normalizeProfileIdSegment(profileId, 'voice_profile');
        const existing = this.qualityProfiles.get(normalizedId);
        if (existing) {
            return existing;
        }
        const created = this.getDefaultQualityProfile(normalizedId);
        this.qualityProfiles.set(normalizedId, created);
        this.qualityProfilesDirty = true;
        return created;
    }

    private updateQualityProfileFromReport(
        profileId: string,
        report: VoiceAudioEnhancementReport | undefined,
    ): void {
        if (!report?.after) {
            return;
        }

        const profile = this.getOrCreateQualityProfile(profileId);
        const alpha = 0.12;
        const ema = (prev: number, next: number) => prev * (1 - alpha) + next * alpha;
        const after = report.after;

        profile.qualityScoreEma = this.clampNumber(ema(profile.qualityScoreEma, after.qualityScore), 0, 100, profile.qualityScoreEma);
        profile.rmsDbEma = this.clampNumber(ema(profile.rmsDbEma, after.rmsDb), -80, 0, profile.rmsDbEma);
        profile.clippingRatioEma = this.clampNumber(ema(profile.clippingRatioEma, after.clippingRatio), 0, 1, profile.clippingRatioEma);
        profile.nearClipRatioEma = this.clampNumber(ema(profile.nearClipRatioEma, after.nearClipRatio), 0, 1, profile.nearClipRatioEma);
        profile.dcOffsetEma = this.clampNumber(ema(profile.dcOffsetEma, after.dcOffset), 0, 1, profile.dcOffsetEma);

        if (after.clippingRatio > 0.0002 || after.nearClipRatio > 0.02) {
            profile.gainBias -= 0.025;
            profile.limiterDriveBias += 0.03;
            profile.targetPeakBias -= 0.01;
        } else if (after.rmsDb < -24 && after.clippingRatio < 0.00005) {
            profile.gainBias += 0.02;
            profile.targetPeakBias += 0.005;
        } else if (after.rmsDb > -10.5) {
            profile.gainBias -= 0.018;
            profile.targetPeakBias -= 0.005;
        }

        if (after.dcOffset > 0.0018) {
            profile.targetPeakBias -= 0.004;
        }

        profile.gainBias = this.clampNumber(profile.gainBias, 0.72, 1.22, 1);
        profile.limiterDriveBias = this.clampNumber(profile.limiterDriveBias, 0.9, 1.55, 1);
        profile.targetPeakBias = this.clampNumber(profile.targetPeakBias, 0.9, 1.08, 1);
        profile.sampleCount += 1;
        profile.updatedAt = new Date().toISOString();
        this.qualityProfilesDirty = true;
        this.persistQualityProfiles();
    }

    private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
        const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
        return Math.max(min, Math.min(max, numeric));
    }

    private resolveEmotionLabel(value: unknown): VoiceEmotionLabelHint {
        if (value === 'joy' || value === 'sad' || value === 'angry' || value === 'excited' || value === 'neutral') {
            return value;
        }
        return 'neutral';
    }

    private resolveExpression(expression?: VoiceExpressionSettings): ResolvedExpressionSettings {
        const singing = expression?.singing === true;
        const autoEmotionRefine = expression?.autoEmotionRefine !== false;
        const emotionLabelHint = this.resolveEmotionLabel(expression?.emotionLabelHint);
        const emotionIntensityHint = this.clampNumber(expression?.emotionIntensityHint, 0, 1, 0);

        let vibratoDepth = 0;
        let vibratoRateHz = 5.2;
        let dynamicBoost = 0;

        if (singing) {
            vibratoDepth = 0.26 + emotionIntensityHint * 0.24;
            vibratoRateHz = 5.4 + emotionIntensityHint * 0.8;
            dynamicBoost = 0.22 + emotionIntensityHint * 0.28;
        } else if (autoEmotionRefine) {
            switch (emotionLabelHint) {
                case 'joy':
                    vibratoDepth = 0.04 + emotionIntensityHint * 0.08;
                    dynamicBoost = 0.08 + emotionIntensityHint * 0.2;
                    break;
                case 'sad':
                    vibratoDepth = 0.02 + emotionIntensityHint * 0.05;
                    vibratoRateHz = 4.4;
                    dynamicBoost = 0.03 + emotionIntensityHint * 0.08;
                    break;
                case 'angry':
                    vibratoDepth = 0.01 + emotionIntensityHint * 0.04;
                    dynamicBoost = 0.1 + emotionIntensityHint * 0.18;
                    break;
                case 'excited':
                    vibratoDepth = 0.06 + emotionIntensityHint * 0.12;
                    vibratoRateHz = 5.6 + emotionIntensityHint * 0.8;
                    dynamicBoost = 0.1 + emotionIntensityHint * 0.24;
                    break;
                default:
                    vibratoDepth = 0.01 + emotionIntensityHint * 0.03;
                    dynamicBoost = 0.02 + emotionIntensityHint * 0.08;
                    break;
            }
        }

        const userWaveEdit = expression?.sbv2WaveEdit;
        if (userWaveEdit) {
            vibratoDepth = this.clampNumber(userWaveEdit.vibratoDepth, 0, 1, vibratoDepth);
            vibratoRateHz = this.clampNumber(
                userWaveEdit.vibratoRateHz,
                singing ? SINGING_VIBRATO_MIN_HZ : 0.1,
                singing ? SINGING_VIBRATO_MAX_HZ : 12,
                vibratoRateHz,
            );
            dynamicBoost = this.clampNumber(userWaveEdit.dynamicBoost, 0, 2, dynamicBoost);
        } else {
            vibratoDepth = this.clampNumber(vibratoDepth, 0, 1, 0);
            vibratoRateHz = this.clampNumber(
                vibratoRateHz,
                singing ? SINGING_VIBRATO_MIN_HZ : 0.1,
                singing ? SINGING_VIBRATO_MAX_HZ : 12,
                5.2,
            );
            dynamicBoost = this.clampNumber(dynamicBoost, 0, 2, 0);
        }

        return {
            singing,
            autoEmotionRefine,
            emotionLabelHint,
            emotionIntensityHint,
            waveEdit: {
                vibratoDepth,
                vibratoRateHz,
                dynamicBoost,
            },
        };
    }

    private shouldApplySbv2WaveEdit(expression: ResolvedExpressionSettings): boolean {
        return expression.waveEdit.vibratoDepth > 0.0001 || expression.waveEdit.dynamicBoost > 0.0001;
    }

    private shouldAutoAnalyze(output?: VoiceOutputSettings): boolean {
        return output?.autoAnalyzeAndEnhance === true;
    }

    private shouldApplyFinalEnhance(output?: VoiceOutputSettings): boolean {
        return Boolean(output?.enhanceFinalAudio || output?.normalize || this.shouldAutoAnalyze(output));
    }

    private clampInt16(value: number): number {
        const rounded = Math.round(value);
        if (rounded < INT16_MIN) return INT16_MIN;
        if (rounded > INT16_MAX) return INT16_MAX;
        return rounded;
    }

    private softClip(value: number): number {
        const normalized = value / INT16_MAX;
        const shaped = Math.tanh(normalized * 1.08) / Math.tanh(1.08);
        return shaped * INT16_MAX;
    }

    private roundNumber(value: number, digits: number = 4): number {
        const scale = 10 ** Math.max(0, Math.floor(digits));
        return Math.round(value * scale) / scale;
    }

    private toDb(amplitude: number): number {
        const safe = Math.max(1e-8, Math.abs(amplitude));
        return Math.max(DB_FLOOR, 20 * Math.log10(safe));
    }

    private clampScore(value: number): number {
        return Math.max(0, Math.min(100, value));
    }

    private estimateQualityScore(metrics: {
        rmsDb: number;
        crestFactorDb: number;
        clippingRatio: number;
        nearClipRatio: number;
        silenceRatio: number;
        dcOffset: number;
    }): number {
        let score = 100;

        score -= Math.min(65, metrics.clippingRatio * 12000);
        score -= Math.min(24, metrics.nearClipRatio * 420);

        if (metrics.dcOffset > 0.0015) {
            score -= Math.min(16, (metrics.dcOffset - 0.0015) * 2600);
        }

        if (metrics.rmsDb < -31) {
            score -= Math.min(18, (-31 - metrics.rmsDb) * 0.9);
        } else if (metrics.rmsDb > -7) {
            score -= Math.min(20, (metrics.rmsDb + 7) * 2.1);
        }

        if (metrics.silenceRatio > 0.93) {
            score -= Math.min(8, (metrics.silenceRatio - 0.93) * 120);
        }

        if (metrics.crestFactorDb < 4) {
            score -= Math.min(10, (4 - metrics.crestFactorDb) * 2.2);
        } else if (metrics.crestFactorDb > 24) {
            score -= Math.min(7, (metrics.crestFactorDb - 24) * 0.8);
        }

        return this.clampScore(score);
    }

    private analyzeParsedAudio(parsed: ParsedPcm16Wav): InternalAudioMetrics {
        const sampleCount = parsed.samples.length;
        if (sampleCount <= 0) {
            const emptyMetrics: VoiceAudioQualityMetrics = {
                sampleRate: parsed.sampleRate,
                channels: parsed.channels,
                durationMs: parsed.durationMs,
                peakDb: DB_FLOOR,
                rmsDb: DB_FLOOR,
                crestFactorDb: 0,
                clippingRatio: 0,
                nearClipRatio: 0,
                silenceRatio: 1,
                dcOffset: 0,
                zeroCrossRate: 0,
                qualityScore: 0,
            };
            return {
                peak: 0,
                rms: 0,
                mean: 0,
                clippingRatio: 0,
                nearClipRatio: 0,
                silenceRatio: 1,
                zeroCrossRate: 0,
                crestFactorDb: 0,
                qualityScore: 0,
                metrics: emptyMetrics,
            };
        }

        let peak = 0;
        let sum = 0;
        let sumSq = 0;
        let clippingCount = 0;
        let nearClipCount = 0;
        let silenceCount = 0;
        let zeroCrossings = 0;

        let prev = parsed.samples[0] / INT16_MAX;
        for (let i = 0; i < sampleCount; i += 1) {
            const value = parsed.samples[i] / INT16_MAX;
            const absValue = Math.abs(value);
            if (absValue > peak) peak = absValue;
            sum += value;
            sumSq += value * value;

            if (absValue >= ANALYSIS_CLIP_THRESHOLD) {
                clippingCount += 1;
            } else if (absValue >= ANALYSIS_NEAR_CLIP_THRESHOLD) {
                nearClipCount += 1;
            }

            if (absValue <= ANALYSIS_SILENCE_THRESHOLD) {
                silenceCount += 1;
            }

            if (i > 0 && ((value >= 0 && prev < 0) || (value < 0 && prev >= 0))) {
                zeroCrossings += 1;
            }
            prev = value;
        }

        const mean = sum / sampleCount;
        const rms = Math.sqrt(sumSq / sampleCount);
        const clippingRatio = clippingCount / sampleCount;
        const nearClipRatio = nearClipCount / sampleCount;
        const silenceRatio = silenceCount / sampleCount;
        const zeroCrossRate = sampleCount > 1 ? zeroCrossings / (sampleCount - 1) : 0;
        const crestFactorDb = this.toDb((peak + 1e-8) / (rms + 1e-8));
        const rmsDb = this.toDb(rms);
        const peakDb = this.toDb(peak);
        const dcOffset = Math.abs(mean);
        const qualityScore = this.estimateQualityScore({
            rmsDb,
            crestFactorDb,
            clippingRatio,
            nearClipRatio,
            silenceRatio,
            dcOffset,
        });

        const metrics: VoiceAudioQualityMetrics = {
            sampleRate: parsed.sampleRate,
            channels: parsed.channels,
            durationMs: parsed.durationMs,
            peakDb: this.roundNumber(peakDb, 2),
            rmsDb: this.roundNumber(rmsDb, 2),
            crestFactorDb: this.roundNumber(crestFactorDb, 2),
            clippingRatio: this.roundNumber(clippingRatio, 6),
            nearClipRatio: this.roundNumber(nearClipRatio, 6),
            silenceRatio: this.roundNumber(silenceRatio, 6),
            dcOffset: this.roundNumber(dcOffset, 6),
            zeroCrossRate: this.roundNumber(zeroCrossRate, 6),
            qualityScore: this.roundNumber(qualityScore, 2),
        };

        return {
            peak,
            rms,
            mean,
            clippingRatio,
            nearClipRatio,
            silenceRatio,
            zeroCrossRate,
            crestFactorDb,
            qualityScore,
            metrics,
        };
    }

    private parsePcm16WavFromBase64(audioBase64: string): ParsedPcm16Wav {
        const source = Buffer.from(audioBase64, 'base64');
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
            durationMs,
        };
    }

    private encodePcm16WavToBase64(parsed: ParsedPcm16Wav): string {
        const output = Buffer.from(parsed.source);
        const maxSamples = Math.min(parsed.samples.length, Math.floor(parsed.dataLength / 2));
        let pointer = parsed.dataOffset;
        for (let i = 0; i < maxSamples; i += 1) {
            output.writeInt16LE(parsed.samples[i], pointer);
            pointer += 2;
        }
        return output.toString('base64');
    }

    private applySbv2WaveEdit(parsed: ParsedPcm16Wav, expression: ResolvedExpressionSettings): boolean {
        if (!this.shouldApplySbv2WaveEdit(expression)) {
            return false;
        }

        const channels = Math.max(1, parsed.channels);
        const totalFrames = Math.floor(parsed.samples.length / channels);
        if (totalFrames < 4) {
            return false;
        }

        const depth = this.clampNumber(expression.waveEdit.vibratoDepth, 0, 1, 0);
        const rate = this.clampNumber(
            expression.waveEdit.vibratoRateHz,
            expression.singing ? SINGING_VIBRATO_MIN_HZ : 0.1,
            expression.singing ? SINGING_VIBRATO_MAX_HZ : 12,
            5.2,
        );
        const dynamicBoost = this.clampNumber(expression.waveEdit.dynamicBoost, 0, 2, 0);
        const dynamicGainBase = 1 + dynamicBoost * (expression.singing ? 0.28 : 0.18);

        const source = new Float32Array(parsed.samples.length);
        for (let i = 0; i < parsed.samples.length; i += 1) {
            source[i] = parsed.samples[i];
        }

        const baseDelayMs = expression.singing ? 3.0 : 1.6;
        const depthDelayMs = expression.singing
            ? (0.35 + depth * 1.35)
            : (0.18 + depth * 0.7);
        const baseDelaySamples = (parsed.sampleRate * baseDelayMs) / 1000;
        const depthDelaySamples = (parsed.sampleRate * depthDelayMs) / 1000;
        const fadeFrames = Math.max(1, Math.min(totalFrames / 3, Math.floor(parsed.sampleRate * 0.12)));

        for (let frame = 0; frame < totalFrames; frame += 1) {
            const phase = TWO_PI * rate * (frame / parsed.sampleRate);
            const fadeIn = frame < fadeFrames ? frame / fadeFrames : 1;
            const fadeOut = (totalFrames - frame) < fadeFrames ? (totalFrames - frame) / fadeFrames : 1;
            const envelope = Math.max(0, Math.min(1, Math.min(fadeIn, fadeOut)));

            const delaySamples = baseDelaySamples + depthDelaySamples * envelope * Math.sin(phase);
            let readPos = frame - delaySamples;
            if (readPos < 0) readPos = 0;
            if (readPos > totalFrames - 2) readPos = totalFrames - 2;

            const i0 = Math.floor(readPos);
            const i1 = Math.min(totalFrames - 1, i0 + 1);
            const frac = readPos - i0;
            const tremolo = expression.singing
                ? (1 + 0.04 * depth * envelope * Math.sin(phase + Math.PI / 2))
                : 1;
            const gain = dynamicGainBase * tremolo;

            for (let channel = 0; channel < channels; channel += 1) {
                const outIndex = frame * channels + channel;
                const src0Index = i0 * channels + channel;
                const src1Index = i1 * channels + channel;
                const sample0 = source[src0Index] || 0;
                const sample1 = source[src1Index] || sample0;
                const pitched = sample0 + (sample1 - sample0) * frac;
                const processed = this.softClip(pitched * gain);
                parsed.samples[outIndex] = this.clampInt16(processed);
            }
        }

        return true;
    }

    private applyFinalEnhanceWithAnalysis(
        parsed: ParsedPcm16Wav,
        output?: VoiceOutputSettings,
        profile?: PersistentQualityProfile,
    ): { applied: boolean; analysis: VoiceAudioEnhancementReport } {
        if (!this.shouldApplyFinalEnhance(output)) {
            return {
                applied: false,
                analysis: {
                    analyzed: false,
                    autoEnhanced: false,
                    actions: [],
                    profileId: profile?.id,
                    warnings: ['final_enhance_disabled'],
                },
            };
        }

        const normalize = output?.normalize === true;
        const enhanceFinalAudio = output?.enhanceFinalAudio === true;
        const autoAnalyze = this.shouldAutoAnalyze(output);
        const shouldShape = normalize || enhanceFinalAudio || autoAnalyze;
        const before = this.analyzeParsedAudio(parsed);
        const actions: string[] = [];
        const warnings: string[] = [];
        const originalSamples = parsed.samples.slice();

        if (parsed.samples.length < 8 || before.peak <= 0) {
            return {
                applied: false,
                analysis: {
                    analyzed: true,
                    autoEnhanced: false,
                    actions,
                    profileId: profile?.id,
                    warnings: ['insufficient_audio_samples'],
                    before: before.metrics,
                    after: before.metrics,
                },
            };
        }

        let applied = false;
        const profileGainBias = this.clampNumber(profile?.gainBias, 0.72, 1.22, 1);
        const profileLimiterBias = this.clampNumber(profile?.limiterDriveBias, 0.9, 1.55, 1);
        const profileTargetPeakBias = this.clampNumber(profile?.targetPeakBias, 0.9, 1.08, 1);
        if ((autoAnalyze || enhanceFinalAudio) && Math.abs(before.mean) > 0.0015) {
            const dcOffsetInt = before.mean * INT16_MAX;
            for (let i = 0; i < parsed.samples.length; i += 1) {
                parsed.samples[i] = this.clampInt16(parsed.samples[i] - dcOffsetInt);
            }
            actions.push(`dc_offset_removed(${this.roundNumber(before.mean, 5)})`);
            applied = true;
        }

        const working = this.analyzeParsedAudio(parsed);
        const targetPeak = this.clampNumber(
            (normalize ? 0.92 : 0.88) * profileTargetPeakBias,
            0.72,
            0.96,
            normalize ? 0.92 : 0.88,
        );
        const safePeak = Math.max(working.peak, 1e-5);
        const gainByPeak = targetPeak / safePeak;
        let gain = profileGainBias;

        if (working.peak > targetPeak) {
            gain = Math.min(gain, gainByPeak);
        }

        if (autoAnalyze || enhanceFinalAudio) {
            if (working.rms < 0.075) {
                gain = Math.min(Math.max(gain, Math.min(1.35, 0.092 / Math.max(0.005, working.rms))), gainByPeak);
            } else if (working.rms > 0.23) {
                gain = Math.min(gain, Math.max(0.72, 0.17 / Math.max(working.rms, 1e-5)));
            }
        }

        gain = this.clampNumber(gain, 0.65, 1.5, profileGainBias);
        const drive = working.clippingRatio > 0.00001
            ? 1.32
            : working.nearClipRatio > 0.015
                ? 1.2
                : 1.08;
        const effectiveDrive = this.clampNumber(drive * profileLimiterBias, 0.98, 2, drive);

        if (Math.abs(gain - 1) > 0.01 || shouldShape) {
            const driveDenominator = Math.tanh(effectiveDrive);
            for (let i = 0; i < parsed.samples.length; i += 1) {
                let value = (parsed.samples[i] / INT16_MAX) * gain;
                if (shouldShape) {
                    value = Math.tanh(value * effectiveDrive) / driveDenominator;
                }
                parsed.samples[i] = this.clampInt16(value * INT16_MAX);
            }
            if (Math.abs(gain - 1) > 0.01) {
                actions.push(`adaptive_gain(${this.roundNumber(gain, 3)}x)`);
            }
            if (shouldShape) {
                actions.push(`soft_limiter(drive=${this.roundNumber(effectiveDrive, 2)})`);
            }
            if (profile) {
                actions.push(
                    `profile_bias(g=${this.roundNumber(profileGainBias, 3)},lim=${this.roundNumber(profileLimiterBias, 3)})`,
                );
            }
            applied = true;
        }

        const after = this.analyzeParsedAudio(parsed);
        if (applied && after.qualityScore + 0.15 < before.qualityScore) {
            parsed.samples.set(originalSamples);
            warnings.push('quality_score_regressed_reverted');
            return {
                applied: false,
                analysis: {
                    analyzed: true,
                    autoEnhanced: false,
                    actions: [],
                    profileId: profile?.id,
                    warnings,
                    before: before.metrics,
                    after: before.metrics,
                },
            };
        }

        if (after.clippingRatio > before.clippingRatio + 0.0001) {
            warnings.push('clipping_ratio_increased');
        }
        if (after.silenceRatio > 0.98) {
            warnings.push('audio_mostly_silence');
        }

        return {
            applied,
            analysis: {
                analyzed: true,
                autoEnhanced: applied,
                actions,
                profileId: profile?.id,
                warnings: warnings.length > 0 ? warnings : undefined,
                before: before.metrics,
                after: after.metrics,
            },
        };
    }

    private processAudioBase64(
        audioBase64: string,
        processor: (parsed: ParsedPcm16Wav) => boolean,
    ): AudioProcessResult {
        try {
            const parsed = this.parsePcm16WavFromBase64(audioBase64);
            const applied = processor(parsed);
            if (!applied) {
                return {
                    audioBase64,
                    sampleRate: parsed.sampleRate,
                    durationMs: parsed.durationMs,
                    applied: false,
                    fallbackUsed: false,
                };
            }
            return {
                audioBase64: this.encodePcm16WavToBase64(parsed),
                sampleRate: parsed.sampleRate,
                durationMs: parsed.durationMs,
                applied: true,
                fallbackUsed: false,
            };
        } catch {
            return {
                audioBase64,
                applied: false,
                fallbackUsed: true,
            };
        }
    }

    private processAudioBase64WithAnalysis(
        audioBase64: string,
        processor: (parsed: ParsedPcm16Wav) => { applied: boolean; analysis: VoiceAudioEnhancementReport },
    ): AudioProcessResult {
        try {
            const parsed = this.parsePcm16WavFromBase64(audioBase64);
            const result = processor(parsed);
            if (!result.applied) {
                return {
                    audioBase64,
                    sampleRate: parsed.sampleRate,
                    durationMs: parsed.durationMs,
                    applied: false,
                    fallbackUsed: false,
                    analysis: result.analysis,
                };
            }
            return {
                audioBase64: this.encodePcm16WavToBase64(parsed),
                sampleRate: parsed.sampleRate,
                durationMs: parsed.durationMs,
                applied: true,
                fallbackUsed: false,
                analysis: result.analysis,
            };
        } catch {
            return {
                audioBase64,
                applied: false,
                fallbackUsed: true,
                analysis: {
                    analyzed: false,
                    autoEnhanced: false,
                    actions: [],
                    warnings: ['wav_parse_failed'],
                },
            };
        }
    }

    private applyAudioEnhancements(
        sourceAudioBase64: string | undefined,
        expression: ResolvedExpressionSettings,
        output?: VoiceOutputSettings,
        applyWaveEdit: boolean = true,
        qualityProfile?: PersistentQualityProfile,
    ): {
        audioBase64?: string;
        sampleRate?: number;
        durationMs?: number;
        analysis?: VoiceAudioEnhancementReport;
        analysisMs?: number;
    } {
        if (!sourceAudioBase64) {
            return {};
        }

        let currentAudioBase64 = sourceAudioBase64;
        let sampleRate: number | undefined;
        let durationMs: number | undefined;
        let analysis: VoiceAudioEnhancementReport | undefined;
        let analysisMs: number | undefined;

        if (applyWaveEdit && this.shouldApplySbv2WaveEdit(expression)) {
            const waveEditResult = this.processAudioBase64(currentAudioBase64, (parsed) => (
                this.applySbv2WaveEdit(parsed, expression)
            ));
            if (waveEditResult.fallbackUsed) {
                console.warn('[VoicePipeline] SBV2 wave edit failed, fallback to original waveform');
            } else if (waveEditResult.applied) {
                currentAudioBase64 = waveEditResult.audioBase64;
                sampleRate = waveEditResult.sampleRate;
                durationMs = waveEditResult.durationMs;
            }
        }

        if (this.shouldApplyFinalEnhance(output)) {
            const analysisStartedAt = Date.now();
            const finalEnhanceResult = this.processAudioBase64WithAnalysis(currentAudioBase64, (parsed) => (
                this.applyFinalEnhanceWithAnalysis(parsed, output, qualityProfile)
            ));
            if (finalEnhanceResult.fallbackUsed) {
                console.warn('[VoicePipeline] Final audio enhancement failed, fallback to previous waveform');
            } else if (finalEnhanceResult.applied) {
                currentAudioBase64 = finalEnhanceResult.audioBase64;
                sampleRate = finalEnhanceResult.sampleRate;
                durationMs = finalEnhanceResult.durationMs;
            }
            analysis = finalEnhanceResult.analysis;
            analysisMs = Date.now() - analysisStartedAt;
        }

        return {
            audioBase64: currentAudioBase64,
            sampleRate,
            durationMs,
            analysis,
            analysisMs,
        };
    }

    private mergeAudioMetadata(
        base: {
            audioBase64?: string;
            sampleRate?: number;
            durationMs?: number;
            analysis?: VoiceAudioEnhancementReport;
            analysisMs?: number;
        },
        enhanced: {
            audioBase64?: string;
            sampleRate?: number;
            durationMs?: number;
            analysis?: VoiceAudioEnhancementReport;
            analysisMs?: number;
        },
    ): {
        audioBase64?: string;
        sampleRate?: number;
        durationMs?: number;
        analysis?: VoiceAudioEnhancementReport;
        analysisMs?: number;
    } {
        return {
            audioBase64: enhanced.audioBase64 || base.audioBase64,
            sampleRate: enhanced.sampleRate || base.sampleRate,
            durationMs: enhanced.durationMs || base.durationMs,
            analysis: enhanced.analysis || base.analysis,
            analysisMs: enhanced.analysisMs || base.analysisMs,
        };
    }

    async synthesize(params: VoiceSynthesizeParams): Promise<VoiceSynthesizeResult> {
        const startedAt = Date.now();
        const resolvedExpression = this.resolveExpression(params.expression);
        const qualityProfileId = this.resolveQualityProfileId(params);
        const qualityProfile = qualityProfileId
            ? this.getOrCreateQualityProfile(qualityProfileId)
            : undefined;

        try {
            switch (params.mode) {
                case 'sbv2': {
                    const sbv2Started = Date.now();
                    const sbv2Result = await this.sbv2.synthesize({
                        text: params.text,
                        ...(params.sbv2 || {}),
                    });

                    if (!sbv2Result.success) {
                        return {
                            success: false,
                            error: {
                                code: sbv2Result.error?.code || 'E_SERVER_FAILED',
                                message: sbv2Result.error?.message || 'SBV2 synthesis failed',
                            },
                        };
                    }

                    const enhanced = this.applyAudioEnhancements(
                        sbv2Result.audioBase64,
                        resolvedExpression,
                        params.output,
                        true,
                        qualityProfile,
                    );
                    const merged = this.mergeAudioMetadata({
                        audioBase64: sbv2Result.audioBase64,
                        sampleRate: sbv2Result.sampleRate,
                        durationMs: sbv2Result.durationMs,
                    }, enhanced);
                    if (qualityProfileId) {
                        this.updateQualityProfileFromReport(qualityProfileId, merged.analysis);
                    }

                    return {
                        success: true,
                        wavPath: sbv2Result.wavPath,
                        audioBase64: merged.audioBase64,
                        durationMs: merged.durationMs,
                        sampleRate: merged.sampleRate,
                        analysis: merged.analysis,
                        stages: {
                            sbv2Ms: Date.now() - sbv2Started,
                            analysisMs: merged.analysisMs,
                            totalMs: Date.now() - startedAt,
                        },
                    };
                }

                case 'rvc': {
                    if (!params.rvc?.inputPath && !params.rvc?.inputBase64) {
                        return {
                            success: false,
                            error: {
                                code: 'E_CONVERT_FAILED',
                                message: 'RVC mode requires inputPath or inputBase64',
                            },
                        };
                    }

                    const rvcStarted = Date.now();
                    const rvcResult = await this.rvc.convert(params.rvc);

                    if (!rvcResult.success) {
                        return {
                            success: false,
                            error: {
                                code: rvcResult.error?.code || 'E_CONVERT_FAILED',
                                message: rvcResult.error?.message || 'RVC conversion failed',
                            },
                        };
                    }

                    const enhanced = this.applyAudioEnhancements(
                        rvcResult.audioBase64,
                        resolvedExpression,
                        params.output,
                        false,
                        qualityProfile,
                    );
                    const merged = this.mergeAudioMetadata({
                        audioBase64: rvcResult.audioBase64,
                        sampleRate: rvcResult.sampleRate,
                        durationMs: rvcResult.durationMs,
                    }, enhanced);
                    if (qualityProfileId) {
                        this.updateQualityProfileFromReport(qualityProfileId, merged.analysis);
                    }

                    return {
                        success: true,
                        wavPath: rvcResult.wavPath,
                        audioBase64: merged.audioBase64,
                        durationMs: merged.durationMs,
                        sampleRate: merged.sampleRate,
                        analysis: merged.analysis,
                        stages: {
                            rvcMs: Date.now() - rvcStarted,
                            analysisMs: merged.analysisMs,
                            totalMs: Date.now() - startedAt,
                        },
                    };
                }

                case 'sbv2+rvc': {
                    const sbv2Started = Date.now();
                    const sbv2Result = await this.sbv2.synthesize({
                        text: params.text,
                        ...(params.sbv2 || {}),
                    });

                    if (!sbv2Result.success) {
                        return {
                            success: false,
                            error: {
                                code: sbv2Result.error?.code || 'E_SERVER_FAILED',
                                message: sbv2Result.error?.message || 'SBV2 stage failed',
                            },
                        };
                    }

                    let rvcInputPath = params.rvc?.inputPath || sbv2Result.wavPath;
                    let rvcInputBase64 = params.rvc?.inputPath ? params.rvc?.inputBase64 : undefined;
                    if (this.shouldApplySbv2WaveEdit(resolvedExpression) && sbv2Result.audioBase64) {
                        const waveEditResult = this.processAudioBase64(
                            sbv2Result.audioBase64,
                            (parsed) => this.applySbv2WaveEdit(parsed, resolvedExpression),
                        );
                        if (waveEditResult.fallbackUsed) {
                            console.warn('[VoicePipeline] SBV2 pre-RVC wave edit failed, using raw SBV2 output');
                        } else if (waveEditResult.applied) {
                            rvcInputPath = undefined;
                            rvcInputBase64 = waveEditResult.audioBase64;
                        }
                    }

                    const rvcStarted = Date.now();
                    const rvcResult = await this.rvc.convert({
                        ...(params.rvc || {}),
                        inputPath: rvcInputPath,
                        inputBase64: rvcInputBase64,
                    });

                    if (!rvcResult.success) {
                        return {
                            success: false,
                            intermediateWavPath: sbv2Result.wavPath,
                            error: {
                                code: rvcResult.error?.code || 'E_CONVERT_FAILED',
                                message: rvcResult.error?.message || 'RVC stage failed',
                            },
                        };
                    }

                    const enhanced = this.applyAudioEnhancements(
                        rvcResult.audioBase64,
                        resolvedExpression,
                        params.output,
                        false,
                        qualityProfile,
                    );
                    const merged = this.mergeAudioMetadata({
                        audioBase64: rvcResult.audioBase64,
                        sampleRate: rvcResult.sampleRate,
                        durationMs: rvcResult.durationMs,
                    }, enhanced);
                    if (qualityProfileId) {
                        this.updateQualityProfileFromReport(qualityProfileId, merged.analysis);
                    }

                    return {
                        success: true,
                        wavPath: rvcResult.wavPath,
                        audioBase64: merged.audioBase64,
                        durationMs: merged.durationMs,
                        sampleRate: merged.sampleRate,
                        analysis: merged.analysis,
                        intermediateWavPath: sbv2Result.wavPath,
                        stages: {
                            sbv2Ms: rvcStarted - sbv2Started,
                            rvcMs: Date.now() - rvcStarted,
                            analysisMs: merged.analysisMs,
                            totalMs: Date.now() - startedAt,
                        },
                    };
                }

                default:
                    return {
                        success: false,
                        error: {
                            code: 'E_UNKNOWN',
                            message: `Unsupported mode: ${String(params.mode)}`,
                        },
                    };
            }
        } catch (error) {
            return {
                success: false,
                error: {
                    code: 'E_UNKNOWN',
                    message: error instanceof Error ? error.message : String(error),
                },
            };
        }
    }
}
