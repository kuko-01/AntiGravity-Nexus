/**
 * GCP Streaming Speech-to-Text サービス
 * リアルタイム音声認識のためのストリーミングAPI
 */

import { SpeechClient } from '@google-cloud/speech';
import * as path from 'path';
import { EventEmitter } from 'events';

// ストリーミング認識の設定
interface StreamingConfig {
    sampleRateHertz: number;
    audioChannelCount: number;
    languageCode: string;
    enableAutomaticPunctuation: boolean;
    enableSpeakerDiarization?: boolean;
    minSpeakerCount?: number;
    maxSpeakerCount?: number;
}

// ストリーミング結果
interface StreamingResult {
    transcript: string;
    isFinal: boolean;
    speakerTag?: number;
}

class StreamingSpeechToTextService extends EventEmitter {
    private client: SpeechClient | null = null;
    private recognizeStream: ReturnType<SpeechClient['streamingRecognize']> | null = null;
    private isStreaming = false;
    private restartTimeout: NodeJS.Timeout | null = null;
    private config: StreamingConfig | null = null;

    // ストリーム再接続間隔（GCP制限は5分）
    private readonly STREAM_LIMIT_MS = 290000; // 4分50秒で再接続

    /**
     * 初期化
     */
    initialize(credentialsPath: string): void {
        try {
            const absolutePath = path.resolve(credentialsPath);
            console.log('[StreamingSpeech] Initializing with credentials:', absolutePath);

            this.client = new SpeechClient({
                keyFilename: absolutePath,
            });

            console.log('[StreamingSpeech] Initialized successfully');
        } catch (error) {
            console.error('[StreamingSpeech] Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * ストリーミング認識を開始
     */
    startStreaming(config: StreamingConfig): void {
        if (!this.client) {
            throw new Error('StreamingSpeechToTextService is not initialized');
        }

        if (this.isStreaming) {
            console.log('[StreamingSpeech] Already streaming, stopping first...');
            this.stopStreaming();
        }

        this.config = config;
        this.createRecognizeStream();
        this.isStreaming = true;

        console.log('[StreamingSpeech] Streaming started');
    }

    /**
     * 認識ストリームを作成
     */
    private createRecognizeStream(): void {
        if (!this.client || !this.config) return;

        const request = {
            config: {
                encoding: 'LINEAR16' as const,
                sampleRateHertz: this.config.sampleRateHertz,
                audioChannelCount: this.config.audioChannelCount,
                languageCode: this.config.languageCode,
                enableAutomaticPunctuation: this.config.enableAutomaticPunctuation,
                model: 'latest_long',
                ...(this.config.enableSpeakerDiarization && {
                    diarizationConfig: {
                        enableSpeakerDiarization: true,
                        minSpeakerCount: this.config.minSpeakerCount || 2,
                        maxSpeakerCount: this.config.maxSpeakerCount || 6,
                    },
                }),
            },
            interimResults: true,
        };

        this.recognizeStream = this.client.streamingRecognize(request)
            .on('data', (response) => {
                if (response.results && response.results.length > 0) {
                    const result = response.results[0];
                    const alternative = result.alternatives?.[0];

                    if (alternative) {
                        const streamingResult: StreamingResult = {
                            transcript: alternative.transcript || '',
                            isFinal: result.isFinal || false,
                        };

                        // 話者情報があれば追加
                        const words = alternative.words;
                        if (words && words.length > 0) {
                            streamingResult.speakerTag = words[words.length - 1].speakerTag || undefined;
                        }

                        this.emit('result', streamingResult);
                    }
                }
            })
            .on('error', (error) => {
                console.error('[StreamingSpeech] Stream error:', error);
                this.emit('error', error);

                // 自動再接続
                if (this.isStreaming && this.config) {
                    console.log('[StreamingSpeech] Attempting to reconnect...');
                    setTimeout(() => {
                        if (this.isStreaming) {
                            this.createRecognizeStream();
                        }
                    }, 1000);
                }
            })
            .on('end', () => {
                console.log('[StreamingSpeech] Stream ended');
            });

        // ストリーム制限時間前に再接続をスケジュール
        if (this.restartTimeout) {
            clearTimeout(this.restartTimeout);
        }
        this.restartTimeout = setTimeout(() => {
            if (this.isStreaming) {
                console.log('[StreamingSpeech] Reconnecting due to stream time limit...');
                this.recognizeStream?.end();
                this.createRecognizeStream();
            }
        }, this.STREAM_LIMIT_MS);
    }

    /**
     * 音声データを送信
     */
    sendAudio(audioData: Buffer): void {
        if (!this.recognizeStream || !this.isStreaming) {
            return;
        }

        try {
            this.recognizeStream.write({ audioContent: audioData });
        } catch (error) {
            console.error('[StreamingSpeech] Failed to write audio:', error);
        }
    }

    /**
     * ストリーミングを停止
     */
    stopStreaming(): void {
        if (this.restartTimeout) {
            clearTimeout(this.restartTimeout);
            this.restartTimeout = null;
        }

        if (this.recognizeStream) {
            this.recognizeStream.end();
            this.recognizeStream = null;
        }

        this.isStreaming = false;
        console.log('[StreamingSpeech] Streaming stopped');
    }

    /**
     * ストリーミング中かどうか
     */
    getIsStreaming(): boolean {
        return this.isStreaming;
    }
}

export const streamingSpeechToTextService = new StreamingSpeechToTextService();
