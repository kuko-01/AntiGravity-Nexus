/**
 * Web Speech-to-Text サービス
 * ブラウザ内蔵のWeb Speech APIを使用してマイク音声をテキストに変換する
 */

// Web Speech API の型定義
interface SpeechRecognitionEvent extends Event {
    results: SpeechRecognitionResultList;
    resultIndex: number;
}

interface SpeechRecognitionResultList {
    length: number;
    item(index: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
    isFinal: boolean;
    length: number;
    item(index: number): SpeechRecognitionAlternative;
    [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
    transcript: string;
    confidence: number;
}

interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: Event) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}

declare global {
    interface Window {
        SpeechRecognition: new () => SpeechRecognition;
        webkitSpeechRecognition: new () => SpeechRecognition;
    }
}

export interface WebSpeechCallbacks {
    onResult: (text: string, isFinal: boolean) => void;
    onError: (error: Error) => void;
}

class WebSpeechToTextService {
    private recognition: SpeechRecognition | null = null;
    private isListening = false;
    private callbacks: WebSpeechCallbacks | null = null;

    /**
     * Web Speech API が利用可能かチェック
     */
    isSupported(): boolean {
        return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    }

    /**
     * 音声認識を開始
     */
    startListening(callbacks: WebSpeechCallbacks): void {
        if (this.isListening) {
            this.stopListening();
        }

        if (!this.isSupported()) {
            callbacks.onError(new Error('Web Speech API はこのブラウザでサポートされていません'));
            return;
        }

        this.callbacks = callbacks;

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();

        // 設定
        this.recognition.continuous = true;  // 連続認識
        this.recognition.interimResults = true;  // 中間結果も取得
        this.recognition.lang = 'ja-JP';  // 日本語

        // 認識結果
        this.recognition.onresult = (event: SpeechRecognitionEvent) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) {
                    finalTranscript += result[0].transcript;
                } else {
                    interimTranscript += result[0].transcript;
                }
            }

            if (finalTranscript) {
                console.log('[WebSpeech] Final result:', finalTranscript);
                this.callbacks?.onResult(finalTranscript, true);
            } else if (interimTranscript) {
                console.log('[WebSpeech] Interim result:', interimTranscript);
                this.callbacks?.onResult(interimTranscript, false);
            }
        };

        // エラー処理
        this.recognition.onerror = (event: Event) => {
            console.error('[WebSpeech] Error:', event);
            const errorEvent = event as { error?: string };
            const errorMessage = errorEvent.error || '音声認識でエラーが発生しました';
            this.callbacks?.onError(new Error(errorMessage));
        };

        // 終了時に自動再開
        this.recognition.onend = () => {
            console.log('[WebSpeech] Recognition ended');
            if (this.isListening) {
                console.log('[WebSpeech] Restarting...');
                setTimeout(() => {
                    if (this.isListening && this.recognition) {
                        this.recognition.start();
                    }
                }, 100);
            }
        };

        try {
            this.recognition.start();
            this.isListening = true;
            console.log('[WebSpeech] Started listening');
        } catch (error) {
            console.error('[WebSpeech] Failed to start:', error);
            this.callbacks?.onError(error instanceof Error ? error : new Error('音声認識の開始に失敗しました'));
        }
    }

    /**
     * 音声認識を停止
     */
    stopListening(): void {
        this.isListening = false;
        if (this.recognition) {
            this.recognition.stop();
            this.recognition = null;
        }
        this.callbacks = null;
        console.log('[WebSpeech] Stopped listening');
    }

    /**
     * 認識中かどうか
     */
    getIsListening(): boolean {
        return this.isListening;
    }
}

export const webSpeechToTextService = new WebSpeechToTextService();
