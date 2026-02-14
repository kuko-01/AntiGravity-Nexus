/**
 * Sbv2Runtime - Style-Bert-VITS2 Process Lifecycle Manager
 * 
 * Handles:
 * - Starting FastAPI server
 * - Port allocation
 * - Health monitoring
 * - Auto-restart on crash
 * - Clean shutdown
 */

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import {
    TtsRuntimeState, TtsError, InstallManifest, GpuInfo,
    TtsStartOptions,
    SliceOptions,
    TranscribeOptions,
} from '../../../types/tts';

// ========================================
// Constants
// ========================================

const DEFAULT_PORT_RANGE_START = 50021;
const DEFAULT_PORT_RANGE_END = 50030;
const HEALTH_CHECK_INTERVAL_MS = 30000;
const HEALTH_CHECK_TIMEOUT_MS = 30000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = 2000;

export class Sbv2Runtime {
    private installPath: string;
    private sbv2Path: string;
    private process: ChildProcess | null = null;
    private state: TtsRuntimeState = 'stopped';
    private port: number | null = null;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private restartAttempts = 0;
    private lastError: TtsError | null = null;
    private onStateChange?: (state: TtsRuntimeState) => void;

    constructor(installPath: string) {
        this.installPath = installPath;
        this.sbv2Path = path.join(installPath, 'sbv2');
    }

    // ========================================
    // Public API
    // ========================================

    getState(): TtsRuntimeState {
        return this.state;
    }

    getPort(): number | null {
        return this.port;
    }

    getEndpoint(): string | null {
        if (this.port === null) return null;
        return `http://localhost:${this.port}`;
    }

    getLastError(): TtsError | null {
        return this.lastError;
    }

    /**
     * Get current paths configuration
     */
    async getPathsConfig(): Promise<{ datasetRoot: string; assetsRoot: string }> {
        const configPath = path.join(this.sbv2Path, 'configs', 'paths.yml');
        if (!fs.existsSync(configPath)) {
            return { datasetRoot: 'Data', assetsRoot: 'model_assets' };
        }

        try {
            const content = fs.readFileSync(configPath, 'utf8');
            const datasetMatch = content.match(/dataset_root:\s*(.+)/);
            const assetsMatch = content.match(/assets_root:\s*(.+)/);

            return {
                datasetRoot: datasetMatch ? datasetMatch[1].trim() : 'Data',
                assetsRoot: assetsMatch ? assetsMatch[1].trim() : 'model_assets'
            };
        } catch (e) {
            console.error('Failed to read paths.yml:', e);
            return { datasetRoot: 'Data', assetsRoot: 'model_assets' };
        }
    }

    /**
     * Set paths configuration
     */
    async setPathsConfig(config: { datasetRoot: string; assetsRoot: string }): Promise<void> {
        const configPath = path.join(this.sbv2Path, 'configs', 'paths.yml');
        const configDir = path.dirname(configPath);

        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        const content = `# Root directory of the training dataset.
# The training dataset of {model_name} should be placed in {dataset_root}/{model_name}.
dataset_root: ${config.datasetRoot}

# Root directory of the model assets (for inference).
# In training, the model assets will be saved to {assets_root}/{model_name},
# and in inference, we load all the models from {assets_root}.
assets_root: ${config.assetsRoot}
`;
        fs.writeFileSync(configPath, content, 'utf8');
    }

    setStateChangeHandler(handler: (state: TtsRuntimeState) => void): void {
        this.onStateChange = handler;
    }

    /**
     * Start SBV2 FastAPI server
     */
    async start(options?: TtsStartOptions): Promise<{ success: boolean; port?: number; error?: TtsError }> {
        if (this.state === 'running' || this.state === 'starting') {
            return { success: true, port: this.port || undefined };
        }

        this.setState('starting');
        this.lastError = null;
        this.restartAttempts = 0;

        try {
            // Find available port
            this.port = await this.findAvailablePort();
            if (!this.port) {
                throw new Error('No available port in range');
            }

            // Get paths
            const manifest = this.loadInstallManifest();
            if (!manifest) {
                throw new Error('Install manifest not found');
            }

            const serverScript = path.join(manifest.sbv2Path, 'server_fastapi.py');

            // Resolve Python Path: Check 'Scripts/python.exe' (typical venv) then 'python.exe' (portable)
            let venvPython = path.join(manifest.venvPath, 'Scripts', 'python.exe');
            if (!fs.existsSync(venvPython)) {
                venvPython = path.join(manifest.venvPath, 'python.exe');
            }

            if (!fs.existsSync(venvPython)) {
                throw new Error(`Python not found at ${venvPython} or default Scripts location`);
            }

            if (!fs.existsSync(serverScript)) {
                throw new Error(`Server script not found: ${serverScript}`);
            }

            // Start process
            await this.spawnServer(venvPython, serverScript, this.port, options?.forceCpu);

            // Wait for health check (pyopenjtalk worker initialization takes time)
            const healthy = await this.waitForHealth(90000);
            if (!healthy) {
                throw new Error('Server failed to become healthy');
            }

            // Update manifest with port
            this.updateManifestPort(this.port);

            // Start health monitoring
            this.startHealthMonitoring();

            this.setState('running');
            return { success: true, port: this.port };

        } catch (err) {
            const error: TtsError = {
                code: 'E_SERVER_FAILED',
                message: err instanceof Error ? err.message : String(err),
            };
            this.lastError = error;
            this.setState('error');
            return { success: false, error };
        }
    }

    /**
     * Stop SBV2 server
     */
    async stop(): Promise<{ success: boolean }> {
        this.stopHealthMonitoring();

        if (this.process) {
            return new Promise((resolve) => {
                this.process!.on('exit', () => {
                    this.process = null;
                    this.setState('stopped');
                    resolve({ success: true });
                });

                // Try graceful shutdown first
                this.process!.kill('SIGTERM');

                // Force kill after timeout
                setTimeout(() => {
                    if (this.process) {
                        this.process.kill('SIGKILL');
                    }
                }, 5000);
            });
        }

        this.setState('stopped');
        return { success: true };
    }

    /**
     * Restart server
     */
    async restart(options?: TtsStartOptions): Promise<{ success: boolean; port?: number; error?: TtsError }> {
        this.setState('restarting');
        await this.stop();
        return this.start(options);
    }

    /**
     * Get GPU information
     */
    async getGpuInfo(): Promise<GpuInfo> {
        const manifest = this.loadInstallManifest();
        if (!manifest) {
            throw new Error('Not installed');
        }

        const scriptPath = path.join(manifest.sbv2Path, 'gpu_check.py');
        let venvPython = path.join(manifest.venvPath, 'Scripts', 'python.exe');
        if (!fs.existsSync(venvPython)) {
            venvPython = path.join(manifest.venvPath, 'python.exe');
        }

        if (!fs.existsSync(venvPython)) {
            // Fallback to system python just in case, but unlikely to work for torch check if venv missing
            throw new Error('Python environment not found');
        }

        return new Promise((resolve, reject) => {
            // We need to run this script in a way that respects the embedded python environment if possible
            // Similar strictly isolated environment execution as spawnServer
            const sbv2Dir = path.dirname(scriptPath);

            // Construct bootstrap to set sys.path, similar to server
            // But for simple script execution, maybe direct exec is enough IF we set PYTHONPATH env var?
            // Embedded python ignores PYTHONPATH env var. So we must use the bootstrap method.

            const pythonBootstrap = `
import sys
sys.path.insert(0, r'${sbv2Dir.replace(/\\/g, '\\\\')}')
__name__ = '__main__'
exec(compile(open(r'${scriptPath.replace(/\\/g, '\\\\')}', encoding='utf-8-sig').read(), r'${scriptPath.replace(/\\/g, '\\\\')}', 'exec'))
`.trim().replace(/\n/g, '; ');

            const proc = spawn(venvPython, ['-c', pythonBootstrap], {
                cwd: sbv2Dir,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (d) => stdout += d.toString());
            proc.stderr.on('data', (d) => stderr += d.toString());

            proc.on('close', (code) => {
                if (code === 0) {
                    try {
                        const info = JSON.parse(stdout.trim());
                        resolve(info);
                    } catch (e) {
                        // Fallback if structured output fails
                        resolve({
                            cudaAvailable: false,
                            cudaVersion: null,
                            torchVersion: 'Error parsing output',
                            deviceCount: 0,
                            currentDevice: 'cpu',
                            devices: ['Parse Error']
                        });
                    }
                } else {
                    reject(new Error(`GPU check failed with code ${code}: ${stderr}`));
                }
            });

            proc.on('error', (err) => {
                reject(err);
            });
        });
    }

    async sliceAudio(datasetName: string, inputDir: string, options?: SliceOptions): Promise<void> {
        const manifest = this.loadInstallManifest();
        if (!manifest) throw new Error('Not installed');

        const venvPython = path.join(manifest.venvPath, 'Scripts', 'python.exe');
        const sliceScript = path.join(manifest.sbv2Path, 'sbv2', 'slice.py');

        const args = [
            sliceScript,
            '--model_name', datasetName,
            '--input_dir', inputDir,
        ];

        if (options?.minSec) args.push('--min_sec', String(options.minSec));
        if (options?.maxSec) args.push('--max_sec', String(options.maxSec));
        if (options?.minSilenceDurMs) args.push('--min_silence_dur_ms', String(options.minSilenceDurMs));
        if (options?.timeSuffix) args.push('--time_suffix');

        console.log(`[Sbv2Runtime] Slicing audio for ${datasetName}:`, args.join(' '));

        const cwd = path.join(manifest.sbv2Path, 'sbv2');

        return new Promise((resolve, reject) => {
            const proc = spawn(venvPython, args, {
                cwd: cwd,
            });

            proc.stdout.on('data', (data) => {
                console.log(`[Slice] ${data.toString().trim()}`);
            });

            proc.stderr.on('data', (data) => {
                console.error(`[Slice] ${data.toString().trim()}`);
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    console.log('[Sbv2Runtime] Slicing completed successfully.');
                    resolve();
                } else {
                    reject(new Error(`Slice process exited with code ${code}`));
                }
            });

            proc.on('error', (err) => {
                reject(err);
            });
        });
    }

    async transcribeAudio(datasetName: string, options?: TranscribeOptions): Promise<void> {
        const manifest = this.loadInstallManifest();
        if (!manifest) throw new Error('Not installed');

        const venvPython = path.join(manifest.venvPath, 'Scripts', 'python.exe');
        const transcribeScript = path.join(manifest.sbv2Path, 'sbv2', 'transcribe.py');
        const cwd = path.join(manifest.sbv2Path, 'sbv2');

        const args = [
            transcribeScript,
            '--model_name', datasetName,
        ];

        if (options?.language) args.push('--language', options.language);
        if (options?.device) args.push('--device', options.device);
        if (options?.model) args.push('--model', options.model);
        if (options?.computeType) args.push('--compute_type', options.computeType);
        if (options?.batchSize) args.push('--batch_size', String(options.batchSize));
        if (options?.numBeams) args.push('--num_beams', String(options.numBeams));
        if (options?.initialPrompt) args.push('--initial_prompt', options.initialPrompt);

        console.log(`[Sbv2Runtime] Transcribing audio for ${datasetName}:`, args.join(' '));

        return new Promise((resolve, reject) => {
            const proc = spawn(venvPython, args, { cwd });

            proc.stdout.on('data', (data) => console.log(`[Transcribe] ${data.toString().trim()}`));
            proc.stderr.on('data', (data) => console.error(`[Transcribe] ${data.toString().trim()}`));

            proc.on('close', (code) => {
                if (code === 0) {
                    console.log('[Sbv2Runtime] Transcription completed successfully.');
                    resolve();
                } else {
                    reject(new Error(`Transcribe process exited with code ${code}`));
                }
            });

            proc.on('error', (err) => reject(err));
        });
    }

    async saveTranscription(datasetName: string, content: string): Promise<void> {
        const manifest = this.loadInstallManifest();
        if (!manifest) throw new Error('Not installed');

        const paths = await this.getPathsConfig();
        const datasetDir = path.join(paths.datasetRoot, datasetName);

        if (!fs.existsSync(datasetDir)) {
            throw new Error(`Dataset directory not found: ${datasetDir}`);
        }

        const transcriptionPath = path.join(datasetDir, 'esd.list');
        await fs.promises.writeFile(transcriptionPath, content, 'utf-8');
        console.log(`[Sbv2Runtime] Saved transcription to ${transcriptionPath}`);
    }

    async initializeTrainingConfig(datasetName: string): Promise<void> {
        const manifest = this.loadInstallManifest();
        if (!manifest) throw new Error('Not installed');

        const paths = await this.getPathsConfig();
        const datasetDir = path.join(paths.datasetRoot, datasetName);

        if (!fs.existsSync(datasetDir)) {
            await fs.promises.mkdir(datasetDir, { recursive: true });
        }

        // Copy config.json template
        const templatePath = path.join(manifest.sbv2Path, 'sbv2', 'configs', 'config.json');
        const targetPath = path.join(datasetDir, 'config.json');

        if (!fs.existsSync(templatePath)) {
            throw new Error(`Template config not found at ${templatePath}`);
        }

        await fs.promises.copyFile(templatePath, targetPath);
        console.log(`[Sbv2Runtime] Initialized config at ${targetPath}`);
    }

    async generateBert(datasetName: string, _options?: { numProcesses?: number; device?: string }): Promise<void> {
        const manifest = this.loadInstallManifest();
        if (!manifest) throw new Error('Not installed');

        const paths = await this.getPathsConfig();
        const configPath = path.join(paths.datasetRoot, datasetName, 'config.json');

        if (!fs.existsSync(configPath)) {
            throw new Error(`Config file not found: ${configPath}. Please initialize config first.`);
        }

        const venvPython = path.join(manifest.venvPath, 'Scripts', 'python.exe');
        const bertGenScript = path.join(manifest.sbv2Path, 'sbv2', 'bert_gen.py');
        const cwd = path.join(manifest.sbv2Path, 'sbv2');

        const args = [bertGenScript, '--config', configPath];

        // Note: bert_gen.py doesn't seem to take num_processes/device via CLI args easily overriding config.json 
        // unless we modify the script or config.json. 
        // But let's check if we can pass them. The script parses known args, but only defines --config.
        // So we rely on config.json settings.

        console.log(`[Sbv2Runtime] Generating BERT features for ${datasetName}:`, args.join(' '));

        return new Promise((resolve, reject) => {
            const proc = spawn(venvPython, args, { cwd });

            proc.stdout.on('data', (data) => console.log(`[BERT] ${data.toString().trim()}`));
            proc.stderr.on('data', (data) => console.error(`[BERT] ${data.toString().trim()}`));

            proc.on('close', (code) => {
                if (code === 0) {
                    console.log('[Sbv2Runtime] BERT generation completed successfully.');
                    resolve();
                } else {
                    reject(new Error(`BERT generation process exited with code ${code}`));
                }
            });

            proc.on('error', (err) => reject(err));
        });
    }

    /**
     * Install training dependencies (excluding torch to enable GPU usage)
     */
    async installTrainingDependencies(): Promise<void> {
        // Stop server first to release any file locks
        await this.stop();

        const manifest = this.loadInstallManifest();
        if (!manifest) {
            throw new Error('Not installed');
        }

        let venvPython = path.join(manifest.venvPath, 'Scripts', 'python.exe');
        if (!fs.existsSync(venvPython)) {
            venvPython = path.join(manifest.venvPath, 'python.exe');
        }

        // Define minimal requirements manually to avoid build errors (e.g. pyannote/av)
        // and to ensure compatibility with existing torch/cuda environment.
        const minimalRequirements = [
            // 'safetensors', // Handled separately with force-reinstall
            'accelerate',
            'tensorboard',
            'transformers',
            'tqdm',
            'scipy',
            'einops',
            // Manual dependencies for transformers/accelerate since we use --no-deps
            'tokenizers',
            'huggingface-hub',
            'packaging',
            'pyyaml',
            'regex',
            'requests',
            'filelock',
            'fsspec',
            'typing-extensions'
        ];

        return new Promise(async (resolve) => {
            // First, try to uninstall 'av' if it exists or is in a broken state
            try {
                await new Promise<void>((res) => {
                    const uninstallProc = spawn(venvPython, ['-m', 'pip', 'uninstall', '-y', 'av'], {
                        cwd: manifest.venvPath
                    });
                    uninstallProc.on('close', () => res());
                });
            } catch (e) {
                console.log('[PIP] Uninstall av failed (might not be installed), ignoring.');
            }

            // Force clean av remnants from file system
            await this.forceCleanPackage(venvPython, 'av');

            // Force clean safetensors remnants (often causes import errors)
            await this.forceCleanPackage(venvPython, 'safetensors');

            // Force clean transformers remnants (to ensure clean slate)
            await this.forceCleanPackage(venvPython, 'transformers');

            // Force clean tokenizers remnants (often causes import errors)
            await this.forceCleanPackage(venvPython, 'tokenizers');


            // Purge broken dependencies requiring av
            await this.purgeAvDependents(venvPython);

            // Install packages one by one to identify the culprit
            for (const pkg of minimalRequirements) {
                console.log(`[PIP] Installing ${pkg}...`);
                await new Promise<void>((resolveInstall, rejectInstall) => {
                    const proc = spawn(venvPython, ['-m', 'pip', 'install', '--no-cache-dir', '--no-deps', '--ignore-installed', pkg], {
                        cwd: manifest.venvPath
                    });

                    let pkgStderr = '';
                    proc.stdout.on('data', (d) => console.log(`[PIP] ${d}`));
                    proc.stderr.on('data', (d) => {
                        const s = d.toString();
                        pkgStderr += s;
                        console.error(`[PIP ERR] ${s}`);
                    });

                    proc.on('close', (code) => {
                        if (code === 0) {
                            resolveInstall();
                        } else {
                            console.error(`[PIP] Failed to install ${pkg}. Continuing...`);
                            rejectInstall(new Error(`Failed to install ${pkg}:\n${pkgStderr.slice(-500)}`));
                        }
                    });
                    proc.on('error', (err) => rejectInstall(err));
                });
            }

            // Explicitly install safetensors with force-reinstall and verify
            console.log('[Sbv2Runtime] Force installing safetensors...');
            await new Promise<void>((resolveSafe, rejectSafe) => {
                // First uninstall explicitly just in case
                const uninstall = spawn(venvPython, ['-m', 'pip', 'uninstall', '-y', 'safetensors'], { cwd: manifest.venvPath });
                uninstall.on('close', () => {
                    const proc = spawn(venvPython, ['-m', 'pip', 'install', 'safetensors', '--force-reinstall', '--no-cache-dir'], {
                        cwd: manifest.venvPath
                    });
                    proc.stdout.on('data', (d) => console.log(`[PIP] ${d}`));
                    proc.stderr.on('data', (d) => console.error(`[PIP ERR] ${d}`));
                    proc.on('close', (code) => {
                        if (code === 0) resolveSafe();
                        else rejectSafe(new Error('Failed to force install safetensors'));
                    });
                });
            });

            // Verify safetensors import immediately
            console.log('[Sbv2Runtime] Verifying safetensors import...');
            await new Promise<void>((resolveVerify, rejectVerify) => {
                const proc = spawn(venvPython, ['-c', 'import safetensors; print("Safetensors OK:", safetensors.__file__)'], {
                    cwd: manifest.venvPath
                });
                proc.stdout.on('data', (d) => console.log(`[VERIFY] ${d}`));
                proc.stderr.on('data', (d) => console.error(`[VERIFY ERR] ${d}`));
                proc.on('close', (code) => {
                    if (code === 0) resolveVerify();
                    else rejectVerify(new Error('Safetensors verification failed. The installation is corrupted.'));
                });
            });

            // Log installed packages for debugging
            await new Promise<void>((res) => {
                console.log('[Sbv2Runtime] Listing installed packages...');
                const listProc = spawn(venvPython, ['-m', 'pip', 'list'], { cwd: manifest.venvPath });
                listProc.stdout.on('data', (d) => console.log(`[PIP LIST] ${d}`));
                listProc.on('close', () => res());
            });

            resolve();
        });
    }

    /**
     * Force clean a package from site-packages by file deletion
     */
    private async forceCleanPackage(venvPython: string, packageName: string): Promise<void> {
        return new Promise<void>((resolve) => {
            try {
                // Assuming Windows venv structure: venv/Scripts/python.exe -> venv/Lib/site-packages
                const venvDir = path.dirname(path.dirname(venvPython));
                const sitePackages = path.join(venvDir, 'Lib', 'site-packages');

                if (fs.existsSync(sitePackages)) {
                    console.log(`[Sbv2Runtime] Force cleaning ${packageName} from ${sitePackages}`);
                    const files = fs.readdirSync(sitePackages);
                    for (const file of files) {
                        const lower = file.toLowerCase();
                        if (lower === packageName || lower.startsWith(`${packageName}-`) || lower.startsWith(`${packageName}.`)) {
                            const target = path.join(sitePackages, file);
                            console.log(`[Sbv2Runtime] Deleting residual file/dir: ${target}`);
                            try {
                                fs.rmSync(target, { recursive: true, force: true });
                            } catch (e) {
                                console.error(`[Sbv2Runtime] Failed to delete ${target}`, e);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error(`[Sbv2Runtime] Failed to force clean ${packageName}:`, err);
            }
            resolve();
        });
    }

    /**
     * Purge packages that require 'av' to fix broken dependency graph
     */
    private async purgeAvDependents(venvPython: string): Promise<void> {
        console.log('[Sbv2Runtime] Checking for broken dependencies requiring "av"...');
        return new Promise<void>((resolve) => {
            const checkProc = spawn(venvPython, ['-m', 'pip', 'check'], { cwd: path.dirname(venvPython) });
            let output = '';
            checkProc.stdout.on('data', (d) => output += d);
            checkProc.stderr.on('data', (d) => output += d); // pip check outputs to stderr/stdout

            checkProc.on('close', async () => {
                const lines = output.split('\n');
                const avDependents = new Set<string>();
                // Example output: "pyannote-audio 3.1.0 requires av, which is not installed."
                // Regex to capture package name at the start
                // Match "package-name ... requires av"
                const regex = /^([a-zA-Z0-9_\-]+).*requires.*av/i;

                for (const line of lines) {
                    if (line.includes('requires') && (line.includes('av,') || line.includes('av>'))) {
                        const match = line.match(regex);
                        if (match && match[1]) {
                            avDependents.add(match[1]);
                        }
                    }
                }

                if (avDependents.size > 0) {
                    console.log(`[Sbv2Runtime] Found packages requiring av: ${Array.from(avDependents).join(', ')}`);
                    console.log('[Sbv2Runtime] Uninstalling them to fix build chain...');

                    for (const pkg of Array.from(avDependents)) {
                        await new Promise<void>((resUrl) => {
                            console.log(`[Sbv2Runtime] Uninstalling ${pkg}...`);
                            const p = spawn(venvPython, ['-m', 'pip', 'uninstall', '-y', pkg], { cwd: path.dirname(venvPython) });
                            p.on('close', () => resUrl());
                        });
                    }
                } else {
                    console.log('[Sbv2Runtime] No broken av dependencies found.');
                }
                resolve();
            });
        });
    }

    // ========================================
    // Private Methods
    // ========================================

    private setState(state: TtsRuntimeState): void {
        this.state = state;
        this.onStateChange?.(state);
    }

    private loadInstallManifest(): InstallManifest | null {
        const manifestPath = path.join(this.installPath, 'install_manifest.json');
        if (!fs.existsSync(manifestPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch {
            return null;
        }
    }

    private updateManifestPort(port: number): void {
        const manifestPath = path.join(this.installPath, 'install_manifest.json');
        try {
            const manifest = this.loadInstallManifest();
            if (manifest) {
                manifest.port = port;
                manifest.lastHealthCheck = new Date().toISOString();
                fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            }
        } catch (err) {
            console.error('[Sbv2Runtime] Failed to update manifest port:', err);
        }
    }

    private async findAvailablePort(): Promise<number | null> {
        for (let port = DEFAULT_PORT_RANGE_START; port <= DEFAULT_PORT_RANGE_END; port++) {
            const available = await this.isPortAvailable(port);
            if (available) return port;
        }
        return null;
    }

    private isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close(() => resolve(true));
            });
            server.listen(port, '127.0.0.1');
        });
    }

    private async spawnServer(pythonExe: string, serverScript: string, port: number, forceCpu?: boolean): Promise<void> {
        const logsDir = path.join(this.installPath, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });

        const logFile = path.join(logsDir, `server_${Date.now()}.log`);
        const logStream = fs.createWriteStream(logFile, { flags: 'a' });

        // Set PYTHONPATH to include the sbv2 directory for local module resolution
        const sbv2Dir = path.dirname(serverScript);

        // Embeddable Python ignores PYTHONPATH when ._pth file exists,
        // so we inject sys.path modification via -c flag
        // We must also set __name__ = '__main__' for the if __name__ == "__main__" block to run
        const pythonBootstrap = `
import sys
sys.path.insert(0, r'${sbv2Dir.replace(/\\/g, '\\\\')}')
sys.argv = ['server_fastapi.py', '--port', '${port}'${forceCpu ? ", '--cpu'" : ''}]
__name__ = '__main__'
exec(compile(open(r'${serverScript.replace(/\\/g, '\\\\')}', encoding='utf-8-sig').read(), r'${serverScript.replace(/\\/g, '\\\\')}', 'exec'))
`.trim().replace(/\n/g, '; ');

        console.log(`[Sbv2Runtime] Starting server with injected sys.path: ${sbv2Dir}`);

        this.process = spawn(pythonExe, ['-c', pythonBootstrap], {
            cwd: sbv2Dir,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout?.pipe(logStream);
        this.process.stderr?.pipe(logStream);

        // Also stream to console for debugging
        this.process.stdout?.on('data', (d) => console.log(`[SBV2 stdout] ${d}`));
        this.process.stderr?.on('data', (d) => console.error(`[SBV2 stderr] ${d}`));

        this.process.on('exit', (code) => {
            console.log(`[Sbv2Runtime] Server exited with code ${code}`);
            logStream.end();

            if (this.state === 'running' || this.state === 'starting') {
                this.handleUnexpectedExit();
            }
        });

        this.process.on('error', (err) => {
            console.error('[Sbv2Runtime] Server process error:', err);
            this.lastError = {
                code: 'E_SERVER_FAILED',
                message: err.message,
            };
        });
    }

    private async waitForHealth(timeoutMs: number): Promise<boolean> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const healthy = await this.checkHealth();
            if (healthy) return true;
            await this.sleep(500);
        }

        return false;
    }

    private async checkHealth(): Promise<boolean> {
        if (!this.port) return false;

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

            const response = await fetch(`http://localhost:${this.port}/health`, {
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (response.ok) {
                return true;
            }

            // Fallback to /openapi.json
            const fallbackResponse = await fetch(`http://localhost:${this.port}/openapi.json`, {
                signal: controller.signal,
            });

            return fallbackResponse.ok;

        } catch {
            return false;
        }
    }

    private startHealthMonitoring(): void {
        this.stopHealthMonitoring();

        this.healthCheckTimer = setInterval(async () => {
            if (this.state !== 'running') return;

            const healthy = await this.checkHealth();
            if (!healthy) {
                console.warn('[Sbv2Runtime] Health check failed');
                this.handleUnexpectedExit();
            }
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    private stopHealthMonitoring(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    private async handleUnexpectedExit(): Promise<void> {
        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            console.error('[Sbv2Runtime] Max restart attempts reached');
            this.lastError = {
                code: 'E_SERVER_FAILED',
                message: 'Server crashed repeatedly',
            };
            this.setState('error');
            return;
        }

        this.restartAttempts++;
        console.log(`[Sbv2Runtime] Attempting restart ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}`);

        await this.sleep(RESTART_BACKOFF_MS * this.restartAttempts);
        await this.restart();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Start model training using train_ms.py via torchrun.
     * This method spawns the training process and returns immediately.
     * The process runs in the background and logs are emitted to console.
     * 
     * @param datasetName - Name of the dataset (e.g., "MyModel")
     * @param options - Training options
     */
    async trainModel(
        datasetName: string,
        options?: {
            speedup?: boolean;        // Disable logging/evaluation for faster training
            noProgressBar?: boolean;  // Disable progress bar
            epochs?: number;          // Override epochs in config
        }
    ): Promise<{ success: boolean; error?: { code: string; message: string } }> {
        const manifest = this.loadInstallManifest();
        if (!manifest) {
            return { success: false, error: { code: 'E_NOT_INSTALLED', message: 'SBV2 is not installed' } };
        }

        const paths = await this.getPathsConfig();
        const datasetPath = path.join(paths.datasetRoot, datasetName);
        const configPath = path.join(datasetPath, 'config.json');

        if (!fs.existsSync(configPath)) {
            return {
                success: false,
                error: { code: 'E_CONFIG_MISSING', message: `Config not found: ${configPath}. Please initialize config first.` }
            };
        }

        // Check that esd.list exists (transcription)
        const esdListPath = path.join(datasetPath, 'esd.list');
        if (!fs.existsSync(esdListPath)) {
            return {
                success: false,
                error: { code: 'E_TRANSCRIPTION_MISSING', message: `Transcription file not found: ${esdListPath}. Please run transcription first.` }
            };
        }

        const venvPython = path.join(manifest.venvPath, 'Scripts', 'python.exe');
        const torchrun = path.join(manifest.venvPath, 'Scripts', 'torchrun.exe');
        const trainScript = path.join(manifest.sbv2Path, 'sbv2', 'train_ms.py');
        const cwd = path.join(manifest.sbv2Path, 'sbv2');

        // Check if torchrun exists
        if (!fs.existsSync(torchrun)) {
            // Fallback to python -m torch.distributed.run
            console.log('[Sbv2Runtime] torchrun not found, using python -m torch.distributed.run');
        }

        // Build args for train_ms.py
        const trainArgs: string[] = [
            '--config', configPath,
            '--model', datasetPath,
            '--assets_root', paths.assetsRoot,
        ];

        if (options?.speedup) {
            trainArgs.push('--speedup');
        }
        if (options?.noProgressBar) {
            trainArgs.push('--no_progress_bar');
        }

        // Environment variables for single-GPU/CPU training (no multi-GPU DDP)
        const env = {
            ...process.env,
            MASTER_ADDR: '127.0.0.1',
            MASTER_PORT: '29500',
            WORLD_SIZE: '1',
            RANK: '0',
            LOCAL_RANK: '0',
        };

        console.log(`[Sbv2Runtime] Starting training for ${datasetName}...`);
        console.log(`[Sbv2Runtime] Config: ${configPath}`);
        console.log(`[Sbv2Runtime] Dataset: ${datasetPath}`);
        console.log(`[Sbv2Runtime] Args: ${trainArgs.join(' ')}`);

        return new Promise((resolve) => {
            let proc: ChildProcess;

            if (fs.existsSync(torchrun)) {
                // Use torchrun for DDP
                proc = spawn(torchrun, ['--standalone', '--nnodes=1', '--nproc_per_node=1', trainScript, ...trainArgs], { cwd, env });
            } else {
                // Fallback to python -m torch.distributed.run
                proc = spawn(venvPython, ['-m', 'torch.distributed.run', '--standalone', '--nnodes=1', '--nproc_per_node=1', trainScript, ...trainArgs], { cwd, env });
            }

            proc.stdout?.on('data', (data) => {
                console.log(`[TRAIN] ${data.toString().trim()}`);
            });

            proc.stderr?.on('data', (data) => {
                // Training logs often go to stderr
                console.log(`[TRAIN] ${data.toString().trim()}`);
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    console.log('[Sbv2Runtime] Training completed successfully.');
                    resolve({ success: true });
                } else {
                    console.error(`[Sbv2Runtime] Training exited with code ${code}`);
                    resolve({ success: false, error: { code: 'E_TRAINING_FAILED', message: `Training process exited with code ${code}` } });
                }
            });

            proc.on('error', (err) => {
                console.error('[Sbv2Runtime] Training process error:', err);
                resolve({ success: false, error: { code: 'E_SPAWN_FAILED', message: err.message } });
            });
        });
    }

    /**
     * Clean dataset audio using DeepFilterNet (via FastAPI endpoint).
     * Removes BGM, reverb, and white noise.
     * 
     * @param datasetName - Name of the dataset to clean
     */
    async cleanAudio(datasetName: string): Promise<{ success: boolean; message?: string; error?: { code: string; message: string } }> {
        if (!this.port) {
            return { success: false, error: { code: 'E_SERVER_NOT_RUNNING', message: 'TTS server is not running' } };
        }

        try {
            const response = await fetch(`http://localhost:${this.port}/dataset/${encodeURIComponent(datasetName)}/clean`, {
                method: 'POST',
            });

            const data = await response.json() as { message?: string; detail?: string };

            if (!response.ok) {
                return {
                    success: false,
                    error: { code: 'E_API_ERROR', message: data.detail || 'Failed to start cleaning' }
                };
            }

            console.log(`[Sbv2Runtime] Audio cleaning started for ${datasetName}`);
            return { success: true, message: data.message };

        } catch (error) {
            console.error('[Sbv2Runtime] Clean audio error:', error);
            return {
                success: false,
                error: { code: 'E_NETWORK', message: error instanceof Error ? error.message : 'Network error' }
            };
        }
    }

    /**
     * Filter dataset audio using Gemini AI quality gate (via FastAPI endpoint).
     * Moves low-quality files to trash folder.
     * Requires GOOGLE_API_KEY environment variable to be set.
     * 
     * @param datasetName - Name of the dataset to filter
     */
    async filterAudio(datasetName: string): Promise<{ success: boolean; message?: string; error?: { code: string; message: string } }> {
        if (!this.port) {
            return { success: false, error: { code: 'E_SERVER_NOT_RUNNING', message: 'TTS server is not running' } };
        }

        try {
            const response = await fetch(`http://localhost:${this.port}/dataset/${encodeURIComponent(datasetName)}/filter`, {
                method: 'POST',
            });

            const data = await response.json() as { message?: string; detail?: string };

            if (!response.ok) {
                return {
                    success: false,
                    error: { code: 'E_API_ERROR', message: data.detail || 'Failed to start filtering' }
                };
            }

            console.log(`[Sbv2Runtime] Audio filtering started for ${datasetName}`);
            return { success: true, message: data.message };

        } catch (error) {
            console.error('[Sbv2Runtime] Filter audio error:', error);
            return {
                success: false,
                error: { code: 'E_NETWORK', message: error instanceof Error ? error.message : 'Network error' }
            };
        }
    }
}
