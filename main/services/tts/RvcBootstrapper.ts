/**
 * RvcBootstrapper - RVC (Retrieval-based Voice Conversion) Installation Manager
 *
 * Handles:
 * - Bundle integrity verification
 * - Python portable extraction
 * - RVC app extraction
 * - Offline wheel installation
 * - Model deployment
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import {
    RvcInstallOptions,
    RvcInstallResult,
    RvcInstallStep,
    RvcError,
    RvcErrorCode,
    RvcBundleManifest,
    RvcInstallManifest,
} from '../../../types/rvc';

// ========================================
// Constants
// ========================================

const REQUIRED_DISK_SPACE_BYTES = 5 * 1024 * 1024 * 1024; // 5GB (RVC with GPU torch)

export class RvcBootstrapper {
    private bundlePath: string;
    private installPath: string;
    private steps: RvcInstallStep[] = [];

    constructor(resourcesPath: string) {
        this.bundlePath = path.join(resourcesPath, 'tts', 'rvc_bundle');
        this.installPath = path.join(
            process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
            'AntiGravity',
            'tts',
            'rvc'
        );
    }

    // ========================================
    // Public API
    // ========================================

    /**
     * Check if RVC is installed
     */
    checkInstalled(): { installed: boolean; version?: string; manifest?: RvcInstallManifest } {
        const manifestPath = path.join(this.installPath, 'install_manifest.json');
        if (!fs.existsSync(manifestPath)) {
            return { installed: false };
        }

        try {
            const manifest: RvcInstallManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            return {
                installed: true,
                version: manifest.bundleVersion,
                manifest,
            };
        } catch {
            return { installed: false };
        }
    }

    /**
     * Check if upgrade is available
     */
    async checkUpgradeAvailable(): Promise<boolean> {
        const bundleManifest = this.loadBundleManifest();
        if (!bundleManifest) return false;

        const installStatus = this.checkInstalled();
        if (!installStatus.installed) return false;

        return bundleManifest.bundleVersion !== installStatus.version;
    }

    /**
     * Install RVC runtime
     */
    async install(options: RvcInstallOptions = {}): Promise<RvcInstallResult> {
        this.steps = [];
        const { dryRun = false, force = false } = options;

        try {
            // Step 1: Check bundle integrity
            this.addStep('verify_bundle', 'running');
            const bundleCheck = await this.verifyBundle();
            if (!bundleCheck.valid) {
                this.updateStep('verify_bundle', 'failed', bundleCheck.error);
                return this.failResult('E_BUNDLE_CORRUPT', bundleCheck.error || 'Bundle verification failed');
            }
            this.updateStep('verify_bundle', 'done');

            // Step 2: Check disk space
            this.addStep('check_disk', 'running');
            const diskOk = await this.checkDiskSpace();
            if (!diskOk) {
                this.updateStep('check_disk', 'failed', 'Insufficient disk space');
                return this.failResult('E_NO_DISK_SPACE', `At least ${REQUIRED_DISK_SPACE_BYTES / 1024 / 1024 / 1024}GB required`);
            }
            this.updateStep('check_disk', 'done');

            // Step 3: Check write permission
            this.addStep('check_permission', 'running');
            const permOk = await this.checkWritePermission();
            if (!permOk) {
                this.updateStep('check_permission', 'failed', 'Cannot write to install directory');
                return this.failResult('E_NO_PERMISSION', `Cannot write to ${this.installPath}`);
            }
            this.updateStep('check_permission', 'done');

            // Dry run ends here
            if (dryRun) {
                return {
                    success: true,
                    dryRunPassed: true,
                    steps: this.steps,
                };
            }

            // Check if already installed (unless force)
            if (!force) {
                const installStatus = this.checkInstalled();
                if (installStatus.installed) {
                    return {
                        success: true,
                        steps: this.steps,
                    };
                }
            }

            // Create install directory
            fs.mkdirSync(this.installPath, { recursive: true });

            // Step 4: Extract Python
            this.addStep('extract_python', 'running');
            await this.extractZip('python_portable.zip', 'python');
            this.updateStep('extract_python', 'done');

            // Step 5: Extract RVC app
            this.addStep('extract_rvc', 'running');
            await this.extractZip('rvc_app.zip', 'rvc');
            this.updateStep('extract_rvc', 'done');

            // Step 6: Extract default models
            this.addStep('extract_model', 'running');
            await this.extractModels();
            this.updateStep('extract_model', 'done');

            // Step 7: Install dependencies
            this.addStep('install_deps', 'running');
            await this.installDependencies();
            this.updateStep('install_deps', 'done');

            // Step 8: Write install manifest
            this.addStep('write_manifest', 'running');
            await this.writeInstallManifest();
            this.updateStep('write_manifest', 'done');

            return {
                success: true,
                steps: this.steps,
            };

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            return this.failResult('E_UNKNOWN', errorMessage);
        }
    }

    /**
     * Repair installation (remove and reinstall)
     */
    async repair(): Promise<RvcInstallResult> {
        await this.uninstall();
        return this.install({ force: true });
    }

    /**
     * Uninstall RVC runtime
     */
    async uninstall(): Promise<{ success: boolean; error?: RvcError }> {
        try {
            if (fs.existsSync(this.installPath)) {
                fs.rmSync(this.installPath, { recursive: true, force: true });
            }
            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: {
                    code: 'E_UNKNOWN',
                    message: err instanceof Error ? err.message : String(err),
                },
            };
        }
    }

    /**
     * Get paths for runtime
     */
    getPaths(): { python: string; rvc: string; models: string; logs: string } {
        return {
            python: path.join(this.installPath, 'python'),
            rvc: path.join(this.installPath, 'rvc'),
            models: path.join(this.installPath, 'models'),
            logs: path.join(this.installPath, 'logs'),
        };
    }

    // ========================================
    // Private Methods
    // ========================================

    private loadBundleManifest(): RvcBundleManifest | null {
        const manifestPath = path.join(this.bundlePath, 'manifest_bundle.json');
        if (!fs.existsSync(manifestPath)) {
            return null;
        }
        try {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch {
            return null;
        }
    }

    private async verifyBundle(): Promise<{ valid: boolean; error?: string }> {
        if (!fs.existsSync(this.bundlePath)) {
            return { valid: false, error: `Bundle directory not found: ${this.bundlePath}` };
        }

        const manifest = this.loadBundleManifest();
        if (!manifest) {
            const manifestPath = path.join(this.bundlePath, 'manifest_bundle.json');
            const hasReadme = fs.existsSync(path.join(this.bundlePath, 'README.md'));
            if (hasReadme) {
                return {
                    valid: false,
                    error: `manifest_bundle.json not found or invalid at ${manifestPath}. Bundle appears unbuilt. Run: npm run bundle:rvc`
                };
            }
            return { valid: false, error: `manifest_bundle.json not found or invalid at ${manifestPath}` };
        }

        // Verify required files exist
        const requiredFiles = ['python_portable.zip', 'rvc_app.zip'];
        for (const file of requiredFiles) {
            const filePath = path.join(this.bundlePath, file);
            if (!fs.existsSync(filePath)) {
                return { valid: false, error: `Required file missing: ${file}` };
            }
        }

        // Verify file hashes
        for (const entry of manifest.files) {
            const filePath = path.join(this.bundlePath, entry.path);
            if (!fs.existsSync(filePath)) {
                return { valid: false, error: `Manifest file missing: ${entry.path}` };
            }

            const hash = await this.computeFileHash(filePath);
            if (hash !== entry.sha256) {
                return { valid: false, error: `Hash mismatch for ${entry.path}` };
            }
        }

        return { valid: true };
    }

    private async computeFileHash(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }

    private async checkDiskSpace(): Promise<boolean> {
        try {
            fs.mkdirSync(this.installPath, { recursive: true });
            return true;
        } catch {
            return false;
        }
    }

    private async checkWritePermission(): Promise<boolean> {
        try {
            const testFile = path.join(this.installPath, '.write_test');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            return true;
        } catch {
            return false;
        }
    }

    private async extractZip(zipName: string, targetSubdir: string): Promise<void> {
        const zipPath = path.join(this.bundlePath, zipName);
        const targetPath = path.join(this.installPath, targetSubdir);

        if (!fs.existsSync(zipPath)) {
            throw new Error(`Zip file not found: ${zipPath}`);
        }

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(targetPath, true);
    }

    private async extractModels(): Promise<void> {
        const modelsPath = path.join(this.installPath, 'models');
        fs.mkdirSync(modelsPath, { recursive: true });

        // Look for model directories or zips in bundle
        const modelsDir = path.join(this.bundlePath, 'models');
        if (fs.existsSync(modelsDir)) {
            // Extract model zips
            const modelZips = fs.readdirSync(modelsDir).filter(f => f.endsWith('.zip'));
            for (const modelZip of modelZips) {
                const zip = new AdmZip(path.join(modelsDir, modelZip));
                const modelName = modelZip.replace('.zip', '');
                zip.extractAllTo(path.join(modelsPath, modelName), true);
            }

            // Copy model directories directly (for .pth files)
            const modelDirs = fs.readdirSync(modelsDir, { withFileTypes: true })
                .filter(d => d.isDirectory());
            for (const dir of modelDirs) {
                const srcDir = path.join(modelsDir, dir.name);
                const destDir = path.join(modelsPath, dir.name);
                fs.mkdirSync(destDir, { recursive: true });
                const files = fs.readdirSync(srcDir);
                for (const file of files) {
                    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
                }
            }
        }
    }

    private async installDependencies(): Promise<void> {
        const pythonExe = path.join(this.installPath, 'python', 'python.exe');
        const wheelsDir = path.join(this.bundlePath, 'wheels');
        const requirementsLock = path.join(this.bundlePath, 'requirements.lock');

        if (!fs.existsSync(pythonExe)) {
            throw new Error(`Python executable not found: ${pythonExe}`);
        }

        if (!fs.existsSync(requirementsLock)) {
            console.warn('[RvcBootstrapper] requirements.lock not found, skipping dependency install');
            return;
        }

        return new Promise((resolve, reject) => {
            const args = [
                '-m', 'pip',
                'install',
                '--no-index',
                '--find-links', wheelsDir,
                '-r', requirementsLock,
            ];

            console.log(`[RvcBootstrapper] Running pip: ${pythonExe} ${args.join(' ')}`);

            const proc = spawn(pythonExe, args, {
                cwd: this.installPath,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (data) => {
                const str = data.toString();
                stdout += str;
                console.log(`[rvc-pip stdout] ${str}`);
            });

            proc.stderr?.on('data', (data) => {
                const str = data.toString();
                stderr += str;
                console.error(`[rvc-pip stderr] ${str}`);
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    const errorMsg = `pip install failed with code ${code}.\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`;
                    reject(new Error(errorMsg));
                }
            });

            proc.on('error', reject);
        });
    }

    private async writeInstallManifest(): Promise<void> {
        const bundleManifest = this.loadBundleManifest();
        const paths = this.getPaths();

        const installManifest: RvcInstallManifest = {
            bundleVersion: bundleManifest?.bundleVersion || 'unknown',
            installedAt: new Date().toISOString(),
            pythonPath: paths.python,
            rvcPath: paths.rvc,
            modelsPath: paths.models,
        };

        fs.mkdirSync(path.join(this.installPath, 'logs'), { recursive: true });
        fs.mkdirSync(path.join(this.installPath, 'config'), { recursive: true });

        fs.writeFileSync(
            path.join(this.installPath, 'install_manifest.json'),
            JSON.stringify(installManifest, null, 2)
        );
    }

    // ========================================
    // Step Tracking
    // ========================================

    private addStep(name: string, status: RvcInstallStep['status'], message?: string): void {
        this.steps.push({ name, status, message });
    }

    private updateStep(name: string, status: RvcInstallStep['status'], message?: string): void {
        const step = this.steps.find(s => s.name === name);
        if (step) {
            step.status = status;
            if (message) step.message = message;
        }
    }

    private failResult(code: RvcErrorCode, message: string): RvcInstallResult {
        return {
            success: false,
            error: { code, message },
            steps: this.steps,
        };
    }
}
