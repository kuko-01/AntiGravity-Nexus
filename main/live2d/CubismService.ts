import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { WebContents } from 'electron';
import { NamedPipeClient } from './NamedPipeClient';
import { v4 as uuidv4 } from 'uuid';

export class CubismService {
    private static instance: CubismService;
    private hostProcess: child_process.ChildProcess | null = null;
    private cmdPipe: NamedPipeClient;
    private evtPipe: NamedPipeClient;
    private isRunning: boolean = false;
    private webContents: WebContents | null = null;

    private cachedStatus: any = null;

    private constructor() {
        // Increase reconnect interval to 3000ms to reduce log spam when host is missing
        this.cmdPipe = new NamedPipeClient('\\\\.\\pipe\\AG.CubismHost.Cmd', 3000);
        this.evtPipe = new NamedPipeClient('\\\\.\\pipe\\AG.CubismHost.Evt', 3000);

        this.evtPipe.on('message', (msg: any) => this.handleEvent(msg));
        this.cmdPipe.on('connect', () => console.log('[Cubism] Cmd Pipe Connected'));
        this.evtPipe.on('connect', () => console.log('[Cubism] Evt Pipe Connected'));

        // Prevent Uncaught Exception by handling error events
        this.cmdPipe.on('error', () => { /* Handled internally by NamedPipeClient logging */ });
        this.evtPipe.on('error', () => { /* Handled internally by NamedPipeClient logging */ });
    }

    public static getInstance(): CubismService {
        if (!CubismService.instance) {
            CubismService.instance = new CubismService();
        }
        return CubismService.instance;
    }

    public setWebContents(wc: WebContents) {
        this.webContents = wc;
    }

    public startHost() {
        if (this.isRunning) return;
        const externalHostMode = process.env.CUBISM_EXTERNAL_HOST === '1';
        const execPath = this.resolveHostPath();
        if (execPath) {
            console.log(`[Cubism] Launching Host: ${execPath}`);
        }

        try {
            // 1. Spawn host only when executable is available
            if (!execPath) {
                if (externalHostMode) {
                    console.warn('[Cubism] Host executable not found. External host mode is enabled; waiting for named pipes.');
                    this.cmdPipe.connect();
                    this.evtPipe.connect();
                } else {
                    console.warn('[Cubism] Host executable not found. Live2D host startup skipped (set CUBISM_EXTERNAL_HOST=1 to allow external pipe polling).');
                }
            } else {
                // 2. Spawn host when found
                this.hostProcess = child_process.spawn(execPath, [], { detached: false });
                this.hostProcess.on('exit', (code) => {
                    console.log(`[Cubism] Host exited with code ${code}`);
                    this.isRunning = false;
                    this.hostProcess = null;
                    // Restart policy (if it was running)
                    setTimeout(() => this.startHost(), 5000);
                });
                this.isRunning = true;
                // 3. Connect Pipes after spawn
                this.cmdPipe.connect();
                this.evtPipe.connect();
            }

        } catch (e) {
            console.error('[Cubism] Failed to launch host:', e);
        }
    }

    private resolveHostPath(): string | null {
        const fromEnv = process.env.CUBISM_HOST_PATH;
        if (fromEnv && fs.existsSync(fromEnv)) {
            return fromEnv;
        }

        const candidates = [
            path.join((process as any).resourcesPath, 'CubismHost', 'AG.CubismHost.exe'),
            path.join(process.cwd(), 'resources', 'CubismHost', 'AG.CubismHost.exe'),
            path.join(process.cwd(), 'bin', 'AG.CubismHost.exe')
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    public sendCommand(type: string, name: string, payload: any = {}): string {
        const msgId = uuidv4();
        const cmd = {
            msgId,
            type,
            name,
            ts: new Date().toISOString(),
            payload
        };
        this.cmdPipe.send(cmd);
        return msgId;
    }

    private handleEvent(msg: any) {
        if (msg.type === 'Event') {
            if (msg.name === 'Host.Status') {
                this.cachedStatus = msg.payload;
            }
            // Forward to renderer
            if (this.webContents) {
                this.webContents.send('cubism:event', msg);
            }
        } else if (msg.type === 'Response') {
            // Forward responses too
            if (this.webContents) {
                this.webContents.send('cubism:response', msg);
            }
        }
    }

    public getStatus() {
        return this.cachedStatus;
    }
}
