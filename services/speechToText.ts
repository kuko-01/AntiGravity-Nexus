/**
 * Speech-to-Text サービス
 * Gemini API を使用して音声をテキストに変換する
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

class SpeechToTextService {
    private genAI: GoogleGenerativeAI | null = null;
    private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;
    private retryCount = 0;
    private maxRetries = 2;
    private isProcessing = false;  // 処理中フラグ

    /**
     * API キーで初期化
     */
    initialize(apiKey: string): void {
        if (!apiKey) {
            throw new Error('API キーが設定されていません');
        }
        this.genAI = new GoogleGenerativeAI(apiKey);
        // gemini-2.0-flash-exp は音声対応のマルチモーダルモデル（expの方が安定）
        this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    }

    /**
     * 音声 Blob をテキストに変換
     */
    async transcribe(audioBlob: Blob): Promise<string> {
        if (!this.model) {
            throw new Error('SpeechToTextService が初期化されていません');
        }

        // 既に処理中の場合はスキップ
        if (this.isProcessing) {
            console.log('[SpeechToText] Already processing, skipping this chunk...');
            return '';
        }

        this.isProcessing = true;

        try {
            // Blob を Base64 に変換
            console.log('[SpeechToText] Received audio blob:', audioBlob.size, 'bytes, type:', audioBlob.type);

            if (audioBlob.size < 1000) {
                console.log('[SpeechToText] Audio blob too small, skipping...');
                return '';
            }

            const arrayBuffer = await audioBlob.arrayBuffer();
            const base64Audio = this.arrayBufferToBase64(arrayBuffer);

            // 毎回新しいモデルインスタンスを作成（セッション状態問題を回避）
            const freshModel = this.genAI!.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

            // Gemini API に送信
            const result = await freshModel.generateContent([
                {
                    inlineData: {
                        mimeType: 'audio/webm',  // 常に audio/webm を使用
                        data: base64Audio,
                    },
                },
                {
                    text: `あなたは高精度な音声文字起こしシステムです。
以下のルールに従って音声を文字起こししてください：

1. 音声の内容を正確にテキスト化してください
2. 日本語の音声は日本語で、英語の音声は英語でそのまま出力してください
3. 句読点（、。）を適切に入れてください
4. 「えー」「あのー」などのフィラーは省略してください
5. 聞き取れない部分は [不明瞭] と記載してください
6. 音声がない場合や無音の場合は空文字を返してください
7. 説明や注釈は一切不要です。テキストのみを出力してください`,
                },
            ]);

            const response = await result.response;
            const text = response.text().trim();

            console.log('[SpeechToText] Transcription result:', text ? text.substring(0, 50) + '...' : '(empty)');

            return text;

        } catch (error) {
            console.error('Transcription error:', error);
            // 400エラーの場合はリトライしない
            throw new Error('音声のテキスト化に失敗しました');
        } finally {
            this.retryCount = 0;
            this.isProcessing = false;
            console.log('[SpeechToText] Ready for next request');
        }
    }

    /**
     * ArrayBuffer を Base64 に変換
     */
    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * 遅延処理
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * 初期化済みかどうか
     */
    isInitialized(): boolean {
        return this.model !== null;
    }
}

export const speechToTextService = new SpeechToTextService();
