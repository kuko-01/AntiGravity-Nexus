import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CharacterChatResponse, CharacterConversationSettings, CharacterEmotionPersonality } from '../../types/character';
import type { RvcModel } from '../../types/rvc';
import type { TtsModel } from '../../types/tts';
import type { AudioProcess, CharacterLearningSeparationProfileResponse } from '../../types';
import { WaveformEditor } from '../components/WaveformEditor';

type MessageRole = 'user' | 'assistant' | 'system';

interface ChatMessage {
    id: string;
    role: MessageRole;
    text: string;
    emotionLabel?: string;
    emotionIntensity?: number;
    voiceSnapshot?: string;
}

interface StoredCharacterVoiceSettings {
    voiceEnabled?: boolean;
    audioVolume?: number;
    mode?: 'sbv2' | 'sbv2+rvc';
    sbv2ModelId?: string;
    sbv2Style?: string;
    rvcModelId?: string;
    rvcSpeakerId?: number;
    rvcIndexPath?: string;
}

interface StoredCharacterProfile {
    nameKanji?: string;
    nameKana?: string;
    firstPerson?: string;
    personaNote?: string;
    speakingStyleNote?: string;
    emotionPersonality?: CharacterEmotionPersonality;
    voice?: StoredCharacterVoiceSettings;
    voiceEnhance?: StoredVoiceEnhanceSettings;
    updatedAt?: string;
}

interface LegacyStoredCharacterProfile {
    name?: string;
    nameKanji?: string;
    nameKana?: string;
    firstPerson?: string;
    personaNote?: string;
    speakingStyleNote?: string;
    voice?: StoredCharacterVoiceSettings;
    voiceEnhance?: StoredVoiceEnhanceSettings;
    updatedAt?: string;
}

interface StoredUserProfile {
    name?: string;
    callName?: string;
    profileNote?: string;
}

interface StoredVoiceEnhanceSettings {
    singingTrainingMode?: boolean;
    separationPreference?: 'auto' | 'uvr-ultimate' | 'demucs' | 'uvr5' | 'ffmpeg-fallback';
    forceSingingMode?: boolean;
    autoEmotionRefine?: boolean;
    enhanceFinalAudio?: boolean;
    autoAnalyzeAndEnhance?: boolean;
    emotionLabelHint?: 'auto' | 'neutral' | 'joy' | 'sad' | 'angry' | 'excited'
        | 'fear' | 'surprise' | 'love' | 'embarrassed' | 'curious';
    useEmotionIntensityHint?: boolean;
    emotionIntensityHint?: number;
    ytDlpCookiesFile?: string;
}

type SeparationMethodId = 'uvr-ultimate' | 'demucs' | 'uvr5' | 'ffmpeg-fallback';

const DEFAULT_CHARACTER_ID = 'aozuki_fox_v1';
const SEPARATION_METHOD_ORDER: SeparationMethodId[] = ['uvr-ultimate', 'demucs', 'uvr5', 'ffmpeg-fallback'];
const SEPARATION_METHOD_LABELS: Record<SeparationMethodId, string> = {
    'uvr-ultimate': 'UVR Ultimate',
    demucs: 'Demucs',
    uvr5: 'UVR5',
    'ffmpeg-fallback': 'FFmpeg fallback',
};
const DEFAULT_CHARACTER_PROFILE: StoredCharacterProfile = {
    nameKanji: '蒼月キツネ案内人',
    nameKana: 'あおつききつねあんないにん',
    firstPerson: 'わたし',
    personaNote: '',
    speakingStyleNote: '',
};
const EMOTION_PERSONALITY_PRESETS: Record<string, CharacterEmotionPersonality> = {
    standard: { intensityScale: 1.0, volatility: 0.3 },
    cheerful: { intensityScale: 1.2, volatility: 0.35, baselineBias: { joy: 0.08, excited: 0.06, sad: -0.04, angry: -0.04 } },
    gentle: { intensityScale: 0.9, volatility: 0.2, baselineBias: { love: 0.08, curious: 0.06, angry: -0.06, fear: -0.04 } },
    shy: { intensityScale: 0.85, volatility: 0.25, baselineBias: { embarrassed: 0.10, fear: 0.06, angry: -0.08 } },
    stoic: { intensityScale: 0.6, volatility: 0.15, baselineBias: { neutral: 0.12, excited: -0.06, love: -0.04 } },
};
const createSessionId = () => `char_ui_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const DEFAULT_RVC_SPEAKER_COUNT = 8;
const APP_INPUT_TRANSCRIBE_INTERVAL_MS = 10_000;
const APP_INPUT_MIN_SEGMENT_SEC = 3;
const LEGACY_SETTINGS_STORAGE_KEY = 'character_studio_settings_v1';
const CHARACTER_PROFILES_STORAGE_KEY = 'character_studio_profiles_v1';
const USER_PROFILE_STORAGE_KEY = 'character_studio_user_profile_v1';
const LAST_CHARACTER_ID_STORAGE_KEY = 'character_studio_last_character_id_v1';
const VOICE_ENHANCE_STORAGE_KEY = 'character_studio_voice_enhance_v1';
const DEFAULT_CHARACTER_VOICE_SETTINGS: StoredCharacterVoiceSettings = {
    voiceEnabled: true,
    audioVolume: 0.9,
    mode: 'sbv2+rvc',
    sbv2ModelId: '',
    sbv2Style: 'ノーマル',
    rvcModelId: '',
    rvcSpeakerId: 0,
    rvcIndexPath: '',
};
const DEFAULT_VOICE_ENHANCE_SETTINGS: StoredVoiceEnhanceSettings = {
    singingTrainingMode: false,
    separationPreference: 'auto',
    forceSingingMode: false,
    autoEmotionRefine: true,
    enhanceFinalAudio: true,
    autoAnalyzeAndEnhance: true,
    emotionLabelHint: 'auto',
    useEmotionIntensityHint: false,
    emotionIntensityHint: 0.55,
};

const CharacterStudioScreen: React.FC = () => {
    const navigate = useNavigate();

    const [sessionId, setSessionId] = useState<string>(createSessionId());
    const [characterId, setCharacterId] = useState<string>(DEFAULT_CHARACTER_ID);
    const [characterIdDraft, setCharacterIdDraft] = useState<string>('');
    const [characterNameKanji, setCharacterNameKanji] = useState<string>(DEFAULT_CHARACTER_PROFILE.nameKanji || '');
    const [characterNameKana, setCharacterNameKana] = useState<string>(DEFAULT_CHARACTER_PROFILE.nameKana || '');
    const [characterFirstPerson, setCharacterFirstPerson] = useState<string>(DEFAULT_CHARACTER_PROFILE.firstPerson || 'わたし');
    const [characterPersonaNote, setCharacterPersonaNote] = useState<string>('');
    const [characterSpeakingStyleNote, setCharacterSpeakingStyleNote] = useState<string>('');
    const [emotionPersonalityPreset, setEmotionPersonalityPreset] = useState<string>('standard');
    const [emotionIntensityScale, setEmotionIntensityScale] = useState<number>(1.0);
    const [emotionVolatility, setEmotionVolatility] = useState<number>(0.3);
    const [userName, setUserName] = useState<string>('');
    const [userCallName, setUserCallName] = useState<string>('');
    const [userProfileNote, setUserProfileNote] = useState<string>('');
    const [characterProfiles, setCharacterProfiles] = useState<Record<string, StoredCharacterProfile>>({});
    const [isStorageHydrated, setIsStorageHydrated] = useState<boolean>(false);
    const [profileStatus, setProfileStatus] = useState<string>('');
    const [inputText, setInputText] = useState<string>('');
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isSending, setIsSending] = useState<boolean>(false);
    const [lastError, setLastError] = useState<string>('');
    const [copyStatus, setCopyStatus] = useState<string>('');
    const [separationProfile, setSeparationProfile] = useState<CharacterLearningSeparationProfileResponse | null>(null);
    const [separationProfileStatus, setSeparationProfileStatus] = useState<string>('');
    const [isSeparationProfileLoading, setIsSeparationProfileLoading] = useState<boolean>(false);
    const [isSeparationProfileResetting, setIsSeparationProfileResetting] = useState<boolean>(false);

    const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);
    const [voiceMode, setVoiceMode] = useState<'sbv2' | 'sbv2+rvc'>('sbv2+rvc');
    const [singingTrainingMode, setSingingTrainingMode] = useState<boolean>(DEFAULT_VOICE_ENHANCE_SETTINGS.singingTrainingMode === true);
    const [singingSeparationPreference, setSingingSeparationPreference] = useState<'auto' | 'uvr-ultimate' | 'demucs' | 'uvr5' | 'ffmpeg-fallback'>(
        DEFAULT_VOICE_ENHANCE_SETTINGS.separationPreference || 'auto',
    );
    const [ytDlpCookiesFile, setYtDlpCookiesFile] = useState<string>('');
    const [forceSingingMode, setForceSingingMode] = useState<boolean>(DEFAULT_VOICE_ENHANCE_SETTINGS.forceSingingMode || false);
    const [autoEmotionRefine, setAutoEmotionRefine] = useState<boolean>(DEFAULT_VOICE_ENHANCE_SETTINGS.autoEmotionRefine !== false);
    const [enhanceFinalAudio, setEnhanceFinalAudio] = useState<boolean>(DEFAULT_VOICE_ENHANCE_SETTINGS.enhanceFinalAudio !== false);
    const [autoAnalyzeAndEnhance, setAutoAnalyzeAndEnhance] = useState<boolean>(DEFAULT_VOICE_ENHANCE_SETTINGS.autoAnalyzeAndEnhance !== false);
    const [emotionLabelHint, setEmotionLabelHint] = useState<
        'auto' | 'neutral' | 'joy' | 'sad' | 'angry' | 'excited' | 'fear' | 'surprise' | 'love' | 'embarrassed' | 'curious'
    >(DEFAULT_VOICE_ENHANCE_SETTINGS.emotionLabelHint || 'auto');
    const [useEmotionIntensityHint, setUseEmotionIntensityHint] = useState<boolean>(DEFAULT_VOICE_ENHANCE_SETTINGS.useEmotionIntensityHint || false);
    const [emotionIntensityHint, setEmotionIntensityHint] = useState<number>(DEFAULT_VOICE_ENHANCE_SETTINGS.emotionIntensityHint || 0.55);
    const [sbv2ModelId, setSbv2ModelId] = useState<string>('');
    const [sbv2Style, setSbv2Style] = useState<string>('ノーマル');
    const [rvcModelId, setRvcModelId] = useState<string>('');
    const [rvcSpeakerId, setRvcSpeakerId] = useState<number>(0);
    const [rvcIndexPath, setRvcIndexPath] = useState<string>('');
    const [audioVolume, setAudioVolume] = useState<number>(0.9);
    const [ttsModels, setTtsModels] = useState<TtsModel[]>([]);
    const [rvcModels, setRvcModels] = useState<RvcModel[]>([]);
    const [rvcIndexOptions, setRvcIndexOptions] = useState<string[]>([]);
    const [rvcSpeakerCount, setRvcSpeakerCount] = useState<number>(DEFAULT_RVC_SPEAKER_COUNT);

    // Dialogue Extract state
    const [dialogueUrl, setDialogueUrl] = useState('');
    const [dialogueDetectedTs, setDialogueDetectedTs] = useState<number | null>(null);
    const [dialogueStartOverride, setDialogueStartOverride] = useState('');
    const [dialogueDuration, setDialogueDuration] = useState(10);
    const [isDialogueExtracting, setIsDialogueExtracting] = useState(false);
    const [dialogueExtractStatus, setDialogueExtractStatus] = useState('');
    const [waveformEditorData, setWaveformEditorData] = useState<{ base64?: string; fileName: string } | null>(null);
    const [appAudioInputEnabled, setAppAudioInputEnabled] = useState(false);
    const [appAudioCaptureRunning, setAppAudioCaptureRunning] = useState(false);
    const [appAudioInputStatus, setAppAudioInputStatus] = useState('');
    const [audioProcesses, setAudioProcesses] = useState<AudioProcess[]>([]);
    const [selectedAppProcessPid, setSelectedAppProcessPid] = useState<number | null>(null);
    const [isRefreshingAudioProcesses, setIsRefreshingAudioProcesses] = useState(false);

    const chatScrollRef = useRef<HTMLDivElement | null>(null);
    const appInputCaptureActiveRef = useRef(false);
    const appInputCaptureTranscribingRef = useRef(false);
    const appInputLastTranscribedSamplesRef = useRef(0);
    const appInputLastTranscribeTimeRef = useRef(0);

    const apiAvailable = useMemo(() => Boolean(window.electronAPI?.characterChatSend), []);
    const selectedSbv2Model = useMemo(
        () => ttsModels.find((model) => model.id === sbv2ModelId),
        [ttsModels, sbv2ModelId],
    );
    const sbv2StyleOptions = useMemo(() => {
        const styles = Array.isArray(selectedSbv2Model?.styles)
            ? selectedSbv2Model.styles.filter((style) => Boolean(style?.trim()))
            : [];
        if (styles.length === 0 && sbv2Style.trim()) {
            return [sbv2Style.trim()];
        }
        if (sbv2Style.trim() && !styles.includes(sbv2Style)) {
            return [sbv2Style, ...styles];
        }
        return styles;
    }, [selectedSbv2Model, sbv2Style]);
    const rvcSpeakerOptions = useMemo(() => {
        const count = Math.max(1, Math.min(128, rvcSpeakerCount || 1));
        return Array.from({ length: count }, (_unused, index) => index);
    }, [rvcSpeakerCount]);
    const characterIdOptions = useMemo(() => {
        const merged = new Set<string>([DEFAULT_CHARACTER_ID]);
        const current = characterId.trim();
        if (current) {
            merged.add(current);
        }
        for (const id of Object.keys(characterProfiles)) {
            const trimmed = id.trim();
            if (trimmed) merged.add(trimmed);
        }
        return Array.from(merged).sort((a, b) => a.localeCompare(b));
    }, [characterId, characterProfiles]);
    const sortedAudioProcesses = useMemo(() => (
        [...audioProcesses].sort((a, b) => {
            const titleA = String(a.title || '').trim();
            const titleB = String(b.title || '').trim();
            if (titleA && titleB) return titleA.localeCompare(titleB);
            if (titleA) return -1;
            if (titleB) return 1;
            return String(a.name || '').localeCompare(String(b.name || ''));
        })
    ), [audioProcesses]);
    const hasSavedProfileForCurrentCharacter = useMemo(
        () => Boolean(characterProfiles[characterId.trim()]),
        [characterProfiles, characterId],
    );
    const separationProfileMethods = useMemo(() => {
        const methods = separationProfile?.methods;
        if (!Array.isArray(methods) || methods.length === 0) {
            return [];
        }
        const byMethod = new Map(methods.map((method) => [method.method, method]));
        return SEPARATION_METHOD_ORDER
            .map((method) => byMethod.get(method))
            .filter((method): method is NonNullable<typeof method> => Boolean(method));
    }, [separationProfile]);
    const resolvedEmotionPersonality = useMemo<CharacterEmotionPersonality>(() => {
        const preset = EMOTION_PERSONALITY_PRESETS[emotionPersonalityPreset] || EMOTION_PERSONALITY_PRESETS.standard;
        return {
            ...preset,
            intensityScale: emotionIntensityScale,
            volatility: emotionVolatility,
        };
    }, [emotionPersonalityPreset, emotionIntensityScale, emotionVolatility]);

    const conversationSettings = useMemo<CharacterConversationSettings>(() => ({
        character: {
            nameKanji: characterNameKanji.trim() || undefined,
            nameKana: characterNameKana.trim() || undefined,
            // Backward-compatible field
            name: characterNameKanji.trim() || undefined,
            firstPerson: characterFirstPerson.trim() || undefined,
            personaNote: characterPersonaNote.trim() || undefined,
            speakingStyleNote: characterSpeakingStyleNote.trim() || undefined,
            emotionPersonality: resolvedEmotionPersonality,
        },
        user: {
            name: userName.trim() || undefined,
            callName: userCallName.trim() || undefined,
            profileNote: userProfileNote.trim() || undefined,
        },
    }), [
        characterNameKanji,
        characterNameKana,
        characterFirstPerson,
        characterPersonaNote,
        characterSpeakingStyleNote,
        resolvedEmotionPersonality,
        userName,
        userCallName,
        userProfileNote,
    ]);

    const normalizeVoiceEnhanceSettings = (
        settings: StoredVoiceEnhanceSettings | undefined,
    ): StoredVoiceEnhanceSettings => {
        const VALID_EMOTION_HINTS = [
            'auto', 'neutral', 'joy', 'sad', 'angry', 'excited',
            'fear', 'surprise', 'love', 'embarrassed', 'curious',
        ] as const;
        const nextEmotionLabelHint = VALID_EMOTION_HINTS.includes(settings?.emotionLabelHint as typeof VALID_EMOTION_HINTS[number])
            ? settings!.emotionLabelHint!
            : (DEFAULT_VOICE_ENHANCE_SETTINGS.emotionLabelHint || 'auto');
        const nextEmotionIntensityHintRaw = Number(settings?.emotionIntensityHint);
        const nextEmotionIntensityHint = Number.isFinite(nextEmotionIntensityHintRaw)
            ? Math.max(0, Math.min(1, nextEmotionIntensityHintRaw))
            : (DEFAULT_VOICE_ENHANCE_SETTINGS.emotionIntensityHint || 0.55);
        const nextSeparationPreference = (
            settings?.separationPreference === 'auto'
            || settings?.separationPreference === 'uvr-ultimate'
            || settings?.separationPreference === 'demucs'
            || settings?.separationPreference === 'uvr5'
            || settings?.separationPreference === 'ffmpeg-fallback'
        )
            ? settings.separationPreference
            : (DEFAULT_VOICE_ENHANCE_SETTINGS.separationPreference || 'auto');
        return {
            singingTrainingMode: settings?.singingTrainingMode === true,
            separationPreference: nextSeparationPreference,
            ytDlpCookiesFile: typeof settings?.ytDlpCookiesFile === 'string' ? settings.ytDlpCookiesFile : '',
            forceSingingMode: settings?.forceSingingMode === true,
            autoEmotionRefine: settings?.autoEmotionRefine !== false,
            enhanceFinalAudio: settings?.enhanceFinalAudio !== false,
            autoAnalyzeAndEnhance: settings?.autoAnalyzeAndEnhance !== false,
            emotionLabelHint: nextEmotionLabelHint,
            useEmotionIntensityHint: settings?.useEmotionIntensityHint === true,
            emotionIntensityHint: nextEmotionIntensityHint,
        };
    };

    const applyVoiceEnhanceSettings = (settings?: StoredVoiceEnhanceSettings) => {
        const normalized = normalizeVoiceEnhanceSettings(settings);
        setSingingTrainingMode(normalized.singingTrainingMode === true);
        setSingingSeparationPreference(normalized.separationPreference || 'auto');
        setYtDlpCookiesFile(normalized.ytDlpCookiesFile || '');
        setForceSingingMode(normalized.forceSingingMode || false);
        setAutoEmotionRefine(normalized.autoEmotionRefine !== false);
        setEnhanceFinalAudio(normalized.enhanceFinalAudio !== false);
        setAutoAnalyzeAndEnhance(normalized.autoAnalyzeAndEnhance !== false);
        setEmotionLabelHint(normalized.emotionLabelHint || 'auto');
        setUseEmotionIntensityHint(normalized.useEmotionIntensityHint || false);
        setEmotionIntensityHint(Math.max(0, Math.min(1, normalized.emotionIntensityHint || 0.55)));
    };

    const buildVoiceEnhanceSettingsFromState = (): StoredVoiceEnhanceSettings => (
        normalizeVoiceEnhanceSettings({
            singingTrainingMode,
            separationPreference: singingSeparationPreference,
            ytDlpCookiesFile,
            forceSingingMode,
            autoEmotionRefine,
            enhanceFinalAudio,
            autoAnalyzeAndEnhance,
            emotionLabelHint,
            useEmotionIntensityHint,
            emotionIntensityHint,
        })
    );

    const normalizeCharacterVoiceSettings = (
        settings: StoredCharacterVoiceSettings | undefined,
    ): StoredCharacterVoiceSettings => {
        const voiceEnabledSetting = typeof settings?.voiceEnabled === 'boolean'
            ? settings.voiceEnabled
            : (DEFAULT_CHARACTER_VOICE_SETTINGS.voiceEnabled !== false);
        const audioVolumeRaw = Number(settings?.audioVolume);
        const audioVolumeSetting = Number.isFinite(audioVolumeRaw)
            ? Math.max(0, Math.min(1, audioVolumeRaw))
            : (DEFAULT_CHARACTER_VOICE_SETTINGS.audioVolume || 0.9);
        const mode = settings?.mode === 'sbv2' || settings?.mode === 'sbv2+rvc'
            ? settings.mode
            : (DEFAULT_CHARACTER_VOICE_SETTINGS.mode || 'sbv2+rvc');
        const sbv2Model = String(settings?.sbv2ModelId || '').trim();
        const sbv2StyleSetting = String(settings?.sbv2Style || '').trim();
        const rvcModel = String(settings?.rvcModelId || '').trim();
        const rvcIndex = String(settings?.rvcIndexPath || '').trim();
        const speakerRaw = Number(settings?.rvcSpeakerId);
        const rvcSpeaker = Number.isFinite(speakerRaw)
            ? Math.max(0, Math.min(127, Math.floor(speakerRaw)))
            : (DEFAULT_CHARACTER_VOICE_SETTINGS.rvcSpeakerId || 0);

        return {
            voiceEnabled: voiceEnabledSetting,
            audioVolume: audioVolumeSetting,
            mode,
            sbv2ModelId: sbv2Model,
            sbv2Style: sbv2StyleSetting || (DEFAULT_CHARACTER_VOICE_SETTINGS.sbv2Style || 'ノーマル'),
            rvcModelId: rvcModel,
            rvcSpeakerId: rvcSpeaker,
            rvcIndexPath: rvcIndex,
        };
    };

    const buildCharacterVoiceSettingsFromState = (): StoredCharacterVoiceSettings => (
        normalizeCharacterVoiceSettings({
            voiceEnabled,
            audioVolume,
            mode: voiceMode,
            sbv2ModelId,
            sbv2Style,
            rvcModelId,
            rvcSpeakerId,
            rvcIndexPath,
        })
    );

    const applyCharacterVoiceSettings = (settings?: StoredCharacterVoiceSettings) => {
        const normalized = normalizeCharacterVoiceSettings(settings);
        const nextVoiceEnabled = normalized.voiceEnabled !== false;
        const nextAudioVolume = Number.isFinite(normalized.audioVolume)
            ? Math.max(0, Math.min(1, Number(normalized.audioVolume)))
            : 0.9;
        const nextMode = normalized.mode || 'sbv2+rvc';
        const nextSbv2ModelId = normalized.sbv2ModelId || '';
        const nextSbv2Style = normalized.sbv2Style || 'ノーマル';
        const nextRvcModelId = normalized.rvcModelId || '';
        const nextRvcSpeakerId = Number.isFinite(normalized.rvcSpeakerId)
            ? Math.max(0, Math.min(127, Math.floor(Number(normalized.rvcSpeakerId))))
            : 0;
        const nextRvcIndexPath = normalized.rvcIndexPath || '';

        setVoiceEnabled(nextVoiceEnabled);
        setAudioVolume(nextAudioVolume);
        setVoiceMode(nextMode);
        setSbv2ModelId(nextSbv2ModelId);
        setSbv2Style(nextSbv2Style);
        setRvcModelId(nextRvcModelId);
        setRvcSpeakerId(nextRvcSpeakerId);
        setRvcIndexPath(nextRvcIndexPath);

        if (nextRvcModelId) {
            void applyRvcModelMeta(nextRvcModelId, {
                speakerId: nextRvcSpeakerId,
                indexPath: nextRvcIndexPath,
            });
        } else {
            setRvcIndexOptions([]);
            setRvcIndexPath('');
            setRvcSpeakerCount(DEFAULT_RVC_SPEAKER_COUNT);
            setRvcSpeakerId(0);
        }
    };

    const normalizeCharacterProfile = (profile: LegacyStoredCharacterProfile | undefined): StoredCharacterProfile => ({
        nameKanji: String(profile?.nameKanji || profile?.name || '').trim(),
        nameKana: String(profile?.nameKana || '').trim(),
        firstPerson: String(profile?.firstPerson || '').trim(),
        personaNote: String(profile?.personaNote || '').trim(),
        speakingStyleNote: String(profile?.speakingStyleNote || '').trim(),
        voice: profile?.voice
            ? normalizeCharacterVoiceSettings(profile.voice)
            : undefined,
        voiceEnhance: profile?.voiceEnhance
            ? normalizeVoiceEnhanceSettings(profile.voiceEnhance)
            : undefined,
        updatedAt: profile?.updatedAt || new Date().toISOString(),
    });

    const applyCharacterProfile = (profile: StoredCharacterProfile) => {
        setCharacterNameKanji(profile.nameKanji || '');
        setCharacterNameKana(profile.nameKana || '');
        setCharacterFirstPerson(profile.firstPerson || 'わたし');
        setCharacterPersonaNote(profile.personaNote || '');
        setCharacterSpeakingStyleNote(profile.speakingStyleNote || '');
        const ep = profile.emotionPersonality;
        if (ep) {
            setEmotionIntensityScale(typeof ep.intensityScale === 'number' ? Math.max(0.5, Math.min(1.5, ep.intensityScale)) : 1.0);
            setEmotionVolatility(typeof ep.volatility === 'number' ? Math.max(0.1, Math.min(0.5, ep.volatility)) : 0.3);
            setEmotionPersonalityPreset('custom');
        } else {
            setEmotionIntensityScale(1.0);
            setEmotionVolatility(0.3);
            setEmotionPersonalityPreset('standard');
        }
        applyCharacterVoiceSettings(profile.voice || DEFAULT_CHARACTER_VOICE_SETTINGS);
        applyVoiceEnhanceSettings(profile.voiceEnhance || DEFAULT_VOICE_ENHANCE_SETTINGS);
    };

    const applyDefaultCharacterProfile = () => {
        applyCharacterProfile(DEFAULT_CHARACTER_PROFILE);
    };

    const buildCharacterProfileFromState = (): StoredCharacterProfile => ({
        nameKanji: characterNameKanji.trim(),
        nameKana: characterNameKana.trim(),
        firstPerson: characterFirstPerson.trim(),
        personaNote: characterPersonaNote.trim(),
        speakingStyleNote: characterSpeakingStyleNote.trim(),
        emotionPersonality: resolvedEmotionPersonality,
        voice: buildCharacterVoiceSettingsFromState(),
        voiceEnhance: buildVoiceEnhanceSettingsFromState(),
        updatedAt: new Date().toISOString(),
    });

    const saveCharacterProfile = (showStatus: boolean) => {
        const id = characterId.trim();
        if (!id) {
            setLastError('Character ID is required to save profile.');
            return;
        }
        const nextProfile = buildCharacterProfileFromState();
        setCharacterProfiles((prev) => {
            const nextProfiles = {
                ...prev,
                [id]: nextProfile,
            };
            try {
                localStorage.setItem(CHARACTER_PROFILES_STORAGE_KEY, JSON.stringify(nextProfiles));
            } catch {
                // Ignore storage failures.
            }
            return nextProfiles;
        });
        setLastError('');
        if (showStatus) {
            setProfileStatus(`Saved profile: ${id}`);
        }
    };

    const loadCharacterProfile = (showStatus: boolean) => {
        const id = characterId.trim();
        if (!id) {
            setLastError('Character ID is required to load profile.');
            return;
        }
        const profile = characterProfiles[id];
        if (!profile) {
            setLastError(`No saved profile for Character ID: ${id}`);
            return;
        }
        applyCharacterProfile(profile);
        setLastError('');
        if (showStatus) {
            setProfileStatus(`Loaded profile: ${id}`);
        }
    };

    const switchCharacterId = (nextIdRaw: string, options?: { fromSelect?: boolean }) => {
        const nextId = nextIdRaw.trim();
        if (!nextId) {
            setLastError('Character ID is required.');
            return;
        }

        setCharacterId(nextId);
        setProfileStatus('');
        setLastError('');
        const saved = characterProfiles[nextId];
        if (saved) {
            applyCharacterProfile(saved);
            if (options?.fromSelect) {
                setProfileStatus(`Loaded profile: ${nextId}`);
            }
            return;
        }

        if (options?.fromSelect) {
            applyDefaultCharacterProfile();
            setProfileStatus(`No saved profile for ${nextId}. Using defaults.`);
        } else {
            setProfileStatus(`Switched to new Character ID: ${nextId} (save to create profile).`);
        }
    };

    const applyRvcModelMeta = async (
        modelId: string,
        preferred?: { speakerId?: number; indexPath?: string },
    ) => {
        if (!apiAvailable || !modelId) {
            setRvcIndexOptions([]);
            setRvcIndexPath('');
            setRvcSpeakerCount(DEFAULT_RVC_SPEAKER_COUNT);
            setRvcSpeakerId(0);
            return;
        }
        try {
            const [indexFiles, setResult] = await Promise.all([
                window.electronAPI.rvcListModelIndexes(modelId),
                window.electronAPI.rvcSetModel(modelId),
            ]);
            const nextIndexFiles = Array.isArray(indexFiles) ? indexFiles : [];
            setRvcIndexOptions(nextIndexFiles);
            const preferredIndexPath = String(preferred?.indexPath || '').trim();
            setRvcIndexPath((prev) => {
                if (preferredIndexPath && nextIndexFiles.includes(preferredIndexPath)) {
                    return preferredIndexPath;
                }
                if (prev && nextIndexFiles.includes(prev)) {
                    return prev;
                }
                return nextIndexFiles[0] || '';
            });
            const speakerCountRaw = Number((setResult as { speaker_count?: number } | undefined)?.speaker_count);
            const nextSpeakerCount = Number.isFinite(speakerCountRaw) && speakerCountRaw > 0
                ? Math.floor(speakerCountRaw)
                : DEFAULT_RVC_SPEAKER_COUNT;
            setRvcSpeakerCount(nextSpeakerCount);
            const preferredSpeakerIdRaw = Number(preferred?.speakerId);
            setRvcSpeakerId((prev) => {
                const candidate = Number.isFinite(preferredSpeakerIdRaw)
                    ? Math.floor(preferredSpeakerIdRaw)
                    : prev;
                return candidate >= 0 && candidate < nextSpeakerCount ? candidate : 0;
            });
        } catch {
            setRvcIndexOptions([]);
            setRvcIndexPath('');
            setRvcSpeakerCount(DEFAULT_RVC_SPEAKER_COUNT);
            setRvcSpeakerId(0);
        }
    };

    const refreshVoiceOptions = async () => {
        if (!apiAvailable) return;
        try {
            const [ttsResponse, rvcResponse] = await Promise.all([
                window.electronAPI.ttsListModels(),
                window.electronAPI.rvcListModels(),
            ]);
            const nextTtsModels = Array.isArray(ttsResponse) ? (ttsResponse as TtsModel[]) : [];
            const nextRvcModels = Array.isArray(rvcResponse) ? (rvcResponse as RvcModel[]) : [];
            setTtsModels(nextTtsModels);
            setRvcModels(nextRvcModels);

            if (nextTtsModels.length > 0) {
                const currentSbv2ModelExists = nextTtsModels.some((model) => model.id === sbv2ModelId);
                const nextSbv2ModelId = currentSbv2ModelExists ? sbv2ModelId : nextTtsModels[0].id;
                setSbv2ModelId(nextSbv2ModelId);

                const targetSbv2Model = nextTtsModels.find((model) => model.id === nextSbv2ModelId) || nextTtsModels[0];
                const targetStyles = Array.isArray(targetSbv2Model.styles)
                    ? targetSbv2Model.styles.filter((style) => Boolean(style?.trim()))
                    : [];
                if (!sbv2Style.trim() || (targetStyles.length > 0 && !targetStyles.includes(sbv2Style))) {
                    setSbv2Style(targetSbv2Model.defaultStyle || targetStyles[0] || 'ノーマル');
                }
            }

            if (nextRvcModels.length > 0) {
                const currentRvcModelExists = nextRvcModels.some((model) => model.id === rvcModelId);
                const nextRvcModelId = currentRvcModelExists ? rvcModelId : nextRvcModels[0].id;
                setRvcModelId(nextRvcModelId);
                await applyRvcModelMeta(nextRvcModelId);
            } else {
                setRvcModelId('');
                setRvcIndexOptions([]);
                setRvcIndexPath('');
                setRvcSpeakerCount(DEFAULT_RVC_SPEAKER_COUNT);
                setRvcSpeakerId(0);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLastError((prev) => prev || `Voice options load failed: ${message}`);
        }
    };

    const fetchSeparationProfile = async (
        targetCharacterIdRaw?: string,
        options?: { silent?: boolean },
    ) => {
        const targetCharacterId = String(targetCharacterIdRaw || characterId || DEFAULT_CHARACTER_ID).trim() || DEFAULT_CHARACTER_ID;
        if (!window.electronAPI?.characterLearningGetSeparationProfile) {
            setSeparationProfile(null);
            if (!options?.silent) {
                setSeparationProfileStatus('Separation profile API is unavailable.');
            }
            return;
        }

        setIsSeparationProfileLoading(true);
        if (!options?.silent) {
            setSeparationProfileStatus('Loading separation quality memory...');
        }
        try {
            const response = await window.electronAPI.characterLearningGetSeparationProfile(targetCharacterId);
            setSeparationProfile(response);
            if (options?.silent) {
                return;
            }
            if (response.success) {
                setSeparationProfileStatus(`Loaded separation memory: ${response.characterId}`);
            } else {
                setSeparationProfileStatus(`Failed to load memory: ${response.error || 'unknown error'}`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!options?.silent) {
                setSeparationProfileStatus(`Failed to load memory: ${message}`);
            }
        } finally {
            setIsSeparationProfileLoading(false);
        }
    };

    const resetSeparationProfile = async () => {
        const targetCharacterId = characterId.trim() || DEFAULT_CHARACTER_ID;
        if (!window.electronAPI?.characterLearningResetSeparationProfile) {
            setSeparationProfileStatus('Separation profile reset API is unavailable.');
            return;
        }
        setIsSeparationProfileResetting(true);
        setSeparationProfileStatus('Resetting separation quality memory...');
        try {
            const response = await window.electronAPI.characterLearningResetSeparationProfile(targetCharacterId);
            setSeparationProfile(response);
            if (response.success) {
                setSeparationProfileStatus(`Reset separation memory: ${response.characterId}`);
            } else {
                setSeparationProfileStatus(`Failed to reset memory: ${response.error || 'unknown error'}`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setSeparationProfileStatus(`Failed to reset memory: ${message}`);
        } finally {
            setIsSeparationProfileResetting(false);
        }
    };

    const handleDialogueUrlChange = useCallback((url: string) => {
        setDialogueUrl(url);
        const match = url.match(/[?&]t=([^&\s#]+)/i);
        if (!match) { setDialogueDetectedTs(null); return; }
        const raw = match[1];
        let secs: number | null = null;
        if (/^\d+$/.test(raw)) {
            secs = parseInt(raw, 10);
        } else {
            const hms = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
            if (hms && (hms[1] || hms[2] || hms[3])) {
                secs = (parseInt(hms[1] || '0', 10) * 3600)
                    + (parseInt(hms[2] || '0', 10) * 60)
                    + parseInt(hms[3] || '0', 10);
            }
        }
        setDialogueDetectedTs(secs);
    }, []);

    const handleDialogueExtract = useCallback(async () => {
        if (!dialogueUrl.trim()) return;
        setIsDialogueExtracting(true);
        setDialogueExtractStatus('音声を抽出中...');
        try {
            const extractResult = await window.electronAPI.dialogueExtractFromYoutube({
                characterId: characterId || 'default',
                sourceUrl: dialogueUrl,
                startSec: dialogueStartOverride !== '' ? Number(dialogueStartOverride) : undefined,
                durationSec: dialogueDuration,
                separationPreference: singingSeparationPreference,
                ytDlpCookiesFile: ytDlpCookiesFile || undefined,
            });
            if (!extractResult.success || !extractResult.vocalWavPath) {
                setDialogueExtractStatus(`エラー: ${extractResult.error || '不明'}`);
                return;
            }
            let loadPath = extractResult.vocalWavPath;
            if (rvcModelId) {
                setDialogueExtractStatus('BGM除去完了。RVC変換中...');
                const rvcResult = await window.electronAPI.rvcConvert({
                    inputPath: extractResult.vocalWavPath,
                    modelId: rvcModelId,
                    speakerId: rvcSpeakerId ?? 0,
                });
                if (rvcResult?.success && rvcResult.wavPath) {
                    loadPath = rvcResult.wavPath;
                }
            }
            setDialogueExtractStatus('WAVを読み込み中...');
            const loaded = await window.electronAPI.dialogueLoadWavFile(loadPath);
            if (loaded.success && loaded.base64) {
                setWaveformEditorData({ base64: loaded.base64, fileName: loaded.fileName || 'dialogue.wav' });
                setDialogueExtractStatus('完了。波形エディタで編集できます。');
            } else {
                setDialogueExtractStatus(`WAV読み込みエラー: ${loaded.error || '不明'}`);
            }
        } catch (e) {
            setDialogueExtractStatus(`予期しないエラー: ${String(e)}`);
        } finally {
            setIsDialogueExtracting(false);
        }
    }, [dialogueUrl, dialogueStartOverride, dialogueDuration, characterId, singingSeparationPreference, ytDlpCookiesFile, rvcModelId, rvcSpeakerId]);

    const handleDialogueLoadWav = useCallback(async () => {
        const result = await window.electronAPI.selectFile(['wav'], false);
        if (!result?.success || !result.path) return;
        const loaded = await window.electronAPI.dialogueLoadWavFile(result.path);
        if (loaded.success && loaded.base64) {
            setWaveformEditorData({ base64: loaded.base64, fileName: loaded.fileName || 'audio.wav' });
            setDialogueExtractStatus('');
        } else {
            setDialogueExtractStatus(`WAV読み込みエラー: ${loaded.error || '不明'}`);
        }
    }, []);

    const handleOpenWaveformEditor = useCallback(() => {
        setWaveformEditorData((prev) => prev ?? { fileName: 'audio.wav' });
        setDialogueExtractStatus((prev) => prev || '波形エディタを開きました。Load WAV または Extract & Open Editor を使ってください。');
    }, []);

    const refreshAudioProcesses = useCallback(async (options?: { silent?: boolean }) => {
        if (!window.electronAPI?.getAudioProcesses) return;
        if (!options?.silent) {
            setIsRefreshingAudioProcesses(true);
            setAppAudioInputStatus('音声出力中のアプリ一覧を取得中...');
        }
        try {
            const result = await window.electronAPI.getAudioProcesses();
            if (!result.success || !Array.isArray(result.processes)) {
                if (!options?.silent) {
                    setAppAudioInputStatus(`アプリ一覧の取得に失敗: ${result.error || '不明'}`);
                }
                return;
            }
            setAudioProcesses(result.processes);
            setSelectedAppProcessPid((prev) => {
                if (prev && result.processes?.some((proc) => proc.pid === prev)) return prev;
                const first = result.processes?.[0];
                return first ? first.pid : null;
            });
            if (!options?.silent) {
                setAppAudioInputStatus(`アプリ一覧を更新しました (${result.processes.length}件)。`);
            }
        } catch (error) {
            if (!options?.silent) {
                setAppAudioInputStatus(`アプリ一覧の取得エラー: ${String(error)}`);
            }
        } finally {
            if (!options?.silent) {
                setIsRefreshingAudioProcesses(false);
            }
        }
    }, []);

    const stopAppAudioInputCapture = useCallback(async (options?: { keepToggleOn?: boolean; reason?: string }) => {
        appInputCaptureActiveRef.current = false;
        appInputCaptureTranscribingRef.current = false;
        appInputLastTranscribedSamplesRef.current = 0;
        appInputLastTranscribeTimeRef.current = 0;
        try {
            window.electronAPI?.offProcessAudioData?.();
        } catch {
            // Ignore listener cleanup errors.
        }
        try {
            if (window.electronAPI?.stopProcessCapture) {
                await window.electronAPI.stopProcessCapture();
            }
        } catch (error) {
            setAppAudioInputStatus(`アプリ音声取得の停止エラー: ${String(error)}`);
        } finally {
            setAppAudioCaptureRunning(false);
            if (!options?.keepToggleOn) {
                setAppAudioInputEnabled(false);
            }
            if (options?.reason) {
                setAppAudioInputStatus(options.reason);
            }
        }
    }, []);

    const startAppAudioInputCapture = useCallback(async () => {
        if (!apiAvailable) {
            setAppAudioInputStatus('Electron API unavailable.');
            setAppAudioInputEnabled(false);
            return;
        }
        if (!selectedAppProcessPid) {
            setAppAudioInputStatus('対象アプリを選択してください。');
            setAppAudioInputEnabled(false);
            return;
        }

        try {
            window.electronAPI.offProcessAudioData?.();
        } catch {
            // Ignore stale listener cleanup.
        }

        setAppAudioInputStatus('アプリ音声取得を開始中...');
        const startResult = await window.electronAPI.startProcessCapture(selectedAppProcessPid);
        if (!startResult.success) {
            setAppAudioInputStatus(`アプリ音声取得の開始失敗: ${startResult.error || '不明'}`);
            setAppAudioInputEnabled(false);
            setAppAudioCaptureRunning(false);
            return;
        }

        appInputCaptureActiveRef.current = true;
        appInputCaptureTranscribingRef.current = false;
        appInputLastTranscribedSamplesRef.current = 0;
        appInputLastTranscribeTimeRef.current = Date.now();
        setAppAudioCaptureRunning(true);
        setAppAudioInputStatus(`アプリ音声取得を開始しました (PID: ${selectedAppProcessPid})。文字起こしを入力欄に追記します。`);

        window.electronAPI.onProcessAudioMetadata((metadata) => {
            if (!appInputCaptureActiveRef.current) return;
            const now = Date.now();
            const totalSamples = Math.max(0, Number(metadata?.totalSamples || 0));
            const sampleRate = Math.max(1, Number(metadata?.sampleRate || 16000));
            const newSamples = totalSamples - appInputLastTranscribedSamplesRef.current;
            const minSamples = sampleRate * APP_INPUT_MIN_SEGMENT_SEC;
            const enoughTime = now - appInputLastTranscribeTimeRef.current >= APP_INPUT_TRANSCRIBE_INTERVAL_MS;
            if (!enoughTime || newSamples < minSamples || appInputCaptureTranscribingRef.current) {
                return;
            }

            const startSample = appInputLastTranscribedSamplesRef.current;
            const endSample = totalSamples;
            appInputLastTranscribedSamplesRef.current = endSample;
            appInputLastTranscribeTimeRef.current = now;
            appInputCaptureTranscribingRef.current = true;

            setTimeout(async () => {
                try {
                    const result = await window.electronAPI.transcribeRecordingSegment(startSample, endSample);
                    if (!appInputCaptureActiveRef.current) return;
                    if (!result.success) {
                        setAppAudioInputStatus(`文字起こし失敗: ${result.error || '不明'}`);
                        return;
                    }
                    const transcript = String(result.text || '').trim();
                    if (!transcript) {
                        setAppAudioInputStatus(`音声取得中... (${Math.max(0, Math.round((endSample - startSample) / sampleRate))}秒区間 / 文字なし)`);
                        return;
                    }
                    setInputText((prev) => {
                        const base = prev.trim();
                        return base ? `${base}\n${transcript}` : transcript;
                    });
                    setAppAudioInputStatus(`入力欄へ追記しました (${Math.max(0, Math.round((endSample - startSample) / sampleRate))}秒区間)。`);
                } catch (error) {
                    if (appInputCaptureActiveRef.current) {
                        setAppAudioInputStatus(`文字起こしエラー: ${String(error)}`);
                    }
                } finally {
                    appInputCaptureTranscribingRef.current = false;
                }
            }, 0);
        });
    }, [apiAvailable, selectedAppProcessPid]);

    useEffect(() => {
        const unsubscribe = window.electronAPI.onDialogueExtractProgress?.((progress) => {
            if (progress?.message) {
                setDialogueExtractStatus(progress.message);
            }
        });
        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        };
    }, []);

    useEffect(() => {
        void refreshVoiceOptions();
    }, [apiAvailable]);

    useEffect(() => {
        if (!apiAvailable) return;
        void refreshAudioProcesses({ silent: true });
    }, [apiAvailable, refreshAudioProcesses]);

    useEffect(() => {
        if (!apiAvailable) return;
        if (appAudioInputEnabled) {
            if (!appInputCaptureActiveRef.current) {
                void startAppAudioInputCapture();
            }
            return;
        }
        if (appAudioCaptureRunning || appInputCaptureActiveRef.current) {
            void stopAppAudioInputCapture({ keepToggleOn: true, reason: 'アプリ音声取得を停止しました。' });
        }
    }, [
        apiAvailable,
        appAudioInputEnabled,
        appAudioCaptureRunning,
        startAppAudioInputCapture,
        stopAppAudioInputCapture,
    ]);

    useEffect(() => {
        return () => {
            if (appInputCaptureActiveRef.current || appAudioCaptureRunning) {
                void stopAppAudioInputCapture({ keepToggleOn: true });
            } else {
                try {
                    window.electronAPI?.offProcessAudioData?.();
                } catch {
                    // Ignore cleanup errors.
                }
            }
        };
    }, [appAudioCaptureRunning, stopAppAudioInputCapture]);

    useEffect(() => {
        if (!apiAvailable) return;
        void fetchSeparationProfile(characterId, { silent: true });
    }, [apiAvailable, characterId]);

    useEffect(() => {
        try {
            const rawProfiles = localStorage.getItem(CHARACTER_PROFILES_STORAGE_KEY);
            const parsedProfiles = rawProfiles
                ? (JSON.parse(rawProfiles) as Record<string, LegacyStoredCharacterProfile>)
                : {};
            const nextProfiles: Record<string, StoredCharacterProfile> = {};
            if (parsedProfiles && typeof parsedProfiles === 'object') {
                for (const [id, profile] of Object.entries(parsedProfiles)) {
                    const normalizedId = id.trim();
                    if (!normalizedId) continue;
                    nextProfiles[normalizedId] = normalizeCharacterProfile(profile);
                }
            }

            const rawUser = localStorage.getItem(USER_PROFILE_STORAGE_KEY);
            const parsedUser = rawUser
                ? (JSON.parse(rawUser) as StoredUserProfile)
                : null;
            const rawVoiceEnhance = localStorage.getItem(VOICE_ENHANCE_STORAGE_KEY);
            const parsedVoiceEnhance = rawVoiceEnhance
                ? (JSON.parse(rawVoiceEnhance) as StoredVoiceEnhanceSettings)
                : null;
            const migratedVoiceEnhance = parsedVoiceEnhance && typeof parsedVoiceEnhance === 'object'
                ? normalizeVoiceEnhanceSettings(parsedVoiceEnhance)
                : undefined;

            // Migration from legacy key.
            const rawLegacy = localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
            const parsedLegacy = rawLegacy
                ? (JSON.parse(rawLegacy) as CharacterConversationSettings)
                : null;
            if (parsedLegacy?.character && !nextProfiles[characterId]) {
                nextProfiles[characterId] = normalizeCharacterProfile({
                    nameKanji: parsedLegacy.character.nameKanji || parsedLegacy.character.name || '',
                    nameKana: parsedLegacy.character.nameKana || '',
                    firstPerson: parsedLegacy.character.firstPerson || '',
                    personaNote: parsedLegacy.character.personaNote || '',
                    speakingStyleNote: parsedLegacy.character.speakingStyleNote || '',
                });
            }

            if (migratedVoiceEnhance) {
                for (const [id, profile] of Object.entries(nextProfiles)) {
                    if (profile.voiceEnhance) continue;
                    nextProfiles[id] = {
                        ...profile,
                        voiceEnhance: migratedVoiceEnhance,
                    };
                }
            }

            setCharacterProfiles(nextProfiles);

            const lastCharacterIdRaw = localStorage.getItem(LAST_CHARACTER_ID_STORAGE_KEY) || '';
            const nextCharacterId = lastCharacterIdRaw.trim() || characterId;
            if (nextCharacterId) {
                setCharacterId(nextCharacterId);
            }

            const activeProfile = nextProfiles[nextCharacterId] || nextProfiles[characterId];
            if (activeProfile) {
                applyCharacterProfile(activeProfile);
            } else {
                applyDefaultCharacterProfile();
                if (migratedVoiceEnhance) {
                    applyVoiceEnhanceSettings(migratedVoiceEnhance);
                }
            }

            if (parsedUser && typeof parsedUser === 'object') {
                if (typeof parsedUser.name === 'string') setUserName(parsedUser.name);
                if (typeof parsedUser.callName === 'string') setUserCallName(parsedUser.callName);
                if (typeof parsedUser.profileNote === 'string') setUserProfileNote(parsedUser.profileNote);
            } else if (parsedLegacy?.user) {
                if (typeof parsedLegacy.user.name === 'string') setUserName(parsedLegacy.user.name);
                if (typeof parsedLegacy.user.callName === 'string') setUserCallName(parsedLegacy.user.callName);
                if (typeof parsedLegacy.user.profileNote === 'string') setUserProfileNote(parsedLegacy.user.profileNote);
            }

        } catch {
            // Ignore corrupted local settings.
        } finally {
            setIsStorageHydrated(true);
        }
    }, []);

    useEffect(() => {
        if (!isStorageHydrated) return;
        try {
            localStorage.setItem(CHARACTER_PROFILES_STORAGE_KEY, JSON.stringify(characterProfiles));
        } catch {
            // Ignore storage failures.
        }
    }, [characterProfiles, isStorageHydrated]);

    useEffect(() => {
        if (!isStorageHydrated) return;
        try {
            const nextUserProfile: StoredUserProfile = {
                name: userName.trim(),
                callName: userCallName.trim(),
                profileNote: userProfileNote.trim(),
            };
            localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(nextUserProfile));
        } catch {
            // Ignore storage failures.
        }
    }, [userName, userCallName, userProfileNote, isStorageHydrated]);

    useEffect(() => {
        if (!isStorageHydrated) return;
        try {
            localStorage.setItem(LAST_CHARACTER_ID_STORAGE_KEY, characterId.trim());
        } catch {
            // Ignore storage failures.
        }
    }, [characterId, isStorageHydrated]);

    useEffect(() => {
        if (!selectedSbv2Model) return;
        const availableStyles = Array.isArray(selectedSbv2Model.styles)
            ? selectedSbv2Model.styles.filter((style) => Boolean(style?.trim()))
            : [];
        if (availableStyles.length === 0) return;
        if (!availableStyles.includes(sbv2Style)) {
            setSbv2Style(selectedSbv2Model.defaultStyle || availableStyles[0]);
        }
    }, [selectedSbv2Model, sbv2Style]);

    const appendMessage = (message: ChatMessage) => {
        setMessages((prev) => [...prev, message]);
        setTimeout(() => {
            if (chatScrollRef.current) {
                chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
            }
        }, 0);
    };

    const playResponseAudio = async (response: CharacterChatResponse) => {
        const audioBase64 = response.voice?.audioBase64;
        if (!audioBase64) return;
        const audio = new Audio(`data:audio/wav;base64,${audioBase64}`);
        audio.volume = Math.max(0, Math.min(1, audioVolume));
        try {
            await audio.play();
        } catch (error) {
            setLastError(`Audio playback failed: ${String(error)}`);
        }
    };

    const buildVoiceSnapshotText = (voiceResult?: CharacterChatResponse['voice']): string => {
        if (!voiceEnabled) {
            return 'voice=OFF';
        }

        const parts: string[] = [];
        parts.push(`voice=${voiceMode}`);
        parts.push(`sbv2=${sbv2ModelId.trim() || 'auto'}`);
        parts.push(`style=${sbv2Style.trim() || 'auto'}`);

        if (voiceMode === 'sbv2+rvc') {
            parts.push(`rvc=${rvcModelId.trim() || 'auto'}`);
            parts.push(`sid=${Number.isFinite(rvcSpeakerId) ? rvcSpeakerId : 0}`);
            parts.push(`index=${rvcIndexPath.trim() || 'none'}`);
        }

        parts.push(`learn=${singingTrainingMode ? 'on' : 'off'}`);
        parts.push(`sep=${singingSeparationPreference}`);
        parts.push(`singing=${forceSingingMode ? 'forced' : 'auto'}`);
        parts.push(`refine=${autoEmotionRefine ? 'on' : 'off'}`);
        parts.push(`enhance=${enhanceFinalAudio ? 'on' : 'off'}`);
        parts.push(`analyze=${autoAnalyzeAndEnhance ? 'on' : 'off'}`);
        parts.push(`hint=${emotionLabelHint}`);
        if (useEmotionIntensityHint) {
            parts.push(`hintI=${Math.max(0, Math.min(1, emotionIntensityHint)).toFixed(2)}`);
        }

        if (voiceResult) {
            const elapsed = voiceResult.stages?.totalMs ?? voiceResult.durationMs;
            if (voiceResult.success) {
                parts.push(`synth=ok${typeof elapsed === 'number' ? `(${elapsed}ms)` : ''}`);
            } else {
                parts.push(`synth=ng:${voiceResult.error?.code || 'unknown'}`);
            }
            if (voiceResult.analysis?.analyzed) {
                const beforeScore = voiceResult.analysis.before?.qualityScore;
                const afterScore = voiceResult.analysis.after?.qualityScore;
                if (voiceResult.analysis.profileId) {
                    parts.push(`profile=${voiceResult.analysis.profileId}`);
                }
                if (typeof beforeScore === 'number' && typeof afterScore === 'number') {
                    parts.push(`q=${beforeScore.toFixed(1)}->${afterScore.toFixed(1)}`);
                } else if (typeof afterScore === 'number') {
                    parts.push(`q=${afterScore.toFixed(1)}`);
                }
                if (voiceResult.analysis.autoEnhanced && voiceResult.analysis.actions.length > 0) {
                    parts.push(`fix=${voiceResult.analysis.actions.slice(0, 2).join('+')}`);
                }
            }
        }

        return parts.join(' | ');
    };

    const copyTextWithFallback = async (text: string): Promise<boolean> => {
        const normalized = String(text || '');
        if (!normalized) {
            return false;
        }

        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(normalized);
                return true;
            }
        } catch {
            // Fallback below.
        }

        try {
            const textarea = document.createElement('textarea');
            textarea.value = normalized;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(textarea);
            return copied;
        } catch {
            return false;
        }
    };

    const handleCopyVoiceSnapshot = async (text: string) => {
        const copied = await copyTextWithFallback(text);
        if (copied) {
            setCopyStatus('Voice snapshot copied.');
            setTimeout(() => setCopyStatus(''), 1600);
            return;
        }
        setCopyStatus('Failed to copy voice snapshot.');
        setTimeout(() => setCopyStatus(''), 2200);
    };

    const handleSend = async () => {
        const text = inputText.trim();
        if (!text || isSending) return;
        if (!apiAvailable) {
            setLastError('Electron API is not available on this screen.');
            return;
        }

        setLastError('');
        setInputText('');
        appendMessage({
            id: `user_${Date.now()}`,
            role: 'user',
            text,
        });

        setIsSending(true);
        try {
            const voiceExpression: {
                singing?: boolean;
                autoEmotionRefine: boolean;
                emotionLabelHint?: 'neutral' | 'joy' | 'sad' | 'angry' | 'excited'
                    | 'fear' | 'surprise' | 'love' | 'embarrassed' | 'curious';
                emotionIntensityHint?: number;
            } = {
                autoEmotionRefine,
            };
            if (forceSingingMode) {
                voiceExpression.singing = true;
            }
            if (emotionLabelHint !== 'auto') {
                voiceExpression.emotionLabelHint = emotionLabelHint;
            }
            if (useEmotionIntensityHint) {
                voiceExpression.emotionIntensityHint = Math.max(0, Math.min(1, emotionIntensityHint));
            }
            const response: CharacterChatResponse = await window.electronAPI.characterChatSend({
                sessionId,
                characterId,
                text,
                settings: conversationSettings,
                learning: {
                    singingTrainingMode,
                    separationPreference: singingSeparationPreference,
                    ytDlpCookiesFile: ytDlpCookiesFile || undefined,
                },
                withVoice: voiceEnabled,
                voice: {
                    mode: voiceMode,
                    sbv2: {
                        modelId: sbv2ModelId.trim() || undefined,
                        style: sbv2Style.trim() || undefined,
                    },
                    rvc: voiceMode === 'sbv2+rvc' ? {
                        modelId: rvcModelId.trim() || undefined,
                        speakerId: Number.isFinite(rvcSpeakerId) ? rvcSpeakerId : 0,
                        indexPath: rvcIndexPath.trim() || undefined,
                    } : undefined,
                    expression: voiceExpression,
                    output: {
                        enhanceFinalAudio,
                        autoAnalyzeAndEnhance,
                    },
                },
            });

            if (!response.success) {
                setLastError(response.error || 'Character chat failed');
                appendMessage({
                    id: `sys_err_${Date.now()}`,
                    role: 'system',
                    text: response.error || 'Character chat failed',
                });
                return;
            }

            setSessionId(response.sessionId || sessionId);
            appendMessage({
                id: response.turnId || `asst_${Date.now()}`,
                role: 'assistant',
                text: response.responseText || '(empty response)',
                emotionLabel: response.emotion?.label,
                emotionIntensity: response.emotion?.intensity,
                voiceSnapshot: response.voice ? buildVoiceSnapshotText(response.voice) : undefined,
            });

            if (voiceEnabled) {
                if (response.voice?.success) {
                    await playResponseAudio(response);
                } else if (response.voice && !response.voice.success) {
                    appendMessage({
                        id: `sys_voice_${Date.now()}`,
                        role: 'system',
                        text: `Voice fallback: ${response.voice.error?.message || 'voice synth failed'}`,
                    });
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLastError(message);
            appendMessage({
                id: `sys_ex_${Date.now()}`,
                role: 'system',
                text: `Error: ${message}`,
            });
        } finally {
            setIsSending(false);
        }
    };

    const handleReset = async () => {
        try {
            if (apiAvailable) {
                await window.electronAPI.characterChatReset(sessionId);
            }
        } catch {
            // Ignore reset failures on server side; renderer state is authoritative here.
        }
        setMessages([]);
        setInputText('');
        setLastError('');
        setSessionId(createSessionId());
    };

    const messageBubbleStyle = (role: MessageRole): React.CSSProperties => ({
        alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
        maxWidth: '80%',
        whiteSpace: 'pre-wrap',
        padding: '10px 12px',
        borderRadius: '10px',
        marginBottom: '10px',
        fontSize: '14px',
        lineHeight: 1.5,
        background: role === 'user'
            ? 'linear-gradient(135deg, #2563eb, #1d4ed8)'
            : role === 'assistant'
                ? 'rgba(15, 23, 42, 0.85)'
                : 'rgba(220, 38, 38, 0.2)',
        border: role === 'system' ? '1px solid rgba(220, 38, 38, 0.5)' : '1px solid var(--color-border)',
        color: 'var(--color-text)',
    });

    return (
        <>
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-secondary)', color: 'var(--color-text)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--color-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button onClick={() => navigate('/')} style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}>
                        Back
                    </button>
                    <h1 style={{ margin: 0, fontSize: '20px' }}>AI Character Studio</h1>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                    Session: <code>{sessionId}</code>
                </div>
            </div>

            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                <div style={{ width: '360px', borderRight: '1px solid var(--color-border)', padding: '14px', overflowY: 'auto' }}>
                    <h3 style={{ marginTop: 0 }}>Character</h3>
                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="話し相手のキャラクターIDです。保存済みIDから選択します。"
                    >
                        Character ID
                    </label>
                    <select
                        value={characterId}
                        onChange={(e) => switchCharacterId(e.target.value, { fromSelect: true })}
                        style={{ width: '100%', marginBottom: '12px' }}
                    >
                        {characterIdOptions.map((id) => (
                            <option key={id} value={id}>
                                {id}
                            </option>
                        ))}
                    </select>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="新しいCharacter IDを入力して切り替えます。保存するとリストに追加されます。"
                    >
                        New Character ID
                    </label>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                        <input
                            value={characterIdDraft}
                            onChange={(e) => setCharacterIdDraft(e.target.value)}
                            style={{ flex: 1 }}
                            placeholder="例: aozuki_fox_v2"
                        />
                        <button
                            onClick={() => {
                                switchCharacterId(characterIdDraft, { fromSelect: false });
                                setCharacterIdDraft('');
                            }}
                            style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
                        >
                            Use
                        </button>
                    </div>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="キャラクターの漢字名です。自己紹介や会話中の参照に使います。"
                    >
                        Character Name (Kanji)
                    </label>
                    <input
                        value={characterNameKanji}
                        onChange={(e) => setCharacterNameKanji(e.target.value)}
                        style={{ width: '100%', marginBottom: '10px' }}
                    />

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="キャラクター名の読み仮名です。読みや発音の参考に使います。"
                    >
                        Character Name (Kana)
                    </label>
                    <input
                        value={characterNameKana}
                        onChange={(e) => setCharacterNameKana(e.target.value)}
                        style={{ width: '100%', marginBottom: '10px' }}
                        placeholder="例: あおつききつねあんないにん"
                    />

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="キャラの一人称です（例: わたし / ぼく）。"
                    >
                        Character First Person
                    </label>
                    <input
                        value={characterFirstPerson}
                        onChange={(e) => setCharacterFirstPerson(e.target.value)}
                        style={{ width: '100%', marginBottom: '10px' }}
                    />

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="キャラクター設定メモです。性格・口調・背景などを自由に書けます。"
                    >
                        Character Persona Note
                    </label>
                    <textarea
                        value={characterPersonaNote}
                        onChange={(e) => setCharacterPersonaNote(e.target.value)}
                        rows={3}
                        style={{ width: '100%', resize: 'vertical', marginBottom: '10px' }}
                        placeholder="例: 明るく世話好き。時々狐っぽい比喩を使う。"
                    />

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="話し方の追加指定です。丁寧め、フランクなど。"
                    >
                        Speaking Style Note
                    </label>
                    <input
                        value={characterSpeakingStyleNote}
                        onChange={(e) => setCharacterSpeakingStyleNote(e.target.value)}
                        style={{ width: '100%', marginBottom: '12px' }}
                        placeholder="例: 丁寧ベースで親しみやすく"
                    />

                    <label style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}>
                        Emotion Personality
                    </label>
                    <select
                        value={emotionPersonalityPreset}
                        onChange={(e) => {
                            const preset = e.target.value;
                            setEmotionPersonalityPreset(preset);
                            if (preset !== 'custom' && EMOTION_PERSONALITY_PRESETS[preset]) {
                                const p = EMOTION_PERSONALITY_PRESETS[preset];
                                setEmotionIntensityScale(p.intensityScale ?? 1.0);
                                setEmotionVolatility(p.volatility ?? 0.3);
                            }
                        }}
                        style={{ width: '100%', marginBottom: '8px' }}
                    >
                        <option value="standard">Standard (標準)</option>
                        <option value="cheerful">Cheerful (明るい・ハイテンション)</option>
                        <option value="gentle">Gentle (優しい・穏やか)</option>
                        <option value="shy">Shy (恥ずかしがり)</option>
                        <option value="stoic">Stoic (感情を出さない)</option>
                        <option value="custom">Custom</option>
                    </select>
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
                        <label style={{ flex: 1, fontSize: '11px' }}>
                            Intensity Scale: {emotionIntensityScale.toFixed(2)}
                            <input
                                type="range" min="0.5" max="1.5" step="0.05"
                                value={emotionIntensityScale}
                                onChange={(e) => { setEmotionIntensityScale(Number(e.target.value)); setEmotionPersonalityPreset('custom'); }}
                                style={{ width: '100%' }}
                            />
                        </label>
                        <label style={{ flex: 1, fontSize: '11px' }}>
                            Volatility: {emotionVolatility.toFixed(2)}
                            <input
                                type="range" min="0.1" max="0.5" step="0.05"
                                value={emotionVolatility}
                                onChange={(e) => { setEmotionVolatility(Number(e.target.value)); setEmotionPersonalityPreset('custom'); }}
                                style={{ width: '100%' }}
                            />
                        </label>
                    </div>

                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                        <button
                            onClick={() => saveCharacterProfile(true)}
                            style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
                            title="Character ID をキーに現在のキャラクター設定（音声ON/OFF・再生音量・音声モデル・音声強化設定を含む）を保存します。"
                        >
                            Save Character
                        </button>
                        <button
                            onClick={() => loadCharacterProfile(true)}
                            style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
                            title="Character ID に保存済みのキャラクター設定（音声ON/OFF・再生音量・音声モデル・音声強化設定を含む）を読み込みます。"
                        >
                            Load Character
                        </button>
                    </div>
                    {profileStatus && (
                        <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
                            {profileStatus}
                        </div>
                    )}
                    {!profileStatus && (
                        <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
                            {hasSavedProfileForCurrentCharacter ? 'Saved profile exists for this Character ID.' : 'No saved profile for this Character ID yet.'}
                        </div>
                    )}

                    <h4 style={{ margin: '2px 0 8px 0', fontSize: '13px' }}>Singing Separation Memory</h4>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                        <button
                            onClick={() => { void fetchSeparationProfile(characterId); }}
                            disabled={isSeparationProfileLoading || !apiAvailable}
                            style={{ flex: 1, padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', opacity: isSeparationProfileLoading ? 0.7 : 1 }}
                            title="このキャラクターの分離品質メモリを再読み込みします。"
                        >
                            {isSeparationProfileLoading ? 'Loading...' : 'Refresh Memory'}
                        </button>
                        <button
                            onClick={() => { void resetSeparationProfile(); }}
                            disabled={isSeparationProfileResetting || !apiAvailable}
                            style={{ flex: 1, padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', opacity: isSeparationProfileResetting ? 0.7 : 1 }}
                            title="このキャラクターの分離品質メモリを初期化します。"
                        >
                            {isSeparationProfileResetting ? 'Resetting...' : 'Reset Memory'}
                        </button>
                    </div>
                    {separationProfileStatus && (
                        <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '8px' }}>
                            {separationProfileStatus}
                        </div>
                    )}
                    {separationProfile?.success && (
                        <div style={{ marginBottom: '12px', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '8px', background: 'rgba(15, 23, 42, 0.25)' }}>
                            <div style={{ fontSize: '11px', marginBottom: '4px' }}>
                                Preferred: <b>{SEPARATION_METHOD_LABELS[separationProfile.preferredMethod]}</b>
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '4px' }}>
                                Updated: {new Date(separationProfile.updatedAt).toLocaleString()}
                            </div>
                            <div style={{ fontSize: '10px', color: 'var(--color-text-secondary)', marginBottom: '8px', wordBreak: 'break-all' }}>
                                Store: {separationProfile.profilePath || '(not saved yet)'}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {separationProfileMethods.map((methodProfile) => (
                                    <div key={methodProfile.method} style={{ border: '1px solid var(--color-border)', borderRadius: '6px', padding: '6px', background: 'rgba(15, 23, 42, 0.35)' }}>
                                        <div style={{ fontSize: '11px', marginBottom: '2px' }}>
                                            {SEPARATION_METHOD_LABELS[methodProfile.method as SeparationMethodId]}
                                        </div>
                                        <div style={{ fontSize: '10px', color: 'var(--color-text-secondary)' }}>
                                            score={methodProfile.scoreEma.toFixed(2)} | success={methodProfile.successCount} | fail={methodProfile.failureCount}
                                        </div>
                                        <div style={{ fontSize: '10px', color: 'var(--color-text-secondary)' }}>
                                            rate={(methodProfile.successRate * 100).toFixed(1)}% | leakage={methodProfile.leakageEma.toFixed(3)} | speech={methodProfile.speechActivityEma.toFixed(3)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {!separationProfile?.success && separationProfile?.error && (
                        <div style={{ fontSize: '11px', color: '#fca5a5', marginBottom: '12px' }}>
                            {separationProfile.error}
                        </div>
                    )}

                    <h4 style={{ margin: '4px 0 8px 0', fontSize: '13px' }}>User Profile</h4>
                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="あなたの名前です。"
                    >
                        Your Name
                    </label>
                    <input
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                        style={{ width: '100%', marginBottom: '10px' }}
                        placeholder="例: そら"
                    />

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="キャラに呼んでほしい呼称です。未設定なら名前→あなたの順で使われます。"
                    >
                        Call Me As
                    </label>
                    <input
                        value={userCallName}
                        onChange={(e) => setUserCallName(e.target.value)}
                        style={{ width: '100%', marginBottom: '10px' }}
                        placeholder="例: そらさん / マスター"
                    />

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="あなたに関する補足情報です。会話中の文脈に使います。"
                    >
                        User Note
                    </label>
                    <textarea
                        value={userProfileNote}
                        onChange={(e) => setUserProfileNote(e.target.value)}
                        rows={2}
                        style={{ width: '100%', resize: 'vertical', marginBottom: '12px' }}
                        placeholder="例: プログラミング学習中。短く要点で答えてほしい。"
                    />

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <h3 style={{ margin: 0 }}>Voice</h3>
                        <button
                            onClick={() => { void refreshVoiceOptions(); }}
                            style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: '12px' }}
                            title="SBV2/RVC のモデル一覧を再読み込みします。"
                        >
                            Refresh Models
                        </button>
                    </div>
                    <label
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}
                        title="ONで応答音声を合成して再生します。"
                    >
                        <input type="checkbox" checked={voiceEnabled} onChange={(e) => setVoiceEnabled(e.target.checked)} />
                        Enable voice output
                    </label>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="SBV2のみ、またはSBV2+RVCのパイプラインを選びます。"
                    >
                        Mode
                    </label>
                    <select value={voiceMode} onChange={(e) => setVoiceMode(e.target.value as 'sbv2' | 'sbv2+rvc')} style={{ width: '100%', marginBottom: '10px' }}>
                        <option value="sbv2+rvc">SBV2 + RVC</option>
                        <option value="sbv2">SBV2 only</option>
                    </select>

                    <label
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}
                        title="ONのとき、YouTube URLを送信すると音源を取得して歌声抽出と学習素材保存を実行します。"
                    >
                        <input
                            type="checkbox"
                            checked={singingTrainingMode}
                            onChange={(e) => setSingingTrainingMode(e.target.checked)}
                        />
                        Singing learning mode (YouTube URL)
                    </label>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="歌唱学習の分離エンジン優先順です。Autoは UVR Ultimate → Demucs → UVR5 → FFmpeg の順に試します。"
                    >
                        Singing Separation Engine
                    </label>
                    <select
                        value={singingSeparationPreference}
                        onChange={(e) => setSingingSeparationPreference(
                            e.target.value as 'auto' | 'uvr-ultimate' | 'demucs' | 'uvr5' | 'ffmpeg-fallback',
                        )}
                        style={{ width: '100%', marginBottom: '10px' }}
                    >
                        <option value="auto">Auto (Recommended)</option>
                        <option value="uvr-ultimate">UVR Ultimate</option>
                        <option value="demucs">Demucs</option>
                        <option value="uvr5">UVR5 (RVC)</option>
                        <option value="ffmpeg-fallback">FFmpeg fallback</option>
                    </select>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}
                        title="YouTube Music PremiumのCookiesファイル（cookies.txt）のパスを指定します。ブラウザ拡張機能でエクスポートしてください。"
                    >
                        YouTube cookies.txt (Premium)
                    </label>
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                        <input
                            type="text"
                            value={ytDlpCookiesFile}
                            onChange={(e) => setYtDlpCookiesFile(e.target.value)}
                            placeholder="cookies.txt (optional)"
                            style={{ flex: 1, minWidth: 0 }}
                            title="YouTube Music Premium動画のダウンロードに必要なcookies.txtのフルパス。'Get cookies.txt LOCALLY'等のブラウザ拡張でエクスポートできます。"
                        />
                        <button
                            type="button"
                            onClick={async () => {
                                const result = await window.electronAPI.selectFile(['txt'], false);
                                if (result?.success && result.path) {
                                    setYtDlpCookiesFile(result.path);
                                }
                            }}
                            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                            title="cookies.txtファイルを選択"
                        >
                            Browse
                        </button>
                    </div>

                    <label
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}
                        title="ONで歌唱モードを強制します。OFFならテキスト内容から自動判定します。"
                    >
                        <input
                            type="checkbox"
                            checked={forceSingingMode}
                            onChange={(e) => setForceSingingMode(e.target.checked)}
                        />
                        Force singing mode
                    </label>

                    {/* ─── Dialogue Clip Extractor ─── */}
                    <div style={{ margin: '12px 0 4px 0', borderTop: '1px solid var(--color-border)', paddingTop: '12px' }}>
                        <h4 style={{ margin: '0 0 8px 0', fontSize: '13px' }}>Dialogue Clip Extractor</h4>
                        <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
                            YouTube URL (タイムスタンプ付き対応)
                        </label>
                        <input
                            type="text"
                            value={dialogueUrl}
                            onChange={(e) => handleDialogueUrlChange(e.target.value)}
                            placeholder="https://youtu.be/xxxxx?t=83"
                            style={{ width: '100%', marginBottom: '4px', boxSizing: 'border-box' }}
                        />
                        {dialogueDetectedTs !== null && (
                            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
                                タイムスタンプ検出: {Math.floor(dialogueDetectedTs / 60)}:{String(dialogueDetectedTs % 60).padStart(2, '0')} ({dialogueDetectedTs}秒)
                            </div>
                        )}
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                            <div style={{ flex: 1 }}>
                                <label style={{ display: 'block', fontSize: '11px', marginBottom: '2px', color: 'var(--color-text-secondary)' }}>
                                    開始位置オーバーライド (秒)
                                </label>
                                <input
                                    type="number"
                                    value={dialogueStartOverride}
                                    onChange={(e) => setDialogueStartOverride(e.target.value)}
                                    placeholder="省略時はURL ?t= を使用"
                                    min={0}
                                    style={{ width: '100%', boxSizing: 'border-box' }}
                                />
                            </div>
                            <div style={{ flex: 1 }}>
                                <label style={{ display: 'block', fontSize: '11px', marginBottom: '2px', color: 'var(--color-text-secondary)' }}>
                                    抽出時間 (秒)
                                </label>
                                <input
                                    type="number"
                                    value={dialogueDuration}
                                    onChange={(e) => setDialogueDuration(Math.max(1, Number(e.target.value)))}
                                    min={1}
                                    max={600}
                                    style={{ width: '100%', boxSizing: 'border-box' }}
                                />
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                            <button
                                onClick={() => { void handleDialogueExtract(); }}
                                disabled={isDialogueExtracting || !dialogueUrl.trim() || !apiAvailable}
                                style={{ flex: 1, padding: '7px 8px', borderRadius: '6px', border: '1px solid var(--color-border)', background: isDialogueExtracting ? 'var(--color-surface)' : 'var(--color-primary, #3182ce)', color: '#fff', cursor: isDialogueExtracting || !dialogueUrl.trim() ? 'not-allowed' : 'pointer', opacity: isDialogueExtracting || !dialogueUrl.trim() ? 0.6 : 1, fontSize: '12px', fontWeight: 'bold' }}
                            >
                                {isDialogueExtracting ? '抽出中...' : 'Extract & Open Editor'}
                            </button>
                            <button
                                onClick={() => { void handleDialogueLoadWav(); }}
                                disabled={isDialogueExtracting}
                                style={{ padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', cursor: 'pointer', fontSize: '12px' }}
                            >
                                Load WAV
                            </button>
                            <button
                                onClick={handleOpenWaveformEditor}
                                style={{ padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', cursor: 'pointer', fontSize: '12px' }}
                                title="モードレスの波形エディタを開きます"
                            >
                                Open Editor
                            </button>
                        </div>
                        {dialogueExtractStatus && (
                            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', padding: '4px 6px', background: 'rgba(15,23,42,0.3)', borderRadius: '4px', wordBreak: 'break-all' }}>
                                {dialogueExtractStatus}
                            </div>
                        )}
                    </div>
                    {/* ─────────────────────────────── */}

                    <label
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}
                        title="ONで感情強度の自己改善（履歴平滑化）を有効化します。"
                    >
                        <input
                            type="checkbox"
                            checked={autoEmotionRefine}
                            onChange={(e) => setAutoEmotionRefine(e.target.checked)}
                        />
                        Auto emotion refine
                    </label>

                    <label
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}
                        title="ONで最終WAVの軽量音質改善（ゲイン整形/クリップ保護）を有効化します。"
                    >
                        <input
                            type="checkbox"
                            checked={enhanceFinalAudio}
                            onChange={(e) => setEnhanceFinalAudio(e.target.checked)}
                        />
                        Enhance final audio
                    </label>

                    <label
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}
                        title="ONで生成WAVを解析し、クリップ・DCオフセット・音量バランスを自動補正します。"
                    >
                        <input
                            type="checkbox"
                            checked={autoAnalyzeAndEnhance}
                            onChange={(e) => setAutoAnalyzeAndEnhance(e.target.checked)}
                        />
                        Auto analyze generated WAV
                    </label>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="感情ラベルのヒントです。Autoの場合は会話内容から自動推定します。"
                    >
                        Emotion Label Hint
                    </label>
                    <select
                        value={emotionLabelHint}
                        onChange={(e) => setEmotionLabelHint(
                            e.target.value as 'auto' | 'neutral' | 'joy' | 'sad' | 'angry' | 'excited'
                                | 'fear' | 'surprise' | 'love' | 'embarrassed' | 'curious',
                        )}
                        style={{ width: '100%', marginBottom: '8px' }}
                    >
                        <option value="auto">Auto</option>
                        <option value="neutral">Neutral</option>
                        <option value="joy">Joy (喜び)</option>
                        <option value="sad">Sad (悲しみ)</option>
                        <option value="angry">Angry (怒り)</option>
                        <option value="excited">Excited (興奮)</option>
                        <option value="fear">Fear (恐怖/不安)</option>
                        <option value="surprise">Surprise (驚き)</option>
                        <option value="love">Love (愛情)</option>
                        <option value="embarrassed">Embarrassed (恥ずかしさ)</option>
                        <option value="curious">Curious (好奇心)</option>
                    </select>

                    <label
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}
                        title="ONで感情強度ヒント（0.00-1.00）を送信します。"
                    >
                        <input
                            type="checkbox"
                            checked={useEmotionIntensityHint}
                            onChange={(e) => setUseEmotionIntensityHint(e.target.checked)}
                        />
                        Use emotion intensity hint
                    </label>
                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="感情強度ヒントです。大きいほど表現を強めます。"
                    >
                        Emotion Intensity Hint: {emotionIntensityHint.toFixed(2)}
                    </label>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={emotionIntensityHint}
                        onChange={(e) => setEmotionIntensityHint(Number(e.target.value))}
                        style={{ width: '100%', marginBottom: '10px' }}
                        disabled={!useEmotionIntensityHint}
                    />

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="SBV2の音声モデルを選択します。モデルごとに声質が変わります。"
                    >
                        SBV2 Model
                    </label>
                    <select
                        value={sbv2ModelId}
                        onChange={(e) => setSbv2ModelId(e.target.value)}
                        style={{ width: '100%', marginBottom: '10px' }}
                    >
                        <option value="">(Auto)</option>
                        {ttsModels.map((model) => (
                            <option key={model.id} value={model.id}>
                                {model.name}
                            </option>
                        ))}
                    </select>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="SBV2の話し方スタイルです。モデルが持つスタイル一覧から選びます。"
                    >
                        SBV2 Style
                    </label>
                    <select
                        value={sbv2Style}
                        onChange={(e) => setSbv2Style(e.target.value)}
                        style={{ width: '100%', marginBottom: '10px' }}
                        disabled={sbv2StyleOptions.length === 0}
                    >
                        {sbv2StyleOptions.length === 0 && <option value="">(No style)</option>}
                        {sbv2StyleOptions.map((style) => (
                            <option key={style} value={style}>
                                {style}
                            </option>
                        ))}
                    </select>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="RVC変換モデルを選択します。"
                    >
                        RVC Model
                    </label>
                    <select
                        value={rvcModelId}
                        onChange={(e) => {
                            const nextModelId = e.target.value;
                            setRvcModelId(nextModelId);
                            void applyRvcModelMeta(nextModelId);
                        }}
                        style={{ width: '100%', marginBottom: '10px' }}
                        disabled={voiceMode !== 'sbv2+rvc'}
                    >
                        <option value="">(Auto)</option>
                        {rvcModels.map((model) => (
                            <option key={model.id} value={model.id}>
                                {model.name}
                            </option>
                        ))}
                    </select>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="RVCモデル内の話者IDです。"
                    >
                        RVC Speaker ID
                    </label>
                    <select
                        value={String(rvcSpeakerId)}
                        onChange={(e) => setRvcSpeakerId(Number(e.target.value))}
                        style={{ width: '100%', marginBottom: '10px' }}
                        disabled={voiceMode !== 'sbv2+rvc'}
                    >
                        {rvcSpeakerOptions.map((speakerId) => (
                            <option key={speakerId} value={speakerId}>
                                {speakerId}
                            </option>
                        ))}
                    </select>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="RVCの検索インデックス(.index)です。通常は同じモデルのindexを使います。"
                    >
                        RVC Index
                    </label>
                    <select
                        value={rvcIndexPath}
                        onChange={(e) => setRvcIndexPath(e.target.value)}
                        style={{ width: '100%', marginBottom: '10px' }}
                        disabled={voiceMode !== 'sbv2+rvc'}
                    >
                        <option value="">(None)</option>
                        {rvcIndexOptions.map((indexPath) => (
                            <option key={indexPath} value={indexPath}>
                                {indexPath}
                            </option>
                        ))}
                    </select>

                    <label
                        style={{ display: 'block', fontSize: '12px', marginBottom: '6px' }}
                        title="再生ボリュームです。0.00-1.00で調整します。"
                    >
                        Playback Volume: {audioVolume.toFixed(2)}
                    </label>
                    <input type="range" min={0} max={1} step={0.01} value={audioVolume} onChange={(e) => setAudioVolume(Number(e.target.value))} style={{ width: '100%', marginBottom: '14px' }} />

                    <button onClick={handleReset} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}>
                        Reset Session
                    </button>
                    {!apiAvailable && (
                        <div style={{ marginTop: '10px', color: '#f87171', fontSize: '12px' }}>
                            Electron API unavailable.
                        </div>
                    )}
                </div>

                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <div ref={chatScrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
                        {messages.length === 0 && (
                            <div style={{ color: 'var(--color-text-secondary)', fontSize: '14px' }}>
                                Start conversation with the character.
                            </div>
                        )}
                        {messages.map((msg) => (
                            <div key={msg.id} style={messageBubbleStyle(msg.role)}>
                                <div style={{ fontSize: '11px', opacity: 0.75, marginBottom: '6px' }}>
                                    {msg.role.toUpperCase()}
                                    {msg.role === 'assistant' && msg.emotionLabel && (() => {
                                        const EMOTION_ICON: Record<string, string> = {
                                            neutral: '😐', joy: '😊', sad: '😢', angry: '😠', excited: '🤩',
                                            fear: '😨', surprise: '😲', love: '💕', embarrassed: '😳', curious: '🤔',
                                        };
                                        const icon = EMOTION_ICON[msg.emotionLabel] || '';
                                        return (
                                            <span>{` | ${icon} ${msg.emotionLabel}${typeof msg.emotionIntensity === 'number' ? `(${msg.emotionIntensity.toFixed(2)})` : ''}`}</span>
                                        );
                                    })()}
                                </div>
                                {msg.role === 'assistant' && msg.voiceSnapshot && (
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '6px' }}>
                                        <div style={{ flex: 1, fontSize: '10px', opacity: 0.7, wordBreak: 'break-all' }}>
                                            {msg.voiceSnapshot}
                                        </div>
                                        <button
                                            onClick={() => { void handleCopyVoiceSnapshot(msg.voiceSnapshot || ''); }}
                                            style={{
                                                padding: '2px 6px',
                                                borderRadius: '6px',
                                                border: '1px solid var(--color-border)',
                                                background: 'var(--color-surface)',
                                                color: 'var(--color-text)',
                                                fontSize: '10px',
                                                lineHeight: 1.2,
                                                cursor: 'pointer',
                                            }}
                                            title="Copy voice snapshot"
                                        >
                                            Copy
                                        </button>
                                    </div>
                                )}
                                <div>{msg.text}</div>
                            </div>
                        ))}
                    </div>

                    <div style={{ borderTop: '1px solid var(--color-border)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ padding: '8px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'rgba(15,23,42,0.22)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                                    <input
                                        type="checkbox"
                                        checked={appAudioInputEnabled}
                                        onChange={(e) => setAppAudioInputEnabled(e.target.checked)}
                                        disabled={!apiAvailable}
                                    />
                                    アプリ音声取得を入力欄へ反映（トグル）
                                </label>
                                <button
                                    onClick={() => { void refreshAudioProcesses(); }}
                                    disabled={!apiAvailable || isRefreshingAudioProcesses}
                                    style={{
                                        padding: '5px 8px',
                                        borderRadius: '6px',
                                        border: '1px solid var(--color-border)',
                                        background: 'var(--color-surface)',
                                        color: 'var(--color-text)',
                                        cursor: (!apiAvailable || isRefreshingAudioProcesses) ? 'not-allowed' : 'pointer',
                                        opacity: (!apiAvailable || isRefreshingAudioProcesses) ? 0.6 : 1,
                                        fontSize: '11px',
                                    }}
                                >
                                    {isRefreshingAudioProcesses ? '更新中...' : 'アプリ一覧更新'}
                                </button>
                                {appAudioCaptureRunning && (
                                    <span style={{ fontSize: '11px', color: '#34d399' }}>取得中</span>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                <select
                                    value={selectedAppProcessPid ?? ''}
                                    onChange={(e) => setSelectedAppProcessPid(e.target.value ? Number(e.target.value) : null)}
                                    disabled={!apiAvailable || appAudioCaptureRunning || sortedAudioProcesses.length === 0}
                                    style={{ flex: 1, minWidth: '220px' }}
                                >
                                    <option value="">音声出力中のアプリを選択</option>
                                    {sortedAudioProcesses.map((proc) => (
                                        <option key={proc.pid} value={proc.pid}>
                                            {`${proc.title?.trim() || proc.name} (PID:${proc.pid})`}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '6px', wordBreak: 'break-all' }}>
                                {appAudioInputStatus || 'ONにすると選択アプリの音声を定期文字起こしして入力欄へ追記します。'}
                            </div>
                        </div>
                        <textarea
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            placeholder="Type your message..."
                            rows={4}
                            style={{ width: '100%', resize: 'vertical' }}
                            onKeyDown={(e) => {
                                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                    e.preventDefault();
                                    handleSend();
                                }
                            }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                <div style={{ color: '#f87171', fontSize: '12px' }}>{lastError}</div>
                                {!lastError && copyStatus && (
                                    <div style={{ color: 'var(--color-text-secondary)', fontSize: '12px' }}>{copyStatus}</div>
                                )}
                            </div>
                            <button
                                onClick={handleSend}
                                disabled={isSending || !inputText.trim()}
                                style={{
                                    minWidth: '120px',
                                    padding: '10px 14px',
                                    borderRadius: '8px',
                                    border: '1px solid #1d4ed8',
                                    background: isSending ? '#334155' : '#2563eb',
                                    color: '#fff',
                                    cursor: isSending ? 'not-allowed' : 'pointer',
                                }}
                            >
                                {isSending ? 'Sending...' : 'Send'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        {waveformEditorData && (
            <WaveformEditor
                wavBase64={waveformEditorData.base64}
                fileName={waveformEditorData.fileName}
                characterId={characterId}
                rvcConfig={{
                    modelId: rvcModelId.trim() || undefined,
                    speakerId: Number.isFinite(rvcSpeakerId) ? rvcSpeakerId : 0,
                    indexPath: rvcIndexPath.trim() || undefined,
                }}
                onClose={() => setWaveformEditorData(null)}
            />
        )}
        </>
    );
};

export default CharacterStudioScreen;
