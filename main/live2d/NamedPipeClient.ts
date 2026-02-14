import * as net from 'net';
import { EventEmitter } from 'events';

export class NamedPipeClient extends EventEmitter {
    private pipeName: string;
    private socket: net.Socket | null = null;
    private buffer: string = '';
    private reconnectInterval: number;
    private isReconnecting: boolean = false;
    private shouldReconnect: boolean = true;

    private loggedError: boolean = false;

    constructor(pipeName: string, reconnectInterval: number = 1000) {
        super();
        this.pipeName = pipeName;
        this.reconnectInterval = reconnectInterval;
    }

    public connect() {
        if (this.socket) {
            this.socket.destroy();
        }

        this.shouldReconnect = true;
        this.socket = net.connect(this.pipeName);

        this.socket.on('connect', () => {
            console.log(`[PipeClient] Connected to ${this.pipeName}`);
            this.isReconnecting = false;
            this.loggedError = false; // Reset error flag on success
            this.emit('connect');
        });

        this.socket.on('data', (data) => {
            this.buffer += data.toString();
            this.processBuffer();
        });

        this.socket.on('error', (err) => {
            if (!this.loggedError) {
                console.error(`[PipeClient] Error on ${this.pipeName}:`, err.message);
                this.loggedError = true;
            }
            this.emit('error', err);
        });

        this.socket.on('close', () => {
            // Only log disconnect if we were previously connected (implied by having logged success or reset flag)
            // But actually, for reconnect loop, 'close' fires after 'error'.
            if (!this.loggedError) {
                console.log(`[PipeClient] Disconnected from ${this.pipeName}`);
            }

            this.emit('close');
            if (this.shouldReconnect && !this.isReconnecting) {
                this.isReconnecting = true;
                setTimeout(() => {
                    this.isReconnecting = false;
                    this.connect();
                }, this.reconnectInterval);
            }
        });
    }

    public send(obj: any): boolean {
        if (!this.socket || this.socket.destroyed) {
            return false;
        }
        const json = JSON.stringify(obj) + '\n';
        return this.socket.write(json);
    }

    public close() {
        this.shouldReconnect = false;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    private processBuffer() {
        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line.trim()) {
                try {
                    const obj = JSON.parse(line);
                    this.emit('message', obj);
                } catch (e) {
                    console.error(`[PipeClient] Failed to parse JSON on ${this.pipeName}:`, line);
                }
            }
        }
    }
}
