/**
 * Google Cloud Speech-to-Text サービス
 * メインプロセスで実行される音声認識サービス
 */

import { SpeechClient } from '@google-cloud/speech';
import * as path from 'path';

class GoogleSpeechToTextService {
    private client: SpeechClient | null = null;
    private isInitialized = false;

    /**
     * 初期化
     */
    initialize(credentialsPath: string): void {
        try {
            const absolutePath = path.resolve(credentialsPath);
            console.log('[GoogleSpeech] Initializing with credentials:', absolutePath);

            this.client = new SpeechClient({
                keyFilename: absolutePath,
            });

            this.isInitialized = true;
            console.log('[GoogleSpeech] Initialized successfully');
        } catch (error) {
            console.error('[GoogleSpeech] Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * 音声データをテキストに変換
     */
    async transcribe(audioBuffer: Buffer): Promise<string> {
        if (!this.client || !this.isInitialized) {
            throw new Error('GoogleSpeechToTextService が初期化されていません');
        }

        try {
            console.log('[GoogleSpeech] Transcribing audio:', audioBuffer.length, 'bytes');

            const request = {
                audio: {
                    content: audioBuffer.toString('base64'),
                },
                config: {
                    encoding: 'WEBM_OPUS' as const,
                    sampleRateHertz: 48000,
                    audioChannelCount: 2, // ステレオ入力に対応
                    languageCode: 'ja-JP',
                    enableAutomaticPunctuation: true,
                    model: 'default',
                },
            };

            const [response] = await this.client.recognize(request);

            const transcription = response.results
                ?.map((result) => result.alternatives?.[0]?.transcript)
                .filter(Boolean)
                .join('\n') || '';

            console.log('[GoogleSpeech] Transcription result:', transcription ? transcription.substring(0, 50) + '...' : '(empty)');

            return transcription;
        } catch (error) {
            console.error('[GoogleSpeech] Transcription error:', error);
            throw error;
        }
    }

    /**
     * LINEAR16 PCM音声をテキストに変換（Per-App Captureからの音声用）
     * Speaker Diarization 有効
     */
    async transcribeLinear16(audioBuffer: Buffer, sampleRate: number = 44100, channels: number = 2): Promise<{ text: string; words?: Array<{ word: string; speakerTag: number }> }> {
        if (!this.client) {
            throw new Error('Google Speech-to-Text is not initialized');
        }

        try {
            console.log('[GoogleSpeech] Transcribing LINEAR16 audio:', audioBuffer.length, 'bytes, sampleRate:', sampleRate, 'channels:', channels);

            const request = {
                audio: {
                    content: audioBuffer.toString('base64'),
                },
                config: {
                    encoding: 'LINEAR16' as const,
                    sampleRateHertz: sampleRate,
                    audioChannelCount: channels,
                    languageCode: 'ja-JP',
                    enableAutomaticPunctuation: true,
                    model: 'latest_long', // Diarization に推奨
                    enableWordTimeOffsets: true,
                    diarizationConfig: {
                        enableSpeakerDiarization: true,
                        minSpeakerCount: 2,
                        maxSpeakerCount: 6,
                    },
                },
            };

            const [response] = await this.client.recognize(request);

            // 全体のテキスト
            const transcription = response.results
                ?.map((result) => result.alternatives?.[0]?.transcript)
                .filter(Boolean)
                .join('\n') || '';

            // 話者情報付きの単語リスト（最後の result に含まれる）
            const lastResult = response.results?.[response.results.length - 1];
            const wordsWithSpeaker = lastResult?.alternatives?.[0]?.words?.map((wordInfo) => ({
                word: wordInfo.word || '',
                speakerTag: wordInfo.speakerTag || 0,
            }));

            console.log('[GoogleSpeech] LINEAR16 Transcription result:', transcription ? transcription.substring(0, 50) + '...' : '(empty)');
            if (wordsWithSpeaker?.length) {
                const speakers = new Set(wordsWithSpeaker.map(w => w.speakerTag));
                console.log('[GoogleSpeech] Speakers detected:', speakers.size);
            }

            return { text: transcription, words: wordsWithSpeaker };
        } catch (error) {
            console.error('[GoogleSpeech] LINEAR16 Transcription error:', error);
            throw error;
        }
    }


    /**
     * 初期化済みかどうか
     */
    getIsInitialized(): boolean {
        return this.isInitialized;
    }
}

export const googleSpeechToTextService = new GoogleSpeechToTextService();
