import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { LogEntry } from '../types';

interface LogViewProps {
    logs: LogEntry[];
    onTextSelect: (text: string) => void;
    onPlaybackStatusChange?: (isPlaying: boolean) => void;
    onEditLog?: (id: string, newText: string) => void;
}

// 話者タグに基づく色を取得
const SPEAKER_COLORS = [
    '#4A90D9', // 青
    '#D94A6E', // ピンク
    '#4AD99B', // 緑
    '#D9A64A', // オレンジ
    '#9B4AD9', // 紫
    '#4AD9D9', // シアン
];

const getSpeakerColor = (speakerTag: number): string => {
    if (speakerTag <= 0) return 'inherit';
    return SPEAKER_COLORS[(speakerTag - 1) % SPEAKER_COLORS.length];
};

const getSpeakerLabel = (speakerTag: number): string => {
    if (speakerTag <= 0) return '';
    return `話者${speakerTag}`;
};

// PCM データを再生する関数（停止関数を返す）
// audioBuffer: Int16 サンプル値の配列 (各要素は -32768〜32767)
const playAudio = (
    audioBuffer: number[],
    sampleRate: number = 44100,
    channels: number = 2,
    onEnded?: () => void
): (() => void) | null => {
    try {
        const audioContext = new AudioContext({ sampleRate });

        // audioBuffer は Int16 サンプル値の配列なので、直接 Float32 に変換
        const numSamples = audioBuffer.length;
        const floatData = new Float32Array(numSamples);

        for (let i = 0; i < numSamples; i++) {
            // Int16 サンプル値を -1.0 〜 1.0 の Float に変換
            floatData[i] = audioBuffer[i] / 32768;
        }

        // AudioBuffer を作成
        const samplesPerChannel = Math.floor(floatData.length / channels);
        const buffer = audioContext.createBuffer(channels, samplesPerChannel, sampleRate);

        // チャンネルごとにデータをコピー（インターリーブ形式）
        for (let ch = 0; ch < channels; ch++) {
            const channelData = buffer.getChannelData(ch);
            for (let i = 0; i < samplesPerChannel; i++) {
                channelData[i] = floatData[i * channels + ch];
            }
        }

        // 再生
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.start();

        // 再生終了後にコンテキストを閉じる
        source.onended = () => {
            audioContext.close();
            if (onEnded) onEnded();
        };

        // 停止関数を返す
        return () => {
            source.stop();
            audioContext.close();
        };
    } catch (error) {
        console.error('Audio playback error:', error);
        return null;
    }
};

// ログエントリ単体のコンポーネント（メモ化）
const LogEntryItem = React.memo(({
    entry,
    isPlaying,
    isEditing,
    editText,
    initialCursorPos,
    onTogglePlay,
    onStartEdit,
    onEditChange,
    onEditSubmit,
    onEditCancel
}: {
    entry: LogEntry;
    isPlaying: boolean;
    isEditing: boolean;
    editText: string;
    initialCursorPos?: number;
    onTogglePlay: (entry: LogEntry) => void;
    onStartEdit: (entry: LogEntry, cursorPos?: number) => void;
    onEditChange: (text: string) => void;
    onEditSubmit: (id: string, text: string) => void;
    onEditCancel: () => void;
}) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // 編集開始時にカーソル位置を設定
    useEffect(() => {
        if (isEditing && textareaRef.current && initialCursorPos !== undefined) {
            textareaRef.current.setSelectionRange(initialCursorPos, initialCursorPos);
        }
    }, [isEditing, initialCursorPos]);

    const handleDoubleClick = useCallback((e: React.MouseEvent) => {
        const selection = window.getSelection();
        if (selection && selection.anchorNode && selection.anchorNode.parentElement === e.currentTarget) {
            const offset = selection.anchorOffset;
            onStartEdit(entry, offset);
        } else {
            onStartEdit(entry);
        }
    }, [entry, onStartEdit]);

    return (
        <div className="log-entry" style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
            {/* 再生/停止ボタン（音声データがある場合のみ） */}
            {((entry.audioBuffer && entry.audioBuffer.length > 0) || entry.audioFile) && (
                <button
                    onClick={() => onTogglePlay(entry)}
                    style={{
                        padding: '2px 6px',
                        borderRadius: '4px',
                        border: 'none',
                        cursor: 'pointer',
                        background: isPlaying ? 'var(--color-error, #ef4444)' : 'var(--color-surface)',
                        color: isPlaying ? 'white' : 'var(--color-text-secondary)',
                        fontSize: '0.75rem',
                        flexShrink: 0,
                    }}
                    title={isPlaying ? 'この行の音声を停止' : 'この行の音声を再生'}
                >
                    {isPlaying ? '⏹️' : '▶️'}
                </button>
            )}
            <div style={{ flex: 1 }}>
                <span className="log-timestamp">[{new Date(entry.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}]</span>
                {entry.customLabel ? (
                    <span
                        className="log-speaker-tag"
                        style={{
                            backgroundColor: '#10b981', // Emerald 500
                            color: 'white',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            marginRight: '6px',
                        }}
                    >
                        {entry.customLabel}
                    </span>
                ) : (
                    entry.speakerTag && entry.speakerTag > 0 && (
                        <span
                            className="log-speaker-tag"
                            style={{
                                backgroundColor: getSpeakerColor(entry.speakerTag),
                                color: 'white',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                fontSize: '0.75rem',
                                marginRight: '6px',
                            }}
                        >
                            {getSpeakerLabel(entry.speakerTag)}
                        </span>
                    )
                )}
                {/* テキスト部分（編集モードとの切り替え） */}
                {isEditing ? (
                    <textarea
                        ref={textareaRef}
                        value={editText}
                        onChange={(e) => onEditChange(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                onEditSubmit(entry.id, editText);
                            } else if (e.key === 'Escape') {
                                onEditCancel();
                            }
                        }}
                        autoFocus
                        rows={Math.max(3, Math.min(10, editText.split('\n').length + 1))}
                        style={{
                            width: '100%',
                            padding: '8px 12px',
                            border: '2px solid var(--color-primary)',
                            borderRadius: '8px',
                            background: 'var(--color-bg-tertiary)',
                            color: 'var(--color-text)',
                            fontSize: '0.9rem',
                            lineHeight: '1.5',
                            resize: 'vertical',
                            minHeight: `${Math.max(80, Math.min(200, editText.length / 2))}px`,
                            fontFamily: 'inherit',
                        }}
                    />
                ) : (
                    <>
                        <span
                            className="log-text"
                            style={{ cursor: 'text' }}
                            onDoubleClick={handleDoubleClick}
                        >
                            {entry.text}
                        </span>
                        {onStartEdit && (
                            <button
                                onClick={() => onStartEdit(entry)}
                                style={{
                                    marginLeft: '8px',
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    border: 'none',
                                    cursor: 'pointer',
                                    background: 'transparent',
                                    color: 'var(--color-text-secondary)',
                                    fontSize: '0.7rem',
                                    opacity: 0.6,
                                }}
                                title="編集 (Enter で保存, Shift+Enter で改行)"
                            >
                                ✏️
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}, (prevProps, nextProps) => {
    return (
        prevProps.entry === nextProps.entry &&
        prevProps.isPlaying === nextProps.isPlaying &&
        prevProps.isEditing === nextProps.isEditing &&
        (prevProps.isEditing ? prevProps.editText === nextProps.editText : true) &&
        prevProps.initialCursorPos === nextProps.initialCursorPos
    );
});

export const LogView: React.FC<LogViewProps> = React.memo(({ logs, onTextSelect, onPlaybackStatusChange, onEditLog }) => {
    const contentRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true); // 自動スクロールトグル
    const [playingId, setPlayingId] = useState<string | null>(null);
    const stopFunctionRef = useRef<(() => void) | null>(null);

    // 編集状態
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState<string>('');
    const [initialCursorPos, setInitialCursorPos] = useState<number | undefined>(undefined);

    // 自動スクロール
    useEffect(() => {
        if (contentRef.current && autoScroll) {
            contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
    }, [logs, autoScroll]);

    // スクロールイベントハンドラ（手動スクロールで自動スクロールをOFF）
    const handleScroll = useCallback(() => {
        if (!contentRef.current) return;

        const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
        const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
        // 一番下にいない場合は自動スクロールをOFF
        if (!isAtBottom && autoScroll) {
            setAutoScroll(false);
        }
    }, [autoScroll]);

    // テキスト選択ハンドラ
    const handleMouseUp = useCallback(() => {
        const selection = window.getSelection();
        const selectedText = selection?.toString().trim() || '';
        onTextSelect(selectedText);
    }, [onTextSelect]);

    // 音声再生ハンドラ
    const handlePlayAudio = useCallback(async (entry: LogEntry) => {
        // ... (existing implementation)
        // 既存の実装を再利用するが、コンポーネント外に出したほうがいいかもしれない
        // ここでは一旦そのままにするため、LogView内に残すが、LogEntryItemに渡す必要がある
        // 上記playAudio関数を使用
        let bufferToPlay = entry.audioBuffer;

        // 音声バッファがなく（ロード済みログなど）、ファイルパスがある場合は読み込む
        let fileSampleRate: number | undefined;
        let fileChannels: number | undefined;

        if ((!bufferToPlay || bufferToPlay.length === 0) && entry.audioFile) {
            try {
                console.log('Reading audio file for playback:', entry.audioFile);
                const result = await window.electronAPI.readAudioFile(entry.audioFile);
                if (result.success && result.buffer) {
                    bufferToPlay = result.buffer;
                    fileSampleRate = result.sampleRate;
                    fileChannels = result.channels;
                } else {
                    console.error('Failed to read audio file:', result.error);
                    alert('音声ファイルの読み込みに失敗しました。');
                    return;
                }
            } catch (err) {
                console.error('Error reading audio file:', err);
                return;
            }
        }

        if (!bufferToPlay || bufferToPlay.length === 0) return;

        // 既に再生中なら停止
        if (stopFunctionRef.current) {
            stopFunctionRef.current();
            stopFunctionRef.current = null;
            if (onPlaybackStatusChange) onPlaybackStatusChange(false);
        }

        // 同じIDをクリックした場合は停止のみ
        if (playingId === entry.id) {
            setPlayingId(null);
            return;
        }

        // 再生パラメータ決定
        const sampleRate = fileSampleRate || entry.sampleRate || 16000;
        const channels = fileChannels || entry.channels || 1;

        setPlayingId(entry.id);
        if (onPlaybackStatusChange) onPlaybackStatusChange(true);
        const stopFn = playAudio(
            bufferToPlay,
            sampleRate,
            channels,
            () => {
                setPlayingId(null);
                stopFunctionRef.current = null;
                if (onPlaybackStatusChange) onPlaybackStatusChange(false);
            }
        );
        stopFunctionRef.current = stopFn;
    }, [playingId, onPlaybackStatusChange]);

    // 音声停止ハンドラ
    const handleStopAudio = useCallback(() => {
        if (stopFunctionRef.current) {
            stopFunctionRef.current();
            stopFunctionRef.current = null;
            setPlayingId(null);
        }
    }, []);

    // 編集ハンドラ
    const handleStartEdit = useCallback((entry: LogEntry, cursorPos?: number) => {
        if (onEditLog) {
            setEditingId(entry.id);
            setEditText(entry.text);
            setInitialCursorPos(cursorPos);
        }
    }, [onEditLog]);

    const handleEditChange = useCallback((text: string) => {
        setEditText(text);
    }, []);

    const handleEditSubmit = useCallback((id: string, text: string) => {
        if (onEditLog && text.trim()) {
            onEditLog(id, text.trim());
        }
        setEditingId(null);
    }, [onEditLog]);

    const handleEditCancel = useCallback(() => {
        setEditingId(null);
    }, []);


    return (
        <div className="log-view">
            <div className="log-view-header">
                <div className="log-view-title">
                    📝 テキストログ ({logs.length}件)
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                    <input
                        type="checkbox"
                        checked={autoScroll}
                        onChange={(e) => setAutoScroll(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                    />
                    自動スクロール
                </label>
            </div>
            <div
                ref={contentRef}
                className="log-view-content"
                onScroll={handleScroll}
                onMouseUp={handleMouseUp}
            >
                {logs.length === 0 ? (
                    <div className="log-empty">
                        <span className="log-empty-icon">🎙️</span>
                        <div>
                            <p>テキストログがありません</p>
                            <p style={{ fontSize: '0.8rem', marginTop: '8px' }}>
                                画面を選択してキャプチャを開始してください
                            </p>
                        </div>
                    </div>
                ) : (
                    logs.map((entry) => (
                        <LogEntryItem
                            key={entry.id}
                            entry={entry}
                            isPlaying={playingId === entry.id}
                            isEditing={editingId === entry.id}
                            editText={editText}
                            initialCursorPos={editingId === entry.id ? initialCursorPos : undefined}
                            onTogglePlay={() => playingId === entry.id ? handleStopAudio() : handlePlayAudio(entry)}
                            onStartEdit={handleStartEdit}
                            onEditChange={handleEditChange}
                            onEditSubmit={handleEditSubmit}
                            onEditCancel={handleEditCancel}
                        />
                    ))
                )}
            </div>
        </div>
    );
});
