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
    avgAbsHighLeakGain: number;
    maxAbsHighLeakGain: number;
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

export interface SeparationMixtureReprojectionSummary {
    frameCount: number;
    estimatedLagSamples: number;
    estimatedLagMs: number;
    avgVocalGain: number;
    avgAccompanimentGain: number;
    avgVocalResidualWeight: number;
    avgReconErrorBefore: number;
    avgReconErrorAfter: number;
    bgmOnlySuppressedFrames: number;
    lowBleedGuardFrames: number;
    outputDurationMs: number;
}

export interface SeparationSubbandReprojectionSummary {
    frameCount: number;
    estimatedLagSamples: number;
    estimatedLagMs: number;
    avgSubLowMask: number;
    avgLowMask: number;
    avgMidMask: number;
    avgHighMask: number;
    avgHighMaskDelta: number;
    maxHighMaskDelta: number;
    highMaskDeltaLimitedFrames: number;
    avgHighSmoothBlend: number;
    highStrongSmoothFrames: number;
    avgProtectBlend: number;
    avgHighProtectBoost: number;
    highProtectBoostRatio: number;
    avgVibratoProxy: number;
    vibratoGuardFrames: number;
    bgmOnlySuppressedFrames: number;
    lowBgmPriorityFrames: number;
    lowBleedGuardFrames: number;
    outputDurationMs: number;
}

export interface SeparationMixtureConsistencyEstimate {
    lagSamples: number;
    lagMs: number;
    normalizedError: number;
    lowBandResidualRatio: number;
    sumCorrelation: number;
}

export interface SeparationHighBandSmoothingSummary {
    sampleRate: number;
    durationMs: number;
    avgAmount: number;
    maxAmount: number;
    highRmsBefore: number;
    highRmsAfter: number;
    roughnessBefore: number;
    roughnessAfter: number;
}

export interface SeparationAdaptiveFilterTuningHints {
    highBandRoughness?: number;
    leakageCorrelation?: number;
    lowBandLeakageCorrelation?: number;
}

export interface SeparationPerceptualQualityMetrics {
    reverbTailRatio: number;
    highBandRoughness: number;
    highBandFluxVariance: number;
    artifactScore: number;
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

    static estimateLowBandLeakageCorrelation(
        vocalPath: string,
        accompanimentPath: string,
        cutoffHz: number = 180,
    ): number {
        const vocal = this.parseMonoPcm16Wav(vocalPath);
        const accompaniment = this.parseMonoPcm16Wav(accompanimentPath);
        const n = Math.min(vocal.samples.length, accompaniment.samples.length);
        if (n < 1024) {
            return 0;
        }

        const vocalLp = new BiquadFilter(this.createLowPass(vocal.sampleRate, cutoffHz));
        const accLp = new BiquadFilter(this.createLowPass(accompaniment.sampleRate, cutoffHz));
        const stride = Math.max(1, Math.floor(n / 220000));
        const xs: number[] = [];
        const ys: number[] = [];
        for (let i = 0; i < n; i += 1) {
            const x = vocalLp.process(vocal.samples[i] / INT16_MAX);
            const y = accLp.process(accompaniment.samples[i] / INT16_MAX);
            if (i % stride === 0) {
                xs.push(x);
                ys.push(y);
            }
        }
        if (xs.length <= 1) {
            return 0;
        }

        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < xs.length; i += 1) {
            sumX += xs[i];
            sumY += ys[i];
        }
        const meanX = sumX / xs.length;
        const meanY = sumY / ys.length;
        let cov = 0;
        let varX = 0;
        let varY = 0;
        for (let i = 0; i < xs.length; i += 1) {
            const x = xs[i] - meanX;
            const y = ys[i] - meanY;
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

    static estimateMixtureConsistencyMonoPcm16Wav(
        mixturePath: string,
        vocalPath: string,
        accompanimentPath: string,
    ): SeparationMixtureConsistencyEstimate {
        const mix = this.parseMonoPcm16Wav(mixturePath);
        const vocal = this.parseMonoPcm16Wav(vocalPath);
        const accompaniment = this.parseMonoPcm16Wav(accompanimentPath);
        if (mix.sampleRate !== vocal.sampleRate || mix.sampleRate !== accompaniment.sampleRate) {
            throw new Error(`Sample rate mismatch for mixture consistency: mix=${mix.sampleRate}, vocal=${vocal.sampleRate}, accompaniment=${accompaniment.sampleRate}`);
        }

        const maxLag = this.clampInt(Math.round(mix.sampleRate * 0.12), 256, 8192, 4096);
        const lagSamples = this.estimateMixtureLagSamples(mix.samples, vocal.samples, accompaniment.samples, maxLag);
        const mixStart = lagSamples < 0 ? -lagSamples : 0;
        const stemStart = lagSamples > 0 ? lagSamples : 0;
        const n = Math.min(
            mix.samples.length - mixStart,
            vocal.samples.length - stemStart,
            accompaniment.samples.length - stemStart,
        );
        if (n < 2048) {
            return {
                lagSamples,
                lagMs: this.roundNumber((lagSamples / mix.sampleRate) * 1000, 2),
                normalizedError: 1,
                lowBandResidualRatio: 1,
                sumCorrelation: 0,
            };
        }

        const sampleCap = Math.min(n, mix.sampleRate * 180); // cap at ~3 min for analysis cost
        const analysisStart = Math.max(0, Math.floor((n - sampleCap) / 2));
        const stride = Math.max(1, Math.floor(sampleCap / 220000));
        const alpha = 1 - Math.exp((-2 * Math.PI * 180) / mix.sampleRate);
        const alphaStep = 1 - Math.pow(1 - alpha, stride);
        let xSq = 0;
        let ySq = 0;
        let eSq = 0;
        let xy = 0;
        let lowX = 0;
        let lowE = 0;
        let lowXSq = 0;
        let lowESq = 0;
        let count = 0;
        for (let j = analysisStart; j < analysisStart + sampleCap; j += stride) {
            const mi = mixStart + j;
            const si = stemStart + j;
            const x = mix.samples[mi] / INT16_MAX;
            const y = (vocal.samples[si] + accompaniment.samples[si]) / INT16_MAX;
            const e = x - y;
            xSq += x * x;
            ySq += y * y;
            eSq += e * e;
            xy += x * y;

            lowX += alphaStep * (x - lowX);
            lowE += alphaStep * (e - lowE);
            lowXSq += lowX * lowX;
            lowESq += lowE * lowE;
            count += 1;
        }

        if (count < 64 || xSq <= 1e-10) {
            return {
                lagSamples,
                lagMs: this.roundNumber((lagSamples / mix.sampleRate) * 1000, 2),
                normalizedError: 1,
                lowBandResidualRatio: 1,
                sumCorrelation: 0,
            };
        }

        const rmsX = Math.sqrt(xSq / count);
        const rmsE = Math.sqrt(eSq / count);
        const lowRmsX = Math.sqrt(lowXSq / Math.max(1, count));
        const lowRmsE = Math.sqrt(lowESq / Math.max(1, count));
        const corr = (xSq > 1e-10 && ySq > 1e-10) ? (xy / Math.sqrt(xSq * ySq)) : 0;
        return {
            lagSamples,
            lagMs: this.roundNumber((lagSamples / mix.sampleRate) * 1000, 2),
            normalizedError: this.roundNumber(rmsE / Math.max(1e-8, rmsX), 5),
            lowBandResidualRatio: this.roundNumber(lowRmsE / Math.max(1e-8, lowRmsX), 5),
            sumCorrelation: this.roundNumber(Math.abs(corr), 5),
        };
    }

    static smoothHarshHighBandMonoPcm16Wav(
        inputPath: string,
        outputPath: string,
    ): SeparationHighBandSmoothingSummary {
        const parsed = this.parseMonoPcm16Wav(inputPath);
        const n = parsed.samples.length;
        if (n < 2048) {
            fs.copyFileSync(inputPath, outputPath);
            return {
                sampleRate: parsed.sampleRate,
                durationMs: parsed.durationMs,
                avgAmount: 0,
                maxAmount: 0,
                highRmsBefore: 0,
                highRmsAfter: 0,
                roughnessBefore: 0,
                roughnessAfter: 0,
            };
        }

        const sr = parsed.sampleRate;
        const hpIn = new BiquadFilter(this.createHighPass(sr, 5200));
        const hpOut = new BiquadFilter(this.createHighPass(sr, 5200));
        const smoothCutoffHz = this.clampNumber(sr * 0.13, 4200, 9000, 6500);
        const smoothAlpha = 1 - Math.exp((-2 * Math.PI * smoothCutoffHz) / sr);
        const envAttack = 1 - Math.exp((-2 * Math.PI * 220) / sr);
        const envRelease = 1 - Math.exp((-2 * Math.PI * 18) / sr);
        const slewAttack = 1 - Math.exp((-2 * Math.PI * 420) / sr);
        const slewRelease = 1 - Math.exp((-2 * Math.PI * 30) / sr);

        let smoothedHigh = 0;
        let envHigh = 0;
        let envFull = 0;
        let envSlew = 0;
        let prevHighIn = 0;
        let prevHighOut = 0;
        let amountSum = 0;
        let amountMax = 0;
        let highSqBefore = 0;
        let highSqAfter = 0;
        let roughBeforeSum = 0;
        let roughAfterSum = 0;
        const out = new Int16Array(n);

        for (let i = 0; i < n; i += 1) {
            const x = parsed.samples[i] / INT16_MAX;
            const highIn = hpIn.process(x);
            const absHigh = Math.abs(highIn);
            const absFull = Math.abs(x);
            envHigh += (absHigh - envHigh) * (absHigh > envHigh ? envAttack : envRelease);
            envFull += (absFull - envFull) * (absFull > envFull ? envAttack : envRelease);
            const slew = Math.abs(highIn - prevHighIn);
            envSlew += (slew - envSlew) * (slew > envSlew ? slewAttack : slewRelease);

            const highRatio = envHigh / (envFull + 1e-7);
            const ratioGate = this.smoothstep(highRatio, 0.24, 0.78);
            const slewGate = this.smoothstep(envSlew, 0.0025, 0.055);
            const noiseLikeGate = 1 - this.smoothstep(envFull, 0.04, 0.18);
            const peakGuard = 1 - (this.smoothstep(absFull, 0.88, 0.99) * 0.55);
            const baseAmount = (ratioGate * 0.58) + (slewGate * 0.42);
            let amount = baseAmount * (0.68 + (0.32 * noiseLikeGate)) * peakGuard;
            if (envFull < 0.012 && highRatio > 0.40) {
                amount += 0.10;
            }
            const tailArtifactBoost = this.clampNumber(
                this.smoothstep(highRatio, 0.30, 0.70)
                * (1 - this.smoothstep(envFull, 0.035, 0.18))
                * (0.45 + (0.55 * slewGate)),
                0,
                1,
                0,
            );
            if (tailArtifactBoost > 0.04) {
                amount += tailArtifactBoost * 0.16;
            }
            // ガビり検出: 高スルーレート×高域比×中エネルギーの組み合わせ → 強補正
            const garbleGate = this.clampNumber(
                (slewGate * 0.65) + Math.max(0, highRatio - 0.32) * 0.55
                - (envFull > 0.28 ? 0.22 : 0),
                0, 1, 0,
            );
            if (garbleGate > 0.22) {
                amount = this.clampNumber(amount + (garbleGate * 0.22), 0, 0.88, amount);
            }
            amount = this.clampNumber(amount, 0, 0.88, 0);

            smoothedHigh += (highIn - smoothedHigh) * smoothAlpha;
            let y = x + ((smoothedHigh - highIn) * amount);
            // 音割れ検出: 振幅大きい場合はより強いソフトサチュレーション
            const absY = Math.abs(y);
            if (absY > 0.82) {
                y = Math.tanh(y * 1.10) / Math.tanh(1.10);
            } else {
                y = Math.tanh(y * 1.03) / Math.tanh(1.03);
            }

            const highOut = hpOut.process(y);
            highSqBefore += highIn * highIn;
            highSqAfter += highOut * highOut;
            if (i > 0) {
                roughBeforeSum += Math.abs(highIn - prevHighIn);
                roughAfterSum += Math.abs(highOut - prevHighOut);
            }
            prevHighIn = highIn;
            prevHighOut = highOut;
            amountSum += amount;
            if (amount > amountMax) amountMax = amount;
            out[i] = this.clampInt16(Math.round(y * INT16_MAX));
        }

        this.writeMonoPcm16Wav(outputPath, sr, out);
        const denom = Math.max(1, n);
        return {
            sampleRate: sr,
            durationMs: parsed.durationMs,
            avgAmount: this.roundNumber(amountSum / denom, 4),
            maxAmount: this.roundNumber(amountMax, 4),
            highRmsBefore: this.roundNumber(Math.sqrt(highSqBefore / denom), 5),
            highRmsAfter: this.roundNumber(Math.sqrt(highSqAfter / denom), 5),
            roughnessBefore: this.roundNumber(roughBeforeSum / Math.max(1, n - 1), 6),
            roughnessAfter: this.roundNumber(roughAfterSum / Math.max(1, n - 1), 6),
        };
    }

    static estimateHighBandRoughnessMonoPcm16Wav(
        inputPath: string,
    ): number {
        const parsed = this.parseMonoPcm16Wav(inputPath);
        const n = parsed.samples.length;
        if (n < 8) return 0;
        const hp = new BiquadFilter(this.createHighPass(parsed.sampleRate, 5200));
        let prev = 0;
        let rough = 0;
        for (let i = 0; i < n; i += 1) {
            const x = parsed.samples[i] / INT16_MAX;
            const h = hp.process(x);
            if (i > 0) rough += Math.abs(h - prev);
            prev = h;
        }
        return this.roundNumber(rough / Math.max(1, n - 1), 6);
    }

    static estimateHighBandFluxVarianceMonoPcm16Wav(
        inputPath: string,
    ): number {
        const parsed = this.parseMonoPcm16Wav(inputPath);
        const n = parsed.samples.length;
        if (n < 2048) return 0;

        const frameLen = this.clampInt(Math.round(parsed.sampleRate * 0.018), 256, 2048, 1024);
        const hop = this.clampInt(Math.round(frameLen * 0.5), 128, frameLen, 512);
        const hp = new BiquadFilter(this.createHighPass(parsed.sampleRate, 7800));
        const fluxValues: number[] = [];
        let previousLogEnergy = 0;
        let hasPrevious = false;

        for (let start = 0; start + frameLen <= n; start += hop) {
            let highSq = 0;
            let fullSq = 0;
            for (let i = start; i < start + frameLen; i += 1) {
                const x = parsed.samples[i] / INT16_MAX;
                const high = hp.process(x);
                highSq += high * high;
                fullSq += x * x;
            }
            const fullRms = Math.sqrt(fullSq / frameLen);
            const highRms = Math.sqrt(highSq / frameLen);
            if (fullRms < 0.0024 && highRms < 0.00075) {
                continue;
            }
            const logEnergy = Math.log10(highRms + 1e-7);
            if (hasPrevious) {
                const flux = Math.abs(logEnergy - previousLogEnergy);
                const weight = 0.55 + (0.45 * (1 - this.smoothstep(fullRms, 0.20, 0.58)));
                fluxValues.push(flux * weight);
            }
            previousLogEnergy = logEnergy;
            hasPrevious = true;
        }

        if (fluxValues.length <= 1) {
            return 0;
        }

        const mean = fluxValues.reduce((sum, value) => sum + value, 0) / fluxValues.length;
        let variance = 0;
        for (const value of fluxValues) {
            const delta = value - mean;
            variance += delta * delta;
        }
        return this.roundNumber(variance / fluxValues.length, 6);
    }

    static estimateHighBandArtifactMetricsMonoPcm16Wav(
        inputPath: string,
    ): Pick<SeparationPerceptualQualityMetrics, 'highBandRoughness' | 'highBandFluxVariance' | 'artifactScore'> {
        const highBandRoughness = this.estimateHighBandRoughnessMonoPcm16Wav(inputPath);
        const highBandFluxVariance = this.estimateHighBandFluxVarianceMonoPcm16Wav(inputPath);
        const roughnessPressure = this.smoothstep(highBandRoughness, 0.011, 0.030);
        const fluxPressure = this.smoothstep(highBandFluxVariance, 0.00015, 0.0038);
        const artifactScore = this.roundNumber(
            this.clampNumber((roughnessPressure * 0.62) + (fluxPressure * 0.38), 0, 1, 0),
            6,
        );
        return {
            highBandRoughness,
            highBandFluxVariance,
            artifactScore,
        };
    }

    static estimateReverbTailRatioMonoPcm16Wav(
        inputPath: string,
    ): number {
        const parsed = this.parseMonoPcm16Wav(inputPath);
        const n = parsed.samples.length;
        if (n < 4096) return 0;

        const frameLen = this.clampInt(Math.round(parsed.sampleRate * 0.020), 256, 2048, 1024);
        const hop = this.clampInt(Math.round(parsed.sampleRate * 0.010), 128, frameLen, 512);
        const frameRms: number[] = [];

        for (let start = 0; start + frameLen <= n; start += hop) {
            let sumSq = 0;
            for (let i = start; i < start + frameLen; i += 1) {
                const x = parsed.samples[i] / INT16_MAX;
                sumSq += x * x;
            }
            frameRms.push(Math.sqrt(sumSq / frameLen));
        }
        if (frameRms.length < 20) {
            return 0;
        }

        const sortedRms = [...frameRms].sort((a, b) => a - b);
        const floorIndex = this.clampInt(Math.floor(sortedRms.length * 0.22), 0, sortedRms.length - 1, 0);
        const highIndex = this.clampInt(Math.floor(sortedRms.length * 0.78), 0, sortedRms.length - 1, sortedRms.length - 1);
        const noiseFloor = Math.max(0.00045, sortedRms[floorIndex] || 0);
        const activeRef = Math.max(noiseFloor * 4.2, sortedRms[highIndex] * 0.34, 0.0065);

        let weightedSum = 0;
        let weightTotal = 0;
        for (let i = 1; i < frameRms.length - 18; i += 1) {
            const direct = frameRms[i];
            const next = frameRms[i + 1];
            if (direct < activeRef) {
                continue;
            }
            const descent = (direct - next) / Math.max(1e-7, direct);
            if (descent < 0.04) {
                continue;
            }
            const tailEarly = this.averageRange(frameRms, i + 2, i + 7);
            const tailLate = this.averageRange(frameRms, i + 8, i + 17);
            const tailEnergy = (tailEarly * 0.65) + (tailLate * 0.35);
            if (tailEnergy <= noiseFloor * 1.20 || tailEnergy >= direct * 0.82) {
                continue;
            }
            const ratio = this.clampNumber(tailEnergy / Math.max(1e-7, direct), 0, 1, 0);
            const weight = this.clampNumber(
                this.smoothstep(descent, 0.05, 0.36)
                * (0.65 + (0.35 * (1 - this.smoothstep(direct, 0.18, 0.72)))),
                0,
                1,
                0,
            );
            if (weight <= 0.01) {
                continue;
            }
            weightedSum += ratio * weight;
            weightTotal += weight;
        }

        if (weightTotal <= 1e-6) {
            return 0;
        }
        return this.roundNumber(weightedSum / weightTotal, 6);
    }

    static analyzePerceptualQualityMonoPcm16Wav(
        inputPath: string,
    ): SeparationPerceptualQualityMetrics {
        const artifact = this.estimateHighBandArtifactMetricsMonoPcm16Wav(inputPath);
        return {
            reverbTailRatio: this.estimateReverbTailRatioMonoPcm16Wav(inputPath),
            highBandRoughness: artifact.highBandRoughness,
            highBandFluxVariance: artifact.highBandFluxVariance,
            artifactScore: artifact.artifactScore,
        };
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

        if (metrics.lowBandRatio > 0.28) {
            score -= Math.min(6, (metrics.lowBandRatio - 0.28) * 35);
            notes.push('low_bed');
        }
        if (metrics.lowBandRatio > 0.36) {
            score -= Math.min(16, (metrics.lowBandRatio - 0.36) * 90);
            notes.push('low_rumble');
        }
        if (metrics.highBandRatio > 0.58) {
            score -= Math.min(5, (metrics.highBandRatio - 0.58) * 20);
            notes.push('high_residue');
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
            if (leakageCorrelation > 0.10) {
                score -= Math.min(8, (leakageCorrelation - 0.10) * 20);
                notes.push('bleed_residue');
            }
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

    static buildAdaptiveFilterChain(
        metrics: SeparationStemQualityMetrics,
        hints?: SeparationAdaptiveFilterTuningHints,
    ): string {
        const highBandRoughness = Math.max(0, hints?.highBandRoughness ?? 0);
        const leakageCorrelation = Math.max(0, hints?.leakageCorrelation ?? 0);
        const lowBandLeakageCorrelation = Math.max(0, hints?.lowBandLeakageCorrelation ?? 0);
        const roughnessPressure = this.clampNumber(
            Math.max(0, highBandRoughness - 0.0048) / 0.0048,
            0,
            2.2,
            0,
        );
        const nearClipPressure = this.clampNumber(
            Math.max(0, metrics.nearClipRatio - 0.012) * 40,
            0,
            2.0,
            0,
        );
        const lowBleedPressure = this.clampNumber(
            Math.max(0, metrics.lowBandRatio - 0.30) * 3.0
            + Math.max(0, lowBandLeakageCorrelation - 0.12) * 4.0
            + Math.max(0, leakageCorrelation - 0.16) * 1.4,
            0,
            3.0,
            0,
        );
        // High-pass cut: keep conservative for singing so low notes are not over-thinned.
        const speechSparse = metrics.speechActivityRatio < 0.50;
        const preGainLinear = this.clampNumber(
            1 - (Math.max(0, metrics.nearClipRatio - 0.008) * 3.6) - (nearClipPressure * 0.03),
            0.78,
            1.0,
            1.0,
        );
        const highpassHz = this.clampNumber(
            Math.round(
                (speechSparse ? 58 : 68)
                + Math.max(0, metrics.lowBandRatio - 0.28) * 180
                + lowBleedPressure * (speechSparse ? 20 : 12)
                - Math.max(0, metrics.speechActivityRatio - 0.55) * 18,
            ),
            48,
            170,
            speechSparse ? 58 : 68,
        );
        // Low-pass cut: lowered when high-band energy (hiss/artifact) is high
        const lowpassHz = this.clampNumber(
            Math.round(
                15000
                - Math.max(0, metrics.highBandRatio - 0.45) * 9000
                - roughnessPressure * 1700
                - nearClipPressure * 700,
            ),
            8200,
            16000,
            14000,
        );
        // FFT spectral denoising strength: stronger when high-band hiss is prominent
        const afftdnNr = this.clampNumber(
            Math.round(
                (speechSparse ? 5 : 6)
                + Math.max(0, metrics.highBandRatio - 0.44) * 20
                + (roughnessPressure * 1.8)
                + (nearClipPressure * 0.8),
            ),
            speechSparse ? 4 : 5,
            15,
            speechSparse ? 6 : 7,
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
            this.clampNumber(
                (speechSparse ? 3.8 : 4.5) + Math.max(0, metrics.highBandRatio - 0.42) * 18,
                speechSparse ? 3.0 : 3.5,
                14,
                speechSparse ? 4.5 : 6,
            ),
            3,
        );
        // ブリード/反響が検出された場合は anlmdn を強化して残響尾を抑制
        const reverbLeakagePressure = this.clampNumber(
            Math.max(0, leakageCorrelation - 0.09) * 2.8
            + Math.max(0, lowBandLeakageCorrelation - 0.11) * 1.4,
            0, 1.2, 0,
        );
        const residualLeakagePressure = this.clampNumber(
            Math.max(0, leakageCorrelation - 0.08) * 2.6
            + Math.max(0, lowBandLeakageCorrelation - 0.10) * 2.2
            + Math.max(0, metrics.silenceRatio - 0.42) * 0.9,
            0,
            1.8,
            0,
        );
        const anlmdnStrengthTuned = this.roundNumber(
            this.clampNumber(
                anlmdnStrength
                + (roughnessPressure * 1.3)
                + (nearClipPressure * 0.6)
                + (reverbLeakagePressure * 0.9)
                - (metrics.speechActivityRatio > 0.72 ? 0.4 : 0),
                speechSparse ? 3.0 : 3.5,
                16,
                anlmdnStrength,
            ),
            3,
        );
        // Dynamic loudness normalization gain
        const dynamicGain = this.clampNumber(
            Math.round((speechSparse ? 6 : 7) + Math.max(0, -18 - metrics.rmsDb) * 0.50),
            4,
            13,
            speechSparse ? 7 : 8,
        );
        const dynaudnormFrame = this.clampNumber(
            Math.round((speechSparse ? 440 : 340) + (roughnessPressure * 80) + (nearClipPressure * 40)),
            speechSparse ? 380 : 300,
            speechSparse ? 700 : 560,
            speechSparse ? 480 : 360,
        );
        const dynaudnormPeak = this.roundNumber(
            this.clampNumber(0.94 - (nearClipPressure * 0.03), 0.86, 0.96, 0.94),
            3,
        );
        const dynaudnormMax = this.clampNumber(
            Math.round((speechSparse ? 12 : 8) + (roughnessPressure * 2)),
            speechSparse ? 10 : 7,
            speechSparse ? 16 : 12,
            speechSparse ? 12 : 8,
        );
        const adeclickWindow = this.clampInt(
            Math.round(35 + (roughnessPressure * 8) + (nearClipPressure * 10)),
            35,
            64,
            35,
        );
        const adeclickOverlap = this.clampInt(
            Math.round(70 + (roughnessPressure * 10) + (nearClipPressure * 10)),
            65,
            88,
            70,
        );

        // 反響/ブリード圧力が強い場合は2段目の軽量 afftdn を追加 (反響対策)
        const tailAfftdnNr = reverbLeakagePressure > 0.08
            ? Math.round(4 + reverbLeakagePressure * 22 + residualLeakagePressure * 5 + (speechSparse ? 1 : 0))
            : 0;

        // 息づかい・声の輝き復元 EQ: ノイズ除去で失われた高域エアを自然にリストア (8–12kHz ハイシェルフ)
        // NR 強度が高いほどより低い周波数から持ち上げ、roughness が高い場合は控えめに
        const highShelfHz = this.clampInt(
            Math.round(9500 - Math.max(0, afftdnNr - 6) * 80 - (roughnessPressure * 180)),
            8200,
            11500,
            9500,
        );
        const highShelfGainDb = this.roundNumber(
            this.clampNumber(
                2.6
                - Math.max(0, metrics.highBandRatio - 0.46) * 9
                + Math.max(0, afftdnNr - 6) * 0.12
                - (roughnessPressure > 0.30 ? 0.6 : 0)
                - (nearClipPressure > 0.50 ? 0.8 : 0)
                - (reverbLeakagePressure * 1.15)
                - (lowBleedPressure * 0.45)
                - (residualLeakagePressure > 0.60 ? 0.45 : 0),
                0,
                4.5,
                2.6,
            ),
            2,
        );
        const applyHighShelf = (
            highShelfGainDb > 0.5
            && lowpassHz > (highShelfHz + 1200)
            && !(residualLeakagePressure >= 1.05 && metrics.speechActivityRatio < 0.52)
        );
        // ローパスカットオフより十分低い帯域にのみ適用 (余裕 1200Hz)

        return [
            ...(preGainLinear < 0.995 ? [`volume=${this.roundNumber(preGainLinear, 4)}`] : []),
            // Steep 2-pole (40 dB/decade) high-pass removes low-end rumble and bass bleed
            `highpass=f=${highpassHz}:poles=2`,
            // FFT-based spectral denoiser — targets stationary hiss and tonal leakage
            `afftdn=nr=${afftdnNr}:nf=-45:tn=1`,
            // Non-local means denoiser — suppresses musical noise (separation artifacts)
            `anlmdn=s=${anlmdnStrengthTuned}:p=${anlmdnPatch}:r=${anlmdnResearch}:m=15`,
            // Light de-click after denoise to catch short "pops" introduced by aggressive separation/noise suppression
            `adeclick=t=2:w=${adeclickWindow}:o=${adeclickOverlap}:a=2:m=a`,
            // ノイズ除去で失われた息づかい・高域エアを自然にリストア (8–12kHz ハイシェルフ EQ)
            ...(applyHighShelf ? [`treble=f=${highShelfHz}:g=${highShelfGainDb}:t=q:w=0.5`] : []),
            // 2-pole low-pass removes harsh high-frequency separation artifacts
            `lowpass=f=${lowpassHz}:poles=2`,
            // Dynamic loudness normalization for consistent RMS
            `dynaudnorm=f=${dynaudnormFrame}:g=${dynamicGain}:p=${dynaudnormPeak}:m=${dynaudnormMax}`,
            // Transparent peak limiter
            'alimiter=limit=0.98',
            // 反響/ブリード残響尾を除去する2段目デノイズ (leakageCorrelation が高い場合のみ)
            ...(tailAfftdnNr > 0 ? [`afftdn=nr=${this.clampInt(tailAfftdnNr, 4, 20, 5)}:nf=-52:tn=1`] : []),
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
                avgAbsHighLeakGain: 0,
                maxAbsHighLeakGain: 0,
                frameCount: 0,
            };
        }

        const sampleRate = vocal.sampleRate;
        const frameLen = this.clampInt(Math.round(sampleRate * 0.046), 1024, 4096, 2048);
        const hop = this.clampInt(Math.round(frameLen / 4), 256, 2048, 512);
        const half = Math.max(1, Math.floor(frameLen / 2));

        const frameCenters: number[] = [];
        const frameLeakGains: number[] = [];
        const frameHighLeakGains: number[] = [];
        let corrSum = 0;
        let gainAbsSum = 0;
        let gainAbsMax = 0;
        let highGainAbsSum = 0;
        let highGainAbsMax = 0;
        const highAlpha = 1 - Math.exp((-2 * Math.PI * 3600) / sampleRate);

        for (let center = half; center < n - half; center += hop) {
            const start = center - half;
            const end = Math.min(n, start + frameLen);
            let vv = 0;
            let aa = 0;
            let va = 0;
            let vPeak = 0;
            let aPeak = 0;
            let vHighLp = 0;
            let aHighLp = 0;
            let vHighSq = 0;
            let aHighSq = 0;
            let highVa = 0;
            let vHighPeak = 0;
            let aHighPeak = 0;
            for (let i = start; i < end; i += 1) {
                const v = vocal.samples[i] / INT16_MAX;
                const a = accompaniment.samples[i] / INT16_MAX;
                vv += v * v;
                aa += a * a;
                va += v * a;
                vHighLp += highAlpha * (v - vHighLp);
                aHighLp += highAlpha * (a - aHighLp);
                const vHigh = v - vHighLp;
                const aHigh = a - aHighLp;
                vHighSq += vHigh * vHigh;
                aHighSq += aHigh * aHigh;
                highVa += vHigh * aHigh;
                const av = Math.abs(v);
                const aaAbs = Math.abs(a);
                const avHigh = Math.abs(vHigh);
                const aaHighAbs = Math.abs(aHigh);
                if (av > vPeak) vPeak = av;
                if (aaAbs > aPeak) aPeak = aaAbs;
                if (avHigh > vHighPeak) vHighPeak = avHigh;
                if (aaHighAbs > aHighPeak) aHighPeak = aaHighAbs;
            }
            const len = Math.max(1, end - start);
            const vRms = Math.sqrt(vv / len);
            const aRms = Math.sqrt(aa / len);
            const vHighRms = Math.sqrt(vHighSq / len);
            const aHighRms = Math.sqrt(aHighSq / len);
            const corr = (vv > 1e-9 && aa > 1e-9) ? Math.abs(va) / Math.sqrt(vv * aa) : 0;
            const beta = aa > 1e-9 ? (va / aa) : 0;
            const highCorr = (vHighSq > 1e-9 && aHighSq > 1e-9) ? Math.abs(highVa) / Math.sqrt(vHighSq * aHighSq) : 0;
            const highBeta = aHighSq > 1e-9 ? (highVa / aHighSq) : 0;
            const vocalDominance = vRms / (aRms + 1e-9);
            const highDominance = vHighRms / (aHighRms + 1e-9);
            const gateCorr = this.smoothstep(corr, 0.08, 0.85);
            const gateEnergy = this.smoothstep(aRms, 0.01, 0.18);
            const preserveVocal = 1 - this.smoothstep(vocalDominance, 1.6, 4.0);
            const peakGuard = 1 - this.smoothstep(vPeak, 0.78, 0.98) * 0.35;
            const highGateCorr = this.smoothstep(highCorr, 0.10, 0.88);
            const highGateEnergy = this.smoothstep(aHighRms, 0.0035, 0.11);
            const preserveHighVocal = 1 - this.smoothstep(highDominance, 1.15, 2.8);
            const highPeakGuard = 1 - this.smoothstep(vHighPeak, 0.26, 0.72) * 0.24;

            let leakGain = beta * gateCorr * gateEnergy * preserveVocal * peakGuard;
            // Clamp to conservative range to avoid eating the lead vocal.
            leakGain = this.clampNumber(leakGain, -0.28, 0.28, 0);
            // When accompaniment is much louder than vocal, permit slightly stronger subtraction.
            if (vocalDominance < 0.75 && corr > 0.18) {
                leakGain = this.clampNumber(leakGain * 1.18, -0.34, 0.34, leakGain);
            }

            let highLeakGain = highBeta * highGateCorr * highGateEnergy * preserveHighVocal * highPeakGuard;
            highLeakGain = this.clampNumber(highLeakGain, -0.18, 0.18, 0);
            if (highDominance < 0.90 && highCorr > 0.16) {
                highLeakGain = this.clampNumber(highLeakGain * 1.22, -0.24, 0.24, highLeakGain);
            }
            // Protect strong sibilants / breaths when the vocal already dominates the high band.
            if (vocalDominance > 1.45 && highDominance > 1.08) {
                highLeakGain = this.clampNumber(highLeakGain * 0.82, -0.20, 0.20, highLeakGain);
            }

            frameCenters.push(center);
            frameLeakGains.push(leakGain);
            frameHighLeakGains.push(highLeakGain);
            corrSum += corr;
            gainAbsSum += Math.abs(leakGain);
            highGainAbsSum += Math.abs(highLeakGain);
            if (Math.abs(leakGain) > gainAbsMax) {
                gainAbsMax = Math.abs(leakGain);
            }
            if (Math.abs(highLeakGain) > highGainAbsMax) {
                highGainAbsMax = Math.abs(highLeakGain);
            }
        }

        if (frameCenters.length === 0) {
            fs.copyFileSync(vocalPath, outputPath);
            return {
                avgCorrelation: 0,
                avgAbsLeakGain: 0,
                maxAbsLeakGain: 0,
                avgAbsHighLeakGain: 0,
                maxAbsHighLeakGain: 0,
                frameCount: 0,
            };
        }

        // Smooth frame gains to reduce pumping / zipper noise.
        const smoothedGains = new Float32Array(frameLeakGains.length);
        const smoothedHighGains = new Float32Array(frameHighLeakGains.length);
        for (let i = 0; i < frameLeakGains.length; i += 1) {
            const a = frameLeakGains[Math.max(0, i - 1)];
            const b = frameLeakGains[i];
            const c = frameLeakGains[Math.min(frameLeakGains.length - 1, i + 1)];
            smoothedGains[i] = (a * 0.2) + (b * 0.6) + (c * 0.2);
            const ah = frameHighLeakGains[Math.max(0, i - 1)];
            const bh = frameHighLeakGains[i];
            const ch = frameHighLeakGains[Math.min(frameHighLeakGains.length - 1, i + 1)];
            smoothedHighGains[i] = (ah * 0.2) + (bh * 0.6) + (ch * 0.2);
        }

        const outputSamples = new Int16Array(vocal.samples.length);
        // Copy untouched tail if accompaniment is shorter.
        for (let i = n; i < vocal.samples.length; i += 1) {
            outputSamples[i] = vocal.samples[i];
        }

        let frameIndex = 0;
        let accHighLp = 0;
        for (let i = 0; i < n; i += 1) {
            while (frameIndex + 1 < frameCenters.length && i > frameCenters[frameIndex + 1]) {
                frameIndex += 1;
            }

            let gain = smoothedGains[frameIndex];
            let highGain = smoothedHighGains[frameIndex];
            if (frameIndex + 1 < frameCenters.length) {
                const c0 = frameCenters[frameIndex];
                const c1 = frameCenters[frameIndex + 1];
                const t = c1 > c0 ? (i - c0) / (c1 - c0) : 0;
                gain = (smoothedGains[frameIndex] * (1 - t)) + (smoothedGains[frameIndex + 1] * t);
                highGain = (smoothedHighGains[frameIndex] * (1 - t)) + (smoothedHighGains[frameIndex + 1] * t);
            }

            const v = vocal.samples[i] / INT16_MAX;
            const a = accompaniment.samples[i] / INT16_MAX;
            accHighLp += highAlpha * (a - accHighLp);
            const aHigh = a - accHighLp;
            let y = v - (gain * a) - (highGain * aHigh);

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
            avgAbsHighLeakGain: this.roundNumber(highGainAbsSum / frameCenters.length, 4),
            maxAbsHighLeakGain: this.roundNumber(highGainAbsMax, 4),
            frameCount: frameCenters.length,
        };
    }

    static removeMusicOnlySectionsWithReferenceMonoPcm16Wav(
        vocalPath: string,
        accompanimentPath: string,
        outputPath: string,
        options?: { preserveTimeline?: boolean; preserveTimelineAttenuation?: number },
    ): SeparationMusicOnlyRemovalSummary {
        const vocal = this.parseMonoPcm16Wav(vocalPath);
        const accompaniment = this.parseMonoPcm16Wav(accompanimentPath);
        if (vocal.sampleRate !== accompaniment.sampleRate) {
            throw new Error(`Sample rate mismatch for music-only removal: vocal=${vocal.sampleRate}, accompaniment=${accompaniment.sampleRate}`);
        }

        const preserveTimeline = options?.preserveTimeline === true;
        const preserveTimelineAttenuation = preserveTimeline
            ? this.clampNumber(Number(options?.preserveTimelineAttenuation), 0, 1, 0)
            : 0;
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
        // Longer fades reduce short "pops" when toggling suppression on/off across segment boundaries.
        const fadeSamples = Math.max(1, Math.round(sr * 0.018));
        const includedSegments: Array<{ start: number; end: number; zero: boolean; gain: number }> = [];
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
                includedSegments.push({ start: segStart, end: s, zero: false, gain: 1 });
            } else if (len < minRemoveSamples) {
                if (preserveTimeline && preserveTimelineAttenuation > 1e-6) {
                    includedSegments.push({ start: segStart, end: s, zero: false, gain: preserveTimelineAttenuation });
                } else {
                    includedSegments.push({ start: segStart, end: s, zero: true, gain: 0 });
                }
                zeroedShortGapSamples += len;
            } else {
                removedSegments += 1;
                removedSamples += len;
                if (preserveTimeline) {
                    includedSegments.push({
                        start: segStart,
                        end: s,
                        zero: preserveTimelineAttenuation <= 1e-6,
                        gain: preserveTimelineAttenuation <= 1e-6 ? 0 : preserveTimelineAttenuation,
                    });
                }
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
                if (seg.zero) {
                    out[outPos + i2] = 0;
                } else if (seg.gain >= 0.999) {
                    out[outPos + i2] = vocal.samples[seg.start + i2];
                } else {
                    out[outPos + i2] = this.clampInt16(Math.round(vocal.samples[seg.start + i2] * seg.gain));
                }
            }
            if (!seg.zero) {
                const fade = Math.min(fadeSamples, len);
                for (let f = 0; f < fade; f += 1) {
                    const fadeIn = f / Math.max(1, fade - 1);
                    const fadeOut = (fade - 1 - f) / Math.max(1, fade - 1);
                    if (si > 0) {
                        const idx = outPos + f;
                        const prevSeg = includedSegments[si - 1];
                        const gainDelta = Math.abs((prevSeg?.gain ?? 0) - seg.gain);
                        if ((prevSeg?.zero ?? true) || gainDelta > 0.10) {
                            out[idx] = this.clampInt16(Math.round(out[idx] * fadeIn));
                        }
                    }
                    if (si < includedSegments.length - 1) {
                        const idx = outPos + len - 1 - f;
                        const nextSeg = includedSegments[si + 1];
                        const gainDelta = Math.abs((nextSeg?.gain ?? 0) - seg.gain);
                        if ((nextSeg?.zero ?? true) || gainDelta > 0.10) {
                            out[idx] = this.clampInt16(Math.round(out[idx] * fadeOut));
                        }
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

    static refineWithOriginalMixtureMonoPcm16Wav(
        mixturePath: string,
        vocalPath: string,
        accompanimentPath: string,
        outputVocalPath: string,
        outputAccompanimentPath?: string,
    ): SeparationMixtureReprojectionSummary {
        const mix = this.parseMonoPcm16Wav(mixturePath);
        const vocal = this.parseMonoPcm16Wav(vocalPath);
        const accompaniment = this.parseMonoPcm16Wav(accompanimentPath);
        if (mix.sampleRate !== vocal.sampleRate || mix.sampleRate !== accompaniment.sampleRate) {
            throw new Error(`Sample rate mismatch for mixture reprojection: mix=${mix.sampleRate}, vocal=${vocal.sampleRate}, accompaniment=${accompaniment.sampleRate}`);
        }

        const stemLength = Math.min(vocal.samples.length, accompaniment.samples.length);
        if (stemLength < 2048 || mix.samples.length < 2048) {
            fs.copyFileSync(vocalPath, outputVocalPath);
            if (outputAccompanimentPath) {
                fs.copyFileSync(accompanimentPath, outputAccompanimentPath);
            }
            return {
                frameCount: 0,
                estimatedLagSamples: 0,
                estimatedLagMs: 0,
                avgVocalGain: 1,
                avgAccompanimentGain: 1,
                avgVocalResidualWeight: 0.5,
                avgReconErrorBefore: 0,
                avgReconErrorAfter: 0,
                bgmOnlySuppressedFrames: 0,
                lowBleedGuardFrames: 0,
                outputDurationMs: vocal.durationMs,
            };
        }

        const maxLag = this.clampInt(Math.round(mix.sampleRate * 0.12), 256, 8192, 4096);
        const lagSamples = this.estimateMixtureLagSamples(mix.samples, vocal.samples, accompaniment.samples, maxLag);
        const mixStart = lagSamples < 0 ? -lagSamples : 0;
        const stemStart = lagSamples > 0 ? lagSamples : 0;
        const n = Math.min(
            mix.samples.length - mixStart,
            vocal.samples.length - stemStart,
            accompaniment.samples.length - stemStart,
        );
        if (n < 2048) {
            fs.copyFileSync(vocalPath, outputVocalPath);
            if (outputAccompanimentPath) {
                fs.copyFileSync(accompanimentPath, outputAccompanimentPath);
            }
            return {
                frameCount: 0,
                estimatedLagSamples: lagSamples,
                estimatedLagMs: this.roundNumber((lagSamples / mix.sampleRate) * 1000, 2),
                avgVocalGain: 1,
                avgAccompanimentGain: 1,
                avgVocalResidualWeight: 0.5,
                avgReconErrorBefore: 0,
                avgReconErrorAfter: 0,
                bgmOnlySuppressedFrames: 0,
                lowBleedGuardFrames: 0,
                outputDurationMs: vocal.durationMs,
            };
        }

        const sr = mix.sampleRate;
        const frameLen = this.clampInt(Math.round(sr * 0.032), 1024, 4096, 2048);
        const hop = this.clampInt(Math.round(sr * 0.012), 256, frameLen, 512);
        const frameCount = Math.max(1, Math.floor((n - frameLen) / hop) + 1);
        const centers = new Int32Array(frameCount);
        const vocalGainFrames = new Float32Array(frameCount);
        const accGainFrames = new Float32Array(frameCount);
        const vocalResidualWeightFrames = new Float32Array(frameCount);
        const suppressVocalFrames = new Float32Array(frameCount);
        const lowBleedCancelFrames = new Float32Array(frameCount);

        let vocalGainSum = 0;
        let accGainSum = 0;
        let vocalWeightSum = 0;
        let bgmOnlySuppressedFrames = 0;
        let lowBleedGuardFrames = 0;
        let reconErrBeforeSqSum = 0;
        let reconErrAfterSqSumApprox = 0;

        for (let fi = 0; fi < frameCount; fi += 1) {
            const start = fi * hop;
            const end = Math.min(n, start + frameLen);
            const center = Math.min(n - 1, start + Math.floor((end - start) / 2));
            centers[fi] = center;

            let vv = 0;
            let aa = 0;
            let xx = 0;
            let xv = 0;
            let xa = 0;
            let va = 0;
            let vPeak = 0;
            let aPeak = 0;
            let xPeak = 0;
            let lowV = 0;
            let lowA = 0;
            let lowX = 0;
            let lowVSq = 0;
            let lowASq = 0;
            let lowXSq = 0;
            let lowVA = 0;
            let prevV = vocal.samples[stemStart + start] / INT16_MAX;
            let zcV = 0;

            for (let j = start; j < end; j += 1) {
                const mi = mixStart + j;
                const si = stemStart + j;
                const x = mix.samples[mi] / INT16_MAX;
                const v = vocal.samples[si] / INT16_MAX;
                const a = accompaniment.samples[si] / INT16_MAX;
                xx += x * x;
                vv += v * v;
                aa += a * a;
                xv += x * v;
                xa += x * a;
                va += v * a;
                const ax = Math.abs(x);
                const av = Math.abs(v);
                const aaAbs = Math.abs(a);
                if (ax > xPeak) xPeak = ax;
                if (av > vPeak) vPeak = av;
                if (aaAbs > aPeak) aPeak = aaAbs;
                lowV += (2 * Math.PI * 180 / sr) * (v - lowV);
                lowA += (2 * Math.PI * 180 / sr) * (a - lowA);
                lowX += (2 * Math.PI * 180 / sr) * (x - lowX);
                lowVSq += lowV * lowV;
                lowASq += lowA * lowA;
                lowXSq += lowX * lowX;
                lowVA += lowV * lowA;
                if (j > start && ((v >= 0 && prevV < 0) || (v < 0 && prevV >= 0))) {
                    zcV += 1;
                }
                prevV = v;
            }

            const len = Math.max(1, end - start);
            const vRms = Math.sqrt(vv / len);
            const aRms = Math.sqrt(aa / len);
            const xRms = Math.sqrt(xx / len);
            const lowVRms = Math.sqrt(lowVSq / len);
            const lowARms = Math.sqrt(lowASq / len);
            const lowXRms = Math.sqrt(lowXSq / len);
            const zcrV = len > 1 ? zcV / (len - 1) : 0;
            const corrVA = (vv > 1e-12 && aa > 1e-12) ? Math.abs(va) / Math.sqrt(vv * aa) : 0;
            const corrLowVA = (lowVSq > 1e-12 && lowASq > 1e-12) ? Math.abs(lowVA) / Math.sqrt(lowVSq * lowASq) : 0;

            let gV = vv > 1e-10 ? (xv / vv) : 1;
            let gA = aa > 1e-10 ? (xa / aa) : 1;
            gV = this.clampNumber(gV, 0.60, 1.45, 1);
            gA = this.clampNumber(gA, 0.60, 1.45, 1);

            const dominance = vRms / (aRms + 1e-9);
            const voiceLike = (vRms > Math.max(0.0045, xRms * 0.10)) && zcrV >= 0.005 && zcrV <= 0.40;
            const likelyBgmOnly = aRms > 0.008 && (
                (!voiceLike && dominance < 0.86)
                || (dominance < 0.62 && corrVA > 0.16)
                || (dominance < 0.72 && lowVRms / (lowARms + 1e-9) < 0.75 && corrLowVA > 0.22)
            );
            let suppressVocal = 1;
            if (likelyBgmOnly) {
                const strength = this.clampNumber(
                    (0.90 - dominance) * 1.25
                    + Math.max(0, corrVA - 0.14) * 1.35
                    + Math.max(0, corrLowVA - 0.18) * 1.1,
                    0,
                    1.2,
                    0,
                );
                suppressVocal = this.clampNumber(1 - (0.62 * strength), 0.18, 1, 1);
                if (suppressVocal < 0.98) bgmOnlySuppressedFrames += 1;
            }

            const lowBleedHeavy = aRms > 0.009
                && (lowVRms / (lowARms + 1e-9)) < 0.82
                && corrLowVA > 0.24
                && lowXRms > 0.006;
            let lowBleedCancel = 0;
            if (lowBleedHeavy) {
                lowBleedCancel = this.clampNumber(
                    0.06
                    + Math.max(0, 0.82 - (lowVRms / (lowARms + 1e-9))) * 0.40
                    + Math.max(0, corrLowVA - 0.24) * 0.28,
                    0,
                    0.28,
                    0,
                );
                if (lowBleedCancel > 0.01) lowBleedGuardFrames += 1;
            }

            const baseWeight = Math.pow(Math.abs(gV) * vRms, 1.25)
                / (Math.pow(Math.abs(gV) * vRms, 1.25) + Math.pow(Math.abs(gA) * aRms, 1.25) + 1e-9);
            const vocalResidualWeight = this.clampNumber(
                (baseWeight * suppressVocal) + (voiceLike ? 0.08 : -0.04),
                0.03,
                0.97,
                0.5,
            );

            // Approximate reconstruction error after reprojection (before sample-level low-end guard)
            const reconBefore = xRms > 1e-7
                ? Math.sqrt(Math.max(0, xx + vv + aa - (2 * xv) - (2 * xa) + (2 * va)) / len)
                : 0;
            const reconAfterApprox = xRms * 0.02; // residual redistribution enforces near mixture-consistency

            vocalGainFrames[fi] = gV;
            accGainFrames[fi] = gA;
            vocalResidualWeightFrames[fi] = vocalResidualWeight;
            suppressVocalFrames[fi] = suppressVocal;
            lowBleedCancelFrames[fi] = lowBleedCancel;
            vocalGainSum += gV;
            accGainSum += gA;
            vocalWeightSum += vocalResidualWeight;
            reconErrBeforeSqSum += reconBefore * reconBefore;
            reconErrAfterSqSumApprox += reconAfterApprox * reconAfterApprox;
        }

        // Smooth controls to avoid zipper noise.
        const gVSmooth = new Float32Array(frameCount);
        const gASmooth = new Float32Array(frameCount);
        const wVSmooth = new Float32Array(frameCount);
        const supSmooth = new Float32Array(frameCount);
        const lowCancelSmooth = new Float32Array(frameCount);
        for (let i = 0; i < frameCount; i += 1) {
            const i0 = Math.max(0, i - 1);
            const i1 = i;
            const i2 = Math.min(frameCount - 1, i + 1);
            gVSmooth[i] = (vocalGainFrames[i0] * 0.18) + (vocalGainFrames[i1] * 0.64) + (vocalGainFrames[i2] * 0.18);
            gASmooth[i] = (accGainFrames[i0] * 0.18) + (accGainFrames[i1] * 0.64) + (accGainFrames[i2] * 0.18);
            wVSmooth[i] = (vocalResidualWeightFrames[i0] * 0.20) + (vocalResidualWeightFrames[i1] * 0.60) + (vocalResidualWeightFrames[i2] * 0.20);
            supSmooth[i] = (suppressVocalFrames[i0] * 0.20) + (suppressVocalFrames[i1] * 0.60) + (suppressVocalFrames[i2] * 0.20);
            lowCancelSmooth[i] = (lowBleedCancelFrames[i0] * 0.20) + (lowBleedCancelFrames[i1] * 0.60) + (lowBleedCancelFrames[i2] * 0.20);
        }

        const outVocal = new Int16Array(vocal.samples.length);
        const outAcc = new Int16Array(accompaniment.samples.length);
        outVocal.set(vocal.samples);
        outAcc.set(accompaniment.samples);

        let frameIdx = 0;
        let lowVState = 0;
        let lowAState = 0;
        let reconErrAfterSqExact = 0;
        let exactCount = 0;
        const lowAlpha = 1 - Math.exp((-2 * Math.PI * 180) / sr);
        for (let j = 0; j < n; j += 1) {
            while (frameIdx + 1 < frameCount && j > centers[frameIdx + 1]) {
                frameIdx += 1;
            }

            let gV = gVSmooth[frameIdx];
            let gA = gASmooth[frameIdx];
            let wVFrame = wVSmooth[frameIdx];
            let suppressVocal = supSmooth[frameIdx];
            let lowCancel = lowCancelSmooth[frameIdx];
            if (frameIdx + 1 < frameCount) {
                const c0 = centers[frameIdx];
                const c1 = centers[frameIdx + 1];
                const t = c1 > c0 ? (j - c0) / (c1 - c0) : 0;
                gV = (gVSmooth[frameIdx] * (1 - t)) + (gVSmooth[frameIdx + 1] * t);
                gA = (gASmooth[frameIdx] * (1 - t)) + (gASmooth[frameIdx + 1] * t);
                wVFrame = (wVSmooth[frameIdx] * (1 - t)) + (wVSmooth[frameIdx + 1] * t);
                suppressVocal = (supSmooth[frameIdx] * (1 - t)) + (supSmooth[frameIdx + 1] * t);
                lowCancel = (lowCancelSmooth[frameIdx] * (1 - t)) + (lowCancelSmooth[frameIdx + 1] * t);
            }

            const mi = mixStart + j;
            const si = stemStart + j;
            const x = mix.samples[mi] / INT16_MAX;
            const v = vocal.samples[si] / INT16_MAX;
            const a = accompaniment.samples[si] / INT16_MAX;
            const v0 = v * gV;
            const a0 = a * gA;
            const residual = x - (v0 + a0);
            const vPow = Math.pow(Math.abs(v0) + 1e-8, 1.20);
            const aPow = Math.pow(Math.abs(a0) + 1e-8, 1.20);
            let wV = vPow / (vPow + aPow + 1e-9);
            wV = this.clampNumber((wV * 0.65) + (wVFrame * 0.35), 0.02, 0.98, 0.5);
            let yV = (v0 * (0.60 + (0.40 * suppressVocal))) + (residual * wV);
            let yA = x - yV;

            if (lowCancel > 0.001) {
                lowVState += lowAlpha * (yV - lowVState);
                lowAState += lowAlpha * (yA - lowAState);
                const corrSign = Math.sign(lowVState * lowAState);
                if (corrSign > 0 && Math.abs(lowAState) > 0.003) {
                    yV -= lowAState * lowCancel;
                    yA = x - yV;
                }
            } else {
                lowVState += lowAlpha * (yV - lowVState);
                lowAState += lowAlpha * (yA - lowAState);
            }

            yV = Math.tanh(yV * 1.05) / Math.tanh(1.05);
            yA = x - yV;
            outVocal[si] = this.clampInt16(Math.round(yV * INT16_MAX));
            outAcc[si] = this.clampInt16(Math.round(yA * INT16_MAX));

            const reconAfter = x - (outVocal[si] / INT16_MAX + outAcc[si] / INT16_MAX);
            reconErrAfterSqExact += reconAfter * reconAfter;
            exactCount += 1;
        }

        this.writeMonoPcm16Wav(outputVocalPath, sr, outVocal);
        if (outputAccompanimentPath) {
            this.writeMonoPcm16Wav(outputAccompanimentPath, sr, outAcc);
        }

        return {
            frameCount,
            estimatedLagSamples: lagSamples,
            estimatedLagMs: this.roundNumber((lagSamples / sr) * 1000, 2),
            avgVocalGain: this.roundNumber(vocalGainSum / Math.max(1, frameCount), 4),
            avgAccompanimentGain: this.roundNumber(accGainSum / Math.max(1, frameCount), 4),
            avgVocalResidualWeight: this.roundNumber(vocalWeightSum / Math.max(1, frameCount), 4),
            avgReconErrorBefore: this.roundNumber(Math.sqrt(reconErrBeforeSqSum / Math.max(1, frameCount)), 5),
            avgReconErrorAfter: this.roundNumber(
                exactCount > 0 ? Math.sqrt(reconErrAfterSqExact / exactCount) : Math.sqrt(reconErrAfterSqSumApprox / Math.max(1, frameCount)),
                7,
            ),
            bgmOnlySuppressedFrames,
            lowBleedGuardFrames,
            outputDurationMs: Math.round((outVocal.length / sr) * 1000),
        };
    }

    static refineWithOriginalMixtureSubbandMaskMonoPcm16Wav(
        mixturePath: string,
        vocalPath: string,
        accompanimentPath: string,
        outputVocalPath: string,
        outputAccompanimentPath?: string,
    ): SeparationSubbandReprojectionSummary {
        const mix = this.parseMonoPcm16Wav(mixturePath);
        const vocal = this.parseMonoPcm16Wav(vocalPath);
        const accompaniment = this.parseMonoPcm16Wav(accompanimentPath);
        if (mix.sampleRate !== vocal.sampleRate || mix.sampleRate !== accompaniment.sampleRate) {
            throw new Error(`Sample rate mismatch for subband reprojection: mix=${mix.sampleRate}, vocal=${vocal.sampleRate}, accompaniment=${accompaniment.sampleRate}`);
        }

        const stemLength = Math.min(vocal.samples.length, accompaniment.samples.length);
        if (stemLength < 2048 || mix.samples.length < 2048) {
            fs.copyFileSync(vocalPath, outputVocalPath);
            if (outputAccompanimentPath) fs.copyFileSync(accompanimentPath, outputAccompanimentPath);
            return {
                frameCount: 0,
                estimatedLagSamples: 0,
                estimatedLagMs: 0,
                avgSubLowMask: 0.5,
                avgLowMask: 0.5,
                avgMidMask: 0.5,
                avgHighMask: 0.5,
                avgHighMaskDelta: 0,
                maxHighMaskDelta: 0,
                highMaskDeltaLimitedFrames: 0,
                avgHighSmoothBlend: 0.5,
                highStrongSmoothFrames: 0,
                avgProtectBlend: 0,
                avgHighProtectBoost: 0,
                highProtectBoostRatio: 0,
                avgVibratoProxy: 0,
                vibratoGuardFrames: 0,
                bgmOnlySuppressedFrames: 0,
                lowBgmPriorityFrames: 0,
                lowBleedGuardFrames: 0,
                outputDurationMs: vocal.durationMs,
            };
        }

        const sr = mix.sampleRate;
        const maxLag = this.clampInt(Math.round(sr * 0.12), 256, 8192, 4096);
        const lagSamples = this.estimateMixtureLagSamples(mix.samples, vocal.samples, accompaniment.samples, maxLag);
        const mixStart = lagSamples < 0 ? -lagSamples : 0;
        const stemStart = lagSamples > 0 ? lagSamples : 0;
        const n = Math.min(
            mix.samples.length - mixStart,
            vocal.samples.length - stemStart,
            accompaniment.samples.length - stemStart,
        );
        if (n < 2048) {
            fs.copyFileSync(vocalPath, outputVocalPath);
            if (outputAccompanimentPath) fs.copyFileSync(accompanimentPath, outputAccompanimentPath);
            return {
                frameCount: 0,
                estimatedLagSamples: lagSamples,
                estimatedLagMs: this.roundNumber((lagSamples / sr) * 1000, 2),
                avgSubLowMask: 0.5,
                avgLowMask: 0.5,
                avgMidMask: 0.5,
                avgHighMask: 0.5,
                avgHighMaskDelta: 0,
                maxHighMaskDelta: 0,
                highMaskDeltaLimitedFrames: 0,
                avgHighSmoothBlend: 0.5,
                highStrongSmoothFrames: 0,
                avgProtectBlend: 0,
                avgHighProtectBoost: 0,
                highProtectBoostRatio: 0,
                avgVibratoProxy: 0,
                vibratoGuardFrames: 0,
                bgmOnlySuppressedFrames: 0,
                lowBgmPriorityFrames: 0,
                lowBleedGuardFrames: 0,
                outputDurationMs: vocal.durationMs,
            };
        }

        const frameLen = this.clampInt(Math.round(sr * 0.032), 1024, 4096, 2048);
        const hop = this.clampInt(Math.round(sr * 0.012), 256, frameLen, 512);
        const frameCount = Math.max(1, Math.floor((n - frameLen) / hop) + 1);
        const centers = new Int32Array(frameCount);
        const subLowMasks = new Float32Array(frameCount);
        const lowMasks = new Float32Array(frameCount);
        const midMasks = new Float32Array(frameCount);
        const highMasks = new Float32Array(frameCount);
        const highSmoothBlendByFrame = new Float32Array(frameCount);
        const highProtectBoostByFrame = new Float32Array(frameCount);
        const voiceLikeByFrame = new Float32Array(frameCount);
        const bgmSuppress = new Float32Array(frameCount);

        const alphaSubLow = 1 - Math.exp((-2 * Math.PI * 95) / sr);
        const alphaLow = 1 - Math.exp((-2 * Math.PI * 260) / sr);
        const alphaHighLp = 1 - Math.exp((-2 * Math.PI * 4200) / sr);
        let subLowMaskSum = 0;
        let lowMaskSum = 0;
        let midMaskSum = 0;
        let highMaskSum = 0;
        let highMaskDeltaSum = 0;
        let highMaskDeltaMax = 0;
        let highMaskDeltaLimitedFrames = 0;
        let highSmoothBlendSum = 0;
        let highStrongSmoothFrames = 0;
        let vibratoProxySum = 0;
        let vibratoGuardFrames = 0;
        let prevHighMaskLimited = 0.5;
        let prevVHighRms = 0;
        let bgmOnlySuppressedFrames = 0;
        let lowBgmPriorityFrames = 0;
        let lowBleedGuardFrames = 0;

        for (let fi = 0; fi < frameCount; fi += 1) {
            const start = fi * hop;
            const end = Math.min(n, start + frameLen);
            const center = Math.min(n - 1, start + Math.floor((end - start) / 2));
            centers[fi] = center;

            let vSq = 0;
            let aSq = 0;
            let xSq = 0;
            let va = 0;
            let zcV = 0;
            let prevV = vocal.samples[stemStart + start] / INT16_MAX;

            let vSubLowState = 0;
            let aSubLowState = 0;
            let xSubLowState = 0;
            let vLowState = 0;
            let aLowState = 0;
            let xLowState = 0;
            let vHighLpState = 0;
            let aHighLpState = 0;
            let xHighLpState = 0;
            let vSubLowSq = 0;
            let aSubLowSq = 0;
            let xSubLowSq = 0;
            let vLowSq = 0;
            let aLowSq = 0;
            let xLowSq = 0;
            let vHighSq = 0;
            let aHighSq = 0;
            let xHighSq = 0;
            let vSubLowA = 0;
            let vLowA = 0;
            let vHighA = 0;

            for (let j = start; j < end; j += 1) {
                const mi = mixStart + j;
                const si = stemStart + j;
                const x = mix.samples[mi] / INT16_MAX;
                const v = vocal.samples[si] / INT16_MAX;
                const a = accompaniment.samples[si] / INT16_MAX;
                xSq += x * x;
                vSq += v * v;
                aSq += a * a;
                va += v * a;

                vSubLowState += alphaSubLow * (v - vSubLowState);
                aSubLowState += alphaSubLow * (a - aSubLowState);
                xSubLowState += alphaSubLow * (x - xSubLowState);
                vLowState += alphaLow * (v - vLowState);
                aLowState += alphaLow * (a - aLowState);
                xLowState += alphaLow * (x - xLowState);
                vHighLpState += alphaHighLp * (v - vHighLpState);
                aHighLpState += alphaHighLp * (a - aHighLpState);
                xHighLpState += alphaHighLp * (x - xHighLpState);
                const vSubLow = vSubLowState;
                const aSubLow = aSubLowState;
                const xSubLow = xSubLowState;
                const vLow = vLowState - vSubLowState;
                const aLow = aLowState - aSubLowState;
                const xLow = xLowState - xSubLowState;
                const vHigh = v - vHighLpState;
                const aHigh = a - aHighLpState;
                const xHigh = x - xHighLpState;
                vSubLowSq += vSubLow * vSubLow;
                aSubLowSq += aSubLow * aSubLow;
                xSubLowSq += xSubLow * xSubLow;
                vLowSq += vLow * vLow;
                aLowSq += aLow * aLow;
                xLowSq += xLow * xLow;
                vHighSq += vHigh * vHigh;
                aHighSq += aHigh * aHigh;
                xHighSq += xHigh * xHigh;
                vSubLowA += vSubLow * aSubLow;
                vLowA += vLow * aLow;
                vHighA += vHigh * aHigh;

                if (j > start && ((v >= 0 && prevV < 0) || (v < 0 && prevV >= 0))) zcV += 1;
                prevV = v;
            }

            const len = Math.max(1, end - start);
            const vRms = Math.sqrt(vSq / len);
            const aRms = Math.sqrt(aSq / len);
            const xRms = Math.sqrt(xSq / len);
            const vSubLowRms = Math.sqrt(vSubLowSq / len);
            const aSubLowRms = Math.sqrt(aSubLowSq / len);
            const xSubLowRms = Math.sqrt(xSubLowSq / len);
            const vLowRms = Math.sqrt(vLowSq / len);
            const aLowRms = Math.sqrt(aLowSq / len);
            const xLowRms = Math.sqrt(xLowSq / len);
            const vHighRms = Math.sqrt(vHighSq / len);
            const aHighRms = Math.sqrt(aHighSq / len);
            const xHighRms = Math.sqrt(xHighSq / len);
            const vMidSq = Math.max(0, vSq - vSubLowSq - vLowSq - vHighSq);
            const aMidSq = Math.max(0, aSq - aSubLowSq - aLowSq - aHighSq);
            const xMidSq = Math.max(0, xSq - xSubLowSq - xLowSq - xHighSq);
            const vMidRms = Math.sqrt(vMidSq / len);
            const aMidRms = Math.sqrt(aMidSq / len);
            const xMidRms = Math.sqrt(xMidSq / len);
            const zcr = len > 1 ? zcV / (len - 1) : 0;
            const dominance = vRms / (aRms + 1e-9);
            const subLowDominance = vSubLowRms / (aSubLowRms + 1e-9);
            const lowDominance = vLowRms / (aLowRms + 1e-9);
            const corrVA = (vSq > 1e-12 && aSq > 1e-12) ? Math.abs(va) / Math.sqrt(vSq * aSq) : 0;
            const corrSubLow = (vSubLowSq > 1e-12 && aSubLowSq > 1e-12) ? Math.abs(vSubLowA) / Math.sqrt(vSubLowSq * aSubLowSq) : 0;
            const corrLow = (vLowSq > 1e-12 && aLowSq > 1e-12) ? Math.abs(vLowA) / Math.sqrt(vLowSq * aLowSq) : 0;
            const corrHigh = (vHighSq > 1e-12 && aHighSq > 1e-12) ? Math.abs(vHighA) / Math.sqrt(vHighSq * aHighSq) : 0;

            const voiceLike = (vRms >= Math.max(0.0048, xRms * 0.10)) && zcr >= 0.005 && zcr <= 0.40;
            const lowVoiceLikely = voiceLike && (
                vSubLowRms >= Math.max(0.0038, xSubLowRms * 0.10)
                || subLowDominance >= 0.72
                || (vLowRms >= Math.max(0.0045, xLowRms * 0.12) && lowDominance >= 0.70)
            );
            const lowBandLeakPressure = this.clampNumber(
                Math.max(0, corrSubLow - 0.18) * 2.3
                + Math.max(0, corrLow - 0.20) * 1.9
                + Math.max(0, 0.88 - subLowDominance) * 0.90
                + Math.max(0, 0.90 - lowDominance) * 0.70
                + Math.max(0, aSubLowRms - 0.0055) * 28
                + Math.max(0, aLowRms - 0.0060) * 20,
                0,
                1.8,
                0,
            );
            const lowBandBgmPriorityMode = !lowVoiceLikely
                && aRms > 0.0065
                && (xSubLowRms + xLowRms) > (xMidRms * 0.60)
                && lowBandLeakPressure >= 0.22;
            const likelyBgmOnly = aRms > 0.0085 && (
                (!voiceLike && dominance < 0.88)
                || (!lowVoiceLikely && lowDominance < 0.78 && corrLow > 0.18)
                || (!lowVoiceLikely && subLowDominance < 0.74 && corrSubLow > 0.18)
                || (dominance < 0.68 && corrVA > 0.18)
            );

            const p = 1.28;
            const vSubLowPow = Math.pow(vSubLowRms + 1e-8, p);
            const aSubLowPow = Math.pow(aSubLowRms + 1e-8, p);
            const vLowPow = Math.pow(vLowRms + 1e-8, p);
            const aLowPow = Math.pow(aLowRms + 1e-8, p);
            const vMidPow = Math.pow(vMidRms + 1e-8, p);
            const aMidPow = Math.pow(aMidRms + 1e-8, p);
            const vHighPow = Math.pow(vHighRms + 1e-8, p);
            const aHighPow = Math.pow(aHighRms + 1e-8, p);

            const subLowBias = this.clampNumber(
                1.18
                + Math.max(0, corrSubLow - 0.13) * 1.10
                + Math.max(0, 0.90 - subLowDominance) * 0.25
                + (lowBandBgmPriorityMode ? this.clampNumber(lowBandLeakPressure * 0.22, 0.04, 0.28, 0.10) : 0),
                0.95,
                2.6,
                1.15,
            );
            const lowBias = this.clampNumber(
                1.35
                + Math.max(0, corrLow - 0.14) * 1.7
                + Math.max(0, 0.95 - lowDominance) * 0.45
                + (lowBandBgmPriorityMode ? this.clampNumber(lowBandLeakPressure * 0.42, 0.08, 0.55, 0.16) : 0),
                1.05,
                3.8,
                1.35,
            );
            const midBias = this.clampNumber(1.05 + Math.max(0, corrVA - 0.12) * 0.60, 0.95, 1.9, 1.05);
            const highBias = this.clampNumber(0.92 + Math.max(0, corrHigh - 0.12) * 0.28, 0.82, 1.35, 0.95);
            let subLowMask = vSubLowPow / (vSubLowPow + (aSubLowPow * subLowBias) + 1e-9);
            let lowMask = vLowPow / (vLowPow + (aLowPow * lowBias) + 1e-9);
            let midMask = vMidPow / (vMidPow + (aMidPow * midBias) + 1e-9);
            let highMask = vHighPow / (vHighPow + (aHighPow * highBias) + 1e-9);

            voiceLikeByFrame[fi] = voiceLike ? 1 : 0;
            if (voiceLike) {
                subLowMask = this.clampNumber(subLowMask + 0.04, 0.02, 0.99, subLowMask);
                midMask = this.clampNumber(midMask + 0.06, 0.02, 0.98, midMask);
                // 高域ドロップアウト防止: voiceLike フレームの highMask 最小値を引き上げ (音抜け対策)
                highMask = this.clampNumber(highMask + 0.09, 0.16, 0.995, highMask);
                if (lowVoiceLikely) {
                    subLowMask = this.clampNumber(subLowMask + 0.03, 0.04, 0.995, subLowMask);
                    lowMask = this.clampNumber(lowMask + 0.04, 0.02, 0.99, lowMask);
                }
            }

            let suppress = 1;
            if (likelyBgmOnly) {
                const strength = this.clampNumber(
                    (0.92 - dominance) * 1.15
                    + Math.max(0, corrLow - 0.16) * 1.25
                    + Math.max(0, corrSubLow - 0.16) * 0.80
                    + Math.max(0, 0.92 - lowDominance) * 0.55,
                    0,
                    1.3,
                    0,
                );
                const bgmPriorityBoost = lowBandBgmPriorityMode ? this.clampNumber(lowBandLeakPressure * 0.22, 0.04, 0.28, 0.08) : 0;
                // Keep low bass layers more conservative to avoid hollowing low-pitched vocals.
                const suppressFloor = lowVoiceLikely ? 0.42 : 0.18;
                suppress = this.clampNumber(1 - (0.68 * (strength + bgmPriorityBoost)), suppressFloor, 1, 1);
                if (suppress < 0.98) bgmOnlySuppressedFrames += 1;
            }
            if (lowBandBgmPriorityMode) {
                lowBgmPriorityFrames += 1;
            }

            const lowBleedHeavy = lowBandBgmPriorityMode || (
                (aLowRms > 0.006 || aSubLowRms > 0.006)
                && (xLowRms > 0.004 || xSubLowRms > 0.004)
                && (lowDominance < 0.86 || subLowDominance < 0.84)
                && (corrLow > 0.20 || corrSubLow > 0.20)
            );
            if (lowBleedHeavy) {
                const lowPenaltyBase = this.clampNumber(
                    0.06
                    + Math.max(0, 0.86 - lowDominance) * 0.28
                    + Math.max(0, corrLow - 0.20) * 0.24
                    + Math.max(0, corrSubLow - 0.20) * 0.18,
                    0.01,
                    0.24,
                    0.06,
                ) + (lowBandBgmPriorityMode ? this.clampNumber(lowBandLeakPressure * 0.08, 0.02, 0.10, 0.03) : 0);
                const lowPenaltyScale = lowVoiceLikely ? 0.45 : 1.0;
                const lowPenalty = lowPenaltyBase * lowPenaltyScale;
                const subPenalty = lowPenalty * (lowVoiceLikely ? 0.25 : 0.55);
                subLowMask = this.clampNumber(subLowMask - subPenalty, lowVoiceLikely ? 0.10 : 0.03, 0.97, subLowMask);
                lowMask = this.clampNumber(lowMask - lowPenalty, lowVoiceLikely ? 0.07 : 0.02, 0.95, lowMask);
                lowBleedGuardFrames += 1;
            }

            // If the mixture has very low vocal-like high band and strong accompaniment-like low band, be more conservative.
            if (!voiceLike && xLowRms > xMidRms * 0.9 && xHighRms < xMidRms * 0.55) {
                subLowMask = this.clampNumber(subLowMask * 0.90, 0.03, 0.97, subLowMask);
                lowMask = this.clampNumber(lowMask * 0.86, 0.02, 0.95, lowMask);
                midMask = this.clampNumber(midMask * 0.92, 0.02, 0.98, midMask);
            }
            if (lowBandBgmPriorityMode) {
                subLowMask = this.clampNumber(subLowMask * (lowVoiceLikely ? 0.96 : 0.84), lowVoiceLikely ? 0.08 : 0.03, lowVoiceLikely ? 0.94 : 0.84, subLowMask);
                lowMask = this.clampNumber(lowMask * (lowVoiceLikely ? 0.92 : 0.76), lowVoiceLikely ? 0.06 : 0.02, lowVoiceLikely ? 0.90 : 0.78, lowMask);
                if (!voiceLike) {
                    midMask = this.clampNumber(midMask * 0.90, 0.01, 0.94, midMask);
                }
            }

            // Apply weaker suppression to low layers so low-pitched vocals do not become hollow.
            const subLowSuppressMix = lowVoiceLikely ? (0.94 + (0.06 * suppress)) : (0.90 + (0.10 * suppress));
            const lowSuppressMix = lowVoiceLikely ? (0.90 + (0.10 * suppress)) : (0.84 + (0.16 * suppress));
            const subLowSuppressMixFinal = lowBandBgmPriorityMode
                ? Math.min(subLowSuppressMix, (lowVoiceLikely ? (0.92 + (0.08 * suppress)) : (0.80 + (0.20 * suppress))))
                : subLowSuppressMix;
            const lowSuppressMixFinal = lowBandBgmPriorityMode
                ? Math.min(lowSuppressMix, (lowVoiceLikely ? (0.88 + (0.12 * suppress)) : (0.72 + (0.28 * suppress))))
                : lowSuppressMix;
            subLowMask = this.clampNumber(subLowMask * subLowSuppressMixFinal, 0.02, 0.995, subLowMask);
            lowMask = this.clampNumber(lowMask * lowSuppressMixFinal, 0.01, 0.98, lowMask);
            midMask = this.clampNumber(midMask * (lowVoiceLikely ? (0.92 + (0.08 * suppress)) : (0.95 + (0.05 * suppress))), 0.01, 0.99, midMask);
            // voiceLike フレームではサプレッションを抑制して高域音抜けを防ぐ
            const highSuppressMix = voiceLike ? (0.93 + (0.07 * suppress)) : (0.77 + (0.23 * suppress));
            highMask = this.clampNumber(highMask * highSuppressMix, voiceLike ? 0.14 : 0.03, 0.995, highMask);

            const highMod = fi > 0 ? Math.abs(vHighRms - prevVHighRms) / Math.max(1e-6, prevVHighRms + vHighRms) : 0;
            const vibratoProxy = this.clampNumber(
                (voiceLike ? 0.18 : 0)
                + (lowVoiceLikely ? 0.07 : 0)
                + Math.max(0, highMod - 0.05) * 3.0
                + Math.max(0, (vHighRms / (vMidRms + 1e-9)) - 0.30) * 0.70
                - (likelyBgmOnly ? 0.18 : 0)
                - (lowBandBgmPriorityMode ? 0.12 : 0)
                - Math.max(0, corrHigh - 0.42) * 0.35,
                0,
                1.4,
                0.18,
            );
            const vibratoGuardStrength = this.clampNumber(
                (vibratoProxy - 0.52) / 0.65,
                0,
                1,
                0,
            );
            vibratoProxySum += vibratoProxy;
            if (vibratoGuardStrength > 0.05) {
                vibratoGuardFrames += 1;
            }

            // フレーム間の高域マスク変化を抑制 — ガビり・ブジー感の主因 (ガビる対策)
            let highMaskDeltaCap = this.clampNumber(
                (voiceLike ? 0.065 : 0.045)
                + (lowVoiceLikely ? 0.006 : 0)
                + (vHighRms > (aHighRms * 1.10) ? 0.006 : 0)
                - (likelyBgmOnly ? 0.012 : 0)
                - (lowBandBgmPriorityMode ? 0.012 : 0)
                - Math.max(0, corrHigh - 0.28) * 0.04,
                voiceLike ? 0.030 : 0.020,
                voiceLike ? 0.090 : 0.068,
                voiceLike ? 0.065 : 0.045,
            );
            if (vibratoGuardStrength > 0) {
                highMaskDeltaCap = this.clampNumber(
                    highMaskDeltaCap * (1 - (0.30 * vibratoGuardStrength)),
                    voiceLike ? 0.022 : 0.016,
                    voiceLike ? 0.082 : 0.060,
                    highMaskDeltaCap,
                );
            }
            let highDeltaWasLimited = false;
            if (fi > 0) {
                const rawDelta = highMask - prevHighMaskLimited;
                if (Math.abs(rawDelta) > highMaskDeltaCap) {
                    highMask = prevHighMaskLimited + (Math.sign(rawDelta) * highMaskDeltaCap);
                    highMaskDeltaLimitedFrames += 1;
                    highDeltaWasLimited = true;
                }
            }
            const highMaskDelta = fi > 0 ? Math.abs(highMask - prevHighMaskLimited) : 0;
            highMaskDeltaSum += highMaskDelta;
            if (highMaskDelta > highMaskDeltaMax) {
                highMaskDeltaMax = highMaskDelta;
            }
            prevHighMaskLimited = highMask;
            prevVHighRms = vHighRms;

            // 反響検出: BGM高域がボーカル高域より大きい場合は反響(エコー)と判定 (反響対策)
            const reverbPressure = this.clampNumber(
                Math.max(0, (aHighRms / (vHighRms + 1e-9)) - 1.15) * 0.11
                + Math.max(0, corrHigh - 0.18) * 0.13,
                0, 0.30, 0,
            );
            const highNoisePressure = this.clampNumber(
                Math.max(0, corrHigh - 0.14) * 1.55
                + Math.max(0, aHighRms - 0.0045) * 28
                + Math.max(0, (xHighRms / (xMidRms + 1e-9)) - 0.75) * 0.55
                + (likelyBgmOnly ? 0.16 : 0)
                + (lowBandBgmPriorityMode ? 0.12 : 0)
                + (highDeltaWasLimited ? 0.12 : 0)
                + reverbPressure
                - (voiceLike ? 0.05 : 0)
                - (vHighRms > (aHighRms * 1.18) ? 0.07 : 0),
                0,
                1,
                0.18,
            );
            const highSmoothBlend = this.clampNumber(
                0.12 + (highNoisePressure * 0.78),
                0.08,
                0.95,
                0.28,
            );
            highSmoothBlendByFrame[fi] = highSmoothBlend;
            highSmoothBlendSum += highSmoothBlend;
            if (highSmoothBlend >= 0.70) {
                highStrongSmoothFrames += 1;
            }
            let highProtectBoost = this.clampNumber(
                Math.max(0, highSmoothBlend - 0.28) * 0.10
                + Math.max(0, 0.55 - highMask) * 0.03
                + (highDeltaWasLimited ? 0.012 : 0)
                + (vibratoGuardStrength * 0.020)
                + (voiceLike ? 0.006 : 0)
                - (likelyBgmOnly ? 0.010 : 0)
                - (lowBandBgmPriorityMode ? 0.008 : 0),
                0,
                0.08,
                0.01,
            );
            if (!voiceLike && likelyBgmOnly && highMask < 0.20) {
                highProtectBoost = Math.min(highProtectBoost, 0.02);
            }
            highProtectBoostByFrame[fi] = highProtectBoost;

            subLowMasks[fi] = subLowMask;
            lowMasks[fi] = lowMask;
            midMasks[fi] = midMask;
            highMasks[fi] = highMask;
            bgmSuppress[fi] = suppress;
            subLowMaskSum += subLowMask;
            lowMaskSum += lowMask;
            midMaskSum += midMask;
            highMaskSum += highMask;
        }

        const subLowMasksSmooth = new Float32Array(frameCount);
        const lowMasksSmooth = new Float32Array(frameCount);
        const midMasksSmooth = new Float32Array(frameCount);
        const highMasksSmooth = new Float32Array(frameCount);
        for (let i = 0; i < frameCount; i += 1) {
            const i0 = Math.max(0, i - 1);
            const i1 = i;
            const i2 = Math.min(frameCount - 1, i + 1);
            const iM2 = Math.max(0, i - 2);
            const iP2 = Math.min(frameCount - 1, i + 2);
            const iM3 = Math.max(0, i - 3);
            const iP3 = Math.min(frameCount - 1, i + 3);
            subLowMasksSmooth[i] = (subLowMasks[iM2] * 0.08) + (subLowMasks[i0] * 0.18) + (subLowMasks[i1] * 0.48) + (subLowMasks[i2] * 0.18) + (subLowMasks[iP2] * 0.08);
            lowMasksSmooth[i] = (lowMasks[iM2] * 0.08) + (lowMasks[i0] * 0.18) + (lowMasks[i1] * 0.48) + (lowMasks[i2] * 0.18) + (lowMasks[iP2] * 0.08);
            midMasksSmooth[i] = (midMasks[iM2] * 0.08) + (midMasks[i0] * 0.18) + (midMasks[i1] * 0.48) + (midMasks[i2] * 0.18) + (midMasks[iP2] * 0.08);
            const h3 = (highMasks[i0] * 0.18) + (highMasks[i1] * 0.64) + (highMasks[i2] * 0.18);
            const h5 = (highMasks[iM2] * 0.08) + (highMasks[i0] * 0.18) + (highMasks[i1] * 0.48) + (highMasks[i2] * 0.18) + (highMasks[iP2] * 0.08);
            const h5Strong = (highMasks[iM2] * 0.12) + (highMasks[i0] * 0.24) + (highMasks[i1] * 0.28) + (highMasks[i2] * 0.24) + (highMasks[iP2] * 0.12);
            // 7タップ: 重度ガビり区間での強平滑化カーネル
            const h7Strong = (highMasks[iM3] * 0.07) + (highMasks[iM2] * 0.13) + (highMasks[i0] * 0.20) + (highMasks[i1] * 0.20) + (highMasks[i2] * 0.20) + (highMasks[iP2] * 0.13) + (highMasks[iP3] * 0.07);
            const b0 = highSmoothBlendByFrame[i0];
            const b1 = highSmoothBlendByFrame[i1];
            const b2 = highSmoothBlendByFrame[i2];
            const bM2 = highSmoothBlendByFrame[iM2];
            const bP2 = highSmoothBlendByFrame[iP2];
            const smoothBlend = this.clampNumber(
                (bM2 * 0.08) + (b0 * 0.18) + (b1 * 0.48) + (b2 * 0.18) + (bP2 * 0.08),
                0.08,
                0.95,
                b1 || 0.28,
            );
            const toFive = this.clampNumber((smoothBlend - 0.12) / 0.46, 0, 1, 0);
            const toStrong = this.clampNumber((smoothBlend - 0.70) / 0.22, 0, 1, 0);
            // 高smoothBlend時(≥0.83)は7タップに移行してガビりを抑制
            const toSeven = this.clampNumber((smoothBlend - 0.83) / 0.10, 0, 1, 0);
            const hBase = (h3 * (1 - toFive)) + (h5 * toFive);
            const hMid = (hBase * (1 - toStrong)) + (h5Strong * toStrong);
            highMasksSmooth[i] = (hMid * (1 - toSeven)) + (h7Strong * toSeven);
        }

        const outVocal = new Int16Array(vocal.samples.length);
        const outAcc = new Int16Array(accompaniment.samples.length);
        outVocal.set(vocal.samples);
        outAcc.set(accompaniment.samples);

        let frameIdx = 0;
        let mixSubLowState = 0;
        let mixLowState = 0;
        let mixHighLpState = 0;
        let protectBlendSum = 0;
        let highProtectBoostAppliedSum = 0;
        let highProtectBoostAppliedCount = 0;
        for (let j = 0; j < n; j += 1) {
            while (frameIdx + 1 < frameCount && j > centers[frameIdx + 1]) {
                frameIdx += 1;
            }

            let subLowMask = subLowMasksSmooth[frameIdx];
            let lowMask = lowMasksSmooth[frameIdx];
            let midMask = midMasksSmooth[frameIdx];
            let highMask = highMasksSmooth[frameIdx];
            let highProtectBoost = highProtectBoostByFrame[frameIdx];
            if (frameIdx + 1 < frameCount) {
                const c0 = centers[frameIdx];
                const c1 = centers[frameIdx + 1];
                const t = c1 > c0 ? (j - c0) / (c1 - c0) : 0;
                subLowMask = (subLowMasksSmooth[frameIdx] * (1 - t)) + (subLowMasksSmooth[frameIdx + 1] * t);
                lowMask = (lowMasksSmooth[frameIdx] * (1 - t)) + (lowMasksSmooth[frameIdx + 1] * t);
                midMask = (midMasksSmooth[frameIdx] * (1 - t)) + (midMasksSmooth[frameIdx + 1] * t);
                highMask = (highMasksSmooth[frameIdx] * (1 - t)) + (highMasksSmooth[frameIdx + 1] * t);
                highProtectBoost = (highProtectBoostByFrame[frameIdx] * (1 - t)) + (highProtectBoostByFrame[frameIdx + 1] * t);
            }

            const mi = mixStart + j;
            const si = stemStart + j;
            const x = mix.samples[mi] / INT16_MAX;
            mixSubLowState += alphaSubLow * (x - mixSubLowState);
            mixLowState += alphaLow * (x - mixLowState);
            mixHighLpState += alphaHighLp * (x - mixHighLpState);
            const xSubLow = mixSubLowState;
            const xLow = mixLowState - mixSubLowState;
            const xHigh = x - mixHighLpState;
            const xMid = x - xSubLow - xLow - xHigh;

            let yV = (xSubLow * subLowMask) + (xLow * lowMask) + (xMid * midMask) + (xHigh * highMask);
            // Blend a small amount of the original separated vocal to preserve fine articulation.
            const vOrig = vocal.samples[si] / INT16_MAX;
            const lowComponentAbs = Math.abs(xSubLow) + Math.abs(xLow);
            const lowProtectBlend = this.clampNumber(0.10 + (lowComponentAbs * 0.10), 0.10, 0.22, 0.12);
            const highProtectEnergyBoost = this.clampNumber(
                Math.max(0, Math.abs(xHigh) - 0.018) * (0.040 + (highProtectBoost * 0.40)),
                0,
                0.038,
                0,
            );
            // 高域保護ブレンド強化 — 音抜け・音割れ・反響の自動補正に使用
            const highProtectBlend = this.clampNumber(
                0.06 + (Math.abs(xHigh) * 0.12) + Math.max(0, 0.38 - highMask) * 0.12,
                0.06,
                0.18,
                0.08,
            ) + this.clampNumber(highProtectBoost + highProtectEnergyBoost, 0, 0.12, 0);
            const highProtectBlendClamped = this.clampNumber(
                highProtectBlend,
                0.06,
                0.26,
                0.08,
            );
            const protectBlend = this.clampNumber(Math.max(lowProtectBlend, highProtectBlendClamped), 0.10, 0.30, 0.14);
            yV = (yV * (1 - protectBlend)) + (vOrig * protectBlend);
            yV = Math.tanh(yV * 1.04) / Math.tanh(1.04);
            // 音抜け自動補正: voiceLike区間で出力が原音の28%未満かつ混合音高域あり → 原音をブレンド
            const isVoicedProxy = highMask >= 0.25;
            if (isVoicedProxy) {
                const yVAbs = Math.abs(yV);
                const vOrigAbs = Math.abs(vOrig);
                if (vOrigAbs > 0.018 && yVAbs < vOrigAbs * 0.28 && Math.abs(xHigh) > 0.010) {
                    const dropoutSeverity = this.clampNumber(
                        1 - (yVAbs / Math.max(vOrigAbs * 0.28, 1e-9)),
                        0, 0.42, 0,
                    );
                    yV = (yV * (1 - dropoutSeverity)) + (vOrig * dropoutSeverity);
                    yV = Math.tanh(yV * 1.02) / Math.tanh(1.02);
                }
            }
            const yA = x - yV;

            protectBlendSum += protectBlend;
            const highProtectBoostApplied = this.clampNumber(highProtectBoost + highProtectEnergyBoost, 0, 0.12, 0);
            highProtectBoostAppliedSum += highProtectBoostApplied;
            if (highProtectBoostApplied >= 0.012) {
                highProtectBoostAppliedCount += 1;
            }

            outVocal[si] = this.clampInt16(Math.round(yV * INT16_MAX));
            outAcc[si] = this.clampInt16(Math.round(yA * INT16_MAX));
        }

        this.writeMonoPcm16Wav(outputVocalPath, sr, outVocal);
        if (outputAccompanimentPath) this.writeMonoPcm16Wav(outputAccompanimentPath, sr, outAcc);

        return {
            frameCount,
            estimatedLagSamples: lagSamples,
            estimatedLagMs: this.roundNumber((lagSamples / sr) * 1000, 2),
            avgSubLowMask: this.roundNumber(subLowMaskSum / Math.max(1, frameCount), 4),
            avgLowMask: this.roundNumber(lowMaskSum / Math.max(1, frameCount), 4),
            avgMidMask: this.roundNumber(midMaskSum / Math.max(1, frameCount), 4),
            avgHighMask: this.roundNumber(highMaskSum / Math.max(1, frameCount), 4),
            avgHighMaskDelta: this.roundNumber(highMaskDeltaSum / Math.max(1, frameCount - 1), 4),
            maxHighMaskDelta: this.roundNumber(highMaskDeltaMax, 4),
            highMaskDeltaLimitedFrames,
            avgHighSmoothBlend: this.roundNumber(highSmoothBlendSum / Math.max(1, frameCount), 4),
            highStrongSmoothFrames,
            avgProtectBlend: this.roundNumber(protectBlendSum / Math.max(1, n), 4),
            avgHighProtectBoost: this.roundNumber(highProtectBoostAppliedSum / Math.max(1, n), 4),
            highProtectBoostRatio: this.roundNumber(highProtectBoostAppliedCount / Math.max(1, n), 4),
            avgVibratoProxy: this.roundNumber(vibratoProxySum / Math.max(1, frameCount), 4),
            vibratoGuardFrames,
            bgmOnlySuppressedFrames,
            lowBgmPriorityFrames,
            lowBleedGuardFrames,
            outputDurationMs: Math.round((outVocal.length / sr) * 1000),
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

    private static estimateMixtureLagSamples(
        mixture: Int16Array,
        vocal: Int16Array,
        accompaniment: Int16Array,
        maxLagSamples: number,
    ): number {
        const stemLen = Math.min(vocal.length, accompaniment.length);
        const n = Math.min(mixture.length, stemLen);
        if (n < 4096) {
            return 0;
        }
        const scanLen = Math.min(n, 44100 * 18);
        const startMix = Math.max(0, Math.floor((mixture.length - scanLen) / 2));
        const startStem = Math.max(0, Math.floor((stemLen - scanLen) / 2));
        const stride = Math.max(1, Math.floor(scanLen / 9000));
        const scoreLag = (lag: number): number => {
            let sumXY = 0;
            let sumXX = 0;
            let sumYY = 0;
            let count = 0;
            for (let j = 0; j < scanLen; j += stride) {
                const mixIdx = startMix + j;
                const stemIdx = startStem + j + lag;
                if (mixIdx < 0 || mixIdx >= mixture.length || stemIdx < 0 || stemIdx >= stemLen) {
                    continue;
                }
                const x = mixture[mixIdx] / INT16_MAX;
                const y = (vocal[stemIdx] + accompaniment[stemIdx]) / INT16_MAX;
                sumXY += x * y;
                sumXX += x * x;
                sumYY += y * y;
                count += 1;
            }
            if (count < 128 || sumXX <= 1e-9 || sumYY <= 1e-9) {
                return -Infinity;
            }
            const corr = sumXY / Math.sqrt(sumXX * sumYY);
            const lagPenalty = Math.abs(lag) * 0.00002;
            return corr - lagPenalty;
        };

        let bestLag = 0;
        let bestScore = -Infinity;
        const coarseStep = Math.max(4, Math.min(32, Math.round(maxLagSamples / 96)));
        for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += coarseStep) {
            const score = scoreLag(lag);
            if (score > bestScore) {
                bestScore = score;
                bestLag = lag;
            }
        }

        const fineRadius = Math.max(coarseStep * 2, 12);
        const fineStart = Math.max(-maxLagSamples, bestLag - fineRadius);
        const fineEnd = Math.min(maxLagSamples, bestLag + fineRadius);
        for (let lag = fineStart; lag <= fineEnd; lag += 1) {
            const score = scoreLag(lag);
            if (score > bestScore) {
                bestScore = score;
                bestLag = lag;
            }
        }
        return bestLag;
    }

    private static clampNumber(value: number, min: number, max: number, fallback: number): number {
        if (!Number.isFinite(value)) return fallback;
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }
}
