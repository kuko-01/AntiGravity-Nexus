/**
 * 音声キャプチャサービス
 * 選択したオーディオデバイスから音声ストリームを取得・管理する
 */

export interface AudioCaptureCallbacks {
    onAudioData?: (audioBlob: Blob) => void; // WebM (Legacy/Fallback)
    onRawAudioData?: (data: { buffer: number[]; sampleRate: number; channels: number; source?: 'system' | 'mic' }) => void; // PCM (New)
    onError: (error: Error) => void;
}

class AudioCaptureService {
    private mediaStream: MediaStream | null = null;
    private micStream: MediaStream | null = null;
    private audioContext: AudioContext | null = null;
    private scriptProcessor: ScriptProcessorNode | null = null;
    private micScriptProcessor: ScriptProcessorNode | null = null; // マイク用
    private sourceNodes: MediaStreamAudioSourceNode[] = [];
    private mediaRecorder: MediaRecorder | null = null; // Legacy support
    private isCapturing = false;
    private callbacks: AudioCaptureCallbacks | null = null;
    private restartInterval: NodeJS.Timeout | null = null;

    /**
     * 利用可能なオーディオ入力デバイス一覧を取得
     */
    async getAudioDevices(): Promise<MediaDeviceInfo[]> {
        try {
            // デバイス一覧を取得する前にマイク権限を要求（権限がないとラベルが取得できない）
            await navigator.mediaDevices.getUserMedia({ audio: true });

            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(device => device.kind === 'audioinput');
        } catch (error) {
            console.error('Failed to enumerate audio devices:', error);
            return [];
        }
    }

    /**
     * 指定したオーディオデバイスからキャプチャを開始
     */
    async startCaptureFromDevice(deviceId: string, callbacks: AudioCaptureCallbacks): Promise<void> {
        if (this.isCapturing) {
            await this.stopCapture();
        }

        this.callbacks = callbacks;
        this.isCapturing = true;

        try {
            // 指定されたデバイスIDで音声を取得
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });

            // 音声トラックがあるか確認
            const audioTracks = this.mediaStream.getAudioTracks();
            if (audioTracks.length === 0) {
                throw new Error('選択したデバイスから音声を取得できませんでした。');
            }

            console.log('[AudioCapture] Audio tracks found:', audioTracks.length);
            console.log('[AudioCapture] Using device:', audioTracks[0].label);

            this.createMediaRecorder();

            console.log('[AudioCapture] Recording started');

            // 定期的に再起動（完全なヘッダー付きファイルを作成するため）
            if (this.restartInterval) clearInterval(this.restartInterval);
            this.restartInterval = setInterval(() => {
                this.restartRecording();
            }, 10000); // 10秒ごと

        } catch (error) {
            console.error('Audio capture error:', error);
            const errorMessage = error instanceof Error
                ? error.message
                : 'オーディオデバイスからキャプチャできません。別のデバイスを選択してください。';
            const err = new Error(errorMessage);
            this.callbacks?.onError(err);
            this.isCapturing = false;
            throw err;
        }
    }

    async startCaptureFromSystemAudio(callbacks: AudioCaptureCallbacks, micDeviceId?: string, includeMic: boolean = true): Promise<void> {
        if (this.isCapturing) {
            await this.stopCapture();
        }

        this.callbacks = callbacks;
        this.isCapturing = true;

        try {
            // 1. システム音声ストリームを取得
            this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    displaySurface: 'monitor',
                } as DisplayMediaStreamOptions['video'],
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });

            // ビデオトラックを停止（音声のみ必要）
            this.mediaStream.getVideoTracks().forEach((track) => track.stop());

            const sysAudioTracks = this.mediaStream.getAudioTracks();
            if (sysAudioTracks.length === 0) {
                throw new Error('システム音声を取得できませんでした。画面共有時に「システム音声を共有」を有効にしてください。');
            }
            console.log('[AudioCapture] System audio tracks found:', sysAudioTracks.length);

            // 2. マイク音声ストリームを取得（includeMicがtrueの場合のみ）
            if (includeMic) {
                try {
                    // ユーザー指定のIDがあれば使う、なければデフォルト
                    const constraint = micDeviceId ? { deviceId: { exact: micDeviceId } } : true;
                    this.micStream = await navigator.mediaDevices.getUserMedia({
                        audio: typeof constraint === 'object' ? {
                            ...constraint,
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false,
                        } : {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false,
                        },
                    });
                    console.log('[AudioCapture] Mic audio tracks found:', this.micStream.getAudioTracks().length);
                } catch (micError) {
                    console.warn('[AudioCapture] Failed to get mic stream (proceeding with system audio only):', micError);
                }
            } else {
                console.log('[AudioCapture] Mic capture disabled by user');
            }

            // 3. AudioContext初期化
            this.audioContext = new AudioContext({ sampleRate: 16000 }); // GCP推奨の16kHz
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            const destination = this.audioContext.createMediaStreamDestination(); // Legacy Recorder用

            // --- システム音声処理 ---
            const sysSource = this.audioContext.createMediaStreamSource(this.mediaStream);
            sysSource.connect(destination); // Legacy用
            this.sourceNodes.push(sysSource);

            this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
            sysSource.connect(this.scriptProcessor);

            // 動作確認のため、GainNode(0)を経由してdestinationに繋ぐ（AudioWorklet/ScriptProcessor駆動用）
            const sysGain = this.audioContext.createGain();
            sysGain.gain.value = 0; // 無音にする
            this.scriptProcessor.connect(sysGain);
            sysGain.connect(this.audioContext.destination);

            this.scriptProcessor.onaudioprocess = (event) => {
                // 出力を完全に無音にする（ハウリング/ノイズ防止）
                const outputBuffer = event.outputBuffer;
                for (let ch = 0; ch < outputBuffer.numberOfChannels; ch++) {
                    outputBuffer.getChannelData(ch).fill(0);
                }

                if (!this.isCapturing) return;

                const inputBuffer = event.inputBuffer;
                const inputData = inputBuffer.getChannelData(0);

                const pcmData = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                if (this.callbacks?.onRawAudioData) {
                    this.callbacks.onRawAudioData({
                        buffer: Array.from(pcmData),
                        sampleRate: inputBuffer.sampleRate,
                        channels: 1,
                        source: 'system' // ソース: system
                    });
                }
            };

            // --- マイク音声処理 ---
            if (this.micStream) {
                const micSource = this.audioContext.createMediaStreamSource(this.micStream);
                micSource.connect(destination); // Legacy用
                this.sourceNodes.push(micSource);

                this.micScriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
                micSource.connect(this.micScriptProcessor);

                // 駆動用接続 (Gain 0)
                const micGain = this.audioContext.createGain();
                micGain.gain.value = 0;
                this.micScriptProcessor.connect(micGain);
                micGain.connect(this.audioContext.destination);

                this.micScriptProcessor.onaudioprocess = (event) => {
                    // 出力を完全に無音にする
                    const outputBuffer = event.outputBuffer;
                    for (let ch = 0; ch < outputBuffer.numberOfChannels; ch++) {
                        outputBuffer.getChannelData(ch).fill(0);
                    }

                    if (!this.isCapturing) return;

                    const inputBuffer = event.inputBuffer;
                    const inputData = inputBuffer.getChannelData(0);

                    const pcmData = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        const s = Math.max(-1, Math.min(1, inputData[i]));
                        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }

                    if (this.callbacks?.onRawAudioData) {
                        this.callbacks.onRawAudioData({
                            buffer: Array.from(pcmData),
                            sampleRate: inputBuffer.sampleRate,
                            channels: 1,
                            source: 'mic' // ソース: mic
                        });
                    }
                };
            }

            // Legacy用: MediaRecorder (WebM 保存はシステム+マイクのMix)
            this.mediaRecorder = new MediaRecorder(destination.stream, {
                mimeType: 'audio/webm;codecs=opus',
            });
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0 && this.callbacks?.onAudioData) {
                    this.callbacks.onAudioData(event.data);
                }
            };
            this.mediaRecorder.start(1000); // 1秒ごとにチャンク作成


            console.log('[AudioCapture] System + Mic discrete processing started');

        } catch (error) {
            console.error('System audio capture error:', error);
            const errorMessage = error instanceof Error
                ? error.message
                : 'システム音声をキャプチャできません。画面共有を許可してください。';
            const err = new Error(errorMessage);
            this.callbacks?.onError(err);
            this.isCapturing = false;
            throw err;
        }
    }

    /**
     * 音声キャプチャを開始 (後方互換性のため残す)
     */
    async startCapture(sourceId: string, callbacks: AudioCaptureCallbacks): Promise<void> {
        return this.startCaptureFromDevice(sourceId, callbacks);
    }

    private createMediaRecorder() {
        if (!this.mediaStream) return;

        // MediaRecorder で音声をチャンク化
        this.mediaRecorder = new MediaRecorder(this.mediaStream, {
            mimeType: 'audio/webm;codecs=opus',
        });

        this.mediaRecorder.ondataavailable = (event) => {
            console.log('[AudioCapture] Data available:', event.data.size, 'bytes');
            if (event.data.size > 0 && this.callbacks) {
                this.callbacks.onAudioData(event.data);
            }
        };

        this.mediaRecorder.onerror = (_event) => {
            const error = new Error('録音中にエラーが発生しました');
            this.callbacks?.onError(error);
        };

        this.mediaRecorder.start();
    }

    /**
     * 録音を停止して即座に再開する
     */
    private restartRecording() {
        if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive' || !this.isCapturing) return;

        console.log('[AudioCapture] Restarting recording for next chunk...');

        this.mediaRecorder.stop();

        setTimeout(() => {
            if (this.isCapturing && this.mediaStream && this.mediaStream.active) {
                if (this.mediaRecorder && this.mediaRecorder.state === 'inactive') {
                    this.mediaRecorder.start();
                }
            }
        }, 100);
    }

    /**
     * マイク音声のみをキャプチャ (PCM)
     * Per-App キャプチャ時の並列実行用
     */
    async startMicOnlyCapture(deviceId: string, callbacks: AudioCaptureCallbacks): Promise<void> {
        if (this.isCapturing) {
            await this.stopCapture();
        }

        this.callbacks = callbacks;
        this.isCapturing = true;

        try {
            console.log('[AudioCapture] startMicOnlyCapture called. DeviceId:', deviceId);

            // 1. マイクストリーム取得
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 44100 // 高音質
                },
            });
            console.log('[AudioCapture] Mic stream obtained. Tracks:', this.micStream.getAudioTracks().length);

            // 2. AudioContext 初期化
            this.audioContext = new AudioContext({ sampleRate: 44100 });
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            const micSource = this.audioContext.createMediaStreamSource(this.micStream);
            this.sourceNodes.push(micSource);

            this.micScriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
            micSource.connect(this.micScriptProcessor);

            // 駆動用接続 (Gain 0)
            const micGain = this.audioContext.createGain();
            micGain.gain.value = 0;
            this.micScriptProcessor.connect(micGain);
            micGain.connect(this.audioContext.destination);

            this.micScriptProcessor.onaudioprocess = (event) => {
                // ハウリング防止
                const outputBuffer = event.outputBuffer;
                for (let ch = 0; ch < outputBuffer.numberOfChannels; ch++) {
                    outputBuffer.getChannelData(ch).fill(0);
                }

                if (!this.isCapturing) return;

                const inputData = event.inputBuffer.getChannelData(0);

                const pcmData = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                if (this.callbacks?.onRawAudioData) {
                    this.callbacks.onRawAudioData({
                        buffer: Array.from(pcmData),
                        sampleRate: event.inputBuffer.sampleRate,
                        channels: 1,
                        source: 'mic'
                    });
                }
            };

            console.log('[AudioCapture] Mic only capture started (PCM)');

        } catch (error) {
            console.error('Mic capture error:', error);
            const err = error instanceof Error ? error : new Error('マイクキャプチャの開始に失敗しました');
            this.callbacks?.onError(err);
            this.isCapturing = false;
            throw err;
        }
    }

    /**
     * 音声キャプチャを停止
     */
    async stopCapture(): Promise<void> {
        this.isCapturing = false;

        if (this.restartInterval) {
            clearInterval(this.restartInterval);
            this.restartInterval = null;
        }

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        this.mediaRecorder = null;

        // Cleanup mixing resources
        if (this.scriptProcessor) {
            this.scriptProcessor.disconnect();
            this.scriptProcessor = null;
        }
        if (this.micScriptProcessor) {
            this.micScriptProcessor.disconnect();
            this.micScriptProcessor = null;
        }

        this.sourceNodes.forEach(node => {
            try {
                node.disconnect();
            } catch (e) { /* ignore */ }
        });
        this.sourceNodes = [];

        if (this.audioContext) {
            if (this.audioContext.state !== 'closed') {
                await this.audioContext.close();
            }
            this.audioContext = null;
        }

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop());
            this.mediaStream = null;
        }

        if (this.micStream) {
            this.micStream.getTracks().forEach((track) => track.stop());
            this.micStream = null;
        }

        this.callbacks = null;
        console.log('[AudioCapture] Capture stopped and resources cleaned up');
    }

    /**
     * キャプチャ中かどうか
     */
    getIsCapturing(): boolean {
        return this.isCapturing;
    }
}

export const audioCaptureService = new AudioCaptureService();
