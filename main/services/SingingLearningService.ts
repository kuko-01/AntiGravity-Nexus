import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as https from 'https';
import AdmZip from 'adm-zip';
import { Sbv2Service } from './tts/Sbv2Service';
import {
    SeparationMixtureConsistencyEstimate,
    SeparationQualityLibrary,
    SeparationStemQualityMetrics,
    SeparationStemQualityScore,
} from './audio/SeparationQualityLibrary';

const AUDIO_SEPARATOR_TORCH_CUDA_INDEX_URL = 'https://download.pytorch.org/whl/cu126';

type SeparationMethod = 'uvr-ultimate' | 'roformer' | 'uvr5' | 'demucs' | 'ffmpeg-fallback';
type SeparationPreference = 'auto' | SeparationMethod;

export interface SingingLearningIngestParams {
    characterId: string;
    sourceUrl: string;
    separationPreference?: SeparationPreference;
    ytDlpCookiesFile?: string;
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
}

interface ScoredSeparationCandidate {
    candidate: SeparationQualityCandidate;
    score: SeparationStemQualityScore;
    vocalMetrics: SeparationStemQualityMetrics;
    mixtureConsistency?: SeparationMixtureConsistencyEstimate;
    finalScore: number;
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
    private readonly separationProfiles = new Map<string, PersistentCharacterSeparationProfile>();
    private separationProfilesDirty = false;
    private separationProfilesLastPersistAt = 0;
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
                    });
                }
                if (separationPreference !== 'auto') { separation = attempt; break; }
                continue;
            }
            separation = attempt;
            if (attempt.error) { attemptErrors.push(`${method}: ${attempt.error}`); failedMethods.push(method); }
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
                    this.updateSeparationProfileFromScoredCandidates(characterId, selected.scoredCandidates);
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
                if (!fallback.success && fallback.error) { attemptErrors.push(`${fallbackMethod}: ${fallback.error}`); failedMethods.push(fallbackMethod); }
                else if (fallback.success && fallback.method) { this.updateSeparationProfileForSuccess(characterId, fallback.method); }
            }
        }

        if (failedMethods.length > 0) this.updateSeparationProfileForFailures(characterId, failedMethods);

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
            const methods: SeparationMethod[] = ['uvr-ultimate', 'roformer', 'demucs', 'uvr5', 'ffmpeg-fallback'];
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
                    this.updateSeparationProfileFromScoredCandidates(characterId, selected.scoredCandidates);
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
                } else if (fallbackAttempt.success && fallbackAttempt.method) {
                    this.updateSeparationProfileForSuccess(characterId, fallbackAttempt.method);
                }
            }
        }

        if (failedMethods.length > 0) {
            this.updateSeparationProfileForFailures(characterId, failedMethods);
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

        this.writeRunMetadata(runDir, {
            sourceUrl,
            characterId,
            sourceAudioPath,
            vocalWavPath: trainingCopyPath,
            accompanimentWavPath: separation.accompanimentWavPath,
            datasetInputPath,
            method: separation.method,
            separationPreference,
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
        if (normalized === 'uvr-ultimate' || normalized === 'roformer' || normalized === 'demucs' || normalized === 'uvr5' || normalized === 'ffmpeg-fallback') {
            return normalized;
        }
        return undefined;
    }

    private resolvePreferredMethod(profile: PersistentCharacterSeparationProfile): SeparationMethod {
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
    ): void {
        for (const entry of scoredCandidates) {
            this.updateSeparationProfileForSuccess(
                characterIdRaw,
                entry.candidate.method,
                {
                    score: entry.score.score,
                    leakageCorrelation: entry.score.leakageCorrelation,
                    metrics: entry.vocalMetrics,
                },
                false,
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

    private updateSeparationProfileForFailures(characterIdRaw: string, methods: SeparationMethod[]): void {
        if (methods.length === 0) {
            return;
        }
        const profile = this.getOrCreateCharacterSeparationProfile(characterIdRaw);
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
        }
        profile.preferredMethod = this.resolvePreferredMethod(profile);
        profile.updatedAt = now;
        this.separationProfilesDirty = true;
        this.persistSeparationProfiles();
    }

    private normalizeSeparationPreference(value: string | undefined): SeparationPreference {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'uvr-ultimate' || normalized === 'roformer' || normalized === 'demucs' || normalized === 'uvr5' || normalized === 'ffmpeg-fallback') {
            return normalized;
        }
        return 'auto';
    }

    private buildSeparationPlan(preference: SeparationPreference, characterId: string): SeparationMethod[] {
        const defaultPlan: SeparationMethod[] = ['uvr-ultimate', 'roformer', 'demucs', 'uvr5', 'ffmpeg-fallback'];
        if (preference === 'auto') {
            const profile = this.getOrCreateCharacterSeparationProfile(characterId);
            const baselineBias: Record<SeparationMethod, number> = {
                'uvr-ultimate': 2.5,
                roformer: 3,
                demucs: 2,
                uvr5: 1,
                'ffmpeg-fallback': -10,
            };
            const ranked = [...defaultPlan].sort((a, b) => {
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
            return ranked;
        }
        return [preference, ...defaultPlan.filter((method) => method !== preference)];
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
        warning?: string;
        error?: string;
    }> {
        if (method === 'uvr-ultimate') {
            return this.trySeparateWithUvrUltimate(sourceAudioPath, vocalDir, accompanimentDir);
        }
        if (method === 'roformer') {
            return this.trySeparateWithRoformer(sourceAudioPath, vocalDir, accompanimentDir);
        }
        if (method === 'demucs') {
            return this.trySeparateWithDemucs(sourceAudioPath, vocalDir, accompanimentDir);
        }
        if (method === 'uvr5') {
            return this.trySeparateWithUvr(sourceAudioPath, vocalDir, accompanimentDir);
        }
        return this.trySeparateWithFfmpegFallback(sourceAudioPath, vocalDir, accompanimentDir);
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

                const finalScore = this.clampNumber(score.score + prior + mixAdjustment, 0, 100, score.score);
                scoredCandidates.push({
                    candidate,
                    score,
                    vocalMetrics,
                    mixtureConsistency,
                    finalScore,
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

            // Prefer stronger vocal activity if everything else is similar.
            const speechDiff = b.vocalMetrics.speechActivityRatio - a.vocalMetrics.speechActivityRatio;
            if (Math.abs(speechDiff) > 0.02) {
                return speechDiff;
            }

            return finalScoreDiff;
        });
        const best = scoredCandidates[0];
        const ranking = scoredCandidates
            .map((entry) => `${entry.candidate.method}:${entry.finalScore.toFixed(2)}(raw=${entry.score.score.toFixed(2)},leak=${(entry.score.leakageCorrelation ?? 0).toFixed(3)},low=${entry.vocalMetrics.lowBandRatio.toFixed(2)},mx=${entry.mixtureConsistency?.normalizedError?.toFixed(3) ?? 'n/a'},mlx=${entry.mixtureConsistency?.lowBandResidualRatio?.toFixed(3) ?? 'n/a'})`)
            .join(', ');
        const second = scoredCandidates[1];
        const tieBreakUsed = !!second && Math.abs(best.finalScore - second.finalScore) <= 0.25;
        const scoreDetail = `Selected ${best.candidate.method} by automatic quality ranking (score=${best.finalScore.toFixed(2)}, raw=${best.score.score.toFixed(2)}, leak=${(best.score.leakageCorrelation ?? 0).toFixed(3)}, low=${best.vocalMetrics.lowBandRatio.toFixed(2)}, mixErr=${best.mixtureConsistency?.normalizedError?.toFixed(3) ?? 'n/a'}, lowMixErr=${best.mixtureConsistency?.lowBandResidualRatio?.toFixed(3) ?? 'n/a'}, rms=${best.vocalMetrics.rmsDb.toFixed(2)}dB, speech=${best.vocalMetrics.speechActivityRatio.toFixed(2)}${tieBreakUsed ? ', tie-break=mix/leak/bleed' : ''}).`;

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
        voc = [f for f in output_files if 'vocal' in os.path.basename(f).lower()]
        inst = [f for f in output_files if any(k in os.path.basename(f).lower() for k in ['instrumental', 'accompaniment', 'no_vocal', 'inst'])]
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
        no_reverb = [f for f in dr_outputs if any(k in os.path.basename(f).lower() for k in ['no reverb', 'noreverb', 'no_reverb', 'dry'])]
        dereverbed_file = no_reverb[0] if no_reverb else dr_outputs[0]
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
                    const afterScore = SeparationQualityLibrary.scoreFromMetrics(afterMetrics, afterLeak);
                    leakageForCleanupTuning = afterLeak;

                    const improved = (
                        afterScore.score >= beforeScore.score + 1.5
                        || afterLeak <= beforeLeak - 0.03
                        || (afterScore.score > beforeScore.score && afterMetrics.highBandRatio <= beforeMetrics.highBandRatio)
                    );

                    if (improved) {
                        cleanupInputPath = debleedPath;
                        enhancementNotes.push(
                            `Reference de-bleed applied (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}, avgGain=${debleedSummary.avgAbsLeakGain.toFixed(3)}).`,
                        );
                    } else {
                        try { if (fs.existsSync(debleedPath)) fs.unlinkSync(debleedPath); } catch {}
                        enhancementNotes.push(
                            `Reference de-bleed not adopted (score ${beforeScore.score.toFixed(2)}->${afterScore.score.toFixed(2)}, leakage ${beforeLeak.toFixed(3)}->${afterLeak.toFixed(3)}).`,
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
                    ) && scoreDrop <= 1.2 && leakWorsened <= 0.018 && speechDrop <= 0.04;

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
                const highBandRoughness = SeparationQualityLibrary.estimateHighBandRoughnessMonoPcm16Wav(analysisMonoPath);
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
                metricsSummary = `Adaptive cleanup tuned from analysis (rms=${metrics.rmsDb.toFixed(2)}dB, low=${metrics.lowBandRatio.toFixed(2)}, high=${metrics.highBandRatio.toFixed(2)}, rough=${highBandRoughness.toFixed(4)}, nearClip=${metrics.nearClipRatio.toFixed(4)}, speech=${metrics.speechActivityRatio.toFixed(2)}${typeof lowBandLeakForCleanup === 'number' ? `, lowLeak=${lowBandLeakForCleanup.toFixed(3)}` : ''}).`;
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
