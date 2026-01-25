/**
 * Whisper Offline Speech-to-Text サービス
 * nodejs-whisper を使用したオフライン音声認識
 */

import * as path from 'path';
import * as fs from 'fs';

// nodejs-whisper は動的にインポート（ESM module）
let nodeWhisper: typeof import('nodejs-whisper') | null = null;

// Whisper モデルの種類
export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large';

// モデル情報
export const WHISPER_MODELS: Record<WhisperModel, { size: string; url: string }> = {
    tiny: { size: '39 MB', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin' },
    base: { size: '142 MB', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' },
    small: { size: '466 MB', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' },
    medium: { size: '1.5 GB', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin' },
    large: { size: '2.9 GB', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large.bin' },
};

class WhisperService {
    private isInitialized = false;
    private modelsDir: string;
    private currentModel: WhisperModel = 'base';

    constructor() {
        // モデルを保存するディレクトリ
        this.modelsDir = path.join(__dirname, '../../whisper-models');
    }

    /**
     * 初期化
     */
    async initialize(): Promise<void> {
        try {
            // nodejs-whisper を動的インポート
            nodeWhisper = await import('nodejs-whisper');

            // モデルディレクトリを作成
            if (!fs.existsSync(this.modelsDir)) {
                fs.mkdirSync(this.modelsDir, { recursive: true });
            }

            this.isInitialized = true;
            console.log('[Whisper] Initialized, models dir:', this.modelsDir);
        } catch (error) {
            console.error('[Whisper] Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * モデルがダウンロード済みか確認
     */
    isModelDownloaded(model: WhisperModel): boolean {
        const modelPath = path.join(this.modelsDir, `ggml-${model}.bin`);
        return fs.existsSync(modelPath);
    }

    /**
     * ダウンロード済みモデル一覧を取得
     */
    getDownloadedModels(): WhisperModel[] {
        const models: WhisperModel[] = [];
        for (const model of Object.keys(WHISPER_MODELS) as WhisperModel[]) {
            if (this.isModelDownloaded(model)) {
                models.push(model);
            }
        }
        return models;
    }

    /**
     * モデルをダウンロード
     */
    async downloadModel(model: WhisperModel, _onProgress?: (percent: number) => void): Promise<void> {
        if (!nodeWhisper) {
            throw new Error('Whisper is not initialized');
        }

        const modelPath = path.join(this.modelsDir, `ggml-${model}.bin`);

        if (fs.existsSync(modelPath)) {
            console.log(`[Whisper] Model ${model} already exists`);
            return;
        }

        console.log(`[Whisper] Downloading model: ${model} (${WHISPER_MODELS[model].size})`);

        // nodejs-whisper は初回実行時に自動でモデルをダウンロードするため、
        // ここでは手動ダウンロードは行わない
        // 実際にWhisperを呼び出すことでモデルがダウンロードされる
        console.log(`[Whisper] Model ${model} will be downloaded on first use`);
    }

    /**
     * 音声ファイルを文字起こし
     * nodejs-whisper はファイルパスを受け取るため、一時ファイルに保存が必要
     */
    async transcribeFile(audioPath: string, model: WhisperModel = 'base'): Promise<string> {
        if (!nodeWhisper) {
            throw new Error('Whisper is not initialized');
        }

        if (!this.isModelDownloaded(model)) {
            throw new Error(`Model ${model} is not downloaded. Please download it first.`);
        }

        try {
            console.log(`[Whisper] Transcribing with model: ${model}`);

            // nodejs-whisper の nodewhisper 関数を使用
            const result = await nodeWhisper.nodewhisper(audioPath, {
                modelName: model,
                autoDownloadModelName: model,
                whisperOptions: {
                    language: 'ja',
                },
            });

            // 結果を文字列に変換
            const transcription = Array.isArray(result)
                ? result.map((r: { speech: string }) => r.speech).join(' ')
                : String(result);

            console.log(`[Whisper] Transcription: ${transcription.substring(0, 50)}...`);
            return transcription;
        } catch (error) {
            console.error('[Whisper] Transcription error:', error);
            throw error;
        }
    }

    /**
     * PCMバッファを文字起こし
     * PCMを一時WAVファイルに変換してから処理
     */
    async transcribePCM(pcmBuffer: Buffer, sampleRate: number = 16000, channels: number = 1, model: WhisperModel = 'base'): Promise<string> {
        const tempDir = path.join(this.modelsDir, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const tempPath = path.join(tempDir, `temp_${Date.now()}.wav`);

        try {
            // PCMをWAVに変換して保存
            const wavBuffer = this.pcmToWav(pcmBuffer, sampleRate, channels);
            fs.writeFileSync(tempPath, wavBuffer);

            // Whisperで文字起こし
            const result = await this.transcribeFile(tempPath, model);

            return result;
        } finally {
            // 一時ファイルを削除
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch (e) {
                console.error('[Whisper] Failed to delete temp file:', e);
            }
        }
    }

    /**
     * PCMをWAVに変換
     */
    private pcmToWav(pcmBuffer: Buffer, sampleRate: number, channels: number): Buffer {
        const bytesPerSample = 2; // 16-bit
        const blockAlign = channels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = pcmBuffer.length;
        const headerSize = 44;

        const buffer = Buffer.alloc(headerSize + dataSize);

        // RIFF header
        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(36 + dataSize, 4);
        buffer.write('WAVE', 8);

        // fmt chunk
        buffer.write('fmt ', 12);
        buffer.writeUInt32LE(16, 16); // chunk size
        buffer.writeUInt16LE(1, 20); // audio format (PCM)
        buffer.writeUInt16LE(channels, 22);
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(byteRate, 28);
        buffer.writeUInt16LE(blockAlign, 32);
        buffer.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample

        // data chunk
        buffer.write('data', 36);
        buffer.writeUInt32LE(dataSize, 40);
        pcmBuffer.copy(buffer, 44);

        return buffer;
    }

    /**
     * 初期化済みかどうか
     */
    getIsInitialized(): boolean {
        return this.isInitialized;
    }

    /**
     * 現在のモデルを取得
     */
    getCurrentModel(): WhisperModel {
        return this.currentModel;
    }

    /**
     * モデルを設定
     */
    setModel(model: WhisperModel): void {
        this.currentModel = model;
    }
}

export const whisperService = new WhisperService();
