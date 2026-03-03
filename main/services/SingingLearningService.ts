import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as https from 'https';
import AdmZip from 'adm-zip';
import { Sbv2Service } from './tts/Sbv2Service';
import {
    SeparationMixtureConsistencyEstimate,
    SeparationPerceptualQualityMetrics,
    SeparationQualityLibrary,
    SeparationStemQualityMetrics,
    SeparationStemQualityScore,
} from './audio/SeparationQualityLibrary';

const AUDIO_SEPARATOR_TORCH_CUDA_INDEX_URL = 'https://download.pytorch.org/whl/cu126';
const DNSMOS_PRIMARY_MODEL_URL = 'https://raw.githubusercontent.com/microsoft/DNS-Challenge/master/DNSMOS/DNSMOS/sig_bak_ovr.onnx';
const DNSMOS_P808_MODEL_URL = 'https://raw.githubusercontent.com/microsoft/DNS-Challenge/master/DNSMOS/DNSMOS/model_v8.onnx';

type SeparationMethod = 'uvr-ultimate' | 'roformer' | 'uvr5' | 'demucs' | 'ffmpeg-fallback' | 'custom-separator';
type SeparationPreference = 'auto' | SeparationMethod;
type SingingLearningExportPreset = 'training_bright' | 'remix_clear';

// Phase 3–4: カスタムモデル運用モード (shadow = 評価のみ / limited-auto = auto 候補に参加)
type CustomSeparatorMode = 'disabled' | 'shadow' | 'limited-auto';

interface CustomSeparatorConfig {
    modelVersion: string;        // 例: 'custom_sep_v0'
    scriptPath: string;          // Python 推論スクリプトパス
    modelWeightPath: string;     // 重みファイルパス
    venvPythonPath: string;      // 専用 venv の python 実行ファイル
}

// Phase 0: 分離試行ごとの KPI を記録する JSONL エントリ
interface SeparationTrialLogEntry {
    timestamp: string;
    characterId: string;
    method: SeparationMethod;
    processingTimeMs: number;
    success: boolean;
    wasSelected: boolean;
    // 客観 KPI (計画書 Section 6.1)
    finalScore: number | null;
    baseScore: number | null;
    stemScore: number | null;
    leakageCorrelation: number | null;
    lowBandResidualRatio: number | null;
    highBandRoughness: number | null;
    speechActivityRatio: number | null;
    silenceRatio: number | null;
    rmsDb: number | null;
    artifactScore: number | null;
    reverbTailRatio: number | null;
    normalizedError: number | null;
    // Phase 1: 学習データ適性フラグ
    isTrainingCandidate: boolean;
    error?: string;
}

export interface SingingLearningIngestParams {
    characterId: string;
    sourceUrl: string;
    separationPreference?: SeparationPreference;
    exportPresets?: SingingLearningExportPreset[];
    ytDlpCookiesFile?: string;
}

export interface SingingLearningComparisonExportResult {
    preset: SingingLearningExportPreset;
    wavPath: string;
    warning?: string;
}

export interface SingingLearningIngestResult {
    success: boolean;
    sourceUrl: string;
    characterId: string;
    runDir?: string;
    sourceAudioPath?: string;
    vocalWavPath?: string;
    accompanimentWavPath?: string;
    datasetInputPath?: string;
    method?: SeparationMethod;
    comparisonExports?: SingingLearningComparisonExportResult[];
    warning?: string;
    error?: string;
}

export interface DialogueExtractParams {
    characterId: string;
    sourceUrl: string;
    startSec?: number;
    durationSec: number;
    separationPreference?: SeparationPreference;
    ytDlpCookiesFile?: string;
}

export interface DialogueExtractResult {
    success: boolean;
    sourceUrl: string;
    characterId: string;
    runDir?: string;
    startSec: number;
    durationSec: number;
    sourceAudioPath?: string;
    vocalWavPath?: string;
    method?: SeparationMethod;
    warning?: string;
    error?: string;
}

export interface DialogueExtractProgressEvent {
    stage: string;
    message: string;
}

export interface SingingLearningProgressEvent {
    stage: string;
    message: string;
    percent: number;
}

export interface SingingLearningSeparationMethodView {
    method: SeparationMethod;
    scoreEma: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    leakageEma: number;
    speechActivityEma: number;
    rmsDbEma: number;
    updatedAt: string;
}

export interface SingingLearningSeparationProfileView {
    success: boolean;
    characterId: string;
    preferredMethod: SeparationMethod;
    updatedAt: string;
    methods: SingingLearningSeparationMethodView[];
    profilePath: string;
    error?: string;
}

interface RvcInstallManifest {
    pythonPath: string;
    rvcPath: string;
}

interface CommandResult {
    success: boolean;
    code: number;
    stdout: string;
    stderr: string;
}

interface SeparationAttempt {
    success: boolean;
    method?: SeparationMethod;
    vocalWavPath?: string;
    accompanimentWavPath?: string;
    warning?: string;
    error?: string;
}

interface SeparationQualityCandidate extends Required<Pick<SeparationAttempt, 'method' | 'vocalWavPath'>> {
    accompanimentWavPath?: string;
    warning?: string;
    processingTimeMs?: number;
}

interface ScoredSeparationCandidate {
    candidate: SeparationQualityCandidate;
    score: SeparationStemQualityScore;
    vocalMetrics: SeparationStemQualityMetrics;
    perceptualMetrics: SeparationPerceptualQualityMetrics;
    dnsmos?: DnsmosInferenceResult;
    mixtureConsistency?: SeparationMixtureConsistencyEstimate;
    baseScore: number;
    priorAdjustment: number;
    mixAdjustment: number;
    perceptualAdjustment: number;
    dnsmosAdjustment: number;
    preservationAdjustment: number;
    finalScore: number;
}

interface DnsmosInferenceResult {
    ovrl: number;
    sig: number;
    bak: number;
    p808: number;
}

interface PersistentMethodSeparationProfile {
    scoreEma: number;
    successCount: number;
    failureCount: number;
    leakageEma: number;
    speechActivityEma: number;
    rmsDbEma: number;
    updatedAt: string;
}

interface PersistentCharacterSeparationProfile {
    id: string;
    preferredMethod?: SeparationMethod;
    methods: Record<SeparationMethod, PersistentMethodSeparationProfile>;
    updatedAt: string;
}

interface PersistedSeparationProfileStore {
    version: number;
    entries: Record<string, PersistentCharacterSeparationProfile>;
}

export class SingingLearningService {
    private static instance: SingingLearningService | null = null;

    private readonly baseDir: string;
    private readonly rvcInstallDir: string;
    private readonly sbv2InstallDir: string;
    private readonly ttsResourcesPath: string;
    private readonly separationProfileStorePath: string;
    private readonly separationTrialLogPath: string;
    private readonly separationProfiles = new Map<string, PersistentCharacterSeparationProfile>();
    private separationProfilesDirty = false;
    private separationProfilesLastPersistAt = 0;
    private customSeparatorMode: CustomSeparatorMode = 'disabled';
    private customSeparatorConfig: CustomSeparatorConfig | null = null;
    private ytDlpRuntimeCache: {
        args: string[];
        diag: string;
        ytDlpOverride?: { command: string; argsPrefix: string[] };
    } | 'unchecked' = 'unchecked';

    private constructor(ttsResourcesPath: string) {
        const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
        this.baseDir = path.join(localAppData, 'AntiGravity', 'tts', 'singing_learning');
        this.rvcInstallDir = path.join(localAppData, 'AntiGravity', 'tts', 'rvc');
        this.sbv2InstallDir = path.join(localAppData, 'AntiGravity', 'tts', 'sbv2');
        this.ttsResourcesPath = ttsResourcesPath;
        this.separationProfileStorePath = path.join(this.baseDir, 'separation_quality_profiles.json');
        this.separationTrialLogPath = path.join(this.baseDir, 'separation_trial_log.jsonl');
        fs.mkdirSync(this.baseDir, { recursive: true });
        this.loadSeparationProfiles();
    }

    static getInstance(ttsResourcesPath: string): SingingLearningService {
        if (!SingingLearningService.instance) {
            SingingLearningService.instance = new SingingLearningService(ttsResourcesPath);
        }
        return SingingLearningService.instance;
    }

    extractYouTubeUrl(text: string): string | null {
        const source = String(text || '').trim();
        if (!source) return null;
        // Supports www.youtube.com, music.youtube.com, and youtu.be
        const regex = /(https?:\/\/(?:(?:www\.|music\.)?youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[^\s]+)/i;
        const match = source.match(regex);
        if (!match || !match[1]) return null;
        return match[1];
    }

    parseYouTubeTimestamp(url: string): number | null {
        const match = url.match(/[?&]t=([^&\s#]+)/i);
        if (!match) return null;
        const raw = match[1];
        if (/^\d+$/.test(raw)) return parseInt(raw, 10);
        const hms = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
        if (hms && (hms[1] || hms[2] || hms[3])) {
            return (parseInt(hms[1] || '0', 10) * 3600)
                + (parseInt(hms[2] || '0', 10) * 60)
                + parseInt(hms[3] || '0', 10);
        }
        return null;
    }

    async extractDialogueClip(
        params: DialogueExtractParams,
        onProgress?: (event: DialogueExtractProgressEvent) => void,
    ): Promise<DialogueExtractResult> {
        const report = (stage: string, message: string): void => {
            try {
                onProgress?.({ stage, message });
            } catch {
                // Ignore progress callback failures
            }
        };
        const characterId = this.normalizeId(params.characterId, 'character_default');
        const sourceUrl = String(params.sourceUrl || '').trim();
        if (!sourceUrl) {
            return { success: false, sourceUrl, characterId, startSec: 0, durationSec: params.durationSec, error: 'YouTube URL is empty' };
        }

        const startSec = params.startSec ?? this.parseYouTubeTimestamp(sourceUrl) ?? 0;
        const durationSec = Math.max(1, Math.floor(params.durationSec || 10));
        const endSec = startSec + durationSec;
        const sectionArg = `*${startSec}-${endSec}`;

        const runId = this.createRunId();
        const charDir = path.join(this.baseDir, characterId);
        const runDir = path.join(charDir, 'dialogue_runs', runId);
        const downloadDir = path.join(runDir, 'download');
        const separateDir = path.join(runDir, 'separated');
        const vocalDir = path.join(separateDir, 'vocals');
        const instDir = path.join(separateDir, 'accompaniment');

        fs.mkdirSync(downloadDir, { recursive: true });
        fs.mkdirSync(vocalDir, { recursive: true });
        fs.mkdirSync(instDir, { recursive: true });

        const preWarnings: string[] = [];

        report('download', 'YouTube音声を取得中...');
        let downloaded = await this.downloadYouTubeAudio(
            sourceUrl,
            downloadDir,
            params.ytDlpCookiesFile,
            sectionArg,
            (message) => report('download', message),
        );
        if ((!downloaded.success || !downloaded.audioPath) && this.isDialogueClipPartialDownloadTimeout(downloaded.error)) {
            preWarnings.push('Dialogue clip partial download timed out; switched to full-audio download + local trim.');
            report('download_retry', 'YouTube部分取得がタイムアウト。音声のみ取得に切り替えます...');
            const fullDownloadDir = path.join(runDir, 'download_fallback_full');
            fs.mkdirSync(fullDownloadDir, { recursive: true });
            const fallbackDownloaded = await this.downloadYouTubeAudio(
                sourceUrl,
                fullDownloadDir,
                params.ytDlpCookiesFile,
                undefined,
                (message) => report('download', `${message} [full-fallback]`),
            );
            if (!fallbackDownloaded.success || !fallbackDownloaded.audioPath) {
                const partialErr = this.takeTail(downloaded.error || 'unknown partial download error', 320);
                const fallbackErr = this.takeTail(fallbackDownloaded.error || 'unknown fallback download error', 320);
                return {
                    success: false, sourceUrl, characterId, runDir, startSec, durationSec,
                    error: `Dialogue clip download failed (partial timeout + full fallback failed). partial=${partialErr} | fallback=${fallbackErr}`,
                };
            }
            report('clip_trim', 'ローカルでクリップを切り出し中...');
            const trimmed = await this.trimAudioClipWithFfmpeg(fallbackDownloaded.audioPath, runDir, startSec, durationSec);
            if (!trimmed.success || !trimmed.audioPath) {
                const trimErr = this.takeTail(trimmed.error || 'unknown trim error', 320);
                return {
                    success: false, sourceUrl, characterId, runDir, startSec, durationSec,
                    error: `Dialogue clip download fallback succeeded but local trim failed: ${trimErr}`,
                };
            }
            const mergedFallbackWarning = [fallbackDownloaded.warning, trimmed.warning].filter(Boolean).join(' ') || undefined;
            downloaded = {
                success: true,
                audioPath: trimmed.audioPath,
                warning: mergedFallbackWarning,
            };
        }
        if (!downloaded.success || !downloaded.audioPath) {
            return {
                success: false, sourceUrl, characterId, runDir, startSec, durationSec,
                error: downloaded.error || 'Failed to download audio clip from YouTube',
            };
        }
        report('download_done', 'YouTube音声の取得完了。分離準備中...');

        const separationPreference = this.normalizeSeparationPreference(params.separationPreference);
        const separationPlan = this.buildSeparationPlan(separationPreference, characterId);
        const dialogueFastAuto = separationPreference === 'auto';
        if (downloaded.warning) preWarnings.push(downloaded.warning);
        if (dialogueFastAuto) preWarnings.push('Dialogue extractor fast auto mode: using faster separator shortlist (ranking skipped).');

        report('prepare', '分離用に音声を準備中...');
        const prepared = await this.prepareSourceAudioForSeparation(downloaded.audioPath, runDir);
        if (prepared.warning) preWarnings.push(prepared.warning);
        const sourceAudioPath = prepared.audioPath;

        const attemptErrors: string[] = [];
        const failedMethods: SeparationMethod[] = [];
        const failedTimings = new Map<SeparationMethod, number>();
        const methodsForInitialPass = separationPreference === 'auto'
            ? this.buildDialogueFastAutoSeparationPlan(separationPlan)
            : separationPlan;
        const successfulCandidates: SeparationQualityCandidate[] = [];
        let separation: SeparationAttempt = { success: false, error: 'No separator attempted.' };

        for (const method of methodsForInitialPass) {
            report('separate', `音声分離中... (${method})`);
            const attempt = await this.runSeparationByMethod(method, sourceAudioPath, vocalDir, instDir);
            if (attempt.success) {
                if (attempt.vocalWavPath) {
                    successfulCandidates.push({
                        method: attempt.method || method,
                        vocalWavPath: attempt.vocalWavPath,
                        accompanimentWavPath: attempt.accompanimentWavPath,
                        warning: attempt.warning,
                        processingTimeMs: attempt.processingTimeMs,
                    });
                }
                if (separationPreference !== 'auto') { separation = attempt; break; }
                continue;
            }
            separation = attempt;
            if (attempt.error) { attemptErrors.push(`${method}: ${attempt.error}`); failedMethods.push(method); failedTimings.set(method, attempt.processingTimeMs); }
        }

        if (dialogueFastAuto && successfulCandidates.length > 0) {
            report('select', `分離候補を選択中... (高速モード: ${successfulCandidates[0].method})`);
            const first = successfulCandidates[0];
            separation = { success: true, method: first.method, vocalWavPath: first.vocalWavPath, warning: first.warning };
            this.updateSeparationProfileForSuccess(characterId, first.method);
        } else if (separationPreference === 'auto' && successfulCandidates.length > 0) {
            report('select', '分離候補を品質評価中...');
            try {
                const selected = await this.selectBestSeparationCandidate(successfulCandidates, runDir, characterId, sourceAudioPath);
                separation = { success: true, method: selected.candidate.method, vocalWavPath: selected.candidate.vocalWavPath, warning: selected.warning };
                if (selected.scoredCandidates && selected.scoredCandidates.length > 0) {
                    this.updateSeparationProfileFromScoredCandidates(characterId, selected.scoredCandidates, selected.candidate.method);
                } else {
                    this.updateSeparationProfileForSuccess(characterId, selected.candidate.method);
                }
            } catch (_err) {
                const first = successfulCandidates[0];
                separation = { success: true, method: first.method, vocalWavPath: first.vocalWavPath, warning: first.warning };
                this.updateSeparationProfileForSuccess(characterId, first.method);
            }
        } else if (separation.success && separation.method) {
            this.updateSeparationProfileForSuccess(characterId, separation.method);
        }

        if ((!separation.success || !separation.vocalWavPath) && methodsForInitialPass.length < separationPlan.length) {
            const fallbackMethod = separationPlan.find((method) => !methodsForInitialPass.includes(method));
            if (fallbackMethod) {
                report('separate_fallback', `音声分離中... (${fallbackMethod} fallback)`);
                const fallback = await this.runSeparationByMethod(fallbackMethod, sourceAudioPath, vocalDir, instDir);
                separation = fallback;
                if (!fallback.success && fallback.error) { attemptErrors.push(`${fallbackMethod}: ${fallback.error}`); failedMethods.push(fallbackMethod); failedTimings.set(fallbackMethod, fallback.processingTimeMs); }
                else if (fallback.success && fallback.method) { this.updateSeparationProfileForSuccess(characterId, fallback.method); }
            }
        }

        if (failedMethods.length > 0) this.updateSeparationProfileForFailures(characterId, failedMethods, failedTimings);

        if (!separation.success || !separation.vocalWavPath) {
            const reasons = attemptErrors.length > 0 ? ` (${attemptErrors.join(' | ')})` : '';
            return {
                success: false, sourceUrl, characterId, runDir, startSec, durationSec, sourceAudioPath,
                error: separation.error ? `${separation.error}${reasons}` : `Failed to separate vocal track${reasons}`,
            };
        }

        report('done', `分離完了 (${separation.method || 'unknown'})`);
        const allWarnings = [...preWarnings, separation.warning].filter(Boolean).join(' ') || undefined;
        return {
            success: true, sourceUrl, characterId, runDir, startSec, durationSec,
            sourceAudioPath, vocalWavPath: separation.vocalWavPath,
            method: separation.method, warning: allWarnings,
        };
    }

    private isDialogueClipPartialDownloadTimeout(errorText?: string): boolean {
        const text = String(errorText || '');
        if (!text) return false;
        return /Command timeout after \d+ms/i.test(text)
            && /Dialogue clip partial download mode enabled/i.test(text);
    }

    private async trimAudioClipWithFfmpeg(
        inputAudioPath: string,
        runDir: string,
        startSec: number,
        durationSec: number,
    ): Promise<{ success: boolean; audioPath?: string; warning?: string; error?: string }> {
        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            return {
                success: false,
                error: `ffmpeg is required for local dialogue clip trim (${ffmpegTools.error || 'ffmpeg not available'}).`,
            };
        }
        const trimmedDir = path.join(runDir, 'trimmed');
        fs.mkdirSync(trimmedDir, { recursive: true });
        const trimmedWavPath = path.join(trimmedDir, `dialogue_clip_${Date.now()}.wav`);
        const safeStart = Math.max(0, Number.isFinite(startSec) ? startSec : 0);
        const safeDuration = Math.max(1, Math.floor(Number.isFinite(durationSec) ? durationSec : 10));
        const trim = await this.runCommand(ffmpegTools.ffmpegPath, [
            '-y',
            '-ss', safeStart.toFixed(3),
            '-t', safeDuration.toFixed(3),
            '-i', inputAudioPath,
            '-vn',
            '-ac', '2',
            '-ar', '44100',
            '-c:a', 'pcm_s16le',
            trimmedWavPath,
        ], {
            timeoutMs: Math.min(10 * 60 * 1000, Math.max(60_000, safeDuration * 8_000)),
        });
        if (!trim.success || !fs.existsSync(trimmedWavPath)) {
            return {
                success: false,
                error: `ffmpeg dialogue clip trim failed (${this.takeTail(trim.stderr || trim.stdout, 360) || 'unknown error'}).`,
            };
        }
        const warning = [ffmpegTools.warning, `Dialogue clip fallback used local ffmpeg trim (${safeStart.toFixed(1)}s + ${safeDuration}s).`]
            .filter(Boolean)
            .join(' ');
        return {
            success: true,
            audioPath: trimmedWavPath,
            warning: warning || undefined,
        };
    }

    getSeparationProfile(characterIdRaw: string): SingingLearningSeparationProfileView {
        try {
            const characterId = this.normalizeId(characterIdRaw, 'character_default');
            const profile = this.getOrCreateCharacterSeparationProfile(characterId);
            const methods: SeparationMethod[] = ['uvr-ultimate', 'roformer', 'demucs', 'uvr5', 'ffmpeg-fallback', 'custom-separator'];
            const methodViews: SingingLearningSeparationMethodView[] = methods.map((method) => {
                const methodProfile = profile.methods[method];
                const attempts = methodProfile.successCount + methodProfile.failureCount;
                const successRate = attempts > 0 ? methodProfile.successCount / attempts : 0;
                return {
                    method,
                    scoreEma: this.roundNumber(methodProfile.scoreEma, 2),
                    successCount: methodProfile.successCount,
                    failureCount: methodProfile.failureCount,
                    successRate: this.roundNumber(successRate, 4),
                    leakageEma: this.roundNumber(methodProfile.leakageEma, 4),
                    speechActivityEma: this.roundNumber(methodProfile.speechActivityEma, 4),
                    rmsDbEma: this.roundNumber(methodProfile.rmsDbEma, 2),
                    updatedAt: methodProfile.updatedAt,
                };
            });
            return {
                success: true,
                characterId,
                preferredMethod: profile.preferredMethod || this.resolvePreferredMethod(profile),
                updatedAt: profile.updatedAt,
                methods: methodViews,
                profilePath: this.separationProfileStorePath,
            };
        } catch (error) {
            return {
                success: false,
                characterId: this.normalizeId(characterIdRaw, 'character_default'),
                preferredMethod: 'uvr-ultimate',
                updatedAt: new Date(0).toISOString(),
                methods: [],
                profilePath: this.separationProfileStorePath,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    resetSeparationProfile(characterIdRaw: string): SingingLearningSeparationProfileView {
        const characterId = this.normalizeId(characterIdRaw, 'character_default');
        this.separationProfiles.delete(characterId);
        this.separationProfilesDirty = true;
        this.persistSeparationProfiles(true);
        return this.getSeparationProfile(characterId);
    }

    // Phase 3–4: カスタムセパレータのモードと設定を切り替える
    setCustomSeparatorMode(mode: CustomSeparatorMode, config?: CustomSeparatorConfig): void {
        this.customSeparatorMode = mode;
        this.customSeparatorConfig = config ?? null;
    }

    // Phase 0: 分離試行 KPI を JSONL ログに追記する（書き込み失敗は無視）
    private appendSeparationTrialLog(entry: SeparationTrialLogEntry): void {
        try {
            fs.appendFileSync(this.separationTrialLogPath, JSON.stringify(entry) + '\n', 'utf8');
        } catch {
            // ログ書き込み失敗は致命的でないため無視
        }
    }

    // Phase 0: ScoredSeparationCandidate から試行ログエントリを構築する
    private buildTrialLogEntry(
        characterId: string,
        scored: ScoredSeparationCandidate,
        wasSelected: boolean,
    ): SeparationTrialLogEntry {
        const m = scored.vocalMetrics;
        const p = scored.perceptualMetrics;
        const lc = scored.score.leakageCorrelation ?? null;
        const lbr = scored.mixtureConsistency?.lowBandResidualRatio ?? null;
        const ne = scored.mixtureConsistency?.normalizedError ?? null;
        const isTrainingCandidate =
            scored.finalScore >= 75
            && (lc === null || lc < 0.18)
            && m.speechActivityRatio >= 0.10
            && m.silenceRatio < 0.60
            && p.highBandRoughness < 0.40;
        return {
            timestamp: new Date().toISOString(),
            characterId,
            method: scored.candidate.method,
            processingTimeMs: scored.candidate.processingTimeMs ?? 0,
            success: true,
            wasSelected,
            finalScore: scored.finalScore,
            baseScore: scored.baseScore,
            stemScore: scored.score.score,
            leakageCorrelation: lc,
            lowBandResidualRatio: lbr,
            highBandRoughness: p.highBandRoughness,
            speechActivityRatio: m.speechActivityRatio,
            silenceRatio: m.silenceRatio,
            rmsDb: m.rmsDb,
            artifactScore: p.artifactScore,
            reverbTailRatio: p.reverbTailRatio,
            normalizedError: ne,
            isTrainingCandidate,
        };
    }

    async ingestFromYouTube(
        params: SingingLearningIngestParams,
        onProgress?: (event: SingingLearningProgressEvent) => void,
    ): Promise<SingingLearningIngestResult> {
        const report = (stage: string, message: string, percent: number): void => {
            try {
                onProgress?.({
                    stage,
                    message,
                    percent: this.clampInteger(Math.round(percent), 0, 100, 0),
                });
            } catch {
                // Ignore progress callback failures.
            }
        };
        const characterId = this.normalizeId(params.characterId, 'character_default');
        const sourceUrl = String(params.sourceUrl || '').trim();
        if (!sourceUrl) {
            return {
                success: false,
                sourceUrl,
                characterId,
                error: 'YouTube URL is empty',
            };
        }

        const runId = this.createRunId();
        const charDir = path.join(this.baseDir, characterId);
        const runDir = path.join(charDir, 'runs', runId);
        const downloadDir = path.join(runDir, 'download');
        const separateDir = path.join(runDir, 'separated');
        const vocalDir = path.join(separateDir, 'vocals');
        const instDir = path.join(separateDir, 'accompaniment');
        const trainDir = path.join(charDir, 'training_material');

        fs.mkdirSync(downloadDir, { recursive: true });
        fs.mkdirSync(vocalDir, { recursive: true });
        fs.mkdirSync(instDir, { recursive: true });
        fs.mkdirSync(trainDir, { recursive: true });

        report('start', '歌唱学習ジョブを開始しました...', 2);
        report('download', 'YouTube音声を取得中...', 8);
        const downloaded = await this.downloadYouTubeAudio(sourceUrl, downloadDir, params.ytDlpCookiesFile);
        if (!downloaded.success || !downloaded.audioPath) {
            return {
                success: false,
                sourceUrl,
                characterId,
                runDir,
                error: downloaded.error || 'Failed to download audio from YouTube',
            };
        }

        let sourceAudioPath = downloaded.audioPath;
        const separationPreference = this.normalizeSeparationPreference(params.separationPreference);
        const exportPresets = this.normalizeExportPresets(params.exportPresets);
        const separationPlan = this.buildSeparationPlan(separationPreference, characterId);
        const preWarnings: string[] = [];
        if (downloaded.warning) {
            preWarnings.push(downloaded.warning);
        }
        if (separationPreference !== 'auto') {
            preWarnings.push(`Separation preference: ${separationPreference}.`);
        }
        report('prepare', '音声を分離用に前処理しています...', 22);
        const prepared = await this.prepareSourceAudioForSeparation(sourceAudioPath, runDir);
        if (prepared.warning) {
            preWarnings.push(prepared.warning);
        }
        sourceAudioPath = prepared.audioPath;
        const attemptErrors: string[] = [];
        const failedMethods: SeparationMethod[] = [];
        const failedTimings = new Map<SeparationMethod, number>();
        const methodsForInitialPass = separationPreference === 'auto'
            ? separationPlan.filter((method) => method !== 'ffmpeg-fallback')
            : separationPlan;
        const successfulCandidates: SeparationQualityCandidate[] = [];
        let enhancementAlternativeCandidates: SeparationQualityCandidate[] = [];
        let separation: SeparationAttempt = { success: false, error: 'No separator attempted.' };
        const separationProgressBase = 28;
        const separationProgressSpan = 46;

        for (let index = 0; index < methodsForInitialPass.length; index += 1) {
            const method = methodsForInitialPass[index];
            const methodPercent = separationProgressBase + Math.floor((index / Math.max(1, methodsForInitialPass.length)) * separationProgressSpan);
            report('separate', `音声分離中... (${method})`, methodPercent);
            const attempt = await this.runSeparationByMethod(method, sourceAudioPath, vocalDir, instDir);
            if (attempt.success) {
                if (attempt.vocalWavPath) {
                    successfulCandidates.push({
                        method: attempt.method || method,
                        vocalWavPath: attempt.vocalWavPath,
                        accompanimentWavPath: attempt.accompanimentWavPath,
                        warning: attempt.warning,
                        processingTimeMs: attempt.processingTimeMs,
                    });
                }
                if (separationPreference !== 'auto') {
                    separation = attempt;
                    break;
                }
                continue;
            }
            separation = attempt;
            if (attempt.error) {
                attemptErrors.push(`${method}: ${attempt.error}`);
                failedMethods.push(method);
                failedTimings.set(method, attempt.processingTimeMs);
            }
        }

        if (separationPreference === 'auto' && successfulCandidates.length > 0) {
            try {
                report('rank', '分離候補を比較中...', 76);
                const selected = await this.selectBestSeparationCandidate(successfulCandidates, runDir, characterId, sourceAudioPath);
                separation = {
                    success: true,
                    method: selected.candidate.method,
                    vocalWavPath: selected.candidate.vocalWavPath,
                    accompanimentWavPath: selected.candidate.accompanimentWavPath,
                    warning: selected.warning,
                };
                if (selected.scoredCandidates && selected.scoredCandidates.length > 0) {
                    enhancementAlternativeCandidates = this.buildEnhancementAlternativeCandidates(
                        selected.candidate,
                        selected.scoredCandidates,
                    );
                    if (selected.scoredCandidates.length > 1 && enhancementAlternativeCandidates.length === 0) {
                        separation.warning = [
                            selected.warning,
                            'Alternative separator candidate was unavailable after path filtering (duplicate output path suspected).',
                        ].filter(Boolean).join(' ');
                    }
                    this.updateSeparationProfileFromScoredCandidates(characterId, selected.scoredCandidates, selected.candidate.method);
                } else {
                    this.updateSeparationProfileForSuccess(characterId, selected.candidate.method);
                }
            } catch (error) {
                const first = successfulCandidates[0];
                separation = {
                    success: true,
                    method: first.method,
                    vocalWavPath: first.vocalWavPath,
                    accompanimentWavPath: first.accompanimentWavPath,
                    warning: [
                        first.warning,
                        `Automatic candidate scoring failed: ${error instanceof Error ? error.message : String(error)}`,
                    ].filter(Boolean).join(' '),
                };
                this.updateSeparationProfileForSuccess(characterId, first.method);
            }
        } else if (separation.success && separation.method) {
            this.updateSeparationProfileForSuccess(characterId, separation.method);
        }

        if ((!separation.success || !separation.vocalWavPath) && methodsForInitialPass.length < separationPlan.length) {
            const fallbackMethod = separationPlan.find((method) => !methodsForInitialPass.includes(method));
            if (fallbackMethod) {
                report('fallback', `音声分離中... (${fallbackMethod} fallback)`, 74);
                const fallbackAttempt = await this.runSeparationByMethod(fallbackMethod, sourceAudioPath, vocalDir, instDir);
                separation = fallbackAttempt;
                if (!fallbackAttempt.success && fallbackAttempt.error) {
                    attemptErrors.push(`${fallbackMethod}: ${fallbackAttempt.error}`);
                    failedMethods.push(fallbackMethod);
                    failedTimings.set(fallbackMethod, fallbackAttempt.processingTimeMs);
                } else if (fallbackAttempt.success && fallbackAttempt.method) {
                    this.updateSeparationProfileForSuccess(characterId, fallbackAttempt.method);
                }
            }
        }

        if (failedMethods.length > 0) {
            this.updateSeparationProfileForFailures(characterId, failedMethods, failedTimings);
        }

        if (separation.success && separation.vocalWavPath && attemptErrors.length > 0) {
            const existingWarning = separation.warning ? `${separation.warning} ` : '';
            separation.warning = `${existingWarning}Other separators failed (${attemptErrors.join(' | ')}).`;
        }

        if (!separation.success || !separation.vocalWavPath) {
            const reasons = attemptErrors.length > 0 ? ` (${attemptErrors.join(' | ')})` : '';
            return {
                success: false,
                sourceUrl,
                characterId,
                runDir,
                sourceAudioPath,
                error: separation.error
                    ? `${separation.error}${reasons}`
                    : `Failed to separate vocal track${reasons}`,
            };
        }

        report('enhance', `抽出ボーカルを整形中... (${separation.method || 'unknown'})`, 84);
        const enhancedVocal = await this.enhanceSeparatedVocalTrack(
            separation.vocalWavPath,
            runDir,
            sourceAudioPath,
            separation.accompanimentWavPath,
            enhancementAlternativeCandidates,
            separation.method,
        );
        if (enhancedVocal.vocalWavPath) {
            separation.vocalWavPath = enhancedVocal.vocalWavPath;
        }
        if (enhancedVocal.warning) {
            separation.warning = [separation.warning, enhancedVocal.warning].filter(Boolean).join(' ') || undefined;
        }

        const trainingCopyPath = path.join(
            trainDir,
            `${runId}_${path.basename(separation.vocalWavPath).replace(/[^a-zA-Z0-9_.-]+/g, '_')}`,
        );
        fs.copyFileSync(separation.vocalWavPath, trainingCopyPath);

        let datasetInputPath: string | undefined;
        let comparisonExports: SingingLearningComparisonExportResult[] | undefined;
        try {
            report('dataset', '学習素材を登録中...', 94);
            datasetInputPath = await this.copyToSbv2DatasetInput(characterId, trainingCopyPath);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                success: true,
                sourceUrl,
                characterId,
                runDir,
                sourceAudioPath,
                vocalWavPath: trainingCopyPath,
                accompanimentWavPath: separation.accompanimentWavPath,
                method: separation.method,
                warning: [...preWarnings, separation.warning, `Vocal extracted but dataset registration failed: ${message}`]
                    .filter(Boolean)
                    .join(' '),
            };
        }

        if (exportPresets.length > 0) {
            report('export', '比較用エクスポートを生成中...', 97);
            const renderedExports = await this.renderComparisonExports({
                runDir,
                canonicalVocalWavPath: separation.vocalWavPath,
                accompanimentWavPath: separation.accompanimentWavPath,
                presets: exportPresets,
            });
            comparisonExports = renderedExports.exports;
            if (renderedExports.warning) {
                separation.warning = [separation.warning, renderedExports.warning].filter(Boolean).join(' ') || undefined;
            }
        }

        this.writeRunMetadata(runDir, {
            sourceUrl,
            characterId,
            sourceAudioPath,
            vocalWavPath: trainingCopyPath,
            accompanimentWavPath: separation.accompanimentWavPath,
            datasetInputPath,
            method: separation.method,
            separationPreference,
            comparisonExports,
            createdAt: new Date().toISOString(),
        });

        report('done', `歌唱学習の取り込みが完了しました。(${separation.method || 'unknown'})`, 100);
        return {
            success: true,
            sourceUrl,
            characterId,
            runDir,
            sourceAudioPath,
            vocalWavPath: trainingCopyPath,
            accompanimentWavPath: separation.accompanimentWavPath,
            datasetInputPath,
            method: separation.method,
            comparisonExports,
            warning: [...preWarnings, separation.warning].filter(Boolean).join(' ') || undefined,
        };
    }

    private writeRunMetadata(runDir: string, payload: Record<string, unknown>): void {
        try {
            fs.writeFileSync(path.join(runDir, 'metadata.json'), JSON.stringify(payload, null, 2), 'utf-8');
        } catch (error) {
            console.warn('[SingingLearning] Failed to write metadata:', error);
        }
    }

    private getDefaultMethodSeparationProfile(method: SeparationMethod): PersistentMethodSeparationProfile {
        const now = new Date().toISOString();
        const initialScore: Record<SeparationMethod, number> = {
            'uvr-ultimate': 78,
            roformer: 75,
            demucs: 76,
            uvr5: 72,
            'ffmpeg-fallback': 58,
            'custom-separator': 72,  // Phase 0 ベースライン: 既存 uvr5 と同等から開始
        };
        return {
            scoreEma: initialScore[method],
            successCount: 0,
            failureCount: 0,
            leakageEma: 0.22,
            speechActivityEma: 0.24,
            rmsDbEma: -18,
            updatedAt: now,
        };
    }

    private getDefaultCharacterSeparationProfile(characterId: string): PersistentCharacterSeparationProfile {
        return {
            id: characterId,
            preferredMethod: 'uvr-ultimate',
            methods: {
                'uvr-ultimate': this.getDefaultMethodSeparationProfile('uvr-ultimate'),
                roformer: this.getDefaultMethodSeparationProfile('roformer'),
                demucs: this.getDefaultMethodSeparationProfile('demucs'),
                uvr5: this.getDefaultMethodSeparationProfile('uvr5'),
                'ffmpeg-fallback': this.getDefaultMethodSeparationProfile('ffmpeg-fallback'),
                'custom-separator': this.getDefaultMethodSeparationProfile('custom-separator'),
            },
            updatedAt: new Date().toISOString(),
        };
    }

    private sanitizeCharacterSeparationProfile(
        raw: Partial<PersistentCharacterSeparationProfile>,
        fallbackId: string,
    ): PersistentCharacterSeparationProfile {
        const base = this.getDefaultCharacterSeparationProfile(fallbackId);
        const methodsRaw = (raw.methods || {}) as Partial<Record<SeparationMethod, Partial<PersistentMethodSeparationProfile>>>;
        const sanitizeMethod = (method: SeparationMethod): PersistentMethodSeparationProfile => {
            const source = methodsRaw[method] || {};
            const fallback = base.methods[method];
            return {
                scoreEma: this.clampNumber(Number(source.scoreEma), 0, 100, fallback.scoreEma),
                successCount: this.clampInteger(Number(source.successCount), 0, 1_000_000, fallback.successCount),
                failureCount: this.clampInteger(Number(source.failureCount), 0, 1_000_000, fallback.failureCount),
                leakageEma: this.clampNumber(Number(source.leakageEma), 0, 1, fallback.leakageEma),
                speechActivityEma: this.clampNumber(Number(source.speechActivityEma), 0, 1, fallback.speechActivityEma),
                rmsDbEma: this.clampNumber(Number(source.rmsDbEma), -80, 0, fallback.rmsDbEma),
                updatedAt: String(source.updatedAt || fallback.updatedAt),
            };
        };

        const normalizedId = this.normalizeId(String(raw.id || fallbackId), fallbackId);
        const profile: PersistentCharacterSeparationProfile = {
            id: normalizedId,
            preferredMethod: this.normalizeSeparationMethod(raw.preferredMethod) || base.preferredMethod,
            methods: {
                'uvr-ultimate': sanitizeMethod('uvr-ultimate'),
                roformer: sanitizeMethod('roformer'),
                demucs: sanitizeMethod('demucs'),
                uvr5: sanitizeMethod('uvr5'),
                'ffmpeg-fallback': sanitizeMethod('ffmpeg-fallback'),
                'custom-separator': sanitizeMethod('custom-separator'),
            },
            updatedAt: String(raw.updatedAt || base.updatedAt),
        };
        profile.preferredMethod = this.resolvePreferredMethod(profile);
        return profile;
    }

    private loadSeparationProfiles(): void {
        if (!fs.existsSync(this.separationProfileStorePath)) {
            return;
        }
        try {
            const raw = fs.readFileSync(this.separationProfileStorePath, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<PersistedSeparationProfileStore>;
            const entries = parsed?.entries;
            if (!entries || typeof entries !== 'object') {
                return;
            }
            for (const [characterIdRaw, profileRaw] of Object.entries(entries)) {
                const characterId = this.normalizeId(characterIdRaw, 'character_default');
                const normalized = this.sanitizeCharacterSeparationProfile(profileRaw, characterId);
                this.separationProfiles.set(characterId, normalized);
            }
        } catch (error) {
            console.warn('[SingingLearning] Failed to load separation profiles:', error);
        }
    }

    private persistSeparationProfiles(force: boolean = false): void {
        if (!this.separationProfilesDirty) {
            return;
        }
        const now = Date.now();
        if (!force && now - this.separationProfilesLastPersistAt < 1500) {
            return;
        }
        try {
            const entries: Record<string, PersistentCharacterSeparationProfile> = {};
            for (const [characterId, profile] of this.separationProfiles.entries()) {
                entries[characterId] = profile;
            }
            const payload: PersistedSeparationProfileStore = {
                version: 1,
                entries,
            };
            fs.writeFileSync(this.separationProfileStorePath, JSON.stringify(payload, null, 2), 'utf-8');
            this.separationProfilesDirty = false;
            this.separationProfilesLastPersistAt = now;
        } catch (error) {
            console.warn('[SingingLearning] Failed to persist separation profiles:', error);
        }
    }

    private getOrCreateCharacterSeparationProfile(characterIdRaw: string): PersistentCharacterSeparationProfile {
        const characterId = this.normalizeId(characterIdRaw, 'character_default');
        const existing = this.separationProfiles.get(characterId);
        if (existing) {
            return existing;
        }
        const created = this.getDefaultCharacterSeparationProfile(characterId);
        this.separationProfiles.set(characterId, created);
        this.separationProfilesDirty = true;
        this.persistSeparationProfiles();
        return created;
    }

    private normalizeSeparationMethod(value: unknown): SeparationMethod | undefined {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'uvr-ultimate' || normalized === 'roformer' || normalized === 'demucs' || normalized === 'uvr5' || normalized === 'ffmpeg-fallback' || normalized === 'custom-separator') {
            return normalized;
        }
        return undefined;
    }

    private resolvePreferredMethod(profile: PersistentCharacterSeparationProfile): SeparationMethod {
        // custom-separator は preferred として表示しない（Phase 3 shadow 運用 / ロールバック対応）
        const methods: SeparationMethod[] = ['uvr-ultimate', 'roformer', 'demucs', 'uvr5', 'ffmpeg-fallback'];
        let bestMethod: SeparationMethod = methods[0];
        let bestScore = -Infinity;
        for (const method of methods) {
            const methodProfile = profile.methods[method];
            const attempts = methodProfile.successCount + methodProfile.failureCount;
            const successRate = (methodProfile.successCount + 1) / (attempts + 2);
            const score = methodProfile.scoreEma + (successRate - 0.5) * 8;
            if (score > bestScore) {
                bestScore = score;
                bestMethod = method;
            }
        }
        return bestMethod;
    }

    private getMethodPriorScore(characterIdRaw: string, method: SeparationMethod): number {
        const profile = this.getOrCreateCharacterSeparationProfile(characterIdRaw);
        const methodProfile = profile.methods[method];
        const attempts = methodProfile.successCount + methodProfile.failureCount;
        const successRate = (methodProfile.successCount + 1) / (attempts + 2);
        const scoreBias = (methodProfile.scoreEma - 72) * 0.08;
        const successBias = (successRate - 0.5) * 6;
        return this.clampNumber(scoreBias + successBias, -6, 6, 0);
    }

    private updateSeparationProfileFromScoredCandidates(
        characterIdRaw: string,
        scoredCandidates: ScoredSeparationCandidate[],
        selectedMethod?: SeparationMethod,
    ): void {
        const characterId = this.normalizeId(characterIdRaw, 'character_default');
        // 選択された method を特定（引数優先、次点は sortedCandidates[0] で shadow 除外後の winner を参照）
        const resolvedSelected = selectedMethod
            ?? (scoredCandidates.find((c) => c.candidate.method !== 'custom-separator') ?? scoredCandidates[0])?.candidate.method;

        for (const entry of scoredCandidates) {
            this.updateSeparationProfileForSuccess(
                characterId,
                entry.candidate.method,
                {
                    score: entry.score.score,
                    leakageCorrelation: entry.score.leakageCorrelation,
                    metrics: entry.vocalMetrics,
                },
                false,
            );
            // Phase 0: 全試行の KPI を JSONL に記録
            this.appendSeparationTrialLog(
                this.buildTrialLogEntry(characterId, entry, entry.candidate.method === resolvedSelected),
            );
        }
        this.persistSeparationProfiles();
    }

    private updateSeparationProfileForSuccess(
        characterIdRaw: string,
        method: SeparationMethod,
        observed?: {
            score?: number;
            leakageCorrelation?: number;
            metrics?: SeparationStemQualityMetrics;
        },
        persist: boolean = true,
    ): void {
        const profile = this.getOrCreateCharacterSeparationProfile(characterIdRaw);
        const methodProfile = profile.methods[method];
        const now = new Date().toISOString();
        const nextScore = this.clampNumber(
            Number(observed?.score),
            0,
            100,
            methodProfile.scoreEma,
        );
        methodProfile.scoreEma = this.clampNumber(
            this.ema(methodProfile.scoreEma, nextScore, 0.22),
            0,
            100,
            methodProfile.scoreEma,
        );
        if (typeof observed?.leakageCorrelation === 'number') {
            methodProfile.leakageEma = this.clampNumber(
                this.ema(methodProfile.leakageEma, observed.leakageCorrelation, 0.2),
                0,
                1,
                methodProfile.leakageEma,
            );
        }
        if (observed?.metrics) {
            methodProfile.speechActivityEma = this.clampNumber(
                this.ema(methodProfile.speechActivityEma, observed.metrics.speechActivityRatio, 0.2),
                0,
                1,
                methodProfile.speechActivityEma,
            );
            methodProfile.rmsDbEma = this.clampNumber(
                this.ema(methodProfile.rmsDbEma, observed.metrics.rmsDb, 0.2),
                -80,
                0,
                methodProfile.rmsDbEma,
            );
        }
        methodProfile.successCount += 1;
        methodProfile.updatedAt = now;
        profile.preferredMethod = this.resolvePreferredMethod(profile);
        profile.updatedAt = now;
        this.separationProfiles.set(profile.id, profile);
        this.separationProfilesDirty = true;
        if (persist) {
            this.persistSeparationProfiles();
        }
    }

    private updateSeparationProfileForFailures(
        characterIdRaw: string,
        methods: SeparationMethod[],
        failedTimings?: Map<SeparationMethod, number>,
    ): void {
        if (methods.length === 0) {
            return;
        }
        const characterId = this.normalizeId(characterIdRaw, 'character_default');
        const profile = this.getOrCreateCharacterSeparationProfile(characterId);
        const uniqueMethods = Array.from(new Set(methods));
        const now = new Date().toISOString();
        for (const method of uniqueMethods) {
            const methodProfile = profile.methods[method];
            methodProfile.failureCount += 1;
            methodProfile.scoreEma = this.clampNumber(
                this.ema(methodProfile.scoreEma, Math.max(0, methodProfile.scoreEma - 6), 0.12),
                0,
                100,
                methodProfile.scoreEma,
            );
            methodProfile.updatedAt = now;
            // Phase 0: 失敗試行もログに記録
            this.appendSeparationTrialLog({
                timestamp: now,
                characterId,
                method,
                processingTimeMs: failedTimings?.get(method) ?? 0,
                success: false,
                wasSelected: false,
                finalScore: null,
                baseScore: null,
                stemScore: null,
                leakageCorrelation: null,
                lowBandResidualRatio: null,
                highBandRoughness: null,
                speechActivityRatio: null,
                silenceRatio: null,
                rmsDb: null,
                artifactScore: null,
                reverbTailRatio: null,
                normalizedError: null,
                isTrainingCandidate: false,
            });
        }
        profile.preferredMethod = this.resolvePreferredMethod(profile);
        profile.updatedAt = now;
        this.separationProfilesDirty = true;
        this.persistSeparationProfiles();
    }

    private normalizeSeparationPreference(value: string | undefined): SeparationPreference {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'uvr-ultimate' || normalized === 'roformer' || normalized === 'demucs' || normalized === 'uvr5' || normalized === 'ffmpeg-fallback' || normalized === 'custom-separator') {
            return normalized;
        }
        return 'auto';
    }

    private normalizeExportPresets(
        presets: readonly SingingLearningExportPreset[] | undefined,
    ): SingingLearningExportPreset[] {
        const normalized: SingingLearningExportPreset[] = [];
        for (const preset of presets || []) {
            if (preset === 'training_bright' || preset === 'remix_clear') {
                if (!normalized.includes(preset)) {
                    normalized.push(preset);
                }
            }
        }
        return normalized;
    }

    private buildSeparationPlan(preference: SeparationPreference, characterId: string): SeparationMethod[] {
        const coreMethods: SeparationMethod[] = ['uvr-ultimate', 'roformer', 'demucs', 'uvr5', 'ffmpeg-fallback'];
        // shadow / limited-auto 時は custom-separator を候補リストに追加
        const allMethods: SeparationMethod[] = this.customSeparatorMode !== 'disabled'
            ? [...coreMethods, 'custom-separator']
            : coreMethods;
        if (preference === 'auto') {
            const profile = this.getOrCreateCharacterSeparationProfile(characterId);
            const baselineBias: Record<SeparationMethod, number> = {
                'uvr-ultimate': 2.5,
                roformer: 3,
                demucs: 2,
                uvr5: 1,
                'ffmpeg-fallback': -10,
                // shadow: 評価・ログのみ、winner 選択は selectBest で除外。limited-auto: 既存と競合参加
                'custom-separator': this.customSeparatorMode === 'limited-auto' ? 2.0 : -999,
            };
            return [...allMethods].sort((a, b) => {
                const aMethod = profile.methods[a];
                const bMethod = profile.methods[b];
                const aAttempts = aMethod.successCount + aMethod.failureCount;
                const bAttempts = bMethod.successCount + bMethod.failureCount;
                const aSuccessRate = (aMethod.successCount + 1) / (aAttempts + 2);
                const bSuccessRate = (bMethod.successCount + 1) / (bAttempts + 2);
                const aPriority = aMethod.scoreEma + (aSuccessRate - 0.5) * 8 + baselineBias[a];
                const bPriority = bMethod.scoreEma + (bSuccessRate - 0.5) * 8 + baselineBias[b];
                return bPriority - aPriority;
            });
        }
        return [preference, ...allMethods.filter((method) => method !== preference)];
    }

    private buildEnhancementAlternativeCandidates(
        primaryCandidate: SeparationQualityCandidate,
        scoredCandidates: ScoredSeparationCandidate[],
    ): SeparationQualityCandidate[] {
        if (scoredCandidates.length <= 1) {
            return [];
        }

        const primaryPath = path.resolve(primaryCandidate.vocalWavPath);
        const alternatives = scoredCandidates
            .filter((entry) => path.resolve(entry.candidate.vocalWavPath) !== primaryPath)
            .sort((a, b) => {
                const affinityDiff = this.getEnsembleComplementPriority(primaryCandidate.method, b.candidate.method)
                    - this.getEnsembleComplementPriority(primaryCandidate.method, a.candidate.method);
                if (affinityDiff !== 0) {
                    return affinityDiff;
                }

                const accompanimentDiff = Number(Boolean(b.candidate.accompanimentWavPath))
                    - Number(Boolean(a.candidate.accompanimentWavPath));
                if (accompanimentDiff !== 0) {
                    return accompanimentDiff;
                }

                const finalScoreDiff = b.finalScore - a.finalScore;
                if (Math.abs(finalScoreDiff) > 0.15) {
                    return finalScoreDiff;
                }

                const artifactDiff = a.perceptualMetrics.artifactScore - b.perceptualMetrics.artifactScore;
                if (Math.abs(artifactDiff) > 0.025) {
                    return artifactDiff;
                }

                const reverbDiff = a.perceptualMetrics.reverbTailRatio - b.perceptualMetrics.reverbTailRatio;
                if (Math.abs(reverbDiff) > 0.03) {
                    return reverbDiff;
                }

                const aLeak = typeof a.score.leakageCorrelation === 'number' ? a.score.leakageCorrelation : 0.999;
                const bLeak = typeof b.score.leakageCorrelation === 'number' ? b.score.leakageCorrelation : 0.999;
                const leakDiff = aLeak - bLeak;
                if (Math.abs(leakDiff) > 0.002) {
                    return leakDiff;
                }

                return a.vocalMetrics.lowBandRatio - b.vocalMetrics.lowBandRatio;
            });

        return alternatives.map((entry) => entry.candidate).slice(0, 3);
    }

    private getEnsembleComplementPriority(primaryMethod: SeparationMethod, alternativeMethod: SeparationMethod): number {
        if (primaryMethod === alternativeMethod) {
            return -10;
        }
        if ((primaryMethod === 'roformer' && alternativeMethod === 'demucs')
            || (primaryMethod === 'demucs' && alternativeMethod === 'roformer')) {
            return 10;
        }
        if (primaryMethod === 'uvr-ultimate' && alternativeMethod === 'roformer') {
            return 8;
        }
        if (primaryMethod === 'roformer' && alternativeMethod === 'uvr-ultimate') {
            return 7;
        }
        if (primaryMethod === 'uvr-ultimate' && alternativeMethod === 'demucs') {
            return 6;
        }
        if (primaryMethod === 'demucs' && alternativeMethod === 'uvr-ultimate') {
            return 5;
        }
        if (alternativeMethod === 'uvr5') {
            return 2;
        }
        if (alternativeMethod === 'ffmpeg-fallback') {
            return -4;
        }
        return 0;
    }

    private shouldAdoptVocalEnsemble(
        primaryMethod: SeparationMethod | undefined,
        alternativeMethod: SeparationMethod,
        beforeMetrics: SeparationStemQualityMetrics,
        afterMetrics: SeparationStemQualityMetrics,
        beforeScore: SeparationStemQualityScore,
        afterScore: SeparationStemQualityScore,
        beforeLeak: number,
        afterLeak: number,
        beforeLowBandLeak: number,
        afterLowBandLeak: number,
        beforeHighRoughness: number,
        afterHighRoughness: number,
    ): boolean {
        const pairPriority = primaryMethod
            ? this.getEnsembleComplementPriority(primaryMethod, alternativeMethod)
            : 0;
        const scoreGain = afterScore.score - beforeScore.score;
        const scoreDrop = beforeScore.score - afterScore.score;
        const leakImproved = beforeLeak - afterLeak;
        const leakWorsened = afterLeak - beforeLeak;
        const lowBandLeakImproved = beforeLowBandLeak - afterLowBandLeak;
        const lowBandLeakWorsened = afterLowBandLeak - beforeLowBandLeak;
        const lowImproved = beforeMetrics.lowBandRatio - afterMetrics.lowBandRatio;
        const lowWorsened = afterMetrics.lowBandRatio - beforeMetrics.lowBandRatio;
        const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
        const silenceRise = afterMetrics.silenceRatio - beforeMetrics.silenceRatio;
        const highRoughDelta = afterHighRoughness - beforeHighRoughness;
        const regressionSafe = (
            scoreDrop <= (pairPriority >= 8 ? 2.0 : 1.6)
            && speechDrop <= (pairPriority >= 8 ? 0.03 : 0.022)
            && silenceRise <= (pairPriority >= 8 ? 0.055 : 0.045)
            && lowWorsened <= 0.04
            && leakWorsened <= (pairPriority >= 8 ? 0.010 : 0.006)
            && lowBandLeakWorsened <= (pairPriority >= 8 ? 0.008 : 0.005)
            && highRoughDelta <= Math.max(0.00035, beforeHighRoughness * (pairPriority >= 8 ? 0.16 : 0.12))
        );
        if (!regressionSafe) {
            return false;
        }

        return (
            scoreGain >= (pairPriority >= 8 ? 0.45 : 0.8)
            || leakImproved >= (pairPriority >= 8 ? 0.012 : 0.018)
            || lowBandLeakImproved >= (pairPriority >= 8 ? 0.010 : 0.014)
            || (lowImproved >= 0.014 && highRoughDelta <= 0.00018 && speechDrop <= 0.020)
            || (
                pairPriority >= 8
                && scoreGain >= -0.20
                && leakImproved >= 0.010
                && lowImproved >= 0.010
                && lowBandLeakImproved >= 0.006
            )
        );
    }

    private buildDialogueFastAutoSeparationPlan(autoPlan: SeparationMethod[]): SeparationMethod[] {
        // Dialogue clip extraction favors responsiveness over exhaustive separator comparison.
        // Skip UVR Ultimate in auto mode (heavy install/import path) and try at most two practical separators first.
        const preferred = autoPlan.filter((method) => method !== 'uvr-ultimate' && method !== 'ffmpeg-fallback');
        const shortlist = preferred.slice(0, 2);
        if (shortlist.length > 0) {
            return shortlist;
        }
        const fallbackOnly = autoPlan.find((method) => method === 'ffmpeg-fallback');
        return fallbackOnly ? [fallbackOnly] : autoPlan.filter((method) => method !== 'uvr-ultimate');
    }

    private async runSeparationByMethod(
        method: SeparationMethod,
        sourceAudioPath: string,
        vocalDir: string,
        accompanimentDir: string,
    ): Promise<{
        success: boolean;
        method?: SeparationMethod;
        vocalWavPath?: string;
        accompanimentWavPath?: string;
        processingTimeMs: number;
        warning?: string;
        error?: string;
    }> {
        const t0 = Date.now();
        if (method === 'custom-separator') {
            const r = await this.trySeparateWithCustomSeparator(sourceAudioPath, vocalDir, accompanimentDir);
            return { ...r, processingTimeMs: Date.now() - t0 };
        }
        if (method === 'uvr-ultimate') {
            const r = await this.trySeparateWithUvrUltimate(sourceAudioPath, vocalDir, accompanimentDir);
            return { ...r, processingTimeMs: Date.now() - t0 };
        }
        if (method === 'roformer') {
            const r = await this.trySeparateWithRoformer(sourceAudioPath, vocalDir, accompanimentDir);
            return { ...r, processingTimeMs: Date.now() - t0 };
        }
        if (method === 'demucs') {
            const r = await this.trySeparateWithDemucs(sourceAudioPath, vocalDir, accompanimentDir);
            return { ...r, processingTimeMs: Date.now() - t0 };
        }
        if (method === 'uvr5') {
            const r = await this.trySeparateWithUvr(sourceAudioPath, vocalDir, accompanimentDir);
            return { ...r, processingTimeMs: Date.now() - t0 };
        }
        const r = await this.trySeparateWithFfmpegFallback(sourceAudioPath, vocalDir, accompanimentDir);
        return { ...r, processingTimeMs: Date.now() - t0 };
    }

    private async selectBestSeparationCandidate(
        candidates: SeparationQualityCandidate[],
        runDir: string,
        characterId: string,
        sourceAudioPath?: string,
    ): Promise<{ candidate: SeparationQualityCandidate; warning?: string; scoredCandidates?: ScoredSeparationCandidate[] }> {
        if (candidates.length === 0) {
            throw new Error('No successful separation candidates to score.');
        }
        if (candidates.length <= 1) {
            return {
                candidate: candidates[0],
                warning: candidates[0]?.warning,
                scoredCandidates: [],
            };
        }

        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            const fallback = candidates[0];
            return {
                candidate: fallback,
                warning: [
                    fallback.warning,
                    'Candidate quality analysis skipped because ffmpeg was unavailable.',
                    ffmpegTools.error,
                ].filter(Boolean).join(' '),
                scoredCandidates: [],
            };
        }

        const analysisDir = path.join(runDir, 'analysis');
        fs.mkdirSync(analysisDir, { recursive: true });
        const analysisWarnings: string[] = [];
        const dnsmosRuntime = await this.resolveDnsmosRuntime();
        if (!dnsmosRuntime.success && dnsmosRuntime.error) {
            analysisWarnings.push(`dnsmos_unavailable(${dnsmosRuntime.error})`);
        } else if (dnsmosRuntime.warning) {
            analysisWarnings.push(dnsmosRuntime.warning);
        }
        let mixtureAnalysisPath: string | undefined;
        const sourcePath = String(sourceAudioPath || '').trim();
        if (sourcePath && fs.existsSync(sourcePath)) {
            const mixPath = path.join(analysisDir, 'mixture_source_mono16.wav');
            const mixPrepared = await this.renderAnalysisMonoPcm16(ffmpegTools.ffmpegPath, sourcePath, mixPath);
            if (mixPrepared && fs.existsSync(mixPath)) {
                mixtureAnalysisPath = mixPath;
            } else {
                analysisWarnings.push('mixture_analysis_preprocess_failed');
            }
        }

        const scoredCandidates: ScoredSeparationCandidate[] = [];
        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            const vocalAnalysisPath = path.join(analysisDir, `candidate_${index + 1}_${candidate.method}_vocal_mono16.wav`);
            const vocalPrepared = await this.renderAnalysisMonoPcm16(
                ffmpegTools.ffmpegPath,
                candidate.vocalWavPath,
                vocalAnalysisPath,
            );
            if (!vocalPrepared) {
                analysisWarnings.push(`analysis_preprocess_failed(${candidate.method})`);
                continue;
            }

            try {
                const vocalMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(vocalAnalysisPath);
                const perceptualMetrics = SeparationQualityLibrary.analyzePerceptualQualityMonoPcm16Wav(vocalAnalysisPath);
                let dnsmos: DnsmosInferenceResult | undefined;
                let leakageCorrelation: number | undefined;
                let accompanimentAnalysisPath: string | undefined;
                if (candidate.accompanimentWavPath && fs.existsSync(candidate.accompanimentWavPath)) {
                    accompanimentAnalysisPath = path.join(
                        analysisDir,
                        `candidate_${index + 1}_${candidate.method}_accompaniment_mono16.wav`,
                    );
                    const accompanimentPrepared = await this.renderAnalysisMonoPcm16(
                        ffmpegTools.ffmpegPath,
                        candidate.accompanimentWavPath,
                        accompanimentAnalysisPath,
                    );
                    if (accompanimentPrepared && accompanimentAnalysisPath && fs.existsSync(accompanimentAnalysisPath)) {
                        leakageCorrelation = SeparationQualityLibrary.estimateLeakageCorrelation(
                            vocalAnalysisPath,
                            accompanimentAnalysisPath,
                        );
                    } else {
                        accompanimentAnalysisPath = undefined;
                    }
                }
                if (dnsmosRuntime.success) {
                    const dnsmosInputPath = path.join(analysisDir, `candidate_${index + 1}_${candidate.method}_vocal_dnsmos.wav`);
                    const dnsmosPrepared = await this.renderDnsmosInputMonoPcm16(
                        ffmpegTools.ffmpegPath,
                        candidate.vocalWavPath,
                        dnsmosInputPath,
                    );
                    if (dnsmosPrepared && fs.existsSync(dnsmosInputPath)) {
                        const dnsmosResult = await this.computeDnsmosForWav(dnsmosInputPath, dnsmosRuntime);
                        if (dnsmosResult.success && dnsmosResult.result) {
                            dnsmos = dnsmosResult.result;
                            if (dnsmosResult.warning) {
                                analysisWarnings.push(dnsmosResult.warning);
                            }
                        } else if (dnsmosResult.error) {
                            analysisWarnings.push(`dnsmos_failed(${candidate.method}): ${dnsmosResult.error}`);
                        }
                    } else {
                        analysisWarnings.push(`dnsmos_preprocess_failed(${candidate.method})`);
                    }
                }
                const score = SeparationQualityLibrary.scoreFromMetrics(vocalMetrics, leakageCorrelation);
                const prior = this.getMethodPriorScore(characterId, candidate.method);
                let mixtureConsistency: SeparationMixtureConsistencyEstimate | undefined;
                if (mixtureAnalysisPath && accompanimentAnalysisPath) {
                    try {
                        mixtureConsistency = SeparationQualityLibrary.estimateMixtureConsistencyMonoPcm16Wav(
                            mixtureAnalysisPath,
                            vocalAnalysisPath,
                            accompanimentAnalysisPath,
                        );
                    } catch (mixError) {
                        analysisWarnings.push(
                            `mixture_consistency_failed(${candidate.method}): ${mixError instanceof Error ? mixError.message : String(mixError)}`,
                        );
                    }
                }

                let mixAdjustment = 0;
                if (mixtureConsistency) {
                    if (mixtureConsistency.normalizedError > 0.035) {
                        mixAdjustment -= Math.min(18, (mixtureConsistency.normalizedError - 0.035) * 85);
                    } else {
                        mixAdjustment += Math.min(2.2, (0.035 - mixtureConsistency.normalizedError) * 36);
                    }
                    if (mixtureConsistency.lowBandResidualRatio > 0.22) {
                        mixAdjustment -= Math.min(10, (mixtureConsistency.lowBandResidualRatio - 0.22) * 18);
                    } else {
                        mixAdjustment += Math.min(1.5, (0.22 - mixtureConsistency.lowBandResidualRatio) * 10);
                    }
                    if (mixtureConsistency.sumCorrelation < 0.985) {
                        mixAdjustment -= Math.min(6, (0.985 - mixtureConsistency.sumCorrelation) * 45);
                    }
                }

                const baseScore = this.clampNumber(score.score + prior + mixAdjustment, 0, 100, score.score);
                scoredCandidates.push({
                    candidate,
                    score,
                    vocalMetrics,
                    perceptualMetrics,
                    dnsmos,
                    mixtureConsistency,
                    baseScore,
                    priorAdjustment: prior,
                    mixAdjustment,
                    perceptualAdjustment: 0,
                    dnsmosAdjustment: 0,
                    preservationAdjustment: 0,
                    finalScore: baseScore,
                });
            } catch (error) {
                analysisWarnings.push(
                    `quality_analysis_failed(${candidate.method}): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        if (scoredCandidates.length === 0) {
            const fallback = candidates[0];
            return {
                candidate: fallback,
                warning: [
                    fallback.warning,
                    ffmpegTools.warning,
                    'Candidate quality analysis failed; kept first successful separator.',
                    analysisWarnings.length > 0 ? `Details: ${analysisWarnings.slice(0, 2).join(' | ')}` : undefined,
                ].filter(Boolean).join(' '),
                scoredCandidates: [],
            };
        }

        for (const entry of scoredCandidates) {
            entry.perceptualAdjustment = this.calculatePerceptualAdjustment(entry, scoredCandidates);
            entry.dnsmosAdjustment = this.calculateDnsmosAdjustment(entry, scoredCandidates);
            entry.preservationAdjustment = this.calculateVocalPreservationAdjustment(entry, scoredCandidates);
            entry.finalScore = this.clampNumber(
                entry.baseScore + entry.perceptualAdjustment + entry.dnsmosAdjustment + entry.preservationAdjustment,
                0,
                100,
                entry.baseScore,
            );
        }

        scoredCandidates.sort((a, b) => {
            const finalScoreDiff = b.finalScore - a.finalScore;
            if (Math.abs(finalScoreDiff) > 0.25) {
                return finalScoreDiff;
            }

            const aMixErr = a.mixtureConsistency?.normalizedError ?? 9;
            const bMixErr = b.mixtureConsistency?.normalizedError ?? 9;
            const mixErrDiff = aMixErr - bMixErr; // lower is better
            if (Math.abs(mixErrDiff) > 0.0025) {
                return mixErrDiff;
            }

            const aMixLow = a.mixtureConsistency?.lowBandResidualRatio ?? 9;
            const bMixLow = b.mixtureConsistency?.lowBandResidualRatio ?? 9;
            const mixLowDiff = aMixLow - bMixLow; // lower is better
            if (Math.abs(mixLowDiff) > 0.015) {
                return mixLowDiff;
            }

            // Quality ranking often saturates at 100.00 for both demucs/uvr5.
            // In that case, prefer lower bleed/leakage and lower low-band residue (bass bleed).
            const aLeak = typeof a.score.leakageCorrelation === 'number' ? a.score.leakageCorrelation : 0.999;
            const bLeak = typeof b.score.leakageCorrelation === 'number' ? b.score.leakageCorrelation : 0.999;
            const leakDiff = aLeak - bLeak; // lower is better
            if (Math.abs(leakDiff) > 0.002) {
                return leakDiff;
            }

            const lowBandDiff = a.vocalMetrics.lowBandRatio - b.vocalMetrics.lowBandRatio; // lower is better for bleed
            if (Math.abs(lowBandDiff) > 0.01) {
                return lowBandDiff;
            }

            const highBandDiff = a.vocalMetrics.highBandRatio - b.vocalMetrics.highBandRatio; // lower hiss/artifacts preferred
            if (Math.abs(highBandDiff) > 0.015) {
                return highBandDiff;
            }

            const artifactDiff = a.perceptualMetrics.artifactScore - b.perceptualMetrics.artifactScore; // lower is better
            if (Math.abs(artifactDiff) > 0.02) {
                return artifactDiff;
            }

            const reverbDiff = a.perceptualMetrics.reverbTailRatio - b.perceptualMetrics.reverbTailRatio; // lower is better
            if (Math.abs(reverbDiff) > 0.025) {
                return reverbDiff;
            }

            // Prefer stronger vocal activity if everything else is similar.
            const speechDiff = b.vocalMetrics.speechActivityRatio - a.vocalMetrics.speechActivityRatio;
            if (Math.abs(speechDiff) > 0.02) {
                return speechDiff;
            }

            return finalScoreDiff;
        });
        // Phase 3 shadow モード: custom-separator をスコアリングするが winner 選択から除外
        const winnableCandidates = this.customSeparatorMode === 'shadow'
            ? scoredCandidates.filter((c) => c.candidate.method !== 'custom-separator')
            : scoredCandidates;
        const best = (winnableCandidates.length > 0 ? winnableCandidates : scoredCandidates)[0];
        const ranking = scoredCandidates
            .map((entry) => `${entry.candidate.method}:${entry.finalScore.toFixed(2)}(raw=${entry.score.score.toFixed(2)},mixAdj=${entry.mixAdjustment.toFixed(2)},percAdj=${entry.perceptualAdjustment.toFixed(2)},dnsAdj=${entry.dnsmosAdjustment.toFixed(2)},presAdj=${entry.preservationAdjustment.toFixed(2)},leak=${(entry.score.leakageCorrelation ?? 0).toFixed(3)},reverb=${entry.perceptualMetrics.reverbTailRatio.toFixed(3)},artifact=${entry.perceptualMetrics.artifactScore.toFixed(3)},flux=${entry.perceptualMetrics.highBandFluxVariance.toFixed(4)},low=${entry.vocalMetrics.lowBandRatio.toFixed(2)},mx=${entry.mixtureConsistency?.normalizedError?.toFixed(3) ?? 'n/a'},mlx=${entry.mixtureConsistency?.lowBandResidualRatio?.toFixed(3) ?? 'n/a'},speech=${entry.vocalMetrics.speechActivityRatio.toFixed(2)},sil=${entry.vocalMetrics.silenceRatio.toFixed(2)},dnsmos=${entry.dnsmos ? `${entry.dnsmos.ovrl.toFixed(2)}/${entry.dnsmos.sig.toFixed(2)}/${entry.dnsmos.p808.toFixed(2)}` : 'n/a'})`)
            .join(', ');
        const second = scoredCandidates[1];
        const tieBreakUsed = !!second && Math.abs(best.finalScore - second.finalScore) <= 0.25;
        const scoreDetail = `Selected ${best.candidate.method} by automatic quality ranking (score=${best.finalScore.toFixed(2)}, raw=${best.score.score.toFixed(2)}, mixAdj=${best.mixAdjustment.toFixed(2)}, perceptualAdj=${best.perceptualAdjustment.toFixed(2)}, dnsAdj=${best.dnsmosAdjustment.toFixed(2)}, preserveAdj=${best.preservationAdjustment.toFixed(2)}, leak=${(best.score.leakageCorrelation ?? 0).toFixed(3)}, reverb=${best.perceptualMetrics.reverbTailRatio.toFixed(3)}, artifact=${best.perceptualMetrics.artifactScore.toFixed(3)}, flux=${best.perceptualMetrics.highBandFluxVariance.toFixed(4)}, low=${best.vocalMetrics.lowBandRatio.toFixed(2)}, mixErr=${best.mixtureConsistency?.normalizedError?.toFixed(3) ?? 'n/a'}, lowMixErr=${best.mixtureConsistency?.lowBandResidualRatio?.toFixed(3) ?? 'n/a'}, rms=${best.vocalMetrics.rmsDb.toFixed(2)}dB, speech=${best.vocalMetrics.speechActivityRatio.toFixed(2)}, silence=${best.vocalMetrics.silenceRatio.toFixed(2)}, dnsmos=${best.dnsmos ? `${best.dnsmos.ovrl.toFixed(2)}/${best.dnsmos.sig.toFixed(2)}/${best.dnsmos.p808.toFixed(2)}` : 'n/a'}${tieBreakUsed ? ', tie-break=mix/leak/bleed/perceptual' : ''}).`;

        return {
            candidate: best.candidate,
            warning: [
                best.candidate.warning,
                ffmpegTools.warning,
                scoreDetail,
                `Ranking: ${ranking}.`,
                analysisWarnings.length > 0 ? `Analyzer warnings: ${analysisWarnings.slice(0, 2).join(' | ')}` : undefined,
            ].filter(Boolean).join(' '),
            scoredCandidates,
        };
    }

    private async renderAnalysisMonoPcm16(
        ffmpegPath: string,
        inputPath: string,
        outputPath: string,
    ): Promise<boolean> {
        const convert = await this.runCommand(ffmpegPath, [
            '-y',
            '-i', inputPath,
            '-vn',
            '-ac', '1',
            '-ar', '22050',
            '-c:a', 'pcm_s16le',
            '-t', '120',
            outputPath,
        ], { timeoutMs: 20 * 60 * 1000 });
        return convert.success && fs.existsSync(outputPath);
    }

    private async renderDnsmosInputMonoPcm16(
        ffmpegPath: string,
        inputPath: string,
        outputPath: string,
    ): Promise<boolean> {
        const convert = await this.runCommand(ffmpegPath, [
            '-y',
            '-i', inputPath,
            '-vn',
            '-ac', '1',
            '-ar', '16000',
            '-c:a', 'pcm_s16le',
            '-t', '120',
            outputPath,
        ], { timeoutMs: 20 * 60 * 1000 });
        return convert.success && fs.existsSync(outputPath);
    }

    private getComparisonExportConfig(preset: SingingLearningExportPreset): {
        filter: string;
        speechDropLimit: number;
        roughnessRiseLimit: number;
        silenceRiseLimit?: number;
        leakageRiseLimit?: number;
    } {
        if (preset === 'training_bright') {
            return {
                filter: 'highshelf=f=9000:g=1.5:t=q:w=0.8,alimiter=limit=0.98',
                speechDropLimit: 0.01,
                roughnessRiseLimit: 0.0005,
                silenceRiseLimit: 0.02,
            };
        }
        return {
            filter: 'highshelf=f=10000:g=2.0:t=q:w=0.8,equalizer=f=2200:t=q:w=1.0:g=1.0,dynaudnorm=f=250:g=7:p=0.95:m=6,alimiter=limit=0.98',
            speechDropLimit: 0.015,
            roughnessRiseLimit: 0.0008,
            leakageRiseLimit: 0.015,
        };
    }

    private removeFileIfExists(filePath: string | undefined): void {
        if (!filePath) {
            return;
        }
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch {
            // Ignore cleanup failures.
        }
    }

    private async analyzeComparisonExportWav(params: {
        ffmpegPath: string;
        inputPath: string;
        analysisPath: string;
        accompanimentAnalysisPath?: string;
    }): Promise<{
        success: boolean;
        metrics?: SeparationStemQualityMetrics;
        roughness?: number;
        leakageCorrelation?: number;
        error?: string;
    }> {
        const prepared = await this.renderAnalysisMonoPcm16(
            params.ffmpegPath,
            params.inputPath,
            params.analysisPath,
        );
        if (!prepared || !fs.existsSync(params.analysisPath)) {
            return {
                success: false,
                error: 'analysis preprocess failed',
            };
        }

        const metrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(params.analysisPath);
        const roughness = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(params.analysisPath);
        const leakageCorrelation = params.accompanimentAnalysisPath && fs.existsSync(params.accompanimentAnalysisPath)
            ? SeparationQualityLibrary.estimateLeakageCorrelation(params.analysisPath, params.accompanimentAnalysisPath)
            : undefined;

        return {
            success: true,
            metrics,
            roughness,
            leakageCorrelation,
        };
    }

    private async renderComparisonExports(params: {
        runDir: string;
        canonicalVocalWavPath: string;
        accompanimentWavPath?: string;
        presets: SingingLearningExportPreset[];
    }): Promise<{
        exports: SingingLearningComparisonExportResult[];
        warning?: string;
    }> {
        const presets = this.normalizeExportPresets(params.presets);
        if (presets.length === 0) {
            return { exports: [] };
        }

        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            return {
                exports: [],
                warning: ffmpegTools.error
                    ? `Comparison export skipped: ffmpeg unavailable (${ffmpegTools.error}).`
                    : 'Comparison export skipped: ffmpeg unavailable.',
            };
        }

        const enhancedDir = path.join(params.runDir, 'enhanced');
        const analysisDir = path.join(params.runDir, 'analysis');
        fs.mkdirSync(enhancedDir, { recursive: true });
        fs.mkdirSync(analysisDir, { recursive: true });

        const analysisStamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        const canonicalAnalysisPath = path.join(analysisDir, `comparison_canonical_${analysisStamp}.wav`);
        let accompanimentAnalysisPath: string | undefined;
        const warnings: string[] = [];
        const exports: SingingLearningComparisonExportResult[] = [];

        const canonicalAnalysis = await this.analyzeComparisonExportWav({
            ffmpegPath: ffmpegTools.ffmpegPath,
            inputPath: params.canonicalVocalWavPath,
            analysisPath: canonicalAnalysisPath,
        });
        if (!canonicalAnalysis.success || !canonicalAnalysis.metrics || typeof canonicalAnalysis.roughness !== 'number') {
            return {
                exports: [],
                warning: `Comparison export skipped: canonical analysis failed (${canonicalAnalysis.error || 'unknown error'}).`,
            };
        }

        if (params.accompanimentWavPath && fs.existsSync(params.accompanimentWavPath)) {
            accompanimentAnalysisPath = path.join(analysisDir, `comparison_accompaniment_${analysisStamp}.wav`);
            const accompanimentPrepared = await this.renderAnalysisMonoPcm16(
                ffmpegTools.ffmpegPath,
                params.accompanimentWavPath,
                accompanimentAnalysisPath,
            );
            if (!accompanimentPrepared || !fs.existsSync(accompanimentAnalysisPath)) {
                accompanimentAnalysisPath = undefined;
                warnings.push('Comparison export leak guard skipped because accompaniment analysis failed.');
            }
        }

        const canonicalLeakage = accompanimentAnalysisPath
            ? SeparationQualityLibrary.estimateLeakageCorrelation(canonicalAnalysisPath, accompanimentAnalysisPath)
            : undefined;

        for (const preset of presets) {
            const config = this.getComparisonExportConfig(preset);
            const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
            const outputPath = path.join(enhancedDir, `vocal_${preset}_${stamp}.wav`);
            const outputAnalysisPath = path.join(analysisDir, `comparison_${preset}_${stamp}.wav`);
            const render = await this.runCommand(ffmpegTools.ffmpegPath, [
                '-y',
                '-i', params.canonicalVocalWavPath,
                '-vn',
                '-af', config.filter,
                '-c:a', 'pcm_s16le',
                outputPath,
            ], {
                timeoutMs: 20 * 60 * 1000,
                env: this.buildEnvWithAdditionalPath(path.dirname(ffmpegTools.ffmpegPath)),
            });

            if (!render.success || !fs.existsSync(outputPath)) {
                this.removeFileIfExists(outputPath);
                warnings.push(`Comparison export skipped (${preset}: ffmpeg filter failed ${this.takeTail(render.stderr || render.stdout, 220) || 'unknown error'}).`);
                continue;
            }

            const outputAnalysis = await this.analyzeComparisonExportWav({
                ffmpegPath: ffmpegTools.ffmpegPath,
                inputPath: outputPath,
                analysisPath: outputAnalysisPath,
                accompanimentAnalysisPath,
            });
            if (!outputAnalysis.success || !outputAnalysis.metrics || typeof outputAnalysis.roughness !== 'number') {
                this.removeFileIfExists(outputPath);
                warnings.push(`Comparison export skipped (${preset}: ${outputAnalysis.error || 'analysis failed'}).`);
                continue;
            }

            const speechDrop = canonicalAnalysis.metrics.speechActivityRatio - outputAnalysis.metrics.speechActivityRatio;
            const silenceRise = outputAnalysis.metrics.silenceRatio - canonicalAnalysis.metrics.silenceRatio;
            const roughnessRise = outputAnalysis.roughness - canonicalAnalysis.roughness;
            const leakageRise = typeof outputAnalysis.leakageCorrelation === 'number' && typeof canonicalLeakage === 'number'
                ? outputAnalysis.leakageCorrelation - canonicalLeakage
                : undefined;

            let rejectReason: string | undefined;
            if (speechDrop > config.speechDropLimit) {
                rejectReason = `speech regression exceeded threshold (${speechDrop.toFixed(4)}>${config.speechDropLimit.toFixed(4)})`;
            } else if (typeof config.silenceRiseLimit === 'number' && silenceRise > config.silenceRiseLimit) {
                rejectReason = `silence regression exceeded threshold (${silenceRise.toFixed(4)}>${config.silenceRiseLimit.toFixed(4)})`;
            } else if (roughnessRise > config.roughnessRiseLimit) {
                rejectReason = `roughness regression exceeded threshold (${roughnessRise.toFixed(4)}>${config.roughnessRiseLimit.toFixed(4)})`;
            } else if (
                typeof config.leakageRiseLimit === 'number'
                && typeof leakageRise === 'number'
                && leakageRise > config.leakageRiseLimit
            ) {
                rejectReason = `leakage regression exceeded threshold (${leakageRise.toFixed(4)}>${config.leakageRiseLimit.toFixed(4)})`;
            }

            if (rejectReason) {
                this.removeFileIfExists(outputPath);
                warnings.push(`Comparison export skipped (${preset}: ${rejectReason}).`);
                continue;
            }

            const successWarning = [
                `Comparison export generated (${preset}, speech=${canonicalAnalysis.metrics.speechActivityRatio.toFixed(2)}->${outputAnalysis.metrics.speechActivityRatio.toFixed(2)}, rough=${canonicalAnalysis.roughness.toFixed(4)}->${outputAnalysis.roughness.toFixed(4)}`,
                typeof canonicalLeakage === 'number' && typeof outputAnalysis.leakageCorrelation === 'number'
                    ? `, leak=${canonicalLeakage.toFixed(3)}->${outputAnalysis.leakageCorrelation.toFixed(3)}`
                    : '',
                ').',
            ].join('');
            warnings.push(successWarning);
            exports.push({
                preset,
                wavPath: outputPath,
                warning: successWarning,
            });
        }

        return {
            exports,
            warning: [ffmpegTools.warning, ...warnings].filter(Boolean).join(' ') || undefined,
        };
    }

    private calculatePerceptualAdjustment(
        entry: Pick<ScoredSeparationCandidate, 'perceptualMetrics' | 'vocalMetrics' | 'score' | 'mixtureConsistency'>,
        scoredCandidates: Array<Pick<ScoredSeparationCandidate, 'perceptualMetrics' | 'vocalMetrics' | 'score' | 'mixtureConsistency'>>,
    ): number {
        if (scoredCandidates.length <= 1) {
            return 0;
        }

        const lowestArtifact = Math.min(...scoredCandidates.map((candidate) => candidate.perceptualMetrics.artifactScore));
        const lowestReverb = Math.min(...scoredCandidates.map((candidate) => candidate.perceptualMetrics.reverbTailRatio));
        const bestSpeech = Math.max(...scoredCandidates.map((candidate) => candidate.vocalMetrics.speechActivityRatio));
        const lowestLeak = Math.min(...scoredCandidates.map((candidate) => candidate.score.leakageCorrelation ?? 0.999));

        const artifact = entry.perceptualMetrics.artifactScore;
        const reverb = entry.perceptualMetrics.reverbTailRatio;
        const speech = entry.vocalMetrics.speechActivityRatio;
        const silence = entry.vocalMetrics.silenceRatio;
        const leak = entry.score.leakageCorrelation ?? 0.2;
        const mixErr = entry.mixtureConsistency?.normalizedError;

        const artifactGap = Math.max(0, artifact - lowestArtifact);
        const reverbGap = Math.max(0, reverb - lowestReverb);
        let penalty = 0;

        if (artifactGap > 0.04) {
            penalty += Math.min(12, (artifactGap - 0.04) * 26);
        }
        if (artifact > 0.36) {
            penalty += Math.min(8, (artifact - 0.36) * 18);
        }
        if (reverbGap > 0.05) {
            penalty += Math.min(10, (reverbGap - 0.05) * 24);
        }
        if (reverb > 0.24) {
            penalty += Math.min(6, (reverb - 0.24) * 16);
        }
        if (artifact > 0.46 && speech < Math.max(0.46, bestSpeech - 0.08)) {
            penalty += 4.5;
        }
        if (reverb > 0.28 && silence > 0.24) {
            penalty += 3.5;
        }
        if (
            typeof mixErr === 'number'
            && mixErr < 0.11
            && speech < 0.50
            && artifact > 0.34
        ) {
            penalty += 2.5;
        }

        let boost = 0;
        if (artifact <= lowestArtifact + 0.03) {
            boost += Math.min(3.2, Math.max(0, 0.30 - artifact) * 9);
        }
        if (reverb <= lowestReverb + 0.03) {
            boost += Math.min(2.8, Math.max(0, 0.20 - reverb) * 10);
        }
        if (artifact < 0.24 && reverb < 0.16) {
            boost += 1.5;
        }
        if (speech >= bestSpeech - 0.02 && leak <= lowestLeak + 0.015) {
            boost += 1.2;
        }

        return this.roundNumber(boost - penalty, 2);
    }

    private calculateDnsmosAdjustment(
        entry: Pick<ScoredSeparationCandidate, 'dnsmos' | 'vocalMetrics' | 'score'>,
        scoredCandidates: Array<Pick<ScoredSeparationCandidate, 'dnsmos' | 'vocalMetrics' | 'score'>>,
    ): number {
        if (!entry.dnsmos) {
            return 0;
        }

        const available = scoredCandidates.filter((candidate) => candidate.dnsmos);
        if (available.length <= 1) {
            return 0;
        }

        const bestOvrl = Math.max(...available.map((candidate) => candidate.dnsmos?.ovrl ?? 0));
        const bestSig = Math.max(...available.map((candidate) => candidate.dnsmos?.sig ?? 0));
        const bestP808 = Math.max(...available.map((candidate) => candidate.dnsmos?.p808 ?? 0));
        const ovrl = entry.dnsmos.ovrl;
        const sig = entry.dnsmos.sig;
        const p808 = entry.dnsmos.p808;
        const speech = entry.vocalMetrics.speechActivityRatio;
        const leak = entry.score.leakageCorrelation ?? 0.2;

        const ovrlGap = Math.max(0, bestOvrl - ovrl);
        const sigGap = Math.max(0, bestSig - sig);
        const p808Gap = Math.max(0, bestP808 - p808);

        let penalty = 0;
        if (ovrlGap > 0.16) {
            penalty += Math.min(4.8, (ovrlGap - 0.16) * 8.5);
        }
        if (sigGap > 0.16) {
            penalty += Math.min(4.8, (sigGap - 0.16) * 9.0);
        }
        if (p808Gap > 0.18) {
            penalty += Math.min(3.5, (p808Gap - 0.18) * 6.5);
        }
        if (ovrl < 2.55) {
            penalty += Math.min(3.5, (2.55 - ovrl) * 3.6);
        }
        if (sig < 2.65) {
            penalty += Math.min(3.8, (2.65 - sig) * 3.8);
        }

        let boost = 0;
        if (ovrl >= bestOvrl - 0.10) {
            boost += 1.2;
        }
        if (sig >= bestSig - 0.10) {
            boost += 1.4;
        }
        if (p808 >= bestP808 - 0.10) {
            boost += 0.8;
        }
        if (ovrl >= 3.0 && sig >= 3.0) {
            boost += 0.9;
        }
        if (speech >= 0.55 && leak <= 0.10 && ovrl >= 2.9) {
            boost += 0.6;
        }

        return this.roundNumber(boost - penalty, 2);
    }

    private calculateVocalPreservationAdjustment(
        entry: Pick<ScoredSeparationCandidate, 'score' | 'vocalMetrics' | 'mixtureConsistency'>,
        scoredCandidates: Array<Pick<ScoredSeparationCandidate, 'score' | 'vocalMetrics' | 'mixtureConsistency'>>,
    ): number {
        if (scoredCandidates.length <= 1) {
            return 0;
        }

        const bestSpeech = Math.max(...scoredCandidates.map((candidate) => candidate.vocalMetrics.speechActivityRatio));
        const lowestSilence = Math.min(...scoredCandidates.map((candidate) => candidate.vocalMetrics.silenceRatio));
        const bestRms = Math.max(...scoredCandidates.map((candidate) => candidate.vocalMetrics.rmsDb));

        // Only apply this guard when at least one candidate appears to preserve continuous singing reasonably well.
        if (bestSpeech < 0.48) {
            return 0;
        }

        const speech = entry.vocalMetrics.speechActivityRatio;
        const silence = entry.vocalMetrics.silenceRatio;
        const rmsDb = entry.vocalMetrics.rmsDb;
        const leak = typeof entry.score.leakageCorrelation === 'number' ? entry.score.leakageCorrelation : 0.2;
        const mixErr = entry.mixtureConsistency?.normalizedError;

        const speechGap = Math.max(0, bestSpeech - speech);
        const silenceGap = Math.max(0, silence - lowestSilence);
        const rmsGap = Math.max(0, bestRms - rmsDb);

        let penalty = 0;
        if (speechGap > 0.035) {
            penalty += Math.min(18, (speechGap - 0.035) * 82);
        }
        if (speech < 0.52) {
            penalty += Math.min(8, (0.52 - speech) * 34);
        }
        if (silenceGap > 0.035) {
            penalty += Math.min(10, (silenceGap - 0.035) * 34);
        }
        if (silence > 0.27) {
            penalty += Math.min(7, (silence - 0.27) * 24);
        }
        if (rmsGap > 1.3 && rmsDb < -19.2) {
            penalty += Math.min(8, (rmsGap - 1.3) * 2.6);
        }

        // Very low reconstruction error with weak speech often indicates over-suppression rather than clean extraction.
        if (
            typeof mixErr === 'number'
            && mixErr < 0.12
            && leak < 0.14
            && speech < 0.50
            && silence > 0.26
        ) {
            penalty += 6;
        }

        let boost = 0;
        if (speech >= bestSpeech - 0.015) {
            boost += Math.min(4, Math.max(0, 0.09 - leak) * 45);
        }
        if (silence <= lowestSilence + 0.02 && rmsDb >= bestRms - 1.0) {
            boost += 1.5;
        }

        return this.roundNumber(boost - penalty, 2);
    }

    private analyzeCanonicalQaMetrics(filePath: string): {
        stemMetrics: SeparationStemQualityMetrics;
        perceptualMetrics: SeparationPerceptualQualityMetrics;
    } {
        return {
            stemMetrics: SeparationQualityLibrary.analyzeMonoPcm16Wav(filePath),
            perceptualMetrics: SeparationQualityLibrary.analyzePerceptualQualityMonoPcm16Wav(filePath),
        };
    }

    private evaluateCanonicalQaSoftFail(metrics: {
        stemMetrics: SeparationStemQualityMetrics;
        perceptualMetrics: SeparationPerceptualQualityMetrics;
    }): { softFail: boolean; reason?: string } {
        const artifact = metrics.perceptualMetrics.artifactScore;
        const reverb = metrics.perceptualMetrics.reverbTailRatio;
        const speech = metrics.stemMetrics.speechActivityRatio;
        const silence = metrics.stemMetrics.silenceRatio;

        if (artifact > 0.62) {
            return { softFail: true, reason: `artifactScore=${artifact.toFixed(3)}` };
        }
        if (reverb > 0.34) {
            return { softFail: true, reason: `reverb=${reverb.toFixed(3)}` };
        }
        if (artifact > 0.48 && reverb > 0.24) {
            return { softFail: true, reason: `artifact/reverb=${artifact.toFixed(3)}/${reverb.toFixed(3)}` };
        }
        if (artifact > 0.44 && speech < 0.46 && silence > 0.24) {
            return { softFail: true, reason: `artifact/speech=${artifact.toFixed(3)}/${speech.toFixed(2)}` };
        }
        return { softFail: false };
    }

    private shouldAdoptCanonicalQaFallback(
        currentMetrics: {
            stemMetrics: SeparationStemQualityMetrics;
            perceptualMetrics: SeparationPerceptualQualityMetrics;
        },
        fallbackMetrics: {
            stemMetrics: SeparationStemQualityMetrics;
            perceptualMetrics: SeparationPerceptualQualityMetrics;
        },
    ): boolean {
        const speechDrop = currentMetrics.stemMetrics.speechActivityRatio - fallbackMetrics.stemMetrics.speechActivityRatio;
        const silenceRise = fallbackMetrics.stemMetrics.silenceRatio - currentMetrics.stemMetrics.silenceRatio;
        const artifactImprovement = currentMetrics.perceptualMetrics.artifactScore - fallbackMetrics.perceptualMetrics.artifactScore;
        const reverbImprovement = currentMetrics.perceptualMetrics.reverbTailRatio - fallbackMetrics.perceptualMetrics.reverbTailRatio;
        const roughnessImprovement = currentMetrics.perceptualMetrics.highBandRoughness - fallbackMetrics.perceptualMetrics.highBandRoughness;

        const regressionSafe = speechDrop <= 0.028 && silenceRise <= 0.045;
        if (!regressionSafe) {
            return false;
        }

        return (
            artifactImprovement >= 0.08
            || reverbImprovement >= 0.07
            || (artifactImprovement >= 0.05 && reverbImprovement >= 0.03)
            || (roughnessImprovement >= 0.0006 && artifactImprovement >= 0.03)
        );
    }

    private async renderCanonicalQaFallback(
        ffmpegPath: string,
        inputPath: string,
        outputPath: string,
        filters: string,
    ): Promise<boolean> {
        const render = await this.runCommand(ffmpegPath, [
            '-y',
            '-i', inputPath,
            '-vn',
            '-af', filters,
            '-ar', '44100',
            '-ac', '1',
            outputPath,
        ], {
            timeoutMs: 20 * 60 * 1000,
            env: this.buildEnvWithAdditionalPath(path.dirname(ffmpegPath)),
        });
        return render.success && fs.existsSync(outputPath);
    }

    private async copyToSbv2DatasetInput(characterId: string, vocalWavPath: string): Promise<string> {
        const sbv2 = Sbv2Service.getInstance(this.ttsResourcesPath);
        const pathsConfig = await sbv2.getPathsConfig();
        const datasetRootConfigured = String(pathsConfig.datasetRoot || 'Data').trim() || 'Data';
        const sbv2Root = path.join(this.sbv2InstallDir, 'sbv2');
        const datasetRootAbs = path.isAbsolute(datasetRootConfigured)
            ? datasetRootConfigured
            : path.join(sbv2Root, datasetRootConfigured);
        const datasetName = `${this.normalizeId(characterId, 'character_default')}_singing`;
        const inputDir = path.join(datasetRootAbs, datasetName, 'input');
        fs.mkdirSync(inputDir, { recursive: true });

        const filename = `${Date.now()}_${path.basename(vocalWavPath).replace(/[^a-zA-Z0-9_.-]+/g, '_')}`;
        const targetPath = path.join(inputDir, filename);
        fs.copyFileSync(vocalWavPath, targetPath);
        return targetPath;
    }

    private extractVideoId(url: string): string | null {
        // Matches v= in query string or youtu.be/ID shortlink
        const qMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (qMatch) return qMatch[1];
        const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
        return shortMatch ? shortMatch[1] : null;
    }

    private cleanYouTubeUrl(url: string): string {
        // Strip playlist/radio params so yt-dlp only downloads the single video.
        const id = this.extractVideoId(url);
        if (id) return `https://www.youtube.com/watch?v=${id}`;
        return url;
    }

    private buildMusicYouTubeUrl(url: string): string | null {
        const id = this.extractVideoId(url);
        if (!id) return null;
        return `https://music.youtube.com/watch?v=${id}`;
    }

    /**
     * Validates a Netscape cookies.txt file for YouTube Premium authentication.
     * Returns a warning string if critical cookies are missing or invalid.
     */
    private validateYouTubeCookiesFile(filePath: string): string | null {
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return `Cannot read cookies file: ${filePath}`;
        }

        // Parse Netscape cookie lines: domain\tflag\tpath\tsecure\texpiry\tname\tvalue
        const now = Math.floor(Date.now() / 1000);
        const cookieMap: Map<string, { domain: string; expiry: number }> = new Map();
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const parts = trimmed.split('\t');
            if (parts.length < 7) continue;
            const [domain, , , , expiryStr, name] = parts;
            const expiry = parseInt(expiryStr, 10);
            const existing = cookieMap.get(name);
            // Prefer .youtube.com (shared) over subdomain-specific entries
            if (!existing || domain.startsWith('.')) {
                cookieMap.set(name, { domain, expiry });
            }
        }

        const issues: string[] = [];

        // Check critical YouTube Premium auth cookies
        const required = ['SAPISID', 'SID', '__Secure-3PSID'];
        const missing = required.filter((name) => !cookieMap.has(name));
        if (missing.length > 0) {
            issues.push(`Missing required cookies: ${missing.join(', ')}`);
        }

        // Check that SAPISID has .youtube.com domain (not just music.youtube.com)
        const sapisid = cookieMap.get('SAPISID');
        if (sapisid && !sapisid.domain.endsWith('.youtube.com') && sapisid.domain !== '.youtube.com') {
            issues.push(`SAPISID domain is "${sapisid.domain}" — must be ".youtube.com" for auth to work across all YouTube URLs`);
        }

        // Check for expired cookies
        const expired = required.filter((name) => {
            const c = cookieMap.get(name);
            return c && c.expiry > 0 && c.expiry < now;
        });
        if (expired.length > 0) {
            issues.push(`Expired cookies: ${expired.join(', ')} — re-export fresh cookies from your browser`);
        }

        if (issues.length === 0) return null;
        return `cookies.txt validation issues: ${issues.join('; ')}. Export from youtube.com (not music.youtube.com) to ensure .youtube.com shared cookies are included.`;
    }

    private async downloadYouTubeAudio(
        sourceUrl: string,
        outputDir: string,
        cookiesFile?: string,
        sectionArg?: string,
        onProgress?: (message: string) => void,
    ): Promise<{ success: boolean; audioPath?: string; warning?: string; error?: string }> {
        const notify = (message: string): void => {
            try {
                onProgress?.(message);
            } catch {
                // Ignore progress callback errors
            }
        };
        const outputTemplate = path.join(outputDir, 'source.%(ext)s');
        const ytDlp = await this.resolveYtDlpCommand();
        if (!ytDlp) {
            return {
                success: false,
                error: 'yt-dlp was not found. Install yt-dlp and ensure it is available in PATH.',
            };
        }

        const warnings: string[] = [];
        const validCookiesFile = cookiesFile && fs.existsSync(cookiesFile) ? cookiesFile : null;
        if (cookiesFile && !validCookiesFile) {
            warnings.push(`cookies.txt not found at: ${cookiesFile}`);
        }
        if (validCookiesFile) {
            const cookieValidation = this.validateYouTubeCookiesFile(validCookiesFile);
            if (cookieValidation) {
                warnings.push(cookieValidation);
            }
        }

        const cookieArgs = validCookiesFile ? ['--cookies', validCookiesFile] : [];
        let ytDlpFfmpegArgs: string[] = [];
        let ytDlpEnv: NodeJS.ProcessEnv | undefined;
        if (sectionArg) {
            const ffmpegTools = await this.ensureFfmpegTools();
            if (!ffmpegTools.ffmpegPath) {
                const warningPrefix = warnings.length > 0 ? `[warnings: ${warnings.join(' ')}] ` : '';
                return {
                    success: false,
                    error: `${warningPrefix}yt-dlp partial download requires ffmpeg, but ffmpeg could not be prepared (${ffmpegTools.error || 'unknown error'}).`,
                };
            }
            const ffmpegDir = path.dirname(ffmpegTools.ffmpegPath);
            ytDlpFfmpegArgs = ['--ffmpeg-location', ffmpegDir];
            ytDlpEnv = this.buildEnvWithAdditionalPath(ffmpegDir);
            if (ffmpegTools.warning) {
                warnings.push(ffmpegTools.warning);
            }
        }
        // Strip playlist/radio query params so yt-dlp only downloads this single video.
        const cleanUrl = this.cleanYouTubeUrl(sourceUrl);
        const musicUrl = this.buildMusicYouTubeUrl(sourceUrl);

        // Provide a JS runtime for yt-dlp EJS support (--js-runtimes or --remote-components).
        // Required for YouTube Premium EJS-based authentication (see yt-dlp/wiki/EJS).
        const { args: runtimeArgs, diag: runtimeDiag, ytDlpOverride } = await this.detectYtDlpRuntimeArgs(ytDlp);
        // Use the upgraded/pip version if detectYtDlpRuntimeArgs switched to it.
        const activeYtDlp = ytDlpOverride ?? ytDlp;
        if (runtimeArgs.length > 0) {
            warnings.push(`Using JS runtime for yt-dlp (${runtimeArgs.join(' ')})`);
        }

        const sectionMode = !!sectionArg;
        const sectionArgs = sectionArg ? ['--download-sections', sectionArg] : [];
        const sectionNetworkArgs = sectionMode
            ? ['--socket-timeout', '20', '--retries', '1', '--fragment-retries', '1']
            : [];
        const baseFixedArgs = ['--ignore-config', '--no-playlist', '-o', outputTemplate, ...ytDlpFfmpegArgs, ...runtimeArgs, ...sectionNetworkArgs, ...sectionArgs];
        const downloadAttemptTimeoutMs = sectionMode ? 75 * 1000 : 30 * 60 * 1000;
        if (sectionMode) {
            warnings.push(`Dialogue clip partial download mode enabled (timeout=${Math.floor(downloadAttemptTimeoutMs / 1000)}s/attempt).`);
        }

        const runAttempt = async (extraArgs: string[], url: string): Promise<CommandResult> => (
            this.runCommand(
                activeYtDlp.command,
                activeYtDlp.argsPrefix.concat(cookieArgs, extraArgs, baseFixedArgs, [url]),
                { cwd: outputDir, timeoutMs: downloadAttemptTimeoutMs, env: ytDlpEnv },
            )
        );

        // Ordered attempts — YouTube Music-specific clients first.
        // Cookie domain note: cookies from music.youtube.com may only match music.youtube.com
        // requests, so music.youtube.com URL variants are tried alongside www.youtube.com.
        // Each entry: [extraArgs, url, label]
        type Attempt = [string[], string, string];
        const mkClient = (client: string): string[] => ['--extractor-args', `youtube:player_client=${client}`];
        const fmt = (f: string): string[] => ['-f', f];
        const fastAudioFmt = (sectionMode ? '140/251/250/249/bestaudio' : 'bestaudio/best');

        const musicAttempts: Attempt[] = musicUrl ? [
            [[...mkClient('ios_music'), ...fmt(fastAudioFmt)], musicUrl, 'ios_music+music_url'],
            [[...mkClient('android_music'), ...fmt(fastAudioFmt)], musicUrl, 'android_music+music_url'],
            [[...mkClient('web_music'), ...fmt(fastAudioFmt)], musicUrl, 'web_music+music_url'],
            [fmt(fastAudioFmt), musicUrl, 'bestaudio+music_url'],
            [[], musicUrl, 'default+music_url'],
            [fmt('worst'), musicUrl, 'worst+music_url'],
        ] : [];

        const fullAttempts: Attempt[] = [
            // YouTube Music-specific mobile clients on clean URL (no playlist params)
            [[...mkClient('ios_music'), ...fmt(fastAudioFmt)], cleanUrl, 'ios_music'],
            [[...mkClient('android_music'), ...fmt(fastAudioFmt)], cleanUrl, 'android_music'],
            // music.youtube.com URL variants interleaved (cookie domain match)
            ...musicAttempts,
            // Standard selectors on clean URL
            [fmt(fastAudioFmt), cleanUrl, 'bestaudio'],
            [[], cleanUrl, 'default'],
            [[...mkClient('ios'), ...fmt(fastAudioFmt)], cleanUrl, 'ios'],
            [fmt('worst'), cleanUrl, 'worst'],
        ];
        const fastSectionAttempts: Attempt[] = [
            [[...mkClient('ios_music'), ...fmt(fastAudioFmt)], cleanUrl, 'ios_music'],
            ...(musicUrl ? [[[...mkClient('ios_music'), ...fmt(fastAudioFmt)], musicUrl, 'ios_music+music_url'] as Attempt] : []),
            [fmt(fastAudioFmt), cleanUrl, 'bestaudio'],
        ];
        const attempts: Attempt[] = sectionArg ? fastSectionAttempts : fullAttempts;

        let lastError = '';
        let successLabel = '';
        let finalResult: CommandResult | null = null;

        for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
            const [extraArgs, url, label] = attempts[attemptIndex];
            notify(`YouTube音声を取得中... (${attemptIndex + 1}/${attempts.length}: ${label})`);
            const result = await runAttempt(extraArgs, url);
            if (result.success) {
                finalResult = result;
                successLabel = label;
                notify(`YouTube音声を取得完了 (${label})`);
                break;
            }
            const errorText = result.stderr || result.stdout || '';
            if (result.code === -1 && /Command timeout/i.test(errorText)) {
                notify(`YouTube音声取得タイムアウト。次の方式で再試行します... (${label})`);
            }
            if (this.isYtDlpPremiumRestrictedError(errorText)) {
                // Authentication failure — try browser cookies combined with music URL.
                const urlsToTry = [cleanUrl, ...(musicUrl ? [musicUrl] : [])];
                const cookieSources = this.buildYtDlpCookieSources();
                outer: for (const tryUrl of urlsToTry) {
                    for (const source of cookieSources) {
                        notify(`YouTube認証付き再試行中... (browser cookies: ${source})`);
                        const browserRetry = await this.runCommand(
                            activeYtDlp.command,
                            activeYtDlp.argsPrefix.concat(
                                cookieArgs,
                                ['--cookies-from-browser', source],
                                [...mkClient('ios_music'), ...fmt(fastAudioFmt)],
                                baseFixedArgs,
                                [tryUrl],
                            ),
                            { cwd: outputDir, timeoutMs: downloadAttemptTimeoutMs, env: ytDlpEnv },
                        );
                        if (browserRetry.success) {
                            finalResult = browserRetry;
                            successLabel = `browser:${source}`;
                            notify(`YouTube音声を取得完了 (browser cookies: ${source})`);
                            break outer;
                        }
                    }
                }
                if (finalResult) break;
                const cookiesHint = cookiesFile
                    ? `cookies.txt specified (${cookiesFile}) but authentication failed. Re-export cookies from music.youtube.com while logged in to your Premium account.`
                    : 'Specify a cookies.txt file exported from music.youtube.com while logged in to your Premium account.';
                return {
                    success: false,
                    error: `yt-dlp failed: This video is restricted to YouTube Music Premium. ${cookiesHint} detail: ${this.takeTail(errorText, 300)}`,
                };
            }
            lastError = this.takeTail(errorText, 300);
        }

        if (!finalResult) {
            // Diagnostic: capture --list-formats for both URLs to diagnose cookie auth.
            const diagUrls: Array<[string, string]> = [[cleanUrl, 'youtube.com']];
            if (musicUrl) diagUrls.push([musicUrl, 'music.youtube.com']);
            const diagParts: string[] = [];
            let onlyStoryboards = true;
            for (const [diagUrl, label] of diagUrls) {
                const listFmtResult = await this.runCommand(
                    activeYtDlp.command,
                    activeYtDlp.argsPrefix.concat(cookieArgs, runtimeArgs, ['--list-formats', '--ignore-config', diagUrl]),
                    { cwd: outputDir, timeoutMs: 60_000 },
                );
                const fmtOut = listFmtResult.stdout || listFmtResult.stderr || '(no output)';
                diagParts.push(`[${label}]:\n${this.takeTail(fmtOut, 600)}`);
                // If any non-storyboard format is visible, cookies may be partially working
                if (/\b(m4a|webm|mp4|opus|aac|mp3|audio)\b/i.test(fmtOut)) {
                    onlyStoryboards = false;
                }
            }
            const ejsNote = this.isYtDlpEjsError(lastError) && runtimeArgs.length === 0
                ? ` JavaScript runtime required: ${runtimeDiag || 'see https://github.com/yt-dlp/yt-dlp/wiki/EJS'}.`
                : '';
            const cookieMsg = onlyStoryboards && validCookiesFile
                ? ` cookies.txt present but only storyboard formats visible.${ejsNote || ' Re-export fresh cookies from music.youtube.com while logged in to Premium.'}`
                : ejsNote;
            const warningPrefix = warnings.length > 0 ? `[warnings: ${warnings.join(' ')}] ` : '';
            return {
                success: false,
                error: `${warningPrefix}yt-dlp failed: ${lastError}${cookieMsg}\n${diagParts.join('\n')}`,
            };
        }

        if (successLabel.startsWith('browser:')) {
            warnings.push(`yt-dlp succeeded using browser cookies (${successLabel.slice(8)}).`);
        } else if (validCookiesFile) {
            warnings.push(`yt-dlp succeeded using cookies.txt (attempt: ${successLabel}).`);
        } else if (successLabel !== 'bestaudio') {
            warnings.push(`yt-dlp required fallback attempt: ${successLabel}.`);
        }

        const files = fs.readdirSync(outputDir)
            .map((name) => path.join(outputDir, name))
            .filter((fullPath) => fs.statSync(fullPath).isFile());
        const sortedByRecent = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        const stableOutputFiles = sortedByRecent.filter((filePath) => {
            const lower = filePath.toLowerCase();
            const base = path.basename(lower);
            if (base.endsWith('.part') || base.endsWith('.ytdl') || base.endsWith('.tmp')) return false;
            if (base.includes('.part-frag')) return false;
            return true;
        });
        const wavCandidate = sortedByRecent.find((filePath) => filePath.toLowerCase().endsWith('.wav'));
        if (wavCandidate) {
            return {
                success: true,
                audioPath: wavCandidate,
                warning: warnings.length > 0 ? warnings.join(' ') : undefined,
            };
        }
        const audioCandidate = stableOutputFiles.find((filePath) => /\.(m4a|mp3|webm|ogg|flac|aac|opus|mp4|m4v|mkv|mov)$/i.test(filePath));
        if (audioCandidate) {
            return {
                success: true,
                audioPath: audioCandidate,
                warning: warnings.length > 0 ? warnings.join(' ') : undefined,
            };
        }

        const fallbackMediaCandidate = stableOutputFiles.find((filePath) => {
            const lower = filePath.toLowerCase();
            if (/\.(json|txt|jpg|jpeg|png|webp|vtt|srt|ass|lrc|nfo)$/i.test(lower)) return false;
            try {
                return fs.statSync(filePath).size > 64 * 1024;
            } catch {
                return false;
            }
        });
        if (fallbackMediaCandidate) {
            warnings.push(`yt-dlp produced unexpected media container: ${path.basename(fallbackMediaCandidate)}`);
            return {
                success: true,
                audioPath: fallbackMediaCandidate,
                warning: warnings.length > 0 ? warnings.join(' ') : undefined,
            };
        }

        const producedNames = sortedByRecent
            .slice(0, 10)
            .map((filePath) => path.basename(filePath))
            .join(', ');

        return {
            success: false,
            error: `No audio file was produced by yt-dlp.${producedNames ? ` Files found: ${producedNames}` : ''}`,
        };
    }

    private async prepareSourceAudioForSeparation(
        sourceAudioPath: string,
        runDir: string,
    ): Promise<{ audioPath: string; warning?: string }> {
        const sourcePath = String(sourceAudioPath || '').trim();
        if (!sourcePath) {
            return { audioPath: sourceAudioPath };
        }

        const ext = path.extname(sourcePath).toLowerCase();
        if (ext === '.wav') {
            return { audioPath: sourcePath };
        }

        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            return {
                audioPath: sourcePath,
                warning: ffmpegTools.error
                    ? `Source is non-WAV and ffmpeg is unavailable (${ffmpegTools.error}).`
                    : 'Source is non-WAV and ffmpeg is unavailable. Proceeding with original container.',
            };
        }

        const preparedDir = path.join(runDir, 'prepared');
        fs.mkdirSync(preparedDir, { recursive: true });
        const preparedWavPath = path.join(preparedDir, 'source_prepared.wav');
        const convert = await this.runCommand(ffmpegTools.ffmpegPath, [
            '-y',
            '-i', sourcePath,
            '-vn',
            '-ar', '44100',
            '-ac', '2',
            preparedWavPath,
        ], { timeoutMs: 20 * 60 * 1000 });
        if (!convert.success || !fs.existsSync(preparedWavPath)) {
            return {
                audioPath: sourcePath,
                warning: `Failed to convert source audio to WAV (${this.takeTail(convert.stderr || convert.stdout, 320)}).`,
            };
        }

        const warningParts = [ffmpegTools.warning, 'Converted source audio to WAV for separation.']
            .filter(Boolean)
            .join(' ');
        return {
            audioPath: preparedWavPath,
            warning: warningParts || undefined,
        };
    }

    private async trySeparateWithUvrUltimate(
        sourceAudioPath: string,
        vocalDir: string,
        accompanimentDir: string,
    ): Promise<{
        success: boolean;
        method?: SeparationMethod;
        vocalWavPath?: string;
        accompanimentWavPath?: string;
        warning?: string;
        error?: string;
    }> {
        const runner = await this.resolveUvrUltimateRuntime();
        if (!runner.success || !runner.pythonExe) {
            return {
                success: false,
                error: runner.error || 'Ultimate Vocal Remover runtime is unavailable.',
            };
        }

        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            return {
                success: false,
                error: ffmpegTools.error || 'ffmpeg not found. UVR Ultimate requires ffmpeg.',
            };
        }

        const workDir = path.join(path.dirname(sourceAudioPath), 'uvr_ultimate_work');
        const outputDir = path.join(workDir, 'output');
        const modelFileDir = path.join(this.baseDir, 'runtime', 'uvr_models');
        fs.mkdirSync(workDir, { recursive: true });
        fs.mkdirSync(outputDir, { recursive: true });
        fs.mkdirSync(modelFileDir, { recursive: true });

        const pythonScript = `
import json
import os
import torch
import onnxruntime as ort
if hasattr(ort, 'preload_dlls'):
    ort.preload_dlls()
from audio_separator.separator import Separator

input_path = r'''${sourceAudioPath.replace(/\\/g, '\\\\')}'''
output_dir = r'''${outputDir.replace(/\\/g, '\\\\')}'''
model_file_dir = r'''${modelFileDir.replace(/\\/g, '\\\\')}'''
dereverb_dir = os.path.join(output_dir, 'dereverb')
os.makedirs(dereverb_dir, exist_ok=True)

def resolve_output_path(file_path, base_dir):
    if not file_path:
        return None
    candidates = []
    if os.path.isabs(file_path):
        candidates.append(file_path)
    else:
        candidates.append(file_path)
        candidates.append(os.path.join(base_dir, file_path))
        candidates.append(os.path.join(base_dir, os.path.basename(file_path)))
    for candidate in candidates:
        absolute_candidate = os.path.abspath(candidate)
        if os.path.exists(absolute_candidate):
            return absolute_candidate
    fallback_name = os.path.basename(file_path)
    return os.path.abspath(os.path.join(base_dir, fallback_name))

# Stage 1 model candidates ordered by quality (SDR benchmark, 2024-2025)
# BS-RoFormer ~13 dB > Mel-RoFormer ~10 dB > Kim_Vocal ~9 dB > MDX-Net ~8.5 dB
vocal_model_candidates = [
    'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
    'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt',
    'Kim_Vocal_2.onnx',
    'UVR-MDX-NET-Voc_FT.onnx',
    'UVR_MDXNET_KARA_2.onnx',
    'UVR-MDX-NET-Inst_HQ_4.onnx',
    '2_HP-UVR.pth',
]
output_names = {
    'Vocals': 'vocals_uvr_ultimate',
    'Instrumental': 'accompaniment_uvr_ultimate',
}
# Stage 2: de-reverb model candidates (applied to extracted vocals)
dereverb_model_candidates = [
    'Reverb_HQ_By_FoxJoy.onnx',
    'UVR-De-Echo-Normal.pth',
]

errors = []
vocal_file = None
inst_file = None
used_model = None
runtime_info = {
    'torch_cuda': bool(torch.cuda.is_available()),
    'ort_providers': ort.get_available_providers(),
    'torch_device': None,
    'onnx_provider': None,
}

# Stage 1 - Vocal / Instrumental separation
for model_name in vocal_model_candidates:
    try:
        sep = Separator(
            log_level=30,
            model_file_dir=model_file_dir,
            output_dir=output_dir,
            output_format='WAV',
        )
        runtime_info['torch_device'] = str(getattr(sep, 'torch_device', 'unknown'))
        runtime_info['onnx_provider'] = getattr(sep, 'onnx_execution_provider', None)
        sep.load_model(model_filename=model_name)
        output_files = sep.separate(input_path, output_names)
        resolved_output_files = [resolve_output_path(f, output_dir) for f in output_files]
        voc = [f for f in resolved_output_files if f and 'vocal' in os.path.basename(f).lower()]
        inst = [f for f in resolved_output_files if f and any(k in os.path.basename(f).lower() for k in ['instrumental', 'accompaniment', 'no_vocal', 'inst'])]
        if voc:
            vocal_file = voc[0]
            inst_file = inst[0] if inst else None
            used_model = model_name
            break
    except Exception as ex:
        errors.append({'stage': 'vocal', 'model': model_name, 'error': str(ex)})

if vocal_file is None:
    print(json.dumps({'ok': False, 'errors': errors}, ensure_ascii=False))
    raise SystemExit(1)

# Stage 2 - De-reverb on extracted vocals (optional; skip on failure)
dereverbed_file = vocal_file
dereverb_model_used = None
for dr_model in dereverb_model_candidates:
    try:
        dr_sep = Separator(
            log_level=30,
            model_file_dir=model_file_dir,
            output_dir=dereverb_dir,
            output_format='WAV',
        )
        dr_sep.load_model(model_filename=dr_model)
        dr_outputs = dr_sep.separate(vocal_file)
        if not dr_outputs:
            continue
        resolved_dr_outputs = [resolve_output_path(f, dereverb_dir) for f in dr_outputs]
        no_reverb = [f for f in resolved_dr_outputs if f and any(k in os.path.basename(f).lower() for k in ['no reverb', 'noreverb', 'no_reverb', 'dry'])]
        dereverbed_file = no_reverb[0] if no_reverb else resolved_dr_outputs[0]
        dereverb_model_used = dr_model
        break
    except Exception as ex:
        errors.append({'stage': 'dereverb', 'model': dr_model, 'error': str(ex)})

print(json.dumps({
    'ok': True,
    'model': used_model,
    'dereverb_model': dereverb_model_used,
    'vocal_file': dereverbed_file,
    'inst_file': inst_file,
    'torch_cuda': runtime_info['torch_cuda'],
    'ort_providers': runtime_info['ort_providers'],
    'torch_device': runtime_info['torch_device'],
    'onnx_provider': runtime_info['onnx_provider'],
}, ensure_ascii=False))
raise SystemExit(0)
`.trim();

        const uvrEnv = this.buildEnvWithAdditionalPath(path.dirname(ffmpegTools.ffmpegPath), {
            ...(runner.env || process.env),
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
        });
        const result = await this.runCommand(runner.pythonExe, ['-c', pythonScript], {
            cwd: workDir,
            env: uvrEnv,
            timeoutMs: 120 * 60 * 1000,
        });
        try {
            const logPath = path.join(workDir, `uvr_ultimate_${Date.now()}.log`);
            const payload = [
                `code=${result.code}`,
                '',
                '[stderr]',
                result.stderr || '',
                '',
                '[stdout]',
                result.stdout || '',
            ].join('\n');
            fs.writeFileSync(logPath, payload, 'utf-8');
        } catch {
            // Ignore log write failures.
        }

        const report = this.tryParseLastJsonLine<{
            ok?: boolean;
            model?: string;
            dereverb_model?: string;
            vocal_file?: string;
            inst_file?: string;
            torch_cuda?: boolean;
            ort_providers?: string[];
            torch_device?: string;
            onnx_provider?: string[] | string;
        }>(result.stdout || '');

        // Prefer the explicit paths returned by the script; fall back to directory scanning.
        let vocalStem: string | undefined;
        if (report?.vocal_file && fs.existsSync(report.vocal_file)) {
            vocalStem = report.vocal_file;
        } else {
            vocalStem = this.findStemFile(outputDir, ['vocals_uvr_ultimate', 'main_vocal', 'vocals', 'vocal']);
        }
        if (!vocalStem) {
            const details = this.takeTail([result.stderr, result.stdout].filter(Boolean).join('\n'), 900);
            return {
                success: false,
                error: details
                    ? `UVR Ultimate failed: ${details}`
                    : this.formatCommandFailure('UVR Ultimate', result),
            };
        }

        let accompanimentStem: string | undefined;
        if (report?.inst_file && fs.existsSync(report.inst_file)) {
            accompanimentStem = report.inst_file;
        } else {
            accompanimentStem = this.findStemFile(
                outputDir,
                ['accompaniment_uvr_ultimate', 'instrumental', 'no_vocals', 'others'],
                { allowAnyWavFallback: false },
            );
        }

        const vocalCopyPath = path.join(vocalDir, `vocal_uvr_ultimate_${Date.now()}.wav`);
        fs.copyFileSync(vocalStem, vocalCopyPath);

        let accompanimentCopyPath: string | undefined;
        if (accompanimentStem) {
            accompanimentCopyPath = path.join(accompanimentDir, `accompaniment_uvr_ultimate_${Date.now()}.wav`);
            fs.copyFileSync(accompanimentStem, accompanimentCopyPath);
        }

        const warnings: string[] = [];
        if (runner.warning) warnings.push(runner.warning);
        if (ffmpegTools.warning) warnings.push(ffmpegTools.warning);
        if (report?.model) warnings.push(`UVR Ultimate vocal model: ${report.model}`);
        if (report?.dereverb_model) warnings.push(`De-reverb: ${report.dereverb_model}`);
        const runtimeInfo = this.formatAudioSeparatorRuntimeInfo(report);
        if (runtimeInfo) warnings.push(runtimeInfo);
        if (!result.success) warnings.push(`UVR Ultimate exited with code ${result.code}, but stem files were produced and reused.`);
        if (!accompanimentCopyPath) warnings.push('UVR Ultimate extracted vocals but accompaniment stem was not found.');

        return {
            success: true,
            method: 'uvr-ultimate',
            vocalWavPath: vocalCopyPath,
            accompanimentWavPath: accompanimentCopyPath,
            warning: warnings.length > 0 ? warnings.join(' ') : undefined,
        };
    }

    private async tryDereverbVocalStem(
        inputVocalPath: string,
        runDir: string,
    ): Promise<{
        success: boolean;
        outputPath?: string;
        model?: string;
        warning?: string;
        error?: string;
    }> {
        const runner = await this.resolveUvrUltimateRuntime();
        if (!runner.success || !runner.pythonExe) {
            return {
                success: false,
                error: runner.error || 'Audio-separator runtime is unavailable for de-reverb.',
            };
        }

        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            return {
                success: false,
                error: ffmpegTools.error || 'ffmpeg not found. De-reverb requires ffmpeg.',
            };
        }

        const workDir = path.join(runDir, 'dereverb_work');
        const outputDir = path.join(workDir, 'output');
        const modelFileDir = path.join(this.baseDir, 'runtime', 'uvr_ultimate_models');
        fs.mkdirSync(workDir, { recursive: true });
        fs.mkdirSync(outputDir, { recursive: true });
        fs.mkdirSync(modelFileDir, { recursive: true });

        const script = `
import json
import os
import onnxruntime as ort
preload = getattr(ort, "preload_dlls", None)
if preload:
    preload()
from audio_separator.separator import Separator

input_path = r'''${inputVocalPath.replace(/\\/g, '\\\\')}'''
output_dir = r'''${outputDir.replace(/\\/g, '\\\\')}'''
model_file_dir = r'''${modelFileDir.replace(/\\/g, '\\\\')}'''
os.makedirs(output_dir, exist_ok=True)

def resolve_output_path(file_path, base_dir):
    if not file_path:
        return None
    candidates = []
    if os.path.isabs(file_path):
        candidates.append(file_path)
    else:
        candidates.append(file_path)
        candidates.append(os.path.join(base_dir, file_path))
        candidates.append(os.path.join(base_dir, os.path.basename(file_path)))
    for candidate in candidates:
        absolute_candidate = os.path.abspath(candidate)
        if os.path.exists(absolute_candidate):
            return absolute_candidate
    fallback_name = os.path.basename(file_path)
    return os.path.abspath(os.path.join(base_dir, fallback_name))

model_candidates = [
    'Reverb_HQ_By_FoxJoy.onnx',
    'UVR-De-Echo-Normal.pth',
]
runtime_info = {
    'torch_cuda': False,
    'ort_providers': ort.get_available_providers(),
    'torch_device': None,
    'onnx_provider': None,
}
errors = []

for model_name in model_candidates:
    try:
        sep = Separator(
            log_level=30,
            model_file_dir=model_file_dir,
            output_dir=output_dir,
            output_format='WAV',
        )
        runtime_info['torch_cuda'] = bool(getattr(__import__('torch').cuda, 'is_available')())
        runtime_info['torch_device'] = str(getattr(sep, 'torch_device', 'unknown'))
        runtime_info['onnx_provider'] = getattr(sep, 'onnx_execution_provider', None)
        sep.load_model(model_filename=model_name)
        output_files = sep.separate(input_path)
        resolved_output_files = [resolve_output_path(f, output_dir) for f in output_files]
        dry_outputs = [f for f in resolved_output_files if f and any(k in os.path.basename(f).lower() for k in ['no reverb', 'noreverb', 'no_reverb', 'dry'])]
        existing_outputs = [f for f in resolved_output_files if f and os.path.exists(f)]
        best_output = dry_outputs[0] if dry_outputs else (existing_outputs[0] if existing_outputs else None)
        if best_output:
            print(json.dumps({
                'ok': True,
                'model': model_name,
                'output_file': best_output,
                **runtime_info,
            }, ensure_ascii=False))
            raise SystemExit(0)
    except SystemExit:
        raise
    except Exception as ex:
        errors.append({'model': model_name, 'error': str(ex)})

print(json.dumps({
    'ok': False,
    'errors': errors,
    **runtime_info,
}, ensure_ascii=False))
raise SystemExit(1)
`.trim();

        const result = await this.runCommand(runner.pythonExe, ['-c', script], {
            cwd: workDir,
            env: runner.env || process.env,
            timeoutMs: 90 * 60 * 1000,
        });

        try {
            const logPath = path.join(workDir, `dereverb_${Date.now()}.log`);
            const payload = [
                `code=${result.code}`,
                '',
                '[stderr]',
                result.stderr || '',
                '',
                '[stdout]',
                result.stdout || '',
            ].join('\n');
            fs.writeFileSync(logPath, payload, 'utf-8');
        } catch {
            // Ignore log write failures.
        }

        const report = this.tryParseLastJsonLine<{
            ok?: boolean;
            model?: string;
            output_file?: string;
            torch_cuda?: boolean;
            ort_providers?: string[];
            torch_device?: string;
            onnx_provider?: string[] | string;
        }>(result.stdout || '');

        const rawOutputPath = report?.output_file && fs.existsSync(report.output_file)
            ? report.output_file
            : this.findStemFile(outputDir, ['no_reverb', 'noreverb', 'dry', 'vocals'], { allowAnyWavFallback: true });
        if (!rawOutputPath) {
            const details = this.takeTail([result.stderr, result.stdout].filter(Boolean).join('\n'), 900);
            return {
                success: false,
                error: details
                    ? `De-reverb failed: ${details}`
                    : this.formatCommandFailure('de-reverb', result),
            };
        }

        const enhancedDir = path.join(runDir, 'enhanced');
        fs.mkdirSync(enhancedDir, { recursive: true });
        const normalizedOutputPath = path.join(enhancedDir, `vocal_dereverb_${Date.now()}.wav`);
        const convert = await this.runCommand(ffmpegTools.ffmpegPath, [
            '-y',
            '-i', rawOutputPath,
            '-vn',
            '-ac', '1',
            '-ar', '44100',
            '-c:a', 'pcm_s16le',
            normalizedOutputPath,
        ], {
            timeoutMs: 20 * 60 * 1000,
            env: this.buildEnvWithAdditionalPath(path.dirname(ffmpegTools.ffmpegPath)),
        });
        if (!convert.success || !fs.existsSync(normalizedOutputPath)) {
            return {
                success: false,
                error: `De-reverb normalization failed (${this.takeTail(convert.stderr || convert.stdout, 260) || 'unknown error'}).`,
            };
        }

        const warnings: string[] = [];
        if (runner.warning) warnings.push(runner.warning);
        if (ffmpegTools.warning) warnings.push(ffmpegTools.warning);
        const runtimeInfo = this.formatAudioSeparatorRuntimeInfo(report);
        if (runtimeInfo) warnings.push(runtimeInfo);
        if (!result.success) warnings.push(`De-reverb exited with code ${result.code}, but output stem was reused.`);

        return {
            success: true,
            outputPath: normalizedOutputPath,
            model: report?.model,
            warning: warnings.length > 0 ? warnings.join(' ') : undefined,
        };
    }

    private async trySeparateWithRoformer(
        sourceAudioPath: string,
        vocalDir: string,
        accompanimentDir: string,
    ): Promise<{
        success: boolean;
        method?: SeparationMethod;
        vocalWavPath?: string;
        accompanimentWavPath?: string;
        warning?: string;
        error?: string;
    }> {
        const runner = await this.resolveRoformerRuntime();
        if (!runner.success || !runner.pythonExe) {
            return {
                success: false,
                error: runner.error || 'Roformer runtime is unavailable.',
            };
        }

        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            return {
                success: false,
                error: ffmpegTools.error || 'ffmpeg not found. Roformer separation requires ffmpeg.',
            };
        }

        const workDir = path.join(path.dirname(sourceAudioPath), 'roformer_work');
        const outputDir = path.join(workDir, 'output');
        const modelFileDir = path.join(this.baseDir, 'runtime', 'roformer_models');
        fs.mkdirSync(workDir, { recursive: true });
        fs.mkdirSync(outputDir, { recursive: true });
        fs.mkdirSync(modelFileDir, { recursive: true });

        const pythonScript = `
import json
import os
import torch
import onnxruntime as ort
if hasattr(ort, 'preload_dlls'):
    ort.preload_dlls()
from audio_separator.separator import Separator

input_path = r'''${sourceAudioPath.replace(/\\/g, '\\\\')}'''
output_dir = r'''${outputDir.replace(/\\/g, '\\\\')}'''
model_file_dir = r'''${modelFileDir.replace(/\\/g, '\\\\')}'''
os.makedirs(output_dir, exist_ok=True)

model_candidates = [
    'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
    'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt',
]
output_names = {
    'Vocals': 'vocals_roformer',
    'Instrumental': 'accompaniment_roformer',
}

errors = []
vocal_file = None
inst_file = None
used_model = None
runtime_info = {
    'torch_cuda': bool(torch.cuda.is_available()),
    'ort_providers': ort.get_available_providers(),
    'torch_device': None,
    'onnx_provider': None,
}

for model_name in model_candidates:
    try:
        sep = Separator(
            log_level=30,
            model_file_dir=model_file_dir,
            output_dir=output_dir,
            output_format='WAV',
        )
        runtime_info['torch_device'] = str(getattr(sep, 'torch_device', 'unknown'))
        runtime_info['onnx_provider'] = getattr(sep, 'onnx_execution_provider', None)
        sep.load_model(model_filename=model_name)
        output_files = sep.separate(input_path, output_names)
        voc = [f for f in output_files if 'vocal' in os.path.basename(f).lower()]
        inst = [f for f in output_files if any(k in os.path.basename(f).lower() for k in ['instrumental', 'accompaniment', 'no_vocal', 'inst'])]
        if voc:
            vocal_file = voc[0]
            inst_file = inst[0] if inst else None
            used_model = model_name
            break
    except Exception as ex:
        errors.append({'model': model_name, 'error': str(ex)})

if vocal_file is None:
    print(json.dumps({'ok': False, 'errors': errors}, ensure_ascii=False))
    raise SystemExit(1)

print(json.dumps({
    'ok': True,
    'model': used_model,
    'vocal_file': vocal_file,
    'inst_file': inst_file,
    'torch_cuda': runtime_info['torch_cuda'],
    'ort_providers': runtime_info['ort_providers'],
    'torch_device': runtime_info['torch_device'],
    'onnx_provider': runtime_info['onnx_provider'],
}, ensure_ascii=False))
raise SystemExit(0)
`.trim();

        const roformerEnv = this.buildEnvWithAdditionalPath(path.dirname(ffmpegTools.ffmpegPath), {
            ...(runner.env || process.env),
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
        });
        const result = await this.runCommand(runner.pythonExe, ['-c', pythonScript], {
            cwd: workDir,
            env: roformerEnv,
            timeoutMs: 120 * 60 * 1000,
        });
        try {
            const logPath = path.join(workDir, `roformer_${Date.now()}.log`);
            const payload = [
                `code=${result.code}`,
                '',
                '[stderr]',
                result.stderr || '',
                '',
                '[stdout]',
                result.stdout || '',
            ].join('\n');
            fs.writeFileSync(logPath, payload, 'utf-8');
        } catch {
            // Ignore log write failures.
        }

        const report = this.tryParseLastJsonLine<{
            ok?: boolean;
            model?: string;
            vocal_file?: string;
            inst_file?: string;
            torch_cuda?: boolean;
            ort_providers?: string[];
            torch_device?: string;
            onnx_provider?: string[] | string;
        }>(result.stdout || '');

        let vocalStem: string | undefined;
        if (report?.vocal_file && fs.existsSync(report.vocal_file)) {
            vocalStem = report.vocal_file;
        } else {
            vocalStem = this.findStemFile(outputDir, ['vocals_roformer', 'main_vocal', 'vocals', 'vocal']);
        }
        if (!vocalStem) {
            const details = this.takeTail([result.stderr, result.stdout].filter(Boolean).join('\n'), 900);
            return {
                success: false,
                error: details
                    ? `Roformer separation failed: ${details}`
                    : this.formatCommandFailure('Roformer', result),
            };
        }

        let accompanimentStem: string | undefined;
        if (report?.inst_file && fs.existsSync(report.inst_file)) {
            accompanimentStem = report.inst_file;
        } else {
            accompanimentStem = this.findStemFile(
                outputDir,
                ['accompaniment_roformer', 'instrumental', 'accompaniment', 'no_vocals', 'others'],
                { allowAnyWavFallback: false },
            );
        }

        const vocalCopyPath = path.join(vocalDir, `vocal_roformer_${Date.now()}.wav`);
        fs.copyFileSync(vocalStem, vocalCopyPath);

        let accompanimentCopyPath: string | undefined;
        if (accompanimentStem) {
            accompanimentCopyPath = path.join(accompanimentDir, `accompaniment_roformer_${Date.now()}.wav`);
            fs.copyFileSync(accompanimentStem, accompanimentCopyPath);
        }

        const warnings: string[] = [];
        if (runner.warning) warnings.push(runner.warning);
        if (ffmpegTools.warning) warnings.push(ffmpegTools.warning);
        if (report?.model) warnings.push(`Roformer model: ${report.model}`);
        const runtimeInfo = this.formatAudioSeparatorRuntimeInfo(report);
        if (runtimeInfo) warnings.push(runtimeInfo);
        if (!result.success) warnings.push(`Roformer exited with code ${result.code}, but stem files were produced and reused.`);
        if (!accompanimentCopyPath) warnings.push('Roformer extracted vocals but accompaniment stem was not found.');

        return {
            success: true,
            method: 'roformer',
            vocalWavPath: vocalCopyPath,
            accompanimentWavPath: accompanimentCopyPath,
            warning: warnings.length > 0 ? warnings.join(' ') : undefined,
        };
    }

    private async trySeparateWithUvr(
        sourceAudioPath: string,
        vocalDir: string,
        accompanimentDir: string,
    ): Promise<{
        success: boolean;
        method?: SeparationMethod;
        vocalWavPath?: string;
        accompanimentWavPath?: string;
        warning?: string;
        error?: string;
    }> {
        const manifest = this.loadRvcManifest();
        if (!manifest) {
            return { success: false, error: 'RVC install manifest not found' };
        }
        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            return {
                success: false,
                error: ffmpegTools.error || 'ffmpeg not found. UVR5 requires ffmpeg/ffprobe.',
            };
        }

        const pythonExe = this.resolvePythonExecutable(manifest.pythonPath);
        if (!pythonExe) {
            return { success: false, error: 'RVC Python executable not found' };
        }

        const rvcOfficialRoot = path.join(manifest.rvcPath, 'rvc_official');
        if (!fs.existsSync(rvcOfficialRoot)) {
            return { success: false, error: `RVC core not found: ${rvcOfficialRoot}` };
        }

        const weightRoot = path.join(rvcOfficialRoot, 'assets', 'uvr5_weights');
        const ensureWeights = await this.ensureUvrWeights(weightRoot);
        if (!ensureWeights.success) {
            return { success: false, error: ensureWeights.error || `UVR5 weights not found: ${weightRoot}` };
        }

        const modelFiles = fs.readdirSync(weightRoot).filter((name) => name.toLowerCase().endsWith('.pth'));
        if (modelFiles.length === 0) {
            return { success: false, error: 'No UVR5 model file (.pth) found in assets/uvr5_weights' };
        }

        const preferred = ['hp5_only_main_vocal', 'hp5_main_vocal', 'hp2_all_vocals', 'deecho'];
        const selectedModelFile = preferred
            .map((candidate) => modelFiles.find((name) => name.toLowerCase().includes(candidate)))
            .find(Boolean)
            || modelFiles[0];
        const modelName = selectedModelFile.replace(/\.pth$/i, '');

        const tempInputDir = path.join(path.dirname(sourceAudioPath), 'uvr_input');
        fs.mkdirSync(tempInputDir, { recursive: true });
        const inputCopyPath = path.join(tempInputDir, path.basename(sourceAudioPath));
        if (path.resolve(inputCopyPath) !== path.resolve(sourceAudioPath)) {
            fs.copyFileSync(sourceAudioPath, inputCopyPath);
        }
        const uvrStamp = Date.now();
        const uvrVocalOutDir = path.join(vocalDir, `uvr5_run_${uvrStamp}`, 'vocals');
        const uvrAccOutDir = path.join(accompanimentDir, `uvr5_run_${uvrStamp}`, 'accompaniment');
        fs.mkdirSync(uvrVocalOutDir, { recursive: true });
        fs.mkdirSync(uvrAccOutDir, { recursive: true });

        const script = `
import json
import os
import sys

root = r'''${rvcOfficialRoot.replace(/\\/g, '\\\\')}'''
if root not in sys.path:
    sys.path.insert(0, root)
os.chdir(root)
os.environ['weight_uvr5_root'] = r'''${weightRoot.replace(/\\/g, '\\\\')}'''
from infer.modules.uvr5.modules import uvr

infos = []
for row in uvr(
    r'''${modelName.replace(/\\/g, '\\\\')}''',
    r'''${tempInputDir.replace(/\\/g, '\\\\')}''',
    r'''${uvrVocalOutDir.replace(/\\/g, '\\\\')}''',
    [],
    r'''${uvrAccOutDir.replace(/\\/g, '\\\\')}''',
    10,
    'wav',
):
    infos.append(row)

print(json.dumps({'ok': True, 'logs': infos[-3:]}))
`.trim();

        const uvrEnv = this.buildEnvWithAdditionalPath(path.dirname(ffmpegTools.ffmpegPath), {
            ...process.env,
            weight_uvr5_root: weightRoot,
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
        });
        const result = await this.runCommand(pythonExe, ['-c', script], {
            cwd: rvcOfficialRoot,
            timeoutMs: 45 * 60 * 1000,
            env: uvrEnv,
        });
        if (!result.success) {
            return {
                success: false,
                error: `UVR separation failed: ${this.takeTail(result.stderr || result.stdout, 600)}`,
            };
        }
        try {
            const logPath = path.join(path.dirname(sourceAudioPath), `uvr5_${Date.now()}.log`);
            const payload = [
                `code=${result.code}`,
                '',
                '[stderr]',
                result.stderr || '',
                '',
                '[stdout]',
                result.stdout || '',
            ].join('\n');
            fs.writeFileSync(logPath, payload, 'utf-8');
        } catch {
            // Ignore UVR debug log write failures.
        }
        const uvrReport = this.tryParseLastJsonLine<{ ok?: boolean; logs?: unknown }>(result.stdout || '');
        const uvrLogs = Array.isArray(uvrReport?.logs)
            ? uvrReport.logs.map((value) => String(value)).filter(Boolean)
            : [];
        const uvrLogTail = uvrLogs.length > 0 ? this.takeTail(uvrLogs.join(' | '), 360) : undefined;

        const vocalWav = this.findStemFile(uvrVocalOutDir, ['vocals', 'vocal', 'main_vocal']);
        if (!vocalWav) {
            const debugWavs = this.collectFilesRecursive(path.dirname(sourceAudioPath))
                .filter((fullPath) => fullPath.toLowerCase().endsWith('.wav') && fullPath.includes(`uvr5_run_${uvrStamp}`))
                .slice(0, 10)
                .map((fullPath) => path.basename(fullPath));
            return {
                success: false,
                error: `UVR separation completed but vocal WAV not found${uvrLogTail ? ` (uvr: ${uvrLogTail})` : ''}${debugWavs.length > 0 ? ` [debug files: ${debugWavs.join(', ')}]` : ''}`,
            };
        }
        const accompanimentWav = this.findStemFile(
            uvrAccOutDir,
            ['no_vocals', 'instrumental', 'accompaniment'],
            { allowAnyWavFallback: true },
        );

        const vocalCopyPath = path.join(vocalDir, `vocal_uvr5_${Date.now()}.wav`);
        fs.copyFileSync(vocalWav, vocalCopyPath);
        let accompanimentCopyPath: string | undefined;
        if (accompanimentWav && fs.existsSync(accompanimentWav)) {
            accompanimentCopyPath = path.join(accompanimentDir, `accompaniment_uvr5_${Date.now()}.wav`);
            fs.copyFileSync(accompanimentWav, accompanimentCopyPath);
        }

        return {
            success: true,
            method: 'uvr5',
            vocalWavPath: vocalCopyPath,
            accompanimentWavPath: accompanimentCopyPath,
            warning: [ensureWeights.warning, ffmpegTools.warning].filter(Boolean).join(' ') || undefined,
        };
    }

    private async trySeparateWithDemucs(
        sourceAudioPath: string,
        vocalDir: string,
        accompanimentDir: string,
    ): Promise<{
        success: boolean;
        method?: SeparationMethod;
        vocalWavPath?: string;
        accompanimentWavPath?: string;
        warning?: string;
        error?: string;
    }> {
        const runner = await this.resolveDemucsRunner();
        if (!runner.success || !runner.command || !runner.argsPrefix) {
            return {
                success: false,
                error: runner.error || 'Demucs runner is unavailable.',
            };
        }
        const ffmpegTools = await this.ensureFfmpegTools();
        const demucsEnv = ffmpegTools.ffmpegPath
            ? this.buildEnvWithAdditionalPath(path.dirname(ffmpegTools.ffmpegPath))
            : process.env;

        const workDir = path.join(path.dirname(sourceAudioPath), 'demucs_work');
        const outputRoot = path.join(workDir, 'output');
        fs.mkdirSync(workDir, { recursive: true });
        fs.mkdirSync(outputRoot, { recursive: true });

        const modelCandidates = ['htdemucs_ft', 'htdemucs'];
        const profileCandidates: Array<{
            id: string;
            args: string[];
            timeoutMs: number;
        }> = [
            {
                id: 'hq',
                args: ['--shifts', '2', '--overlap', '0.35', '--float32'],
                timeoutMs: 120 * 60 * 1000,
            },
            {
                id: 'balanced',
                args: ['--shifts', '1', '--overlap', '0.25'],
                timeoutMs: 90 * 60 * 1000,
            },
        ];
        let lastError = '';
        for (const modelName of modelCandidates) {
            for (let profileIndex = 0; profileIndex < profileCandidates.length; profileIndex += 1) {
                const profile = profileCandidates[profileIndex];
                const attempt = profileIndex + 1;
                const args = runner.argsPrefix.concat([
                    '--two-stems',
                    'vocals',
                    '-n',
                    modelName,
                    ...profile.args,
                    '-o',
                    outputRoot,
                    sourceAudioPath,
                ]);
                const result = await this.runCommand(runner.command, args, {
                    cwd: workDir,
                    env: demucsEnv,
                    timeoutMs: profile.timeoutMs,
                });
                try {
                    const logPath = path.join(workDir, `demucs_${modelName}_${profile.id}_attempt${attempt}.log`);
                    const payload = [
                        `model=${modelName}`,
                        `profile=${profile.id}`,
                        `attempt=${attempt}`,
                        `code=${result.code}`,
                        '',
                        '[stderr]',
                        result.stderr || '',
                        '',
                        '[stdout]',
                        result.stdout || '',
                    ].join('\n');
                    fs.writeFileSync(logPath, payload, 'utf-8');
                } catch {
                    // Ignore log write failures.
                }

                const modelOutputDir = path.join(outputRoot, modelName);
                const vocalStem = this.findStemFile(modelOutputDir, ['vocals']);
                if (vocalStem && vocalStem.toLowerCase().endsWith('.wav')) {
                    const accompanimentStem = this.findStemFile(
                        modelOutputDir,
                        ['no_vocals', 'instrumental', 'accompaniment'],
                        { allowAnyWavFallback: false },
                    );
                    const vocalCopyPath = path.join(vocalDir, `vocal_demucs_${Date.now()}.wav`);
                    fs.copyFileSync(vocalStem, vocalCopyPath);

                    let accompanimentCopyPath: string | undefined;
                    if (accompanimentStem && accompanimentStem.toLowerCase().endsWith('.wav')) {
                        accompanimentCopyPath = path.join(accompanimentDir, `accompaniment_demucs_${Date.now()}.wav`);
                        fs.copyFileSync(accompanimentStem, accompanimentCopyPath);
                    }

                    const warnings: string[] = [];
                    if (runner.warning) warnings.push(runner.warning);
                    if (ffmpegTools.warning) warnings.push(ffmpegTools.warning);
                    if (!result.success) {
                        warnings.push(`Demucs exited with code ${result.code}, but stem files were produced and reused (${modelName}/${profile.id}).`);
                    }
                    if (attempt > 1) {
                        warnings.push(`Demucs succeeded after retry (${modelName}, profile ${profile.id}, attempt ${attempt}).`);
                    } else {
                        warnings.push(`Demucs quality profile: ${modelName}/${profile.id}.`);
                    }
                    if (!accompanimentCopyPath) {
                        warnings.push('Demucs extracted vocals but accompaniment stem was not found.');
                    }
                    return {
                        success: true,
                        method: 'demucs',
                        vocalWavPath: vocalCopyPath,
                        accompanimentWavPath: accompanimentCopyPath,
                        warning: warnings.length > 0 ? warnings.join(' ') : undefined,
                    };
                }

                if (!result.success) {
                    lastError = this.formatCommandFailure(`Demucs(${modelName}/${profile.id}) attempt ${attempt}`, result);
                } else {
                    lastError = `Demucs(${modelName}/${profile.id}) attempt ${attempt} finished but vocals.wav was not found.`;
                }
            }
        }

        return {
            success: false,
            error: lastError || 'Demucs separation failed.',
        };
    }

    private async resolveUvrUltimateRuntime(): Promise<{
        success: boolean;
        pythonExe?: string;
        env?: NodeJS.ProcessEnv;
        warning?: string;
        error?: string;
    }> {
        const runtimeRoot = path.join(this.baseDir, 'runtime');
        const venvRoot = path.join(runtimeRoot, 'uvr_ultimate_venv');
        const venvPython = path.join(venvRoot, 'Scripts', 'python.exe');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const warnings: string[] = [];

        if (!fs.existsSync(venvPython)) {
            const manifest = this.loadRvcManifest();
            const manifestPython = manifest?.pythonPath ? this.resolvePythonExecutable(manifest.pythonPath) : null;
            const systemPython = await this.resolveExecutable('python');
            const basePython = systemPython || manifestPython;
            if (!basePython) {
                return {
                    success: false,
                    error: 'Python runtime not found. Install Python 3 and make it available in PATH.',
                };
            }

            const createVenv = await this.createIsolatedVenv(venvRoot, basePython);
            if (!createVenv.success || !fs.existsSync(venvPython)) {
                return {
                    success: false,
                    error: `Failed to create UVR Ultimate runtime: ${createVenv.error || 'unknown'}`,
                };
            }
            if (createVenv.warning) {
                warnings.push(createVenv.warning);
            }
        }

        const hasNvidiaGpu = await this.hasNvidiaGpuAvailable();
        const probe = await this.probeAudioSeparatorRuntime(venvPython);
        const probeSummary = this.summarizeAudioSeparatorProbe(probe);
        if (probe.success && (!hasNvidiaGpu || this.audioSeparatorProbeUsesGpu(probe))) {
            return {
                success: true,
                pythonExe: venvPython,
                warning: [...warnings, probeSummary].filter(Boolean).join(' ') || undefined,
            };
        }
        if (probe.success && hasNvidiaGpu) {
            warnings.push('Detected CPU-only audio-separator runtime on a CUDA-capable machine. Upgrading runtime to GPU stack.');
            if (probeSummary) {
                warnings.push(`Previous runtime: ${probeSummary}`);
            }
        }

        const pipCheck = await this.runCommand(venvPython, ['-m', 'pip', '--version'], {
            timeoutMs: 20_000,
        });
        if (!pipCheck.success) {
            const ensurePip = await this.runCommand(venvPython, ['-m', 'ensurepip', '--upgrade'], {
                timeoutMs: 3 * 60 * 1000,
            });
            if (!ensurePip.success) {
                return {
                    success: false,
                    error: `pip is unavailable in UVR Ultimate runtime: ${this.takeTail(ensurePip.stderr || ensurePip.stdout, 700)}`,
                };
            }
        }

        await this.runCommand(venvPython, ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel'], {
            timeoutMs: 10 * 60 * 1000,
        });
        const install = await this.installAudioSeparatorRuntimeDependencies(venvPython);
        if (!install.success) {
            return {
                success: false,
                error: `Failed to install UVR Ultimate runtime: ${this.takeTail(install.stderr || install.stdout, 900)}`,
            };
        }

        const verify = await this.probeAudioSeparatorRuntime(venvPython);
        if (!verify.success) {
            return {
                success: false,
                error: `UVR Ultimate installation completed but Separator import failed: ${this.takeTail(verify.stderr || verify.stdout, 700)}`,
            };
        }

        const verifySummary = this.summarizeAudioSeparatorProbe(verify);
        warnings.push('UVR Ultimate runtime was auto-installed into isolated environment.');
        return {
            success: true,
            pythonExe: venvPython,
            warning: [...warnings, verifySummary].filter(Boolean).join(' '),
        };
    }

    private async resolveRoformerRuntime(): Promise<{
        success: boolean;
        pythonExe?: string;
        env?: NodeJS.ProcessEnv;
        warning?: string;
        error?: string;
    }> {
        const runtimeRoot = path.join(this.baseDir, 'runtime');
        const venvRoot = path.join(runtimeRoot, 'roformer_venv');
        const venvPython = path.join(venvRoot, 'Scripts', 'python.exe');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const warnings: string[] = [];

        if (!fs.existsSync(venvPython)) {
            const manifest = this.loadRvcManifest();
            const manifestPython = manifest?.pythonPath ? this.resolvePythonExecutable(manifest.pythonPath) : null;
            const systemPython = await this.resolveExecutable('python');
            const basePython = systemPython || manifestPython;
            if (!basePython) {
                return {
                    success: false,
                    error: 'Python runtime not found. Install Python 3 and make it available in PATH.',
                };
            }

            const createVenv = await this.createIsolatedVenv(venvRoot, basePython);
            if (!createVenv.success || !fs.existsSync(venvPython)) {
                return {
                    success: false,
                    error: `Failed to create Roformer runtime: ${createVenv.error || 'unknown'}`,
                };
            }
            if (createVenv.warning) {
                warnings.push(createVenv.warning);
            }
        }

        const hasNvidiaGpu = await this.hasNvidiaGpuAvailable();
        const probe = await this.probeAudioSeparatorRuntime(venvPython);
        const probeSummary = this.summarizeAudioSeparatorProbe(probe);
        if (probe.success && (!hasNvidiaGpu || this.audioSeparatorProbeUsesGpu(probe))) {
            return {
                success: true,
                pythonExe: venvPython,
                warning: [...warnings, probeSummary].filter(Boolean).join(' ') || undefined,
            };
        }
        if (probe.success && hasNvidiaGpu) {
            warnings.push('Detected CPU-only audio-separator runtime on a CUDA-capable machine. Upgrading runtime to GPU stack.');
            if (probeSummary) {
                warnings.push(`Previous runtime: ${probeSummary}`);
            }
        }

        const pipCheck = await this.runCommand(venvPython, ['-m', 'pip', '--version'], {
            timeoutMs: 20_000,
        });
        if (!pipCheck.success) {
            const ensurePip = await this.runCommand(venvPython, ['-m', 'ensurepip', '--upgrade'], {
                timeoutMs: 3 * 60 * 1000,
            });
            if (!ensurePip.success) {
                return {
                    success: false,
                    error: `pip is unavailable in Roformer runtime: ${this.takeTail(ensurePip.stderr || ensurePip.stdout, 700)}`,
                };
            }
        }

        await this.runCommand(venvPython, ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel'], {
            timeoutMs: 10 * 60 * 1000,
        });
        const install = await this.installAudioSeparatorRuntimeDependencies(venvPython);
        if (!install.success) {
            return {
                success: false,
                error: `Failed to install Roformer runtime: ${this.takeTail(install.stderr || install.stdout, 900)}`,
            };
        }

        const verify = await this.probeAudioSeparatorRuntime(venvPython);
        if (!verify.success) {
            return {
                success: false,
                error: `Roformer installation completed but Separator import failed: ${this.takeTail(verify.stderr || verify.stdout, 700)}`,
            };
        }

        const verifySummary = this.summarizeAudioSeparatorProbe(verify);
        warnings.push('Roformer runtime was auto-installed into isolated environment.');
        return {
            success: true,
            pythonExe: venvPython,
            warning: [...warnings, verifySummary].filter(Boolean).join(' '),
        };
    }

    private probeDnsmosRuntime(pythonExe: string): Promise<CommandResult> {
        return this.runCommand(pythonExe, ['-c', [
            'import numpy',
            'import onnxruntime as ort',
            'preload = getattr(ort, "preload_dlls", None)',
            'if preload: preload()',
            'print("ok")',
            'print("providers=" + ",".join(ort.get_available_providers()))',
        ].join('\n')], {
            timeoutMs: 30_000,
        });
    }

    private parseDnsmosProbe(probe: Pick<CommandResult, 'stdout' | 'stderr'>): {
        providers: string[];
    } {
        const output = [probe.stdout || '', probe.stderr || ''].filter(Boolean).join('\n');
        const providerMatch = output.match(/providers=([^\r\n]+)/i);
        return {
            providers: providerMatch
                ? providerMatch[1].split(',').map((value) => value.trim()).filter(Boolean)
                : [],
        };
    }

    private dnsmosProbeUsesGpu(probe: Pick<CommandResult, 'stdout' | 'stderr'>): boolean {
        return this.parseDnsmosProbe(probe).providers.some((provider) => /CUDAExecutionProvider/i.test(provider));
    }

    private summarizeDnsmosProbe(probe: Pick<CommandResult, 'stdout' | 'stderr'>): string | undefined {
        const parsed = this.parseDnsmosProbe(probe);
        if (parsed.providers.length <= 0) {
            return undefined;
        }
        return `DNSMOS runtime: providers=${parsed.providers.join('/')}`;
    }

    private async ensureDnsmosModels(modelDir: string): Promise<{
        success: boolean;
        primaryModelPath?: string;
        p808ModelPath?: string;
        warning?: string;
        error?: string;
    }> {
        try {
            fs.mkdirSync(modelDir, { recursive: true });
        } catch (error) {
            return {
                success: false,
                error: `Failed to create DNSMOS model directory: ${error instanceof Error ? error.message : String(error)}`,
            };
        }

        const primaryModelPath = path.join(modelDir, 'sig_bak_ovr.onnx');
        const p808ModelPath = path.join(modelDir, 'model_v8.onnx');
        const warnings: string[] = [];

        if (!fs.existsSync(primaryModelPath)) {
            const download = await this.downloadFile(DNSMOS_PRIMARY_MODEL_URL, primaryModelPath);
            if (!download.success || !fs.existsSync(primaryModelPath)) {
                return {
                    success: false,
                    error: `Failed to download DNSMOS primary model: ${download.error || DNSMOS_PRIMARY_MODEL_URL}`,
                };
            }
            warnings.push('DNSMOS primary model was auto-downloaded.');
        }
        if (!fs.existsSync(p808ModelPath)) {
            const download = await this.downloadFile(DNSMOS_P808_MODEL_URL, p808ModelPath);
            if (!download.success || !fs.existsSync(p808ModelPath)) {
                return {
                    success: false,
                    error: `Failed to download DNSMOS P808 model: ${download.error || DNSMOS_P808_MODEL_URL}`,
                };
            }
            warnings.push('DNSMOS P808 model was auto-downloaded.');
        }

        return {
            success: true,
            primaryModelPath,
            p808ModelPath,
            warning: warnings.length > 0 ? warnings.join(' ') : undefined,
        };
    }

    private async installDnsmosRuntimeDependencies(
        pythonExe: string,
        preferGpu: boolean,
    ): Promise<CommandResult> {
        await this.runCommand(pythonExe, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime', 'onnxruntime-gpu'], {
            timeoutMs: 5 * 60 * 1000,
        });
        const installNumpy = await this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'numpy'], {
            timeoutMs: 30 * 60 * 1000,
        });
        if (!installNumpy.success) {
            return installNumpy;
        }
        if (preferGpu) {
            const installGpu = await this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'onnxruntime-gpu'], {
                timeoutMs: 45 * 60 * 1000,
            });
            if (installGpu.success) {
                const probe = await this.probeDnsmosRuntime(pythonExe);
                if (probe.success && this.dnsmosProbeUsesGpu(probe)) {
                    return installGpu;
                }
            }
        }
        return this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'onnxruntime'], {
            timeoutMs: 30 * 60 * 1000,
        });
    }

    private async resolveDnsmosRuntime(): Promise<{
        success: boolean;
        pythonExe?: string;
        env?: NodeJS.ProcessEnv;
        primaryModelPath?: string;
        p808ModelPath?: string;
        warning?: string;
        error?: string;
    }> {
        const runtimeRoot = path.join(this.baseDir, 'runtime');
        const venvRoot = path.join(runtimeRoot, 'dnsmos_venv');
        const modelDir = path.join(runtimeRoot, 'dnsmos_models');
        const venvPython = path.join(venvRoot, 'Scripts', 'python.exe');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const warnings: string[] = [];

        if (!fs.existsSync(venvPython)) {
            const manifest = this.loadRvcManifest();
            const manifestPython = manifest?.pythonPath ? this.resolvePythonExecutable(manifest.pythonPath) : null;
            const systemPython = await this.resolveExecutable('python');
            const basePython = systemPython || manifestPython;
            if (!basePython) {
                return {
                    success: false,
                    error: 'Python runtime not found for DNSMOS.',
                };
            }

            const createVenv = await this.createIsolatedVenv(venvRoot, basePython);
            if (!createVenv.success || !fs.existsSync(venvPython)) {
                return {
                    success: false,
                    error: `Failed to create DNSMOS runtime: ${createVenv.error || 'unknown'}`,
                };
            }
            if (createVenv.warning) {
                warnings.push(createVenv.warning);
            }
        }

        const preferGpu = await this.hasNvidiaGpuAvailable();
        let probe = await this.probeDnsmosRuntime(venvPython);
        if (!probe.success || (preferGpu && !this.dnsmosProbeUsesGpu(probe))) {
            const pipCheck = await this.runCommand(venvPython, ['-m', 'pip', '--version'], {
                timeoutMs: 20_000,
            });
            if (!pipCheck.success) {
                const ensurePip = await this.runCommand(venvPython, ['-m', 'ensurepip', '--upgrade'], {
                    timeoutMs: 3 * 60 * 1000,
                });
                if (!ensurePip.success) {
                    return {
                        success: false,
                        error: `pip is unavailable in DNSMOS runtime: ${this.takeTail(ensurePip.stderr || ensurePip.stdout, 700)}`,
                    };
                }
            }

            await this.runCommand(venvPython, ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel'], {
                timeoutMs: 10 * 60 * 1000,
            });
            const install = await this.installDnsmosRuntimeDependencies(venvPython, preferGpu);
            if (!install.success) {
                return {
                    success: false,
                    error: `Failed to install DNSMOS runtime: ${this.takeTail(install.stderr || install.stdout, 900)}`,
                };
            }
            probe = await this.probeDnsmosRuntime(venvPython);
            if (!probe.success) {
                return {
                    success: false,
                    error: `DNSMOS runtime installation completed but import probe failed: ${this.takeTail(probe.stderr || probe.stdout, 700)}`,
                };
            }
            warnings.push('DNSMOS runtime was auto-installed into isolated environment.');
        }

        const models = await this.ensureDnsmosModels(modelDir);
        if (!models.success || !models.primaryModelPath || !models.p808ModelPath) {
            return {
                success: false,
                error: models.error || 'DNSMOS model files are unavailable.',
            };
        }
        if (models.warning) {
            warnings.push(models.warning);
        }

        const probeSummary = this.summarizeDnsmosProbe(probe);
        return {
            success: true,
            pythonExe: venvPython,
            env: process.env,
            primaryModelPath: models.primaryModelPath,
            p808ModelPath: models.p808ModelPath,
            warning: [...warnings, probeSummary].filter(Boolean).join(' ') || undefined,
        };
    }

    private async computeDnsmosForWav(
        preparedInputPath: string,
        runtimeOverride?: {
            success: boolean;
            pythonExe?: string;
            env?: NodeJS.ProcessEnv;
            primaryModelPath?: string;
            p808ModelPath?: string;
            warning?: string;
            error?: string;
        },
    ): Promise<{
        success: boolean;
        result?: DnsmosInferenceResult;
        warning?: string;
        error?: string;
    }> {
        const runtime = runtimeOverride || await this.resolveDnsmosRuntime();
        if (!runtime.success || !runtime.pythonExe || !runtime.primaryModelPath || !runtime.p808ModelPath) {
            return {
                success: false,
                error: runtime.error || 'DNSMOS runtime unavailable.',
            };
        }

        const script = `
import json
import math
import wave
import numpy as np
import onnxruntime as ort

preload = getattr(ort, "preload_dlls", None)
if preload:
    preload()

INPUT_WAV = r'''${preparedInputPath.replace(/\\/g, '\\\\')}'''
PRIMARY_MODEL = r'''${runtime.primaryModelPath.replace(/\\/g, '\\\\')}'''
P808_MODEL = r'''${runtime.p808ModelPath.replace(/\\/g, '\\\\')}'''
SAMPLING_RATE = 16000
INPUT_LENGTH = 9.01

def hz_to_mel(hz):
    return 2595.0 * math.log10(1.0 + (hz / 700.0))

def mel_to_hz(mel):
    return 700.0 * ((10.0 ** (mel / 2595.0)) - 1.0)

def build_mel_filterbank(sr, n_fft, n_mels, fmin, fmax):
    fft_freqs = np.linspace(0, sr / 2.0, int(n_fft // 2) + 1, dtype=np.float32)
    mel_points = np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2, dtype=np.float32)
    hz_points = np.array([mel_to_hz(m) for m in mel_points], dtype=np.float32)
    bins = np.floor((n_fft + 1) * hz_points / sr).astype(np.int32)
    filters = np.zeros((n_mels, int(n_fft // 2) + 1), dtype=np.float32)
    for i in range(n_mels):
        left = max(0, bins[i])
        center = max(left + 1, bins[i + 1])
        right = max(center + 1, bins[i + 2])
        for j in range(left, min(center, filters.shape[1])):
            filters[i, j] = (j - left) / max(1, center - left)
        for j in range(center, min(right, filters.shape[1])):
            filters[i, j] = (right - j) / max(1, right - center)
        width_hz = max(1.0, hz_points[i + 2] - hz_points[i])
        filters[i, :] *= (2.0 / width_hz)
    return filters

def resample_linear(audio, orig_sr, target_sr):
    if orig_sr == target_sr:
        return audio.astype(np.float32)
    duration = len(audio) / float(orig_sr)
    target_len = max(1, int(round(duration * target_sr)))
    old_x = np.linspace(0.0, duration, num=len(audio), endpoint=False, dtype=np.float64)
    new_x = np.linspace(0.0, duration, num=target_len, endpoint=False, dtype=np.float64)
    return np.interp(new_x, old_x, audio).astype(np.float32)

def read_wav_mono_float(path):
    with wave.open(path, "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frame_count = wav.getnframes()
        raw = wav.readframes(frame_count)
    if sample_width != 2:
        raise RuntimeError(f"DNSMOS requires PCM16 WAV input, got sample_width={sample_width}")
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio.astype(np.float32), sample_rate

def frame_audio(audio, frame_size, hop_length):
    pad = frame_size // 2
    padded = np.pad(audio, (pad, pad), mode="reflect")
    frames = []
    for start in range(0, max(1, len(padded) - frame_size + 1), hop_length):
        frame = padded[start:start + frame_size]
        if len(frame) < frame_size:
            frame = np.pad(frame, (0, frame_size - len(frame)))
        frames.append(frame)
    if not frames:
        frames.append(np.pad(padded[:frame_size], (0, max(0, frame_size - len(padded[:frame_size])))))
    return np.stack(frames, axis=0)

def audio_melspec(audio, sr=16000, n_mels=120, frame_size=320, hop_length=160):
    n_fft = frame_size + 1
    frames = frame_audio(audio, n_fft, hop_length).astype(np.float32)
    window = np.hanning(n_fft).astype(np.float32)
    stft = np.fft.rfft(frames * window[None, :], axis=1)
    power = (np.abs(stft) ** 2).astype(np.float32)
    mel_fb = build_mel_filterbank(sr, n_fft, n_mels, 0.0, sr / 2.0)
    mel_spec = np.maximum(1e-10, np.matmul(power, mel_fb.T))
    ref = np.max(mel_spec) if mel_spec.size else 1.0
    mel_db = 10.0 * np.log10(np.maximum(1e-10, mel_spec)) - 10.0 * math.log10(max(1e-10, float(ref)))
    mel_norm = (mel_db + 40.0) / 40.0
    return mel_norm.astype(np.float32)

def get_polyfit_val(sig, bak, ovr):
    p_ovr = np.poly1d([-0.06766283, 1.11546468, 0.04602535])
    p_sig = np.poly1d([-0.08397278, 1.22083953, 0.0052439])
    p_bak = np.poly1d([-0.13166888, 1.60915514, -0.39604546])
    return float(p_sig(sig)), float(p_bak(bak)), float(p_ovr(ovr))

audio, sr = read_wav_mono_float(INPUT_WAV)
if sr != SAMPLING_RATE:
    audio = resample_linear(audio, sr, SAMPLING_RATE)
actual_len = len(audio)
len_samples = int(INPUT_LENGTH * SAMPLING_RATE)
while len(audio) < len_samples:
    audio = np.concatenate([audio, audio])

num_hops = int(np.floor(len(audio) / SAMPLING_RATE) - INPUT_LENGTH) + 1
hop_len_samples = SAMPLING_RATE

available_providers = ort.get_available_providers()
providers = [provider for provider in ["CUDAExecutionProvider", "CPUExecutionProvider"] if provider in available_providers]
if not providers:
    providers = available_providers
primary_sess = ort.InferenceSession(PRIMARY_MODEL, providers=providers)
p808_sess = ort.InferenceSession(P808_MODEL, providers=providers)
primary_name = primary_sess.get_inputs()[0].name
p808_name = p808_sess.get_inputs()[0].name

pred_sig = []
pred_bak = []
pred_ovr = []
pred_p808 = []

for idx in range(max(1, num_hops)):
    start = int(idx * hop_len_samples)
    end = int((idx + INPUT_LENGTH) * hop_len_samples)
    audio_seg = audio[start:end]
    if len(audio_seg) < len_samples:
        continue
    input_features = np.array(audio_seg, dtype=np.float32)[np.newaxis, :]
    p808_input_features = np.array(audio_melspec(audio_seg[:-160]), dtype=np.float32)[np.newaxis, :, :]
    p808_mos = float(p808_sess.run(None, {p808_name: p808_input_features})[0][0][0])
    mos_sig_raw, mos_bak_raw, mos_ovr_raw = primary_sess.run(None, {primary_name: input_features})[0][0]
    mos_sig, mos_bak, mos_ovr = get_polyfit_val(float(mos_sig_raw), float(mos_bak_raw), float(mos_ovr_raw))
    pred_sig.append(mos_sig)
    pred_bak.append(mos_bak)
    pred_ovr.append(mos_ovr)
    pred_p808.append(p808_mos)

if not pred_sig:
    raise RuntimeError("DNSMOS produced no scoring windows")

print(json.dumps({
    "ok": True,
    "ovrl": float(np.mean(np.array(pred_ovr, dtype=np.float32))),
    "sig": float(np.mean(np.array(pred_sig, dtype=np.float32))),
    "bak": float(np.mean(np.array(pred_bak, dtype=np.float32))),
    "p808": float(np.mean(np.array(pred_p808, dtype=np.float32))),
    "providers": available_providers,
    "session_provider": primary_sess.get_providers(),
    "duration_sec": float(actual_len / SAMPLING_RATE),
}, ensure_ascii=False))
`.trim();

        const result = await this.runCommand(runtime.pythonExe, ['-c', script], {
            env: runtime.env || process.env,
            timeoutMs: 20 * 60 * 1000,
        });
        const report = this.tryParseLastJsonLine<{
            ok?: boolean;
            ovrl?: number;
            sig?: number;
            bak?: number;
            p808?: number;
            providers?: string[];
            session_provider?: string[];
        }>(result.stdout || '');
        if (!result.success || !report?.ok) {
            return {
                success: false,
                warning: runtime.warning,
                error: `DNSMOS inference failed: ${this.takeTail(result.stderr || result.stdout, 500) || 'unknown error'}`,
            };
        }

        const runtimeDetails = Array.isArray(report.session_provider) && report.session_provider.length > 0
            ? `DNSMOS execution: provider=${report.session_provider.join('/')}`
            : undefined;

        return {
            success: true,
            result: {
                ovrl: Number(report.ovrl || 0),
                sig: Number(report.sig || 0),
                bak: Number(report.bak || 0),
                p808: Number(report.p808 || 0),
            },
            warning: runtimeDetails,
        };
    }

    private probeAudioSeparatorRuntime(pythonExe: string): Promise<CommandResult> {
        return this.runCommand(pythonExe, ['-c', [
            'import torch',
            'import onnxruntime as ort',
            'preload = getattr(ort, "preload_dlls", None)',
            'if preload: preload()',
            'from audio_separator.separator import Separator',
            'print("ok")',
            'print("torch_cuda=" + str(torch.cuda.is_available()))',
            'print("ort_providers=" + ",".join(ort.get_available_providers()))',
        ].join('\n')], {
            timeoutMs: 30_000,
        });
    }

    private parseAudioSeparatorProbe(probe: Pick<CommandResult, 'stdout' | 'stderr'>): {
        torchCuda?: boolean;
        providers: string[];
    } {
        const output = [probe.stdout || '', probe.stderr || ''].filter(Boolean).join('\n');
        const torchCudaMatch = output.match(/torch_cuda=(true|false)/i);
        const providerMatch = output.match(/ort_providers=([^\r\n]+)/i);
        return {
            torchCuda: torchCudaMatch ? /^true$/i.test(torchCudaMatch[1]) : undefined,
            providers: providerMatch
                ? providerMatch[1].split(',').map((value) => value.trim()).filter(Boolean)
                : [],
        };
    }

    private audioSeparatorProbeUsesGpu(probe: Pick<CommandResult, 'stdout' | 'stderr'>): boolean {
        const parsed = this.parseAudioSeparatorProbe(probe);
        return parsed.torchCuda === true && parsed.providers.some((provider) => /CUDAExecutionProvider/i.test(provider));
    }

    private summarizeAudioSeparatorProbe(probe: Pick<CommandResult, 'stdout' | 'stderr'>): string | undefined {
        const parsed = this.parseAudioSeparatorProbe(probe);
        const parts: string[] = [];
        if (typeof parsed.torchCuda === 'boolean') {
            parts.push(`torch_cuda=${parsed.torchCuda}`);
        }
        if (parsed.providers.length > 0) {
            parts.push(`providers=${parsed.providers.join('/')}`);
        }
        return parts.length > 0 ? `Audio-separator runtime: ${parts.join(', ')}` : undefined;
    }

    private formatAudioSeparatorRuntimeInfo(report: {
        torch_cuda?: boolean;
        ort_providers?: string[];
        torch_device?: string;
        onnx_provider?: string[] | string;
    } | null | undefined): string | undefined {
        if (!report) {
            return undefined;
        }
        const parts: string[] = [];
        if (typeof report.torch_cuda === 'boolean') {
            parts.push(`torch_cuda=${report.torch_cuda}`);
        }
        if (report.torch_device) {
            parts.push(`torch_device=${report.torch_device}`);
        }
        const onnxProvider = Array.isArray(report.onnx_provider)
            ? report.onnx_provider.join('/')
            : report.onnx_provider;
        if (onnxProvider) {
            parts.push(`onnx_provider=${onnxProvider}`);
        }
        if (report.ort_providers && report.ort_providers.length > 0) {
            parts.push(`providers=${report.ort_providers.join('/')}`);
        }
        return parts.length > 0 ? `Audio-separator execution: ${parts.join(', ')}` : undefined;
    }

    private async installAudioSeparatorRuntimeDependencies(pythonExe: string): Promise<CommandResult> {
        const installAudioSeparator = await this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'audio-separator'], {
            timeoutMs: 60 * 60 * 1000,
        });
        if (!installAudioSeparator.success) {
            return installAudioSeparator;
        }

        if (await this.hasNvidiaGpuAvailable()) {
            const installOnnxRuntimeGpu = await this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'onnxruntime-gpu'], {
                timeoutMs: 45 * 60 * 1000,
            });
            if (installOnnxRuntimeGpu.success) {
                const verifyGpuProbe = await this.probeAudioSeparatorRuntime(pythonExe);
                if (verifyGpuProbe.success && this.audioSeparatorProbeUsesGpu(verifyGpuProbe)) {
                    return installOnnxRuntimeGpu;
                }
            }
            const installGpuStack = await this.installGpuAudioSeparatorRuntimeDependencies(pythonExe);
            if (installGpuStack.success) {
                return installGpuStack;
            }
        }

        const probeAfterBaseInstall = await this.probeAudioSeparatorRuntime(pythonExe);
        if (probeAfterBaseInstall.success) {
            return installAudioSeparator;
        }

        const missingOnnxRuntime = /No module named ['"]onnxruntime['"]/i.test(
            `${probeAfterBaseInstall.stderr}\n${probeAfterBaseInstall.stdout}`,
        );
        if (!missingOnnxRuntime) {
            return probeAfterBaseInstall;
        }

        const installOnnxRuntime = await this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'onnxruntime'], {
            timeoutMs: 30 * 60 * 1000,
        });
        if (!installOnnxRuntime.success) {
            return installOnnxRuntime;
        }

        const verify = await this.probeAudioSeparatorRuntime(pythonExe);
        if (verify.success) {
            return installOnnxRuntime;
        }
        return verify;
    }

    private async installGpuAudioSeparatorRuntimeDependencies(pythonExe: string): Promise<CommandResult> {
        await this.runCommand(pythonExe, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime', 'onnxruntime-gpu'], {
            timeoutMs: 5 * 60 * 1000,
        });
        const installTorch = await this.runCommand(pythonExe, [
            '-m', 'pip', 'install', '--upgrade', '--force-reinstall',
            'torch', 'torchvision',
            '--index-url', AUDIO_SEPARATOR_TORCH_CUDA_INDEX_URL,
        ], {
            timeoutMs: 120 * 60 * 1000,
        });
        if (!installTorch.success) {
            return installTorch;
        }

        const installOnnxRuntimeGpu = await this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'onnxruntime-gpu'], {
            timeoutMs: 45 * 60 * 1000,
        });
        if (!installOnnxRuntimeGpu.success) {
            return installOnnxRuntimeGpu;
        }

        const verify = await this.probeAudioSeparatorRuntime(pythonExe);
        if (verify.success) {
            return installOnnxRuntimeGpu;
        }
        return verify;
    }

    private async hasNvidiaGpuAvailable(): Promise<boolean> {
        const nvidiaSmi = await this.resolveExecutable('nvidia-smi');
        if (!nvidiaSmi) {
            return false;
        }
        const probe = await this.runCommand(nvidiaSmi, ['-L'], { timeoutMs: 15_000 });
        return probe.success && /GPU\s+\d+:/i.test(probe.stdout || '');
    }

    private async resolveDemucsRunner(): Promise<{
        success: boolean;
        command?: string;
        argsPrefix?: string[];
        warning?: string;
        error?: string;
    }> {
        const demucsExecutable = await this.resolveExecutable('demucs');
        if (demucsExecutable) {
            return {
                success: true,
                command: demucsExecutable,
                argsPrefix: [],
            };
        }

        const manifest = this.loadRvcManifest();
        if (!manifest) {
            return {
                success: false,
                error: 'Demucs not found in PATH and RVC install manifest is missing.',
            };
        }

        const pythonExe = this.resolvePythonExecutable(manifest.pythonPath);
        if (!pythonExe) {
            return {
                success: false,
                error: 'RVC Python executable not found for Demucs fallback.',
            };
        }

        const probe = await this.runCommand(pythonExe, ['-m', 'demucs.separate', '--help'], {
            timeoutMs: 20_000,
        });
        if (probe.success) {
            return {
                success: true,
                command: pythonExe,
                argsPrefix: ['-m', 'demucs.separate'],
            };
        }
        const isolatedRunner = await this.resolveIsolatedDemucsRunner(pythonExe);
        if (isolatedRunner.success) {
            return isolatedRunner;
        }

        const pipProbe = await this.runCommand(pythonExe, ['-m', 'pip', '--version'], {
            timeoutMs: 20_000,
        });
        if (!pipProbe.success) {
            return {
                success: false,
                error: `Demucs is unavailable. Isolated runner failed: ${isolatedRunner.error || 'unknown'}`,
            };
        }

        let install = await this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'demucs'], {
            timeoutMs: 40 * 60 * 1000,
        });
        if (!install.success) {
            // pip 24.1+ hard-fails when an installed package has an invalid requirement
            // (e.g. omegaconf 2.0.6 specifies "PyYAML (>=5.1.*)" which is invalid outside == / !=).
            // The hint says to uninstall it; pip uninstall does NOT do dependency resolution so it
            // succeeds even when pip install is blocked.  Uninstall every offending package and retry.
            const installStderr = install.stderr || install.stdout || '';
            const brokenPkgPattern = /Cannot process installed package ([^\s]+)/g;
            const brokenPackages: string[] = [];
            let m: RegExpExecArray | null;
            // eslint-disable-next-line no-cond-assign
            while ((m = brokenPkgPattern.exec(installStderr)) !== null) {
                if (m[1] && !brokenPackages.includes(m[1])) {
                    brokenPackages.push(m[1]);
                }
            }
            if (brokenPackages.length > 0) {
                for (const pkg of brokenPackages) {
                    await this.runCommand(pythonExe, ['-m', 'pip', 'uninstall', '-y', pkg], {
                        timeoutMs: 60_000,
                    });
                }
                install = await this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'demucs'], {
                    timeoutMs: 40 * 60 * 1000,
                });
            }
        }
        if (!install.success) {
            const pipError = this.takeTail(install.stderr || install.stdout, 900);
            return {
                success: false,
                error: `Failed to install Demucs in both isolated and RVC Python envs. Isolated: ${isolatedRunner.error || 'unknown'} | RVC pip: ${pipError}`,
            };
        }

        // Demucs pulls in dora_search which upgrades omegaconf to 2.3.0, breaking RVC model
        // loading (get_ref_type was removed from omegaconf._utils in omegaconf>=2.2).
        // Pin back to 2.1.1 using --no-deps to avoid touching antlr4/PyYAML.
        await this.runCommand(pythonExe, ['-m', 'pip', 'install', '--no-deps', 'omegaconf==2.1.1'], {
            timeoutMs: 60_000,
        });

        const probeAfterInstall = await this.runCommand(pythonExe, ['-m', 'demucs.separate', '--help'], {
            timeoutMs: 20_000,
        });
        if (!probeAfterInstall.success) {
            return {
                success: false,
                error: 'Demucs installation completed but demucs.separate is still unavailable.',
            };
        }

        return {
            success: true,
            command: pythonExe,
            argsPrefix: ['-m', 'demucs.separate'],
            warning: 'Demucs was auto-installed into the RVC Python environment.',
        };
    }

    private async resolveIsolatedDemucsRunner(basePythonExe: string): Promise<{
        success: boolean;
        command?: string;
        argsPrefix?: string[];
        warning?: string;
        error?: string;
    }> {
        const runtimeRoot = path.join(this.baseDir, 'runtime');
        const venvRoot = path.join(runtimeRoot, 'demucs_venv');
        const venvPython = path.join(venvRoot, 'Scripts', 'python.exe');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const warnings: string[] = [];

        if (!fs.existsSync(venvPython)) {
            const createVenv = await this.createIsolatedVenv(venvRoot, basePythonExe);
            if (!createVenv.success || !fs.existsSync(venvPython)) {
                return {
                    success: false,
                    error: `Failed to create isolated Demucs venv: ${createVenv.error || 'unknown'}`,
                };
            }
            if (createVenv.warning) {
                warnings.push(createVenv.warning);
            }
        }

        const probe = await this.runCommand(venvPython, ['-m', 'demucs.separate', '--help'], {
            timeoutMs: 20_000,
        });
        if (probe.success) {
            return {
                success: true,
                command: venvPython,
                argsPrefix: ['-m', 'demucs.separate'],
                warning: [...warnings, 'Using isolated Demucs runtime environment.'].join(' '),
            };
        }

        const pipCheck = await this.runCommand(venvPython, ['-m', 'pip', '--version'], {
            timeoutMs: 20_000,
        });
        if (!pipCheck.success) {
            const ensurePip = await this.runCommand(venvPython, ['-m', 'ensurepip', '--upgrade'], {
                timeoutMs: 3 * 60 * 1000,
            });
            if (!ensurePip.success) {
                return {
                    success: false,
                    error: `pip is unavailable in isolated Demucs venv: ${this.takeTail(ensurePip.stderr || ensurePip.stdout, 700)}`,
                };
            }
        }

        await this.runCommand(venvPython, ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel'], {
            timeoutMs: 10 * 60 * 1000,
        });
        const install = await this.runCommand(venvPython, ['-m', 'pip', 'install', '-U', 'demucs'], {
            timeoutMs: 60 * 60 * 1000,
        });
        if (!install.success) {
            return {
                success: false,
                error: `Failed to install Demucs in isolated venv: ${this.takeTail(install.stderr || install.stdout, 900)}`,
            };
        }

        const verify = await this.runCommand(venvPython, ['-m', 'demucs.separate', '--help'], {
            timeoutMs: 20_000,
        });
        if (!verify.success) {
            return {
                success: false,
                error: 'Isolated Demucs installation completed but demucs.separate is unavailable.',
            };
        }

        return {
            success: true,
            command: venvPython,
            argsPrefix: ['-m', 'demucs.separate'],
            warning: [...warnings, 'Demucs was auto-installed into isolated runtime environment.'].join(' '),
        };
    }

    private async createIsolatedVenv(
        venvRoot: string,
        basePythonExe: string,
    ): Promise<{ success: boolean; warning?: string; error?: string }> {
        const errors: string[] = [];

        const tryCreate = async (
            command: string,
            args: string[],
            warning?: string,
        ): Promise<{ success: boolean; warning?: string; error?: string }> => {
            const create = await this.runCommand(command, args.concat([venvRoot]), {
                timeoutMs: 5 * 60 * 1000,
            });
            if (create.success && fs.existsSync(path.join(venvRoot, 'Scripts', 'python.exe'))) {
                return { success: true, warning };
            }
            errors.push(this.takeTail(create.stderr || create.stdout || `failed: ${command} ${args.join(' ')}`, 500));
            return { success: false };
        };

        let result = await tryCreate(basePythonExe, ['-m', 'venv']);
        if (result.success) {
            return result;
        }

        const systemPython = await this.resolveExecutable('python');
        if (systemPython && path.resolve(systemPython) !== path.resolve(basePythonExe)) {
            result = await tryCreate(systemPython, ['-m', 'venv'], 'Created isolated venv with system python (RVC python lacks venv module).');
            if (result.success) {
                return result;
            }
        }

        const pyLauncher = await this.resolveExecutable('py');
        if (pyLauncher) {
            result = await tryCreate(pyLauncher, ['-3', '-m', 'venv'], 'Created isolated venv with py launcher (RVC python lacks venv module).');
            if (result.success) {
                return result;
            }
        }

        return {
            success: false,
            error: errors.filter(Boolean).join(' | ') || 'No available Python runtime could create venv.',
        };
    }

    // Phase 3: カスタム分離モデル推論スタブ。cfg.scriptPath に実装が用意され次第 spawn 実行に切り替える。
    private async trySeparateWithCustomSeparator(
        sourceAudioPath: string,
        vocalDir: string,
        _accompanimentDir: string,
    ): Promise<{
        success: boolean;
        method?: SeparationMethod;
        vocalWavPath?: string;
        accompanimentWavPath?: string;
        warning?: string;
        error?: string;
    }> {
        const cfg = this.customSeparatorConfig;
        if (!cfg) {
            return { success: false, method: 'custom-separator', error: 'custom separator not configured' };
        }
        if (!fs.existsSync(cfg.venvPythonPath)) {
            return { success: false, method: 'custom-separator', error: `custom separator venv not found: ${cfg.venvPythonPath}` };
        }
        if (!fs.existsSync(cfg.scriptPath)) {
            return { success: false, method: 'custom-separator', error: `custom separator script not found: ${cfg.scriptPath}` };
        }
        if (!fs.existsSync(cfg.modelWeightPath)) {
            return { success: false, method: 'custom-separator', error: `custom separator weight not found: ${cfg.modelWeightPath}` };
        }
        // v0 実装時: spawn(cfg.venvPythonPath, [cfg.scriptPath, '--input', sourceAudioPath, '--vocal-out', vocalOut, '--model', cfg.modelWeightPath])
        // 出力ファイルを検索して { success: true, method: 'custom-separator', vocalWavPath, accompanimentWavPath } を返す
        void sourceAudioPath; void vocalDir;
        return { success: false, method: 'custom-separator', error: `custom separator runtime not yet implemented (model=${cfg.modelVersion})` };
    }

    private async trySeparateWithFfmpegFallback(
        sourceAudioPath: string,
        vocalDir: string,
        accompanimentDir: string,
    ): Promise<{
        success: boolean;
        method?: SeparationMethod;
        vocalWavPath?: string;
        accompanimentWavPath?: string;
        warning?: string;
        error?: string;
    }> {
        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            return {
                success: false,
                error: ffmpegTools.error || 'ffmpeg not found. Install ffmpeg to enable fallback vocal extraction.',
            };
        }
        const ffmpeg = ffmpegTools.ffmpegPath;

        const vocalPath = path.join(vocalDir, `vocal_${Date.now()}.wav`);
        const accompanimentPath = path.join(accompanimentDir, `accompaniment_${Date.now()}.wav`);

        const vocalResult = await this.runCommand(ffmpeg, [
            '-y',
            '-i', sourceAudioPath,
            '-vn',
            '-af', 'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=90,lowpass=f=12000,afftdn=nr=8:nf=-45:tn=1,dynaudnorm=f=250:g=11:p=0.95:m=6,alimiter=limit=0.98',
            '-ar', '44100',
            '-ac', '1',
            vocalPath,
        ], { timeoutMs: 15 * 60 * 1000 });
        if (!vocalResult.success) {
            const basicVocalPath = path.join(vocalDir, `vocal_basic_${Date.now()}.wav`);
            const basicResult = await this.runCommand(ffmpeg, [
                '-y',
                '-i', sourceAudioPath,
                '-vn',
                '-ar', '44100',
                '-ac', '1',
                basicVocalPath,
            ], { timeoutMs: 15 * 60 * 1000 });
            if (basicResult.success && fs.existsSync(basicVocalPath)) {
                return {
                    success: true,
                    method: 'ffmpeg-fallback',
                    vocalWavPath: basicVocalPath,
                    accompanimentWavPath: undefined,
                    warning: [
                        ffmpegTools.warning,
                        'Center/side extraction failed; used basic mono vocal fallback (no strict BGM separation).',
                    ].filter(Boolean).join(' '),
                };
            }

            if (sourceAudioPath.toLowerCase().endsWith('.wav') && fs.existsSync(sourceAudioPath)) {
                const passthroughPath = path.join(vocalDir, `vocal_passthrough_${Date.now()}.wav`);
                try {
                    fs.copyFileSync(sourceAudioPath, passthroughPath);
                    return {
                        success: true,
                        method: 'ffmpeg-fallback',
                        vocalWavPath: passthroughPath,
                        accompanimentWavPath: undefined,
                        warning: [
                            ffmpegTools.warning,
                            'All fallback separations failed; source WAV was reused as vocal training material.',
                        ].filter(Boolean).join(' '),
                    };
                } catch {
                    // Ignore copy failure and return detailed error below.
                }
            }

            return {
                success: false,
                error: `${this.formatCommandFailure('ffmpeg vocal extraction', vocalResult)} | ${this.formatCommandFailure('ffmpeg basic vocal fallback', basicResult)}`,
            };
        }

        const accompanimentResult = await this.runCommand(ffmpeg, [
            '-y',
            '-i', sourceAudioPath,
            '-vn',
            '-af', 'pan=mono|c0=0.5*c0-0.5*c1,highpass=f=40,lowpass=f=12000',
            '-ar', '44100',
            '-ac', '1',
            accompanimentPath,
        ], { timeoutMs: 15 * 60 * 1000 });

        return {
            success: true,
            method: 'ffmpeg-fallback',
            vocalWavPath: vocalPath,
            accompanimentWavPath: accompanimentResult.success ? accompanimentPath : undefined,
            warning: [
                ffmpegTools.warning,
                accompanimentResult.success
                    ? 'Used ffmpeg fallback separation (center/side approximation) with cleanup filters.'
                    : 'Used ffmpeg fallback vocal extraction; accompaniment export failed.',
            ].filter(Boolean).join(' '),
        };
    }

    private async enhanceSeparatedVocalTrack(
        vocalWavPath: string,
        runDir: string,
        sourceAudioPath?: string,
        accompanimentWavPath?: string,
        alternativeCandidates: SeparationQualityCandidate[] = [],
        primaryMethod?: SeparationMethod,
    ): Promise<{ vocalWavPath?: string; warning?: string }> {
        const sourcePath = String(vocalWavPath || '').trim();
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            return { warning: 'Skipped vocal enhancement because separated vocal WAV was not found.' };
        }

        const ffmpegTools = await this.ensureFfmpegTools();
        if (!ffmpegTools.ffmpegPath) {
            return {
                warning: ffmpegTools.error
                    ? `Skipped vocal enhancement: ffmpeg unavailable (${ffmpegTools.error}).`
                    : 'Skipped vocal enhancement: ffmpeg unavailable.',
            };
        }

        const enhancedDir = path.join(runDir, 'enhanced');
        fs.mkdirSync(enhancedDir, { recursive: true });
        const enhancedPath = path.join(enhancedDir, `vocal_enhanced_${Date.now()}.wav`);
        const defaultFilters = [
            'highpass=f=80',
            'lowpass=f=14000',
            'afftdn=nr=7:nf=-45:tn=1',
            'anlmdn=s=6:p=0.002:r=0.006:m=15',
            'adeclick=t=3:w=55:o=75:a=2:m=a',
            'dynaudnorm=f=250:g=9:p=0.95:m=6',
            'alimiter=limit=0.98',
        ].join(',');
        let filters = defaultFilters;
        let metricsSummary = '';
        const enhancementNotes: string[] = [];
        let cleanupInputPath = sourcePath;
        let preDereverbFallbackPath: string | undefined;
        let preparedAccMonoPath: string | undefined;
        let preparedMixMonoPath: string | undefined;
        let leakageForCleanupTuning: number | undefined;

        const analysisDir = path.join(runDir, 'analysis');
        fs.mkdirSync(analysisDir, { recursive: true });
        const stamp = Date.now();
        const preparedVocalMonoPath = path.join(analysisDir, `vocal_enhance_input_full_${stamp}.wav`);
        const preparedVocalMono = await this.runCommand(ffmpegTools.ffmpegPath, [
            '-y',
            '-i', sourcePath,
            '-vn',
            '-ac', '1',
            '-ar', '44100',
            '-c:a', 'pcm_s16le',
            preparedVocalMonoPath,
        ], { timeoutMs: 20 * 60 * 1000 });
        const analysisPrepared = preparedVocalMono.success && fs.existsSync(preparedVocalMonoPath);

        if (analysisPrepared && accompanimentWavPath && fs.existsSync(accompanimentWavPath)) {
            preparedAccMonoPath = path.join(analysisDir, `vocal_enhance_acc_full_${stamp}.wav`);
            if (!fs.existsSync(preparedAccMonoPath)) {
                const preparedAccMono = await this.runCommand(ffmpegTools.ffmpegPath, [
                    '-y',
                    '-i', accompanimentWavPath,
                    '-vn',
                    '-ac', '1',
                    '-ar', '44100',
                    '-c:a', 'pcm_s16le',
                    preparedAccMonoPath,
                ], { timeoutMs: 20 * 60 * 1000 });
                if (!preparedAccMono.success || !fs.existsSync(preparedAccMonoPath)) {
                    preparedAccMonoPath = undefined;
                }
            }
        }

        const sourceMixPath = String(sourceAudioPath || '').trim();
        if (analysisPrepared && sourceMixPath && fs.existsSync(sourceMixPath)) {
            preparedMixMonoPath = path.join(analysisDir, `vocal_enhance_mix_full_${stamp}.wav`);
            if (!fs.existsSync(preparedMixMonoPath)) {
                const preparedMixMono = await this.runCommand(ffmpegTools.ffmpegPath, [
                    '-y',
                    '-i', sourceMixPath,
                    '-vn',
                    '-ac', '1',
                    '-ar', '44100',
                    '-c:a', 'pcm_s16le',
                    preparedMixMonoPath,
                ], { timeoutMs: 20 * 60 * 1000 });
                if (!preparedMixMono.success || !fs.existsSync(preparedMixMonoPath)) {
                    preparedMixMonoPath = undefined;
                    enhancementNotes.push(
                        `Mixture reprojection prep skipped (source mono conversion failed: ${this.takeTail(preparedMixMono.stderr || preparedMixMono.stdout, 220)}).`,
                    );
                }
            }
        }

        if (analysisPrepared && alternativeCandidates.length > 0) {
            const usableAlternativeCandidates = alternativeCandidates.filter((candidate) => {
                const p = String(candidate?.vocalWavPath || '').trim();
                return !!p && fs.existsSync(p) && path.resolve(p) !== path.resolve(sourcePath);
            });
            let ensembleApplied = false;
            for (const altCandidate of usableAlternativeCandidates) {
                const altMonoPath = path.join(analysisDir, `vocal_alt_${altCandidate.method}_${stamp}.wav`);
                const altPrepared = await this.runCommand(ffmpegTools.ffmpegPath, [
                    '-y',
                    '-i', altCandidate.vocalWavPath,
                    '-vn',
                    '-ac', '1',
                    '-ar', '44100',
                    '-c:a', 'pcm_s16le',
                    altMonoPath,
                ], { timeoutMs: 20 * 60 * 1000 });

                let altAccMonoPath: string | undefined;
                if (altPrepared.success && altCandidate.accompanimentWavPath && fs.existsSync(altCandidate.accompanimentWavPath)) {
                    altAccMonoPath = path.join(analysisDir, `vocal_alt_acc_${altCandidate.method}_${stamp}.wav`);
                    const altAccPrepared = await this.runCommand(ffmpegTools.ffmpegPath, [
                        '-y',
                        '-i', altCandidate.accompanimentWavPath,
                        '-vn',
                        '-ac', '1',
                        '-ar', '44100',
                        '-c:a', 'pcm_s16le',
                        altAccMonoPath,
                    ], { timeoutMs: 20 * 60 * 1000 });
                    if (!altAccPrepared.success || !fs.existsSync(altAccMonoPath)) {
                        altAccMonoPath = undefined;
                    }
                }

                if (altPrepared.success && fs.existsSync(altMonoPath)) {
                    const ensemblePath = path.join(enhancedDir, `vocal_ensemble_${Date.now()}.wav`);
                    try {
                        const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(preparedVocalMonoPath);
                        const beforeLeak = preparedAccMonoPath && fs.existsSync(preparedAccMonoPath)
                            ? SeparationQualityLibrary.estimateLeakageCorrelation(preparedVocalMonoPath, preparedAccMonoPath)
                            : 0;
                        const beforeLowBandLeak = preparedAccMonoPath && fs.existsSync(preparedAccMonoPath)
                            ? SeparationQualityLibrary.estimateLowBandLeakageCorrelation(preparedVocalMonoPath, preparedAccMonoPath)
                            : beforeLeak;
                        const beforeHighRoughness = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(preparedVocalMonoPath);
                        const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);

                        const ensembleSummary = SeparationQualityLibrary.mergeVocalCandidatesWithReferenceMonoPcm16Wav(
                            preparedVocalMonoPath,
                            altMonoPath,
                            ensemblePath,
                            preparedAccMonoPath,
                            altAccMonoPath,
                        );

                        const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(ensemblePath);
                        const afterLeak = preparedAccMonoPath && fs.existsSync(preparedAccMonoPath)
                            ? SeparationQualityLibrary.estimateLeakageCorrelation(ensemblePath, preparedAccMonoPath)
                            : 0;
                        const afterLowBandLeak = preparedAccMonoPath && fs.existsSync(preparedAccMonoPath)
                            ? SeparationQualityLibrary.estimateLowBandLeakageCorrelation(ensemblePath, preparedAccMonoPath)
                            : afterLeak;
                        const afterHighRoughness = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(ensemblePath);
                        const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                        const improved = this.shouldAdoptVocalEnsemble(
                            primaryMethod,
                            altCandidate.method,
                            beforeMetrics,
                            afterMetrics,
                            beforeScore,
                            afterScore,
                            beforeLeak,
                            afterLeak,
                            beforeLowBandLeak,
                            afterLowBandLeak,
                            beforeHighRoughness,
                            afterHighRoughness,
                        );

                        if (improved) {
                            cleanupInputPath = ensemblePath;
                            leakageForCleanupTuning = afterLeak;
                            enhancementNotes.push(
                                `Vocal ensemble applied (${primaryMethod || 'primary'} + ${altCandidate.method}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}, rough ${beforeHighRoughness.toFixed(4)}->${afterHighRoughness.toFixed(4)}, corr=${ensembleSummary.avgInterCandidateCorrelation.toFixed(3)}, w=${ensembleSummary.avgPrimaryWeight.toFixed(2)}/${ensembleSummary.avgSecondaryWeight.toFixed(2)}).`,
                            );
                            ensembleApplied = true;
                            break;
                        } else {
                            try { if (fs.existsSync(ensemblePath)) fs.unlinkSync(ensemblePath); } catch {}
                            enhancementNotes.push(
                                `Vocal ensemble not adopted (${primaryMethod || 'primary'} + ${altCandidate.method}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}, rough ${beforeHighRoughness.toFixed(4)}->${afterHighRoughness.toFixed(4)}).`,
                            );
                        }
                    } catch (error) {
                        try { if (fs.existsSync(ensemblePath)) fs.unlinkSync(ensemblePath); } catch {}
                        enhancementNotes.push(`Vocal ensemble skipped (${error instanceof Error ? error.message : String(error)}).`);
                    }
                } else {
                    enhancementNotes.push(
                        `Vocal ensemble skipped (${altCandidate.method} mono conversion failed: ${this.takeTail(altPrepared.stderr || altPrepared.stdout, 220)}).`,
                    );
                }
                if (ensembleApplied) {
                    break;
                }
            }
            if (!ensembleApplied && usableAlternativeCandidates.length === 0) {
                enhancementNotes.push('Vocal ensemble skipped (no usable alternative candidate).');
            }
        }

        if (analysisPrepared && primaryMethod !== 'uvr-ultimate') {
            try {
                const dereverbInputPath = cleanupInputPath === sourcePath ? preparedVocalMonoPath : cleanupInputPath;
                if (!fs.existsSync(dereverbInputPath)) {
                    throw new Error(`dereverb input not found: ${dereverbInputPath}`);
                }

                const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(dereverbInputPath);
                const beforeLeak = preparedAccMonoPath && fs.existsSync(preparedAccMonoPath)
                    ? SeparationQualityLibrary.estimateLeakageCorrelation(dereverbInputPath, preparedAccMonoPath)
                    : 0;
                const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);
                const beforeHighRough = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(dereverbInputPath);
                const dereverbPressure = Math.max(
                    beforeLeak >= 0.050 ? 1 : 0,
                    beforeHighRough >= 0.015 ? 1 : 0,
                    (beforeMetrics.speechActivityRatio >= 0.40 && beforeMetrics.highBandRatio >= 0.17) ? 1 : 0,
                );

                if (dereverbPressure <= 0) {
                    enhancementNotes.push(
                        `Dereverb skipped (pressure low: leak=${beforeLeak.toFixed(3)}, rough=${beforeHighRough.toFixed(4)}, speech=${beforeMetrics.speechActivityRatio.toFixed(2)}).`,
                    );
                } else {
                    const dereverbAttempt = await this.tryDereverbVocalStem(dereverbInputPath, runDir);
                    if (!dereverbAttempt.success || !dereverbAttempt.outputPath || !fs.existsSync(dereverbAttempt.outputPath)) {
                        enhancementNotes.push(
                            `Dereverb skipped (${dereverbAttempt.error || 'model output unavailable'}).`,
                        );
                    } else {
                        const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(dereverbAttempt.outputPath);
                        const afterLeak = preparedAccMonoPath && fs.existsSync(preparedAccMonoPath)
                            ? SeparationQualityLibrary.estimateLeakageCorrelation(dereverbAttempt.outputPath, preparedAccMonoPath)
                            : beforeLeak;
                        const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                        const afterHighRough = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(dereverbAttempt.outputPath);
                        const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
                        const silenceRise = afterMetrics.silenceRatio - beforeMetrics.silenceRatio;
                        const leakImprovement = beforeLeak - afterLeak;
                        const roughImprovement = beforeHighRough - afterHighRough;
                        const highLoss = beforeMetrics.highBandRatio - afterMetrics.highBandRatio;
                        const rmsDrop = beforeMetrics.rmsDb - afterMetrics.rmsDb;
                        const regressionSafe = (
                            speechDrop <= 0.022
                            && silenceRise <= 0.035
                            && highLoss <= 0.030
                            && rmsDrop <= 1.8
                        );
                        const improved = regressionSafe && (
                            afterScore.score >= beforeScore.score + 0.8
                            || leakImprovement >= 0.012
                            || roughImprovement >= 0.00045
                            || (roughImprovement >= 0.00028 && leakImprovement >= 0.004)
                            || (
                                afterScore.score >= beforeScore.score - 0.25
                                && leakImprovement >= 0.008
                                && speechDrop <= 0.015
                            )
                        );

                        if (improved) {
                            const previousCleanupPath = cleanupInputPath;
                            preDereverbFallbackPath = dereverbInputPath;
                            if (
                                previousCleanupPath !== sourcePath
                                && previousCleanupPath !== preparedVocalMonoPath
                                && previousCleanupPath !== dereverbAttempt.outputPath
                            ) {
                                try { if (fs.existsSync(previousCleanupPath)) fs.unlinkSync(previousCleanupPath); } catch {}
                            }
                            cleanupInputPath = dereverbAttempt.outputPath;
                            leakageForCleanupTuning = afterLeak;
                            enhancementNotes.push(
                                `Dereverb applied (${dereverbAttempt.model || 'auto'}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, rough ${beforeHighRough.toFixed(4)}->${afterHighRough.toFixed(4)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}).`,
                            );
                        } else {
                            try { if (fs.existsSync(dereverbAttempt.outputPath)) fs.unlinkSync(dereverbAttempt.outputPath); } catch {}
                            enhancementNotes.push(
                                `Dereverb not adopted (${dereverbAttempt.model || 'auto'}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, rough ${beforeHighRough.toFixed(4)}->${afterHighRough.toFixed(4)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}).`,
                            );
                        }

                        if (dereverbAttempt.warning) {
                            enhancementNotes.push(`Dereverb runtime: ${dereverbAttempt.warning}`);
                        }
                    }
                }
            } catch (error) {
                enhancementNotes.push(`Dereverb skipped (${error instanceof Error ? error.message : String(error)}).`);
            }
        }

        if (preparedMixMonoPath && preparedAccMonoPath && fs.existsSync(preparedMixMonoPath) && fs.existsSync(preparedAccMonoPath)) {
            const reprojInputPath = cleanupInputPath === sourcePath ? preparedVocalMonoPath : cleanupInputPath;
            if (fs.existsSync(reprojInputPath)) {
                const reprojVocalPath = path.join(enhancedDir, `vocal_reproject_${stamp}.wav`);
                const reprojAccPath = path.join(enhancedDir, `acc_reproject_${stamp}.wav`);
                try {
                    const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(reprojInputPath);
                    const beforeLeak = SeparationQualityLibrary.estimateLeakageCorrelation(reprojInputPath, preparedAccMonoPath);
                    const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);
                    const beforeLow = beforeMetrics.lowBandRatio;

                    const reprojSummary = SeparationQualityLibrary.refineWithOriginalMixtureMonoPcm16Wav(
                        preparedMixMonoPath,
                        reprojInputPath,
                        preparedAccMonoPath,
                        reprojVocalPath,
                        reprojAccPath,
                    );

                    const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(reprojVocalPath);
                    const afterLeak = SeparationQualityLibrary.estimateLeakageCorrelation(reprojVocalPath, reprojAccPath);
                    const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                    const lowImproved = beforeLow - afterMetrics.lowBandRatio;
                    const leakImproved = beforeLeak - afterLeak;
                    const scoreDrop = beforeScore.score - afterScore.score;
                    const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
                    const silenceRise = afterMetrics.silenceRatio - beforeMetrics.silenceRatio;
                    const lowWorsened = afterMetrics.lowBandRatio - beforeLow;
                    const bgmSuppressRatio = reprojSummary.frameCount > 0
                        ? (reprojSummary.bgmOnlySuppressedFrames / reprojSummary.frameCount)
                        : 0;
                    const regressionSafe = (
                        scoreDrop <= 2.5
                        && speechDrop <= 0.035
                        && silenceRise <= 0.07
                        && lowWorsened <= 0.06
                        && bgmSuppressRatio <= (beforeMetrics.speechActivityRatio < 0.50 ? 0.18 : 0.30)
                    );
                    const improved = regressionSafe && (
                        afterScore.score >= beforeScore.score + 0.8
                        || leakImproved >= 0.015
                        || lowImproved >= 0.020
                        || (afterScore.score >= beforeScore.score - 0.5 && leakImproved >= 0.010 && lowImproved >= 0.012)
                    );

                    if (improved) {
                        if (cleanupInputPath !== sourcePath && cleanupInputPath !== reprojInputPath) {
                            try { if (fs.existsSync(cleanupInputPath)) fs.unlinkSync(cleanupInputPath); } catch {}
                        }
                        cleanupInputPath = reprojVocalPath;
                        if (preparedAccMonoPath !== reprojAccPath) {
                            try { if (preparedAccMonoPath && fs.existsSync(preparedAccMonoPath)) fs.unlinkSync(preparedAccMonoPath); } catch {}
                            preparedAccMonoPath = reprojAccPath;
                        }
                        leakageForCleanupTuning = afterLeak;
                        enhancementNotes.push(
                            `Mixture reprojection applied (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, low ${beforeLow.toFixed(2)}->${afterMetrics.lowBandRatio.toFixed(2)}, lag=${reprojSummary.estimatedLagMs.toFixed(1)}ms, g=${reprojSummary.avgVocalGain.toFixed(2)}/${reprojSummary.avgAccompanimentGain.toFixed(2)}, bgmFrames=${reprojSummary.bgmOnlySuppressedFrames}).`,
                        );
                    } else {
                        try { if (fs.existsSync(reprojVocalPath)) fs.unlinkSync(reprojVocalPath); } catch {}
                        try { if (fs.existsSync(reprojAccPath)) fs.unlinkSync(reprojAccPath); } catch {}
                        enhancementNotes.push(
                            `Mixture reprojection not adopted (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, low ${beforeLow.toFixed(2)}->${afterMetrics.lowBandRatio.toFixed(2)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}, bgmRatio=${bgmSuppressRatio.toFixed(2)}).`,
                        );
                    }
                } catch (error) {
                    try { if (fs.existsSync(reprojVocalPath)) fs.unlinkSync(reprojVocalPath); } catch {}
                    try { if (fs.existsSync(reprojAccPath)) fs.unlinkSync(reprojAccPath); } catch {}
                    enhancementNotes.push(`Mixture reprojection skipped (${error instanceof Error ? error.message : String(error)}).`);
                }
            } else {
                enhancementNotes.push('Mixture reprojection skipped (input vocal mono not found).');
            }
        }

        if (preparedMixMonoPath && preparedAccMonoPath && fs.existsSync(preparedMixMonoPath) && fs.existsSync(preparedAccMonoPath)) {
            const subbandInputPath = cleanupInputPath === sourcePath ? preparedVocalMonoPath : cleanupInputPath;
            if (fs.existsSync(subbandInputPath)) {
                const subbandVocalPath = path.join(enhancedDir, `vocal_subband_reproject_${stamp}.wav`);
                const subbandAccPath = path.join(enhancedDir, `acc_subband_reproject_${stamp}.wav`);
                try {
                    const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(subbandInputPath);
                    const beforeLeak = SeparationQualityLibrary.estimateLeakageCorrelation(subbandInputPath, preparedAccMonoPath);
                    const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);
                    const beforeLow = beforeMetrics.lowBandRatio;
                    const beforeHigh = beforeMetrics.highBandRatio;
                    const beforeHighRough = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(subbandInputPath);
                    const beforeLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                        subbandInputPath,
                        preparedAccMonoPath,
                    );

                    const subbandSummary = SeparationQualityLibrary.refineWithOriginalMixtureSubbandMaskMonoPcm16Wav(
                        preparedMixMonoPath,
                        subbandInputPath,
                        preparedAccMonoPath,
                        subbandVocalPath,
                        subbandAccPath,
                    );

                    const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(subbandVocalPath);
                    const afterLeak = SeparationQualityLibrary.estimateLeakageCorrelation(subbandVocalPath, subbandAccPath);
                    const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                    const afterHighRough = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(subbandVocalPath);
                    const afterLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                        subbandVocalPath,
                        subbandAccPath,
                    );
                    const lowImproved = beforeLow - afterMetrics.lowBandRatio;
                    const highImproved = beforeHigh - afterMetrics.highBandRatio;
                    const highRoughDelta = afterHighRough - beforeHighRough;
                    const leakImproved = beforeLeak - afterLeak;
                    const lowBandLeakImproved = beforeLowBandLeak - afterLowBandLeak;
                    const scoreDrop = beforeScore.score - afterScore.score;
                    const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
                    const silenceRise = afterMetrics.silenceRatio - beforeMetrics.silenceRatio;
                    const lowWorsened = afterMetrics.lowBandRatio - beforeLow;
                    const leakWorsened = afterLeak - beforeLeak;
                    const lowBandLeakWorsened = afterLowBandLeak - beforeLowBandLeak;
                    const bgmSuppressRatio = subbandSummary.frameCount > 0
                        ? (subbandSummary.bgmOnlySuppressedFrames / subbandSummary.frameCount)
                        : 0;
                    const regressionSafe = (
                        scoreDrop <= 2.0
                        && speechDrop <= 0.030
                        && silenceRise <= 0.06
                        && lowWorsened <= 0.05
                        && leakWorsened <= 0.025
                        && lowBandLeakWorsened <= 0.012
                        && highRoughDelta <= Math.max(0.00045, beforeHighRough * 0.18)
                        && bgmSuppressRatio <= (beforeMetrics.speechActivityRatio < 0.50 ? 0.20 : 0.32)
                    );
                    const improved = regressionSafe && (
                        afterScore.score >= beforeScore.score + 0.8
                        || leakImproved >= 0.012
                        || lowBandLeakImproved >= 0.010
                        || lowImproved >= 0.018
                        || (afterScore.score >= beforeScore.score - 0.4 && lowImproved >= 0.010 && highImproved >= 0.010)
                        || (lowImproved >= 0.012 && highRoughDelta <= 0.00020 && leakWorsened <= 0.010 && lowBandLeakWorsened <= 0.006)
                    );

                    if (improved) {
                        if (cleanupInputPath !== sourcePath && cleanupInputPath !== subbandInputPath) {
                            try { if (fs.existsSync(cleanupInputPath)) fs.unlinkSync(cleanupInputPath); } catch {}
                        }
                        cleanupInputPath = subbandVocalPath;
                        if (preparedAccMonoPath !== subbandAccPath) {
                            try { if (preparedAccMonoPath && fs.existsSync(preparedAccMonoPath)) fs.unlinkSync(preparedAccMonoPath); } catch {}
                            preparedAccMonoPath = subbandAccPath;
                        }
                        leakageForCleanupTuning = afterLeak;
                        enhancementNotes.push(
                            `Subband reprojection applied (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, low ${beforeLow.toFixed(2)}->${afterMetrics.lowBandRatio.toFixed(2)}, high ${beforeHigh.toFixed(2)}->${afterMetrics.highBandRatio.toFixed(2)}, rough ${beforeHighRough.toFixed(4)}->${afterHighRough.toFixed(4)}, lag=${subbandSummary.estimatedLagMs.toFixed(1)}ms, m4=${subbandSummary.avgSubLowMask.toFixed(2)}/${subbandSummary.avgLowMask.toFixed(2)}/${subbandSummary.avgMidMask.toFixed(2)}/${subbandSummary.avgHighMask.toFixed(2)}, hDelta=${subbandSummary.avgHighMaskDelta.toFixed(3)}/${subbandSummary.maxHighMaskDelta.toFixed(3)}(#${subbandSummary.highMaskDeltaLimitedFrames}), hSm=${subbandSummary.avgHighSmoothBlend.toFixed(2)}(#${subbandSummary.highStrongSmoothFrames}), vib=${subbandSummary.avgVibratoProxy.toFixed(2)}(#${subbandSummary.vibratoGuardFrames}), pBl=${subbandSummary.avgProtectBlend.toFixed(2)}(+${subbandSummary.avgHighProtectBoost.toFixed(2)},r=${subbandSummary.highProtectBoostRatio.toFixed(2)}), bgmFrames=${subbandSummary.bgmOnlySuppressedFrames}, lowBgmFrames=${subbandSummary.lowBgmPriorityFrames}).`,
                        );
                    } else {
                        try { if (fs.existsSync(subbandVocalPath)) fs.unlinkSync(subbandVocalPath); } catch {}
                        try { if (fs.existsSync(subbandAccPath)) fs.unlinkSync(subbandAccPath); } catch {}
                        enhancementNotes.push(
                            `Subband reprojection not adopted (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, low ${beforeLow.toFixed(2)}->${afterMetrics.lowBandRatio.toFixed(2)}, high ${beforeHigh.toFixed(2)}->${afterMetrics.highBandRatio.toFixed(2)}, rough ${beforeHighRough.toFixed(4)}->${afterHighRough.toFixed(4)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}, hDelta=${subbandSummary.avgHighMaskDelta.toFixed(3)}/${subbandSummary.maxHighMaskDelta.toFixed(3)}(#${subbandSummary.highMaskDeltaLimitedFrames}), hSm=${subbandSummary.avgHighSmoothBlend.toFixed(2)}(#${subbandSummary.highStrongSmoothFrames}), vib=${subbandSummary.avgVibratoProxy.toFixed(2)}(#${subbandSummary.vibratoGuardFrames}), pBl=${subbandSummary.avgProtectBlend.toFixed(2)}(+${subbandSummary.avgHighProtectBoost.toFixed(2)},r=${subbandSummary.highProtectBoostRatio.toFixed(2)}), bgmRatio=${bgmSuppressRatio.toFixed(2)}, lowBgmFrames=${subbandSummary.lowBgmPriorityFrames}).`,
                        );
                    }
                } catch (error) {
                    try { if (fs.existsSync(subbandVocalPath)) fs.unlinkSync(subbandVocalPath); } catch {}
                    try { if (fs.existsSync(subbandAccPath)) fs.unlinkSync(subbandAccPath); } catch {}
                    enhancementNotes.push(`Subband reprojection skipped (${error instanceof Error ? error.message : String(error)}).`);
                }
            } else {
                enhancementNotes.push('Subband reprojection skipped (input vocal mono not found).');
            }
        }

        if (analysisPrepared && preparedAccMonoPath && fs.existsSync(preparedAccMonoPath)) {
                const debleedPath = path.join(enhancedDir, `vocal_debleed_ref_${stamp}.wav`);
                try {
                    const debleedInputPath = cleanupInputPath === sourcePath ? preparedVocalMonoPath : cleanupInputPath;
                    if (!fs.existsSync(debleedInputPath)) {
                        throw new Error(`de-bleed input not found: ${debleedInputPath}`);
                    }
                    const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(debleedInputPath);
                    const beforeLeak = SeparationQualityLibrary.estimateLeakageCorrelation(
                        debleedInputPath,
                        preparedAccMonoPath,
                    );
                    const beforeHighRough = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(
                        debleedInputPath,
                    );
                    const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);

                    const debleedSummary = SeparationQualityLibrary.reduceBleedWithReferenceMonoPcm16Wav(
                        debleedInputPath,
                        preparedAccMonoPath,
                        debleedPath,
                    );

                    const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(debleedPath);
                    const afterLeak = SeparationQualityLibrary.estimateLeakageCorrelation(
                        debleedPath,
                        preparedAccMonoPath,
                    );
                    const afterHighRough = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(
                        debleedPath,
                    );
                    const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                    leakageForCleanupTuning = afterLeak;
                    const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
                    const highRoughWorsened = afterHighRough - beforeHighRough;
                    const regressionSafe = speechDrop <= 0.028 && highRoughWorsened <= 0.00075;

                    const improved = regressionSafe && (
                        afterScore.score >= beforeScore.score + 1.2
                        || afterLeak <= beforeLeak - 0.025
                        || (
                            afterLeak <= beforeLeak - 0.012
                            && speechDrop <= 0.020
                            && afterMetrics.highBandRatio <= beforeMetrics.highBandRatio + 0.008
                            && highRoughWorsened <= 0.00035
                        )
                        || (
                            afterScore.score >= beforeScore.score - 0.25
                            && afterLeak < beforeLeak - 0.008
                            && afterMetrics.highBandRatio <= beforeMetrics.highBandRatio
                            && speechDrop <= 0.015
                        )
                    );

                    if (improved) {
                        cleanupInputPath = debleedPath;
                        enhancementNotes.push(
                            `Reference de-bleed applied (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, avgGain=${debleedSummary.avgAbsLeakGain.toFixed(3)}, highGain=${debleedSummary.avgAbsHighLeakGain.toFixed(3)}).`,
                        );
                    } else {
                        try { if (fs.existsSync(debleedPath)) fs.unlinkSync(debleedPath); } catch {}
                        enhancementNotes.push(
                            `Reference de-bleed not adopted (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}, rough ${beforeHighRough.toFixed(4)}->${afterHighRough.toFixed(4)}).`,
                        );
                    }
                } catch (error) {
                    enhancementNotes.push(`Reference de-bleed skipped (${error instanceof Error ? error.message : String(error)}).`);
                }
        }

        if (preparedAccMonoPath && fs.existsSync(preparedAccMonoPath) && fs.existsSync(cleanupInputPath)) {
            const musicOnlyTrimPath = path.join(enhancedDir, `vocal_music_only_removed_${stamp}.wav`);
            try {
                let musicRemovalInputPath = cleanupInputPath;
                if (musicRemovalInputPath === sourcePath && analysisPrepared) {
                    // Demucs/UVR outputs may be float WAV. Use the pre-rendered mono PCM16 version for
                    // reference-based music-only trimming when no prior de-bleed artifact was adopted.
                    musicRemovalInputPath = preparedVocalMonoPath;
                }

                if (!fs.existsSync(musicRemovalInputPath)) {
                    throw new Error(`Music-only removal input not found: ${musicRemovalInputPath}`);
                }

                const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(musicRemovalInputPath);
                const beforeLeak = SeparationQualityLibrary.estimateLeakageCorrelation(musicRemovalInputPath, preparedAccMonoPath);
                const beforeLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                    musicRemovalInputPath,
                    preparedAccMonoPath,
                );
                const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);
                const bassVocalProtectBias = this.clampNumber(
                    (beforeMetrics.speechActivityRatio < 0.55 ? 0.03 : 0)
                    + Math.max(0, beforeMetrics.lowBandRatio - 0.10) * 0.35
                    - Math.max(0, beforeLeak - 0.14) * 0.08,
                    0,
                    0.10,
                    0.03,
                );
                const timelineSuppressionGain = this.clampNumber(
                    beforeMetrics.speechActivityRatio >= 0.62
                        ? (beforeLeak >= 0.12 ? 0.22 : 0.28)
                        : beforeMetrics.speechActivityRatio >= 0.50
                            ? (beforeLeak >= 0.12 ? 0.26 : 0.32)
                            : (beforeLeak >= 0.12 ? 0.48 : 0.58),
                    0.24,
                    0.70,
                    0.34,
                ) + bassVocalProtectBias;
                const timelineSuppressionGainClamped = this.clampNumber(timelineSuppressionGain, 0.24, 0.78, 0.36);
                const trimSummary = SeparationQualityLibrary.removeMusicOnlySectionsWithReferenceMonoPcm16Wav(
                    musicRemovalInputPath,
                    preparedAccMonoPath,
                    musicOnlyTrimPath,
                    { preserveTimeline: true, preserveTimelineAttenuation: timelineSuppressionGainClamped },
                );
                const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(musicOnlyTrimPath);
                const afterLeak = SeparationQualityLibrary.estimateLeakageCorrelation(musicOnlyTrimPath, preparedAccMonoPath);
                const afterLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                    musicOnlyTrimPath,
                    preparedAccMonoPath,
                );
                const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                const leakImprovementAbs = beforeLeak - afterLeak;
                const leakImprovementRatio = beforeLeak > 1e-6 ? (leakImprovementAbs / beforeLeak) : 0;
                const lowBandLeakImprovementAbs = beforeLowBandLeak - afterLowBandLeak;
                const lowBandLeakWorsened = afterLowBandLeak - beforeLowBandLeak;
                const totalBeforeMs = Math.max(1, beforeMetrics.durationMs || (trimSummary.outputDurationMs + trimSummary.removedDurationMs));
                const removedRatio = trimSummary.removedDurationMs / totalBeforeMs;
                const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
                const silenceRise = afterMetrics.silenceRatio - beforeMetrics.silenceRatio;
                const midBandDrop = beforeMetrics.midBandRatio - afterMetrics.midBandRatio;
                const likelyContinuousVocal = beforeMetrics.speechActivityRatio >= 0.52;
                const continuitySafe = (
                    speechDrop <= 0.05
                    && silenceRise <= 0.10
                    && midBandDrop <= 0.06
                    && lowBandLeakWorsened <= 0.010
                );
                const aggressiveTrimOnContinuousVocal = likelyContinuousVocal && (
                    removedRatio >= 0.05
                    || trimSummary.removedSegments >= 8
                ) && (
                    speechDrop > 0.015
                    || silenceRise > 0.04
                    || midBandDrop > 0.025
                );
                const overSuppressionOnSparseVocal = (
                    beforeMetrics.speechActivityRatio < 0.48
                    && removedRatio >= 0.18
                    && (
                        leakImprovementAbs < 0.010
                        || speechDrop > 0.01
                        || midBandDrop > 0.02
                    )
                );

                const removedEnough = trimSummary.removedDurationMs >= 500;
                const removedSome = trimSummary.removedDurationMs >= 180;
                const outputStillUsable = trimSummary.outputDurationMs >= 15_000
                    && trimSummary.outputDurationMs >= Math.round(trimSummary.outputDurationMs + trimSummary.removedDurationMs > 0
                        ? (trimSummary.outputDurationMs + trimSummary.removedDurationMs) * 0.18
                        : 15_000);
                const improved = outputStillUsable && continuitySafe && !aggressiveTrimOnContinuousVocal && !overSuppressionOnSparseVocal && (
                    afterScore.score >= beforeScore.score + 1.0
                    || afterLeak <= beforeLeak - 0.025
                    || afterLowBandLeak <= beforeLowBandLeak - 0.010
                    || (removedSome && leakImprovementRatio >= 0.15)
                    || (removedSome && lowBandLeakImprovementAbs >= 0.008)
                    || leakImprovementAbs >= 0.010
                    || (afterScore.score >= beforeScore.score && afterLeak < beforeLeak && trimSummary.zeroedShortGapDurationMs >= 120)
                    || (removedEnough && afterScore.score >= beforeScore.score - 1.0)
                );

                if (improved) {
                    if (cleanupInputPath !== sourcePath) {
                        try { if (fs.existsSync(cleanupInputPath)) fs.unlinkSync(cleanupInputPath); } catch {}
                    }
                    cleanupInputPath = musicOnlyTrimPath;
                    leakageForCleanupTuning = afterLeak;
                    enhancementNotes.push(
                        `Music-only section removal applied (timeline-preserved, suppressed ${trimSummary.removedDurationMs}ms in ${trimSummary.removedSegments} segments, gain=${timelineSuppressionGainClamped.toFixed(2)}, output ${trimSummary.outputDurationMs}ms, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}).`,
                    );
                } else {
                    try { if (fs.existsSync(musicOnlyTrimPath)) fs.unlinkSync(musicOnlyTrimPath); } catch {}
                    enhancementNotes.push(
                        `Music-only section removal not adopted (timeline-preserved, suppressed ${trimSummary.removedDurationMs}ms @gain=${timelineSuppressionGainClamped.toFixed(2)}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}).`,
                    );
                }
            } catch (error) {
                enhancementNotes.push(`Music-only section removal skipped (${error instanceof Error ? error.message : String(error)}).`);
                try { if (fs.existsSync(musicOnlyTrimPath)) fs.unlinkSync(musicOnlyTrimPath); } catch {}
            }
        }

        if (preparedAccMonoPath && fs.existsSync(preparedAccMonoPath) && fs.existsSync(cleanupInputPath)) {
            const residualMusicTrimPath = path.join(enhancedDir, `vocal_music_only_removed_residual_${stamp}.wav`);
            try {
                const residualInputPath = cleanupInputPath === sourcePath && analysisPrepared
                    ? preparedVocalMonoPath
                    : cleanupInputPath;
                if (!fs.existsSync(residualInputPath)) {
                    throw new Error(`Residual music-only cleanup input not found: ${residualInputPath}`);
                }

                const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(residualInputPath);
                const beforeLeak = SeparationQualityLibrary.estimateLeakageCorrelation(residualInputPath, preparedAccMonoPath);
                const beforeLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                    residualInputPath,
                    preparedAccMonoPath,
                );
                const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);
                const beforePerceptual = SeparationQualityLibrary.analyzePerceptualQualityMonoPcm16Wav(residualInputPath);
                const residualCleanupPressure = this.clampNumber(
                    Math.max(0, beforeLeak - 0.09) * 2.8
                    + Math.max(0, beforeLowBandLeak - 0.08) * 2.2
                    + Math.max(0, beforeMetrics.silenceRatio - 0.34) * 0.8
                    - Math.max(0, beforeMetrics.speechActivityRatio - 0.66) * 0.35,
                    0,
                    1.8,
                    0,
                );
                const residualSuppressionGainBase = beforeMetrics.speechActivityRatio >= 0.62
                    ? (beforeLeak >= 0.10 ? 0.14 : 0.18)
                    : beforeMetrics.speechActivityRatio >= 0.50
                        ? (beforeLeak >= 0.10 ? 0.18 : 0.22)
                        : (beforeLeak >= 0.10 ? 0.24 : 0.32);
                const residualSuppressionGain = this.clampNumber(
                    residualSuppressionGainBase
                    - (residualCleanupPressure * 0.06)
                    + (beforeMetrics.speechActivityRatio >= 0.70 ? 0.02 : 0),
                    0.08,
                    0.40,
                    0.20,
                );
                const trimSummary = SeparationQualityLibrary.removeMusicOnlySectionsWithReferenceMonoPcm16Wav(
                    residualInputPath,
                    preparedAccMonoPath,
                    residualMusicTrimPath,
                    { preserveTimeline: true, preserveTimelineAttenuation: residualSuppressionGain },
                );
                const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(residualMusicTrimPath);
                const afterLeak = SeparationQualityLibrary.estimateLeakageCorrelation(residualMusicTrimPath, preparedAccMonoPath);
                const afterLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                    residualMusicTrimPath,
                    preparedAccMonoPath,
                );
                const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                const afterPerceptual = SeparationQualityLibrary.analyzePerceptualQualityMonoPcm16Wav(residualMusicTrimPath);
                const leakImprovementAbs = beforeLeak - afterLeak;
                const lowBandLeakImprovementAbs = beforeLowBandLeak - afterLowBandLeak;
                const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
                const silenceRise = afterMetrics.silenceRatio - beforeMetrics.silenceRatio;
                const midBandDrop = beforeMetrics.midBandRatio - afterMetrics.midBandRatio;
                const artifactRise = afterPerceptual.artifactScore - beforePerceptual.artifactScore;
                const roughRise = afterPerceptual.highBandRoughness - beforePerceptual.highBandRoughness;
                const outputStillUsable = trimSummary.outputDurationMs >= 15_000;
                const regressionSafe = (
                    speechDrop <= 0.03
                    && silenceRise <= 0.08
                    && midBandDrop <= 0.035
                    && artifactRise <= 0.025
                    && roughRise <= 0.0008
                );
                const improved = outputStillUsable && regressionSafe && (
                    afterScore.score >= beforeScore.score + 0.5
                    || leakImprovementAbs >= 0.008
                    || afterLowBandLeak <= beforeLowBandLeak - 0.005
                    || (
                        trimSummary.removedDurationMs >= 120
                        && leakImprovementAbs >= 0.005
                        && lowBandLeakImprovementAbs >= 0.002
                        && artifactRise <= 0.010
                    )
                    || (
                        trimSummary.removedSegments >= 2
                        && leakImprovementAbs >= 0.006
                        && speechDrop <= 0.016
                    )
                    || (
                        beforePerceptual.artifactScore >= 0.11
                        && afterPerceptual.artifactScore <= beforePerceptual.artifactScore - 0.015
                        && leakImprovementAbs >= 0.003
                    )
                );

                if (improved) {
                    if (cleanupInputPath !== sourcePath && cleanupInputPath !== residualInputPath) {
                        try { if (fs.existsSync(cleanupInputPath)) fs.unlinkSync(cleanupInputPath); } catch {}
                    }
                    cleanupInputPath = residualMusicTrimPath;
                    leakageForCleanupTuning = afterLeak;
                    enhancementNotes.push(
                        `Residual music-only cleanup applied (suppressed ${trimSummary.removedDurationMs}ms in ${trimSummary.removedSegments} segments, gain=${residualSuppressionGain.toFixed(2)}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, artifact ${beforePerceptual.artifactScore.toFixed(3)}->${afterPerceptual.artifactScore.toFixed(3)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}).`,
                    );
                } else {
                    try { if (fs.existsSync(residualMusicTrimPath)) fs.unlinkSync(residualMusicTrimPath); } catch {}
                    enhancementNotes.push(
                        `Residual music-only cleanup not adopted (suppressed ${trimSummary.removedDurationMs}ms in ${trimSummary.removedSegments} segments, gain=${residualSuppressionGain.toFixed(2)}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, artifact ${beforePerceptual.artifactScore.toFixed(3)}->${afterPerceptual.artifactScore.toFixed(3)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}).`,
                    );
                }
            } catch (error) {
                enhancementNotes.push(`Residual music-only cleanup skipped (${error instanceof Error ? error.message : String(error)}).`);
                try { if (fs.existsSync(residualMusicTrimPath)) fs.unlinkSync(residualMusicTrimPath); } catch {}
            }
        }

        if (fs.existsSync(cleanupInputPath)) {
            const highSmoothInputPath = cleanupInputPath === sourcePath
                ? (analysisPrepared ? preparedVocalMonoPath : cleanupInputPath)
                : cleanupInputPath;
            if (fs.existsSync(highSmoothInputPath)) {
                const highSmoothPath = path.join(enhancedDir, `vocal_high_smooth_${stamp}.wav`);
                try {
                    const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(highSmoothInputPath);
                    const beforeLeak = (preparedAccMonoPath && fs.existsSync(preparedAccMonoPath))
                        ? SeparationQualityLibrary.estimateLeakageCorrelation(highSmoothInputPath, preparedAccMonoPath)
                        : 0;
                    const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);
                    const smoothingSummary = SeparationQualityLibrary.smoothHarshHighBandMonoPcm16Wav(
                        highSmoothInputPath,
                        highSmoothPath,
                    );
                    const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(highSmoothPath);
                    const afterLeak = (preparedAccMonoPath && fs.existsSync(preparedAccMonoPath))
                        ? SeparationQualityLibrary.estimateLeakageCorrelation(highSmoothPath, preparedAccMonoPath)
                        : beforeLeak;
                    const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);

                    const highImproved = beforeMetrics.highBandRatio - afterMetrics.highBandRatio;
                    const roughImproved = smoothingSummary.roughnessBefore - smoothingSummary.roughnessAfter;
                    const scoreDrop = beforeScore.score - afterScore.score;
                    const leakWorsened = afterLeak - beforeLeak;
                    const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
                    const improved = (
                        highImproved >= 0.012
                        || (highImproved >= 0.006 && roughImproved >= 0.00035)
                        || (smoothingSummary.roughnessAfter <= smoothingSummary.roughnessBefore * 0.90 && highImproved >= 0.004)
                        || (
                            roughImproved >= 0.00048
                            && beforeMetrics.highBandRatio >= 0.22
                            && smoothingSummary.avgAmount >= 0.10
                        )
                    ) && scoreDrop <= 1.2 && leakWorsened <= 0.018 && speechDrop <= 0.035;

                    if (improved) {
                        if (cleanupInputPath !== sourcePath && cleanupInputPath !== highSmoothInputPath) {
                            try { if (fs.existsSync(cleanupInputPath)) fs.unlinkSync(cleanupInputPath); } catch {}
                        }
                        cleanupInputPath = highSmoothPath;
                        enhancementNotes.push(
                            `High-band smoothing applied (high ${beforeMetrics.highBandRatio.toFixed(2)}->${afterMetrics.highBandRatio.toFixed(2)}, rough ${smoothingSummary.roughnessBefore.toFixed(4)}->${smoothingSummary.roughnessAfter.toFixed(4)}, amt=${smoothingSummary.avgAmount.toFixed(2)}, leak ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}).`,
                        );
                    } else {
                        try { if (fs.existsSync(highSmoothPath)) fs.unlinkSync(highSmoothPath); } catch {}
                        enhancementNotes.push(
                            `High-band smoothing not adopted (high ${beforeMetrics.highBandRatio.toFixed(2)}->${afterMetrics.highBandRatio.toFixed(2)}, rough ${smoothingSummary.roughnessBefore.toFixed(4)}->${smoothingSummary.roughnessAfter.toFixed(4)}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}).`,
                        );
                    }
                } catch (error) {
                    try { if (fs.existsSync(highSmoothPath)) fs.unlinkSync(highSmoothPath); } catch {}
                    enhancementNotes.push(`High-band smoothing skipped (${error instanceof Error ? error.message : String(error)}).`);
                }
            }
        }

        const analysisMonoPath = cleanupInputPath !== sourcePath
            ? cleanupInputPath
            : (analysisPrepared ? preparedVocalMonoPath : path.join(analysisDir, `vocal_enhance_input_${stamp}.wav`));
        const analysisReady = (
            (cleanupInputPath !== sourcePath && fs.existsSync(analysisMonoPath))
            || (cleanupInputPath === sourcePath && analysisPrepared)
            || await this.renderAnalysisMonoPcm16(
                ffmpegTools.ffmpegPath,
                cleanupInputPath,
                analysisMonoPath,
            )
        );
        if (analysisReady) {
            try {
                const metrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(analysisMonoPath);
                const perceptualMetrics = SeparationQualityLibrary.analyzePerceptualQualityMonoPcm16Wav(analysisMonoPath);
                const highBandRoughness = perceptualMetrics.highBandRoughness;
                const lowBandLeakForCleanup = (preparedAccMonoPath && fs.existsSync(preparedAccMonoPath))
                    ? SeparationQualityLibrary.estimateLowBandLeakageCorrelation(analysisMonoPath, preparedAccMonoPath)
                    : undefined;
                filters = SeparationQualityLibrary.buildAdaptiveFilterChain(metrics, {
                    highBandRoughness,
                    leakageCorrelation: leakageForCleanupTuning,
                    lowBandLeakageCorrelation: lowBandLeakForCleanup,
                });
                const lowBleedRisk = (
                    metrics.lowBandRatio > 0.38
                    || (typeof leakageForCleanupTuning === 'number' && leakageForCleanupTuning > 0.20)
                    || (typeof lowBandLeakForCleanup === 'number' && lowBandLeakForCleanup > 0.16)
                );
                if (lowBleedRisk) {
                    const extraHighpassHz = Math.max(
                        85,
                        Math.min(
                            180,
                            Math.round(
                                92
                                + Math.max(0, metrics.lowBandRatio - 0.30) * 220
                                + Math.max(0, (leakageForCleanupTuning ?? 0) - 0.14) * 150,
                            ),
                        ),
                    );
                    const continuousSinging = metrics.speechActivityRatio >= 0.42;
                    const lowBleedSevere = (
                        metrics.lowBandRatio > 0.52
                        || (typeof leakageForCleanupTuning === 'number' && leakageForCleanupTuning > 0.28)
                    );
                    const gateSafe = (
                        lowBleedSevere
                        && metrics.speechActivityRatio < 0.18
                        && metrics.silenceRatio > 0.55
                        && metrics.midBandRatio < 0.22
                    );
                    const lowBleedGuardFilters = gateSafe
                        ? [
                            `highpass=f=${extraHighpassHz}:poles=2`,
                            // Very soft gate; only enabled on low speech-activity tracks with severe low bleed.
                            'agate=threshold=0.0055:ratio=1.35:attack=16:release=260:range=0.86:makeup=1',
                        ]
                        : [
                            `highpass=f=${Math.max(75, extraHighpassHz - (continuousSinging ? 26 : 10) - (metrics.lowBandRatio > 0.18 ? 8 : 0))}:poles=2`,
                        ];
                    filters = [
                        ...lowBleedGuardFilters,
                        filters,
                    ].join(',');
                    enhancementNotes.push(
                        `Low-end bleed guard enabled (${gateSafe ? 'mode=hp+soft-gate' : 'mode=soft-hp'}, extra highpass=${extraHighpassHz}Hz${typeof leakageForCleanupTuning === 'number' ? `, leakage=${leakageForCleanupTuning.toFixed(3)}` : ''}).`,
                    );
                }
                metricsSummary = `Adaptive cleanup tuned from analysis (rms=${metrics.rmsDb.toFixed(2)}dB, low=${metrics.lowBandRatio.toFixed(2)}, high=${metrics.highBandRatio.toFixed(2)}, rough=${highBandRoughness.toFixed(4)}, flux=${perceptualMetrics.highBandFluxVariance.toFixed(4)}, artifact=${perceptualMetrics.artifactScore.toFixed(3)}, reverb=${perceptualMetrics.reverbTailRatio.toFixed(3)}, nearClip=${metrics.nearClipRatio.toFixed(4)}, speech=${metrics.speechActivityRatio.toFixed(2)}${typeof lowBandLeakForCleanup === 'number' ? `, lowLeak=${lowBandLeakForCleanup.toFixed(3)}` : ''}).`;
            } catch {
                // Keep default filters when analysis fails.
            }
        }

        let result = await this.runCommand(ffmpegTools.ffmpegPath, [
            '-y',
            '-i', cleanupInputPath,
            '-vn',
            '-af', filters,
            '-ar', '44100',
            '-ac', '1',
            enhancedPath,
        ], { timeoutMs: 20 * 60 * 1000 });

        if ((!result.success || !fs.existsSync(enhancedPath)) && filters !== defaultFilters) {
            result = await this.runCommand(ffmpegTools.ffmpegPath, [
                '-y',
                '-i', cleanupInputPath,
                '-vn',
                '-af', defaultFilters,
                '-ar', '44100',
                '-ac', '1',
                enhancedPath,
            ], { timeoutMs: 20 * 60 * 1000 });
        }

        if (!result.success || !fs.existsSync(enhancedPath)) {
            return {
                warning: `Vocal enhancement failed; using original separation (${this.takeTail(result.stderr || result.stdout, 320)}).`,
            };
        }

        let finalEnhancedPath = enhancedPath;
        try {
            const postSmoothPath = path.join(enhancedDir, `vocal_enhanced_post_high_smooth_${stamp}.wav`);
            const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(enhancedPath);
            // Final cleanup can reintroduce slight harshness via normalization/limiting.
            // Run a second, conservative high-band smoothing pass and adopt only on clear improvement.
            const smoothingSummary = SeparationQualityLibrary.smoothHarshHighBandMonoPcm16Wav(
                enhancedPath,
                postSmoothPath,
            );
            const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(postSmoothPath);
            const highImproved = beforeMetrics.highBandRatio - afterMetrics.highBandRatio;
            const roughImproved = smoothingSummary.roughnessBefore - smoothingSummary.roughnessAfter;
            const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
            const rmsDiff = Math.abs(afterMetrics.rmsDb - beforeMetrics.rmsDb);
            const crestDiff = Math.abs(afterMetrics.crestFactorDb - beforeMetrics.crestFactorDb);
            const improved = (
                highImproved >= 0.010
                || (highImproved >= 0.005 && roughImproved >= 0.00030)
                || (smoothingSummary.roughnessAfter <= smoothingSummary.roughnessBefore * 0.92 && highImproved >= 0.0035)
                || (
                    roughImproved >= 0.00040
                    && beforeMetrics.highBandRatio >= 0.20
                    && smoothingSummary.avgAmount >= 0.09
                )
            ) && speechDrop <= 0.03 && rmsDiff <= 1.0 && crestDiff <= 2.4;

            if (improved) {
                finalEnhancedPath = postSmoothPath;
                enhancementNotes.push(
                    `Post-cleanup high-band smoothing applied (high ${beforeMetrics.highBandRatio.toFixed(2)}->${afterMetrics.highBandRatio.toFixed(2)}, rough ${smoothingSummary.roughnessBefore.toFixed(4)}->${smoothingSummary.roughnessAfter.toFixed(4)}, amt=${smoothingSummary.avgAmount.toFixed(2)}).`,
                );
            } else {
                try { if (fs.existsSync(postSmoothPath)) fs.unlinkSync(postSmoothPath); } catch {}
                enhancementNotes.push(
                    `Post-cleanup high-band smoothing not adopted (high ${beforeMetrics.highBandRatio.toFixed(2)}->${afterMetrics.highBandRatio.toFixed(2)}, rough ${smoothingSummary.roughnessBefore.toFixed(4)}->${smoothingSummary.roughnessAfter.toFixed(4)}).`,
                );
            }
        } catch (error) {
            enhancementNotes.push(`Post-cleanup high-band smoothing skipped (${error instanceof Error ? error.message : String(error)}).`);
        }

        if (preparedAccMonoPath && fs.existsSync(preparedAccMonoPath) && fs.existsSync(finalEnhancedPath)) {
            const postCleanupDebleedPath = path.join(enhancedDir, `vocal_enhanced_post_debleed_${stamp}.wav`);
            try {
                const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(finalEnhancedPath);
                const beforePerceptual = SeparationQualityLibrary.analyzePerceptualQualityMonoPcm16Wav(finalEnhancedPath);
                const beforeLeak = SeparationQualityLibrary.estimateLeakageCorrelation(
                    finalEnhancedPath,
                    preparedAccMonoPath,
                );
                const beforeLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                    finalEnhancedPath,
                    preparedAccMonoPath,
                );
                const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);
                const postCleanupBleedPressure = this.clampNumber(
                    Math.max(0, beforeLeak - 0.075) * 2.8
                    + Math.max(0, beforeLowBandLeak - 0.055) * 2.3
                    + Math.max(0, beforePerceptual.artifactScore - 0.11) * 0.9
                    - Math.max(0, beforeMetrics.speechActivityRatio - 0.70) * 0.4,
                    0,
                    1.8,
                    0,
                );

                if (postCleanupBleedPressure > 0.04) {
                    const debleedSummary = SeparationQualityLibrary.reduceBleedWithReferenceMonoPcm16Wav(
                        finalEnhancedPath,
                        preparedAccMonoPath,
                        postCleanupDebleedPath,
                    );
                    const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(postCleanupDebleedPath);
                    const afterPerceptual = SeparationQualityLibrary.analyzePerceptualQualityMonoPcm16Wav(postCleanupDebleedPath);
                    const afterLeak = SeparationQualityLibrary.estimateLeakageCorrelation(
                        postCleanupDebleedPath,
                        preparedAccMonoPath,
                    );
                    const afterLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                        postCleanupDebleedPath,
                        preparedAccMonoPath,
                    );
                    const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                    const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
                    const artifactRise = afterPerceptual.artifactScore - beforePerceptual.artifactScore;
                    const roughRise = afterPerceptual.highBandRoughness - beforePerceptual.highBandRoughness;
                    const leakImprovement = beforeLeak - afterLeak;
                    const lowLeakImprovement = beforeLowBandLeak - afterLowBandLeak;
                    const regressionSafe = (
                        speechDrop <= 0.02
                        && artifactRise <= 0.020
                        && roughRise <= 0.00075
                        && Math.abs(afterMetrics.rmsDb - beforeMetrics.rmsDb) <= 1.2
                    );
                    const improved = regressionSafe && (
                        afterScore.score >= beforeScore.score + 0.45
                        || leakImprovement >= 0.010
                        || lowLeakImprovement >= 0.006
                        || (
                            leakImprovement >= 0.006
                            && debleedSummary.avgAbsHighLeakGain >= 0.010
                            && artifactRise <= 0.010
                        )
                        || (
                            beforePerceptual.artifactScore >= 0.12
                            && afterPerceptual.artifactScore <= beforePerceptual.artifactScore - 0.015
                            && leakImprovement >= 0.003
                        )
                    );

                    if (improved) {
                        const previousFinalPath = finalEnhancedPath;
                        finalEnhancedPath = postCleanupDebleedPath;
                        if (previousFinalPath !== enhancedPath && previousFinalPath !== postCleanupDebleedPath) {
                            this.removeFileIfExists(previousFinalPath);
                        }
                        enhancementNotes.push(
                            `Post-cleanup de-bleed applied (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, artifact ${beforePerceptual.artifactScore.toFixed(3)}->${afterPerceptual.artifactScore.toFixed(3)}, highGain=${debleedSummary.avgAbsHighLeakGain.toFixed(3)}).`,
                        );
                    } else {
                        this.removeFileIfExists(postCleanupDebleedPath);
                        enhancementNotes.push(
                            `Post-cleanup de-bleed not adopted (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, artifact ${beforePerceptual.artifactScore.toFixed(3)}->${afterPerceptual.artifactScore.toFixed(3)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}).`,
                        );
                    }
                } else {
                    enhancementNotes.push(
                        `Post-cleanup de-bleed skipped (pressure=${postCleanupBleedPressure.toFixed(2)}, leakage=${beforeLeak.toFixed(3)}, lowLeak=${beforeLowBandLeak.toFixed(3)}).`,
                    );
                }
            } catch (error) {
                this.removeFileIfExists(postCleanupDebleedPath);
                enhancementNotes.push(`Post-cleanup de-bleed skipped (${error instanceof Error ? error.message : String(error)}).`);
            }
        }

        if (preparedAccMonoPath && fs.existsSync(preparedAccMonoPath) && fs.existsSync(finalEnhancedPath)) {
            const postCleanupResidualMusicPath = path.join(enhancedDir, `vocal_enhanced_post_music_only_${stamp}.wav`);
            try {
                const beforeMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(finalEnhancedPath);
                const beforePerceptual = SeparationQualityLibrary.analyzePerceptualQualityMonoPcm16Wav(finalEnhancedPath);
                const beforeLeak = SeparationQualityLibrary.estimateLeakageCorrelation(
                    finalEnhancedPath,
                    preparedAccMonoPath,
                );
                const beforeLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                    finalEnhancedPath,
                    preparedAccMonoPath,
                );
                const beforeScore = SeparationQualityLibrary.scoreFromMetrics(beforeMetrics, beforeLeak);
                const residualPressure = this.clampNumber(
                    Math.max(0, beforeLeak - 0.070) * 3.0
                    + Math.max(0, beforeLowBandLeak - 0.050) * 2.4
                    + Math.max(0, beforeMetrics.silenceRatio - 0.34) * 0.7
                    + Math.max(0, beforePerceptual.artifactScore - 0.10) * 0.8
                    - Math.max(0, beforeMetrics.speechActivityRatio - 0.68) * 0.45,
                    0,
                    1.9,
                    0,
                );
                if (residualPressure > 0.05) {
                    const residualSuppressionGain = this.clampNumber(
                        0.22 - (residualPressure * 0.06) + (beforeMetrics.speechActivityRatio >= 0.72 ? 0.02 : 0),
                        0.08,
                        0.30,
                        0.18,
                    );
                    const trimSummary = SeparationQualityLibrary.removeMusicOnlySectionsWithReferenceMonoPcm16Wav(
                        finalEnhancedPath,
                        preparedAccMonoPath,
                        postCleanupResidualMusicPath,
                        { preserveTimeline: true, preserveTimelineAttenuation: residualSuppressionGain },
                    );
                    const afterMetrics = SeparationQualityLibrary.analyzeMonoPcm16Wav(postCleanupResidualMusicPath);
                    const afterPerceptual = SeparationQualityLibrary.analyzePerceptualQualityMonoPcm16Wav(postCleanupResidualMusicPath);
                    const afterLeak = SeparationQualityLibrary.estimateLeakageCorrelation(
                        postCleanupResidualMusicPath,
                        preparedAccMonoPath,
                    );
                    const afterLowBandLeak = SeparationQualityLibrary.estimateLowBandLeakageCorrelation(
                        postCleanupResidualMusicPath,
                        preparedAccMonoPath,
                    );
                    const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                    const speechDrop = beforeMetrics.speechActivityRatio - afterMetrics.speechActivityRatio;
                    const silenceRise = afterMetrics.silenceRatio - beforeMetrics.silenceRatio;
                    const artifactRise = afterPerceptual.artifactScore - beforePerceptual.artifactScore;
                    const roughRise = afterPerceptual.highBandRoughness - beforePerceptual.highBandRoughness;
                    const leakImprovement = beforeLeak - afterLeak;
                    const lowLeakImprovement = beforeLowBandLeak - afterLowBandLeak;
                    const regressionSafe = (
                        speechDrop <= 0.018
                        && silenceRise <= 0.05
                        && artifactRise <= 0.018
                        && roughRise <= 0.0007
                    );
                    const improved = regressionSafe && (
                        afterScore.score >= beforeScore.score + 0.35
                        || leakImprovement >= 0.008
                        || lowLeakImprovement >= 0.005
                        || (
                            trimSummary.removedDurationMs >= 120
                            && leakImprovement >= 0.004
                            && afterPerceptual.artifactScore <= beforePerceptual.artifactScore + 0.006
                        )
                        || (
                            trimSummary.removedSegments >= 2
                            && leakImprovement >= 0.005
                            && speechDrop <= 0.012
                        )
                    );

                    if (improved) {
                        const previousFinalPath = finalEnhancedPath;
                        finalEnhancedPath = postCleanupResidualMusicPath;
                        if (previousFinalPath !== enhancedPath && previousFinalPath !== postCleanupResidualMusicPath) {
                            this.removeFileIfExists(previousFinalPath);
                        }
                        enhancementNotes.push(
                            `Post-cleanup residual music-only cleanup applied (suppressed ${trimSummary.removedDurationMs}ms in ${trimSummary.removedSegments} segments, gain=${residualSuppressionGain.toFixed(2)}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, artifact ${beforePerceptual.artifactScore.toFixed(3)}->${afterPerceptual.artifactScore.toFixed(3)}).`,
                        );
                    } else {
                        this.removeFileIfExists(postCleanupResidualMusicPath);
                        enhancementNotes.push(
                            `Post-cleanup residual music-only cleanup not adopted (suppressed ${trimSummary.removedDurationMs}ms in ${trimSummary.removedSegments} segments, gain=${residualSuppressionGain.toFixed(2)}, score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, lowLeak ${beforeLowBandLeak.toFixed(3)}->${afterLowBandLeak.toFixed(3)}, artifact ${beforePerceptual.artifactScore.toFixed(3)}->${afterPerceptual.artifactScore.toFixed(3)}, speech ${beforeMetrics.speechActivityRatio.toFixed(2)}->${afterMetrics.speechActivityRatio.toFixed(2)}).`,
                        );
                    }
                } else {
                    enhancementNotes.push(
                        `Post-cleanup residual music-only cleanup skipped (pressure=${residualPressure.toFixed(2)}, leakage=${beforeLeak.toFixed(3)}, lowLeak=${beforeLowBandLeak.toFixed(3)}).`,
                    );
                }
            } catch (error) {
                this.removeFileIfExists(postCleanupResidualMusicPath);
                enhancementNotes.push(`Post-cleanup residual music-only cleanup skipped (${error instanceof Error ? error.message : String(error)}).`);
            }
        }

        try {
            const currentQa = this.analyzeCanonicalQaMetrics(finalEnhancedPath);
            const softFail = this.evaluateCanonicalQaSoftFail(currentQa);
            if (softFail.softFail) {
                let qaRecovered = false;

                const fallbackCandidate = alternativeCandidates.find((candidate) => {
                    const p = String(candidate?.vocalWavPath || '').trim();
                    return !!p && fs.existsSync(p) && path.resolve(p) !== path.resolve(sourcePath);
                });
                if (fallbackCandidate?.vocalWavPath) {
                    const fallbackCandidatePath = path.join(enhancedDir, `vocal_qa_fallback_${fallbackCandidate.method}_${stamp}.wav`);
                    const renderedFallback = await this.renderCanonicalQaFallback(
                        ffmpegTools.ffmpegPath,
                        fallbackCandidate.vocalWavPath,
                        fallbackCandidatePath,
                        defaultFilters,
                    );
                    if (renderedFallback) {
                        const fallbackQa = this.analyzeCanonicalQaMetrics(fallbackCandidatePath);
                        if (this.shouldAdoptCanonicalQaFallback(currentQa, fallbackQa)) {
                            finalEnhancedPath = fallbackCandidatePath;
                            qaRecovered = true;
                            enhancementNotes.push(
                                `Canonical QA fallback applied (2nd candidate=${fallbackCandidate.method}, artifact ${currentQa.perceptualMetrics.artifactScore.toFixed(3)}->${fallbackQa.perceptualMetrics.artifactScore.toFixed(3)}, reverb ${currentQa.perceptualMetrics.reverbTailRatio.toFixed(3)}->${fallbackQa.perceptualMetrics.reverbTailRatio.toFixed(3)}, speech ${currentQa.stemMetrics.speechActivityRatio.toFixed(2)}->${fallbackQa.stemMetrics.speechActivityRatio.toFixed(2)}).`,
                            );
                        } else {
                            this.removeFileIfExists(fallbackCandidatePath);
                            enhancementNotes.push(
                                `Canonical QA fallback not adopted (2nd candidate=${fallbackCandidate.method}, artifact ${currentQa.perceptualMetrics.artifactScore.toFixed(3)}->${fallbackQa.perceptualMetrics.artifactScore.toFixed(3)}, reverb ${currentQa.perceptualMetrics.reverbTailRatio.toFixed(3)}->${fallbackQa.perceptualMetrics.reverbTailRatio.toFixed(3)}, speech ${currentQa.stemMetrics.speechActivityRatio.toFixed(2)}->${fallbackQa.stemMetrics.speechActivityRatio.toFixed(2)}).`,
                            );
                        }
                    } else {
                        this.removeFileIfExists(fallbackCandidatePath);
                        enhancementNotes.push(`Canonical QA fallback skipped (2nd candidate=${fallbackCandidate.method} render failed).`);
                    }
                }

                if (!qaRecovered && preDereverbFallbackPath && fs.existsSync(preDereverbFallbackPath)) {
                    const dereverbRollbackPath = path.join(enhancedDir, `vocal_qa_fallback_pre_dereverb_${stamp}.wav`);
                    const renderedRollback = await this.renderCanonicalQaFallback(
                        ffmpegTools.ffmpegPath,
                        preDereverbFallbackPath,
                        dereverbRollbackPath,
                        defaultFilters,
                    );
                    if (renderedRollback) {
                        const rollbackQa = this.analyzeCanonicalQaMetrics(dereverbRollbackPath);
                        if (this.shouldAdoptCanonicalQaFallback(currentQa, rollbackQa)) {
                            finalEnhancedPath = dereverbRollbackPath;
                            qaRecovered = true;
                            enhancementNotes.push(
                                `Canonical QA fallback applied (pre-dereverb stem, artifact ${currentQa.perceptualMetrics.artifactScore.toFixed(3)}->${rollbackQa.perceptualMetrics.artifactScore.toFixed(3)}, reverb ${currentQa.perceptualMetrics.reverbTailRatio.toFixed(3)}->${rollbackQa.perceptualMetrics.reverbTailRatio.toFixed(3)}, speech ${currentQa.stemMetrics.speechActivityRatio.toFixed(2)}->${rollbackQa.stemMetrics.speechActivityRatio.toFixed(2)}).`,
                            );
                        } else {
                            this.removeFileIfExists(dereverbRollbackPath);
                            enhancementNotes.push(
                                `Canonical QA fallback not adopted (pre-dereverb stem, artifact ${currentQa.perceptualMetrics.artifactScore.toFixed(3)}->${rollbackQa.perceptualMetrics.artifactScore.toFixed(3)}, reverb ${currentQa.perceptualMetrics.reverbTailRatio.toFixed(3)}->${rollbackQa.perceptualMetrics.reverbTailRatio.toFixed(3)}, speech ${currentQa.stemMetrics.speechActivityRatio.toFixed(2)}->${rollbackQa.stemMetrics.speechActivityRatio.toFixed(2)}).`,
                            );
                        }
                    } else {
                        this.removeFileIfExists(dereverbRollbackPath);
                        enhancementNotes.push('Canonical QA fallback skipped (pre-dereverb stem render failed).');
                    }
                }

                if (!qaRecovered) {
                    enhancementNotes.push(
                        `Canonical QA soft-fail retained current stem (${softFail.reason || 'artifact/reverb threshold exceeded'}, artifact=${currentQa.perceptualMetrics.artifactScore.toFixed(3)}, reverb=${currentQa.perceptualMetrics.reverbTailRatio.toFixed(3)}, speech=${currentQa.stemMetrics.speechActivityRatio.toFixed(2)}).`,
                    );
                }
            }
        } catch (error) {
            enhancementNotes.push(`Canonical QA gate skipped (${error instanceof Error ? error.message : String(error)}).`);
        }

        return {
            vocalWavPath: finalEnhancedPath,
            warning: [
                ffmpegTools.warning,
                ...enhancementNotes,
                metricsSummary || undefined,
                'Applied vocal cleanup (reference de-bleed + adaptive cleanup + denoise + dynamic normalize + limiter).',
            ].filter(Boolean).join(' '),
        };
    }

    private async ensureFfmpegTools(): Promise<{
        ffmpegPath?: string;
        ffprobePath?: string;
        warning?: string;
        error?: string;
    }> {
        const existingFfmpeg = await this.resolveExecutable('ffmpeg');
        const existingFfprobe = await this.resolveExecutable('ffprobe');
        if (existingFfmpeg && existingFfprobe) {
            const verify = await this.verifyFfmpegPair(existingFfmpeg, existingFfprobe);
            if (verify.success) {
                return {
                    ffmpegPath: existingFfmpeg,
                    ffprobePath: existingFfprobe,
                };
            }
        }

        const install = await this.installPortableFfmpeg();
        if (!install.success) {
            return {
                error: install.error || 'Portable ffmpeg installation failed.',
            };
        }

        const ffmpegPath = install.ffmpegPath || await this.resolveExecutable('ffmpeg');
        const ffprobePath = install.ffprobePath || await this.resolveExecutable('ffprobe');
        if (!ffmpegPath || !ffprobePath) {
            return {
                error: 'ffmpeg installation completed but ffmpeg/ffprobe were not found.',
            };
        }
        const verifyInstalled = await this.verifyFfmpegPair(ffmpegPath, ffprobePath);
        if (!verifyInstalled.success) {
            return {
                error: verifyInstalled.error || 'ffmpeg installation completed but executable health check failed.',
            };
        }

        return {
            ffmpegPath,
            ffprobePath,
            warning: install.warning,
        };
    }

    private async installPortableFfmpeg(): Promise<{
        success: boolean;
        ffmpegPath?: string;
        ffprobePath?: string;
        warning?: string;
        error?: string;
    }> {
        const runtimeRoot = path.join(this.baseDir, 'runtime');
        const ffmpegRoot = path.join(runtimeRoot, 'ffmpeg');
        const binDir = path.join(ffmpegRoot, 'bin');
        const ffmpegPath = path.join(binDir, 'ffmpeg.exe');
        const ffprobePath = path.join(binDir, 'ffprobe.exe');
        if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
            const verify = await this.verifyFfmpegPair(ffmpegPath, ffprobePath);
            if (verify.success) {
                return {
                    success: true,
                    ffmpegPath,
                    ffprobePath,
                };
            }
        }

        fs.mkdirSync(ffmpegRoot, { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        let release: any;
        try {
            release = await this.fetchJson('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest');
        } catch (error) {
            return {
                success: false,
                error: `Failed to query ffmpeg release metadata: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        const assets = Array.isArray(release?.assets) ? release.assets as Array<Record<string, unknown>> : [];
        const preferredAssetNames = [
            'ffmpeg-master-latest-win64-lgpl.zip',
            'ffmpeg-master-latest-win64-gpl.zip',
            'ffmpeg-master-latest-win64-lgpl-shared.zip',
            'ffmpeg-master-latest-win64-gpl-shared.zip',
            'ffmpeg-n8.0-latest-win64-lgpl-8.0.zip',
            'ffmpeg-n8.0-latest-win64-gpl-8.0.zip',
            'ffmpeg-n7.1-latest-win64-lgpl-7.1.zip',
            'ffmpeg-n7.1-latest-win64-gpl-7.1.zip',
        ];
        const selected = preferredAssetNames
            .map((assetName) => assets.find((asset) => String(asset?.name || '') === assetName))
            .find(Boolean)
            || assets.find((asset) => String(asset?.name || '').toLowerCase().includes('win64') && String(asset?.name || '').toLowerCase().endsWith('.zip'));
        const downloadUrl = selected ? String(selected.browser_download_url || '') : '';
        if (!downloadUrl) {
            return {
                success: false,
                error: 'Could not resolve a Windows ffmpeg build URL from BtbN release metadata.',
            };
        }

        const zipPath = path.join(ffmpegRoot, 'ffmpeg_latest.zip');
        const download = await this.downloadFile(downloadUrl, zipPath);
        if (!download.success) {
            return {
                success: false,
                error: `Failed to download ffmpeg package: ${download.error || 'unknown'}`,
            };
        }

        const extractDir = path.join(ffmpegRoot, 'extract');
        fs.mkdirSync(extractDir, { recursive: true });
        try {
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(extractDir, true);
        } catch (error) {
            return {
                success: false,
                error: `Failed to extract ffmpeg zip: ${error instanceof Error ? error.message : String(error)}`,
            };
        }

        const extractedFiles = this.collectFilesRecursive(extractDir);
        const extractedFfmpeg = extractedFiles.find((filePath) => filePath.toLowerCase().endsWith('\\ffmpeg.exe') || filePath.toLowerCase().endsWith('/ffmpeg.exe'));
        const extractedFfprobe = extractedFiles.find((filePath) => filePath.toLowerCase().endsWith('\\ffprobe.exe') || filePath.toLowerCase().endsWith('/ffprobe.exe'));
        if (!extractedFfmpeg || !extractedFfprobe) {
            return {
                success: false,
                error: 'ffmpeg zip extracted but ffmpeg.exe/ffprobe.exe were not found.',
            };
        }

        try {
            const extractedBinDir = path.dirname(extractedFfmpeg);
            const binEntries = fs.readdirSync(extractedBinDir, { withFileTypes: true });
            for (const entry of binEntries) {
                if (!entry.isFile()) continue;
                const src = path.join(extractedBinDir, entry.name);
                const dst = path.join(binDir, entry.name);
                fs.copyFileSync(src, dst);
            }
        } catch (error) {
            return {
                success: false,
                error: `Failed to stage ffmpeg binaries: ${error instanceof Error ? error.message : String(error)}`,
            };
        }

        const verify = await this.verifyFfmpegPair(ffmpegPath, ffprobePath);
        if (!verify.success) {
            return {
                success: false,
                error: verify.error || 'ffmpeg binaries were staged but health check failed.',
            };
        }

        return {
            success: true,
            ffmpegPath,
            ffprobePath,
            warning: 'ffmpeg was auto-installed (portable runtime).',
        };
    }

    private async ensureUvrWeights(weightRoot: string): Promise<{ success: boolean; warning?: string; error?: string }> {
        try {
            fs.mkdirSync(weightRoot, { recursive: true });
        } catch (error) {
            return {
                success: false,
                error: `Failed to create UVR weight directory: ${error instanceof Error ? error.message : String(error)}`,
            };
        }

        let existingModels: string[] = [];
        try {
            existingModels = fs.readdirSync(weightRoot).filter((name) => name.toLowerCase().endsWith('.pth'));
        } catch (error) {
            return {
                success: false,
                error: `Failed to inspect UVR weight directory: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        if (existingModels.length > 0) {
            return { success: true };
        }

        const targetName = 'HP5_only_main_vocal.pth';
        const targetPath = path.join(weightRoot, targetName);
        const candidateUrls = [
            `https://huggingface.co/fumiama/RVC-Pretrained-Models/resolve/main/uvr5_weights/${targetName}?download=true`,
            `https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/uvr5_weights/${targetName}?download=true`,
        ];

        const errors: string[] = [];
        for (const url of candidateUrls) {
            const download = await this.downloadFile(url, targetPath);
            if (download.success && fs.existsSync(targetPath)) {
                return {
                    success: true,
                    warning: 'UVR5 weights were auto-downloaded.',
                };
            }
            errors.push(download.error || `download failed: ${url}`);
        }

        return {
            success: false,
            error: `UVR5 weights not found: ${weightRoot}. Auto-download failed: ${errors.join(' | ')}`,
        };
    }

    private loadRvcManifest(): RvcInstallManifest | null {
        const manifestPath = path.join(this.rvcInstallDir, 'install_manifest.json');
        if (!fs.existsSync(manifestPath)) {
            return null;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<RvcInstallManifest>;
            if (!parsed.pythonPath || !parsed.rvcPath) {
                return null;
            }
            return {
                pythonPath: parsed.pythonPath,
                rvcPath: parsed.rvcPath,
            };
        } catch {
            return null;
        }
    }

    private resolvePythonExecutable(pythonRoot: string): string | null {
        const candidates = [
            path.join(pythonRoot, 'Scripts', 'python.exe'),
            path.join(pythonRoot, 'python.exe'),
            pythonRoot,
        ];
        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private isYtDlpEjsError(text: string): boolean {
        return text.includes('yt-dlp/wiki/EJS') || /\bEJS\b/.test(text);
    }

    /**
     * Detects EJS (External JS Scripts) support in yt-dlp and determines the correct
     * runtime args. The EJS system uses --js-runtimes (not --runtime).
     *
     * Strategy:
     *  1. Check current yt-dlp help for --js-runtimes / --remote-components
     *  2. If missing: try pip install -U "yt-dlp[default]" (installs bundled Deno runtime)
     *     - For system yt-dlp: also try yt-dlp -U and RVC/system Python pip fallbacks
     *  3. If --js-runtimes available + node.js found → --js-runtimes node
     *  4. If --remote-components available → --remote-components ejs:npm (auto-download)
     *  5. On failure: surface actionable diag message
     *
     * Returns { args, diag, ytDlpOverride? }.
     * ytDlpOverride replaces the yt-dlp command if we switched to a pip-managed version.
     * Result is cached for the lifetime of the service instance.
     */
    private async detectYtDlpRuntimeArgs(ytDlp: { command: string; argsPrefix: string[] }): Promise<{
        args: string[];
        diag: string;
        ytDlpOverride?: { command: string; argsPrefix: string[] };
    }> {
        if (this.ytDlpRuntimeCache !== 'unchecked') {
            return this.ytDlpRuntimeCache;
        }

        const set = (
            args: string[],
            diag: string,
            ytDlpOverride?: { command: string; argsPrefix: string[] },
        ) => {
            this.ytDlpRuntimeCache = { args, diag, ytDlpOverride };
            return this.ytDlpRuntimeCache;
        };

        type EjsCapability = { jsRuntimes: boolean; remoteComponents: boolean };

        const checkEjsCapability = async (cmd: string, prefix: string[]): Promise<EjsCapability> => {
            const r = await this.runCommand(cmd, prefix.concat(['--help']), { timeoutMs: 15_000 });
            const text = r.stdout + (r.stderr || '');
            return {
                jsRuntimes: text.includes('--js-runtimes'),
                remoteComponents: text.includes('--remote-components'),
            };
        };

        const pipInstallYtDlp = async (python: string): Promise<boolean> => {
            // "yt-dlp[default]" includes the bundled Deno runtime for EJS support.
            const r = await this.runCommand(
                python, ['-m', 'pip', 'install', '-U', 'yt-dlp[default]'], { timeoutMs: 5 * 60 * 1000 },
            );
            console.log(`[SingingLearning] pip install yt-dlp[default] via ${python}: ${r.success ? 'ok' : r.stderr || r.stdout}`);
            return r.success;
        };

        let cap = await checkEjsCapability(ytDlp.command, ytDlp.argsPrefix);
        let activeYtDlp = ytDlp;

        if (!cap.jsRuntimes && !cap.remoteComponents) {
            console.log('[SingingLearning] yt-dlp lacks EJS support; attempting upgrade...');

            // Helper: try installing via a given Python and check if the result gains EJS.
            const tryPipFallback = async (python: string, label: string): Promise<boolean> => {
                if (await pipInstallYtDlp(python)) {
                    const pipCmd = { command: python, argsPrefix: ['-m', 'yt_dlp'] };
                    const pipCap = await checkEjsCapability(pipCmd.command, pipCmd.argsPrefix);
                    if (pipCap.jsRuntimes || pipCap.remoteComponents) {
                        cap = pipCap;
                        activeYtDlp = pipCmd;
                        console.log(`[SingingLearning] Using ${label} yt-dlp with EJS support`);
                        return true;
                    }
                }
                return false;
            };

            if (ytDlp.argsPrefix.length > 0) {
                // pip-managed: upgrade in place
                if (await pipInstallYtDlp(ytDlp.command)) {
                    cap = await checkEjsCapability(ytDlp.command, ytDlp.argsPrefix);
                }
            } else {
                // Direct system executable: try self-update, then pip fallbacks
                const selfUpd = await this.runCommand(ytDlp.command, ['-U'], { timeoutMs: 3 * 60 * 1000 });
                console.log(`[SingingLearning] yt-dlp -U: ${selfUpd.success ? 'ok' : 'failed'}`);
                if (selfUpd.success) {
                    cap = await checkEjsCapability(ytDlp.command, ytDlp.argsPrefix);
                }

                if (!cap.jsRuntimes && !cap.remoteComponents) {
                    // RVC Python fallback
                    const manifest = this.loadRvcManifest();
                    const rvcPython = manifest?.pythonPath
                        ? this.resolvePythonExecutable(manifest.pythonPath)
                        : null;
                    if (rvcPython) {
                        await tryPipFallback(rvcPython, 'RVC Python');
                    }
                }

                if (!cap.jsRuntimes && !cap.remoteComponents) {
                    // System Python fallback
                    const sysPython = await this.resolveExecutable('python')
                        ?? await this.resolveExecutable('python3')
                        ?? await this.resolveExecutable('py');
                    if (sysPython) {
                        await tryPipFallback(sysPython, 'system Python');
                    }
                }
            }
        }

        if (!cap.jsRuntimes && !cap.remoteComponents) {
            return set(
                [],
                'yt-dlp EJS support missing. Run: pip install -U "yt-dlp[default]"  or  yt-dlp -U',
            );
        }

        // Prefer --js-runtimes node (explicit, faster than auto-download).
        if (cap.jsRuntimes) {
            const nodePath = await this.resolveExecutable('node');
            if (nodePath) {
                const override = activeYtDlp !== ytDlp ? activeYtDlp : undefined;
                console.log(`[SingingLearning] EJS via --js-runtimes node:${nodePath}${override ? ' (pip)' : ''}`);
                return set(['--js-runtimes', `node:${nodePath}`], '', override);
            }
            // node not in PATH but --remote-components is available — fall through.
        }

        // Fallback: auto-download EJS runtime from npm on first use.
        if (cap.remoteComponents) {
            const override = activeYtDlp !== ytDlp ? activeYtDlp : undefined;
            console.log(`[SingingLearning] EJS via --remote-components ejs:npm${override ? ' (pip)' : ''}`);
            return set(['--remote-components', 'ejs:npm'], '', override);
        }

        // --js-runtimes supported but no node.js and no --remote-components
        return set(
            [],
            'Node.js ≥20 not found in PATH — install from https://nodejs.org and restart',
        );
    }

    private async resolveYtDlpCommand(): Promise<{ command: string; argsPrefix: string[] } | null> {
        const direct = await this.resolveExecutable('yt-dlp');
        if (direct) {
            return { command: direct, argsPrefix: [] };
        }
        const directAlt = await this.resolveExecutable('yt_dlp');
        if (directAlt) {
            return { command: directAlt, argsPrefix: [] };
        }

        const manifest = this.loadRvcManifest();
        if (!manifest) {
            return null;
        }
        const pythonExe = this.resolvePythonExecutable(manifest.pythonPath);
        if (!pythonExe) {
            return null;
        }
        const probe = await this.runCommand(pythonExe, ['-m', 'yt_dlp', '--version'], {
            timeoutMs: 20_000,
        });
        if (probe.success) {
            return { command: pythonExe, argsPrefix: ['-m', 'yt_dlp'] };
        }

        const pipProbe = await this.runCommand(pythonExe, ['-m', 'pip', '--version'], {
            timeoutMs: 20_000,
        });
        if (!pipProbe.success) {
            return null;
        }

        const install = await this.runCommand(pythonExe, ['-m', 'pip', 'install', '-U', 'yt-dlp'], {
            timeoutMs: 20 * 60 * 1000,
        });
        if (!install.success) {
            return null;
        }
        const probeAfterInstall = await this.runCommand(pythonExe, ['-m', 'yt_dlp', '--version'], {
            timeoutMs: 20_000,
        });
        if (probeAfterInstall.success) {
            return { command: pythonExe, argsPrefix: ['-m', 'yt_dlp'] };
        }
        return null;
    }

    private fetchJson(url: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const request = https.get(url, {
                headers: {
                    'User-Agent': 'AntiGravity-Nexus',
                    Accept: 'application/json',
                },
            }, (res) => {
                const statusCode = res.statusCode || 0;
                if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
                    const redirected = new URL(res.headers.location, url).toString();
                    res.resume();
                    this.fetchJson(redirected).then(resolve).catch(reject);
                    return;
                }
                if (statusCode !== 200) {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                    res.on('end', () => {
                        reject(new Error(`HTTP ${statusCode}: ${Buffer.concat(chunks).toString('utf-8').slice(0, 200)}`));
                    });
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                        resolve(parsed);
                    } catch (error) {
                        reject(new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`));
                    }
                });
            });

            request.on('error', (error) => {
                reject(error);
            });
        });
    }

    private downloadFile(url: string, destinationPath: string, redirectCount = 0): Promise<{ success: boolean; error?: string }> {
        return new Promise((resolve) => {
            if (redirectCount > 8) {
                resolve({ success: false, error: 'Too many redirects while downloading file.' });
                return;
            }

            const tempPath = `${destinationPath}.tmp_${Date.now()}`;
            try {
                fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
            } catch (error) {
                resolve({ success: false, error: `Failed to create destination directory: ${error instanceof Error ? error.message : String(error)}` });
                return;
            }

            const request = https.get(url, {
                headers: {
                    'User-Agent': 'AntiGravity-Nexus',
                    Accept: '*/*',
                },
            }, (res) => {
                const statusCode = res.statusCode || 0;
                if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
                    const redirected = new URL(res.headers.location, url).toString();
                    res.resume();
                    try {
                        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    } catch {
                        // Ignore cleanup errors.
                    }
                    this.downloadFile(redirected, destinationPath, redirectCount + 1).then(resolve);
                    return;
                }
                if (statusCode !== 200) {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                    res.on('end', () => {
                        try {
                            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                        } catch {
                            // Ignore cleanup errors.
                        }
                        resolve({
                            success: false,
                            error: `HTTP ${statusCode}: ${Buffer.concat(chunks).toString('utf-8').slice(0, 240)}`,
                        });
                    });
                    return;
                }

                const output = fs.createWriteStream(tempPath);
                output.on('error', (error) => {
                    try {
                        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    } catch {
                        // Ignore cleanup errors.
                    }
                    resolve({ success: false, error: `Failed to write download file: ${error.message}` });
                });

                res.pipe(output);
                output.on('finish', () => {
                    output.close();
                    try {
                        if (fs.existsSync(destinationPath)) {
                            fs.unlinkSync(destinationPath);
                        }
                        fs.renameSync(tempPath, destinationPath);
                        resolve({ success: true });
                    } catch (error) {
                        try {
                            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                        } catch {
                            // Ignore cleanup errors.
                        }
                        resolve({ success: false, error: `Failed to finalize downloaded file: ${error instanceof Error ? error.message : String(error)}` });
                    }
                });
            });

            request.on('error', (error) => {
                try {
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                } catch {
                    // Ignore cleanup errors.
                }
                resolve({ success: false, error: error.message });
            });
        });
    }

    private async verifyFfmpegPair(ffmpegPath: string, ffprobePath: string): Promise<{ success: boolean; error?: string }> {
        const env = this.buildEnvWithAdditionalPath(path.dirname(ffmpegPath));
        const ffmpegCheck = await this.runCommand(ffmpegPath, ['-version'], {
            timeoutMs: 20_000,
            env,
        });
        if (!ffmpegCheck.success) {
            return {
                success: false,
                error: this.formatCommandFailure('ffmpeg -version', ffmpegCheck),
            };
        }

        const ffprobeCheck = await this.runCommand(ffprobePath, ['-version'], {
            timeoutMs: 20_000,
            env,
        });
        if (!ffprobeCheck.success) {
            return {
                success: false,
                error: this.formatCommandFailure('ffprobe -version', ffprobeCheck),
            };
        }

        return { success: true };
    }

    private buildEnvWithAdditionalPath(extraDir: string, baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        const nextEnv: NodeJS.ProcessEnv = {
            ...(baseEnv || process.env),
        };
        const currentPathRaw = nextEnv.PATH || nextEnv.Path || '';
        const currentParts = String(currentPathRaw)
            .split(path.delimiter)
            .map((part) => String(part || '').trim())
            .filter(Boolean);

        const normalizedExtra = path.resolve(extraDir).toLowerCase();
        const hasExtra = currentParts.some((part) => {
            try {
                return path.resolve(part).toLowerCase() === normalizedExtra;
            } catch {
                return false;
            }
        });
        const mergedParts = hasExtra ? currentParts : [extraDir, ...currentParts];
        const mergedPath = mergedParts.join(path.delimiter);
        nextEnv.PATH = mergedPath;
        nextEnv.Path = mergedPath;
        return nextEnv;
    }

    private async resolveExecutable(command: string): Promise<string | null> {
        if (command === 'ffmpeg' || command === 'ffprobe') {
            const runtimeCandidate = path.join(this.baseDir, 'runtime', 'ffmpeg', 'bin', `${command}.exe`);
            if (fs.existsSync(runtimeCandidate)) {
                return runtimeCandidate;
            }
        }
        const result = await this.runCommand('where', [command], { timeoutMs: 15_000 });
        if (!result.success) {
            return null;
        }
        const firstLine = result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
        return firstLine || null;
    }

    private runCommand(
        command: string,
        args: string[],
        options?: {
            cwd?: string;
            timeoutMs?: number;
            env?: NodeJS.ProcessEnv;
        },
    ): Promise<CommandResult> {
        return new Promise((resolve) => {
            const child = spawn(command, args, {
                cwd: options?.cwd,
                env: options?.env || process.env,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            let settled = false;

            const timeoutMs = Math.max(5_000, options?.timeoutMs || 10 * 60 * 1000);
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Ignore kill errors.
                }
                resolve({
                    success: false,
                    code: -1,
                    stdout,
                    stderr: `${stderr}\nCommand timeout after ${timeoutMs}ms`,
                });
            }, timeoutMs);

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });
            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({
                    success: false,
                    code: -1,
                    stdout,
                    stderr: `${stderr}\n${error.message}`,
                });
            });

            child.on('close', (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({
                    success: code === 0,
                    code: code ?? -1,
                    stdout,
                    stderr,
                });
            });
        });
    }

    private findStemFile(
        rootDir: string,
        preferredStemNames: string[],
        options?: { allowAnyWavFallback?: boolean },
    ): string | undefined {
        if (!fs.existsSync(rootDir)) {
            return undefined;
        }
        const files = this.collectFilesRecursive(rootDir)
            .filter((filePath) => {
                try {
                    return fs.statSync(filePath).isFile();
                } catch {
                    return false;
                }
            });
        if (files.length === 0) {
            return undefined;
        }

        const normalizedNames = preferredStemNames
            .map((name) => String(name || '').trim().toLowerCase())
            .filter(Boolean);
        for (const stemName of normalizedNames) {
            const exactMatches = files.filter((filePath) => (
                path.basename(filePath).toLowerCase() === `${stemName}.wav`
            ));
            const newestExact = this.pickNewestFile(exactMatches);
            if (newestExact) {
                return newestExact;
            }
        }

        for (const stemName of normalizedNames) {
            const partialMatches = files.filter((filePath) => (
                filePath.toLowerCase().endsWith('.wav')
                && path.basename(filePath).toLowerCase().includes(stemName)
            ));
            const newestPartial = this.pickNewestFile(partialMatches);
            if (newestPartial) {
                return newestPartial;
            }
        }

        if (options?.allowAnyWavFallback === false) {
            return undefined;
        }
        return this.pickNewestFile(files.filter((filePath) => filePath.toLowerCase().endsWith('.wav')));
    }

    private collectFilesRecursive(rootDir: string): string[] {
        const results: string[] = [];
        const stack: string[] = [rootDir];
        while (stack.length > 0) {
            const current = stack.pop();
            if (!current || !fs.existsSync(current)) continue;
            let entries: fs.Dirent[] = [];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (entry.isFile()) {
                    results.push(fullPath);
                }
            }
        }
        return results;
    }

    private pickNewestFile(paths: string[]): string | undefined {
        if (paths.length === 0) {
            return undefined;
        }
        const sorted = [...paths];
        sorted.sort((a, b) => {
            const aTime = fs.statSync(a).mtimeMs;
            const bTime = fs.statSync(b).mtimeMs;
            return bTime - aTime;
        });
        return sorted[0];
    }

    private createRunId(): string {
        const now = new Date();
        const stamp = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0'),
            '_',
            String(now.getHours()).padStart(2, '0'),
            String(now.getMinutes()).padStart(2, '0'),
            String(now.getSeconds()).padStart(2, '0'),
        ].join('');
        return `${stamp}_${Math.floor(Math.random() * 100000)}`;
    }

    private normalizeId(value: string, fallback: string): string {
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/[^\p{L}\p{N}_-]+/gu, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 64);
        return normalized || fallback;
    }

    private isYtDlpPremiumRestrictedError(value: string): boolean {
        const normalized = String(value || '').toLowerCase();
        if (!normalized) {
            return false;
        }
        return (
            normalized.includes('only available to music premium members')
            || normalized.includes('music premium')
        );
    }

    private buildYtDlpCookieSources(): string[] {
        const sources: string[] = [];
        const profileMap: Record<string, string[]> = {
            edge: ['', 'Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4', 'Profile 5'],
            chrome: ['', 'Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4', 'Profile 5'],
            brave: ['', 'Default', 'Profile 1', 'Profile 2', 'Profile 3'],
            chromium: ['', 'Default', 'Profile 1'],
            firefox: ['', 'default-release', 'default'],
        };

        const browsers = ['edge', 'chrome', 'brave', 'chromium', 'firefox'];
        for (const browser of browsers) {
            const profiles = profileMap[browser] || [''];
            for (const profile of profiles) {
                const trimmedProfile = String(profile || '').trim();
                const source = trimmedProfile ? `${browser}:${trimmedProfile}` : browser;
                if (!sources.includes(source)) {
                    sources.push(source);
                }
            }
        }

        return sources;
    }

    private tryParseLastJsonLine<T>(value: string): T | null {
        const lines = String(value || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const line = lines[i];
            if (!line.startsWith('{') || !line.endsWith('}')) {
                continue;
            }
            try {
                return JSON.parse(line) as T;
            } catch {
                // Ignore parse failures and keep searching previous lines.
            }
        }
        return null;
    }

    private ema(previous: number, next: number, alpha: number): number {
        const a = this.clampNumber(alpha, 0.01, 1, 0.2);
        return (previous * (1 - a)) + (next * a);
    }

    private roundNumber(value: number, digits: number): number {
        if (!Number.isFinite(value)) return 0;
        const safeDigits = this.clampInteger(digits, 0, 6, 2);
        const scale = 10 ** safeDigits;
        return Math.round(value * scale) / scale;
    }

    private clampNumber(value: number, min: number, max: number, fallback: number): number {
        if (!Number.isFinite(value)) return fallback;
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    private clampInteger(value: number, min: number, max: number, fallback: number): number {
        if (!Number.isFinite(value)) return fallback;
        const rounded = Math.floor(value);
        if (rounded < min) return min;
        if (rounded > max) return max;
        return rounded;
    }

    private formatCommandFailure(label: string, result: CommandResult): string {
        const detail = this.takeTail(
            [result.stderr || '', result.stdout || ''].filter(Boolean).join('\n'),
            700,
        );
        if (detail) {
            return `${label} failed (code=${result.code}): ${detail}`;
        }
        return `${label} failed (code=${result.code})`;
    }

    private takeTail(value: string, maxLen: number): string {
        const text = String(value || '').trim();
        if (text.length <= maxLen) return text;
        return text.slice(text.length - maxLen);
    }
}
