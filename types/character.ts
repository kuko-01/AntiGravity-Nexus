import {
    VoiceExpressionSettings,
    VoiceOutputSettings,
    VoicePipelineMode,
    VoiceSynthesizeResult,
} from './rvc';

export type CharacterEmotionLabel =
    | 'neutral' | 'joy' | 'sad' | 'angry' | 'excited'
    | 'fear' | 'surprise' | 'love' | 'embarrassed' | 'curious';

export interface CharacterEmotionResult {
    label: CharacterEmotionLabel;
    intensity: number;
}

export interface CharacterProfile {
    id: string;
    name: string;
    personaVersion: string;
    styleKeywords: string[];
    responseLengthPolicy: string;
    systemPrompt: string;
}

export interface CharacterChatTurn {
    role: 'user' | 'assistant';
    text: string;
    createdAt: string;
    emotion?: CharacterEmotionResult;
}

/** Per-character emotion personality profile. Controls emotion intensity and baseline. */
export interface CharacterEmotionPersonality {
    /** Overall intensity multiplier: 0.5 = subdued, 1.0 = standard, 1.5 = expressive */
    intensityScale?: number;
    /** How quickly emotions shift between turns: 0.1 = very stable, 0.5 = volatile */
    volatility?: number;
    /** Per-label baseline offset applied before lexicon matching (-0.2 to +0.2) */
    baselineBias?: Partial<Record<CharacterEmotionLabel, number>>;
}

export interface CharacterPersonaSettings {
    nameKanji?: string;
    nameKana?: string;
    // Backward compatibility with older payloads.
    name?: string;
    firstPerson?: string;
    personaNote?: string;
    speakingStyleNote?: string;
    emotionPersonality?: CharacterEmotionPersonality;
}

export interface UserPersonaSettings {
    name?: string;
    callName?: string;
    profileNote?: string;
}

export interface CharacterConversationSettings {
    character?: CharacterPersonaSettings;
    user?: UserPersonaSettings;
}

export interface CharacterLearningRequest {
    singingTrainingMode?: boolean;
    separationPreference?: 'auto' | 'uvr-ultimate' | 'roformer' | 'demucs' | 'uvr5' | 'ffmpeg-fallback';
    ytDlpCookiesFile?: string;
}

export interface CharacterLearningResult {
    success: boolean;
    sourceUrl?: string;
    runDir?: string;
    sourceAudioPath?: string;
    vocalWavPath?: string;
    accompanimentWavPath?: string;
    datasetInputPath?: string;
    method?: 'uvr-ultimate' | 'roformer' | 'uvr5' | 'demucs' | 'ffmpeg-fallback';
    warning?: string;
    error?: string;
}

export interface CharacterVoiceRequest {
    mode?: VoicePipelineMode;
    sbv2?: {
        modelId?: string;
        style?: string;
        speed?: number;
        pitch?: number;
        intonation?: number;
        styleWeight?: number;
        sdpRatio?: number;
        noiseScale?: number;
        noiseScaleW?: number;
        assistText?: string;
        assistTextWeight?: number;
        postFilter?: boolean;
        filterStrength?: number;
        preserveLineBreaks?: boolean;
        chunkPauseMs?: number;
        lineSplit?: boolean;
        splitInterval?: number;
    };
    rvc?: {
        modelId?: string;
        indexPath?: string;
        speakerId?: number;
        f0Method?: 'rmvpe' | 'harvest' | 'crepe';
        transpose?: number;
        indexRate?: number;
        protect?: number;
        filterRadius?: number;
        rmsMixRate?: number;
        resampleSr?: number;
    };
    expression?: VoiceExpressionSettings;
    output?: VoiceOutputSettings;
}

export interface CharacterChatRequest {
    sessionId?: string;
    characterId?: string;
    text: string;
    withVoice?: boolean;
    voice?: CharacterVoiceRequest;
    settings?: CharacterConversationSettings;
    learning?: CharacterLearningRequest;
}

export interface CharacterChatResponse {
    success: boolean;
    sessionId: string;
    turnId?: string;
    characterId?: string;
    responseText?: string;
    emotion?: CharacterEmotionResult;
    voice?: VoiceSynthesizeResult;
    learning?: CharacterLearningResult;
    error?: string;
}
