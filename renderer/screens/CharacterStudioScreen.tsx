import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CharacterChatResponse, CharacterConversationSettings } from '../../types/character';
import type { RvcModel } from '../../types/rvc';
import type { TtsModel } from '../../types/tts';

type MessageRole = 'user' | 'assistant' | 'system';

interface ChatMessage {
    id: string;
    role: MessageRole;
    text: string;
    emotionLabel?: string;
    emotionIntensity?: number;
}

interface StoredCharacterProfile {
    nameKanji?: string;
    nameKana?: string;
    firstPerson?: string;
    personaNote?: string;
    speakingStyleNote?: string;
    updatedAt?: string;
}

interface StoredUserProfile {
    name?: string;
    callName?: string;
    profileNote?: string;
}

const createSessionId = () => `char_ui_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const DEFAULT_RVC_SPEAKER_COUNT = 8;
const LEGACY_SETTINGS_STORAGE_KEY = 'character_studio_settings_v1';
const CHARACTER_PROFILES_STORAGE_KEY = 'character_studio_profiles_v1';
const USER_PROFILE_STORAGE_KEY = 'character_studio_user_profile_v1';

const CharacterStudioScreen: React.FC = () => {
    const navigate = useNavigate();

    const [sessionId, setSessionId] = useState<string>(createSessionId());
    const [characterId, setCharacterId] = useState<string>('aozuki_fox_v1');
    const [characterNameKanji, setCharacterNameKanji] = useState<string>('蒼月キツネ案内人');
    const [characterNameKana, setCharacterNameKana] = useState<string>('あおつききつねあんないにん');
    const [characterFirstPerson, setCharacterFirstPerson] = useState<string>('わたし');
    const [characterPersonaNote, setCharacterPersonaNote] = useState<string>('');
    const [characterSpeakingStyleNote, setCharacterSpeakingStyleNote] = useState<string>('');
    const [userName, setUserName] = useState<string>('');
    const [userCallName, setUserCallName] = useState<string>('');
    const [userProfileNote, setUserProfileNote] = useState<string>('');
    const [characterProfiles, setCharacterProfiles] = useState<Record<string, StoredCharacterProfile>>({});
    const [profileStatus, setProfileStatus] = useState<string>('');
    const [inputText, setInputText] = useState<string>('');
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isSending, setIsSending] = useState<boolean>(false);
    const [lastError, setLastError] = useState<string>('');

    const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);
    const [voiceMode, setVoiceMode] = useState<'sbv2' | 'sbv2+rvc'>('sbv2+rvc');
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

    const chatScrollRef = useRef<HTMLDivElement | null>(null);

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
    const conversationSettings = useMemo<CharacterConversationSettings>(() => ({
        character: {
            nameKanji: characterNameKanji.trim() || undefined,
            nameKana: characterNameKana.trim() || undefined,
            // Backward-compatible field
            name: characterNameKanji.trim() || undefined,
            firstPerson: characterFirstPerson.trim() || undefined,
            personaNote: characterPersonaNote.trim() || undefined,
            speakingStyleNote: characterSpeakingStyleNote.trim() || undefined,
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
        userName,
        userCallName,
        userProfileNote,
    ]);

    const normalizeCharacterProfile = (profile: StoredCharacterProfile | undefined): StoredCharacterProfile => ({
        nameKanji: String(profile?.nameKanji || '').trim(),
        nameKana: String(profile?.nameKana || '').trim(),
        firstPerson: String(profile?.firstPerson || '').trim(),
        personaNote: String(profile?.personaNote || '').trim(),
        speakingStyleNote: String(profile?.speakingStyleNote || '').trim(),
        updatedAt: profile?.updatedAt || new Date().toISOString(),
    });

    const applyCharacterProfile = (profile: StoredCharacterProfile) => {
        setCharacterNameKanji(profile.nameKanji || '');
        setCharacterNameKana(profile.nameKana || '');
        setCharacterFirstPerson(profile.firstPerson || 'わたし');
        setCharacterPersonaNote(profile.personaNote || '');
        setCharacterSpeakingStyleNote(profile.speakingStyleNote || '');
    };

    const buildCharacterProfileFromState = (): StoredCharacterProfile => ({
        nameKanji: characterNameKanji.trim(),
        nameKana: characterNameKana.trim(),
        firstPerson: characterFirstPerson.trim(),
        personaNote: characterPersonaNote.trim(),
        speakingStyleNote: characterSpeakingStyleNote.trim(),
        updatedAt: new Date().toISOString(),
    });

    const saveCharacterProfile = (showStatus: boolean) => {
        const id = characterId.trim();
        if (!id) {
            setLastError('Character ID is required to save profile.');
            return;
        }
        const nextProfile = buildCharacterProfileFromState();
        setCharacterProfiles((prev) => ({
            ...prev,
            [id]: nextProfile,
        }));
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

    const applyRvcModelMeta = async (modelId: string) => {
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
            setRvcIndexPath((prev) => {
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
            setRvcSpeakerId((prev) => (prev >= 0 && prev < nextSpeakerCount ? prev : 0));
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

    useEffect(() => {
        void refreshVoiceOptions();
    }, [apiAvailable]);

    useEffect(() => {
        try {
            const rawProfiles = localStorage.getItem(CHARACTER_PROFILES_STORAGE_KEY);
            const parsedProfiles = rawProfiles
                ? (JSON.parse(rawProfiles) as Record<string, StoredCharacterProfile>)
                : {};
            const nextProfiles: Record<string, StoredCharacterProfile> = {};
            if (parsedProfiles && typeof parsedProfiles === 'object') {
                for (const [id, profile] of Object.entries(parsedProfiles)) {
                    if (!id.trim()) continue;
                    nextProfiles[id] = normalizeCharacterProfile(profile);
                }
            }

            const rawUser = localStorage.getItem(USER_PROFILE_STORAGE_KEY);
            const parsedUser = rawUser
                ? (JSON.parse(rawUser) as StoredUserProfile)
                : null;

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

            setCharacterProfiles(nextProfiles);

            if (nextProfiles[characterId]) {
                applyCharacterProfile(nextProfiles[characterId]);
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
        }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(CHARACTER_PROFILES_STORAGE_KEY, JSON.stringify(characterProfiles));
        } catch {
            // Ignore storage failures.
        }
    }, [characterProfiles]);

    useEffect(() => {
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
    }, [userName, userCallName, userProfileNote]);

    useEffect(() => {
        const id = characterId.trim();
        if (!id) return;
        const nextProfile = buildCharacterProfileFromState();
        setCharacterProfiles((prev) => {
            const prevProfile = prev[id];
            if (
                prevProfile
                && prevProfile.nameKanji === nextProfile.nameKanji
                && prevProfile.nameKana === nextProfile.nameKana
                && prevProfile.firstPerson === nextProfile.firstPerson
                && prevProfile.personaNote === nextProfile.personaNote
                && prevProfile.speakingStyleNote === nextProfile.speakingStyleNote
            ) {
                return prev;
            }
            return { ...prev, [id]: nextProfile };
        });
    }, [
        characterNameKanji,
        characterNameKana,
        characterFirstPerson,
        characterPersonaNote,
        characterSpeakingStyleNote,
    ]);

    useEffect(() => {
        const id = characterId.trim();
        if (!id) return;
        const savedProfile = characterProfiles[id];
        if (!savedProfile) return;
        applyCharacterProfile(savedProfile);
    }, [characterId, characterProfiles]);

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
            const response: CharacterChatResponse = await window.electronAPI.characterChatSend({
                sessionId,
                characterId,
                text,
                settings: conversationSettings,
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
                        title="話し相手のキャラクターIDです。登録済みIDを入力します。"
                    >
                        Character ID
                    </label>
                    <input value={characterId} onChange={(e) => setCharacterId(e.target.value)} style={{ width: '100%', marginBottom: '12px' }} />

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

                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                        <button
                            onClick={() => saveCharacterProfile(true)}
                            style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
                            title="Character ID をキーに現在のキャラクター設定を保存します。"
                        >
                            Save Character
                        </button>
                        <button
                            onClick={() => loadCharacterProfile(true)}
                            style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
                            title="Character ID に保存済みのキャラクター設定を読み込みます。"
                        >
                            Load Character
                        </button>
                    </div>
                    {profileStatus && (
                        <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
                            {profileStatus}
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
                                    {msg.role === 'assistant' && msg.emotionLabel && (
                                        <span>{` | emotion=${msg.emotionLabel}${typeof msg.emotionIntensity === 'number' ? `(${msg.emotionIntensity.toFixed(2)})` : ''}`}</span>
                                    )}
                                </div>
                                <div>{msg.text}</div>
                            </div>
                        ))}
                    </div>

                    <div style={{ borderTop: '1px solid var(--color-border)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                            <div style={{ color: '#f87171', fontSize: '12px' }}>{lastError}</div>
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
    );
};

export default CharacterStudioScreen;
