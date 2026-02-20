import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
    CharacterChatRequest,
    CharacterChatResponse,
    CharacterChatTurn,
    CharacterConversationSettings,
    CharacterEmotionLabel,
    CharacterEmotionResult,
    CharacterProfile,
} from '../../types/character';

const DEFAULT_CHARACTER_ID = 'aozuki_fox_v1';
const DEFAULT_FIRST_PERSON = 'わたし';
const MAX_SESSION_TURNS = 24;
const MAX_MEMORY_TURNS = 120;
const MEMORY_PROMPT_TURNS = 10;
const MEMORY_STORE_FILENAME = 'character_memory.json';

const DEFAULT_PROFILE: CharacterProfile = {
    id: DEFAULT_CHARACTER_ID,
    name: '蒼月キツネ案内人',
    personaVersion: '1.0',
    styleKeywords: ['friendly', 'fox-like', 'blue-white-theme', 'gentle', 'energetic'],
    responseLengthPolicy: 'short_default_with_expand_on_request',
    systemPrompt: [
        'あなたは「蒼月キツネ案内人」です。',
        '一人称は「わたし」を基本にしてください。',
        '親しみやすく丁寧で、短く要点を先に答えてください。',
        '必要なときだけ補足を追加してください。',
        '攻撃的・威圧的・冷笑的な表現は禁止です。',
        '医療/法律/投資など高リスク領域では断定せず一般情報として案内してください。',
    ].join('\n'),
};

interface ResolvedConversationSettings {
    characterNameKanji: string;
    characterNameKana: string;
    characterDisplayName: string;
    firstPerson: string;
    personaNote: string;
    speakingStyleNote: string;
    userName: string;
    userCallName: string;
    userProfileNote: string;
    addressedUser: string;
}

interface PersistentCharacterMemoryEntry {
    key: string;
    characterId: string;
    userKey: string;
    turns: CharacterChatTurn[];
    updatedAt: string;
}

export class CharacterChatService {
    private static instance: CharacterChatService | null = null;
    private readonly sessions = new Map<string, CharacterChatTurn[]>();
    private readonly profiles = new Map<string, CharacterProfile>([[DEFAULT_PROFILE.id, DEFAULT_PROFILE]]);
    private readonly memoryByKey = new Map<string, PersistentCharacterMemoryEntry>();
    private readonly memoryStorePath: string;

    private constructor() {
        const userDataPath = app.getPath('userData');
        this.memoryStorePath = path.join(userDataPath, MEMORY_STORE_FILENAME);
        this.loadPersistentMemory();
    }

    static getInstance(): CharacterChatService {
        if (!CharacterChatService.instance) {
            CharacterChatService.instance = new CharacterChatService();
        }
        return CharacterChatService.instance;
    }

    async sendMessage(request: CharacterChatRequest): Promise<CharacterChatResponse> {
        const userText = String(request.text || '').trim();
        if (!userText) {
            return {
                success: false,
                sessionId: request.sessionId || this.createSessionId(),
                error: 'text is required',
            };
        }

        const sessionId = request.sessionId || this.createSessionId();
        const profile = this.profiles.get(request.characterId || DEFAULT_CHARACTER_ID) || DEFAULT_PROFILE;
        const turns = this.sessions.get(sessionId) || [];
        const settings = this.resolveSettings(profile, request.settings);
        const memoryKey = this.buildMemoryKey(profile.id, settings);
        const memoryEntry = this.getOrCreateMemoryEntry(memoryKey, profile.id, settings);

        const userTurn: CharacterChatTurn = {
            role: 'user',
            text: userText,
            createdAt: new Date().toISOString(),
        };
        turns.push(userTurn);

        this.trimTurns(turns);

        const responseText = await this.generateResponse(profile, turns, memoryEntry.turns, userText, settings);
        const emotion = this.estimateEmotion(responseText);

        const assistantTurn: CharacterChatTurn = {
            role: 'assistant',
            text: responseText,
            createdAt: new Date().toISOString(),
            emotion,
        };
        turns.push(assistantTurn);

        this.trimTurns(turns);
        this.sessions.set(sessionId, turns);
        this.appendTurnToMemory(memoryEntry, userTurn);
        this.appendTurnToMemory(memoryEntry, assistantTurn);
        this.persistMemoryStore();

        return {
            success: true,
            sessionId,
            turnId: `${sessionId}:${turns.length}`,
            characterId: profile.id,
            responseText,
            emotion,
        };
    }

    resetSession(sessionId: string): { success: boolean } {
        this.sessions.delete(sessionId);
        return { success: true };
    }

    private createSessionId(): string {
        return `char_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    }

    private trimTurns(turns: CharacterChatTurn[]): void {
        if (turns.length <= MAX_SESSION_TURNS) {
            return;
        }
        turns.splice(0, turns.length - MAX_SESSION_TURNS);
    }

    private normalizeMemoryUserKey(settings: ResolvedConversationSettings): string {
        const source = (settings.userCallName || settings.userName || 'default_user').toLowerCase();
        const normalized = source
            .replace(/\s+/g, '_')
            .replace(/[^\p{L}\p{N}_-]+/gu, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 64);
        return normalized || 'default_user';
    }

    private buildMemoryKey(characterId: string, settings: ResolvedConversationSettings): string {
        return `${characterId}::${this.normalizeMemoryUserKey(settings)}`;
    }

    private getOrCreateMemoryEntry(
        key: string,
        characterId: string,
        settings: ResolvedConversationSettings,
    ): PersistentCharacterMemoryEntry {
        const existing = this.memoryByKey.get(key);
        if (existing) {
            return existing;
        }

        const created: PersistentCharacterMemoryEntry = {
            key,
            characterId,
            userKey: this.normalizeMemoryUserKey(settings),
            turns: [],
            updatedAt: new Date().toISOString(),
        };
        this.memoryByKey.set(key, created);
        return created;
    }

    private appendTurnToMemory(entry: PersistentCharacterMemoryEntry, turn: CharacterChatTurn): void {
        entry.turns.push({
            role: turn.role,
            text: String(turn.text || '').slice(0, 1200),
            createdAt: turn.createdAt || new Date().toISOString(),
            emotion: turn.emotion,
        });
        if (entry.turns.length > MAX_MEMORY_TURNS) {
            entry.turns.splice(0, entry.turns.length - MAX_MEMORY_TURNS);
        }
        entry.updatedAt = new Date().toISOString();
    }

    private normalizePersistedTurns(turns: unknown): CharacterChatTurn[] {
        if (!Array.isArray(turns)) {
            return [];
        }
        const normalized: CharacterChatTurn[] = [];
        for (const item of turns) {
            if (!item || typeof item !== 'object') continue;
            const raw = item as Partial<CharacterChatTurn>;
            if (raw.role !== 'user' && raw.role !== 'assistant') continue;
            const text = typeof raw.text === 'string' ? raw.text.trim() : '';
            if (!text) continue;

            normalized.push({
                role: raw.role,
                text: text.slice(0, 1200),
                createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
                emotion: raw.emotion,
            });
        }

        if (normalized.length > MAX_MEMORY_TURNS) {
            normalized.splice(0, normalized.length - MAX_MEMORY_TURNS);
        }

        return normalized;
    }

    private loadPersistentMemory(): void {
        try {
            if (!fs.existsSync(this.memoryStorePath)) {
                return;
            }
            const raw = fs.readFileSync(this.memoryStorePath, 'utf-8');
            const parsed = JSON.parse(raw) as { entries?: Record<string, Partial<PersistentCharacterMemoryEntry>> };
            const entries = parsed?.entries;
            if (!entries || typeof entries !== 'object') {
                return;
            }

            for (const [key, value] of Object.entries(entries)) {
                if (!value || typeof value !== 'object') continue;
                const characterId = typeof value.characterId === 'string' && value.characterId
                    ? value.characterId
                    : String(key.split('::')[0] || DEFAULT_CHARACTER_ID);
                const userKey = typeof value.userKey === 'string' && value.userKey
                    ? value.userKey
                    : String(key.split('::')[1] || 'default_user');
                const turns = this.normalizePersistedTurns(value.turns);
                const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString();

                this.memoryByKey.set(key, {
                    key,
                    characterId,
                    userKey,
                    turns,
                    updatedAt,
                });
            }
        } catch (error) {
            console.warn('[CharacterChat] Failed to load persistent memory:', error);
        }
    }

    private persistMemoryStore(): void {
        try {
            const entries: Record<string, PersistentCharacterMemoryEntry> = {};
            for (const [key, value] of this.memoryByKey.entries()) {
                entries[key] = value;
            }
            fs.mkdirSync(path.dirname(this.memoryStorePath), { recursive: true });
            fs.writeFileSync(this.memoryStorePath, JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
        } catch (error) {
            console.warn('[CharacterChat] Failed to save persistent memory:', error);
        }
    }

    private cleanSettingText(value: unknown, maxLen: number): string {
        if (typeof value !== 'string') return '';
        return value.trim().replace(/\s+/g, ' ').slice(0, maxLen);
    }

    private resolveSettings(profile: CharacterProfile, settings?: CharacterConversationSettings): ResolvedConversationSettings {
        const characterSettings = settings?.character;
        const userSettings = settings?.user;
        const characterNameKanji = this.cleanSettingText(characterSettings?.nameKanji, 48)
            || this.cleanSettingText(characterSettings?.name, 48)
            || profile.name;
        const characterNameKana = this.cleanSettingText(characterSettings?.nameKana, 64);
        const userName = this.cleanSettingText(userSettings?.name, 48);
        const userCallName = this.cleanSettingText(userSettings?.callName, 48);
        const addressedUser = userCallName || userName || 'あなた';

        return {
            characterNameKanji,
            characterNameKana,
            characterDisplayName: characterNameKanji,
            firstPerson: this.cleanSettingText(characterSettings?.firstPerson, 16) || DEFAULT_FIRST_PERSON,
            personaNote: this.cleanSettingText(characterSettings?.personaNote, 260),
            speakingStyleNote: this.cleanSettingText(characterSettings?.speakingStyleNote, 180),
            userName,
            userCallName,
            userProfileNote: this.cleanSettingText(userSettings?.profileNote, 260),
            addressedUser,
        };
    }

    private buildPrompt(
        profile: CharacterProfile,
        turns: CharacterChatTurn[],
        memoryTurns: CharacterChatTurn[],
        userText: string,
        settings: ResolvedConversationSettings,
    ): string {
        const history = turns
            .slice(-12)
            .map((turn) => `${turn.role === 'user' ? settings.addressedUser : settings.characterDisplayName}: ${turn.text}`)
            .join('\n');
        const continuityHistory = memoryTurns
            .slice(-MEMORY_PROMPT_TURNS)
            .map((turn) => `${turn.role === 'user' ? settings.addressedUser : settings.characterDisplayName}: ${turn.text}`)
            .join('\n');

        return [
            profile.systemPrompt,
            `characterId: ${profile.id}`,
            `personaVersion: ${profile.personaVersion}`,
            `styleKeywords: ${profile.styleKeywords.join(', ')}`,
            `キャラクター名(漢字): ${settings.characterNameKanji}`,
            settings.characterNameKana ? `キャラクター名(読み): ${settings.characterNameKana}` : '',
            `一人称: ${settings.firstPerson}`,
            `ユーザー呼称（最優先）: ${settings.addressedUser}`,
            settings.userName ? `ユーザー名: ${settings.userName}` : '',
            settings.userCallName ? `ユーザー希望の呼び名: ${settings.userCallName}` : '',
            settings.personaNote ? `キャラ追加設定: ${settings.personaNote}` : '',
            settings.speakingStyleNote ? `話し方メモ: ${settings.speakingStyleNote}` : '',
            settings.userProfileNote ? `ユーザー情報メモ: ${settings.userProfileNote}` : '',
            'ユーザー呼称は「あなた」固定にせず、指定があれば指定名を優先してください。',
            'キャラクター名は漢字名を優先し、必要なら読み仮名を発音・表現の参考にしてください。',
            '',
            continuityHistory ? '以下は過去セッションから引き継いだ記憶です。矛盾しない範囲で活用してください。' : '',
            continuityHistory,
            '以下は会話履歴です。',
            history,
            '',
            `最新のユーザー入力: ${userText}`,
            '上の方針を守り、日本語で返信してください。返答は最長3文。',
        ].filter(Boolean).join('\n');
    }

    private async generateResponse(
        profile: CharacterProfile,
        turns: CharacterChatTurn[],
        memoryTurns: CharacterChatTurn[],
        userText: string,
        settings: ResolvedConversationSettings,
    ): Promise<string> {
        const prompt = this.buildPrompt(profile, turns, memoryTurns, userText, settings);
        const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
        const projectId = process.env.GCP_PROJECT_ID;
        const modelId = process.env.CHARACTER_CHAT_MODEL || 'gemini-2.0-flash-001';

        if (!apiKey && !projectId) {
            return this.buildFallbackResponse(userText, settings);
        }

        try {
            const { GoogleGenAI } = await import('@google/genai');
            const ai = apiKey
                ? new GoogleGenAI({ apiKey })
                : new GoogleGenAI({
                    vertexai: true,
                    project: projectId,
                    location: process.env.GCP_LOCATION || 'us-central1',
                });

            const result: any = await ai.models.generateContent({
                model: modelId,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
            });
            const text = this.extractText(result).trim();
            if (text) {
                return text;
            }
        } catch (error) {
            console.error('[CharacterChat] generateContent error:', error);
        }

        return this.buildFallbackResponse(userText, settings);
    }

    private extractText(result: any): string {
        if (!result) return '';
        const candidateText = result?.candidates?.[0]?.content?.parts
            ?.map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
            .join('');
        if (typeof candidateText === 'string' && candidateText.trim().length > 0) {
            return candidateText;
        }
        if (typeof result?.text === 'string') {
            return result.text;
        }
        return '';
    }

    private buildFallbackResponse(userText: string, settings: ResolvedConversationSettings): string {
        return `了解です、${settings.addressedUser}。${settings.addressedUser}の「${userText}」についてお手伝いします。まずは要点を整理して一緒に進めましょう。`;
    }

    private estimateEmotion(text: string): CharacterEmotionResult {
        const lower = text.toLowerCase();
        const scores: Record<CharacterEmotionLabel, number> = {
            neutral: 0.4,
            joy: 0,
            sad: 0,
            angry: 0,
            excited: 0,
        };

        const joyWords = ['嬉', '楽しい', '最高', 'やった', 'ありがとう', 'うれしい'];
        const sadWords = ['悲', 'つらい', '寂', 'しんど', '落ち込'];
        const angryWords = ['怒', '許せ', '最悪', 'ふざけ', '頭にくる'];
        const excitedWords = ['！', 'すごい', 'わくわく', 'テンション', '本当に'];

        for (const word of joyWords) if (lower.includes(word.toLowerCase())) scores.joy += 0.35;
        for (const word of sadWords) if (lower.includes(word.toLowerCase())) scores.sad += 0.35;
        for (const word of angryWords) if (lower.includes(word.toLowerCase())) scores.angry += 0.35;
        for (const word of excitedWords) if (lower.includes(word.toLowerCase())) scores.excited += 0.25;

        const exclamationCount = (text.match(/!/g) || []).length + (text.match(/！/g) || []).length;
        scores.excited += Math.min(0.5, exclamationCount * 0.08);

        const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const top = sorted[0];
        const second = sorted[1];

        const label = top ? (top[0] as CharacterEmotionLabel) : 'neutral';
        const margin = top && second ? Math.max(0, top[1] - second[1]) : 0;
        const intensity = Math.max(0, Math.min(1, 0.35 + margin * 1.2 + Math.min(0.25, top[1] * 0.15)));

        return { label, intensity };
    }
}
