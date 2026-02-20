/**
 * RvcRuntime - RVC Process Lifecycle Manager
 *
 * Handles:
 * - Starting RVC FastAPI server
 * - Port allocation (50031-50040)
 * - Health monitoring
 * - Auto-restart on crash
 * - Clean shutdown
 */

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import {
    RvcRuntimeState,
    RvcError,
    RvcInstallManifest,
    RvcStartOptions,
} from '../../../types/rvc';
import { GpuInfo } from '../../../types/tts';

// ========================================
// Constants
// ========================================

const DEFAULT_PORT_RANGE_START = 50031;
const DEFAULT_PORT_RANGE_END = 50040;
const HEALTH_CHECK_INTERVAL_MS = 30000;
const HEALTH_CHECK_TIMEOUT_MS = 30000;
const HEALTH_CHECK_CONSECUTIVE_FAILURE_LIMIT = 3;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = 2000;

export class RvcRuntime {
    private installPath: string;
    private process: ChildProcess | null = null;
    private state: RvcRuntimeState = 'stopped';
    private port: number | null = null;
    private verboseLogs = false;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private healthConsecutiveFailures = 0;
    private activeConversionCount = 0;
    private restartAttempts = 0;
    private lastError: RvcError | null = null;
    private onStateChange?: (state: RvcRuntimeState) => void;

    constructor(installPath: string) {
        this.installPath = installPath;
    }

    // ========================================
    // Public API
    // ========================================

    getState(): RvcRuntimeState {
        return this.state;
    }

    getPort(): number | null {
        return this.port;
    }

    getEndpoint(): string | null {
        if (this.port === null) return null;
        return `http://localhost:${this.port}`;
    }

    getLastError(): RvcError | null {
        return this.lastError;
    }

    setVerboseLogs(enabled: boolean): void {
        this.verboseLogs = !!enabled;
    }

    getVerboseLogs(): boolean {
        return this.verboseLogs;
    }

    setStateChangeHandler(handler: (state: RvcRuntimeState) => void): void {
        this.onStateChange = handler;
    }

    beginConversion(): void {
        this.activeConversionCount += 1;
    }

    endConversion(): void {
        this.activeConversionCount = Math.max(0, this.activeConversionCount - 1);
    }

    /**
     * Start RVC FastAPI server
     */
    async start(options?: RvcStartOptions): Promise<{ success: boolean; port?: number; error?: RvcError }> {
        if (this.state === 'running' || this.state === 'starting') {
            return { success: true, port: this.port || undefined };
        }

        if (typeof options?.verboseLogs === 'boolean') {
            this.verboseLogs = options.verboseLogs;
        }

        this.setState('starting');
        this.lastError = null;
        this.restartAttempts = 0;
        this.healthConsecutiveFailures = 0;
        this.activeConversionCount = 0;

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

            const serverScript = path.join(manifest.rvcPath, 'rvc_server.py');

            // Resolve Python Path
            let pythonExe = path.join(manifest.pythonPath, 'Scripts', 'python.exe');
            if (!fs.existsSync(pythonExe)) {
                pythonExe = path.join(manifest.pythonPath, 'python.exe');
            }

            if (!fs.existsSync(pythonExe)) {
                throw new Error(`Python not found at ${pythonExe}`);
            }

            if (!fs.existsSync(serverScript)) {
                throw new Error(`Server script not found: ${serverScript}`);
            }

            // Start process
            await this.spawnServer(pythonExe, serverScript, this.port, options?.forceCpu);

            // Wait for health check
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
            const error: RvcError = {
                code: 'E_SERVER_FAILED',
                message: err instanceof Error ? err.message : String(err),
            };
            this.lastError = error;
            this.setState('error');
            return { success: false, error };
        }
    }

    /**
     * Stop RVC server
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
    async restart(options?: RvcStartOptions): Promise<{ success: boolean; port?: number; error?: RvcError }> {
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

        const scriptPath = path.join(manifest.rvcPath, 'gpu_check.py');
        let pythonExe = path.join(manifest.pythonPath, 'Scripts', 'python.exe');
        if (!fs.existsSync(pythonExe)) {
            pythonExe = path.join(manifest.pythonPath, 'python.exe');
        }

        if (!fs.existsSync(pythonExe)) {
            throw new Error('Python environment not found');
        }

        return new Promise((resolve, reject) => {
            const rvcDir = path.dirname(scriptPath);

            const pythonBootstrap = `
import sys
sys.path.insert(0, r'${rvcDir.replace(/\\/g, '\\\\')}')
__name__ = '__main__'
exec(compile(open(r'${scriptPath.replace(/\\/g, '\\\\')}', encoding='utf-8-sig').read(), r'${scriptPath.replace(/\\/g, '\\\\')}', 'exec'))
`.trim().replace(/\n/g, '; ');

            const proc = spawn(pythonExe, ['-c', pythonBootstrap], {
                cwd: rvcDir,
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
                    } catch {
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

    // ========================================
    // Private Methods
    // ========================================

    private setState(state: RvcRuntimeState): void {
        this.state = state;
        this.onStateChange?.(state);
    }

    private loadInstallManifest(): RvcInstallManifest | null {
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
            console.error('[RvcRuntime] Failed to update manifest port:', err);
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

        const rvcDir = path.dirname(serverScript);

        // Embeddable Python ignores PYTHONPATH when ._pth file exists,
        // so we inject sys.path modification via -c flag
        const pythonBootstrap = `
import sys
sys.path.insert(0, r'${rvcDir.replace(/\\/g, '\\\\')}')
sys.argv = ['rvc_server.py', '--port', '${port}'${forceCpu ? ", '--cpu'" : ''}]
__name__ = '__main__'
exec(compile(open(r'${serverScript.replace(/\\/g, '\\\\')}', encoding='utf-8-sig').read(), r'${serverScript.replace(/\\/g, '\\\\')}', 'exec'))
`.trim().replace(/\n/g, '; ');

        console.log(`[RvcRuntime] Starting server with injected sys.path: ${rvcDir} (verboseLogs=${this.verboseLogs})`);

        this.process = spawn(pythonExe, ['-c', pythonBootstrap], {
            cwd: rvcDir,
            detached: false,
            env: {
                ...process.env,
                RVC_MODELS_DIR: path.join(this.installPath, 'models'),
                RVC_VERBOSE_LOG: this.verboseLogs ? '1' : '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout?.pipe(logStream);
        this.process.stderr?.pipe(logStream);

        this.process.stdout?.on('data', (d) => {
            const text = d.toString();
            if (this.verboseLogs) {
                console.log(`[RVC stdout] ${text}`);
                return;
            }
            if (/traceback|error|exception|failed/i.test(text)) {
                console.warn(`[RVC stdout] ${text}`);
            }
        });
        this.process.stderr?.on('data', (d) => {
            const text = d.toString();
            if (this.verboseLogs) {
                console.error(`[RVC stderr] ${text}`);
                return;
            }
            // In quiet mode, keep only actionable errors.
            if (/traceback|error|exception|failed/i.test(text)) {
                console.error(`[RVC stderr] ${text}`);
            }
        });

        this.process.on('exit', (code) => {
            console.log(`[RvcRuntime] Server exited with code ${code}`);
            logStream.end();

            if (this.state === 'running' || this.state === 'starting') {
                this.handleUnexpectedExit();
            }
        });

        this.process.on('error', (err) => {
            console.error('[RvcRuntime] Server process error:', err);
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
            return response.ok;

        } catch {
            return false;
        }
    }

    private startHealthMonitoring(): void {
        this.stopHealthMonitoring();
        this.healthConsecutiveFailures = 0;

        this.healthCheckTimer = setInterval(async () => {
            if (this.state !== 'running') return;

            if (this.activeConversionCount > 0) {
                // /convert can take minutes on long audio. Skip watchdog during active inference.
                this.healthConsecutiveFailures = 0;
                return;
            }

            const healthy = await this.checkHealth();
            if (!healthy) {
                this.healthConsecutiveFailures += 1;
                console.warn(`[RvcRuntime] Health check failed (${this.healthConsecutiveFailures}/${HEALTH_CHECK_CONSECUTIVE_FAILURE_LIMIT})`);
                if (this.healthConsecutiveFailures >= HEALTH_CHECK_CONSECUTIVE_FAILURE_LIMIT) {
                    this.handleUnexpectedExit();
                }
                return;
            }
            this.healthConsecutiveFailures = 0;
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    private stopHealthMonitoring(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    private async handleUnexpectedExit(): Promise<void> {
        if (this.state === 'restarting') {
            return;
        }

        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            console.error('[RvcRuntime] Max restart attempts reached');
            this.lastError = {
                code: 'E_SERVER_FAILED',
                message: 'Server crashed repeatedly',
            };
            this.setState('error');
            return;
        }

        this.restartAttempts++;
        console.log(`[RvcRuntime] Attempting restart ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}`);

        await this.sleep(RESTART_BACKOFF_MS * this.restartAttempts);
        await this.restart();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
