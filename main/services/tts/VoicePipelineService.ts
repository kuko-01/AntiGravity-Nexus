import { app } from 'electron';
import * as path from 'path';
import { Sbv2Service } from './Sbv2Service';
import { RvcService } from './RvcService';
import { VoiceSynthesizeParams, VoiceSynthesizeResult } from '../../../types/rvc';

/**
 * VoicePipelineService
 * Orchestrates SBV2-only, RVC-only, and SBV2+RVC synthesis paths.
 */
export class VoicePipelineService {
    private static instance: VoicePipelineService | null = null;

    private sbv2: Sbv2Service;
    private rvc: RvcService;

    private constructor(resourcesPath: string) {
        this.sbv2 = Sbv2Service.getInstance(resourcesPath);
        this.rvc = RvcService.getInstance(resourcesPath);
    }

    static getInstance(resourcesPath?: string): VoicePipelineService {
        if (!VoicePipelineService.instance) {
            const resPath = resourcesPath || (
                app.isPackaged
                    ? process.resourcesPath
                    : path.join(__dirname, '../../../resources')
            );
            VoicePipelineService.instance = new VoicePipelineService(resPath);
        }
        return VoicePipelineService.instance;
    }

    async synthesize(params: VoiceSynthesizeParams): Promise<VoiceSynthesizeResult> {
        const startedAt = Date.now();

        try {
            switch (params.mode) {
                case 'sbv2': {
                    const sbv2Started = Date.now();
                    const sbv2Result = await this.sbv2.synthesize({
                        text: params.text,
                        ...(params.sbv2 || {}),
                    });

                    if (!sbv2Result.success) {
                        return {
                            success: false,
                            error: {
                                code: sbv2Result.error?.code || 'E_SERVER_FAILED',
                                message: sbv2Result.error?.message || 'SBV2 synthesis failed',
                            },
                        };
                    }

                    return {
                        success: true,
                        wavPath: sbv2Result.wavPath,
                        audioBase64: sbv2Result.audioBase64,
                        durationMs: sbv2Result.durationMs,
                        sampleRate: sbv2Result.sampleRate,
                        stages: {
                            sbv2Ms: Date.now() - sbv2Started,
                            totalMs: Date.now() - startedAt,
                        },
                    };
                }

                case 'rvc': {
                    if (!params.rvc?.inputPath && !params.rvc?.inputBase64) {
                        return {
                            success: false,
                            error: {
                                code: 'E_CONVERT_FAILED',
                                message: 'RVC mode requires inputPath or inputBase64',
                            },
                        };
                    }

                    const rvcStarted = Date.now();
                    const rvcResult = await this.rvc.convert(params.rvc);

                    if (!rvcResult.success) {
                        return {
                            success: false,
                            error: {
                                code: rvcResult.error?.code || 'E_CONVERT_FAILED',
                                message: rvcResult.error?.message || 'RVC conversion failed',
                            },
                        };
                    }

                    return {
                        success: true,
                        wavPath: rvcResult.wavPath,
                        audioBase64: rvcResult.audioBase64,
                        durationMs: rvcResult.durationMs,
                        sampleRate: rvcResult.sampleRate,
                        stages: {
                            rvcMs: Date.now() - rvcStarted,
                            totalMs: Date.now() - startedAt,
                        },
                    };
                }

                case 'sbv2+rvc': {
                    const sbv2Started = Date.now();
                    const sbv2Result = await this.sbv2.synthesize({
                        text: params.text,
                        ...(params.sbv2 || {}),
                    });

                    if (!sbv2Result.success) {
                        return {
                            success: false,
                            error: {
                                code: sbv2Result.error?.code || 'E_SERVER_FAILED',
                                message: sbv2Result.error?.message || 'SBV2 stage failed',
                            },
                        };
                    }

                    const rvcStarted = Date.now();
                    const rvcResult = await this.rvc.convert({
                        ...(params.rvc || {}),
                        inputPath: params.rvc?.inputPath || sbv2Result.wavPath,
                        inputBase64: params.rvc?.inputPath ? params.rvc?.inputBase64 : undefined,
                    });

                    if (!rvcResult.success) {
                        return {
                            success: false,
                            intermediateWavPath: sbv2Result.wavPath,
                            error: {
                                code: rvcResult.error?.code || 'E_CONVERT_FAILED',
                                message: rvcResult.error?.message || 'RVC stage failed',
                            },
                        };
                    }

                    return {
                        success: true,
                        wavPath: rvcResult.wavPath,
                        audioBase64: rvcResult.audioBase64,
                        durationMs: rvcResult.durationMs,
                        sampleRate: rvcResult.sampleRate,
                        intermediateWavPath: sbv2Result.wavPath,
                        stages: {
                            sbv2Ms: rvcStarted - sbv2Started,
                            rvcMs: Date.now() - rvcStarted,
                            totalMs: Date.now() - startedAt,
                        },
                    };
                }

                default:
                    return {
                        success: false,
                        error: {
                            code: 'E_UNKNOWN',
                            message: `Unsupported mode: ${String(params.mode)}`,
                        },
                    };
            }
        } catch (error) {
            return {
                success: false,
                error: {
                    code: 'E_UNKNOWN',
                    message: error instanceof Error ? error.message : String(error),
                },
            };
        }
    }
}
