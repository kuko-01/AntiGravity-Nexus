/**
 * OPUS Encoder Service
 * @discordjs/opus を使用した PCM → OPUS 変換
 */

// @ts-ignore - @discordjs/opus の型定義がない場合があるため
import OpusEncoder from '@discordjs/opus';

class OpusEncoderService {
    private encoder: OpusEncoder.OpusEncoder | null = null;
    private channels: number = 2;
    private frameSize: number = 960; // 20ms @ 48kHz

    /**
     * エンコーダを初期化
     */
    initialize(sampleRate: number = 48000, channels: number = 2): void {
        this.channels = channels;
        // 20ms frame size = sampleRate * 0.02
        this.frameSize = Math.floor(sampleRate * 0.02);

        try {
            this.encoder = new OpusEncoder.OpusEncoder(sampleRate, channels);
            console.log(`[OpusEncoder] Initialized: ${sampleRate}Hz, ${channels}ch, frameSize=${this.frameSize}`);
        } catch (error) {
            console.error('[OpusEncoder] Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * PCMデータをOPUSにエンコード
     * @param pcmBuffer 16-bit signed PCM data
     * @returns OPUS encoded frames concatenated
     */
    encode(pcmBuffer: Buffer): Buffer {
        if (!this.encoder) {
            throw new Error('OpusEncoder is not initialized');
        }

        const opusFrames: Buffer[] = [];
        const bytesPerSample = 2; // 16-bit
        const bytesPerFrame = this.frameSize * this.channels * bytesPerSample;

        let offset = 0;
        while (offset + bytesPerFrame <= pcmBuffer.length) {
            const frame = pcmBuffer.slice(offset, offset + bytesPerFrame);
            try {
                const encoded = this.encoder.encode(frame);
                opusFrames.push(encoded);
            } catch (error) {
                console.error('[OpusEncoder] Encode error at offset', offset, error);
            }
            offset += bytesPerFrame;
        }

        // 残りのデータがあれば0パディングしてエンコード
        if (offset < pcmBuffer.length) {
            // remaining bytes not used but kept for documentation
            const paddedFrame = Buffer.alloc(bytesPerFrame);
            pcmBuffer.copy(paddedFrame, 0, offset, pcmBuffer.length);
            try {
                const encoded = this.encoder.encode(paddedFrame);
                opusFrames.push(encoded);
            } catch (error) {
                console.error('[OpusEncoder] Final frame encode error:', error);
            }
        }

        // すべてのフレームを連結
        // 注意: GCP Speech-to-Text の OGG_OPUS は OGG コンテナが必要
        // 生の OPUS フレームでは動作しないため、OGG ヘッダーを追加する必要がある
        const totalSize = opusFrames.reduce((sum, f) => sum + f.length, 0);
        const result = Buffer.concat(opusFrames, totalSize);

        console.log(`[OpusEncoder] Encoded ${pcmBuffer.length} bytes PCM -> ${result.length} bytes OPUS (${((1 - result.length / pcmBuffer.length) * 100).toFixed(1)}% reduction)`);

        return result;
    }

    /**
     * サンプルレートを変換（44100Hz -> 48000Hz）
     * OPUS は 48kHz を推奨
     */
    resample44100to48000(pcmBuffer: Buffer, channels: number = 2): Buffer {
        const bytesPerSample = 2;
        const inputSamples = pcmBuffer.length / (bytesPerSample * channels);
        const outputSamples = Math.floor(inputSamples * 48000 / 44100);
        const output = Buffer.alloc(outputSamples * bytesPerSample * channels);

        for (let i = 0; i < outputSamples; i++) {
            const srcPos = (i * 44100) / 48000;
            const srcIndex = Math.floor(srcPos);
            const frac = srcPos - srcIndex;

            for (let ch = 0; ch < channels; ch++) {
                const offset = (srcIndex * channels + ch) * bytesPerSample;
                const nextOffset = Math.min((srcIndex + 1) * channels + ch, inputSamples * channels - 1) * bytesPerSample;

                if (offset + 1 < pcmBuffer.length && nextOffset + 1 < pcmBuffer.length) {
                    const sample1 = pcmBuffer.readInt16LE(offset);
                    const sample2 = pcmBuffer.readInt16LE(nextOffset);
                    const interpolated = Math.round(sample1 * (1 - frac) + sample2 * frac);
                    output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), (i * channels + ch) * bytesPerSample);
                }
            }
        }

        return output;
    }

    /**
     * リソースを解放
     */
    destroy(): void {
        if (this.encoder) {
            // @discordjs/opus doesn't have explicit destroy, just null the reference
            this.encoder = null;
            console.log('[OpusEncoder] Destroyed');
        }
    }
}

export const opusEncoderService = new OpusEncoderService();
