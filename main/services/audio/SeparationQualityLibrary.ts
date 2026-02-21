import * as fs from 'fs';

const INT16_MAX = 32767;
const DB_FLOOR = -120;
const ANALYSIS_CLIP_THRESHOLD = 0.985;
const ANALYSIS_NEAR_CLIP_THRESHOLD = 0.94;
const ANALYSIS_SILENCE_THRESHOLD = 0.0012;

interface ParsedMonoPcm16Wav {
    sampleRate: number;
    samples: Int16Array;
    durationMs: number;
}

interface BiquadCoefficients {
    b0: number;
    b1: number;
    b2: number;
    a1: number;
    a2: number;
}

class BiquadFilter {
    private readonly c: BiquadCoefficients;
    private x1 = 0;
    private x2 = 0;
    private y1 = 0;
    private y2 = 0;

    constructor(coefficients: BiquadCoefficients) {
        this.c = coefficients;
    }

    process(input: number): number {
        const output = (this.c.b0 * input)
            + (this.c.b1 * this.x1)
            + (this.c.b2 * this.x2)
            - (this.c.a1 * this.y1)
            - (this.c.a2 * this.y2);
        this.x2 = this.x1;
        this.x1 = input;
        this.y2 = this.y1;
        this.y1 = output;
        return output;
    }
}

export interface SeparationStemQualityMetrics {
    sampleRate: number;
    durationMs: number;
    peakDb: number;
    rmsDb: number;
    crestFactorDb: number;
    clippingRatio: number;
    nearClipRatio: number;
    silenceRatio: number;
    dcOffset: number;
    zeroCrossRate: number;
    lowBandRatio: number;
    midBandRatio: number;
    highBandRatio: number;
    speechActivityRatio: number;
}

export interface SeparationStemQualityScore {
    score: number;
    notes: string[];
    leakageCorrelation?: number;
}

export class SeparationQualityLibrary {
    static analyzeMonoPcm16Wav(filePath: string): SeparationStemQualityMetrics {
        const parsed = this.parseMonoPcm16Wav(filePath);
        const sampleCount = parsed.samples.length;
        if (sampleCount <= 0) {
            return {
                sampleRate: parsed.sampleRate,
                durationMs: parsed.durationMs,
                peakDb: DB_FLOOR,
                rmsDb: DB_FLOOR,
                crestFactorDb: 0,
                clippingRatio: 0,
                nearClipRatio: 0,
                silenceRatio: 1,
                dcOffset: 0,
                zeroCrossRate: 0,
                lowBandRatio: 0,
                midBandRatio: 0,
                highBandRatio: 0,
                speechActivityRatio: 0,
            };
        }

        const lowBandFilter = new BiquadFilter(this.createLowPass(parsed.sampleRate, 140));
        const midBandHighPass = new BiquadFilter(this.createHighPass(parsed.sampleRate, 220));
        const midBandLowPass = new BiquadFilter(this.createLowPass(parsed.sampleRate, 4200));
        const highBandFilter = new BiquadFilter(this.createHighPass(parsed.sampleRate, 7000));

        let peak = 0;
        let sum = 0;
        let sumSq = 0;
        let lowSq = 0;
        let midSq = 0;
        let highSq = 0;
        let clippingCount = 0;
        let nearClipCount = 0;
        let silenceCount = 0;
        let zeroCrossings = 0;

        let prev = parsed.samples[0] / INT16_MAX;
        for (let i = 0; i < sampleCount; i += 1) {
            const value = parsed.samples[i] / INT16_MAX;
            const absValue = Math.abs(value);
            if (absValue > peak) peak = absValue;
            sum += value;
            sumSq += value * value;

            if (absValue >= ANALYSIS_CLIP_THRESHOLD) {
                clippingCount += 1;
            } else if (absValue >= ANALYSIS_NEAR_CLIP_THRESHOLD) {
                nearClipCount += 1;
            }
            if (absValue <= ANALYSIS_SILENCE_THRESHOLD) {
                silenceCount += 1;
            }
            if (i > 0 && ((value >= 0 && prev < 0) || (value < 0 && prev >= 0))) {
                zeroCrossings += 1;
            }
            prev = value;

            const low = lowBandFilter.process(value);
            const mid = midBandLowPass.process(midBandHighPass.process(value));
            const high = highBandFilter.process(value);
            lowSq += low * low;
            midSq += mid * mid;
            highSq += high * high;
        }

        const mean = sum / sampleCount;
        const rms = Math.sqrt(sumSq / sampleCount);
        const clippingRatio = clippingCount / sampleCount;
        const nearClipRatio = nearClipCount / sampleCount;
        const silenceRatio = silenceCount / sampleCount;
        const zeroCrossRate = sampleCount > 1 ? zeroCrossings / (sampleCount - 1) : 0;
        const crestFactorDb = this.toDb((peak + 1e-8) / (rms + 1e-8));
        const rmsDb = this.toDb(rms);
        const peakDb = this.toDb(peak);

        const lowRms = Math.sqrt(lowSq / sampleCount);
        const midRms = Math.sqrt(midSq / sampleCount);
        const highRms = Math.sqrt(highSq / sampleCount);
        const denom = Math.max(1e-8, rms);
        const lowBandRatio = lowRms / denom;
        const midBandRatio = midRms / denom;
        const highBandRatio = highRms / denom;
        const speechActivityRatio = this.estimateSpeechActivityRatio(parsed.samples, parsed.sampleRate, rms);

        return {
            sampleRate: parsed.sampleRate,
            durationMs: parsed.durationMs,
            peakDb: this.roundNumber(peakDb, 2),
            rmsDb: this.roundNumber(rmsDb, 2),
            crestFactorDb: this.roundNumber(crestFactorDb, 2),
            clippingRatio: this.roundNumber(clippingRatio, 6),
            nearClipRatio: this.roundNumber(nearClipRatio, 6),
            silenceRatio: this.roundNumber(silenceRatio, 6),
            dcOffset: this.roundNumber(Math.abs(mean), 6),
            zeroCrossRate: this.roundNumber(zeroCrossRate, 6),
            lowBandRatio: this.roundNumber(lowBandRatio, 4),
            midBandRatio: this.roundNumber(midBandRatio, 4),
            highBandRatio: this.roundNumber(highBandRatio, 4),
            speechActivityRatio: this.roundNumber(speechActivityRatio, 4),
        };
    }

    static estimateLeakageCorrelation(vocalPath: string, accompanimentPath: string): number {
        const vocal = this.parseMonoPcm16Wav(vocalPath);
        const accompaniment = this.parseMonoPcm16Wav(accompanimentPath);
        const n = Math.min(vocal.samples.length, accompaniment.samples.length);
        if (n < 1024) {
            return 0;
        }

        const stride = Math.max(1, Math.floor(n / 200000));
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (let i = 0; i < n; i += stride) {
            const x = vocal.samples[i] / INT16_MAX;
            const y = accompaniment.samples[i] / INT16_MAX;
            sumX += x;
            sumY += y;
            count += 1;
        }
        if (count <= 1) {
            return 0;
        }

        const meanX = sumX / count;
        const meanY = sumY / count;
        let cov = 0;
        let varX = 0;
        let varY = 0;
        for (let i = 0; i < n; i += stride) {
            const x = (vocal.samples[i] / INT16_MAX) - meanX;
            const y = (accompaniment.samples[i] / INT16_MAX) - meanY;
            cov += x * y;
            varX += x * x;
            varY += y * y;
        }
        if (varX <= 1e-12 || varY <= 1e-12) {
            return 0;
        }

        const correlation = cov / Math.sqrt(varX * varY);
        return this.roundNumber(Math.abs(correlation), 6);
    }

    static scoreFromMetrics(
        metrics: SeparationStemQualityMetrics,
        leakageCorrelation?: number,
    ): SeparationStemQualityScore {
        let score = 100;
        const notes: string[] = [];

        if (metrics.rmsDb < -30) {
            score -= Math.min(24, (-30 - metrics.rmsDb) * 0.9);
            notes.push('too_quiet');
        } else if (metrics.rmsDb > -7) {
            score -= Math.min(22, (metrics.rmsDb + 7) * 2.0);
            notes.push('too_loud');
        }

        if (metrics.clippingRatio > 0) {
            score -= Math.min(70, metrics.clippingRatio * 14000);
            notes.push('clipping');
        }
        if (metrics.nearClipRatio > 0.01) {
            score -= Math.min(20, (metrics.nearClipRatio - 0.01) * 620);
            notes.push('near_clipping');
        }

        if (metrics.dcOffset > 0.0015) {
            score -= Math.min(14, (metrics.dcOffset - 0.0015) * 2600);
            notes.push('dc_offset');
        }

        if (metrics.crestFactorDb < 3.5) {
            score -= Math.min(12, (3.5 - metrics.crestFactorDb) * 2.2);
            notes.push('flat_dynamics');
        } else if (metrics.crestFactorDb > 25) {
            score -= Math.min(8, (metrics.crestFactorDb - 25) * 0.75);
            notes.push('spiky_dynamics');
        }

        if (metrics.lowBandRatio > 0.36) {
            score -= Math.min(16, (metrics.lowBandRatio - 0.36) * 90);
            notes.push('low_rumble');
        }
        if (metrics.highBandRatio > 0.75) {
            score -= Math.min(14, (metrics.highBandRatio - 0.75) * 50);
            notes.push('high_hiss');
        }
        if (metrics.midBandRatio < 0.2) {
            score -= Math.min(18, (0.2 - metrics.midBandRatio) * 110);
            notes.push('weak_vocal_band');
        }

        if (metrics.speechActivityRatio < 0.08) {
            score -= Math.min(24, (0.08 - metrics.speechActivityRatio) * 220);
            notes.push('low_speech_activity');
        } else if (metrics.speechActivityRatio > 0.98) {
            score -= Math.min(8, (metrics.speechActivityRatio - 0.98) * 150);
            notes.push('constant_activity');
        }

        if (typeof leakageCorrelation === 'number') {
            if (leakageCorrelation > 0.28) {
                score -= Math.min(22, (leakageCorrelation - 0.28) * 85);
                notes.push('high_bleed');
            } else if (leakageCorrelation < 0.06) {
                score += Math.min(2.4, (0.06 - leakageCorrelation) * 24);
            }
        }

        return {
            score: this.roundNumber(this.clampNumber(score, 0, 100, 0), 2),
            notes,
            leakageCorrelation,
        };
    }

    static buildAdaptiveFilterChain(metrics: SeparationStemQualityMetrics): string {
        // High-pass cut: raised when low-band energy (rumble/bass bleed) is high
        const highpassHz = this.clampNumber(
            Math.round(80 + Math.max(0, metrics.lowBandRatio - 0.25) * 220),
            70,
            180,
            90,
        );
        // Low-pass cut: lowered when high-band energy (hiss/artifact) is high
        const lowpassHz = this.clampNumber(
            Math.round(15000 - Math.max(0, metrics.highBandRatio - 0.45) * 9000),
            8500,
            16000,
            14000,
        );
        // FFT spectral denoising strength: stronger when high-band hiss is prominent
        const afftdnNr = this.clampNumber(
            Math.round(6 + Math.max(0, metrics.highBandRatio - 0.42) * 22),
            6,
            16,
            8,
        );
        // Non-Local Means denoiser (anlmdn) strength coefficient:
        // handles musical noise and residual BGM artifacts left by the neural separator.
        // p controls the denoising patch weight (higher = more aggressive).
        const anlmdnP = this.roundNumber(
            this.clampNumber(0.001 + Math.max(0, metrics.highBandRatio - 0.38) * 0.006, 0.001, 0.006, 0.002),
            4,
        );
        // Dynamic loudness normalization gain
        const dynamicGain = this.clampNumber(
            Math.round(8 + Math.max(0, -18 - metrics.rmsDb) * 0.65),
            6,
            16,
            9,
        );

        return [
            // Steep 2-pole (40 dB/decade) high-pass removes low-end rumble and bass bleed
            `highpass=f=${highpassHz}:poles=2`,
            // FFT-based spectral denoiser — targets stationary hiss and tonal leakage
            `afftdn=nr=${afftdnNr}:nf=-45:tn=1`,
            // Non-local means denoiser — suppresses musical noise (separation artifacts)
            // s=7 (patch window ms), r=0.0015 (research distance), m=15 (filter length)
            `anlmdn=s=7:p=${anlmdnP}:r=0.0015:m=15`,
            // 2-pole low-pass removes harsh high-frequency separation artifacts
            `lowpass=f=${lowpassHz}:poles=2`,
            // Dynamic loudness normalization for consistent RMS
            `dynaudnorm=f=250:g=${dynamicGain}:p=0.95:m=6`,
            // Transparent peak limiter
            'alimiter=limit=0.98',
        ].join(',');
    }

    private static parseMonoPcm16Wav(filePath: string): ParsedMonoPcm16Wav {
        const source = fs.readFileSync(filePath);
        if (source.length < 44) {
            throw new Error(`WAV payload too short: ${filePath}`);
        }
        if (source.toString('ascii', 0, 4) !== 'RIFF' || source.toString('ascii', 8, 12) !== 'WAVE') {
            throw new Error(`Invalid WAV header: ${filePath}`);
        }

        let offset = 12;
        let audioFormat = 1;
        let channels = 1;
        let sampleRate = 44100;
        let bitsPerSample = 16;
        let dataOffset = -1;
        let dataLength = 0;

        while (offset + 8 <= source.length) {
            const chunkId = source.toString('ascii', offset, offset + 4);
            const chunkSize = source.readUInt32LE(offset + 4);
            const chunkDataStart = offset + 8;
            const chunkDataEnd = chunkDataStart + chunkSize;
            if (chunkDataEnd > source.length) {
                break;
            }

            if (chunkId === 'fmt ' && chunkSize >= 16) {
                audioFormat = source.readUInt16LE(chunkDataStart);
                channels = source.readUInt16LE(chunkDataStart + 2) || 1;
                sampleRate = source.readUInt32LE(chunkDataStart + 4) || 44100;
                bitsPerSample = source.readUInt16LE(chunkDataStart + 14) || 16;
            } else if (chunkId === 'data') {
                dataOffset = chunkDataStart;
                dataLength = chunkSize;
                break;
            }

            offset = chunkDataEnd + (chunkSize % 2);
        }

        if (dataOffset < 0) {
            throw new Error(`WAV data chunk not found: ${filePath}`);
        }
        if (audioFormat !== 1) {
            throw new Error(`Unsupported WAV format (${audioFormat}): ${filePath}`);
        }
        if (channels !== 1) {
            throw new Error(`Expected mono WAV, got channels=${channels}: ${filePath}`);
        }
        if (bitsPerSample !== 16) {
            throw new Error(`Expected 16-bit WAV, got bits=${bitsPerSample}: ${filePath}`);
        }
        if (dataOffset + dataLength > source.length) {
            dataLength = source.length - dataOffset;
        }
        if (dataLength < 2) {
            throw new Error(`WAV data chunk is empty: ${filePath}`);
        }
        if (dataLength % 2 !== 0) {
            dataLength -= 1;
        }

        const sampleCount = Math.floor(dataLength / 2);
        const samples = new Int16Array(sampleCount);
        let pointer = dataOffset;
        for (let i = 0; i < sampleCount; i += 1) {
            samples[i] = source.readInt16LE(pointer);
            pointer += 2;
        }

        const durationMs = sampleRate > 0
            ? Math.round((sampleCount / sampleRate) * 1000)
            : 0;

        return {
            sampleRate,
            samples,
            durationMs,
        };
    }

    private static estimateSpeechActivityRatio(
        samples: Int16Array,
        sampleRate: number,
        globalRms: number,
    ): number {
        const frameSize = Math.max(256, Math.floor(sampleRate * 0.02));
        if (samples.length < frameSize * 2) {
            return 0;
        }

        const totalFrames = Math.floor(samples.length / frameSize);
        if (totalFrames <= 0) {
            return 0;
        }

        const energyThreshold = Math.max(0.006, globalRms * 0.42);
        let speechFrames = 0;
        for (let frame = 0; frame < totalFrames; frame += 1) {
            const start = frame * frameSize;
            const end = Math.min(samples.length, start + frameSize);
            let frameSumSq = 0;
            let zc = 0;
            let prev = samples[start] / INT16_MAX;
            for (let i = start; i < end; i += 1) {
                const value = samples[i] / INT16_MAX;
                frameSumSq += value * value;
                if (i > start && ((value >= 0 && prev < 0) || (value < 0 && prev >= 0))) {
                    zc += 1;
                }
                prev = value;
            }
            const length = Math.max(1, end - start);
            const frameRms = Math.sqrt(frameSumSq / length);
            const frameZcr = length > 1 ? zc / (length - 1) : 0;
            if (frameRms >= energyThreshold && frameZcr >= 0.008 && frameZcr <= 0.38) {
                speechFrames += 1;
            }
        }

        return speechFrames / totalFrames;
    }

    private static createLowPass(sampleRate: number, cutoffHz: number, q: number = 0.707): BiquadCoefficients {
        const omega = 2 * Math.PI * this.clampNumber(cutoffHz, 20, (sampleRate * 0.45), 1000) / sampleRate;
        const sin = Math.sin(omega);
        const cos = Math.cos(omega);
        const alpha = sin / (2 * q);
        const b0 = (1 - cos) / 2;
        const b1 = 1 - cos;
        const b2 = (1 - cos) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * cos;
        const a2 = 1 - alpha;
        return {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        };
    }

    private static createHighPass(sampleRate: number, cutoffHz: number, q: number = 0.707): BiquadCoefficients {
        const omega = 2 * Math.PI * this.clampNumber(cutoffHz, 20, (sampleRate * 0.45), 1000) / sampleRate;
        const sin = Math.sin(omega);
        const cos = Math.cos(omega);
        const alpha = sin / (2 * q);
        const b0 = (1 + cos) / 2;
        const b1 = -(1 + cos);
        const b2 = (1 + cos) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * cos;
        const a2 = 1 - alpha;
        return {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        };
    }

    private static toDb(value: number): number {
        return 20 * Math.log10(Math.max(1e-8, value));
    }

    private static roundNumber(value: number, digits: number): number {
        const scale = 10 ** digits;
        return Math.round(value * scale) / scale;
    }

    private static clampNumber(value: number, min: number, max: number, fallback: number): number {
        if (!Number.isFinite(value)) return fallback;
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }
}
