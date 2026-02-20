import { VoicePipelineMode, VoiceSynthesizeResult } from './rvc';

export type CharacterEmotionLabel = 'neutral' | 'joy' | 'sad' | 'angry' | 'excited';

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

export interface CharacterPersonaSettings {
    nameKanji?: string;
    nameKana?: string;
    // Backward compatibility with older payloads.
    name?: string;
    firstPerson?: string;
    personaNote?: string;
    speakingStyleNote?: string;
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
}

export interface CharacterChatRequest {
    sessionId?: string;
    characterId?: string;
    text: string;
    withVoice?: boolean;
    voice?: CharacterVoiceRequest;
    settings?: CharacterConversationSettings;
}

export interface CharacterChatResponse {
    success: boolean;
    sessionId: string;
    turnId?: string;
    characterId?: string;
    responseText?: string;
    emotion?: CharacterEmotionResult;
    voice?: VoiceSynthesizeResult;
    error?: string;
}
