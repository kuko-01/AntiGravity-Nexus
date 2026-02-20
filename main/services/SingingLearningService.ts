import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as https from 'https';
import AdmZip from 'adm-zip';
import { Sbv2Service } from './tts/Sbv2Service';

type SeparationMethod = 'uvr5' | 'demucs' | 'ffmpeg-fallback';

export interface SingingLearningIngestParams {
    characterId: string;
    sourceUrl: string;
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

export class SingingLearningService {
    private static instance: SingingLearningService | null = null;

    private readonly baseDir: string;
    private readonly rvcInstallDir: string;
    private readonly sbv2InstallDir: string;
    private readonly ttsResourcesPath: string;

    private constructor(ttsResourcesPath: string) {
        const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
        this.baseDir = path.join(localAppData, 'AntiGravity', 'tts', 'singing_learning');
        this.rvcInstallDir = path.join(localAppData, 'AntiGravity', 'tts', 'rvc');
        this.sbv2InstallDir = path.join(localAppData, 'AntiGravity', 'tts', 'sbv2');
        this.ttsResourcesPath = ttsResourcesPath;
        fs.mkdirSync(this.baseDir, { recursive: true });
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
        const regex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[^\s]+)/i;
        const match = source.match(regex);
        if (!match || !match[1]) return null;
        return match[1];
    }

    async ingestFromYouTube(params: SingingLearningIngestParams): Promise<SingingLearningIngestResult> {
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

        const downloaded = await this.downloadYouTubeAudio(sourceUrl, downloadDir);
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
        const preWarnings: string[] = [];
        if (downloaded.warning) {
            preWarnings.push(downloaded.warning);
        }
        const prepared = await this.prepareSourceAudioForSeparation(sourceAudioPath, runDir);
        if (prepared.warning) {
            preWarnings.push(prepared.warning);
        }
        sourceAudioPath = prepared.audioPath;
        const attemptErrors: string[] = [];
        let separation = await this.trySeparateWithUvr(sourceAudioPath, vocalDir, instDir);
        if (!separation.success && separation.error) {
            attemptErrors.push(`uvr5: ${separation.error}`);
        }
        if (!separation.success) {
            separation = await this.trySeparateWithDemucs(sourceAudioPath, vocalDir, instDir);
            if (!separation.success && separation.error) {
                attemptErrors.push(`demucs: ${separation.error}`);
            } else if (separation.success && attemptErrors.length > 0) {
                const existingWarning = separation.warning ? `${separation.warning} ` : '';
                separation.warning = `${existingWarning}UVR5 was unavailable, switched to Demucs.`;
            }
        }
        if (!separation.success) {
            separation = await this.trySeparateWithFfmpegFallback(sourceAudioPath, vocalDir, instDir);
            if (separation.success && attemptErrors.length > 0) {
                const existingWarning = separation.warning ? `${separation.warning} ` : '';
                separation.warning = `${existingWarning}High-quality separators failed (${attemptErrors.join(' | ')}).`;
            }
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

        const trainingCopyPath = path.join(
            trainDir,
            `${runId}_${path.basename(separation.vocalWavPath).replace(/[^a-zA-Z0-9_.-]+/g, '_')}`,
        );
        fs.copyFileSync(separation.vocalWavPath, trainingCopyPath);

        let datasetInputPath: string | undefined;
        try {
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
            createdAt: new Date().toISOString(),
        });

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

    private async downloadYouTubeAudio(
        sourceUrl: string,
        outputDir: string,
    ): Promise<{ success: boolean; audioPath?: string; warning?: string; error?: string }> {
        const outputTemplate = path.join(outputDir, 'source.%(ext)s');
        const ytDlp = await this.resolveYtDlpCommand();
        if (!ytDlp) {
            return {
                success: false,
                error: 'yt-dlp was not found. Install yt-dlp and ensure it is available in PATH.',
            };
        }

        const warnings: string[] = [];
        const baseArgs = [
            '--ignore-config',
            '--no-playlist',
            '--no-warnings',
            '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
            '-o', outputTemplate,
            sourceUrl,
        ];
        const runYtDlp = async (extraArgs?: string[]): Promise<CommandResult> => (
            this.runCommand(
                ytDlp.command,
                ytDlp.argsPrefix.concat(extraArgs || [], baseArgs),
                {
                    cwd: outputDir,
                    timeoutMs: 30 * 60 * 1000,
                },
            )
        );

        let result = await runYtDlp();
        let cookieSourceUsed = '';
        if (!result.success) {
            const errorText = result.stderr || result.stdout || '';
            if (this.isYtDlpPremiumRestrictedError(errorText)) {
                const cookieSources = this.buildYtDlpCookieSources();
                for (const source of cookieSources) {
                    const retry = await runYtDlp(['--cookies-from-browser', source]);
                    if (retry.success) {
                        result = retry;
                        cookieSourceUsed = source;
                        break;
                    }
                }
                if (!result.success) {
                    return {
                        success: false,
                        error: [
                            'yt-dlp failed: This video is restricted to YouTube Music Premium.',
                            'Sign in with a Premium account in your browser and retry.',
                            `detail: ${this.takeTail(result.stderr || result.stdout, 300)}`,
                        ].join(' '),
                    };
                }
            } else {
                return {
                    success: false,
                    error: `yt-dlp failed: ${this.takeTail(errorText, 400)}`,
                };
            }
        }

        if (cookieSourceUsed) {
            warnings.push(`yt-dlp retry succeeded using browser cookies (${cookieSourceUsed}).`);
        }

        const files = fs.readdirSync(outputDir)
            .map((name) => path.join(outputDir, name))
            .filter((fullPath) => fs.statSync(fullPath).isFile());
        const sortedByRecent = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        const wavCandidate = sortedByRecent.find((filePath) => filePath.toLowerCase().endsWith('.wav'));
        if (wavCandidate) {
            return {
                success: true,
                audioPath: wavCandidate,
                warning: warnings.length > 0 ? warnings.join(' ') : undefined,
            };
        }
        const audioCandidate = sortedByRecent.find((filePath) => /\.(m4a|mp3|webm|ogg|flac|aac)$/i.test(filePath));
        if (audioCandidate) {
            return {
                success: true,
                audioPath: audioCandidate,
                warning: warnings.length > 0 ? warnings.join(' ') : undefined,
            };
        }

        return {
            success: false,
            error: 'No audio file was produced by yt-dlp.',
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
    r'''${vocalDir.replace(/\\/g, '\\\\')}''',
    [],
    r'''${accompanimentDir.replace(/\\/g, '\\\\')}''',
    10,
    'wav',
):
    infos.append(row)

print(json.dumps({'ok': True, 'logs': infos[-3:]}))
`.trim();

        const result = await this.runCommand(pythonExe, ['-c', script], {
            cwd: rvcOfficialRoot,
            timeoutMs: 45 * 60 * 1000,
            env: {
                ...process.env,
                weight_uvr5_root: weightRoot,
            },
        });
        if (!result.success) {
            return {
                success: false,
                error: `UVR separation failed: ${this.takeTail(result.stderr || result.stdout, 600)}`,
            };
        }

        const vocalWav = this.findStemFile(vocalDir, ['vocals', 'vocal', 'main_vocal']);
        if (!vocalWav) {
            return { success: false, error: 'UVR separation completed but vocal WAV not found' };
        }
        const accompanimentWav = this.findStemFile(
            accompanimentDir,
            ['no_vocals', 'instrumental', 'accompaniment'],
            { allowAnyWavFallback: true },
        );

        return {
            success: true,
            method: 'uvr5',
            vocalWavPath: vocalWav,
            accompanimentWavPath: accompanimentWav,
            warning: ensureWeights.warning,
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
        let lastError = '';
        for (const modelName of modelCandidates) {
            for (let attempt = 1; attempt <= 2; attempt += 1) {
                const args = runner.argsPrefix.concat([
                    '--two-stems',
                    'vocals',
                    '-n',
                    modelName,
                    '-o',
                    outputRoot,
                    sourceAudioPath,
                ]);
                const result = await this.runCommand(runner.command, args, {
                    cwd: workDir,
                    env: demucsEnv,
                    timeoutMs: 90 * 60 * 1000,
                });
                try {
                    const logPath = path.join(workDir, `demucs_${modelName}_attempt${attempt}.log`);
                    const payload = [
                        `model=${modelName}`,
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
                        warnings.push(`Demucs exited with code ${result.code}, but stem files were produced and reused.`);
                    }
                    if (attempt > 1) {
                        warnings.push(`Demucs succeeded after retry (${modelName}, attempt ${attempt}).`);
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
                    lastError = this.formatCommandFailure(`Demucs(${modelName}) attempt ${attempt}`, result);
                } else {
                    lastError = `Demucs(${modelName}) attempt ${attempt} finished but vocals.wav was not found.`;
                }
            }
        }

        return {
            success: false,
            error: lastError || 'Demucs separation failed.',
        };
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
            '-af', 'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=120,lowpass=f=10000',
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
                    ? 'Used ffmpeg fallback separation (center/side approximation).'
                    : 'Used ffmpeg fallback vocal extraction; accompaniment export failed.',
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
