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

        // Assuming AG.CubismHost.exe is in resources folder in prod, or specific path in dev
        // For now, let's assume it's next to the executable or in a known location.
        // The user spec assumes: C:\AG\Models\... as model path.
        // But Host Path: "Process Model - Launched as external process".
        // Use a fixed path or relative?
        // Let's assume adjacent to main bundle or C:\AG\bin\AG.CubismHost.exe?
        // Spec didn't enforce Host Path, but implied Controller launches it.
        // I will assume standard resource path for now, but fallback to C:\AG\bin if needed.

        let execPath = path.join((process as any).resourcesPath, 'CubismHost', 'AG.CubismHost.exe');
        // Dev fallback
        if (process.env.NODE_ENV === 'development') {
            // Maybe in a 'bin' folder in project root?
            execPath = path.join(process.cwd(), 'bin', 'AG.CubismHost.exe');
        }

        console.log(`[Cubism] Launching Host: ${execPath}`);

        try {
            // 1. Check if EXE exists
            if (!fs.existsSync(execPath)) {
                console.warn(`[Cubism] Host not found at: ${execPath}. Pending manual deployment.`);
                // We still attempt to connect to pipes, because user might launch host manually.
                // But we suppress the spawn attempt.
            } else {
                // 2. Spawn if found
                this.hostProcess = child_process.spawn(execPath, [], { detached: false });
                this.hostProcess.on('exit', (code) => {
                    console.log(`[Cubism] Host exited with code ${code}`);
                    this.isRunning = false;
                    this.hostProcess = null;
                    // Restart policy (if it was running)
                    setTimeout(() => this.startHost(), 5000);
                });
                this.isRunning = true;
            }

            // 3. Connect Pipes (with new 3s interval)
            this.cmdPipe.connect();
            this.evtPipe.connect();

        } catch (e) {
            console.error('[Cubism] Failed to launch host:', e);
        }
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
