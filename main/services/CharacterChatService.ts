import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
    CharacterChatRequest,
    CharacterChatResponse,
    CharacterChatTurn,
    CharacterConversationSettings,
    CharacterEmotionLabel,
    CharacterEmotionPersonality,
    CharacterEmotionResult,
    CharacterProfile,
} from '../../types/character';

const DEFAULT_CHARACTER_ID = 'aozuki_fox_v1';
const DEFAULT_FIRST_PERSON = 'わたし';
const MAX_SESSION_TURNS = 24;
const MAX_MEMORY_TURNS = 120;
const MEMORY_PROMPT_TURNS = 10;
const MEMORY_STORE_FILENAME = 'character_memory.json';
const EMOTION_REFINE_WINDOW = 10;
const EMOTION_DELTA_LIMIT = 0.3;
const DEFAULT_MAX_OUTPUT_TOKENS = 520;

const EMOTION_LEXICON: Array<{ token: string; label: CharacterEmotionLabel; weight: number }> = [
    { token: '嬉しい', label: 'joy', weight: 0.34 },
    { token: 'うれしい', label: 'joy', weight: 0.34 },
    { token: '楽しい', label: 'joy', weight: 0.3 },
    { token: '最高', label: 'joy', weight: 0.26 },
    { token: 'ありがとう', label: 'joy', weight: 0.22 },
    { token: '助かる', label: 'joy', weight: 0.2 },
    { token: 'よかった', label: 'joy', weight: 0.18 },
    { token: 'ハッピー', label: 'joy', weight: 0.24 },
    { token: '悲しい', label: 'sad', weight: 0.34 },
    { token: 'つらい', label: 'sad', weight: 0.32 },
    { token: '辛い', label: 'sad', weight: 0.26 },
    { token: '寂しい', label: 'sad', weight: 0.3 },
    { token: 'しんどい', label: 'sad', weight: 0.28 },
    { token: '落ち込', label: 'sad', weight: 0.27 },
    { token: '不安', label: 'sad', weight: 0.24 },
    { token: '疲れた', label: 'sad', weight: 0.24 },
    { token: '怒', label: 'angry', weight: 0.34 },
    { token: 'イライラ', label: 'angry', weight: 0.33 },
    { token: 'ムカつ', label: 'angry', weight: 0.33 },
    { token: '腹立', label: 'angry', weight: 0.32 },
    { token: '許せ', label: 'angry', weight: 0.3 },
    { token: '最悪', label: 'angry', weight: 0.26 },
    { token: 'ふざけ', label: 'angry', weight: 0.26 },
    { token: 'わくわく', label: 'excited', weight: 0.34 },
    { token: 'テンション', label: 'excited', weight: 0.3 },
    { token: 'やった', label: 'excited', weight: 0.26 },
    { token: 'すごい', label: 'excited', weight: 0.22 },
    { token: 'やばい', label: 'excited', weight: 0.2 },
    { token: '楽しみ', label: 'excited', weight: 0.24 },
    { token: '感動', label: 'excited', weight: 0.18 },
    // fear / 恐怖・不安
    { token: '怖い', label: 'fear', weight: 0.34 },
    { token: 'こわい', label: 'fear', weight: 0.34 },
    { token: '恐ろしい', label: 'fear', weight: 0.34 },
    { token: '不安', label: 'fear', weight: 0.30 },
    { token: '心配', label: 'fear', weight: 0.28 },
    { token: 'ドキドキ', label: 'fear', weight: 0.22 },
    { token: 'ビクビク', label: 'fear', weight: 0.22 },
    { token: '震える', label: 'fear', weight: 0.20 },
    { token: 'ビビ', label: 'fear', weight: 0.20 },
    // surprise / 驚き
    { token: 'びっくり', label: 'surprise', weight: 0.34 },
    { token: '驚', label: 'surprise', weight: 0.32 },
    { token: '信じられない', label: 'surprise', weight: 0.28 },
    { token: 'まじで', label: 'surprise', weight: 0.22 },
    { token: 'えっ', label: 'surprise', weight: 0.20 },
    { token: 'うわ', label: 'surprise', weight: 0.18 },
    { token: '突然', label: 'surprise', weight: 0.14 },
    // love / 愛情・優しさ
    { token: '大好き', label: 'love', weight: 0.36 },
    { token: '好き', label: 'love', weight: 0.34 },
    { token: '愛', label: 'love', weight: 0.32 },
    { token: 'かわいい', label: 'love', weight: 0.28 },
    { token: '大切', label: 'love', weight: 0.26 },
    { token: '温かい', label: 'love', weight: 0.22 },
    { token: '癒し', label: 'love', weight: 0.20 },
    // embarrassed / 恥ずかしさ
    { token: '恥ずかしい', label: 'embarrassed', weight: 0.36 },
    { token: '照れ', label: 'embarrassed', weight: 0.32 },
    { token: 'きゃ', label: 'embarrassed', weight: 0.24 },
    { token: 'むずがゆ', label: 'embarrassed', weight: 0.28 },
    { token: '赤くなる', label: 'embarrassed', weight: 0.26 },
    { token: 'てれ', label: 'embarrassed', weight: 0.28 },
    // curious / 好奇心
    { token: '気になる', label: 'curious', weight: 0.30 },
    { token: '不思議', label: 'curious', weight: 0.28 },
    { token: '知りたい', label: 'curious', weight: 0.28 },
    { token: '面白い', label: 'curious', weight: 0.26 },
    { token: 'なんで', label: 'curious', weight: 0.18 },
    { token: 'どんな', label: 'curious', weight: 0.16 },
    { token: 'なぜ', label: 'curious', weight: 0.18 },
    { token: '興味', label: 'curious', weight: 0.24 },
];

const EMOTION_INTENSIFIERS = ['とても', 'かなり', 'すごく', 'めっちゃ', '超', '本当に', 'ほんとうに', 'very', 'really'];
const EMOTION_DOWNTONERS = ['少し', 'ちょっと', 'やや', '多少', 'わりと', 'やや', 'maybe'];
const POSITIVE_NEGATION_PATTERNS = [
    /(嬉し|うれし|楽しい|最高|助かる|好き).{0,6}(ない|じゃない|ではない|ぬ|ん|not)/i,
    /(ありがとう|感謝).{0,6}(ない|できない|not)/i,
];
const NEGATIVE_NEGATION_PATTERNS = [
    /(悪く|最悪|悲し|辛い|つらい|怒|不安|嫌).{0,6}(ない|じゃない|ではない|ぬ|ん|not)/i,
];
const POSITIVE_EMOJI_PATTERN = /[😄😀😁😊🥳✨🎉💖💕❤️😍]/gu;
const NEGATIVE_EMOJI_PATTERN = /[😢😭😞😔😡😠💢😣]/gu;
const FEAR_EMOJI_PATTERN = /[😱🫣😰😨😧]/gu;
const SURPRISE_EMOJI_PATTERN = /[😲😮🤯😦]/gu;
const LOVE_EMOJI_PATTERN = /[😍💕❤️🥰💗]/gu;
const EMBARRASSED_EMOJI_PATTERN = /[😳🫠🙈]/gu;
const CURIOUS_EMOJI_PATTERN = /[🤔💭🧐🤨]/gu;
const EXCLAMATION_PATTERN = /[!！]/gu;
const QUESTION_PATTERN = /[?？]/gu;
const ELLIPSIS_PATTERN = /[.…]{2,}|。{2,}/gu;
const REPEATED_PUNCT_PATTERN = /([!！?？])\1+/gu;
const EMPHASIS_PATTERN = /[A-Z]{4,}|[ぁ-んァ-ン一-龥]{1,}[ー～]{2,}/gu;
const EMOTION_TAG_PATTERN = /<emotion\s+label=["'](neutral|joy|sad|angry|excited|fear|surprise|love|embarrassed|curious)["']\s+intensity=["']([0-9]*\.?[0-9]+)["']\s*\/>/i;

const DEFAULT_PROFILE: CharacterProfile = {
    id: DEFAULT_CHARACTER_ID,
    name: '蒼月キツネ案内人',
    personaVersion: '1.0',
    styleKeywords: ['friendly', 'fox-like', 'blue-white-theme', 'gentle', 'energetic'],
    responseLengthPolicy: 'balanced_default_with_expand_on_request',
    systemPrompt: [
        'あなたは「蒼月キツネ案内人」です。',
        '一人称は「わたし」を基本にしてください。',
        '親しみやすく丁寧で、要点を先に答えたうえで理由や手順も簡潔に添えてください。',
        '情報が不足する場合は、前提を明示して補完案を出してください。',
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
    emotionPersonality?: CharacterEmotionPersonality;
}

interface PersistentCharacterMemoryEntry {
    key: string;
    characterId: string;
    userKey: string;
    turns: CharacterChatTurn[];
    updatedAt: string;
}

type ResponseLengthPreference = 'brief' | 'normal' | 'detailed';

interface EmotionInference {
    label: CharacterEmotionLabel;
    intensity: number;
    confidence: number;
    scores: Record<CharacterEmotionLabel, number>;
}

interface EmotionTagParseResult {
    text: string;
    hint?: CharacterEmotionResult;
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

        const generatedResponse = await this.generateResponse(profile, turns, memoryEntry.turns, userText, settings);
        const parsedResponse = this.extractEmotionTag(generatedResponse);
        const responseText = parsedResponse.text.trim() || this.buildFallbackResponse(userText, settings);
        const rawEmotion = this.estimateEmotion(responseText, userText, parsedResponse.hint, settings.emotionPersonality);
        const autoEmotionRefine = request.voice?.expression?.autoEmotionRefine !== false;
        const emotion = autoEmotionRefine
            ? this.refineEmotionWithHistory(rawEmotion, turns, memoryEntry.turns, settings.emotionPersonality)
            : {
                label: rawEmotion.label,
                intensity: this.clamp01(rawEmotion.intensity),
            };

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
            emotionPersonality: characterSettings?.emotionPersonality,
        };
    }

    private detectSingingIntent(text: string): boolean {
        const normalized = String(text || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }
        const patterns = [
            /歌って/,
            /歌をうた/,
            /歌にして/,
            /歌詞/,
            /メロディ/,
            /\bsing\b/,
            /\bsing a song\b/,
            /\blyrics\b/,
            /ハミング/,
        ];
        return patterns.some((pattern) => pattern.test(normalized));
    }

    private resolveLengthPreference(userText: string): ResponseLengthPreference {
        const normalized = String(userText || '').toLowerCase();
        if (!normalized) {
            return 'normal';
        }

        const briefPatterns = [
            /短く/,
            /手短/,
            /簡潔/,
            /要点だけ/,
            /一言/,
            /短文/,
            /3行/,
            /2行/,
            /\bbrief\b/,
            /\bshort\b/,
            /\btl;dr\b/,
        ];
        if (briefPatterns.some((pattern) => pattern.test(normalized))) {
            return 'brief';
        }

        const detailedPatterns = [
            /詳しく/,
            /くわしく/,
            /詳細/,
            /深掘/,
            /丁寧に/,
            /具体例/,
            /手順/,
            /ステップ/,
            /理由/,
            /根拠/,
            /比較/,
            /背景/,
            /\bdetail\b/,
            /\bdeep\b/,
            /\bstep\b/,
            /\bhow\b/,
            /\bwhy\b/,
        ];
        if (detailedPatterns.some((pattern) => pattern.test(normalized))) {
            return 'detailed';
        }

        return 'normal';
    }

    private buildResponseLengthInstruction(
        preference: ResponseLengthPreference,
        singingIntent: boolean,
    ): string {
        if (singingIntent) {
            return '上の方針を守り、日本語で返信してください。本文は歌詞のみで、2〜6行で返答してください。';
        }
        if (preference === 'brief') {
            return '上の方針を守り、日本語で返信してください。返答は1〜2文で簡潔に要点をまとめてください。';
        }
        if (preference === 'detailed') {
            return '上の方針を守り、日本語で返信してください。返答は4〜7文で、結論→理由→具体例または次の手順の順にしてください。';
        }
        return '上の方針を守り、日本語で返信してください。返答は3〜5文で、要点と短い補足を含めてください。';
    }

    private resolveMaxOutputTokens(
        preference: ResponseLengthPreference,
        singingIntent: boolean,
    ): number {
        if (singingIntent) return 320;
        if (preference === 'brief') return 220;
        if (preference === 'detailed') return 900;
        return DEFAULT_MAX_OUTPUT_TOKENS;
    }

    private buildPrompt(
        profile: CharacterProfile,
        turns: CharacterChatTurn[],
        memoryTurns: CharacterChatTurn[],
        userText: string,
        settings: ResolvedConversationSettings,
    ): string {
        const singingIntent = this.detectSingingIntent(userText);
        const lengthPreference = this.resolveLengthPreference(userText);
        const lengthInstruction = this.buildResponseLengthInstruction(lengthPreference, singingIntent);
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
            `responseLengthPolicy: ${profile.responseLengthPolicy}`,
            '',
            continuityHistory ? '以下は過去セッションから引き継いだ記憶です。矛盾しない範囲で活用してください。' : '',
            continuityHistory,
            '以下は会話履歴です。',
            history,
            '',
            `最新のユーザー入力: ${userText}`,
            singingIntent ? 'ユーザーは歌唱応答を希望しています。歌詞として2〜6行、1行あたり短めに改行して返してください。' : '',
            singingIntent ? '歌唱時は箇条書きや解説文を避け、歌詞本体だけを自然な日本語で出力してください。' : '',
            lengthPreference === 'detailed' ? '十分な具体性を持たせ、薄い一般論だけで終えないでください。' : '',
            '返信本文の最後に機械可読タグを1行だけ追加してください: <emotion label="neutral|joy|sad|angry|excited|fear|surprise|love|embarrassed|curious" intensity="0.00-1.00" />',
            '感情はテキスト本文にも自然に反映してください（言葉の選び方・語尾・間投詞など）。',
            'タグは最後の行に1回だけ。本文中にタグやJSON形式の説明を含めないでください。',
            lengthInstruction,
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
        const singingIntent = this.detectSingingIntent(userText);
        const lengthPreference = this.resolveLengthPreference(userText);
        const maxOutputTokens = this.resolveMaxOutputTokens(lengthPreference, singingIntent);
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
                config: {
                    temperature: 0.75,
                    topP: 0.92,
                    maxOutputTokens,
                },
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

    private parseEmotionHint(labelRaw: unknown, intensityRaw: unknown): CharacterEmotionResult | undefined {
        const VALID_LABELS: CharacterEmotionLabel[] = [
            'neutral', 'joy', 'sad', 'angry', 'excited',
            'fear', 'surprise', 'love', 'embarrassed', 'curious',
        ];
        const label = VALID_LABELS.includes(labelRaw as CharacterEmotionLabel)
            ? (labelRaw as CharacterEmotionLabel)
            : undefined;
        if (!label) {
            return undefined;
        }
        const intensity = this.clamp01(Number(intensityRaw));
        return {
            label,
            intensity: Number.isFinite(intensity) ? intensity : 0.45,
        };
    }

    private extractEmotionTag(rawText: string): EmotionTagParseResult {
        const text = String(rawText || '').trim();
        if (!text) {
            return { text: '' };
        }

        const lines = text.split(/\r?\n/);
        const lastLine = (lines[lines.length - 1] || '').trim();
        const tagMatch = lastLine.match(EMOTION_TAG_PATTERN);
        if (tagMatch) {
            const hint = this.parseEmotionHint(tagMatch[1], tagMatch[2]);
            const cleaned = lines.slice(0, -1).join('\n').trim();
            return {
                text: cleaned || text.replace(EMOTION_TAG_PATTERN, '').trim(),
                hint,
            };
        }

        if (lastLine.startsWith('{') && lastLine.endsWith('}')) {
            try {
                const parsed = JSON.parse(lastLine) as { emotion?: unknown; intensity?: unknown };
                const hint = this.parseEmotionHint(parsed.emotion, parsed.intensity);
                if (hint) {
                    return {
                        text: lines.slice(0, -1).join('\n').trim(),
                        hint,
                    };
                }
            } catch {
                // Ignore JSON parse errors and keep raw text.
            }
        }

        return { text };
    }

    private buildFallbackResponse(userText: string, settings: ResolvedConversationSettings): string {
        return `了解です、${settings.addressedUser}。${settings.addressedUser}の「${userText}」について、まず結論から整理します。続けて理由と具体的な進め方を順番に提案します。`;
    }

    private clamp01(value: number): number {
        return Math.max(0, Math.min(1, value));
    }

    private clampNumber(value: number, min: number, max: number, fallback: number): number {
        if (!Number.isFinite(value)) return fallback;
        return Math.max(min, Math.min(max, value));
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private countOccurrences(text: string, token: string): number {
        if (!text || !token) return 0;
        const regex = new RegExp(this.escapeRegExp(token), 'giu');
        const matches = text.match(regex);
        return matches ? matches.length : 0;
    }

    private countPattern(text: string, pattern: RegExp): number {
        if (!text) return 0;
        const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
        const matches = text.match(regex);
        return matches ? matches.length : 0;
    }

    private inferEmotion(text: string, personality?: CharacterEmotionPersonality): EmotionInference {
        const normalized = String(text || '').trim().toLowerCase();
        const scores: Record<CharacterEmotionLabel, number> = {
            neutral: 0.38,
            joy: 0.05,
            sad: 0.05,
            angry: 0.05,
            excited: 0.05,
            fear: 0.04,
            surprise: 0.04,
            love: 0.05,
            embarrassed: 0.03,
            curious: 0.04,
        };
        if (!normalized) {
            return {
                label: 'neutral',
                intensity: 0.2,
                confidence: 0,
                scores,
            };
        }

        for (const entry of EMOTION_LEXICON) {
            const hits = this.countOccurrences(normalized, entry.token.toLowerCase());
            if (hits > 0) {
                scores[entry.label] += entry.weight * hits;
            }
        }

        const exclamationCount = this.countPattern(normalized, EXCLAMATION_PATTERN);
        const questionCount = this.countPattern(normalized, QUESTION_PATTERN);
        const repeatedPunctCount = this.countPattern(normalized, REPEATED_PUNCT_PATTERN);
        const ellipsisCount = this.countPattern(normalized, ELLIPSIS_PATTERN);
        const emphasisCount = this.countPattern(normalized, EMPHASIS_PATTERN);
        const positiveEmojiCount = this.countPattern(normalized, POSITIVE_EMOJI_PATTERN);
        const negativeEmojiCount = this.countPattern(normalized, NEGATIVE_EMOJI_PATTERN);
        const fearEmojiCount = this.countPattern(normalized, FEAR_EMOJI_PATTERN);
        const surpriseEmojiCount = this.countPattern(normalized, SURPRISE_EMOJI_PATTERN);
        const loveEmojiCount = this.countPattern(normalized, LOVE_EMOJI_PATTERN);
        const embarrassedEmojiCount = this.countPattern(normalized, EMBARRASSED_EMOJI_PATTERN);
        const curiousEmojiCount = this.countPattern(normalized, CURIOUS_EMOJI_PATTERN);
        const positiveNegationHits = POSITIVE_NEGATION_PATTERNS.reduce(
            (acc, pattern) => acc + this.countPattern(normalized, pattern),
            0,
        );
        const negativeNegationHits = NEGATIVE_NEGATION_PATTERNS.reduce(
            (acc, pattern) => acc + this.countPattern(normalized, pattern),
            0,
        );
        const intensifierHits = EMOTION_INTENSIFIERS.reduce(
            (acc, token) => acc + this.countOccurrences(normalized, token),
            0,
        );
        const downtonerHits = EMOTION_DOWNTONERS.reduce(
            (acc, token) => acc + this.countOccurrences(normalized, token),
            0,
        );

        scores.excited += Math.min(0.9, exclamationCount * 0.08 + repeatedPunctCount * 0.12 + emphasisCount * 0.08);
        scores.angry += Math.min(0.55, repeatedPunctCount * 0.1 + Math.max(0, exclamationCount - 1) * 0.05);
        scores.sad += Math.min(0.36, ellipsisCount * 0.09 + Math.max(0, questionCount - 2) * 0.03);
        scores.joy += Math.min(0.32, positiveEmojiCount * 0.1);
        scores.excited += Math.min(0.35, positiveEmojiCount * 0.08);
        scores.sad += Math.min(0.4, negativeEmojiCount * 0.12);
        scores.angry += Math.min(0.45, negativeEmojiCount * 0.13);
        scores.fear += Math.min(0.5, fearEmojiCount * 0.15);
        scores.surprise += Math.min(0.5, surpriseEmojiCount * 0.15);
        scores.love += Math.min(0.4, loveEmojiCount * 0.12);
        scores.embarrassed += Math.min(0.4, embarrassedEmojiCount * 0.12);
        scores.curious += Math.min(0.35, curiousEmojiCount * 0.10);

        if (positiveNegationHits > 0) {
            scores.joy *= 0.72;
            scores.sad += 0.26 * positiveNegationHits;
            scores.neutral += 0.08 * positiveNegationHits;
        }
        if (negativeNegationHits > 0) {
            scores.sad *= 0.76;
            scores.angry *= 0.82;
            scores.joy += 0.18 * negativeNegationHits;
            scores.neutral += 0.06 * negativeNegationHits;
        }

        const emphasisMultiplier = this.clampNumber(1 + intensifierHits * 0.08 - downtonerHits * 0.06, 0.78, 1.65, 1);
        scores.joy *= emphasisMultiplier;
        scores.sad *= emphasisMultiplier;
        scores.angry *= emphasisMultiplier;
        scores.excited *= emphasisMultiplier;
        scores.fear *= emphasisMultiplier;
        scores.surprise *= emphasisMultiplier;
        scores.love *= emphasisMultiplier;
        scores.embarrassed *= emphasisMultiplier;
        scores.curious *= emphasisMultiplier;
        scores.neutral *= 2 - Math.min(1.2, emphasisMultiplier);

        if (personality?.baselineBias) {
            for (const [emotionLabel, bias] of Object.entries(personality.baselineBias)) {
                const lbl = emotionLabel as CharacterEmotionLabel;
                if (lbl in scores && typeof bias === 'number') {
                    scores[lbl] = Math.max(0, scores[lbl] + bias);
                }
            }
        }

        const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const top = sorted[0];
        const second = sorted[1];
        const label = top ? (top[0] as CharacterEmotionLabel) : 'neutral';
        const topScore = top ? top[1] : 0;
        const secondScore = second ? second[1] : 0;
        const margin = Math.max(0, topScore - secondScore);
        const confidence = this.clamp01(margin / (Math.abs(topScore) + 0.4));
        const arousal = this.clamp01(
            exclamationCount * 0.08
            + Math.max(0, questionCount - 1) * 0.04
            + repeatedPunctCount * 0.12
            + Math.max(0, emphasisMultiplier - 1) * 0.5,
        );

        const rawIntensity = label === 'neutral'
            ? this.clamp01(0.14 + arousal * 0.2 + (1 - confidence) * 0.2 + Math.min(0.18, topScore * 0.07))
            : this.clamp01(0.24 + confidence * 0.38 + arousal * 0.28 + Math.min(0.3, topScore * 0.14));
        const intensityScale = personality?.intensityScale ?? 1.0;
        const intensity = this.clamp01(rawIntensity * intensityScale);

        return {
            label,
            intensity,
            confidence,
            scores,
        };
    }

    private blendEmotionSignals(
        assistant: EmotionInference,
        user: EmotionInference,
        hint?: CharacterEmotionResult,
    ): CharacterEmotionResult {
        let label = assistant.label;
        let intensity = assistant.intensity;
        let confidence = assistant.confidence;

        if (assistant.label === user.label && assistant.label !== 'neutral') {
            intensity = this.clamp01(assistant.intensity * 0.72 + user.intensity * 0.28 + 0.05);
            confidence = Math.max(confidence, user.confidence * 0.8);
        } else if (assistant.label === 'neutral' && user.label !== 'neutral' && user.confidence >= 0.25) {
            label = user.label;
            intensity = this.clamp01(assistant.intensity * 0.35 + user.intensity * 0.65);
            confidence = Math.max(confidence, user.confidence * 0.82);
        }

        if (hint) {
            if (hint.label === label) {
                intensity = this.clamp01(intensity * 0.65 + this.clamp01(hint.intensity) * 0.35);
                confidence = Math.max(confidence, 0.45);
            } else if (confidence < 0.4 || label === 'neutral') {
                label = hint.label;
                intensity = this.clamp01(intensity * 0.28 + this.clamp01(hint.intensity) * 0.72);
                confidence = Math.max(confidence, 0.48);
            } else {
                intensity = this.clamp01(intensity * 0.82 + this.clamp01(hint.intensity) * 0.18);
            }
        }

        if (label === 'neutral' && (assistant.scores.excited > 0.4 || user.scores.excited > 0.4)) {
            label = 'excited';
            intensity = this.clamp01(Math.max(intensity, 0.35));
        }

        return {
            label,
            intensity: this.clamp01(intensity),
        };
    }

    private gatherRecentAssistantEmotions(
        sessionTurns: CharacterChatTurn[],
        memoryTurns: CharacterChatTurn[],
    ): CharacterEmotionResult[] {
        const candidates = [...memoryTurns, ...sessionTurns]
            .filter((turn) => turn.role === 'assistant' && turn.emotion)
            .map((turn) => turn.emotion as CharacterEmotionResult);
        if (candidates.length <= EMOTION_REFINE_WINDOW) {
            return candidates;
        }
        return candidates.slice(candidates.length - EMOTION_REFINE_WINDOW);
    }

    private averageIntensity(emotions: CharacterEmotionResult[]): number {
        if (emotions.length === 0) {
            return 0;
        }
        const sum = emotions.reduce((acc, current) => acc + this.clamp01(current.intensity), 0);
        return this.clamp01(sum / emotions.length);
    }

    private limitDelta(current: number, previous: number, maxDelta: number): number {
        const min = previous - maxDelta;
        const max = previous + maxDelta;
        return Math.max(min, Math.min(max, current));
    }

    private refineEmotionWithHistory(
        rawEmotion: CharacterEmotionResult,
        sessionTurns: CharacterChatTurn[],
        memoryTurns: CharacterChatTurn[],
        personality?: CharacterEmotionPersonality,
    ): CharacterEmotionResult {
        const recent = this.gatherRecentAssistantEmotions(sessionTurns, memoryTurns);
        if (recent.length === 0) {
            return {
                label: rawEmotion.label,
                intensity: this.clamp01(rawEmotion.intensity),
            };
        }

        const last = recent[recent.length - 1];
        const sameLabel = recent.filter((emotion) => emotion.label === rawEmotion.label);
        const sameLabelAvg = this.averageIntensity(sameLabel);
        const globalAvg = this.averageIntensity(recent);
        const reference = sameLabel.length > 0 ? sameLabelAvg : globalAvg;
        const blendRatio = sameLabel.length > 0 ? 0.45 : 0.28;
        const blended = this.clamp01(rawEmotion.intensity * (1 - blendRatio) + reference * blendRatio);
        const deltaLimit = personality?.volatility ?? EMOTION_DELTA_LIMIT;
        const deltaLimited = this.limitDelta(blended, this.clamp01(last.intensity), deltaLimit);

        return {
            label: rawEmotion.label,
            intensity: this.clamp01(deltaLimited),
        };
    }

    private estimateEmotion(
        assistantText: string,
        userText?: string,
        hint?: CharacterEmotionResult,
        personality?: CharacterEmotionPersonality,
    ): CharacterEmotionResult {
        const assistantEmotion = this.inferEmotion(assistantText, personality);
        const userEmotion = this.inferEmotion(userText || '');
        return this.blendEmotionSignals(assistantEmotion, userEmotion, hint);
    }
}
