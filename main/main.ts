import { app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, shell } from 'electron';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { googleSpeechToTextService } from './googleSpeechToText';
import { streamingSpeechToTextService } from './streamingSpeechToText';
import { whisperService } from './whisperService';

// .env ファイルを読み込み
// .env ファイルを読み込み
const isDevelopment = process.env.NODE_ENV === 'development' || !app.isPackaged;
const resourcesPath = isDevelopment ? path.join(__dirname, '../../') : process.resourcesPath;

dotenv.config({ path: path.join(resourcesPath, '.env') });

// Google Cloud Speech-to-Text を初期化
const gcpCredentialsPath = path.join(resourcesPath, 'gcp-credentials.json');
try {
    if (fs.existsSync(gcpCredentialsPath)) {
        googleSpeechToTextService.initialize(gcpCredentialsPath);
        streamingSpeechToTextService.initialize(gcpCredentialsPath);
    } else {
        console.warn('GCP credentials file not found at:', gcpCredentialsPath);
    }
} catch (error) {
    console.error('Failed to initialize Google Speech-to-Text:', error);
}

// Whisper オフライン認識を初期化
whisperService.initialize().catch((error) => {
    console.error('Failed to initialize Whisper:', error);
});

// [Troubleshooting] UIがぼやける問題を回避するためにハードウェアアクセラレーションを無効化
// 多くのWindows環境でElectronアプリの文字が滲む現象を解決します
app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;



function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        backgroundColor: '#1a1a2e',
        show: false,
    });

    // 権限リクエストを自動的に許可
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        const allowedPermissions = ['media', 'display-capture', 'mediaKeySystem', 'audioCapture', 'videoCapture'];
        if (allowedPermissions.includes(permission)) {
            callback(true);
        } else {
            callback(false);
        }
    });

    // displayMediaRequestHandlerを設定
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
            if (sources.length > 0) {
                callback({ video: sources[0], audio: 'loopback' });
            } else {
                callback({});
            }
        });
    });

    // 開発時は Vite dev server、本番時はビルド済みファイル
    if (isDevelopment) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        const indexPath = path.join(__dirname, '../renderer/index.html');
        mainWindow.loadFile(indexPath).catch(e => {
            console.error('Failed to load index.html:', e);
        });
    }
    // Debug: プロダクションでもDevToolsを開く
    mainWindow.webContents.openDevTools();

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 画面ソース一覧を取得
ipcMain.handle('get-sources', async () => {
    try {
        console.log('Getting desktop sources...');
        const sources = await desktopCapturer.getSources({
            types: ['window', 'screen'],
            thumbnailSize: { width: 150, height: 100 },
            fetchWindowIcons: false,
        });

        console.log(`Found ${sources.length} sources`);

        if (sources.length === 0) {
            console.log('No sources found. This might be a Windows permission issue.');
            console.log('Try running the app with --disable-gpu-sandbox flag or check Windows Graphics Settings.');
        }

        const result = sources.map((source) => ({
            id: source.id,
            name: source.name,
            thumbnailDataUrl: source.thumbnail.toDataURL(),
        }));

        return result;
    } catch (error) {
        console.error('Failed to get sources:', error);
        // エラー情報をレンダラーに伝える
        throw error;
    }
});

// API キーを取得
ipcMain.handle('get-api-key', () => {
    return process.env.GEMINI_API_KEY || '';
});

// Google Cloud Speech-to-Text で音声をテキスト化
ipcMain.handle('transcribe-audio', async (_event, audioData: number[]) => {
    try {
        const buffer = Buffer.from(audioData);
        const text = await googleSpeechToTextService.transcribe(buffer);
        return { success: true, text };
    } catch (error) {
        console.error('Transcribe audio error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// LINEAR16 PCM音声をテキスト化（Per-App Capture用）- Speaker Diarization 有効
ipcMain.handle('transcribe-linear16', async (_event, audioData: number[], sampleRate: number, channels: number) => {
    try {
        // audioData は Int16 サンプル値の配列
        // GCP は LINEAR16 (Little-Endian) を期待するので、Int16Array を使ってバイト配列に変換
        const int16Array = new Int16Array(audioData);
        const buffer = Buffer.from(int16Array.buffer);

        console.log(`[Main] transcribe-linear16: samples=${audioData.length}, bytes=${buffer.length}, rate=${sampleRate}, ch=${channels}`);

        const result = await googleSpeechToTextService.transcribeLinear16(buffer, sampleRate, channels);
        return { success: true, text: result.text, words: result.words };
    } catch (error) {
        console.error('Transcribe LINEAR16 audio error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// WAVバッファを作成するヘルパー関数
function createWavBuffer(samples: number[], sampleRate: number, channels: number): Buffer {
    const dataLength = samples.length * 2; // 16-bit = 2 bytes
    const header = Buffer.alloc(44);

    // RIFF chunk
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
    header.writeUInt16LE(channels, 22); // NumChannels
    header.writeUInt32LE(sampleRate, 24); // SampleRate
    header.writeUInt32LE(sampleRate * channels * 2, 28); // ByteRate
    header.writeUInt16LE(channels * 2, 32); // BlockAlign
    header.writeUInt16LE(16, 34); // BitsPerSample

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);

    // PCMデータをバッファに変換
    const pcmData = new Int16Array(samples);
    const dataBuffer = Buffer.from(pcmData.buffer);

    return Buffer.concat([header, dataBuffer]);
}

// ログをファイルに保存
ipcMain.handle('save-logs', async (_event, logs: any[]) => {
    try {
        const hasAudio = logs.some(log => log.audioBuffer && log.audioBuffer.length > 0);

        const result = await dialog.showSaveDialog(mainWindow!, {
            title: 'ログを保存',
            defaultPath: `transcript-${new Date().toISOString().split('T')[0]}`,
            filters: hasAudio
                ? [{ name: 'ZIP Archive (with Audio)', extensions: ['zip'] }, { name: 'JSON File (Text Only)', extensions: ['json'] }]
                : [{ name: 'JSON Files', extensions: ['json'] }],
        });

        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }

        if (result.filePath.endsWith('.zip')) {
            const zip = new AdmZip();
            const logsForJson = logs.map(log => {
                const logCopy = { ...log };

                // 音声データがあればWAVファイルとして追加
                if (log.audioBuffer && log.audioBuffer.length > 0) {
                    const wavBuffer = createWavBuffer(log.audioBuffer, log.sampleRate || 16000, log.channels || 1);
                    const fileName = `audio/${log.id}.wav`;
                    zip.addFile(fileName, wavBuffer);

                    // JSONからは削除・参照を追加
                    delete logCopy.audioBuffer;
                    logCopy.audioFile = fileName;
                }
                return logCopy;
            });

            // JSONを追加
            zip.addFile('logs.json', Buffer.from(JSON.stringify(logsForJson, null, 2), 'utf-8'));

            // ZIPを書き込み
            zip.writeZip(result.filePath);
        } else {
            // JSONのみ保存（音声データは削除）
            const logsNoAudio = logs.map(log => {
                const { audioBuffer, ...rest } = log;
                return rest;
            });
            fs.writeFileSync(result.filePath, JSON.stringify(logsNoAudio, null, 2), 'utf-8');
        }

        return { success: true, filePath: result.filePath };
    } catch (error) {
        console.error('Save logs error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// ファイルからログを読み込み
ipcMain.handle('load-logs', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: 'ログを開く',
            filters: [{ name: 'Transcript Files', extensions: ['json', 'zip'] }],
            properties: ['openFile'],
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }

        const filePath = result.filePaths[0];

        if (filePath.endsWith('.zip')) {
            const zip = new AdmZip(filePath);
            const logsJsonEntry = zip.getEntry('logs.json');

            if (!logsJsonEntry) {
                throw new Error('Invalid ZIP format: logs.json not found');
            }

            const content = zip.readAsText(logsJsonEntry);
            const logs = JSON.parse(content);

            // 音声データを復元
            for (const log of logs) {
                if (log.audioFile) {
                    const audioEntry = zip.getEntry(log.audioFile);
                    if (audioEntry) {
                        const wavBuffer = zip.readFile(audioEntry);
                        if (wavBuffer) {
                            // WAVヘッダー(44バイト)をスキップしてPCMデータを取得
                            const pcmBuffer = wavBuffer.subarray(44);
                            // Int16Arrayに変換してからnumber[]に戻す
                            const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
                            log.audioBuffer = Array.from(samples);
                        }
                    }
                }
            }

            return { success: true, logs, filePath };
        } else {
            const content = fs.readFileSync(filePath, 'utf-8');
            const logs = JSON.parse(content);
            return { success: true, logs, filePath };
        }
    } catch (error) {
        console.error('Load logs error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});


// ============================================
// Per-App Audio Capture (Native Module)
// ============================================

// Native moduleを動的にロード
let appAudioCapture: {
    getAudioProcesses: () => Array<{ pid: number; name: string; title: string }>;
    startCapture: (pid: number, callback: (data: { buffer: Buffer; channels: number; sampleRate: number; bytesPerSample: number }) => void) => { success: boolean; error?: string };
    stopCapture: () => void;
    isCapturing: () => boolean;
} | null = null;

try {
    let nativeModulePath: string;
    if (isDevelopment) {
        nativeModulePath = path.join(__dirname, '../../native/app-audio-capture/build/Release/app_audio_capture.node');
    } else {
        // パッケージ版: resourcesフォルダ直下に native フォルダをコピーする想定
        nativeModulePath = path.join(process.resourcesPath, 'native/app-audio-capture/build/Release/app_audio_capture.node');
    }

    if (fs.existsSync(nativeModulePath)) {
        appAudioCapture = require(nativeModulePath);
        console.log('[Main] Loaded native app-audio-capture module from:', nativeModulePath);
    } else {
        console.warn('[Main] Native app-audio-capture module not found at:', nativeModulePath);
    }
} catch (error) {
    console.error('[Main] Failed to load native app-audio-capture module:', error);
}

// 音声を出力しているプロセス一覧を取得
ipcMain.handle('get-audio-processes', async () => {
    // Debug: プロセス一覧取得時の状況を表示
    if (!isDevelopment) {
        try {
            const loaded = !!appAudioCapture;
            const count = appAudioCapture ? appAudioCapture.getAudioProcesses().length : 0;
            const nativePath = path.join(process.resourcesPath, 'native/app-audio-capture/build/Release/app_audio_capture.node');

            dialog.showMessageBoxSync({
                title: 'Debug Processes',
                message: `Loaded: ${loaded}\nCount: ${count}\nExists: ${fs.existsSync(nativePath)}\nPath: ${nativePath}`
            });
        } catch (e) {
            dialog.showErrorBox('Debug Error', `Error in debug: ${e}`);
        }
    }

    try {
        if (!appAudioCapture) {
            return { success: false, error: 'Native module not loaded' };
        }
        const processes = appAudioCapture.getAudioProcesses();
        return { success: true, processes };
    } catch (error) {
        console.error('Get audio processes error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// プロセスの音声キャプチャを開始（連続録音ファイル方式）
let continuousRecordingPath: string | null = null;
let continuousRecordingStream: fs.WriteStream | null = null;
let continuousRecordingSampleRate = 44100;
let continuousRecordingChannels = 2;
let continuousRecordingTotalSamples = 0;
let lastTranscribedSamples = 0;
let lastMetadataSendTime = 0; // IPC送信頻度制限用

ipcMain.handle('start-process-capture', async (_event, pid: number) => {
    try {
        if (!appAudioCapture) {
            return { success: false, error: 'Native module not loaded' };
        }

        // 連続録音ファイルを準備
        if (currentSessionPath) {
            const timestamp = Date.now();
            continuousRecordingPath = path.join(currentSessionPath, `continuous_${timestamp}.raw`);
            continuousRecordingStream = fs.createWriteStream(continuousRecordingPath);
            continuousRecordingTotalSamples = 0;
            lastTranscribedSamples = 0;
            lastMetadataSendTime = 0;
        }

        const result = appAudioCapture.startCapture(pid, (data) => {
            // 音声データをファイルに追記
            if (continuousRecordingStream) {
                continuousRecordingStream.write(data.buffer);
                continuousRecordingSampleRate = data.sampleRate;
                continuousRecordingChannels = data.channels;
                continuousRecordingTotalSamples += data.buffer.length / (data.bytesPerSample * data.channels);
            }

            // レンダラーにはメタデータのみ送信（1秒ごとにスロットリング）
            const now = Date.now();
            if (now - lastMetadataSendTime >= 1000) {
                lastMetadataSendTime = now;
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('process-audio-metadata', {
                        totalSamples: continuousRecordingTotalSamples,
                        sampleRate: data.sampleRate,
                        channels: data.channels,
                    });
                }
            }
        });

        return { ...result, recordingPath: continuousRecordingPath };
    } catch (error) {
        console.error('Start process capture error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// 連続録音から指定区間を読み取って文字起こし
ipcMain.handle('transcribe-recording-segment', async (_event, startSample: number, endSample: number) => {
    try {
        if (!continuousRecordingPath || !fs.existsSync(continuousRecordingPath)) {
            return { success: false, error: 'No active recording' };
        }

        const bytesPerSample = 2; // 16-bit
        const startByte = startSample * bytesPerSample * continuousRecordingChannels;
        const length = (endSample - startSample) * bytesPerSample * continuousRecordingChannels;

        // ファイルから指定範囲を読み取り
        const fd = fs.openSync(continuousRecordingPath, 'r');
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, startByte);
        fs.closeSync(fd);

        // GCPで文字起こし
        const result = await googleSpeechToTextService.transcribeLinear16(
            buffer,
            continuousRecordingSampleRate,
            continuousRecordingChannels
        );

        return {
            success: true,
            text: result.text,
            words: result.words,
            startSample,
            endSample,
            audioBuffer: Array.from(new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2))
        };
    } catch (error) {
        console.error('Transcribe segment error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// 連続録音の現在の状態を取得
ipcMain.handle('get-recording-status', async () => {
    return {
        isRecording: !!continuousRecordingStream,
        totalSamples: continuousRecordingTotalSamples,
        lastTranscribedSamples,
        sampleRate: continuousRecordingSampleRate,
        channels: continuousRecordingChannels,
        recordingPath: continuousRecordingPath
    };
});

// プロセスの音声キャプチャを停止
ipcMain.handle('stop-process-capture', async () => {
    try {
        if (!appAudioCapture) {
            return { success: false, error: 'Native module not loaded' };
        }
        appAudioCapture.stopCapture();

        // 連続録音ストリームを閉じる
        if (continuousRecordingStream) {
            continuousRecordingStream.end();
            continuousRecordingStream = null;
        }

        // RAWファイルをWAVに変換
        let wavPath: string | null = null;
        if (continuousRecordingPath && fs.existsSync(continuousRecordingPath)) {
            wavPath = continuousRecordingPath.replace('.raw', '.wav');
            const rawBuffer = fs.readFileSync(continuousRecordingPath);
            const wavBuffer = createWavBuffer(
                Array.from(new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)),
                continuousRecordingSampleRate,
                continuousRecordingChannels
            );
            fs.writeFileSync(wavPath, wavBuffer);
            // RAWファイルを削除
            fs.unlinkSync(continuousRecordingPath);
        }

        const finalPath = wavPath;
        continuousRecordingPath = null;

        return { success: true, finalRecordingPath: finalPath };
    } catch (error) {
        console.error('Stop process capture error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// ============================================
// Mic Continuous Recording (File-based)
// ============================================
let micContinuousRecordingPath: string | null = null;
let micContinuousRecordingStream: fs.WriteStream | null = null;
let micRecordingSampleRate = 44100;
let micRecordingChannels = 1;
let micRecordingTotalSamples = 0;

// マイク連続録音を開始
ipcMain.handle('start-mic-continuous-recording', async () => {
    try {
        if (!currentSessionPath) {
            return { success: false, error: 'No active session' };
        }

        const timestamp = Date.now();
        micContinuousRecordingPath = path.join(currentSessionPath, `mic_continuous_${timestamp}.raw`);
        micContinuousRecordingStream = fs.createWriteStream(micContinuousRecordingPath);
        micRecordingTotalSamples = 0;

        return { success: true, recordingPath: micContinuousRecordingPath };
    } catch (error) {
        console.error('Start mic continuous recording error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// マイク音声データを連続録音ファイルに追記
ipcMain.handle('append-mic-audio', async (_event, audioData: number[], sampleRate: number, channels: number) => {
    try {
        if (!micContinuousRecordingStream) {
            return { success: false, error: 'No active mic recording' };
        }

        micRecordingSampleRate = sampleRate;
        micRecordingChannels = channels;

        // Int16配列をバッファに変換して書き込み
        const int16Array = new Int16Array(audioData);
        const buffer = Buffer.from(int16Array.buffer);
        micContinuousRecordingStream.write(buffer);
        micRecordingTotalSamples += audioData.length;

        return { success: true, totalSamples: micRecordingTotalSamples };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// マイク連続録音からセグメントを読み取って文字起こし
ipcMain.handle('transcribe-mic-segment', async (_event, startSample: number, endSample: number) => {
    try {
        if (!micContinuousRecordingPath || !fs.existsSync(micContinuousRecordingPath)) {
            return { success: false, error: 'No active mic recording' };
        }

        const bytesPerSample = 2; // 16-bit
        const startByte = startSample * bytesPerSample * micRecordingChannels;
        const length = (endSample - startSample) * bytesPerSample * micRecordingChannels;

        // ファイルから指定範囲を読み取り
        const fd = fs.openSync(micContinuousRecordingPath, 'r');
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, startByte);
        fs.closeSync(fd);

        // GCPで文字起こし
        const result = await googleSpeechToTextService.transcribeLinear16(
            buffer,
            micRecordingSampleRate,
            micRecordingChannels
        );

        return {
            success: true,
            text: result.text,
            words: result.words,
            startSample,
            endSample,
            audioBuffer: Array.from(new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2))
        };
    } catch (error) {
        console.error('Transcribe mic segment error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// マイク連続録音の状態を取得
ipcMain.handle('get-mic-recording-status', async () => {
    return {
        isRecording: !!micContinuousRecordingStream,
        totalSamples: micRecordingTotalSamples,
        sampleRate: micRecordingSampleRate,
        channels: micRecordingChannels,
        recordingPath: micContinuousRecordingPath
    };
});

// マイク連続録音を停止
ipcMain.handle('stop-mic-continuous-recording', async () => {
    try {
        if (micContinuousRecordingStream) {
            micContinuousRecordingStream.end();
            micContinuousRecordingStream = null;
        }

        // RAWファイルをWAVに変換
        let wavPath: string | null = null;
        if (micContinuousRecordingPath && fs.existsSync(micContinuousRecordingPath)) {
            wavPath = micContinuousRecordingPath.replace('.raw', '.wav');
            const rawBuffer = fs.readFileSync(micContinuousRecordingPath);
            if (rawBuffer.length > 0) {
                const wavBuffer = createWavBuffer(
                    Array.from(new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)),
                    micRecordingSampleRate,
                    micRecordingChannels
                );
                fs.writeFileSync(wavPath, wavBuffer);
            }
            // RAWファイルを削除
            fs.unlinkSync(micContinuousRecordingPath);
        }

        const finalPath = wavPath;
        micContinuousRecordingPath = null;
        micRecordingTotalSamples = 0;

        return { success: true, finalRecordingPath: finalPath };
    } catch (error) {
        console.error('Stop mic continuous recording error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// ============================================
// Streaming Speech-to-Text API
// ============================================

// ストリーミング認識を開始
ipcMain.handle('start-streaming-recognition', async (_event, config: {
    sampleRate: number;
    channels: number;
    enableDiarization?: boolean;
}) => {
    try {
        // 既存のリスナーを削除
        streamingSpeechToTextService.removeAllListeners();

        // 結果イベントをレンダラーに転送
        streamingSpeechToTextService.on('result', (result) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('streaming-transcription-result', result);
            }
        });

        streamingSpeechToTextService.on('error', (error) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('streaming-transcription-error', {
                    message: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        });

        streamingSpeechToTextService.startStreaming({
            sampleRateHertz: config.sampleRate,
            audioChannelCount: config.channels,
            languageCode: 'ja-JP',
            enableAutomaticPunctuation: true,
            enableSpeakerDiarization: config.enableDiarization,
            minSpeakerCount: 2,
            maxSpeakerCount: 6,
        });

        return { success: true };
    } catch (error) {
        console.error('Start streaming recognition error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// ストリーミングに音声データを送信
ipcMain.handle('send-streaming-audio', async (_event, audioData: number[]) => {
    try {
        const buffer = Buffer.from(audioData);
        streamingSpeechToTextService.sendAudio(buffer);
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// ストリーミング認識を停止
ipcMain.handle('stop-streaming-recognition', async () => {
    try {
        streamingSpeechToTextService.stopStreaming();
        streamingSpeechToTextService.removeAllListeners();
        return { success: true };
    } catch (error) {
        console.error('Stop streaming recognition error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// ============================================
// Whisper Offline Speech-to-Text API
// ============================================

// Whisper 初期化状態を取得
ipcMain.handle('whisper-get-status', async () => {
    return {
        success: true,
        isInitialized: whisperService.getIsInitialized(),
        currentModel: whisperService.getCurrentModel(),
        downloadedModels: whisperService.getDownloadedModels(),
    };
});

// Whisper モデルをダウンロード
ipcMain.handle('whisper-download-model', async (_event, model: string) => {
    try {
        await whisperService.downloadModel(model as any);
        return { success: true };
    } catch (error) {
        console.error('Whisper download model error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// Whisper で PCM を文字起こし
ipcMain.handle('whisper-transcribe', async (_event, audioData: number[], sampleRate: number, channels: number) => {
    try {
        const buffer = Buffer.from(audioData);
        const text = await whisperService.transcribePCM(buffer, sampleRate, channels);
        return { success: true, text };
    } catch (error) {
        console.error('Whisper transcribe error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// Whisper モデルを設定
ipcMain.handle('whisper-set-model', async (_event, model: string) => {
    try {
        whisperService.setModel(model as any);
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// ============================================
// Auto-Save / Session Management
// ============================================

let currentSessionPath: string | null = null;
let customSaveRoot: string | null = null; // ユーザー選択の保存ルート

// 保存フォルダ選択ダイアログ
ipcMain.handle('select-save-folder', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow!, {
            title: '保存先フォルダを選択',
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: customSaveRoot || app.getPath('documents'),
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }

        customSaveRoot = result.filePaths[0];
        console.log('[Main] Custom save root set:', customSaveRoot);
        return { success: true, path: customSaveRoot };
    } catch (error) {
        console.error('Select folder error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// セッション開始（フォルダ作成）
ipcMain.handle('start-session', async (_event, customRoot?: string) => {
    try {
        // カスタムルートが指定されていればそれを使用
        const rootPath = customRoot || customSaveRoot || path.join(app.getPath('documents'), 'GeminiAudioCapture');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sessionName = `Session_${timestamp}`;
        const sessionPath = path.join(rootPath, sessionName);
        const audioPath = path.join(sessionPath, 'audio');

        // フォルダ作成
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }
        if (!fs.existsSync(audioPath)) {
            fs.mkdirSync(audioPath, { recursive: true });
        }

        currentSessionPath = sessionPath;
        console.log('[Main] Session started:', sessionPath);
        return { success: true, sessionPath };
    } catch (error) {
        console.error('Start session error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// セッションパスを設定（フォルダ作成なし、ロード時に使用）
ipcMain.handle('set-session-path', async (_event, sessionPath: string) => {
    currentSessionPath = sessionPath;
    console.log('[Main] Session path set:', sessionPath);
    return { success: true };
});

// 音声チャンク保存
ipcMain.handle('save-audio-chunk', async (_event, logId: string, buffer: number[], sampleRate: number, channels: number) => {
    try {
        if (!currentSessionPath) {
            return { success: false, error: 'No active session' };
        }

        console.log(`[Main] save-audio-chunk: samples=${buffer.length}, rate=${sampleRate}, ch=${channels}, first5=[${buffer.slice(0, 5).join(',')}]`);

        const wavBuffer = createWavBuffer(buffer, sampleRate, channels);
        const fileName = `audio/${logId}.wav`;
        const filePath = path.join(currentSessionPath, fileName);

        fs.writeFileSync(filePath, wavBuffer);
        return { success: true, filePath: fileName }; // JSONには相対パスを保存
    } catch (error) {
        console.error('Save chunk error:', error);
        return { success: false, error: error };
    }
});

// ログJSON更新
ipcMain.handle('update-logs-json', async (_event, logs: any[]) => {
    try {
        if (!currentSessionPath) {
            return { success: false, error: 'No active session' };
        }

        // 音声バッファを除外して保存
        const logsToSave = logs.map(log => {
            const { audioBuffer, ...rest } = log;
            return rest;
        });

        const jsonPath = path.join(currentSessionPath, 'logs.json');
        fs.writeFileSync(jsonPath, JSON.stringify(logsToSave, null, 2), 'utf-8');

        return { success: true };
    } catch (error) {
        console.error('Update logs error:', error);
        return { success: false, error: error };
    }
});

// フォルダを開く
ipcMain.handle('open-folder', async (_event, fullPath: string) => {
    try {
        await shell.openPath(fullPath);
        return { success: true };
    } catch (error) {
        return { success: false, error: error };
    }
});

// 音声ファイルを読み込む（WAVヘッダーを解析してPCMデータのみ返す）
ipcMain.handle('read-audio-file', async (_event, filePath: string) => {
    try {
        console.log(`[Main] Reading audio file: ${filePath}`);
        console.log(`[Main] Current Session Path: ${currentSessionPath}`);

        let fullPath = filePath;
        // 相対パスなら現在のセッションパスと結合
        if (!path.isAbsolute(filePath) && currentSessionPath) {
            fullPath = path.join(currentSessionPath, filePath);
        }

        console.log('[Main] Resolved full path:', fullPath);

        const fileBuffer = await fs.promises.readFile(fullPath);

        // WAVファイルかどうかチェック
        const riffHeader = fileBuffer.toString('ascii', 0, 4);
        if (riffHeader === 'RIFF') {
            // WAVファイルをパース
            // 標準WAVヘッダー構造:
            // 0-3: RIFF
            // 4-7: file size - 8
            // 8-11: WAVE
            // 12-15: fmt 
            // 16-19: fmt chunk size (16 for PCM)
            // 20-21: audio format (1 = PCM)
            // 22-23: number of channels
            // 24-27: sample rate
            // 28-31: byte rate
            // 32-33: block align
            // 34-35: bits per sample
            // 36-39: data
            // 40-43: data size
            // 44+: audio data

            const channels = fileBuffer.readUInt16LE(22);
            const sampleRate = fileBuffer.readUInt32LE(24);
            const bitsPerSample = fileBuffer.readUInt16LE(34);

            // "data" チャンクを探す (fmt チャンクサイズが可変の場合がある)
            let dataOffset = 12;
            while (dataOffset < fileBuffer.length - 8) {
                const chunkId = fileBuffer.toString('ascii', dataOffset, dataOffset + 4);
                const chunkSize = fileBuffer.readUInt32LE(dataOffset + 4);

                if (chunkId === 'data') {
                    dataOffset += 8; // Skip "data" and size
                    break;
                }
                dataOffset += 8 + chunkSize;
            }

            console.log(`[Main] WAV parsed: channels=${channels}, sampleRate=${sampleRate}, bitsPerSample=${bitsPerSample}, dataOffset=${dataOffset}`);

            // PCMデータ部分を取得
            const pcmData = fileBuffer.slice(dataOffset);

            // バイト配列を Int16 サンプル配列に変換（Little-Endian）
            const int16Samples: number[] = [];
            for (let i = 0; i < pcmData.length - 1; i += 2) {
                int16Samples.push(pcmData.readInt16LE(i));
            }

            console.log(`[Main] Converted to Int16 samples: ${int16Samples.length} samples`);

            return {
                success: true,
                buffer: int16Samples,
                sampleRate,
                channels,
                bitsPerSample
            };
        } else {
            // WAVでない場合はそのまま返す
            return { success: true, buffer: Array.from(fileBuffer) };
        }
    } catch (error) {
        console.error(`Failed to read audio file (${filePath}):`, error);
        return { success: false, error: String(error) };
    }
});

// 現在のセッションパスを取得
ipcMain.handle('get-current-session-path', () => {
    return currentSessionPath;
});

// ============================================
// Folder Organizer API
// ============================================

// フォルダを再帰的に解析
ipcMain.handle('organizer:analyze-folder', async (_event, rootPath: string) => {
    try {
        const files: any[] = [];
        const stats = { totalSize: 0, fileCount: 0, skippedCount: 0 };

        async function scan(dir: string) {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                // システムフォルダや隠しフォルダをスキップ
                if (entry.name.startsWith('.') || ['$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) {
                    stats.skippedCount++;
                    continue;
                }

                if (entry.isDirectory()) {
                    await scan(fullPath);
                } else {
                    const stat = await fs.promises.stat(fullPath);
                    stats.totalSize += stat.size;
                    stats.fileCount++;
                    files.push({
                        path: fullPath,
                        name: entry.name,
                        extension: path.extname(entry.name).toLowerCase(),
                        size: stat.size,
                        mtime: stat.mtime,
                        atime: stat.atime,
                        birthtime: stat.birthtime,
                    });
                }
            }
        }

        await scan(rootPath);
        return { success: true, files, stats };
    } catch (error) {
        console.error('Analyze folder error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// フォルダ構造の適用（コピー実行）
ipcMain.handle('organizer:execute-copy', async (_event, planItems: any[], outputRoot: string) => {
    try {
        if (!fs.existsSync(outputRoot)) {
            await fs.promises.mkdir(outputRoot, { recursive: true });
        }

        let successCount = 0;
        let failCount = 0;
        const errors: any[] = [];

        for (const item of planItems) {
            try {
                // item: { sourcePath: string, destinationPath: string }
                // destinationPath は outputRoot からの相対パス
                const destFullPath = path.join(outputRoot, item.destinationPath);
                const destDir = path.dirname(destFullPath);

                if (!fs.existsSync(destDir)) {
                    await fs.promises.mkdir(destDir, { recursive: true });
                }

                // コピー実行 (上書きしない設定には fs.constants.COPYFILE_EXCL を使うが、
                // 同名ファイルがあった場合のハンドリングが必要。今回は単純コピーとする)
                await fs.promises.copyFile(item.sourcePath, destFullPath);
                successCount++;
            } catch (err) {
                failCount++;
                errors.push({ path: item.sourcePath, error: String(err) });
            }
        }

        return { success: true, successCount, failCount, errors };
    } catch (error) {
        console.error('Execute copy error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// 出力フォルダを開く
ipcMain.handle('organizer:open-folder', async (_event, dirPath: string) => {
    await shell.openPath(dirPath);
    return { success: true };
});

// ファイルの内容を読み取る（詳細解析用）
ipcMain.handle('organizer:read-content', async (_event, filePath: string) => {
    try {
        const ext = path.extname(filePath).toLowerCase();
        let text = '';

        if (ext === '.pdf') {
            const pdfParse = require('pdf-parse');
            const dataBuffer = await fs.promises.readFile(filePath);
            const data = await pdfParse(dataBuffer);
            text = data.text;
        } else if (ext === '.docx') {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: filePath });
            text = result.value;
        } else if (ext === '.xlsx') {
            const XLSX = require('xlsx');
            const workbook = XLSX.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            text = XLSX.utils.sheet_to_text(sheet);
        } else if (ext === '.pptx') {
            const officeParser = require('officeparser');
            text = await new Promise((resolve, reject) => {
                officeParser.parseOffice(filePath, (data: any, err: any) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });
        } else if (['.txt', '.md', '.json', '.csv', '.log'].includes(ext)) {
            text = await fs.promises.readFile(filePath, 'utf-8');
        }

        // Token節約のため、最大文字数を制限 (例: 2000文字)
        return { success: true, text: text.slice(0, 2000) };
    } catch (error) {
        console.error('Read content error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
