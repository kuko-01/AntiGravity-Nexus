import { app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, shell } from 'electron';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { googleSpeechToTextService } from './googleSpeechToText';
import { streamingSpeechToTextService } from './streamingSpeechToText';
import { whisperService } from './whisperService';
import { autoUpdater } from 'electron-updater';
import { CubismService } from './live2d/CubismService';
import { Sbv2Service } from './services/tts/Sbv2Service';
import { TtsSynthesizeParams, TtsPreset } from '../types/tts';
import { RvcService } from './services/tts/RvcService';
import { VoicePipelineService } from './services/tts/VoicePipelineService';
import { RvcConvertParams, RvcPreset, VoiceSynthesizeParams } from '../types/rvc';
import { CharacterChatService } from './services/CharacterChatService';
import { CharacterChatRequest, CharacterEmotionResult } from '../types/character';

// .env ファイルを読み込み
// .env ファイルを読み込み
const isDevelopment = process.env.NODE_ENV === 'development' || (app && !app.isPackaged);
const resourcesPath = isDevelopment ? path.join(__dirname, '../../') : process.resourcesPath;
const ttsResourcesPath = isDevelopment ? path.join(__dirname, '../../resources') : process.resourcesPath;

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

    // Link Cubism Service to Window
    CubismService.getInstance().setWebContents(mainWindow.webContents);

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
    // mainWindow.webContents.openDevTools();

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
    startSystemCapture: (callback: (data: { buffer: Buffer; channels: number; sampleRate: number; bytesPerSample: number }) => void) => { success: boolean; error?: string };
    stopCapture: () => void;
    isCapturing: () => boolean;
    setProcessMute: (pid: number, mute: boolean) => { success: boolean; error?: string };
    getProcessMute: (pid: number) => { success: boolean; found: boolean; muted: boolean; error?: string };
} | null = null;

try {
    if (isDevelopment) {
        const devCandidates = [
            path.join(__dirname, '../../native/app-audio-capture/build/Release_alt/app_audio_capture.node'),
            path.join(__dirname, '../../native/app-audio-capture/build/Release/app_audio_capture.node'),
        ];
        const nativeModulePath = devCandidates.find((p) => fs.existsSync(p));
        if (nativeModulePath) {
            appAudioCapture = require(nativeModulePath);
            console.log('[Main] Loaded native app-audio-capture module from:', nativeModulePath);
        } else {
            console.warn('[Main] Native app-audio-capture module not found at:', devCandidates.join(' | '));
        }
    } else {
        // パッケージ版: resourcesフォルダ直下に native フォルダをコピーする想定
        const nativeModulePath = path.join(process.resourcesPath, 'native/app-audio-capture/build/Release/app_audio_capture.node');
        if (fs.existsSync(nativeModulePath)) {
            appAudioCapture = require(nativeModulePath);
            console.log('[Main] Loaded native app-audio-capture module from:', nativeModulePath);
        } else {
            console.warn('[Main] Native app-audio-capture module not found at:', nativeModulePath);
        }
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

ipcMain.handle('set-process-mute', async (_event, pid: number, mute: boolean) => {
    try {
        if (!appAudioCapture || typeof appAudioCapture.setProcessMute !== 'function') {
            return { success: false, error: 'Native module does not support process mute control' };
        }
        return appAudioCapture.setProcessMute(pid, mute);
    } catch (error) {
        console.error('Set process mute error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

ipcMain.handle('get-process-mute', async (_event, pid: number) => {
    try {
        if (!appAudioCapture || typeof appAudioCapture.getProcessMute !== 'function') {
            return { success: false, found: false, muted: false, error: 'Native module does not support process mute control' };
        }
        return appAudioCapture.getProcessMute(pid);
    } catch (error) {
        console.error('Get process mute error:', error);
        return { success: false, found: false, muted: false, error: error instanceof Error ? error.message : 'Unknown error' };
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

// Start per-app capture and stream raw PCM chunks to the requesting renderer
ipcMain.handle('start-process-capture-stream', async (event, pid: number) => {
    try {
        if (!appAudioCapture) {
            return { success: false, error: 'Native module not loaded' };
        }

        if (appAudioCapture.isCapturing()) {
            appAudioCapture.stopCapture();
        }

        const sender = event.sender;
        const result = appAudioCapture.startCapture(pid, (data) => {
            if (sender.isDestroyed()) return;
            try {
                if (data.bytesPerSample !== 2) {
                    // Current native module outputs 16-bit PCM. Ignore incompatible formats.
                    return;
                }
                const int16 = new Int16Array(
                    data.buffer.buffer,
                    data.buffer.byteOffset,
                    Math.floor(data.buffer.byteLength / 2)
                );
                sender.send('process-audio-stream', {
                    buffer: Array.from(int16),
                    channels: data.channels,
                    sampleRate: data.sampleRate,
                    bytesPerSample: data.bytesPerSample,
                });
            } catch (streamError) {
                console.error('[Main] process-audio-stream send error:', streamError);
            }
        });

        return result;
    } catch (error) {
        console.error('Start process capture stream error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

ipcMain.handle('stop-process-capture-stream', async () => {
    try {
        if (!appAudioCapture) {
            return { success: false, error: 'Native module not loaded' };
        }
        appAudioCapture.stopCapture();
        return { success: true };
    } catch (error) {
        console.error('Stop process capture stream error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// システム全体の音声キャプチャを開始 (New: Native WASAPI loopback)
ipcMain.handle('start-system-capture', async () => {
    try {
        if (!appAudioCapture) {
            return { success: false, error: 'Native module not loaded' };
        }

        // 連続録音ファイルを準備
        if (currentSessionPath) {
            const timestamp = Date.now();
            continuousRecordingPath = path.join(currentSessionPath, `system_continuous_${timestamp}.raw`);
            continuousRecordingStream = fs.createWriteStream(continuousRecordingPath);
            continuousRecordingTotalSamples = 0;
            lastTranscribedSamples = 0;
            lastMetadataSendTime = 0;
        }

        const result = appAudioCapture.startSystemCapture((data: { buffer: Buffer; sampleRate: number; channels: number; bytesPerSample: number }) => {
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

        console.log('[Main] System capture started:', result);
        return { ...result, recordingPath: continuousRecordingPath };
    } catch (error) {
        console.error('Start system capture error:', error);
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

ipcMain.handle('open-app-volume-settings', async () => {
    try {
        await shell.openExternal('ms-settings:apps-volume');
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// 音声ファイルを読み込む（WAVヘッダーを解析してPCMデータのみ返す）
ipcMain.handle('read-audio-file-deprecated', async (_event, filePath: string) => {
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

// ============================================
// Nano Studio IPC Handlers
// ============================================

const presetsDir = isDevelopment ? path.join(__dirname, '../../presets') : path.join(process.resourcesPath, 'presets');
const outputDir = isDevelopment ? path.join(__dirname, '../../output') : path.join(process.resourcesPath, 'output');

// Ensure directories exist
if (!fs.existsSync(presetsDir)) fs.mkdirSync(presetsDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

ipcMain.handle('nano:select-file', async (_event, extensions: string[], multi: boolean = false) => {
    try {
        const properties: ('openFile' | 'multiSelections')[] = ['openFile'];
        if (multi) properties.push('multiSelections');

        const result = await dialog.showOpenDialog({
            properties,
            filters: [{ name: 'Files', extensions }]
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false };
        }
        return { success: true, path: result.filePaths[0], paths: result.filePaths };
    } catch (error) {
        return { success: false, error: String(error) };
    }
});

ipcMain.handle('nano:read-image', async (_event, filePath: string) => {
    try {
        if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
        const buffer = fs.readFileSync(filePath);
        return { success: true, base64: buffer.toString('base64') };
    } catch (e) {
        return { success: false, error: String(e) };
    }
});

// --- Live2D IPC ---
ipcMain.handle('cubism:send-command', async (_, type, name, payload) => {
    try {
        const msgId = CubismService.getInstance().sendCommand(type, name, payload);
        return { success: true, msgId };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('cubism:get-status', async () => {
    return CubismService.getInstance().getStatus();
});

ipcMain.handle('nano:load-presets', async () => {
    try {
        const files = fs.readdirSync(presetsDir).filter(f => f.endsWith('.json'));
        const presets = files.map(f => {
            const content = fs.readFileSync(path.join(presetsDir, f), 'utf-8');
            return JSON.parse(content);
        });
        return { success: true, presets };
    } catch (error) {
        return { success: true, presets: [] };
    }
});

ipcMain.handle('nano:load-preset', async (_event, name: string) => {
    try {
        const filePath = path.join(presetsDir, `${name}.json`);
        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'Preset not found' };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return { success: true, preset: JSON.parse(content) };
    } catch (error) {
        return { success: false, error: String(error) };
    }
});

ipcMain.handle('nano:save-preset', async (_event, preset: any) => {
    try {
        const filePath = path.join(presetsDir, `${preset.name}.json`);
        fs.writeFileSync(filePath, JSON.stringify(preset, null, 2));
        return { success: true };
    } catch (error) {
        return { success: false, error: String(error) };
    }
});

const MODEL_MAP: Record<string, string> = {
    gemini3pro: process.env.MODEL_ID_GEMINI3PRO || 'gemini-3-pro-image-preview',
    imagen4ultra: process.env.MODEL_ID_IMAGEN4ULTRA || 'imagen-4.0-ultra-generate-001',
    'imagen-3': 'imagen-3.0-generate-001',
    'gemini-2.0-flash': 'gemini-2.0-flash-001',
    'gemini-2.5-flash': 'gemini-2.5-flash-image-preview',
    'gemini-3-pro-preview': 'gemini-3-pro-preview'
};

// ============================================
// Nano Studio vNext: Cost & History Management
// ============================================

const nanoDataDir = isDevelopment ? path.join(__dirname, '../../user_data') : path.join(app.getPath('userData'), 'user_data');
if (!fs.existsSync(nanoDataDir)) fs.mkdirSync(nanoDataDir, { recursive: true });

const budgetPath = path.join(nanoDataDir, 'budget_tracker.json');
const historyPath = path.join(nanoDataDir, 'nano_history.json');

// Pricing Configuration (USD)
const PRICING = {
    'imagen-3.0-fast-generate-001': 0.02, // Draft
    'imagen-3.0-generate-001': 0.04,      // Production
    'imagen-4.0-ultra-generate-001': 0.06, // Final
    'imagen-4-ultra': 0.06,               // Legacy/Alternative ID support
    'gemini-3-pro-image-preview': 0.0,    // Preview (Free?)
    'gemini-2.0-flash-001': 0.0001,       // Very cheap per request usually
    'gemini-3-pro-preview': 0.0,
    'cloud_upscale': 0.06                 // Per image
};


const DEFAULT_BUDGET = {
    dailyLimit: 10.0,
    monthlyLimit: 100.0
};

// --- Cost Manager Class ---
class CostManager {
    static getBudgetStatus() {
        try {
            if (!fs.existsSync(budgetPath)) return { daily: 0, monthly: 0, lastReset: new Date().toISOString() };
            return JSON.parse(fs.readFileSync(budgetPath, 'utf-8'));
        } catch (e) {
            return { daily: 0, monthly: 0, lastReset: new Date().toISOString() };
        }
    }

    static updateBudget(cost: number) {
        const status = this.getBudgetStatus();
        const now = new Date();
        const last = new Date(status.lastReset);

        // Reset counters if new day/month
        if (now.getDate() !== last.getDate()) {
            status.daily = 0;
        }
        if (now.getMonth() !== last.getMonth()) {
            status.monthly = 0;
        }

        status.daily += cost;
        status.monthly += cost;
        status.lastReset = now.toISOString();

        fs.writeFileSync(budgetPath, JSON.stringify(status, null, 2));
        return status;
    }

    static checkBudget(estimatedCost: number): { allowed: boolean; reason?: string } {
        const status = this.getBudgetStatus();
        const dailyLimit = Number(process.env.BUDGET_DAILY_USD) || DEFAULT_BUDGET.dailyLimit;

        if (status.daily + estimatedCost > dailyLimit) {
            return { allowed: false, reason: `Daily budget exceeded using this generation (Current: $${status.daily.toFixed(2)} + Est: $${estimatedCost.toFixed(2)} > Limit: $${dailyLimit.toFixed(2)})` };
        }
        return { allowed: true };
    }

    static calculateCost(modelId: string, count: number, useCloudUpscale: boolean): number {
        const unitPrice = PRICING[modelId as keyof typeof PRICING] || 0.0; // Default to 0 if unknown (e.g. standard Gemini)
        let total = unitPrice * count;
        if (useCloudUpscale) {
            total += (PRICING['cloud_upscale'] * count);
        }
        return total;
    }
}

// --- History Manager Class ---
class HistoryManager {
    static addRecord(record: any) {
        try {
            let history = [];
            if (fs.existsSync(historyPath)) {
                history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            }
            history.unshift(record); // Add to top
            // Limit history size (e.g. 100 items)
            if (history.length > 100) history = history.slice(0, 100);
            fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
        } catch (e) {
            console.error('Failed to save history:', e);
        }
    }

    static getHistory() {
        try {
            if (!fs.existsSync(historyPath)) return [];
            return JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
        } catch (e) {
            return [];
        }
    }
}

// --- IPC Handlers ---

ipcMain.handle('nano:get-history', async () => {
    return { success: true, history: HistoryManager.getHistory() };
});

ipcMain.handle('nano:get-budget-status', async () => {
    const dailyLimit = Number(process.env.BUDGET_DAILY_USD) || DEFAULT_BUDGET.dailyLimit;
    const monthlyLimit = Number(process.env.BUDGET_MONTHLY_USD) || DEFAULT_BUDGET.monthlyLimit;
    return { success: true, status: CostManager.getBudgetStatus(), limits: { daily: dailyLimit, monthly: monthlyLimit } };
});

ipcMain.handle('nano:estimate-cost', async (_event, params: any) => {
    // Mode routing logic for estimation
    let modelId = 'gemini-3-pro-image-preview'; // Default/Manual
    if (params.mode === 'draft') modelId = 'imagen-3.0-fast-generate-001';
    else if (params.mode === 'production') modelId = 'imagen-3.0-generate-001';
    else if (params.mode === 'final') modelId = 'imagen-4-ultra';
    else if (params.modelKey) {
        modelId = MODEL_MAP[params.modelKey] || params.customModelId || modelId;
    }

    const cost = CostManager.calculateCost(modelId, params.count || 1, params.upscaleMethod === 'cloud');
    return { success: true, cost, modelId };
});

// (Moved to top of file)

// ... (Existing code) ...

// Helper: Get GoogleGenAI Client (Hybrid Auth)
async function getAIClient(modelId: string) {
    const { GoogleGenAI } = await import('@google/genai');
    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
    const projectId = process.env.GCP_PROJECT_ID;

    // Auth Strategy
    const isImagen = modelId.startsWith('imagen');

    if (isImagen && projectId) {
        // Vertex AI Strategy for Imagen (Tokyo)
        const targetLocation = process.env.GCP_LOCATION || 'asia-northeast1';
        console.log(`[Auto] Initializing Vertex AI (Imagen) | Project: ${projectId} | Region: ${targetLocation}`);
        return new GoogleGenAI({ vertexai: true, project: projectId, location: targetLocation });
    } else if (apiKey) {
        // AI Studio Strategy
        console.log(`[Auto] Initializing AI Studio with API Key`);
        return new GoogleGenAI({ apiKey });
    } else {
        // Fallback to Vertex US
        console.log(`[Auto] Fallback to Vertex AI (US)`);
        return new GoogleGenAI({ vertexai: true, project: projectId, location: 'us-central1' });
    }
}

// Handler: Auto Prompt Generation
ipcMain.handle('nano:auto-prompt', async (_event, params: { type: 'base' | 'negative', userPrompt: string }) => {
    try {
        const ai = await getAIClient('gemini-2.0-flash-001');

        let systemPrompt = "";
        if (params.type === 'base') {
            systemPrompt = `You are an expert AI Art Prompt Engineer specializing in Japanese Anime Style (Niji/Midjourney/Imagen style).
            Your task is to take a simple user concept and expand it into a detailed, high-quality prompt optimized for "Anime Painting".
            Include keywords like: "anime illustration, cel shading, detailed lineart, 4k, masterpiece".
            Focus on: Lighting, Composition, Color Palette (Vibrant), and Character detail.
            Output ONLY the raw prompt text, no explanations.`;
        } else {
            systemPrompt = `You are an expert AI Art Prompt Engineer.
            Generate a robust "Negative Prompt" for Anime Illustrations to prevent common artifacts.
            Include: "photorealistic, 3d, nsfw, lowres, bad anatomy, bad hands, text, watermark, jpeg artifacts".
            Output ONLY the raw negative prompt text.`;
        }

        const result = await ai.models.generateContent({
            model: 'gemini-2.0-flash-001',
            contents: [
                { role: 'user', parts: [{ text: systemPrompt + "\n\nUser Input: " + params.userPrompt }] }
            ]
        });

        const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return { success: true, prompt: text.trim() };
    } catch (e: any) {
        console.error('Auto Prompt Error:', e);
        return { success: false, error: e.message };
    }
});

// Handler: Optimize Prompt
ipcMain.handle('nano:optimize-prompt', async (_event, prompt: string) => {
    try {
        const ai = await getAIClient('gemini-2.0-flash-001');

        const instruction = `Optimize this prompt for an Image Generation AI (Imagen 3/4).
        - Remove contradictory terms.
        - Enhance descriptive quality.
        - Ensure "Anime Style" focus.
        - Keep it concise but descriptive.
        Output ONLY the final prompt.
        
        Input: "${prompt}"`;

        const result = await ai.models.generateContent({
            model: 'gemini-2.0-flash-001',
            contents: [{ role: 'user', parts: [{ text: instruction }] }]
        });
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return { success: true, prompt: text.trim() };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
});


// Helper: Perform Upscale
async function performUpscale(imagePath: string, scale: number, method: string = 'auto'): Promise<{ success: boolean; path?: string; error?: string }> {
    if (scale <= 1) return { success: true, path: imagePath };

    // Logic: Auto/Local -> Python
    // Logic: Cloud -> Not implemented yet

    // For now, treat Auto/Local as same
    const effectiveMethod = method === 'cloud' ? 'cloud' : 'local';

    if (effectiveMethod === 'cloud') {
        return { success: false, error: 'Cloud upscale is not yet available.' };
    }

    try {
        const { spawn } = await import('child_process');
        const scaleInt = Math.floor(scale);
        console.log(`[Nano] Starting LOCAL upscale (${scaleInt}x) for: ${imagePath}`);

        const projectRoot = isDevelopment ? path.join(__dirname, '../../') : process.resourcesPath;
        const pythonProcess = spawn('python', ['upscale_image.py', imagePath, String(scaleInt)], {
            cwd: projectRoot,
            shell: true
        });

        let stdoutData = '';
        let finalPath = imagePath;
        let warning = '';

        await new Promise<void>((resolve) => {
            pythonProcess.stdout.on('data', (d) => stdoutData += d.toString());
            pythonProcess.on('close', (code) => {
                if (code === 0) {
                    const match = stdoutData.match(/OUTPUT:(.+)/);
                    if (match && match[1]) {
                        finalPath = match[1].trim();
                    }
                } else {
                    warning = `Local upscale failed (code ${code})`;
                }
                resolve();
            });
            pythonProcess.on('error', (e) => {
                warning = `Script error: ${e}`;
                resolve();
            });
            // Timeout 60s
            setTimeout(() => {
                if (pythonProcess.exitCode === null) {
                    pythonProcess.kill();
                    warning = 'Timeout';
                    resolve();
                }
            }, 60000);
        });

        if (warning) return { success: false, error: warning };
        return { success: true, path: finalPath };

    } catch (e) {
        return { success: false, error: String(e) };
    }
}

ipcMain.handle('nano:upscale-image', async (_event, params: { imagePath: string, scale: number }) => {
    return await performUpscale(params.imagePath, params.scale, 'local');
});

// Helper: Perform Smoothing
async function performSmoothing(imagePath: string): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
        const { spawn } = await import('child_process');
        console.log(`[Nano] Starting Smoothing for: ${imagePath}`);

        const projectRoot = isDevelopment ? path.join(__dirname, '../../') : process.resourcesPath;
        const pythonProcess = spawn('python', ['edge_smooth.py', imagePath], {
            cwd: projectRoot,
            shell: true
        });

        let stdoutData = '';
        let finalPath = imagePath;
        let warning = '';

        await new Promise<void>((resolve) => {
            pythonProcess.stdout.on('data', (d) => stdoutData += d.toString());
            pythonProcess.on('close', (code) => {
                if (code === 0) {
                    const match = stdoutData.match(/OUTPUT:(.+)/);
                    if (match && match[1]) {
                        finalPath = match[1].trim();
                    }
                } else {
                    warning = `Smoothing script failed (code ${code})`;
                }
                resolve();
            });
            pythonProcess.on('error', (e) => {
                warning = `Script error: ${e}`;
                resolve();
            });
            setTimeout(() => {
                if (pythonProcess.exitCode === null) {
                    pythonProcess.kill();
                    warning = 'Timeout';
                    resolve();
                }
            }, 30000);
        });

        if (warning) return { success: false, error: warning };
        return { success: true, path: finalPath };

    } catch (e) {
        return { success: false, error: String(e) };
    }
}

ipcMain.handle('nano:smooth-image', async (_event, imagePath: string) => {
    return await performSmoothing(imagePath);
});

// Helper: Format Conversion
async function performFormatConversion(imagePath: string, format: string, quality: number = 90): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
        const { spawn } = await import('child_process');
        const projectRoot = isDevelopment ? path.join(__dirname, '../../') : process.resourcesPath;
        const pythonProcess = spawn('python', ['convert_format.py', imagePath, format, String(quality)], {
            cwd: projectRoot,
            shell: true
        });

        let stdoutData = '';
        let finalPath = imagePath;
        let warning = '';

        await new Promise<void>((resolve) => {
            pythonProcess.stdout.on('data', (d) => stdoutData += d.toString());
            pythonProcess.on('close', (code) => {
                if (code === 0) {
                    const match = stdoutData.match(/OUTPUT:(.+)/);
                    if (match && match[1]) {
                        finalPath = match[1].trim();
                    }
                } else {
                    warning = `Convert script failed (code ${code})`;
                }
                resolve();
            });
            pythonProcess.on('error', (e) => {
                warning = `Script error: ${e}`;
                resolve();
            });
            setTimeout(() => {
                if (pythonProcess.exitCode === null) {
                    pythonProcess.kill();
                    warning = 'Timeout';
                    resolve();
                }
            }, 30000);
        });

        if (warning) return { success: false, error: warning };
        return { success: true, path: finalPath };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

ipcMain.handle('nano:convert-format', async (_event, params: { imagePath: string, format: string, quality?: number }) => {
    return await performFormatConversion(params.imagePath, params.format, params.quality);
});

ipcMain.handle('nano:generate', async (_event, params: {
    prompt: string;
    negativePrompt?: string;
    aspectRatio?: string;
    resolution?: string;
    referenceImage?: string | null;
    referenceImages?: string[]; // Multiple references
    modelKey?: string;
    customModelId?: string;
    upscaleScale?: number;
    mode?: 'draft' | 'production' | 'final' | 'manual';
    upscaleMethod?: 'local' | 'cloud' | 'auto';
    outputFormat?: string;
    outputQuality?: number;
}) => {
    let modelId = 'gemini-3-pro-image-preview'; try {
        const { GoogleGenAI } = await import('@google/genai');
        const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
        const projectId = process.env.GCP_PROJECT_ID;

        // Set credentials for Vertex AI if available
        const credentialsPath = isDevelopment
            ? path.join(__dirname, '../../gcp-credentials.json')
            : path.join(process.resourcesPath, 'gcp-credentials.json');

        if (fs.existsSync(credentialsPath)) {
            process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
        }

        // 1. Resolve Model ID
        if (params.mode === 'draft') modelId = 'imagen-3.0-fast-generate-001';
        else if (params.mode === 'production') modelId = 'imagen-3.0-generate-001';
        else if (params.mode === 'final') modelId = MODEL_MAP['imagen4ultra'];
        else if (params.modelKey) {
            if (params.customModelId) {
                modelId = params.customModelId;
            } else if (MODEL_MAP[params.modelKey]) {
                modelId = MODEL_MAP[params.modelKey];
            }
        }

        // 2. Auth Strategy: Hybrid
        // Imagen models -> Vertex AI (Required)
        // Gemini models -> AI Studio (Preferred/Previous working state) or Vertex (US)

        let effectiveProjectId = projectId;
        const isUltra = modelId.includes('ultra') || modelId.includes('imagen-4');

        if (isUltra) {
            // Ultra uses dedicated credentials
            const ultraCredsPath = isDevelopment
                ? path.join(__dirname, '../../gcp-credentials-ultra.json')
                : path.join(process.resourcesPath, 'gcp-credentials-ultra.json');

            if (fs.existsSync(ultraCredsPath)) {
                process.env.GOOGLE_APPLICATION_CREDENTIALS = ultraCredsPath;
                try {
                    const creds = JSON.parse(fs.readFileSync(ultraCredsPath, 'utf-8'));
                    if (creds.project_id) {
                        effectiveProjectId = creds.project_id;
                        // Force environment variables to update so low-level libs pick it up
                        process.env.GCP_PROJECT_ID = effectiveProjectId;
                        process.env.GOOGLE_CLOUD_PROJECT = effectiveProjectId;
                        console.log(`[Nano] Ultra Credentials Loaded. Project ID switched to: ${effectiveProjectId}`);
                    }
                } catch (e) {
                    console.error('Failed to parse Ultra credentials:', e);
                }
            } else {
                console.warn(`[Nano] Ultra Credentials NOT FOUND at: ${ultraCredsPath}`);
            }
        } else {
            // Revert/Ensure default credentials for others
            if (fs.existsSync(credentialsPath)) {
                process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
            }
        }

        const isImagen = modelId.startsWith('imagen');

        let ai;

        if (isImagen && effectiveProjectId) {
            // Vertex AI Strategy for Imagen
            let targetLocation = process.env.GCP_LOCATION || 'asia-northeast1';

            // Force asia-east1 for Imagen 4 Ultra (Preview Availability)
            if (isUltra) {
                targetLocation = 'asia-east1';
            }

            process.env.GCP_LOCATION = targetLocation;

            console.log(`[Nano] Initializing Vertex AI (Imagen) | Project: ${effectiveProjectId} | Region: ${targetLocation} | Creds: ${isUltra ? 'Ultra' : 'Default'}`);
            ai = new GoogleGenAI({ vertexai: true, project: effectiveProjectId, location: targetLocation });
        } else if (apiKey) {
            // AI Studio Strategy for Gemini (or fallback)
            console.log(`[Nano] Initializing AI Studio (Gemini) with API Key`);
            ai = new GoogleGenAI({ apiKey });
        } else {
            // Fallback to Vertex if no API key
            console.log(`[Nano] Fallback to Vertex AI (US) for Gemini`);
            ai = new GoogleGenAI({ vertexai: true, project: projectId, location: 'us-central1' });
        }

        // 3. Prepare Content (Moved from later, or we wait?)
        // The original code constructed 'contents' *after* auth but *before* generation.
        // We need to ensure 'contents' is available for the API call.
        // Let's use the original flow for content construction, we just needed 'ai' initialized.

        // ... (Content construction follows in original code) ...


        // 2. Budget Guard
        // Note: Gemini 3 Pro is currently free in preview, so cost is 0. Imagen 4 has cost.
        // We use the PRICING table.
        const estimatedCost = CostManager.calculateCost(modelId, 1, false); // Per image check not batch yet
        const budgetCheck = CostManager.checkBudget(estimatedCost);

        if (!budgetCheck.allowed) {
            return { success: false, error: `Budget Limit: ${budgetCheck.reason}` };
        }

        console.log(`[Nano] Generating | Mode: ${params.mode} | Model: ${modelId} | Est: $${estimatedCost}`);

        // 3. Build prompt
        let prompt = params.prompt;

        // Resolution handling
        if (params.resolution) {
            const qualityTags = "ultra high resolution, 4k, 8k, masterpiece, best quality, sharp detail, high fidelity";
            prompt = `resolution: ${params.resolution}, ${qualityTags} -- ${prompt}`;
        }

        if (params.negativePrompt) {
            prompt += `\n\nNegative: ${params.negativePrompt}`;
        }
        if (params.aspectRatio) {
            prompt += `\n\nAspect Ratio: ${params.aspectRatio}`;
        }

        // Reference image handling
        // Reference image handling (Multi + Legacy)
        let parts: any[] = [{ text: prompt }];

        const refImages = [];
        if (params.referenceImage) refImages.push(params.referenceImage);
        if (params.referenceImages && Array.isArray(params.referenceImages)) refImages.push(...params.referenceImages);

        // Deduplicate
        const uniqueRefImages = [...new Set(refImages)];

        for (const imgPath of uniqueRefImages) {
            if (imgPath && fs.existsSync(imgPath)) {
                try {
                    const imageData = fs.readFileSync(imgPath);
                    const base64 = imageData.toString('base64');
                    // Simple mime detection
                    const ext = path.extname(imgPath).toLowerCase();
                    const mimeType = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
                    parts.push({ inlineData: { mimeType, data: base64 } });
                } catch (e) {
                    console.warn(`Failed to read reference image: ${imgPath}`, e);
                }
            }
        }

        // 4. API Call
        console.log(`[Nano] Calling generateContent with Model: ${modelId}`);
        console.log(`[Nano] AI Config -> Project: ${process.env.GCP_PROJECT_ID}, Location: ${process.env.GCP_LOCATION}`);

        // Construct request options dynamically to handle Gemini limitations
        const requestOptions: any = {
            model: modelId,
            contents: [
                {
                    role: 'user',
                    parts: parts
                }
            ]
        };

        // Only add responseModalities for Imagen (Gemini Flash fails with 400 if this is set)
        if (isImagen) {
            requestOptions.config = { responseModalities: ['IMAGE', 'TEXT'] };
        }

        const response = await ai.models.generateContent(requestOptions);

        // 5. Process Response
        if (response.candidates && response.candidates[0]?.content?.parts) {
            for (const part of response.candidates[0].content.parts) {
                if (part.inlineData && part.inlineData.data) {
                    const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
                    const timestamp = Date.now();
                    const filename = `nano_${timestamp}.png`;
                    const imagePath = path.join(outputDir, filename);
                    fs.writeFileSync(imagePath, imageBuffer);

                    let finalPath = imagePath;
                    let warning = undefined;
                    const filesToDelete: string[] = [];

                    // 6. Upscaling (Two-Tier)
                    // Method: 'local' | 'cloud' | 'auto' (default)
                    // Auto = Always Local first. Cloud is manual trigger via specific IPC later.
                    // So here, if scale > 1, we basically always do Local unless 'cloud' is explicitly implemented here (future).
                    if (params.upscaleScale && params.upscaleScale > 1) {
                        const upscaleRes = await performUpscale(imagePath, params.upscaleScale, params.upscaleMethod);
                        if (upscaleRes.success && upscaleRes.path) {
                            filesToDelete.push(finalPath);
                            finalPath = upscaleRes.path;
                        } else if (upscaleRes.error) {
                            warning = upscaleRes.error;
                        }
                    }

                    // 6b. Format Conversion
                    if (params.outputFormat && ['jpeg', 'jpg', 'webp', 'png'].includes(params.outputFormat.toLowerCase())) {
                        // Skip if PNG and no special quality arg? (Optimization: API output is PNG)
                        // But user might want specific compression.
                        // We'll run it.
                        const convertRes = await performFormatConversion(finalPath, params.outputFormat, params.outputQuality);
                        if (convertRes.success && convertRes.path) {
                            if (finalPath !== convertRes.path) filesToDelete.push(finalPath);
                            finalPath = convertRes.path;
                        } else if (convertRes.error) {
                            warning = warning ? `${warning}; Convert failed: ${convertRes.error}` : `Convert failed: ${convertRes.error}`;
                        }
                    }

                    // Cleanup Intermediate Files
                    for (const f of filesToDelete) {
                        try {
                            if (fs.existsSync(f)) fs.unlinkSync(f);
                        } catch (e) {
                            console.error('Failed to cleanup file:', f, e);
                        }
                    }

                    // 7. Data Recording
                    CostManager.updateBudget(estimatedCost);

                    const record = {
                        id: `job_${timestamp}`,
                        timestamp,
                        mode: params.mode || 'manual',
                        modelId,
                        prompt,
                        imagePath: finalPath,
                        cost: estimatedCost,
                        upscale: params.upscaleScale || 1
                    };
                    HistoryManager.addRecord(record);

                    // Read final image for preview
                    let finalBase64 = part.inlineData.data;
                    if (finalPath !== imagePath && fs.existsSync(finalPath)) {
                        finalBase64 = fs.readFileSync(finalPath).toString('base64');
                    }

                    return { success: true, imagePath: finalPath, imageBase64: finalBase64, error: warning, cost: estimatedCost };
                }
            }
        }

        return { success: false, error: 'No image generated in response' };
    } catch (error: any) {
        console.error('[Nano] Generation error:', error);
        return { success: false, error: `Generation Failed (Model: ${modelId || 'Unknown'}): ${error.message || String(error)}` };
    }
});


// ============================================
// TTS (Style-Bert-VITS2) APIs
// ============================================




ipcMain.handle('read-audio-file', async (_event, filePath: string) => {
    try {
        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }
        const buffer = fs.readFileSync(filePath);
        return { success: true, base64: buffer.toString('base64') };
    } catch (error) {
        console.error('Read audio file error:', error);
        return { success: false, error: String(error) };
    }
});

// TTS ステータス取得
ipcMain.handle('tts-get-status', async () => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return service.getStatus();
    } catch (error) {
        console.error('[TTS] Get status error:', error);
        return { installState: 'not_installed', runtimeState: 'stopped' };
    }
});

// TTS インストール
ipcMain.handle('tts-install', async (_event, options?: { dryRun?: boolean; force?: boolean }) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.install(options);
    } catch (error) {
        console.error('[TTS] Install error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: String(error) } };
    }
});

// TTS 修復
ipcMain.handle('tts-repair', async () => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.repair();
    } catch (error) {
        console.error('[TTS] Repair error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: String(error) } };
    }
});

// TTS アンインストール
ipcMain.handle('tts-uninstall', async () => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.uninstall();
    } catch (error) {
        console.error('[TTS] Uninstall error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: String(error) } };
    }
});

// TTS サーバー開始
ipcMain.handle('tts-start-server', async (_event, options?: any) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.startServer(options);
    } catch (error) {
        console.error('[TTS] Start server error:', error);
        return { success: false, error: { code: 'E_SERVER_FAILED', message: String(error) } };
    }
});

// TTS サーバー停止
ipcMain.handle('tts-stop-server', async () => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.stopServer();
    } catch (error) {
        console.error('[TTS] Stop server error:', error);
        return { success: false };
    }
});

// モデル一覧取得
ipcMain.handle('tts-list-models', async () => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.listModels();
    } catch (error) {
        console.error('[TTS] List models error:', error);
        return [];
    }
});

// モデル設定
ipcMain.handle('tts-set-model', async (_event, modelId: string) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.setModel(modelId);
    } catch (error) {
        console.error('[TTS] Set model error:', error);
        return { success: false, error: { code: 'E_MODEL_FAILED', message: String(error) } };
    }
});

// 音声合成
ipcMain.handle('tts-analyze-text', async (_event, text: string) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.analyzeText(text);
    } catch (error) {
        console.error('[TTS] Analyze text error:', error);
        return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// 音声合成
ipcMain.handle('tts-synthesize', async (_event, params: TtsSynthesizeParams) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.synthesize(params);
    } catch (error) {
        console.error('[TTS] Synthesize error:', error);
        return { success: false, error: { code: 'E_SERVER_FAILED', message: String(error) } };
    }
});

// Acting Engine output bundle save
ipcMain.handle('tts-save-acting-bundle', async (_event, payload: any) => {
    try {
        const localBase = path.join(
            process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
            'AntiGravity',
            'tts',
            'sbv2',
            'acting_output',
        );
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const runDir = path.join(localBase, `run_${stamp}`);
        const outputDir = path.join(runDir, 'output');
        const rawDir = path.join(outputDir, 'raw_segments');
        fs.mkdirSync(rawDir, { recursive: true });

        const writeBase64Wav = (filePath: string, base64?: string) => {
            if (!base64 || typeof base64 !== 'string') return;
            fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
        };

        const inputText = String(payload?.inputText || '');
        const segments = Array.isArray(payload?.segments) ? payload.segments : [];
        const params = payload?.params ?? {};
        const rawSegments = Array.isArray(payload?.rawSegments) ? payload.rawSegments : [];
        const mergedAudioBase64 = typeof payload?.mergedAudioBase64 === 'string' ? payload.mergedAudioBase64 : '';
        const finalAudioBase64 = typeof payload?.finalAudioBase64 === 'string' ? payload.finalAudioBase64 : '';

        fs.writeFileSync(path.join(outputDir, 'input.txt'), inputText, 'utf-8');
        fs.writeFileSync(path.join(outputDir, 'segments.json'), JSON.stringify(segments, null, 2), 'utf-8');
        fs.writeFileSync(path.join(outputDir, 'params.json'), JSON.stringify(params, null, 2), 'utf-8');

        const sortedRaw = [...rawSegments].sort((a: any, b: any) => Number(a?.index || 0) - Number(b?.index || 0));
        for (let i = 0; i < sortedRaw.length; i++) {
            const seg = sortedRaw[i];
            const idx = Number.isFinite(Number(seg?.index)) ? Number(seg.index) : i;
            const padded = String(Math.max(0, idx)).padStart(3, '0');
            writeBase64Wav(path.join(rawDir, `seg_${padded}.wav`), seg?.audioBase64);
        }

        writeBase64Wav(path.join(outputDir, 'merged.wav'), mergedAudioBase64);
        writeBase64Wav(path.join(outputDir, 'final.wav'), finalAudioBase64 || mergedAudioBase64);

        return {
            success: true,
            outputDir,
            runDir,
            projectName: payload?.projectName || 'Voice Studio Acting Engine v1',
        };
    } catch (error) {
        console.error('[TTS] Save acting bundle error:', error);
        return { success: false, error: String(error) };
    }
});

const getActingProfilesPath = (): string => {
    return path.join(
        process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
        'AntiGravity',
        'tts',
        'sbv2',
        'config',
        'acting_profiles.json',
    );
};

const getDefaultActingProfiles = () => {
    const nowIso = new Date().toISOString();
    const base = {
        baselineStyle: 'ノーマル',
        styleMap: {
            neutral: 'ノーマル',
            joy: 'るんるん',
            sadness: 'よふかし',
            fear: 'ささやきB',
            anger: 'ノーマル',
        },
        confidenceThreshold: 0.55,
        applyModeDefault: 'fixed_style',
        analyzerModeDefault: 'hybrid',
        classifierBlend: 0.45,
        classifierTemperature: 1.0,
        hybridClassifierScale: 2.4,
        classifierFeatureGain: {
            keyword: 1.0,
            punctuation: 1.0,
            negation: 1.0,
            uncertainty: 1.0,
            laughter: 1.0,
            assertive: 1.0,
            neutralContext: 1.0,
        },
        classifierEmotionBias: {
            neutral: 0.0,
            joy: 0.0,
            sadness: 0.0,
            anger: 0.0,
            fear: 0.0,
        },
        prosodyLimits: {
            speed: [0.9, 1.12],
            pitch: [-12, 12],
            intonation: [0.85, 1.25],
            styleWeight: [0.95, 1.15],
        },
        prosodyDeltaByEmotion: {
            neutral: { speed: 0, pitch: 0, intonation: 0, styleWeight: 0 },
            joy: { speed: 0.07, pitch: 0, intonation: 0.12, styleWeight: 0.05 },
            sadness: { speed: -0.10, pitch: 0, intonation: -0.10, styleWeight: 0 },
            fear: { speed: -0.03, pitch: 0, intonation: 0.05, styleWeight: 0.03 },
            anger: { speed: 0.03, pitch: 0, intonation: 0.15, styleWeight: 0.04 },
        },
        pauseMsByPunct: {
            comma: 120,
            period: 220,
            exclamation: 160,
            question: 200,
            ellipsis: 350,
            newline: 280,
            default: 180,
        },
        pauseEmotionMultiplier: {
            joy: 0.85,
            anger: 0.70,
            sadness: 1.25,
            fear: 1.35,
            neutral: 1.0,
        },
        intensityCurveByEmotion: {
            neutral: { start: 0.95, end: 1.05 },
            joy: { start: 1.0, end: 1.15 },
            sadness: { start: 1.05, end: 0.95 },
            anger: { start: 1.0, end: 1.10 },
            fear: { start: 1.05, end: 1.15 },
        },
        emotionGain: {
            joy: 1.0,
            anger: 0.7,
            sadness: 1.0,
            fear: 1.0,
            neutral: 1.0,
        },
        crossfadeMs: 20,
        dspEnabledByDefault: true,
    };
    return [
        {
            id: 'default',
            name: 'Default Safe Broadcast',
            ...base,
            createdAt: nowIso,
            updatedAt: nowIso,
        },
        {
            id: 'preset_calm',
            name: '落ち着き (Calm Narrator)',
            ...base,
            confidenceThreshold: 0.60,
            classifierBlend: 0.40,
            classifierTemperature: 1.15,
            classifierFeatureGain: {
                ...base.classifierFeatureGain,
                punctuation: 0.75,
                assertive: 0.8,
                neutralContext: 1.15,
            },
            prosodyDeltaByEmotion: {
                ...base.prosodyDeltaByEmotion,
                joy: { speed: 0.04, pitch: 0, intonation: 0.08, styleWeight: 0.03 },
                sadness: { speed: -0.07, pitch: 0, intonation: -0.08, styleWeight: 0.0 },
                anger: { speed: 0.01, pitch: 0, intonation: 0.08, styleWeight: 0.02 },
            },
            pauseMsByPunct: {
                ...base.pauseMsByPunct,
                period: 240,
                question: 220,
                default: 195,
            },
            intensityCurveByEmotion: {
                ...base.intensityCurveByEmotion,
                neutral: { start: 0.92, end: 1.0 },
                joy: { start: 0.97, end: 1.08 },
            },
            createdAt: nowIso,
            updatedAt: nowIso,
        },
        {
            id: 'preset_energetic',
            name: '元気 (Energetic Streamer)',
            ...base,
            confidenceThreshold: 0.50,
            classifierBlend: 0.55,
            classifierTemperature: 0.85,
            hybridClassifierScale: 2.8,
            classifierFeatureGain: {
                ...base.classifierFeatureGain,
                keyword: 1.12,
                punctuation: 1.25,
                laughter: 1.25,
            },
            classifierEmotionBias: {
                ...base.classifierEmotionBias,
                joy: 0.12,
                neutral: -0.08,
            },
            prosodyDeltaByEmotion: {
                ...base.prosodyDeltaByEmotion,
                joy: { speed: 0.10, pitch: 0, intonation: 0.16, styleWeight: 0.08 },
                anger: { speed: 0.05, pitch: 0, intonation: 0.18, styleWeight: 0.05 },
                fear: { speed: -0.01, pitch: 0, intonation: 0.09, styleWeight: 0.05 },
            },
            pauseMsByPunct: {
                ...base.pauseMsByPunct,
                comma: 95,
                period: 190,
                exclamation: 130,
                default: 145,
            },
            emotionGain: {
                ...base.emotionGain,
                joy: 1.15,
                anger: 0.85,
            },
            createdAt: nowIso,
            updatedAt: nowIso,
        },
        {
            id: 'preset_tense',
            name: '不穏 (Tense / Dark)',
            ...base,
            confidenceThreshold: 0.56,
            classifierBlend: 0.62,
            classifierTemperature: 0.92,
            hybridClassifierScale: 2.9,
            classifierFeatureGain: {
                ...base.classifierFeatureGain,
                uncertainty: 1.3,
                negation: 1.25,
                punctuation: 1.05,
            },
            classifierEmotionBias: {
                ...base.classifierEmotionBias,
                fear: 0.18,
                sadness: 0.10,
                joy: -0.12,
            },
            styleMap: {
                ...base.styleMap,
                fear: 'ささやきB',
                sadness: 'よふかし',
            },
            prosodyDeltaByEmotion: {
                ...base.prosodyDeltaByEmotion,
                fear: { speed: -0.06, pitch: 0, intonation: 0.06, styleWeight: 0.05 },
                sadness: { speed: -0.12, pitch: 0, intonation: -0.12, styleWeight: 0.01 },
                joy: { speed: 0.03, pitch: 0, intonation: 0.06, styleWeight: 0.03 },
            },
            pauseMsByPunct: {
                ...base.pauseMsByPunct,
                period: 255,
                ellipsis: 420,
                question: 240,
                default: 205,
            },
            pauseEmotionMultiplier: {
                ...base.pauseEmotionMultiplier,
                fear: 1.45,
                sadness: 1.30,
            },
            createdAt: nowIso,
            updatedAt: nowIso,
        },
    ];
};

const mergeBuiltinActingProfiles = (profiles: any[]): any[] => {
    const builtins = getDefaultActingProfiles();
    const builtinsById = new Map(builtins.map((p) => [p.id, p]));
    const existingById = new Map(
        (Array.isArray(profiles) ? profiles : [])
            .filter((p: any) => p && typeof p.id === 'string' && p.id.trim().length > 0)
            .map((p: any) => [String(p.id), p]),
    );

    const mergedBuiltins = builtins.map((builtin) => existingById.get(builtin.id) || builtin);
    const extras = Array.from(existingById.values())
        .filter((p: any) => !builtinsById.has(p.id));
    return [...mergedBuiltins, ...extras];
};

const readActingProfiles = (): any[] => {
    const profilePath = getActingProfilesPath();
    if (!fs.existsSync(profilePath)) {
        return mergeBuiltinActingProfiles([]);
    }
    try {
        const raw = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
        const list = Array.isArray(raw) ? raw : [];
        return mergeBuiltinActingProfiles(list);
    } catch {
        return mergeBuiltinActingProfiles([]);
    }
};

const writeActingProfiles = (profiles: any[]) => {
    const profilePath = getActingProfilesPath();
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify(profiles, null, 2), 'utf-8');
};

ipcMain.handle('tts-acting-list-profiles', async () => {
    try {
        const profiles = readActingProfiles();
        writeActingProfiles(profiles);
        return { success: true, profiles };
    } catch (error) {
        console.error('[TTS] Acting profile list error:', error);
        return { success: false, error: String(error), profiles: mergeBuiltinActingProfiles([]) };
    }
});

ipcMain.handle('tts-acting-save-profile', async (_event, profile: any) => {
    try {
        const nowIso = new Date().toISOString();
        const id = typeof profile?.id === 'string' && profile.id.trim().length > 0
            ? profile.id.trim()
            : `profile_${Date.now()}`;
        const name = typeof profile?.name === 'string' && profile.name.trim().length > 0
            ? profile.name.trim()
            : 'Acting Profile';
        const next = {
            ...profile,
            id,
            name,
            updatedAt: nowIso,
            createdAt: profile?.createdAt || nowIso,
        };

        const profiles = readActingProfiles();
        const idx = profiles.findIndex((p: any) => p?.id === id);
        if (idx >= 0) {
            profiles[idx] = next;
        } else {
            profiles.push(next);
        }
        writeActingProfiles(profiles);
        return { success: true, profile: next };
    } catch (error) {
        console.error('[TTS] Acting profile save error:', error);
        return { success: false, error: String(error) };
    }
});

ipcMain.handle('tts-acting-delete-profile', async (_event, profileId: string) => {
    try {
        const id = String(profileId || '').trim();
        if (!id) {
            return { success: false, error: 'profileId is required' };
        }
        if (id === 'default' || id.startsWith('preset_')) {
            return { success: false, error: 'bundled profile cannot be deleted' };
        }
        const profiles = mergeBuiltinActingProfiles(readActingProfiles().filter((p: any) => p?.id !== id));
        writeActingProfiles(profiles);
        return { success: true };
    } catch (error) {
        console.error('[TTS] Acting profile delete error:', error);
        return { success: false, error: String(error) };
    }
});

ipcMain.handle('tts-acting-reset-bundled-profiles', async () => {
    try {
        const bundled = getDefaultActingProfiles();
        const bundledIds = new Set(bundled.map((p) => p.id));
        const current = readActingProfiles();
        const custom = current.filter((p: any) => !bundledIds.has(String(p?.id || '')));
        const next = [...bundled, ...custom];
        writeActingProfiles(next);
        return { success: true, profiles: next };
    } catch (error) {
        console.error('[TTS] Acting profile reset bundled error:', error);
        return { success: false, error: String(error) };
    }
});

// プリセット一覧取得
ipcMain.handle('tts-get-presets', async () => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return service.getPresets();
    } catch (error) {
        console.error('[TTS] Get presets error:', error);
        return [];
    }
});

// プリセット保存
ipcMain.handle('tts-save-preset', async (_event, preset: Omit<TtsPreset, 'id' | 'createdAt' | 'updatedAt'>) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return service.savePreset(preset);
    } catch (error) {
        console.error('[TTS] Save preset error:', error);
        return null;
    }
});

// プリセット更新
ipcMain.handle('tts-update-preset', async (_event, id: string, updates: Partial<TtsPreset>) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return service.updatePreset(id, updates);
    } catch (error) {
        console.error('[TTS] Update preset error:', error);
        return null;
    }
});

// プリセット削除
ipcMain.handle('tts-delete-preset', async (_event, id: string) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return service.deletePreset(id);
    } catch (error) {
        console.error('[TTS] Delete preset error:', error);
        return false;
    }
});

// GPU情報取得
ipcMain.handle('tts-get-gpu-info', async () => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.getGpuInfo();
    } catch (error) {
        console.error('[TTS] Get GPU info error:', error);
        return {
            cudaAvailable: false,
            cudaVersion: null,
            torchVersion: 'Unknown',
            deviceCount: 0,
            currentDevice: 'none',
            devices: [`Error: ${String(error)}`]
        };
    }
});



// TTS Paths Config
ipcMain.handle('tts-get-paths-config', async () => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.getPathsConfig();
    } catch (error) {
        console.error('[TTS] Get paths config error:', error);
        return { datasetRoot: 'Data', assetsRoot: 'model_assets' };
    }
});

ipcMain.handle('tts-set-paths-config', async (_event, config: { datasetRoot: string; assetsRoot: string }) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        await service.setPathsConfig(config);
        return { success: true };
    } catch (error) {
        console.error('[TTS] Set paths config error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// TTS Install Training Dependencies
ipcMain.handle('tts-install-training-deps', async () => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        await service.installTrainingDependencies();
        return { success: true };
    } catch (error) {
        console.error('[TTS] Install training deps error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// TTS Slice Audio
ipcMain.handle('tts-slice-audio', async (_event, datasetName: string, inputDir: string, options?: any) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        await service.sliceAudio(datasetName, inputDir, options);
        return { success: true };
    } catch (error) {
        console.error('Slice audio error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// TTS Transcribe Audio
ipcMain.handle('tts-transcribe-audio', async (_event, datasetName: string, options?: any) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        await service.transcribeAudio(datasetName, options);
        return { success: true };
    } catch (error) {
        console.error('Transcribe audio error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// TTS Save Transcription
ipcMain.handle('tts-save-transcription', async (_event, datasetName: string, content: string) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        await service.saveTranscription(datasetName, content);
        return { success: true };
    } catch (error) {
        console.error('Save transcription error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// TTS Initialize Training Config
ipcMain.handle('tts-init-training-config', async (_event, datasetName: string) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        await service.initializeTrainingConfig(datasetName);
        return { success: true };
    } catch (error) {
        console.error('Init config error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// TTS Generate BERT
ipcMain.handle('tts-generate-bert', async (_event, datasetName: string) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        await service.generateBert(datasetName);
        return { success: true };
    } catch (error) {
        console.error('Generate BERT error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
});

// TTS Train Model
ipcMain.handle('tts-train-model', async (_event, datasetName: string, options?: { speedup?: boolean; noProgressBar?: boolean; epochs?: number }) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.trainModel(datasetName, options);
    } catch (error) {
        console.error('Train model error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
});

// TTS Clean Audio (DeepFilterNet)
ipcMain.handle('tts-clean-audio', async (_event, datasetName: string) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.cleanAudio(datasetName);
    } catch (error) {
        console.error('Clean audio error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
});

// TTS Filter Audio (Gemini Quality Gate)
ipcMain.handle('tts-filter-audio', async (_event, datasetName: string) => {
    try {
        const service = Sbv2Service.getInstance(ttsResourcesPath);
        return await service.filterAudio(datasetName);
    } catch (error) {
        console.error('Filter audio error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
});

// RVC ステータス取得
ipcMain.handle('rvc-get-status', async () => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return service.getStatus();
    } catch (error) {
        console.error('[RVC] Get status error:', error);
        return { installState: 'not_installed', runtimeState: 'stopped' };
    }
});

// RVC インストール
ipcMain.handle('rvc-install', async (_event, options?: { dryRun?: boolean; force?: boolean }) => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.install(options);
    } catch (error) {
        console.error('[RVC] Install error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: String(error) } };
    }
});

// RVC 修復
ipcMain.handle('rvc-repair', async () => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.repair();
    } catch (error) {
        console.error('[RVC] Repair error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: String(error) } };
    }
});

// RVC アンインストール
ipcMain.handle('rvc-uninstall', async () => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.uninstall();
    } catch (error) {
        console.error('[RVC] Uninstall error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: String(error) } };
    }
});

// RVC サーバー開始
ipcMain.handle('rvc-start-server', async (_event, options?: { forceCpu?: boolean; verboseLogs?: boolean }) => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.startServer(options);
    } catch (error) {
        console.error('[RVC] Start server error:', error);
        return { success: false, error: { code: 'E_SERVER_FAILED', message: String(error) } };
    }
});

// RVC ログ出力設定
ipcMain.handle('rvc-set-verbose-logs', async (_event, enabled: boolean) => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        service.setVerboseLogs(!!enabled);
        return {
            success: true,
            verboseLogs: service.getVerboseLogs(),
            requiresRestart: service.getStatus().runtimeState === 'running',
        };
    } catch (error) {
        console.error('[RVC] Set verbose logs error:', error);
        return { success: false, error: String(error) };
    }
});

ipcMain.handle('rvc-get-verbose-logs', async () => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return { success: true, verboseLogs: service.getVerboseLogs() };
    } catch (error) {
        console.error('[RVC] Get verbose logs error:', error);
        return { success: false, verboseLogs: false, error: String(error) };
    }
});

// RVC サーバー停止
ipcMain.handle('rvc-stop-server', async () => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.stopServer();
    } catch (error) {
        console.error('[RVC] Stop server error:', error);
        return { success: false };
    }
});

// RVC GPU情報取得
ipcMain.handle('rvc-get-gpu-info', async () => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.getGpuInfo();
    } catch (error) {
        console.error('[RVC] Get GPU info error:', error);
        return {
            cudaAvailable: false,
            cudaVersion: null,
            torchVersion: 'Unknown',
            deviceCount: 0,
            currentDevice: 'none',
            devices: [`Error: ${String(error)}`]
        };
    }
});

// RVC モデル一覧取得
ipcMain.handle('rvc-list-models', async () => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.listModels();
    } catch (error) {
        console.error('[RVC] List models error:', error);
        return [];
    }
});

// RVC モデルごとのインデックス一覧取得
ipcMain.handle('rvc-list-model-indexes', async (_event, modelId: string) => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.listModelIndexes(modelId);
    } catch (error) {
        console.error('[RVC] List model indexes error:', error);
        return [];
    }
});

// RVC モデルフォルダを開く
ipcMain.handle('rvc-open-models-folder', async () => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        const modelsPath = service.getModelsPath();
        fs.mkdirSync(modelsPath, { recursive: true });
        const openError = await shell.openPath(modelsPath);
        if (openError) {
            return { success: false, error: openError };
        }
        return { success: true, path: modelsPath };
    } catch (error) {
        console.error('[RVC] Open models folder error:', error);
        return { success: false, error: String(error) };
    }
});

// RVC モデル設定
ipcMain.handle('rvc-set-model', async (_event, modelId: string) => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.setModel(modelId);
    } catch (error) {
        console.error('[RVC] Set model error:', error);
        return { success: false, error: { code: 'E_MODEL_FAILED', message: String(error) } };
    }
});

// RVC 変換
ipcMain.handle('rvc-convert', async (_event, params: RvcConvertParams) => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return await service.convert(params);
    } catch (error) {
        console.error('[RVC] Convert error:', error);
        return { success: false, error: { code: 'E_CONVERT_FAILED', message: String(error) } };
    }
});

// RVC プリセット一覧取得
ipcMain.handle('rvc-get-presets', async () => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return service.getPresets();
    } catch (error) {
        console.error('[RVC] Get presets error:', error);
        return [];
    }
});

// RVC プリセット保存
ipcMain.handle('rvc-save-preset', async (_event, preset: Omit<RvcPreset, 'id' | 'createdAt' | 'updatedAt'>) => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return service.savePreset(preset);
    } catch (error) {
        console.error('[RVC] Save preset error:', error);
        return null;
    }
});

// RVC プリセット更新
ipcMain.handle('rvc-update-preset', async (_event, id: string, updates: Partial<RvcPreset>) => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return service.updatePreset(id, updates);
    } catch (error) {
        console.error('[RVC] Update preset error:', error);
        return null;
    }
});

// RVC プリセット削除
ipcMain.handle('rvc-delete-preset', async (_event, id: string) => {
    try {
        const service = RvcService.getInstance(ttsResourcesPath);
        return service.deletePreset(id);
    } catch (error) {
        console.error('[RVC] Delete preset error:', error);
        return false;
    }
});

// SBV2 / RVC 統合パイプライン
ipcMain.handle('voice-synthesize', async (_event, params: VoiceSynthesizeParams) => {
    try {
        const service = VoicePipelineService.getInstance(ttsResourcesPath);
        return await service.synthesize(params);
    } catch (error) {
        console.error('[VoicePipeline] Synthesize error:', error);
        return { success: false, error: { code: 'E_UNKNOWN', message: String(error) } };
    }
});

const buildSbv2EmotionDefaults = (emotion?: CharacterEmotionResult): NonNullable<VoiceSynthesizeParams['sbv2']> => {
    const label = emotion?.label || 'neutral';
    const intensity = Math.max(0, Math.min(1, emotion?.intensity ?? 0));

    const base = {
        style: 'ノーマル',
        speed: 1.0,
        pitch: 0.0,
        intonation: 1.0,
        styleWeight: 1.0,
        assistText: '親しみやすく自然な話し方',
        assistTextWeight: 1.0,
    };

    switch (label) {
        case 'joy':
            return {
                ...base,
                speed: 1.0 + 0.08 * intensity,
                pitch: 0.0 + 0.45 * intensity,
                intonation: 1.0 + 0.16 * intensity,
                styleWeight: 1.0 + 0.08 * intensity,
                assistText: '明るく優しく、親しみやすく',
            };
        case 'sad':
            return {
                ...base,
                style: 'よふかし',
                speed: 1.0 - 0.1 * intensity,
                pitch: 0.0 - 0.35 * intensity,
                intonation: 1.0 - 0.12 * intensity,
                assistText: '落ち着いて穏やかに、やさしく',
            };
        case 'angry':
            return {
                ...base,
                speed: 1.0 + 0.07 * intensity,
                pitch: 0.0 + 0.2 * intensity,
                intonation: 1.0 + 0.15 * intensity,
                styleWeight: 1.0 + 0.1 * intensity,
                assistText: '強めだが威圧しすぎない、はっきりと',
            };
        case 'excited':
            return {
                ...base,
                style: 'るんるん',
                speed: 1.0 + 0.12 * intensity,
                pitch: 0.0 + 0.55 * intensity,
                intonation: 1.0 + 0.2 * intensity,
                styleWeight: 1.0 + 0.12 * intensity,
                assistText: '元気でわくわくした雰囲気',
            };
        default:
            return base;
    }
};

const ensureSbv2ServerRunningForCharacter = async (): Promise<{ success: boolean; error?: { code: string; message: string } }> => {
    const service = Sbv2Service.getInstance(ttsResourcesPath);
    const status = service.getStatus();
    if (status.installState !== 'installed') {
        return {
            success: false,
            error: {
                code: 'E_SERVER_FAILED',
                message: 'SBV2 is not installed. Please install SBV2 first.',
            },
        };
    }

    if (status.runtimeState !== 'running') {
        console.log('[CharacterChat] Auto-starting SBV2 server...');
        const startResult = await service.startServer();
        if (!startResult.success) {
            return {
                success: false,
                error: {
                    code: startResult.error?.code || 'E_SERVER_FAILED',
                    message: startResult.error?.message || 'Failed to start SBV2 server',
                },
            };
        }
    }

    return { success: true };
};

const ensureRvcServerRunningForCharacter = async (): Promise<{ success: boolean; error?: { code: string; message: string } }> => {
    const service = RvcService.getInstance(ttsResourcesPath);
    const status = service.getStatus();
    if (status.installState !== 'installed') {
        return {
            success: false,
            error: {
                code: 'E_SERVER_FAILED',
                message: 'RVC is not installed. Please install RVC first.',
            },
        };
    }

    if (status.runtimeState !== 'running') {
        console.log('[CharacterChat] Auto-starting RVC server...');
        const startResult = await service.startServer();
        if (!startResult.success) {
            return {
                success: false,
                error: {
                    code: startResult.error?.code || 'E_SERVER_FAILED',
                    message: startResult.error?.message || 'Failed to start RVC server',
                },
            };
        }
    }

    return { success: true };
};

const ensureVoiceServersForCharacter = async (
    mode: VoiceSynthesizeParams['mode'],
): Promise<{ success: boolean; error?: { code: string; message: string } }> => {
    if (mode === 'sbv2' || mode === 'sbv2+rvc') {
        const sbv2Ready = await ensureSbv2ServerRunningForCharacter();
        if (!sbv2Ready.success) {
            return sbv2Ready;
        }
    }

    if (mode === 'rvc' || mode === 'sbv2+rvc') {
        const rvcReady = await ensureRvcServerRunningForCharacter();
        if (!rvcReady.success) {
            return rvcReady;
        }
    }

    return { success: true };
};

ipcMain.handle('character-chat-send', async (_event, request: CharacterChatRequest) => {
    try {
        const chatService = CharacterChatService.getInstance();
        const chatResult = await chatService.sendMessage(request);
        if (!chatResult.success) {
            return chatResult;
        }

        if (!request.withVoice) {
            return chatResult;
        }

        const responseText = chatResult.responseText || '';
        if (!responseText.trim()) {
            return chatResult;
        }

        const defaultSbv2 = buildSbv2EmotionDefaults(chatResult.emotion);
        const voiceParams: VoiceSynthesizeParams = {
            text: responseText,
            mode: request.voice?.mode || 'sbv2+rvc',
            sbv2: {
                ...defaultSbv2,
                ...(request.voice?.sbv2 || {}),
            },
            rvc: request.voice?.rvc,
        };

        const runtimeReady = await ensureVoiceServersForCharacter(voiceParams.mode);
        if (!runtimeReady.success) {
            return {
                ...chatResult,
                voice: {
                    success: false,
                    error: runtimeReady.error || { code: 'E_SERVER_FAILED', message: 'Voice server startup failed' },
                },
            };
        }

        const voiceService = VoicePipelineService.getInstance(ttsResourcesPath);
        const voiceResult = await voiceService.synthesize(voiceParams);

        return {
            ...chatResult,
            voice: voiceResult,
        };
    } catch (error) {
        console.error('[CharacterChat] Send error:', error);
        return {
            success: false,
            sessionId: request.sessionId || `char_error_${Date.now()}`,
            error: String(error),
        };
    }
});

ipcMain.handle('character-chat-reset', async (_event, sessionId: string) => {
    try {
        const service = CharacterChatService.getInstance();
        return service.resetSession(String(sessionId || ''));
    } catch (error) {
        console.error('[CharacterChat] Reset error:', error);
        return { success: false, error: String(error) };
    }
});

ipcMain.handle('util:select-directory', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }
    return result.filePaths[0];
});

app.whenReady().then(() => {
    createWindow();

    // Start Live2D Host
    CubismService.getInstance().startHost();

    // Auto-updater: Check for updates on startup (production only)
    if (app.isPackaged) {
        autoUpdater.checkForUpdatesAndNotify();
    }

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
