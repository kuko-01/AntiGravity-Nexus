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

export interface SeparationReferenceDebleedSummary {
    avgCorrelation: number;
    avgAbsLeakGain: number;
    maxAbsLeakGain: number;
    frameCount: number;
}

export interface SeparationMusicOnlyRemovalSummary {
    frameCount: number;
    keepFrames: number;
    removedSegments: number;
    removedDurationMs: number;
    zeroedShortGapDurationMs: number;
    outputDurationMs: number;
    avgDominance: number;
    avgCorrelation: number;
    lowLeakFrames: number;
}

export interface SeparationVocalEnsembleSummary {
    frameCount: number;
    avgInterCandidateCorrelation: number;
    avgPrimaryWeight: number;
    avgSecondaryWeight: number;
    bgmSuppressedFrames: number;
    outputDurationMs: number;
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
        // Non-Local Means denoiser (anlmdn) tuning:
        // p = patch duration, r = research duration (must be >= p in practice)
        // s = denoising strength. We bias stronger when hiss/artifacts are prominent.
        const anlmdnPatch = this.roundNumber(
            this.clampNumber(0.0015 + Math.max(0, metrics.highBandRatio - 0.38) * 0.003, 0.0015, 0.0045, 0.002),
            4,
        );
        const anlmdnResearch = this.roundNumber(
            this.clampNumber(Math.max(0.006, anlmdnPatch * 3.2), 0.006, 0.020, 0.006),
            4,
        );
        const anlmdnStrength = this.roundNumber(
            this.clampNumber(4.5 + Math.max(0, metrics.highBandRatio - 0.40) * 22, 3.5, 16, 6),
            3,
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
            `anlmdn=s=${anlmdnStrength}:p=${anlmdnPatch}:r=${anlmdnResearch}:m=15`,
            // 2-pole low-pass removes harsh high-frequency separation artifacts
            `lowpass=f=${lowpassHz}:poles=2`,
            // Dynamic loudness normalization for consistent RMS
            `dynaudnorm=f=250:g=${dynamicGain}:p=0.95:m=6`,
            // Transparent peak limiter
            'alimiter=limit=0.98',
        ].join(',');
    }

    static reduceBleedWithReferenceMonoPcm16Wav(
        vocalPath: string,
        accompanimentPath: string,
        outputPath: string,
    ): SeparationReferenceDebleedSummary {
        const vocal = this.parseMonoPcm16Wav(vocalPath);
        const accompaniment = this.parseMonoPcm16Wav(accompanimentPath);
        if (vocal.sampleRate !== accompaniment.sampleRate) {
            throw new Error(`Sample rate mismatch for de-bleed: vocal=${vocal.sampleRate}, accompaniment=${accompaniment.sampleRate}`);
        }

        const n = Math.min(vocal.samples.length, accompaniment.samples.length);
        if (n < 1024) {
            fs.copyFileSync(vocalPath, outputPath);
            return {
                avgCorrelation: 0,
                avgAbsLeakGain: 0,
                maxAbsLeakGain: 0,
                frameCount: 0,
            };
        }

        const sampleRate = vocal.sampleRate;
        const frameLen = this.clampInt(Math.round(sampleRate * 0.046), 1024, 4096, 2048);
        const hop = this.clampInt(Math.round(frameLen / 4), 256, 2048, 512);
        const half = Math.max(1, Math.floor(frameLen / 2));

        const frameCenters: number[] = [];
        const frameLeakGains: number[] = [];
        let corrSum = 0;
        let gainAbsSum = 0;
        let gainAbsMax = 0;

        for (let center = half; center < n - half; center += hop) {
            const start = center - half;
            const end = Math.min(n, start + frameLen);
            let vv = 0;
            let aa = 0;
            let va = 0;
            let vPeak = 0;
            let aPeak = 0;
            for (let i = start; i < end; i += 1) {
                const v = vocal.samples[i] / INT16_MAX;
                const a = accompaniment.samples[i] / INT16_MAX;
                vv += v * v;
                aa += a * a;
                va += v * a;
                const av = Math.abs(v);
                const aaAbs = Math.abs(a);
                if (av > vPeak) vPeak = av;
                if (aaAbs > aPeak) aPeak = aaAbs;
            }
            const len = Math.max(1, end - start);
            const vRms = Math.sqrt(vv / len);
            const aRms = Math.sqrt(aa / len);
            const corr = (vv > 1e-9 && aa > 1e-9) ? Math.abs(va) / Math.sqrt(vv * aa) : 0;
            const beta = aa > 1e-9 ? (va / aa) : 0;
            const vocalDominance = vRms / (aRms + 1e-9);
            const gateCorr = this.smoothstep(corr, 0.08, 0.85);
            const gateEnergy = this.smoothstep(aRms, 0.01, 0.18);
            const preserveVocal = 1 - this.smoothstep(vocalDominance, 1.6, 4.0);
            const peakGuard = 1 - this.smoothstep(vPeak, 0.78, 0.98) * 0.35;

            let leakGain = beta * gateCorr * gateEnergy * preserveVocal * peakGuard;
            // Clamp to conservative range to avoid eating the lead vocal.
            leakGain = this.clampNumber(leakGain, -0.28, 0.28, 0);
            // When accompaniment is much louder than vocal, permit slightly stronger subtraction.
            if (vocalDominance < 0.75 && corr > 0.18) {
                leakGain = this.clampNumber(leakGain * 1.18, -0.34, 0.34, leakGain);
            }

            frameCenters.push(center);
            frameLeakGains.push(leakGain);
            corrSum += corr;
            gainAbsSum += Math.abs(leakGain);
            if (Math.abs(leakGain) > gainAbsMax) {
                gainAbsMax = Math.abs(leakGain);
            }
        }

        if (frameCenters.length === 0) {
            fs.copyFileSync(vocalPath, outputPath);
            return {
                avgCorrelation: 0,
                avgAbsLeakGain: 0,
                maxAbsLeakGain: 0,
                frameCount: 0,
            };
        }

        // Smooth frame gains to reduce pumping / zipper noise.
        const smoothedGains = new Float32Array(frameLeakGains.length);
        for (let i = 0; i < frameLeakGains.length; i += 1) {
            const a = frameLeakGains[Math.max(0, i - 1)];
            const b = frameLeakGains[i];
            const c = frameLeakGains[Math.min(frameLeakGains.length - 1, i + 1)];
            smoothedGains[i] = (a * 0.2) + (b * 0.6) + (c * 0.2);
        }

        const outputSamples = new Int16Array(vocal.samples.length);
        // Copy untouched tail if accompaniment is shorter.
        for (let i = n; i < vocal.samples.length; i += 1) {
            outputSamples[i] = vocal.samples[i];
        }

        let frameIndex = 0;
        for (let i = 0; i < n; i += 1) {
            while (frameIndex + 1 < frameCenters.length && i > frameCenters[frameIndex + 1]) {
                frameIndex += 1;
            }

            let gain = smoothedGains[frameIndex];
            if (frameIndex + 1 < frameCenters.length) {
                const c0 = frameCenters[frameIndex];
                const c1 = frameCenters[frameIndex + 1];
                const t = c1 > c0 ? (i - c0) / (c1 - c0) : 0;
                gain = (smoothedGains[frameIndex] * (1 - t)) + (smoothedGains[frameIndex + 1] * t);
            }

            const v = vocal.samples[i] / INT16_MAX;
            const a = accompaniment.samples[i] / INT16_MAX;
            let y = v - (gain * a);

            // Gentle expansion in low-energy sections to suppress residual accompaniment bed.
            const absY = Math.abs(y);
            if (absY < 0.05) {
                const g = this.clampNumber(0.88 + (absY / 0.05) * 0.12, 0.86, 1, 1);
                y *= g;
            }

            // Soft clipping to avoid sharp peaks after subtraction.
            y = Math.tanh(y * 1.12) / Math.tanh(1.12);
            outputSamples[i] = this.clampInt16(Math.round(y * INT16_MAX));
        }

        this.writeMonoPcm16Wav(outputPath, sampleRate, outputSamples);
        return {
            avgCorrelation: this.roundNumber(corrSum / frameCenters.length, 4),
            avgAbsLeakGain: this.roundNumber(gainAbsSum / frameCenters.length, 4),
            maxAbsLeakGain: this.roundNumber(gainAbsMax, 4),
            frameCount: frameCenters.length,
        };
    }

    static removeMusicOnlySectionsWithReferenceMonoPcm16Wav(
        vocalPath: string,
        accompanimentPath: string,
        outputPath: string,
    ): SeparationMusicOnlyRemovalSummary {
        const vocal = this.parseMonoPcm16Wav(vocalPath);
        const accompaniment = this.parseMonoPcm16Wav(accompanimentPath);
        if (vocal.sampleRate !== accompaniment.sampleRate) {
            throw new Error(`Sample rate mismatch for music-only removal: vocal=${vocal.sampleRate}, accompaniment=${accompaniment.sampleRate}`);
        }

        const n = Math.min(vocal.samples.length, accompaniment.samples.length);
        if (n < 2048) {
            fs.copyFileSync(vocalPath, outputPath);
            return {
                frameCount: 0,
                keepFrames: 0,
                removedSegments: 0,
                removedDurationMs: 0,
                zeroedShortGapDurationMs: 0,
                outputDurationMs: vocal.durationMs,
                avgDominance: 0,
                avgCorrelation: 0,
                lowLeakFrames: 0,
            };
        }

        const sr = vocal.sampleRate;
        const frameLen = this.clampInt(Math.round(sr * 0.024), 512, 4096, 1024);
        const hop = this.clampInt(Math.round(sr * 0.010), 256, frameLen, 441);
        const frameCount = Math.max(1, Math.floor((n - frameLen) / hop) + 1);
        const frameStart = new Int32Array(frameCount);
        const frameEnd = new Int32Array(frameCount);
        const vRmsList = new Float32Array(frameCount);
        const aRmsList = new Float32Array(frameCount);
        const corrList = new Float32Array(frameCount);
        const zcrList = new Float32Array(frameCount);
        const domList = new Float32Array(frameCount);
        const lowLeakList = new Float32Array(frameCount);
        const lowAlpha = 1 - Math.exp((-2 * Math.PI * 180) / sr);
        let domSum = 0;
        let corrSum = 0;
        let lowLeakFrames = 0;

        for (let fi = 0; fi < frameCount; fi += 1) {
            const start = fi * hop;
            const end = Math.min(n, start + frameLen);
            frameStart[fi] = start;
            frameEnd[fi] = end;
            let vv = 0;
            let aa = 0;
            let va = 0;
            let zc = 0;
            let prevV = vocal.samples[start] / INT16_MAX;
            let lowVState = 0;
            let lowAState = 0;
            let lowVSq = 0;
            let lowASq = 0;
            for (let i = start; i < end; i += 1) {
                const v = vocal.samples[i] / INT16_MAX;
                const a = accompaniment.samples[i] / INT16_MAX;
                vv += v * v;
                aa += a * a;
                va += v * a;
                lowVState += lowAlpha * (v - lowVState);
                lowAState += lowAlpha * (a - lowAState);
                lowVSq += lowVState * lowVState;
                lowASq += lowAState * lowAState;
                if (i > start && ((v >= 0 && prevV < 0) || (v < 0 && prevV >= 0))) {
                    zc += 1;
                }
                prevV = v;
            }
            const len = Math.max(1, end - start);
            const vRms = Math.sqrt(vv / len);
            const aRms = Math.sqrt(aa / len);
            const corr = (vv > 1e-12 && aa > 1e-12) ? Math.abs(va) / Math.sqrt(vv * aa) : 0;
            const zcr = len > 1 ? zc / (len - 1) : 0;
            const dominance = vRms / (aRms + 1e-9);
            const lowVRms = Math.sqrt(lowVSq / len);
            const lowARms = Math.sqrt(lowASq / len);
            const lowLeak = lowVRms / (lowARms + 1e-9);

            vRmsList[fi] = vRms;
            aRmsList[fi] = aRms;
            corrList[fi] = corr;
            zcrList[fi] = zcr;
            domList[fi] = dominance;
            lowLeakList[fi] = lowLeak;
            domSum += dominance;
            corrSum += corr;
            if (lowLeak < 0.85 && lowARms > 0.01) lowLeakFrames += 1;
        }

        const sortedVRms = Array.from(vRmsList).sort((a, b) => a - b);
        const sortedARms = Array.from(aRmsList).sort((a, b) => a - b);
        const noiseFloor = sortedVRms[Math.floor((sortedVRms.length - 1) * 0.22)] || 0;
        const accFloor = sortedARms[Math.floor((sortedARms.length - 1) * 0.22)] || 0;
        const voiceThreshold = Math.max(0.0045, noiseFloor * 1.9);
        const accThreshold = Math.max(0.0060, accFloor * 1.8);

        const rawKeep = new Uint8Array(frameCount);
        for (let fi = 0; fi < frameCount; fi += 1) {
            const vRms = vRmsList[fi];
            const aRms = aRmsList[fi];
            const corr = corrList[fi];
            const zcr = zcrList[fi];
            const dominance = domList[fi];
            const lowLeak = lowLeakList[fi];

            const vocalEnergyOk = vRms >= voiceThreshold;
            const voiceLike = vocalEnergyOk && (
                dominance >= 0.78
                || (corr <= 0.28 && zcr >= 0.005 && zcr <= 0.36)
                || (dominance >= 0.60 && vRms >= voiceThreshold * 1.35)
            );

            const bgmStrong = aRms >= accThreshold;
            const lowBassBleedHeavy = lowLeak < 0.70 && aRms >= accThreshold * 0.9;
            const bgmOnly = bgmStrong && !voiceLike && (
                dominance < 0.62
                || (corr > 0.18 && dominance < 0.85)
                || (lowBassBleedHeavy && zcr < 0.04)
            );

            rawKeep[fi] = bgmOnly ? 0 : 1;
        }

        // Fill short holes to avoid choppy cuts around weak consonants / breaths.
        const keepMask = new Uint8Array(rawKeep);
        const fillGapFrames = Math.max(3, Math.round(0.12 / (hop / sr))); // ~120ms
        const minKeepFrames = Math.max(4, Math.round(0.08 / (hop / sr))); // ~80ms
        let i = 0;
        while (i < frameCount) {
            const state = keepMask[i];
            let j = i + 1;
            while (j < frameCount && keepMask[j] === state) j += 1;
            const len = j - i;
            if (state === 0) {
                const leftKeep = i > 0 && keepMask[i - 1] === 1;
                const rightKeep = j < frameCount && keepMask[j] === 1;
                if (leftKeep && rightKeep && len <= fillGapFrames) {
                    for (let k = i; k < j; k += 1) keepMask[k] = 1;
                }
            } else if (len < minKeepFrames) {
                // Remove tiny isolated keep islands if they are likely bleed bursts.
                const avgDom = this.averageRange(domList, i, j);
                const avgCorr = this.averageRange(corrList, i, j);
                if (avgDom < 0.72 && avgCorr > 0.20) {
                    for (let k = i; k < j; k += 1) keepMask[k] = 0;
                }
            }
            i = j;
        }

        const keepDiff = new Int16Array(n + 1);
        let keepFrames = 0;
        for (let fi = 0; fi < frameCount; fi += 1) {
            if (keepMask[fi] !== 1) continue;
            keepFrames += 1;
            keepDiff[frameStart[fi]] += 1;
            keepDiff[frameEnd[fi]] -= 1;
        }

        const sampleKeep = new Uint8Array(n);
        let acc = 0;
        for (let s = 0; s < n; s += 1) {
            acc += keepDiff[s];
            sampleKeep[s] = acc > 0 ? 1 : 0;
        }

        const minRemoveSamples = Math.max(1, Math.round(sr * 0.24));
        const fadeSamples = Math.max(1, Math.round(sr * 0.008));
        const includedSegments: Array<{ start: number; end: number; zero: boolean }> = [];
        let removedSegments = 0;
        let removedSamples = 0;
        let zeroedShortGapSamples = 0;

        let segStart = 0;
        let segState = sampleKeep[0] === 1;
        for (let s = 1; s <= n; s += 1) {
            const curState = s < n ? sampleKeep[s] === 1 : !segState;
            if (s < n && curState === segState) continue;
            const len = s - segStart;
            if (segState) {
                includedSegments.push({ start: segStart, end: s, zero: false });
            } else if (len < minRemoveSamples) {
                includedSegments.push({ start: segStart, end: s, zero: true });
                zeroedShortGapSamples += len;
            } else {
                removedSegments += 1;
                removedSamples += len;
            }
            segStart = s;
            segState = curState;
        }

        if (includedSegments.length === 0) {
            fs.copyFileSync(vocalPath, outputPath);
            return {
                frameCount,
                keepFrames,
                removedSegments,
                removedDurationMs: Math.round((removedSamples / sr) * 1000),
                zeroedShortGapDurationMs: Math.round((zeroedShortGapSamples / sr) * 1000),
                outputDurationMs: vocal.durationMs,
                avgDominance: this.roundNumber(domSum / Math.max(1, frameCount), 4),
                avgCorrelation: this.roundNumber(corrSum / Math.max(1, frameCount), 4),
                lowLeakFrames,
            };
        }

        let totalOutLen = 0;
        for (const seg of includedSegments) totalOutLen += Math.max(0, seg.end - seg.start);
        const out = new Int16Array(Math.max(1, totalOutLen));
        let outPos = 0;

        for (let si = 0; si < includedSegments.length; si += 1) {
            const seg = includedSegments[si];
            const len = Math.max(0, seg.end - seg.start);
            if (len <= 0) continue;
            for (let i2 = 0; i2 < len; i2 += 1) {
                out[outPos + i2] = seg.zero ? 0 : vocal.samples[seg.start + i2];
            }
            if (!seg.zero) {
                const fade = Math.min(fadeSamples, len);
                for (let f = 0; f < fade; f += 1) {
                    const fadeIn = f / Math.max(1, fade - 1);
                    const fadeOut = (fade - 1 - f) / Math.max(1, fade - 1);
                    if (si > 0) {
                        const idx = outPos + f;
                        out[idx] = this.clampInt16(Math.round(out[idx] * fadeIn));
                    }
                    if (si < includedSegments.length - 1) {
                        const idx = outPos + len - 1 - f;
                        out[idx] = this.clampInt16(Math.round(out[idx] * fadeOut));
                    }
                }
            }
            outPos += len;
        }

        const finalOut = outPos === out.length ? out : out.slice(0, outPos);
        this.writeMonoPcm16Wav(outputPath, sr, finalOut);

        return {
            frameCount,
            keepFrames,
            removedSegments,
            removedDurationMs: Math.round((removedSamples / sr) * 1000),
            zeroedShortGapDurationMs: Math.round((zeroedShortGapSamples / sr) * 1000),
            outputDurationMs: Math.round((finalOut.length / sr) * 1000),
            avgDominance: this.roundNumber(domSum / Math.max(1, frameCount), 4),
            avgCorrelation: this.roundNumber(corrSum / Math.max(1, frameCount), 4),
            lowLeakFrames,
        };
    }

    static mergeVocalCandidatesWithReferenceMonoPcm16Wav(
        primaryVocalPath: string,
        secondaryVocalPath: string,
        outputPath: string,
        primaryAccompanimentPath?: string,
        secondaryAccompanimentPath?: string,
    ): SeparationVocalEnsembleSummary {
        const p = this.parseMonoPcm16Wav(primaryVocalPath);
        const s = this.parseMonoPcm16Wav(secondaryVocalPath);
        if (p.sampleRate !== s.sampleRate) {
            throw new Error(`Sample rate mismatch for ensemble: primary=${p.sampleRate}, secondary=${s.sampleRate}`);
        }
        const pa = primaryAccompanimentPath ? this.parseMonoPcm16Wav(primaryAccompanimentPath) : undefined;
        const sa = secondaryAccompanimentPath ? this.parseMonoPcm16Wav(secondaryAccompanimentPath) : undefined;
        if (pa && pa.sampleRate !== p.sampleRate) {
            throw new Error(`Sample rate mismatch for primary accompaniment: ${pa.sampleRate} vs ${p.sampleRate}`);
        }
        if (sa && sa.sampleRate !== p.sampleRate) {
            throw new Error(`Sample rate mismatch for secondary accompaniment: ${sa.sampleRate} vs ${p.sampleRate}`);
        }

        const n = Math.min(
            p.samples.length,
            s.samples.length,
            pa ? pa.samples.length : Number.MAX_SAFE_INTEGER,
            sa ? sa.samples.length : Number.MAX_SAFE_INTEGER,
        );
        if (n < 2048) {
            fs.copyFileSync(primaryVocalPath, outputPath);
            return {
                frameCount: 0,
                avgInterCandidateCorrelation: 0,
                avgPrimaryWeight: 1,
                avgSecondaryWeight: 0,
                bgmSuppressedFrames: 0,
                outputDurationMs: p.durationMs,
            };
        }

        const sr = p.sampleRate;
        const frameLen = this.clampInt(Math.round(sr * 0.032), 1024, 4096, 2048);
        const hop = this.clampInt(Math.round(sr * 0.012), 256, frameLen, 512);
        const frameCount = Math.max(1, Math.floor((n - frameLen) / hop) + 1);
        const centers = new Int32Array(frameCount);
        const w1Frames = new Float32Array(frameCount);
        const suppressFrames = new Float32Array(frameCount);
        const corr12Frames = new Float32Array(frameCount);
        const lowAlpha = 1 - Math.exp((-2 * Math.PI * 180) / sr);
        let corr12Sum = 0;
        let w1Sum = 0;
        let suppressedCount = 0;

        for (let fi = 0; fi < frameCount; fi += 1) {
            const start = fi * hop;
            const end = Math.min(n, start + frameLen);
            const center = Math.min(n - 1, start + Math.floor((end - start) / 2));
            centers[fi] = center;

            let pSq = 0;
            let sSq = 0;
            let ps = 0;
            let pz = 0;
            let sz = 0;
            let prevP = p.samples[start] / INT16_MAX;
            let prevS = s.samples[start] / INT16_MAX;
            let pLowState = 0;
            let sLowState = 0;
            let pLowSq = 0;
            let sLowSq = 0;
            let paSq = 0;
            let saSq = 0;
            let pPa = 0;
            let sSa = 0;
            let paLowState = 0;
            let saLowState = 0;
            let paLowSq = 0;
            let saLowSq = 0;

            for (let i = start; i < end; i += 1) {
                const pv = p.samples[i] / INT16_MAX;
                const sv = s.samples[i] / INT16_MAX;
                pSq += pv * pv;
                sSq += sv * sv;
                ps += pv * sv;
                pLowState += lowAlpha * (pv - pLowState);
                sLowState += lowAlpha * (sv - sLowState);
                pLowSq += pLowState * pLowState;
                sLowSq += sLowState * sLowState;
                if (i > start && ((pv >= 0 && prevP < 0) || (pv < 0 && prevP >= 0))) pz += 1;
                if (i > start && ((sv >= 0 && prevS < 0) || (sv < 0 && prevS >= 0))) sz += 1;
                prevP = pv;
                prevS = sv;

                if (pa && i < pa.samples.length) {
                    const pav = pa.samples[i] / INT16_MAX;
                    paSq += pav * pav;
                    pPa += pv * pav;
                    paLowState += lowAlpha * (pav - paLowState);
                    paLowSq += paLowState * paLowState;
                }
                if (sa && i < sa.samples.length) {
                    const sav = sa.samples[i] / INT16_MAX;
                    saSq += sav * sav;
                    sSa += sv * sav;
                    saLowState += lowAlpha * (sav - saLowState);
                    saLowSq += saLowState * saLowState;
                }
            }

            const len = Math.max(1, end - start);
            const pRms = Math.sqrt(pSq / len);
            const sRms = Math.sqrt(sSq / len);
            const pLowRms = Math.sqrt(pLowSq / len);
            const sLowRms = Math.sqrt(sLowSq / len);
            const corr12 = (pSq > 1e-12 && sSq > 1e-12) ? Math.abs(ps) / Math.sqrt(pSq * sSq) : 0;
            const pZcr = len > 1 ? pz / (len - 1) : 0;
            const sZcr = len > 1 ? sz / (len - 1) : 0;
            corr12Frames[fi] = corr12;
            corr12Sum += corr12;

            const paRms = pa ? Math.sqrt(paSq / len) : 0;
            const saRms = sa ? Math.sqrt(saSq / len) : 0;
            const paLowRms = pa ? Math.sqrt(paLowSq / len) : 0;
            const saLowRms = sa ? Math.sqrt(saLowSq / len) : 0;
            const pLeakCorr = pa && pSq > 1e-12 && paSq > 1e-12 ? Math.abs(pPa) / Math.sqrt(pSq * paSq) : 0;
            const sLeakCorr = sa && sSq > 1e-12 && saSq > 1e-12 ? Math.abs(sSa) / Math.sqrt(sSq * saSq) : 0;
            const pDom = pRms / (paRms + 1e-9);
            const sDom = sRms / (saRms + 1e-9);
            const pLowDom = pLowRms / (paLowRms + 1e-9);
            const sLowDom = sLowRms / (saLowRms + 1e-9);

            const pVoiceLike = (pRms > 0.0045) && (pZcr >= 0.005 && pZcr <= 0.40);
            const sVoiceLike = (sRms > 0.0045) && (sZcr >= 0.005 && sZcr <= 0.40);

            const pScore = (
                Math.min(3, Math.log10(1 + (pRms * 120))) * 1.6
                + Math.min(2.4, pDom) * 0.65
                + Math.min(2.0, pLowDom) * 0.35
                + (pVoiceLike ? 0.25 : -0.15)
                - Math.max(0, pLeakCorr - 0.12) * 1.8
            );
            const sScore = (
                Math.min(3, Math.log10(1 + (sRms * 120))) * 1.6
                + Math.min(2.4, sDom) * 0.65
                + Math.min(2.0, sLowDom) * 0.35
                + (sVoiceLike ? 0.25 : -0.15)
                - Math.max(0, sLeakCorr - 0.12) * 1.8
            );

            const delta = pScore - sScore;
            const selectivity = corr12 >= 0.86 ? 0.45 : (corr12 >= 0.65 ? 0.75 : 1.1);
            let w1 = this.sigmoid(delta * selectivity);
            if (corr12 >= 0.92) {
                w1 = this.clampNumber(0.5 + (delta * 0.10), 0.20, 0.80, 0.5);
            } else {
                w1 = this.clampNumber(w1, 0.12, 0.88, 0.5);
            }

            const accStrong = Math.max(paRms, saRms) > 0.010;
            const bothWeakDom = (pDom < 0.70 && sDom < 0.70) || (pLowDom < 0.72 && sLowDom < 0.72);
            const bothNotVoiceLike = !pVoiceLike && !sVoiceLike;
            const likelyMusicOnly = accStrong && (bothWeakDom || bothNotVoiceLike) && corr12 < 0.80;
            let suppress = 1;
            if (likelyMusicOnly) {
                const domMax = Math.max(pDom, sDom, pLowDom, sLowDom);
                const strength = this.clampNumber((0.85 - domMax) * 1.4 + Math.max(0, 0.22 - Math.min(pZcr, sZcr)) * 2.5, 0, 1, 0);
                suppress = this.clampNumber(1 - (0.65 * strength), 0.22, 1, 1);
                if (suppress < 0.98) {
                    suppressedCount += 1;
                }
            }

            w1Frames[fi] = w1;
            suppressFrames[fi] = suppress;
            w1Sum += w1;
        }

        // Smooth weights and suppression factors to avoid zipper noise.
        const smoothWeights = new Float32Array(frameCount);
        const smoothSuppress = new Float32Array(frameCount);
        for (let i = 0; i < frameCount; i += 1) {
            const p0 = Math.max(0, i - 1);
            const p1 = i;
            const p2 = Math.min(frameCount - 1, i + 1);
            smoothWeights[i] = (w1Frames[p0] * 0.2) + (w1Frames[p1] * 0.6) + (w1Frames[p2] * 0.2);
            smoothSuppress[i] = (suppressFrames[p0] * 0.2) + (suppressFrames[p1] * 0.6) + (suppressFrames[p2] * 0.2);
        }

        const out = new Int16Array(p.samples.length);
        for (let i = n; i < p.samples.length; i += 1) {
            out[i] = p.samples[i];
        }

        let frameIdx = 0;
        for (let i = 0; i < n; i += 1) {
            while (frameIdx + 1 < frameCount && i > centers[frameIdx + 1]) {
                frameIdx += 1;
            }
            let w1 = smoothWeights[frameIdx];
            let suppress = smoothSuppress[frameIdx];
            let corr12 = corr12Frames[frameIdx];
            if (frameIdx + 1 < frameCount) {
                const c0 = centers[frameIdx];
                const c1 = centers[frameIdx + 1];
                const t = c1 > c0 ? (i - c0) / (c1 - c0) : 0;
                w1 = (smoothWeights[frameIdx] * (1 - t)) + (smoothWeights[frameIdx + 1] * t);
                suppress = (smoothSuppress[frameIdx] * (1 - t)) + (smoothSuppress[frameIdx + 1] * t);
                corr12 = (corr12Frames[frameIdx] * (1 - t)) + (corr12Frames[frameIdx + 1] * t);
            }

            const pv = p.samples[i] / INT16_MAX;
            const sv = s.samples[i] / INT16_MAX;
            const mix = (pv * w1) + (sv * (1 - w1));
            const consensus = Math.sign(mix || (pv + sv)) * Math.min(Math.abs(pv), Math.abs(sv));
            const consensusBlend = this.clampNumber(0.18 + Math.max(0, corr12 - 0.55) * 0.35, 0.12, 0.42, 0.2);
            let y = (mix * (1 - consensusBlend)) + (consensus * consensusBlend);
            y *= suppress;
            y = Math.tanh(y * 1.08) / Math.tanh(1.08);
            out[i] = this.clampInt16(Math.round(y * INT16_MAX));
        }

        this.writeMonoPcm16Wav(outputPath, sr, out);
        const avgW1 = w1Sum / Math.max(1, frameCount);
        return {
            frameCount,
            avgInterCandidateCorrelation: this.roundNumber(corr12Sum / Math.max(1, frameCount), 4),
            avgPrimaryWeight: this.roundNumber(avgW1, 4),
            avgSecondaryWeight: this.roundNumber(1 - avgW1, 4),
            bgmSuppressedFrames: suppressedCount,
            outputDurationMs: Math.round((out.length / sr) * 1000),
        };
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

    private static writeMonoPcm16Wav(filePath: string, sampleRate: number, samples: Int16Array): void {
        const dataLength = samples.length * 2;
        const buffer = Buffer.alloc(44 + dataLength);
        buffer.write('RIFF', 0, 4, 'ascii');
        buffer.writeUInt32LE(36 + dataLength, 4);
        buffer.write('WAVE', 8, 4, 'ascii');
        buffer.write('fmt ', 12, 4, 'ascii');
        buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
        buffer.writeUInt16LE(1, 20); // PCM
        buffer.writeUInt16LE(1, 22); // mono
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
        buffer.writeUInt16LE(2, 32); // block align
        buffer.writeUInt16LE(16, 34); // bits/sample
        buffer.write('data', 36, 4, 'ascii');
        buffer.writeUInt32LE(dataLength, 40);
        let offset = 44;
        for (let i = 0; i < samples.length; i += 1) {
            buffer.writeInt16LE(samples[i], offset);
            offset += 2;
        }
        fs.writeFileSync(filePath, buffer);
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

    private static averageRange(values: ArrayLike<number>, start: number, end: number): number {
        if (end <= start) return 0;
        let sum = 0;
        let count = 0;
        for (let i = start; i < end; i += 1) {
            sum += Number(values[i] || 0);
            count += 1;
        }
        return count > 0 ? (sum / count) : 0;
    }

    private static clampInt(value: number, min: number, max: number, fallback: number): number {
        if (!Number.isFinite(value)) return fallback;
        const rounded = Math.round(value);
        if (rounded < min) return min;
        if (rounded > max) return max;
        return rounded;
    }

    private static clampInt16(value: number): number {
        if (!Number.isFinite(value)) return 0;
        if (value < -32768) return -32768;
        if (value > 32767) return 32767;
        return Math.round(value);
    }

    private static smoothstep(value: number, edge0: number, edge1: number): number {
        if (!Number.isFinite(value)) return 0;
        if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
        const t = this.clampNumber((value - edge0) / (edge1 - edge0), 0, 1, 0);
        return t * t * (3 - (2 * t));
    }

    private static sigmoid(value: number): number {
        if (!Number.isFinite(value)) return 0.5;
        if (value >= 12) return 0.999994;
        if (value <= -12) return 0.000006;
        return 1 / (1 + Math.exp(-value));
    }

    private static clampNumber(value: number, min: number, max: number, fallback: number): number {
        if (!Number.isFinite(value)) return fallback;
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }
}
