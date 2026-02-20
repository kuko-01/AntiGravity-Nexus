import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

type StudioMode = 'sbv2' | 'rvc' | 'sbv2+rvc';
type TtsInstallState = 'not_installed' | 'installing' | 'installed' | 'corrupted' | 'upgrade_available';
type TtsRuntimeState = 'stopped' | 'starting' | 'running' | 'error' | 'restarting';
type RvcF0Method = 'rmvpe' | 'harvest' | 'crepe';
type RvcTestInputSource = 'mic' | 'app';
type AutoEmotion = 'neutral' | 'joy' | 'sadness' | 'anger' | 'fear';
type AutoEmotionStrengthPreset = 'subtle' | 'standard' | 'strong';
type AutoEmotionApplyMode = 'fixed_style' | 'auto_style';
type AutoEmotionOverride = 'auto' | AutoEmotion;
type AutoEmotionAnalyzerMode = 'rule' | 'classifier' | 'hybrid';
type AssistDirectionPreset = 'none' | 'bright' | 'dark' | 'joy' | 'anger' | 'sadness' | 'fear' | 'calm';

interface TtsStatus {
    installState: TtsInstallState;
    runtimeState: TtsRuntimeState;
    port?: number;
}

interface RvcStatus {
    installState: TtsInstallState;
    runtimeState: TtsRuntimeState;
    port?: number;
}

interface TtsModel {
    id: string;
    name: string;
    styles: string[];
    defaultStyle: string;
}

interface RvcModel {
    id: string;
    name: string;
    path: string;
    hasIndex: boolean;
}

interface TtsPreset {
    id: string;
    name: string;
    modelId: string;
    style: string;
    speed: number;
    pitch: number;
    intonation: number;
    styleWeight?: number;
    sdpRatio?: number;
    noiseScale?: number;
    noiseScaleW?: number;
}

interface RvcPreset {
    id: string;
    name: string;
    modelId: string;
    f0Method: RvcF0Method;
    transpose: number;
    indexRate: number;
    protect: number;
    filterRadius: number;
    rmsMixRate: number;
    resampleSr: number;
}

interface MediaDeviceOption {
    deviceId: string;
    label: string;
}

interface AudioProcessOption {
    pid: number;
    name: string;
    title: string;
}

interface SpeakerScanResult {
    sid: number;
    audioUrl?: string;
    error?: string;
}

interface RvcTestPendingChunk {
    pcm: number[];
    skipSamples: number; // samples to drop from converted output (mapped from 16k domain)
    takeSamples: number; // samples to keep after skip (16k domain)
    isSpeech: boolean;
    speechRatio: number;
}

interface RvcTestOutputChunk {
    audioBase64: string;
    skipSamples: number; // 16k domain
    takeSamples: number; // 16k domain
}

interface AutoEmotionAnalysis {
    emotion: AutoEmotion;
    confidence: number; // 0..1
    intensity: number; // 0..1
    scoreByEmotion: Record<AutoEmotion, number>;
    reason: string;
}

interface AutoEmotionSynthesisParams {
    style: string;
    speed: number;
    pitch: number;
    intonation: number;
    styleWeight: number;
    assistTextWeight: number;
    pauseMs: number;
    curveFactor: number;
    assistText: string;
    jpExtraBoostApplied: boolean;
}

interface AssistDirectionOverride {
    preset?: AssistDirectionPreset;
    strength?: number;
}

interface AssistDirectionOptimizationResult {
    enabled: boolean;
    isLongForm: boolean;
    preset: AssistDirectionPreset;
    strength: number;
    dominantEmotion: AutoEmotion;
    averageIntensity: number;
    segmentCount: number;
    charCount: number;
    reason: string;
}

interface AutoEmotionAudioSegment {
    samples: Float32Array;
    sampleRate: number;
    pauseMs: number;
}

interface AutoEmotionSegmentTrace {
    index: number;
    text: string;
    emotion: AutoEmotion;
    confidence: number;
    intensity: number;
    style: string;
    speed: number;
    pitch: number;
    intonation: number;
    styleWeight: number;
    pauseMs: number;
    curveFactor: number;
    reason: string;
}

interface ActingPreviewScript {
    id: string;
    label: string;
    text: string;
}

interface ActingProsodyDelta {
    speed: number;
    pitch: number;
    intonation: number;
    styleWeight: number;
}

interface ActingProfile {
    id: string;
    name: string;
    baselineStyle: string;
    styleMap: Record<AutoEmotion, string>;
    confidenceThreshold: number;
    applyModeDefault: AutoEmotionApplyMode;
    analyzerModeDefault: AutoEmotionAnalyzerMode;
    classifierBlend: number; // 0..1, only for hybrid
    classifierTemperature: number;
    hybridClassifierScale: number;
    classifierFeatureGain: {
        keyword: number;
        punctuation: number;
        negation: number;
        uncertainty: number;
        laughter: number;
        assertive: number;
        neutralContext: number;
    };
    classifierEmotionBias: Record<AutoEmotion, number>;
    prosodyLimits: {
        speed: [number, number];
        pitch: [number, number];
        intonation: [number, number];
        styleWeight: [number, number];
    };
    prosodyDeltaByEmotion: Record<AutoEmotion, ActingProsodyDelta>;
    pauseMsByPunct: {
        comma: number;
        period: number;
        exclamation: number;
        question: number;
        ellipsis: number;
        newline: number;
        default: number;
    };
    pauseEmotionMultiplier: Record<AutoEmotion, number>;
    intensityCurveByEmotion: Record<AutoEmotion, { start: number; end: number }>;
    emotionGain: Record<AutoEmotion, number>;
    crossfadeMs: number;
    dspEnabledByDefault: boolean;
    createdAt?: string;
    updatedAt?: string;
}

const AUTO_EMOTION_STYLE_MAP: Record<AutoEmotion, string> = {
    neutral: 'ノーマル',
    joy: 'るんるん',
    sadness: 'よふかし',
    fear: 'ささやきB',
    anger: 'ノーマル',
};

const AUTO_EMOTION_EMOJI: Record<AutoEmotion, string> = {
    neutral: '中立',
    joy: '喜',
    sadness: '哀',
    anger: '怒',
    fear: '不安',
};

const AUTO_EMOTION_KEYWORDS: Record<Exclude<AutoEmotion, 'neutral'>, string[]> = {
    joy: ['嬉しい', 'うれしい', 'やった', '最高', 'ありがとう', '助かる', '楽しい', 'やったー'],
    anger: ['ふざけるな', '許せない', '最悪', '怒', 'ありえない', 'むかつく', 'ざけんな'],
    sadness: ['つらい', '辛い', '悲しい', '失う', '泣', 'しんどい', '落ち込', '無理'],
    fear: ['怖い', '不安', 'どうしよう', 'やばい', '大丈夫かな', '心配', '迷う', 'まずい'],
};

const AUTO_EMOTION_STRENGTH_GAIN: Record<AutoEmotionStrengthPreset, number> = {
    subtle: 0.65,
    standard: 1.0,
    strong: 1.35,
};

const ASSIST_DIRECTION_PROMPTS: Record<
    Exclude<AssistDirectionPreset, 'none'>,
    { primary: string; reinforce: string; mappedEmotion: AutoEmotion }
> = {
    bright: {
        primary: '全体トーンを明るく前向きに保つ。',
        reinforce: '語尾を軽く上げ、軽快に話す。',
        mappedEmotion: 'joy',
    },
    dark: {
        primary: '全体トーンを暗めで落ち着いた方向に寄せる。',
        reinforce: '抑揚を少し抑え、静かに話す。',
        mappedEmotion: 'sadness',
    },
    joy: {
        primary: '喜びを中心に、明るく笑顔が伝わる口調で話す。',
        reinforce: '快活で弾むようなニュアンスを強める。',
        mappedEmotion: 'joy',
    },
    anger: {
        primary: '怒りを中心に、語気を強めて芯のある口調で話す。',
        reinforce: 'キレを保ち、テンポを詰めすぎず強調して話す。',
        mappedEmotion: 'anger',
    },
    sadness: {
        primary: '悲しみを中心に、沈んだ落ち着いた口調で話す。',
        reinforce: '余韻を残すように丁寧に話す。',
        mappedEmotion: 'sadness',
    },
    fear: {
        primary: '不安・恐れを中心に、慎重で迷いのある口調で話す。',
        reinforce: '語尾の迷いと間を少し増やして話す。',
        mappedEmotion: 'fear',
    },
    calm: {
        primary: '穏やかで中立寄りのトーンを最優先する。',
        reinforce: '過度な感情を抑え、聞き取りやすく安定して話す。',
        mappedEmotion: 'neutral',
    },
};

const getAssistDirectionStrengthBand = (
    strength: number,
): { label: 'subtle' | 'natural' | 'strong'; text: string; gain: number } => {
    if (strength < 0.40) {
        return { label: 'subtle', text: '感情は控えめに', gain: 0.45 };
    }
    if (strength < 0.72) {
        return { label: 'natural', text: '感情は自然に', gain: 0.75 };
    }
    return { label: 'strong', text: '感情は強めに', gain: 1.0 };
};

const mapEmotionToDirectionPreset = (emotion: AutoEmotion): AssistDirectionPreset => {
    switch (emotion) {
        case 'joy':
            return 'joy';
        case 'sadness':
            return 'sadness';
        case 'anger':
            return 'anger';
        case 'fear':
            return 'fear';
        default:
            return 'calm';
    }
};

const AUTO_EMOTION_STYLE_HINTS: Record<
    AutoEmotion,
    { positive: string[]; negative?: string[] }
> = {
    neutral: {
        positive: ['neutral', 'normal', 'ノーマル', 'default', 'plain', 'calm'],
        negative: ['angry', 'sad', 'fear', 'lol', 'hate', 'down'],
    },
    joy: {
        positive: ['happy', 'joy', 'cheer', 'るんるん', 'lol', 'laugh', 'smile', 'fine', 'surprise', 'excited'],
        negative: ['sad', 'down', 'angry', 'hate', 'fear', 'disgust'],
    },
    sadness: {
        positive: ['sad', 'down', 'cry', 'sorrow', 'よふかし', 'low', 'dark', 'blue'],
        negative: ['happy', 'lol', 'fine', 'cheer', 'surprise'],
    },
    anger: {
        positive: ['angry', 'rage', 'mad', '怒', 'hate', 'disgust', 'irritat'],
        negative: ['sad', 'fear', 'calm', 'normal', 'whisper'],
    },
    fear: {
        positive: ['fear', 'scared', 'panic', 'nervous', 'question', '不安', '怖', 'ささやき', 'whisper'],
        negative: ['happy', 'lol', 'fine', 'cheer'],
    },
};

const normalizeStyleToken = (value: string): string => {
    return (value || '')
        .toLowerCase()
        .replace(/[()\[\]{}（）【】]/g, '')
        .replace(/[\s_\-　]/g, '');
};

const findEmotionStyleByHints = (
    emotion: AutoEmotion,
    availableStyles: string[],
): string | null => {
    if (availableStyles.length === 0) return null;
    const hints = AUTO_EMOTION_STYLE_HINTS[emotion];
    let bestStyle: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const style of availableStyles) {
        const key = normalizeStyleToken(style);
        let score = 0;
        for (const pos of hints.positive) {
            const token = normalizeStyleToken(pos);
            if (!token) continue;
            if (key === token) score += 4.0;
            else if (key.includes(token)) score += 2.0;
        }
        for (const neg of hints.negative || []) {
            const token = normalizeStyleToken(neg);
            if (!token) continue;
            if (key.includes(token)) score -= 1.8;
        }
        if (score > bestScore) {
            bestScore = score;
            bestStyle = style;
        }
    }

    return bestScore > 0 ? bestStyle : null;
};

const isLikelyJpExtraEmotionModel = (modelId: string, styles: string[]): boolean => {
    const id = (modelId || '').toLowerCase();
    if (
        id.includes('jp-extra')
        || id.includes('jpextra')
        || id.includes('jvnv')
        || id.endsWith('-jp')
        || id.includes('style-bert-vits2')
    ) {
        return true;
    }
    const normalized = styles.map((s) => normalizeStyleToken(s));
    const hasClassic7 = ['angry', 'happy', 'sad', 'fear'].every(
        (token) => normalized.some((s) => s.includes(token)),
    );
    return hasClassic7;
};

const ACTING_PAUSE_MS_BY_PUNCT: Record<string, number> = {
    '、': 120,
    ',': 120,
    '。': 220,
    '！': 160,
    '!': 160,
    '？': 200,
    '?': 200,
    '…': 350,
    '\n': 280,
};

const ACTING_PAUSE_EMOTION_MULTIPLIER: Record<AutoEmotion, number> = {
    joy: 0.85,
    anger: 0.70,
    sadness: 1.25,
    fear: 1.35,
    neutral: 1.0,
};

const ACTING_INTENSITY_CURVE: Record<AutoEmotion, { start: number; end: number }> = {
    neutral: { start: 0.95, end: 1.05 },
    joy: { start: 1.0, end: 1.15 },
    sadness: { start: 1.05, end: 0.95 },
    anger: { start: 1.0, end: 1.10 },
    fear: { start: 1.05, end: 1.15 },
};

const DEFAULT_ACTING_PROFILE: ActingProfile = {
    id: 'default',
    name: 'Default Safe Broadcast',
    baselineStyle: 'ノーマル',
    styleMap: { ...AUTO_EMOTION_STYLE_MAP },
    confidenceThreshold: 0.55,
    applyModeDefault: 'fixed_style',
    analyzerModeDefault: 'hybrid',
    classifierBlend: 0.45,
    classifierTemperature: 1.0,
    hybridClassifierScale: 2.4,
    classifierFeatureGain: {
        keyword: 1.0,
        punctuation: 1.0,
        negation: 1.0,
        uncertainty: 1.0,
        laughter: 1.0,
        assertive: 1.0,
        neutralContext: 1.0,
    },
    classifierEmotionBias: {
        neutral: 0.0,
        joy: 0.0,
        sadness: 0.0,
        anger: 0.0,
        fear: 0.0,
    },
    prosodyLimits: {
        speed: [0.90, 1.12],
        pitch: [-12, 12],
        intonation: [0.85, 1.25],
        styleWeight: [0.95, 1.15],
    },
    prosodyDeltaByEmotion: {
        neutral: { speed: 0, pitch: 0, intonation: 0, styleWeight: 0 },
        joy: { speed: 0.07, pitch: 0, intonation: 0.12, styleWeight: 0.05 },
        sadness: { speed: -0.10, pitch: 0, intonation: -0.10, styleWeight: 0.00 },
        fear: { speed: -0.03, pitch: 0, intonation: 0.05, styleWeight: 0.03 },
        anger: { speed: 0.03, pitch: 0, intonation: 0.15, styleWeight: 0.04 },
    },
    pauseMsByPunct: {
        comma: 120,
        period: 220,
        exclamation: 160,
        question: 200,
        ellipsis: 350,
        newline: 280,
        default: 180,
    },
    pauseEmotionMultiplier: { ...ACTING_PAUSE_EMOTION_MULTIPLIER },
    intensityCurveByEmotion: { ...ACTING_INTENSITY_CURVE },
    emotionGain: {
        neutral: 1.0,
        joy: 1.0,
        sadness: 1.0,
        fear: 1.0,
        anger: 0.7,
    },
    crossfadeMs: 20,
    dspEnabledByDefault: true,
};

const isLikelyVirtualMicOutput = (label: string): boolean => {
    const lower = (label || '').toLowerCase();
    if (!lower) return false;
    const hints = [
        'vb-audio',
        'cable input',
        'voiceemeeter input',
        'virtual cable',
        'blackhole',
        'loopback',
        'line',
    ];
    return hints.some((h) => lower.includes(h));
};

const isLikelyVirtualMicInput = (label: string): boolean => {
    const lower = (label || '').toLowerCase();
    if (!lower) return false;
    const hints = [
        'vb-audio',
        'cable output',
        'voiceemeeter output',
        'virtual cable',
        'blackhole',
        'loopback',
    ];
    return hints.some((h) => lower.includes(h));
};

const isBundledActingProfileId = (id: string): boolean => {
    return id === 'default' || id.startsWith('preset_');
};

const ACTING_PREVIEW_LIBRARY: Record<string, ActingPreviewScript[]> = {
    default: [
        {
            id: 'default_dialog',
            label: '標準会話',
            text: '今日は配信に来てくれてありがとう。コメントを拾いながら、ゆっくり進めていこう。',
        },
        {
            id: 'default_story',
            label: '説明文',
            text: '次のシーンでは、状況が少しずつ変わる。焦らず一歩ずつ確かめれば、きっと答えに近づけるはずだ。',
        },
    ],
    preset_calm: [
        {
            id: 'calm_narration',
            label: '落ち着きナレーション',
            text: '深呼吸して、視線を少し遠くへ。静かな声で、ひとつずつ丁寧に説明していく。',
        },
        {
            id: 'calm_reply',
            label: '穏やかな返答',
            text: 'なるほど、その視点は面白いね。慌てずに整理すると、意外とシンプルに見えてくるよ。',
        },
    ],
    preset_energetic: [
        {
            id: 'energetic_opening',
            label: '元気オープニング',
            text: 'よし、行くぞ！今日はテンション全開で、最後まで一緒に盛り上がっていこう！',
        },
        {
            id: 'energetic_reaction',
            label: '元気リアクション',
            text: 'えっ、今のすごい！ナイスプレイ！この流れ、そのまま一気に決めたいね！',
        },
    ],
    preset_tense: [
        {
            id: 'tense_scene',
            label: '不穏シーン',
            text: '……静かすぎる。何かが近づいている気配がする。次の一歩を間違えたら、終わりかもしれない。',
        },
        {
            id: 'tense_question',
            label: '不安な問い',
            text: '本当にこのままで大丈夫かな？もし見落としがあったら、取り返しがつかない気がする。',
        },
    ],
};

const getActingPreviewScriptsForProfile = (profileId: string): ActingPreviewScript[] => {
    const specific = ACTING_PREVIEW_LIBRARY[profileId];
    if (specific && specific.length > 0) {
        return specific;
    }
    return ACTING_PREVIEW_LIBRARY.default;
};

const VoiceStudioScreen: React.FC = () => {
    const navigate = useNavigate();

    const [mode, setMode] = useState<StudioMode>('sbv2');
    const [isLoading, setIsLoading] = useState(false);
    const [isRunningAction, setIsRunningAction] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const [useCpuMode, setUseCpuMode] = useState(false); // default: GPU/Auto
    const [rvcVerboseLogs, setRvcVerboseLogs] = useState(false);

    // SBV2
    const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ installState: 'not_installed', runtimeState: 'stopped' });
    const [ttsModels, setTtsModels] = useState<TtsModel[]>([]);
    const [ttsPresets, setTtsPresets] = useState<TtsPreset[]>([]);
    const [selectedTtsModel, setSelectedTtsModel] = useState('');
    const [selectedStyle, setSelectedStyle] = useState('');
    const [text, setText] = useState('こんにちは、音声合成のテストです。');
    const [assistText, setAssistText] = useState('');
    const [assistTextWeight, setAssistTextWeight] = useState(1.0);
    const [assistDirectionPreset, setAssistDirectionPreset] = useState<AssistDirectionPreset>('none');
    const [assistDirectionStrength, setAssistDirectionStrength] = useState(0.50);
    const [assistDirectionAutoOptimize, setAssistDirectionAutoOptimize] = useState(false);
    const [speed, setSpeed] = useState(1.0);
    const [pitch, setPitch] = useState(0.0);
    const [intonation, setIntonation] = useState(1.0);
    const [styleWeight, setStyleWeight] = useState(1.0);
    const [sdpRatio, setSdpRatio] = useState(0.2);
    const [noiseScale, setNoiseScale] = useState(0.6);
    const [noiseScaleW, setNoiseScaleW] = useState(0.8);
    const [sbv2AutoEmotionEnabled, setSbv2AutoEmotionEnabled] = useState(false);
    const [sbv2AutoEmotionStrength, setSbv2AutoEmotionStrength] = useState<AutoEmotionStrengthPreset>('standard');
    const [sbv2AutoEmotionApplyMode, setSbv2AutoEmotionApplyMode] = useState<AutoEmotionApplyMode>('fixed_style');
    const [sbv2AutoEmotionOverride, setSbv2AutoEmotionOverride] = useState<AutoEmotionOverride>('auto');
    const [sbv2AutoEmotionThreshold, setSbv2AutoEmotionThreshold] = useState(0.55);
    const [sbv2AutoEmotionAnalyzerMode, setSbv2AutoEmotionAnalyzerMode] = useState<AutoEmotionAnalyzerMode>('hybrid');
    const [sbv2AutoEmotionClassifierBlend, setSbv2AutoEmotionClassifierBlend] = useState(0.45);
    const [sbv2JpExtraEmotionBoost, setSbv2JpExtraEmotionBoost] = useState(true);
    const [sbv2JpExtraBoostLevel, setSbv2JpExtraBoostLevel] = useState(0.70);
    const [actingProfiles, setActingProfiles] = useState<ActingProfile[]>([DEFAULT_ACTING_PROFILE]);
    const [selectedActingProfileId, setSelectedActingProfileId] = useState(DEFAULT_ACTING_PROFILE.id);
    const [sbv2ActingDspEnabled, setSbv2ActingDspEnabled] = useState(true);
    const [sbv2ActingAutoSaveOutput, setSbv2ActingAutoSaveOutput] = useState(true);
    const [sbv2ActingLastOutputDir, setSbv2ActingLastOutputDir] = useState<string | null>(null);
    const [selectedActingPreviewScriptId, setSelectedActingPreviewScriptId] = useState('');
    const [actingPreviewForceAutoEmotion, setActingPreviewForceAutoEmotion] = useState(true);
    const [actingPreviewAutoPlay, setActingPreviewAutoPlay] = useState(true);
    const [actingPreviewContinuousMode, setActingPreviewContinuousMode] = useState(false);
    const [actingPreviewContinuousRunning, setActingPreviewContinuousRunning] = useState(false);
    const [sbv2AutoEmotionDetected, setSbv2AutoEmotionDetected] = useState<{
        emotion: AutoEmotion;
        confidence: number;
        intensity: number;
        segmentIndex: number;
        segmentCount: number;
    } | null>(null);
    const [sbv2AutoEmotionDebugRows, setSbv2AutoEmotionDebugRows] = useState<string[]>([]);

    // RVC
    const [rvcStatus, setRvcStatus] = useState<RvcStatus>({ installState: 'not_installed', runtimeState: 'stopped' });
    const [rvcModels, setRvcModels] = useState<RvcModel[]>([]);
    const [rvcPresets, setRvcPresets] = useState<RvcPreset[]>([]);
    const [selectedRvcModel, setSelectedRvcModel] = useState('');
    const [rvcIndexFiles, setRvcIndexFiles] = useState<string[]>([]);
    const [selectedRvcIndexPath, setSelectedRvcIndexPath] = useState('');
    const [rvcInputPaths, setRvcInputPaths] = useState<string[]>([]);
    const [rvcBatchProgress, setRvcBatchProgress] = useState<{ current: number; total: number } | null>(null);
    const [rvcF0Method, setRvcF0Method] = useState<RvcF0Method>('rmvpe');
    const [rvcSpeakerId, setRvcSpeakerId] = useState(0);
    const [rvcSpeakerCount, setRvcSpeakerCount] = useState(1);
    const [rvcSpeakerScanRunning, setRvcSpeakerScanRunning] = useState(false);
    const [rvcSpeakerScanResults, setRvcSpeakerScanResults] = useState<SpeakerScanResult[]>([]);
    const [rvcTranspose, setRvcTranspose] = useState(0);
    const [rvcIndexRate, setRvcIndexRate] = useState(0.75);
    const [rvcProtect, setRvcProtect] = useState(0.33);
    const [rvcFilterRadius, setRvcFilterRadius] = useState(3);
    const [rvcRmsMixRate, setRvcRmsMixRate] = useState(0.25);
    const [rvcResampleSr, setRvcResampleSr] = useState(0);
    const [rvcTestEnabled, setRvcTestEnabled] = useState(false);
    const [rvcTestRunning, setRvcTestRunning] = useState(false);
    const [rvcTestInputSource, setRvcTestInputSource] = useState<RvcTestInputSource>('mic');
    const [rvcTestProcesses, setRvcTestProcesses] = useState<AudioProcessOption[]>([]);
    const [selectedRvcTestProcessPid, setSelectedRvcTestProcessPid] = useState<number | null>(null);
    const [rvcTestMuteSourceApp, setRvcTestMuteSourceApp] = useState(false);
    const [rvcTestNoiseCancel, setRvcTestNoiseCancel] = useState(false);
    const [rvcTestBgmRemoval, setRvcTestBgmRemoval] = useState(false);
    const [rvcTestBgmRemovalStrength, setRvcTestBgmRemovalStrength] = useState(0.65);
    const [rvcTestSpeechOnlyConvert, setRvcTestSpeechOnlyConvert] = useState(true);
    const [rvcTestVadAggressiveness, setRvcTestVadAggressiveness] = useState(2);
    const [rvcTestVadMinSpeechMs, setRvcTestVadMinSpeechMs] = useState(120);
    const [rvcTestVadHangoverMs, setRvcTestVadHangoverMs] = useState(220);
    const [rvcTestSpectralDenoise, setRvcTestSpectralDenoise] = useState(false);
    const [rvcTestSpectralStrength, setRvcTestSpectralStrength] = useState(0.62);
    const [rvcTestSpectralFloor, setRvcTestSpectralFloor] = useState(0.10);
    const [rvcTestCallRelayEnabled, setRvcTestCallRelayEnabled] = useState(false);
    const [selectedRvcTestCallOutputDeviceId, setSelectedRvcTestCallOutputDeviceId] = useState('');
    const [rvcTestChunkMs, setRvcTestChunkMs] = useState(1200);
    const [micDevices, setMicDevices] = useState<MediaDeviceOption[]>([]);
    const [speakerDevices, setSpeakerDevices] = useState<MediaDeviceOption[]>([]);
    const [selectedMicDeviceId, setSelectedMicDeviceId] = useState('');
    const [selectedSpeakerDeviceId, setSelectedSpeakerDeviceId] = useState('');

    // Output
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [intermediateAudioUrl, setIntermediateAudioUrl] = useState<string | null>(null);
    const [lastSbv2WavPath, setLastSbv2WavPath] = useState<string | null>(null);
    const outputAudioElementRef = useRef<HTMLAudioElement | null>(null);
    const outputAudioAutoPlayPendingRef = useRef(false);
    const actingPreviewContinuousStopRef = useRef(false);
    const missingApiLoggedRef = useRef(false);
    const rvcTestStreamRef = useRef<MediaStream | null>(null);
    const rvcTestAudioContextRef = useRef<AudioContext | null>(null);
    const rvcTestProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const rvcTestPcmBufferRef = useRef<number[]>([]);
    const rvcTestContextTailRef = useRef<number[]>([]);
    const rvcTestPendingChunksRef = useRef<RvcTestPendingChunk[]>([]);
    const rvcTestConvertingRef = useRef(false);
    const rvcTestPlaybackQueueRef = useRef<RvcTestOutputChunk[]>([]);
    const rvcTestPlaybackRunningRef = useRef(false);
    const rvcTestPlaybackContextRef = useRef<AudioContext | null>(null);
    const rvcTestPlaybackDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
    const rvcTestCallPlaybackDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
    const rvcTestPlaybackScheduleTimeRef = useRef(0);
    const rvcTestPlaybackPrimedRef = useRef(false);
    const rvcTestAudioElementRef = useRef<HTMLAudioElement | null>(null);
    const rvcTestCallAudioElementRef = useRef<HTMLAudioElement | null>(null);
    const rvcTestUsingProcessCaptureRef = useRef(false);
    const rvcTestRunningRef = useRef(false);
    const rvcTestMainSinkIdRef = useRef('');
    const rvcTestCallSinkIdRef = useRef('');
    const rvcTestRouteErrorLogMsRef = useRef(0);
    const rvcTestLastDropLogMsRef = useRef(0);
    const rvcTestLastVadLogMsRef = useRef(0);
    const rvcTestNoiseCancelRef = useRef(false);
    const rvcTestBgmRemovalRef = useRef(false);
    const rvcTestBgmRemovalStrengthRef = useRef(0.65);
    const rvcTestSpeechOnlyConvertRef = useRef(true);
    const rvcTestVadAggressivenessRef = useRef(2);
    const rvcTestVadMinSpeechMsRef = useRef(120);
    const rvcTestVadHangoverMsRef = useRef(220);
    const rvcTestSpectralDenoiseRef = useRef(false);
    const rvcTestSpectralStrengthRef = useRef(0.62);
    const rvcTestSpectralFloorRef = useRef(0.10);
    const rvcTestHpPrevXRef = useRef(0);
    const rvcTestHpPrevYRef = useRef(0);
    const rvcTestLpPrevYRef = useRef(0);
    const rvcTestNoiseFloorRef = useRef(0.004);
    const rvcTestGateGainRef = useRef(1);
    const rvcTestResampleSrcRateRef = useRef(0);
    const rvcTestResampleSrcOffsetRef = useRef(0);
    const rvcTestResampleNextPosRef = useRef(0);
    const rvcTestResamplePrevSampleRef = useRef(0);
    const rvcTestVadNoiseRmsRef = useRef(0.006);
    const rvcTestVadHangoverFramesRef = useRef(0);
    const rvcTestSpecNoiseMagRef = useRef<Float64Array | null>(null);
    const rvcTestSpecWindowRef = useRef<Float64Array | null>(null);
    const rvcTestSpecFrameSizeRef = useRef(256);
    const rvcTestMuteAnchorPidRef = useRef<number | null>(null);
    const rvcTestMuteTargetNameRef = useRef<string | null>(null);
    const rvcTestMutedStatesRef = useRef<Map<number, boolean>>(new Map());
    const rvcTestMuteRefreshTimerRef = useRef<number | null>(null);

    const activeStatus = useMemo(() => {
        if (mode === 'rvc') return rvcStatus;
        if (mode === 'sbv2+rvc') {
            if (ttsStatus.runtimeState === 'running' && rvcStatus.runtimeState === 'running') {
                return { installState: 'installed', runtimeState: 'running' };
            }
            return { installState: 'installed', runtimeState: 'stopped' };
        }
        return ttsStatus;
    }, [mode, ttsStatus, rvcStatus]);

    const rvcTestCallOutputCandidates = useMemo(
        () => speakerDevices.filter((d) => isLikelyVirtualMicOutput(d.label)),
        [speakerDevices],
    );

    const activeActingProfile = useMemo<ActingProfile>(() => {
        const found = actingProfiles.find((p) => p.id === selectedActingProfileId);
        return found || actingProfiles[0] || DEFAULT_ACTING_PROFILE;
    }, [actingProfiles, selectedActingProfileId]);

    const activeActingPreviewScripts = useMemo<ActingPreviewScript[]>(
        () => getActingPreviewScriptsForProfile(activeActingProfile.id),
        [activeActingProfile.id],
    );

    const selectedTtsModelInfo = useMemo<TtsModel | null>(
        () => ttsModels.find((m) => m.id === selectedTtsModel) || null,
        [ttsModels, selectedTtsModel],
    );
    const selectedTtsAvailableStyles = useMemo<string[]>(
        () => selectedTtsModelInfo?.styles || [],
        [selectedTtsModelInfo],
    );
    const selectedTtsLikelyJpExtra = useMemo<boolean>(
        () => isLikelyJpExtraEmotionModel(selectedTtsModel, selectedTtsAvailableStyles),
        [selectedTtsModel, selectedTtsAvailableStyles],
    );

    const normalizeActingProfile = (raw: any): ActingProfile => {
        const nowIso = new Date().toISOString();
        const id = typeof raw?.id === 'string' && raw.id.trim().length > 0
            ? raw.id.trim()
            : `profile_${Date.now()}`;
        const name = typeof raw?.name === 'string' && raw.name.trim().length > 0
            ? raw.name.trim()
            : 'Acting Profile';
        const mergedProsodyDelta = {
            neutral: {
                ...DEFAULT_ACTING_PROFILE.prosodyDeltaByEmotion.neutral,
                ...(raw?.prosodyDeltaByEmotion?.neutral || {}),
            },
            joy: {
                ...DEFAULT_ACTING_PROFILE.prosodyDeltaByEmotion.joy,
                ...(raw?.prosodyDeltaByEmotion?.joy || {}),
            },
            sadness: {
                ...DEFAULT_ACTING_PROFILE.prosodyDeltaByEmotion.sadness,
                ...(raw?.prosodyDeltaByEmotion?.sadness || {}),
            },
            anger: {
                ...DEFAULT_ACTING_PROFILE.prosodyDeltaByEmotion.anger,
                ...(raw?.prosodyDeltaByEmotion?.anger || {}),
            },
            fear: {
                ...DEFAULT_ACTING_PROFILE.prosodyDeltaByEmotion.fear,
                ...(raw?.prosodyDeltaByEmotion?.fear || {}),
            },
        };
        const mergedCurves = {
            neutral: {
                ...DEFAULT_ACTING_PROFILE.intensityCurveByEmotion.neutral,
                ...(raw?.intensityCurveByEmotion?.neutral || {}),
            },
            joy: {
                ...DEFAULT_ACTING_PROFILE.intensityCurveByEmotion.joy,
                ...(raw?.intensityCurveByEmotion?.joy || {}),
            },
            sadness: {
                ...DEFAULT_ACTING_PROFILE.intensityCurveByEmotion.sadness,
                ...(raw?.intensityCurveByEmotion?.sadness || {}),
            },
            anger: {
                ...DEFAULT_ACTING_PROFILE.intensityCurveByEmotion.anger,
                ...(raw?.intensityCurveByEmotion?.anger || {}),
            },
            fear: {
                ...DEFAULT_ACTING_PROFILE.intensityCurveByEmotion.fear,
                ...(raw?.intensityCurveByEmotion?.fear || {}),
            },
        };
        return {
            ...DEFAULT_ACTING_PROFILE,
            ...raw,
            id,
            name,
            styleMap: {
                ...DEFAULT_ACTING_PROFILE.styleMap,
                ...(raw?.styleMap || {}),
            },
            prosodyLimits: {
                ...DEFAULT_ACTING_PROFILE.prosodyLimits,
                ...(raw?.prosodyLimits || {}),
            },
            prosodyDeltaByEmotion: mergedProsodyDelta,
            pauseMsByPunct: {
                ...DEFAULT_ACTING_PROFILE.pauseMsByPunct,
                ...(raw?.pauseMsByPunct || {}),
            },
            pauseEmotionMultiplier: {
                ...DEFAULT_ACTING_PROFILE.pauseEmotionMultiplier,
                ...(raw?.pauseEmotionMultiplier || {}),
            },
            intensityCurveByEmotion: mergedCurves,
            emotionGain: {
                ...DEFAULT_ACTING_PROFILE.emotionGain,
                ...(raw?.emotionGain || {}),
            },
            analyzerModeDefault: (raw?.analyzerModeDefault || DEFAULT_ACTING_PROFILE.analyzerModeDefault) as AutoEmotionAnalyzerMode,
            classifierBlend: clamp(Number(raw?.classifierBlend ?? DEFAULT_ACTING_PROFILE.classifierBlend), 0, 1),
            classifierTemperature: clamp(Number(raw?.classifierTemperature ?? DEFAULT_ACTING_PROFILE.classifierTemperature), 0.35, 3.0),
            hybridClassifierScale: clamp(Number(raw?.hybridClassifierScale ?? DEFAULT_ACTING_PROFILE.hybridClassifierScale), 0.2, 6.0),
            classifierFeatureGain: {
                keyword: clamp(Number(raw?.classifierFeatureGain?.keyword ?? DEFAULT_ACTING_PROFILE.classifierFeatureGain.keyword), 0.2, 2.5),
                punctuation: clamp(Number(raw?.classifierFeatureGain?.punctuation ?? DEFAULT_ACTING_PROFILE.classifierFeatureGain.punctuation), 0.2, 2.5),
                negation: clamp(Number(raw?.classifierFeatureGain?.negation ?? DEFAULT_ACTING_PROFILE.classifierFeatureGain.negation), 0.2, 2.5),
                uncertainty: clamp(Number(raw?.classifierFeatureGain?.uncertainty ?? DEFAULT_ACTING_PROFILE.classifierFeatureGain.uncertainty), 0.2, 2.5),
                laughter: clamp(Number(raw?.classifierFeatureGain?.laughter ?? DEFAULT_ACTING_PROFILE.classifierFeatureGain.laughter), 0.2, 2.5),
                assertive: clamp(Number(raw?.classifierFeatureGain?.assertive ?? DEFAULT_ACTING_PROFILE.classifierFeatureGain.assertive), 0.2, 2.5),
                neutralContext: clamp(Number(raw?.classifierFeatureGain?.neutralContext ?? DEFAULT_ACTING_PROFILE.classifierFeatureGain.neutralContext), 0.2, 2.5),
            },
            classifierEmotionBias: {
                neutral: clamp(Number(raw?.classifierEmotionBias?.neutral ?? DEFAULT_ACTING_PROFILE.classifierEmotionBias.neutral), -1, 1),
                joy: clamp(Number(raw?.classifierEmotionBias?.joy ?? DEFAULT_ACTING_PROFILE.classifierEmotionBias.joy), -1, 1),
                sadness: clamp(Number(raw?.classifierEmotionBias?.sadness ?? DEFAULT_ACTING_PROFILE.classifierEmotionBias.sadness), -1, 1),
                anger: clamp(Number(raw?.classifierEmotionBias?.anger ?? DEFAULT_ACTING_PROFILE.classifierEmotionBias.anger), -1, 1),
                fear: clamp(Number(raw?.classifierEmotionBias?.fear ?? DEFAULT_ACTING_PROFILE.classifierEmotionBias.fear), -1, 1),
            },
            createdAt: raw?.createdAt || nowIso,
            updatedAt: nowIso,
        };
    };

    const updateActiveActingProfileDraft = (updater: (profile: ActingProfile) => ActingProfile) => {
        setActingProfiles((prev) => {
            if (prev.length === 0) {
                const created = updater(normalizeActingProfile(DEFAULT_ACTING_PROFILE));
                return [created];
            }
            return prev.map((p) => {
                if (p.id !== selectedActingProfileId) return p;
                return normalizeActingProfile(updater(p));
            });
        });
    };

    const addLog = (message: string) => {
        setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev].slice(0, 80));
    };

    const pcm16ToWavBase64 = (samples: number[], sampleRate: number, channels: number = 1): string => {
        const dataLength = samples.length * 2;
        const buffer = new ArrayBuffer(44 + dataLength);
        const view = new DataView(buffer);

        const writeString = (offset: number, value: string) => {
            for (let i = 0; i < value.length; i++) {
                view.setUint8(offset + i, value.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataLength, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * channels * 2, true);
        view.setUint16(32, channels * 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, dataLength, true);

        let offset = 44;
        for (const sample of samples) {
            view.setInt16(offset, sample, true);
            offset += 2;
        }

        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
    };

    const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    };

    const resetRvcTestInputDsp = () => {
        rvcTestHpPrevXRef.current = 0;
        rvcTestHpPrevYRef.current = 0;
        rvcTestLpPrevYRef.current = 0;
        rvcTestNoiseFloorRef.current = 0.004;
        rvcTestGateGainRef.current = 1;
        rvcTestVadNoiseRmsRef.current = 0.006;
        rvcTestVadHangoverFramesRef.current = 0;
        rvcTestSpecNoiseMagRef.current = null;
    };

    const fftRadix2InPlace = (real: Float64Array, imag: Float64Array, inverse: boolean) => {
        const n = real.length;
        let j = 0;
        for (let i = 1; i < n; i++) {
            let bit = n >> 1;
            while (j & bit) {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            if (i < j) {
                const tr = real[i];
                const ti = imag[i];
                real[i] = real[j];
                imag[i] = imag[j];
                real[j] = tr;
                imag[j] = ti;
            }
        }

        for (let len = 2; len <= n; len <<= 1) {
            const ang = (inverse ? 2 : -2) * Math.PI / len;
            const wLenCos = Math.cos(ang);
            const wLenSin = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let wCos = 1;
                let wSin = 0;
                const half = len >> 1;
                for (let k = 0; k < half; k++) {
                    const uRe = real[i + k];
                    const uIm = imag[i + k];
                    const vRe = real[i + k + half] * wCos - imag[i + k + half] * wSin;
                    const vIm = real[i + k + half] * wSin + imag[i + k + half] * wCos;
                    real[i + k] = uRe + vRe;
                    imag[i + k] = uIm + vIm;
                    real[i + k + half] = uRe - vRe;
                    imag[i + k + half] = uIm - vIm;
                    const nextWCos = wCos * wLenCos - wSin * wLenSin;
                    wSin = wCos * wLenSin + wSin * wLenCos;
                    wCos = nextWCos;
                }
            }
        }

        if (inverse) {
            for (let i = 0; i < n; i++) {
                real[i] /= n;
                imag[i] /= n;
            }
        }
    };

    const applyRvcTestSpectralDenoise = (samples: number[]): number[] => {
        const frameSize = rvcTestSpecFrameSizeRef.current;
        const hop = frameSize >> 1;
        if (samples.length < frameSize) {
            return samples;
        }

        if (!rvcTestSpecWindowRef.current || rvcTestSpecWindowRef.current.length !== frameSize) {
            const win = new Float64Array(frameSize);
            for (let i = 0; i < frameSize; i++) {
                win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
            }
            rvcTestSpecWindowRef.current = win;
        }
        const window = rvcTestSpecWindowRef.current!;
        const strength = Math.max(0, Math.min(1.6, rvcTestSpectralStrengthRef.current));
        const floor = Math.max(0.02, Math.min(0.6, rvcTestSpectralFloorRef.current));
        const bins = frameSize >> 1;

        if (!rvcTestSpecNoiseMagRef.current || rvcTestSpecNoiseMagRef.current.length !== bins + 1) {
            rvcTestSpecNoiseMagRef.current = new Float64Array(bins + 1);
        }
        const noiseMag = rvcTestSpecNoiseMagRef.current;

        const input = new Float64Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
            input[i] = Math.max(-1, Math.min(1, samples[i] / 32768));
        }

        const outAcc = new Float64Array(samples.length + frameSize);
        const weightAcc = new Float64Array(samples.length + frameSize);
        const real = new Float64Array(frameSize);
        const imag = new Float64Array(frameSize);

        for (let pos = 0; pos + frameSize <= input.length; pos += hop) {
            let frameEnergy = 0;
            for (let i = 0; i < frameSize; i++) {
                const v = input[pos + i] * window[i];
                real[i] = v;
                imag[i] = 0;
                frameEnergy += v * v;
            }
            const frameRms = Math.sqrt(frameEnergy / frameSize);

            fftRadix2InPlace(real, imag, false);
            for (let k = 0; k <= bins; k++) {
                const re = real[k];
                const im = imag[k];
                const mag = Math.sqrt(re * re + im * im) + 1e-9;
                if (noiseMag[k] <= 0) {
                    noiseMag[k] = mag;
                } else {
                    const alpha = frameRms < 0.018 ? 0.90 : 0.995;
                    noiseMag[k] = alpha * noiseMag[k] + (1 - alpha) * Math.min(mag, noiseMag[k] * 1.5);
                }

                const sub = mag - strength * noiseMag[k];
                const cleanMag = Math.max(sub, floor * noiseMag[k]);
                const gain = cleanMag / mag;
                real[k] *= gain;
                imag[k] *= gain;
                if (k > 0 && k < bins) {
                    const mk = frameSize - k;
                    real[mk] *= gain;
                    imag[mk] *= gain;
                }
            }

            fftRadix2InPlace(real, imag, true);
            for (let i = 0; i < frameSize; i++) {
                const w = window[i];
                const idx = pos + i;
                outAcc[idx] += real[i] * w;
                weightAcc[idx] += w * w;
            }
        }

        const out = new Array<number>(samples.length);
        for (let i = 0; i < samples.length; i++) {
            const wet = weightAcc[i] > 1e-9 ? outAcc[i] / weightAcc[i] : input[i];
            const mix = 0.86; // keep some dry to reduce musical noise
            const v = wet * mix + input[i] * (1 - mix);
            out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        }
        return out;
    };

    const resetRvcTestResampler = () => {
        rvcTestResampleSrcRateRef.current = 0;
        rvcTestResampleSrcOffsetRef.current = 0;
        rvcTestResampleNextPosRef.current = 0;
        rvcTestResamplePrevSampleRef.current = 0;
    };

    const resampleRvcTestMonoTo16k = (mono: number[], sourceRate: number): number[] => {
        const safeRate = Math.max(1, Math.floor(sourceRate || 16000));
        if (mono.length === 0) return [];

        if (safeRate === 16000) {
            // Keep direct path simple for native 16k streams.
            return mono;
        }

        if (rvcTestResampleSrcRateRef.current !== safeRate) {
            resetRvcTestResampler();
            rvcTestResampleSrcRateRef.current = safeRate;
        }
        if (rvcTestResampleSrcRateRef.current === 0) {
            rvcTestResampleSrcRateRef.current = safeRate;
        }

        const startPos = rvcTestResampleSrcOffsetRef.current;
        const endPos = startPos + mono.length - 1;
        const prevSample = rvcTestResamplePrevSampleRef.current;
        const step = safeRate / 16000;
        let nextPos = rvcTestResampleNextPosRef.current;
        if (nextPos < startPos) {
            nextPos = startPos;
        }

        const out: number[] = [];
        // Generate output at fixed 16k timeline while keeping source phase continuous across chunks.
        while (nextPos <= endPos + 1e-9) {
            const extPos = nextPos - (startPos - 1);
            const i0 = Math.floor(extPos);
            const frac = extPos - i0;

            let s0: number;
            let s1: number;
            if (i0 <= 0) {
                s0 = prevSample;
                s1 = mono[0];
            } else if (i0 >= mono.length) {
                s0 = mono[mono.length - 1];
                s1 = s0;
            } else {
                s0 = mono[i0 - 1];
                s1 = mono[i0];
            }

            const v = Math.round(s0 + (s1 - s0) * frac);
            out.push(Math.max(-32768, Math.min(32767, v)));
            nextPos += step;
        }

        rvcTestResamplePrevSampleRef.current = mono[mono.length - 1];
        rvcTestResampleSrcOffsetRef.current = startPos + mono.length;
        rvcTestResampleNextPosRef.current = nextPos;
        return out;
    };

    const preprocessRvcTestInput = (samples: number[], sampleRate: number): number[] => {
        const useNoiseCancel = rvcTestNoiseCancelRef.current;
        const useBgmRemoval = rvcTestBgmRemovalRef.current;
        const useSpectralDenoise = rvcTestSpectralDenoiseRef.current;
        if (!useNoiseCancel && !useBgmRemoval && !useSpectralDenoise) {
            return samples;
        }

        const dt = 1 / Math.max(1, sampleRate);
        const hpFc = useBgmRemoval ? 120 : 65;
        const hpRc = 1 / (2 * Math.PI * hpFc);
        const hpA = hpRc / (hpRc + dt);

        const lpFc = useBgmRemoval ? 3600 : 7600;
        const lpRc = 1 / (2 * Math.PI * lpFc);
        const lpAlpha = dt / (lpRc + dt);

        const bgmStrength = Math.max(0, Math.min(1, rvcTestBgmRemovalStrengthRef.current));

        let hpPrevX = rvcTestHpPrevXRef.current;
        let hpPrevY = rvcTestHpPrevYRef.current;
        let lpPrevY = rvcTestLpPrevYRef.current;
        let noiseFloor = rvcTestNoiseFloorRef.current;
        let gateGain = rvcTestGateGainRef.current;

        let out = new Array<number>(samples.length);
        for (let i = 0; i < samples.length; i++) {
            const x = Math.max(-1, Math.min(1, samples[i] / 32768));
            let y = x;

            // Voice-band emphasis to attenuate typical BGM bands.
            const hp = hpA * (hpPrevY + x - hpPrevX);
            hpPrevX = x;
            hpPrevY = hp;
            const lp = lpPrevY + lpAlpha * (hp - lpPrevY);
            lpPrevY = lp;
            if (useBgmRemoval) {
                y = x * (1 - bgmStrength) + lp * bgmStrength;
            } else {
                y = lp;
            }

            if (useNoiseCancel) {
                const absVal = Math.abs(y);
                // Track noise floor slowly so speech peaks don't dominate.
                if (absVal < noiseFloor) {
                    noiseFloor = noiseFloor * 0.995 + absVal * 0.005;
                } else {
                    noiseFloor = noiseFloor * 0.9992 + absVal * 0.0008;
                }
                const threshold = Math.max(0.0035, noiseFloor * 3.0);
                const ratio = absVal / (threshold + 1e-6);
                const targetGain = ratio >= 1 ? 1 : Math.max(0.08, ratio);
                const smooth = targetGain < gateGain ? 0.22 : 0.03;
                gateGain += (targetGain - gateGain) * smooth;
                y *= gateGain;
            }

            out[i] = Math.max(-32768, Math.min(32767, Math.round(y * 32767)));
        }

        if (useSpectralDenoise) {
            out = applyRvcTestSpectralDenoise(out);
        }

        rvcTestHpPrevXRef.current = hpPrevX;
        rvcTestHpPrevYRef.current = hpPrevY;
        rvcTestLpPrevYRef.current = lpPrevY;
        rvcTestNoiseFloorRef.current = noiseFloor;
        rvcTestGateGainRef.current = gateGain;

        return out;
    };

    const analyzeRvcTestSpeech = (samples16k: number[]): { isSpeech: boolean; speechRatio: number } => {
        if (samples16k.length < 160) {
            return { isSpeech: false, speechRatio: 0 };
        }

        const frameSize = 320; // 20ms @ 16k
        const totalFrames = Math.floor(samples16k.length / frameSize);
        if (totalFrames <= 0) {
            return { isSpeech: false, speechRatio: 0 };
        }

        const aggressiveness = Math.max(0, Math.min(3, Math.round(rvcTestVadAggressivenessRef.current)));
        const minSpeechFrames = Math.max(1, Math.floor(rvcTestVadMinSpeechMsRef.current / 20));
        const hangoverFrames = Math.max(0, Math.floor(rvcTestVadHangoverMsRef.current / 20));
        const energyFactorByAgg = [2.2, 2.8, 3.4, 4.2];
        const clickRatioByAgg = [2.2, 1.9, 1.7, 1.5];
        const minRms = 0.0045;

        let noiseRms = rvcTestVadNoiseRmsRef.current;
        let speechFrames = 0;

        for (let f = 0; f < totalFrames; f++) {
            const start = f * frameSize;
            const end = start + frameSize;
            let sumSq = 0;
            let diffSq = 0;
            let peak = 0;
            let zc = 0;
            let prev = 0;

            for (let i = start; i < end; i++) {
                const x = Math.max(-1, Math.min(1, samples16k[i] / 32768));
                sumSq += x * x;
                if (i > start) {
                    const d = x - prev;
                    diffSq += d * d;
                    if ((x >= 0) !== (prev >= 0)) {
                        zc += 1;
                    }
                }
                prev = x;
                const ax = Math.abs(x);
                if (ax > peak) peak = ax;
            }

            const rms = Math.sqrt(sumSq / frameSize);
            if (rms < noiseRms * 1.25) {
                noiseRms = noiseRms * 0.96 + rms * 0.04;
            } else {
                noiseRms = noiseRms * 0.998 + rms * 0.002;
            }

            const zcr = zc / frameSize;
            const crest = peak / (rms + 1e-6);
            const diffRatio = diffSq / (sumSq + 1e-9);
            const energyThreshold = Math.max(minRms, noiseRms * energyFactorByAgg[aggressiveness]);
            const clickLike = crest > 8.5 && diffRatio > clickRatioByAgg[aggressiveness];
            const likelyVoice = rms > energyThreshold && zcr > 0.012 && zcr < 0.28 && !clickLike;

            if (likelyVoice) {
                speechFrames += 1;
            }
        }

        rvcTestVadNoiseRmsRef.current = Math.max(0.001, Math.min(0.08, noiseRms));
        let isSpeech = speechFrames >= minSpeechFrames;
        if (isSpeech) {
            rvcTestVadHangoverFramesRef.current = hangoverFrames;
        } else if (rvcTestVadHangoverFramesRef.current > 0) {
            isSpeech = true;
            rvcTestVadHangoverFramesRef.current -= 1;
        }

        return {
            isSpeech,
            speechRatio: speechFrames / totalFrames,
        };
    };

    const getElectronApi = () => {
        const api = (window as any).electronAPI;
        if (!api && !missingApiLoggedRef.current) {
            addLog('Electron API is not available. Please launch this screen from the Electron app.');
            missingApiLoggedRef.current = true;
        }
        return api as (typeof window.electronAPI | undefined);
    };

    const refreshStatus = async () => {
        const api = getElectronApi();
        if (!api) return;
        try {
            const [tts, rvc] = await Promise.all([
                api.ttsGetStatus(),
                api.rvcGetStatus(),
            ]);
            setTtsStatus(tts);
            setRvcStatus(rvc);
        } catch (error) {
            addLog(`Status refresh failed: ${String(error)}`);
        }
    };

    const loadTtsModels = async () => {
        try {
            const models = await window.electronAPI.ttsListModels();
            setTtsModels(models);
            if (models.length > 0 && !selectedTtsModel) {
                setSelectedTtsModel(models[0].id);
                setSelectedStyle(models[0].defaultStyle || models[0].styles[0] || 'Neutral');
                await window.electronAPI.ttsSetModel(models[0].id);
            }
        } catch (error) {
            addLog(`SBV2 model load failed: ${String(error)}`);
        }
    };

    const loadRvcModels = async () => {
        try {
            const models = await window.electronAPI.rvcListModels();
            setRvcModels(models);
            if (models.length > 0 && !selectedRvcModel) {
                setSelectedRvcModel(models[0].id);
                const setRes = await window.electronAPI.rvcSetModel(models[0].id);
                const spkCount = Number(setRes?.speaker_count || 1);
                setRvcSpeakerCount(spkCount > 0 ? spkCount : 1);
                setRvcSpeakerId(0);
                addLog(`RVC model ${models[0].name}: speaker count = ${spkCount > 0 ? spkCount : 1}`);
                const indexFiles = await window.electronAPI.rvcListModelIndexes(models[0].id);
                setRvcIndexFiles(indexFiles || []);
                const firstIndex = indexFiles && indexFiles.length > 0 ? indexFiles[0] : '';
                setSelectedRvcIndexPath(firstIndex);
                if (firstIndex) {
                    addLog(`Using index file: ${firstIndex}`);
                    if (rvcIndexRate <= 0) {
                        setRvcIndexRate(0.75);
                    }
                } else {
                    setRvcIndexRate(0);
                    setRvcProtect(0.33);
                    setRvcRmsMixRate(0.25);
                    addLog(`Model ${models[0].name} has no index file. Applied no-index safe defaults.`);
                }
            }
        } catch (error) {
            addLog(`RVC model load failed: ${String(error)}`);
        }
    };

    const loadPresets = async () => {
        try {
            const [tts, rvc] = await Promise.all([
                window.electronAPI.ttsGetPresets(),
                window.electronAPI.rvcGetPresets(),
            ]);
            setTtsPresets(tts);
            setRvcPresets(rvc);
        } catch {
            // non-fatal
        }
    };

    const applyActingProfileToUi = (profile: ActingProfile) => {
        setSbv2AutoEmotionThreshold(clamp(profile.confidenceThreshold, 0.3, 0.95));
        setSbv2AutoEmotionApplyMode(profile.applyModeDefault);
        setSbv2AutoEmotionAnalyzerMode(profile.analyzerModeDefault || 'hybrid');
        setSbv2AutoEmotionClassifierBlend(clamp(profile.classifierBlend ?? 0.45, 0, 1));
        setSbv2ActingDspEnabled(!!profile.dspEnabledByDefault);
        if (profile.baselineStyle && profile.baselineStyle !== selectedStyle) {
            setSelectedStyle(profile.baselineStyle);
        }
    };

    const loadActingProfiles = async (preferProfileId?: string) => {
        try {
            const res = await window.electronAPI.invoke('tts-acting-list-profiles');
            const rawProfiles: any[] = Array.isArray(res?.profiles) ? res.profiles : [];
            const normalized = rawProfiles.map((p) => normalizeActingProfile(p));
            const profiles = normalized.length > 0
                ? normalized
                : [normalizeActingProfile(DEFAULT_ACTING_PROFILE)];
            setActingProfiles(profiles);

            const targetId = preferProfileId
                || (profiles.some((p) => p.id === selectedActingProfileId) ? selectedActingProfileId : profiles[0].id);
            setSelectedActingProfileId(targetId);
            const target = profiles.find((p) => p.id === targetId) || profiles[0];
            applyActingProfileToUi(target);
        } catch (error) {
            const fallback = normalizeActingProfile(DEFAULT_ACTING_PROFILE);
            setActingProfiles([fallback]);
            setSelectedActingProfileId(fallback.id);
            applyActingProfileToUi(fallback);
            addLog(`Failed to load acting profiles: ${String(error)}`);
        }
    };

    const saveActingProfile = async (profile: ActingProfile) => {
        const normalized = normalizeActingProfile(profile);
        const res = await window.electronAPI.invoke('tts-acting-save-profile', normalized);
        if (!res?.success) {
            throw new Error(res?.error || 'Failed to save profile');
        }
        await loadActingProfiles(normalized.id);
        addLog(`Acting profile saved: ${normalized.name}`);
    };

    const buildCurrentActingProfile = (base?: ActingProfile): ActingProfile => {
        const src = normalizeActingProfile(base || activeActingProfile);
        return {
            ...src,
            baselineStyle: selectedStyle || src.baselineStyle,
            confidenceThreshold: sbv2AutoEmotionThreshold,
            applyModeDefault: sbv2AutoEmotionApplyMode,
            analyzerModeDefault: sbv2AutoEmotionAnalyzerMode,
            classifierBlend: sbv2AutoEmotionClassifierBlend,
            dspEnabledByDefault: sbv2ActingDspEnabled,
            updatedAt: new Date().toISOString(),
        };
    };

    const handleSaveActingProfileAsNew = async () => {
        const entered = window.prompt('新しいプロファイル名を入力', `${activeActingProfile.name} Copy`);
        const name = (entered || '').trim();
        if (!name) return;
        const profile: ActingProfile = {
            ...buildCurrentActingProfile(activeActingProfile),
            id: `profile_${Date.now()}`,
            name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        try {
            await saveActingProfile(profile);
            setSelectedActingProfileId(profile.id);
        } catch (error) {
            addLog(`Acting profile save failed: ${String(error)}`);
        }
    };

    const handleUpdateCurrentActingProfile = async () => {
        const profile = buildCurrentActingProfile(activeActingProfile);
        try {
            await saveActingProfile(profile);
        } catch (error) {
            addLog(`Acting profile update failed: ${String(error)}`);
        }
    };

    const handleDeleteCurrentActingProfile = async () => {
        if (isBundledActingProfileId(activeActingProfile.id)) {
            addLog('Bundled profile cannot be deleted.');
            return;
        }
        const ok = window.confirm(`Delete profile "${activeActingProfile.name}"?`);
        if (!ok) return;
        try {
            const res = await window.electronAPI.invoke('tts-acting-delete-profile', activeActingProfile.id);
            if (!res?.success) {
                addLog(`Failed to delete acting profile: ${res?.error || 'Unknown error'}`);
                return;
            }
            await loadActingProfiles(DEFAULT_ACTING_PROFILE.id);
            addLog(`Acting profile deleted: ${activeActingProfile.name}`);
        } catch (error) {
            addLog(`Acting profile delete failed: ${String(error)}`);
        }
    };

    const handleRestoreBundledActingProfiles = async () => {
        try {
            const res = await window.electronAPI.invoke('tts-acting-reset-bundled-profiles');
            if (!res?.success) {
                addLog(`Failed to restore bundled profiles: ${res?.error || 'Unknown error'}`);
                return;
            }
            await loadActingProfiles(activeActingProfile.id);
            addLog('Bundled acting profiles restored.');
        } catch (error) {
            addLog(`Restore bundled profiles failed: ${String(error)}`);
        }
    };

    const handleLoadActingPreviewScript = () => {
        const script = activeActingPreviewScripts.find((s) => s.id === selectedActingPreviewScriptId)
            || activeActingPreviewScripts[0];
        if (!script) {
            addLog('No acting preview script available.');
            return;
        }
        setText(script.text);
        addLog(`Loaded acting preview script: ${script.label} (${activeActingProfile.name})`);
    };

    const handleLoadAndSynthesizeActingPreviewScript = async () => {
        const script = activeActingPreviewScripts.find((s) => s.id === selectedActingPreviewScriptId)
            || activeActingPreviewScripts[0];
        if (!script) {
            addLog('No acting preview script available.');
            return;
        }
        if (isRunningAction) {
            addLog('Already processing. Please wait.');
            return;
        }
        setText(script.text);
        const forceAutoEmotion = mode === 'sbv2'
            && actingPreviewForceAutoEmotion
            && !sbv2AutoEmotionEnabled;
        addLog(
            `Loaded preview and started synth: ${script.label} (${activeActingProfile.name})`
            + `${forceAutoEmotion ? ' [Auto Emotion: forced once]' : ''}`,
        );
        const ok = await handleSynthesize(script.text, {
            forceAutoEmotion,
            autoPlayAfterSynthesize: actingPreviewAutoPlay,
        });
        if (!ok) {
            addLog(`Preview synth failed: ${script.label}`);
        }
    };

    const handleRunActingPreviewSequence = async () => {
        if (actingPreviewContinuousRunning) {
            return;
        }
        if (isRunningAction) {
            addLog('Already processing. Please wait.');
            return;
        }
        const scripts = activeActingPreviewScripts;
        if (scripts.length === 0) {
            addLog('No acting preview scripts available for sequence.');
            return;
        }

        const selectedIndex = scripts.findIndex((s) => s.id === selectedActingPreviewScriptId);
        const startIndex = selectedIndex >= 0 ? selectedIndex : 0;
        const sequence = scripts.slice(startIndex);
        if (sequence.length === 0) {
            addLog('No acting preview scripts to run.');
            return;
        }

        actingPreviewContinuousStopRef.current = false;
        setActingPreviewContinuousRunning(true);
        addLog(`Preview sequence started: ${sequence.length} script(s).`);
        try {
            for (let i = 0; i < sequence.length; i++) {
                if (actingPreviewContinuousStopRef.current) {
                    addLog('Preview sequence stopped.');
                    break;
                }
                const script = sequence[i];
                setSelectedActingPreviewScriptId(script.id);
                setText(script.text);

                const forceAutoEmotion = mode === 'sbv2'
                    && actingPreviewForceAutoEmotion
                    && !sbv2AutoEmotionEnabled;

                addLog(`Preview sequence ${i + 1}/${sequence.length}: ${script.label}`);
                const ok = await handleSynthesize(script.text, {
                    forceAutoEmotion,
                    autoPlayAfterSynthesize: actingPreviewAutoPlay,
                    waitForPlaybackEnd: actingPreviewAutoPlay,
                });
                if (!ok) {
                    addLog(`Preview sequence aborted at: ${script.label}`);
                    break;
                }
            }
        } finally {
            actingPreviewContinuousStopRef.current = false;
            setActingPreviewContinuousRunning(false);
        }
    };

    const handleStopActingPreviewSequence = () => {
        if (!actingPreviewContinuousRunning) return;
        actingPreviewContinuousStopRef.current = true;
        addLog('Stopping preview sequence...');
    };

    const handleRunActingPreview = async () => {
        if (actingPreviewContinuousMode) {
            await handleRunActingPreviewSequence();
            return;
        }
        await handleLoadAndSynthesizeActingPreviewScript();
    };

    const refreshRealtimeDevices = async () => {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const mics = devices
                .filter((d) => d.kind === 'audioinput')
                .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone (${d.deviceId.slice(0, 6)})` }));
            const speakers = devices
                .filter((d) => d.kind === 'audiooutput')
                .map((d) => ({ deviceId: d.deviceId, label: d.label || `Speaker (${d.deviceId.slice(0, 6)})` }));

            setMicDevices(mics);
            setSpeakerDevices(speakers);

            if (!selectedMicDeviceId && mics.length > 0) {
                setSelectedMicDeviceId(mics[0].deviceId);
            }
            if (!selectedSpeakerDeviceId && speakers.length > 0) {
                setSelectedSpeakerDeviceId(speakers[0].deviceId);
            }
            if (!selectedRvcTestCallOutputDeviceId) {
                const virtual = speakers.find((d) => isLikelyVirtualMicOutput(d.label));
                if (virtual) {
                    setSelectedRvcTestCallOutputDeviceId(virtual.deviceId);
                }
            }
        } catch (error) {
            addLog(`Failed to enumerate audio devices: ${String(error)}`);
        }
    };

    const refreshRvcTestProcesses = async () => {
        try {
            const res = await window.electronAPI.getAudioProcesses();
            if (!res.success || !res.processes) {
                addLog(`Failed to get audio apps: ${res.error || 'Unknown error'}`);
                setRvcTestProcesses([]);
                return;
            }
            const processes = [...res.processes]
                .filter((p) => Number.isFinite(p.pid) && p.pid > 0)
                .sort((a, b) => a.name.localeCompare(b.name));

            setRvcTestProcesses(processes);
            if (!selectedRvcTestProcessPid && processes.length > 0) {
                setSelectedRvcTestProcessPid(processes[0].pid);
            }
        } catch (error) {
            addLog(`Failed to refresh app list: ${String(error)}`);
            setRvcTestProcesses([]);
        }
    };

    const getRvcTestChunkPlan = () => {
        const chunkSamples = Math.max(1600, Math.floor(16000 * (rvcTestChunkMs / 1000)));
        const contextSamples = Math.min(4800, Math.max(1600, Math.floor(chunkSamples * 0.25)));
        const maxPendingChunks = rvcTestChunkMs >= 1200 ? 64 : 48;
        return { chunkSamples, contextSamples, maxPendingChunks };
    };

    const trimDecodedRvcChunk = (
        context: AudioContext,
        decoded: AudioBuffer,
        skipSamples16k: number,
        takeSamples16k: number,
    ): AudioBuffer => {
        const sr = Math.max(1, decoded.sampleRate || 16000);
        const start = Math.max(0, Math.round(skipSamples16k * sr / 16000));
        const desired = Math.max(1, Math.round(takeSamples16k * sr / 16000));
        if (start >= decoded.length - 8) {
            return decoded;
        }

        if (start <= 0 && desired >= decoded.length) {
            return decoded;
        }

        const safeStart = Math.min(Math.max(0, start), Math.max(0, decoded.length - 1));
        const safeLength = Math.max(1, Math.min(desired, decoded.length - safeStart));
        if (safeStart <= 0 && safeLength >= decoded.length) {
            return decoded;
        }

        const trimmed = context.createBuffer(decoded.numberOfChannels, safeLength, sr);
        for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
            const src = decoded.getChannelData(ch);
            trimmed.copyToChannel(src.subarray(safeStart, safeStart + safeLength), ch, 0);
        }
        return trimmed;
    };

    const appendRvcTestPcm = (pcm: number[], sampleRate: number, channels: number) => {
        if (pcm.length === 0) return;

        const safeChannels = Math.max(1, Math.floor(channels || 1));
        const frameCount = Math.floor(pcm.length / safeChannels);
        if (frameCount <= 0) return;

        const mono = new Array<number>(frameCount);
        if (safeChannels === 1) {
            for (let i = 0; i < frameCount; i++) {
                const v = pcm[i] || 0;
                mono[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
            }
        } else {
            for (let frame = 0; frame < frameCount; frame++) {
                const base = frame * safeChannels;
                let sum = 0;
                for (let ch = 0; ch < safeChannels; ch++) {
                    sum += pcm[base + ch] || 0;
                }
                mono[frame] = Math.max(-32768, Math.min(32767, Math.round(sum / safeChannels)));
            }
        }

        const mono16k = resampleRvcTestMonoTo16k(mono, sampleRate);

        const processed16k = preprocessRvcTestInput(mono16k, 16000);
        rvcTestPcmBufferRef.current.push(...processed16k);

        const { chunkSamples, contextSamples, maxPendingChunks } = getRvcTestChunkPlan();
        while (rvcTestPcmBufferRef.current.length >= chunkSamples) {
            const hop = rvcTestPcmBufferRef.current.slice(0, chunkSamples);
            rvcTestPcmBufferRef.current = rvcTestPcmBufferRef.current.slice(chunkSamples);
            const speech = analyzeRvcTestSpeech(hop);
            const shouldConvert = !rvcTestSpeechOnlyConvertRef.current || speech.isSpeech;

            const leftContext = rvcTestContextTailRef.current;
            const merged = leftContext.length > 0 ? leftContext.concat(hop) : hop;
            const pending: RvcTestPendingChunk = {
                pcm: merged,
                skipSamples: leftContext.length,
                takeSamples: hop.length,
                isSpeech: shouldConvert,
                speechRatio: speech.speechRatio,
            };

            const keepFrom = Math.max(0, merged.length - contextSamples);
            rvcTestContextTailRef.current = merged.slice(keepFrom);

            if (rvcTestPendingChunksRef.current.length > maxPendingChunks) {
                rvcTestPendingChunksRef.current.shift();
                const nowMs = Date.now();
                if (nowMs - rvcTestLastDropLogMsRef.current > 5000) {
                    addLog('RVC test input backlog detected. Increase Test Chunk or reduce conversion load.');
                    rvcTestLastDropLogMsRef.current = nowMs;
                }
            }
            rvcTestPendingChunksRef.current.push(pending);
        }
        void flushRvcTestChunks();
    };

    const clearRvcTestMuteRefreshTimer = () => {
        if (rvcTestMuteRefreshTimerRef.current !== null) {
            window.clearInterval(rvcTestMuteRefreshTimerRef.current);
            rvcTestMuteRefreshTimerRef.current = null;
        }
    };

    const applyRvcTestSourceMute = async (anchorPid: number, targetName?: string, silent: boolean = false): Promise<number> => {
        const nameLower = (targetName || '').trim().toLowerCase();
        const candidatePids = new Set<number>([anchorPid]);

        try {
            const listRes = await window.electronAPI.getAudioProcesses();
            if (listRes?.success && listRes.processes) {
                for (const proc of listRes.processes) {
                    if (proc.pid === anchorPid) {
                        candidatePids.add(proc.pid);
                        continue;
                    }
                    if (nameLower && proc.name.toLowerCase() === nameLower) {
                        candidatePids.add(proc.pid);
                    }
                }
            }
        } catch {
            // keep anchor PID fallback
        }

        let mutedCount = 0;
        for (const pid of candidatePids) {
            try {
                if (!rvcTestMutedStatesRef.current.has(pid)) {
                    const stateRes = await window.electronAPI.getProcessMute(pid);
                    if (stateRes?.success && stateRes.found) {
                        rvcTestMutedStatesRef.current.set(pid, !!stateRes.muted);
                    }
                }

                const muteRes = await window.electronAPI.setProcessMute(pid, true);
                if (muteRes?.success) {
                    mutedCount += 1;
                }
            } catch {
                // ignore per-pid errors
            }
        }

        if (mutedCount <= 0 && !silent) {
            addLog('Failed to mute source app sessions. Try Refresh and select the active audio process.');
        }
        return mutedCount;
    };

    const restoreRvcTestSourceMute = async (silent: boolean = false) => {
        clearRvcTestMuteRefreshTimer();
        const entries = Array.from(rvcTestMutedStatesRef.current.entries());
        rvcTestMutedStatesRef.current.clear();

        for (const [pid, prevMuted] of entries) {
            try {
                const restoreRes = await window.electronAPI.setProcessMute(pid, prevMuted);
                if (!restoreRes?.success && !silent) {
                    addLog(`Failed to restore source app mute state (pid=${pid}): ${restoreRes?.error || 'Unknown error'}`);
                }
            } catch (error) {
                if (!silent) {
                    addLog(`Failed to restore source app mute state (pid=${pid}): ${String(error)}`);
                }
            }
        }

        rvcTestMuteAnchorPidRef.current = null;
        rvcTestMuteTargetNameRef.current = null;
    };

    const stopRvcTestMode = async (silent: boolean = false) => {
        setRvcTestRunning(false);
        rvcTestRunningRef.current = false;
        rvcTestLastDropLogMsRef.current = 0;
        rvcTestPlaybackPrimedRef.current = false;
        resetRvcTestInputDsp();
        resetRvcTestResampler();
        rvcTestPcmBufferRef.current = [];
        rvcTestContextTailRef.current = [];
        rvcTestPendingChunksRef.current = [];
        rvcTestConvertingRef.current = false;
        rvcTestPlaybackQueueRef.current = [];
        rvcTestPlaybackRunningRef.current = false;

        if (rvcTestProcessorRef.current) {
            rvcTestProcessorRef.current.disconnect();
            rvcTestProcessorRef.current.onaudioprocess = null;
            rvcTestProcessorRef.current = null;
        }

        if (rvcTestStreamRef.current) {
            for (const track of rvcTestStreamRef.current.getTracks()) {
                track.stop();
            }
            rvcTestStreamRef.current = null;
        }

        if (rvcTestAudioContextRef.current) {
            await rvcTestAudioContextRef.current.close();
            rvcTestAudioContextRef.current = null;
        }

        if (rvcTestAudioElementRef.current) {
            try {
                rvcTestAudioElementRef.current.pause();
                rvcTestAudioElementRef.current.src = '';
                (rvcTestAudioElementRef.current as any).srcObject = null;
            } catch {
                // ignore
            }
            rvcTestAudioElementRef.current = null;
        }
        if (rvcTestCallAudioElementRef.current) {
            try {
                rvcTestCallAudioElementRef.current.pause();
                rvcTestCallAudioElementRef.current.src = '';
                (rvcTestCallAudioElementRef.current as any).srcObject = null;
            } catch {
                // ignore
            }
            rvcTestCallAudioElementRef.current = null;
        }
        rvcTestMainSinkIdRef.current = '';
        rvcTestCallSinkIdRef.current = '';
        rvcTestRouteErrorLogMsRef.current = 0;
        rvcTestLastVadLogMsRef.current = 0;

        if (rvcTestPlaybackContextRef.current) {
            try {
                await rvcTestPlaybackContextRef.current.close();
            } catch {
                // ignore
            }
            rvcTestPlaybackContextRef.current = null;
            rvcTestPlaybackDestinationRef.current = null;
            rvcTestCallPlaybackDestinationRef.current = null;
            rvcTestPlaybackScheduleTimeRef.current = 0;
        }

        try {
            window.electronAPI.offProcessAudioStream();
        } catch {
            // ignore
        }

        if (rvcTestUsingProcessCaptureRef.current) {
            try {
                await window.electronAPI.stopProcessCaptureStream();
            } catch {
                // ignore
            }
            rvcTestUsingProcessCaptureRef.current = false;
        }

        await restoreRvcTestSourceMute(silent);

        if (!silent) {
            addLog('RVC test mode stopped.');
        }
    };

    const ensureRvcTestPlaybackGraph = async (): Promise<{
        context: AudioContext;
        destination: MediaStreamAudioDestinationNode;
        callDestination: MediaStreamAudioDestinationNode;
        audio: HTMLAudioElement;
    }> => {
        if (!rvcTestPlaybackContextRef.current || !rvcTestPlaybackDestinationRef.current || !rvcTestCallPlaybackDestinationRef.current) {
            const context = new AudioContext();
            const destination = context.createMediaStreamDestination();
            const callDestination = context.createMediaStreamDestination();
            rvcTestPlaybackContextRef.current = context;
            rvcTestPlaybackDestinationRef.current = destination;
            rvcTestCallPlaybackDestinationRef.current = callDestination;
            rvcTestPlaybackScheduleTimeRef.current = 0;
        }

        const context = rvcTestPlaybackContextRef.current!;
        const destination = rvcTestPlaybackDestinationRef.current!;
        const callDestination = rvcTestCallPlaybackDestinationRef.current!;

        if (!rvcTestAudioElementRef.current) {
            rvcTestAudioElementRef.current = new Audio();
        }
        const audio = rvcTestAudioElementRef.current;
        if ((audio as any).srcObject !== destination.stream) {
            (audio as any).srcObject = destination.stream;
        }

        const sinkTarget = selectedSpeakerDeviceId || '';
        const sinkFn = (audio as any).setSinkId as ((id: string) => Promise<void>) | undefined;
        if (sinkTarget && sinkFn && rvcTestMainSinkIdRef.current !== sinkTarget) {
            try {
                await sinkFn.call(audio, sinkTarget);
                rvcTestMainSinkIdRef.current = sinkTarget;
            } catch (error) {
                const nowMs = Date.now();
                if (nowMs - rvcTestRouteErrorLogMsRef.current > 5000) {
                    addLog(`Failed to route monitor output to selected speaker: ${String(error)}`);
                    rvcTestRouteErrorLogMsRef.current = nowMs;
                }
                rvcTestMainSinkIdRef.current = '';
            }
        }

        if (context.state === 'suspended') {
            await context.resume();
        }
        if (audio.paused) {
            await audio.play();
        }

        if (rvcTestCallRelayEnabled && selectedRvcTestCallOutputDeviceId) {
            if (!rvcTestCallAudioElementRef.current) {
                rvcTestCallAudioElementRef.current = new Audio();
            }
            const callAudio = rvcTestCallAudioElementRef.current;
            if ((callAudio as any).srcObject !== callDestination.stream) {
                (callAudio as any).srcObject = callDestination.stream;
            }
            const callSinkFn = (callAudio as any).setSinkId as ((id: string) => Promise<void>) | undefined;
            if (!callSinkFn) {
                if (rvcTestCallSinkIdRef.current !== '__unsupported__') {
                    addLog('Call relay requires setSinkId support. This runtime cannot route to a separate call output device.');
                    rvcTestCallSinkIdRef.current = '__unsupported__';
                }
            } else {
                try {
                    if (rvcTestCallSinkIdRef.current !== selectedRvcTestCallOutputDeviceId) {
                        await callSinkFn.call(callAudio, selectedRvcTestCallOutputDeviceId);
                        rvcTestCallSinkIdRef.current = selectedRvcTestCallOutputDeviceId;
                    }
                    if (callAudio.paused) {
                        await callAudio.play();
                    }
                } catch (error) {
                    const nowMs = Date.now();
                    if (nowMs - rvcTestRouteErrorLogMsRef.current > 5000) {
                        addLog(`Failed to route converted voice to call output device: ${String(error)}`);
                        rvcTestRouteErrorLogMsRef.current = nowMs;
                    }
                    try {
                        callAudio.pause();
                        (callAudio as any).srcObject = null;
                    } catch {
                        // ignore
                    }
                    rvcTestCallSinkIdRef.current = '';
                }
            }
        } else if (rvcTestCallAudioElementRef.current) {
            try {
                rvcTestCallAudioElementRef.current.pause();
                (rvcTestCallAudioElementRef.current as any).srcObject = null;
            } catch {
                // ignore
            }
            rvcTestCallSinkIdRef.current = '';
        }

        return { context, destination, callDestination, audio };
    };

    const playNextRvcTestAudio = async () => {
        if (rvcTestPlaybackRunningRef.current) return;
        const minPrimeChunks = rvcTestInputSource === 'app' ? 2 : (rvcTestChunkMs >= 1000 ? 2 : 3);
        if (!rvcTestPlaybackPrimedRef.current && rvcTestPlaybackQueueRef.current.length < minPrimeChunks) {
            return;
        }
        const nextChunk = rvcTestPlaybackQueueRef.current.shift();
        if (!nextChunk) return;

        rvcTestPlaybackRunningRef.current = true;
        try {
            const { context, destination, callDestination } = await ensureRvcTestPlaybackGraph();
            const wavBuffer = base64ToArrayBuffer(nextChunk.audioBase64);
            const decodedRaw = await context.decodeAudioData(wavBuffer.slice(0));
            const decoded = trimDecodedRvcChunk(
                context,
                decodedRaw,
                nextChunk.skipSamples,
                nextChunk.takeSamples,
            );
            if (decoded.length <= 0 || decoded.duration <= 0) {
                return;
            }

            const source = context.createBufferSource();
            source.buffer = decoded;
            const gain = context.createGain();
            source.connect(gain);
            gain.connect(destination);
            if (rvcTestCallRelayEnabled && selectedRvcTestCallOutputDeviceId) {
                gain.connect(callDestination);
            }

            const now = context.currentTime;
            const leadTimeSec = rvcTestInputSource === 'app' ? 0.35 : 0.28;
            const overlapSec = rvcTestPlaybackScheduleTimeRef.current > 0
                ? Math.min(0.012, decoded.duration * 0.20)
                : 0;
            let startAt: number;
            if (rvcTestPlaybackScheduleTimeRef.current > 0) {
                startAt = Math.max(now + leadTimeSec, rvcTestPlaybackScheduleTimeRef.current - overlapSec);
            } else {
                startAt = now + leadTimeSec;
            }

            const endAt = startAt + decoded.duration;
            let fadeSec = Math.min(0.010, decoded.duration * 0.18);
            if (decoded.duration < fadeSec * 2) {
                fadeSec = Math.max(0.0015, decoded.duration * 0.30);
            }

            gain.gain.setValueAtTime(0, startAt);
            gain.gain.linearRampToValueAtTime(1, startAt + fadeSec);
            gain.gain.setValueAtTime(1, Math.max(startAt + fadeSec, endAt - fadeSec));
            gain.gain.linearRampToValueAtTime(0, endAt);

            source.start(startAt);
            source.onended = () => {
                try {
                    gain.disconnect();
                    source.disconnect();
                } catch {
                    // ignore
                }
            };

            rvcTestPlaybackScheduleTimeRef.current = endAt;
            rvcTestPlaybackPrimedRef.current = true;
        } catch (error) {
            addLog(`RVC test playback error: ${String(error)}`);
        } finally {
            rvcTestPlaybackRunningRef.current = false;
            if (rvcTestPlaybackQueueRef.current.length > 0) {
                void playNextRvcTestAudio();
            }
        }
    };

    const flushRvcTestChunks = async () => {
        if (!rvcTestRunningRef.current || rvcTestConvertingRef.current) return;
        const nextChunk = rvcTestPendingChunksRef.current.shift();
        if (!nextChunk) return;

        rvcTestConvertingRef.current = true;
        try {
            if (!nextChunk.isSpeech) {
                const silentLength = Math.max(
                    nextChunk.takeSamples,
                    nextChunk.skipSamples + nextChunk.takeSamples,
                );
                const silent = new Array<number>(silentLength).fill(0);
                rvcTestPlaybackQueueRef.current.push({
                    audioBase64: pcm16ToWavBase64(silent, 16000, 1),
                    skipSamples: nextChunk.skipSamples,
                    takeSamples: nextChunk.takeSamples,
                });
                const nowMs = Date.now();
                if (nowMs - rvcTestLastVadLogMsRef.current > 5000) {
                    addLog(`VAD suppressed non-speech chunk (speechRatio=${nextChunk.speechRatio.toFixed(2)}).`);
                    rvcTestLastVadLogMsRef.current = nowMs;
                }
                void playNextRvcTestAudio();
                return;
            }

            const wavBase64 = pcm16ToWavBase64(nextChunk.pcm, 16000, 1);
            const res = await window.electronAPI.rvcConvert({
                inputBase64: wavBase64,
                modelId: selectedRvcModel,
                indexPath: selectedRvcIndexPath || undefined,
                speakerId: rvcSpeakerId,

                f0Method: rvcF0Method,
                transpose: rvcTranspose,
                indexRate: rvcIndexRate,
                protect: rvcProtect,
                filterRadius: rvcFilterRadius,
                rmsMixRate: rvcRmsMixRate,

                resampleSr: rvcResampleSr,
            });

            if (!res.success || !res.audioBase64) {
                addLog(`RVC test convert failed: ${res.error?.message || 'Unknown error'}`);
            } else {
                rvcTestPlaybackQueueRef.current.push({
                    audioBase64: res.audioBase64,
                    skipSamples: nextChunk.skipSamples,
                    takeSamples: nextChunk.takeSamples,
                });
                const maxPlaybackChunks = rvcTestInputSource === 'app' ? 10 : 12;
                if (rvcTestPlaybackQueueRef.current.length > maxPlaybackChunks) {
                    const trimCount = rvcTestPlaybackQueueRef.current.length - maxPlaybackChunks;
                    rvcTestPlaybackQueueRef.current.splice(0, trimCount);
                    const nowMs = Date.now();
                    if (nowMs - rvcTestLastDropLogMsRef.current > 5000) {
                        addLog('RVC test playback backlog detected. Oldest chunks were trimmed to keep streaming smooth.');
                        rvcTestLastDropLogMsRef.current = nowMs;
                    }
                }
                void playNextRvcTestAudio();
            }
        } catch (error) {
            addLog(`RVC test convert error: ${String(error)}`);
        } finally {
            rvcTestConvertingRef.current = false;
            if (rvcTestPendingChunksRef.current.length > 0) {
                void flushRvcTestChunks();
            }
        }
    };

    const startRvcTestMode = async () => {
        if (rvcStatus.runtimeState !== 'running') {
            addLog('Start RVC server before enabling test mode.');
            return;
        }
        if (!selectedRvcModel) {
            addLog('Select an RVC model before enabling test mode.');
            return;
        }
        if (rvcTestRunning) return;

        try {
            if (rvcTestCallRelayEnabled && !selectedRvcTestCallOutputDeviceId) {
                throw new Error('Select "Call App Output Device" before enabling call relay.');
            }
            rvcTestPcmBufferRef.current = [];
            rvcTestContextTailRef.current = [];
            rvcTestPendingChunksRef.current = [];
            rvcTestLastDropLogMsRef.current = 0;
            rvcTestLastVadLogMsRef.current = 0;
            rvcTestPlaybackPrimedRef.current = false;
            resetRvcTestInputDsp();
            resetRvcTestResampler();
            setRvcTestRunning(true);
            rvcTestRunningRef.current = true;
            rvcTestUsingProcessCaptureRef.current = false;
            addLog(
                `Input cleanup: noiseCancel=${rvcTestNoiseCancelRef.current ? 'ON' : 'OFF'}, `
                + `bgmRemoval=${rvcTestBgmRemovalRef.current ? `ON(${rvcTestBgmRemovalStrengthRef.current.toFixed(2)})` : 'OFF'}, `
                + `spectralDenoise=${rvcTestSpectralDenoiseRef.current ? `ON(str=${rvcTestSpectralStrengthRef.current.toFixed(2)}, floor=${rvcTestSpectralFloorRef.current.toFixed(2)})` : 'OFF'}, `
                + `speechOnly=${rvcTestSpeechOnlyConvertRef.current ? `ON(agg=${rvcTestVadAggressivenessRef.current}, min=${rvcTestVadMinSpeechMsRef.current}ms, hold=${rvcTestVadHangoverMsRef.current}ms)` : 'OFF'}`
            );
            if (rvcTestCallRelayEnabled) {
                const selectedRelay = speakerDevices.find((d) => d.deviceId === selectedRvcTestCallOutputDeviceId);
                addLog(
                    `Call relay ON: converted voice is also sent to "${selectedRelay?.label || selectedRvcTestCallOutputDeviceId}". `
                    + 'Set Teams/Discord mic input to the paired virtual recording device.'
                );
                addLog('Discord mic input should be "CABLE Output (VB-Audio Virtual Cable)" when call output is "CABLE Input".');
            }

            if (rvcTestInputSource === 'app') {
                if (!selectedRvcTestProcessPid) {
                    throw new Error('Select an app before enabling app input mode.');
                }

                const selectedProcess = rvcTestProcesses.find((p) => p.pid === selectedRvcTestProcessPid);
                const targetName = selectedProcess?.name || '';
                rvcTestMuteAnchorPidRef.current = selectedRvcTestProcessPid;
                rvcTestMuteTargetNameRef.current = targetName || null;
                rvcTestMutedStatesRef.current.clear();
                clearRvcTestMuteRefreshTimer();

                if (rvcTestMuteSourceApp) {
                    addLog('Experimental source mute is ON. If conversion stops, turn this OFF and route app output in Windows settings.');
                    const mutedCount = await applyRvcTestSourceMute(selectedRvcTestProcessPid, targetName);
                    if (mutedCount > 0) {
                        addLog(`Muted ${mutedCount} source app session(s).`);
                    }
                    rvcTestMuteRefreshTimerRef.current = window.setInterval(() => {
                        const anchorPid = rvcTestMuteAnchorPidRef.current;
                        if (!rvcTestRunningRef.current || !anchorPid) return;
                        void applyRvcTestSourceMute(anchorPid, rvcTestMuteTargetNameRef.current || undefined, true);
                    }, 1500);
                }

                window.electronAPI.offProcessAudioStream();
                window.electronAPI.onProcessAudioStream((data) => {
                    appendRvcTestPcm(data.buffer, data.sampleRate, data.channels);
                });

                const startResult = await window.electronAPI.startProcessCaptureStream(selectedRvcTestProcessPid);
                if (!startResult.success) {
                    throw new Error(startResult.error || 'Failed to start app audio capture.');
                }

                rvcTestUsingProcessCaptureRef.current = true;
                addLog(`RVC test mode started. App input: ${selectedProcess?.name || `PID ${selectedRvcTestProcessPid}`}.`);
                return;
            }

            const selectedMic = micDevices.find((d) => d.deviceId === selectedMicDeviceId);
            if (selectedMic && isLikelyVirtualMicInput(selectedMic.label)) {
                addLog(
                    `Microphone (Input) is set to "${selectedMic.label}". `
                    + 'This is a virtual cable endpoint. Speaking into your physical mic will not enter unless routed into this cable.'
                );
            }

            const micConstraint = selectedMicDeviceId ? { deviceId: { exact: selectedMicDeviceId } } : true;
            const useWebNs = rvcTestNoiseCancelRef.current;
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: typeof micConstraint === 'object'
                    ? {
                        ...micConstraint,
                        echoCancellation: useWebNs,
                        noiseSuppression: useWebNs,
                        autoGainControl: useWebNs,
                        channelCount: 1,
                        sampleRate: 16000,
                        sampleSize: 16,
                    }
                    : {
                        echoCancellation: useWebNs,
                        noiseSuppression: useWebNs,
                        autoGainControl: useWebNs,
                        channelCount: 1,
                        sampleRate: 16000,
                        sampleSize: 16,
                    },
            });

            const context = new AudioContext({ sampleRate: 16000 });
            if (context.state === 'suspended') {
                await context.resume();
            }

            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(2048, 1, 1);
            const silentGain = context.createGain();
            silentGain.gain.value = 0;

            source.connect(processor);
            processor.connect(silentGain);
            silentGain.connect(context.destination);

            rvcTestStreamRef.current = stream;
            rvcTestAudioContextRef.current = context;
            rvcTestProcessorRef.current = processor;

            processor.onaudioprocess = (event) => {
                if (!rvcTestStreamRef.current) return;
                const input = event.inputBuffer.getChannelData(0);
                const pcm = new Array<number>(input.length);
                for (let i = 0; i < input.length; i++) {
                    const s = Math.max(-1, Math.min(1, input[i]));
                    pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
                }
                appendRvcTestPcm(pcm, 16000, 1);
            };

            addLog('RVC test mode started. Mic input is being voice-converted in near real-time.');
        } catch (error) {
            addLog(`Failed to start RVC test mode: ${String(error)}`);
            await stopRvcTestMode(true);
        }
    };

    useEffect(() => {
        refreshStatus();
        loadPresets();
        loadActingProfiles();
        void refreshRealtimeDevices();
        window.electronAPI.rvcGetVerboseLogs()
            .then((res) => {
                if (res?.success) {
                    setRvcVerboseLogs(!!res.verboseLogs);
                }
            })
            .catch(() => {
                // non-fatal
            });
        const timer = setInterval(refreshStatus, 5000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (ttsStatus.runtimeState === 'running') {
            loadTtsModels();
        }
    }, [ttsStatus.runtimeState]);

    useEffect(() => {
        if (rvcStatus.runtimeState === 'running') {
            loadRvcModels();
        }
    }, [rvcStatus.runtimeState]);

    useEffect(() => {
        const onDeviceChange = () => {
            void refreshRealtimeDevices();
        };
        navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
        return () => {
            navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
        };
    }, []);

    useEffect(() => {
        rvcTestNoiseCancelRef.current = rvcTestNoiseCancel;
    }, [rvcTestNoiseCancel]);

    useEffect(() => {
        rvcTestBgmRemovalRef.current = rvcTestBgmRemoval;
    }, [rvcTestBgmRemoval]);

    useEffect(() => {
        rvcTestBgmRemovalStrengthRef.current = rvcTestBgmRemovalStrength;
    }, [rvcTestBgmRemovalStrength]);

    useEffect(() => {
        rvcTestSpectralDenoiseRef.current = rvcTestSpectralDenoise;
    }, [rvcTestSpectralDenoise]);

    useEffect(() => {
        rvcTestSpectralStrengthRef.current = rvcTestSpectralStrength;
    }, [rvcTestSpectralStrength]);

    useEffect(() => {
        rvcTestSpectralFloorRef.current = rvcTestSpectralFloor;
    }, [rvcTestSpectralFloor]);

    useEffect(() => {
        if (!sbv2AutoEmotionEnabled) {
            setSbv2AutoEmotionDetected(null);
            setSbv2AutoEmotionDebugRows([]);
        }
    }, [sbv2AutoEmotionEnabled]);

    useEffect(() => {
        if (!audioUrl || !outputAudioAutoPlayPendingRef.current) return;

        const timer = window.setTimeout(() => {
            const audio = outputAudioElementRef.current;
            outputAudioAutoPlayPendingRef.current = false;
            if (!audio) return;
            try {
                audio.currentTime = 0;
            } catch {
                // ignore seek failures
            }
            void audio.play().catch((err) => {
                addLog(`Auto-play failed: ${String(err)}`);
            });
        }, 0);

        return () => window.clearTimeout(timer);
    }, [audioUrl]);

    const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

    const waitForOutputPlaybackEnd = async (timeoutMs: number = 90000): Promise<boolean> => {
        const startDeadline = Date.now() + 7000;
        while (Date.now() < startDeadline) {
            const audio = outputAudioElementRef.current;
            if (audio && (!audio.paused || audio.ended || audio.currentTime > 0.01)) {
                break;
            }
            await sleepMs(100);
        }

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const audio = outputAudioElementRef.current;
            if (!audio) return false;
            if (audio.ended) return true;
            const duration = Number(audio.duration || 0);
            if (Number.isFinite(duration) && duration > 0 && audio.currentTime >= duration - 0.05) {
                return true;
            }
            await sleepMs(120);
        }
        return false;
    };

    useEffect(() => {
        if (activeActingPreviewScripts.length === 0) {
            setSelectedActingPreviewScriptId('');
            return;
        }
        if (!activeActingPreviewScripts.some((s) => s.id === selectedActingPreviewScriptId)) {
            setSelectedActingPreviewScriptId(activeActingPreviewScripts[0].id);
        }
    }, [activeActingPreviewScripts, selectedActingPreviewScriptId]);

    useEffect(() => {
        rvcTestSpeechOnlyConvertRef.current = rvcTestSpeechOnlyConvert;
    }, [rvcTestSpeechOnlyConvert]);

    useEffect(() => {
        rvcTestVadAggressivenessRef.current = rvcTestVadAggressiveness;
    }, [rvcTestVadAggressiveness]);

    useEffect(() => {
        rvcTestVadMinSpeechMsRef.current = rvcTestVadMinSpeechMs;
    }, [rvcTestVadMinSpeechMs]);

    useEffect(() => {
        rvcTestVadHangoverMsRef.current = rvcTestVadHangoverMs;
    }, [rvcTestVadHangoverMs]);

    useEffect(() => {
        if (!rvcTestCallRelayEnabled) return;
        if (selectedRvcTestCallOutputDeviceId) return;
        if (rvcTestCallOutputCandidates.length > 0) {
            setSelectedRvcTestCallOutputDeviceId(rvcTestCallOutputCandidates[0].deviceId);
        }
    }, [rvcTestCallRelayEnabled, selectedRvcTestCallOutputDeviceId, rvcTestCallOutputCandidates]);

    useEffect(() => {
        if (!rvcTestRunning) return;
        const audio = rvcTestAudioElementRef.current;
        if (!audio) return;
        const sinkTarget = selectedSpeakerDeviceId || '';
        const sinkFn = (audio as any).setSinkId as ((id: string) => Promise<void>) | undefined;
        if (!sinkTarget) {
            rvcTestMainSinkIdRef.current = '';
            return;
        }
        if (!sinkFn) return;
        sinkFn.call(audio, sinkTarget).catch((error) => {
            addLog(`Failed to switch test output speaker: ${String(error)}`);
        });
        rvcTestMainSinkIdRef.current = sinkTarget;
    }, [selectedSpeakerDeviceId, rvcTestRunning]);

    useEffect(() => {
        if (!rvcTestRunning) return;
        const callAudio = rvcTestCallAudioElementRef.current;
        if (!callAudio) return;
        const callDestination = rvcTestCallPlaybackDestinationRef.current;
        if (callDestination && (callAudio as any).srcObject !== callDestination.stream) {
            (callAudio as any).srcObject = callDestination.stream;
        }

        if (!rvcTestCallRelayEnabled) {
            try {
                callAudio.pause();
                (callAudio as any).srcObject = null;
            } catch {
                // ignore
            }
            rvcTestCallSinkIdRef.current = '';
            return;
        }

        if (!selectedRvcTestCallOutputDeviceId) return;
        const sinkFn = (callAudio as any).setSinkId as ((id: string) => Promise<void>) | undefined;
        if (!sinkFn) {
            if (rvcTestCallSinkIdRef.current !== '__unsupported__') {
                addLog('Call relay output switch is not supported in this runtime (setSinkId unavailable).');
                rvcTestCallSinkIdRef.current = '__unsupported__';
            }
            return;
        }
        sinkFn.call(callAudio, selectedRvcTestCallOutputDeviceId)
            .then(() => {
                rvcTestCallSinkIdRef.current = selectedRvcTestCallOutputDeviceId;
            })
            .catch((error) => {
                addLog(`Failed to switch call relay output: ${String(error)}`);
            });
    }, [rvcTestCallRelayEnabled, selectedRvcTestCallOutputDeviceId, rvcTestRunning]);

    useEffect(() => {
        if (rvcTestInputSource === 'app') {
            void refreshRvcTestProcesses();
        }
    }, [rvcTestInputSource]);

    useEffect(() => {
        if (rvcTestEnabled) {
            void startRvcTestMode();
        } else if (rvcTestRunning) {
            void stopRvcTestMode();
        }
    }, [rvcTestEnabled]);

    useEffect(() => {
        if (rvcStatus.runtimeState !== 'running' && (rvcTestEnabled || rvcTestRunning)) {
            setRvcTestEnabled(false);
            void stopRvcTestMode(true);
        }
    }, [rvcStatus.runtimeState, rvcTestEnabled, rvcTestRunning]);

    useEffect(() => {
        return () => {
            void stopRvcTestMode(true);
        };
    }, []);

    const handleInstallTts = async () => {
        setIsLoading(true);
        addLog('Installing SBV2...');
        const res = await window.electronAPI.ttsInstall();
        addLog(res.success ? 'SBV2 installed.' : `SBV2 install failed: ${res.error?.message || 'Unknown error'}`);
        await refreshStatus();
        setIsLoading(false);
    };

    const handleStartTts = async () => {
        setIsLoading(true);
        addLog(`Starting SBV2 server (${useCpuMode ? 'CPU' : 'GPU/Auto'})...`);
        const res = await window.electronAPI.ttsStartServer({ forceCpu: useCpuMode });
        addLog(res.success ? 'SBV2 server started.' : `SBV2 start failed: ${res.error?.message || 'Unknown error'}`);
        await refreshStatus();
        setIsLoading(false);
    };

    const handleStopTts = async () => {
        setIsLoading(true);
        await window.electronAPI.ttsStopServer();
        addLog('SBV2 server stopped.');
        await refreshStatus();
        setIsLoading(false);
    };

    const handleInstallRvc = async () => {
        setIsLoading(true);
        addLog('Installing RVC...');
        const res = await window.electronAPI.rvcInstall();
        addLog(res.success ? 'RVC installed.' : `RVC install failed: ${res.error?.message || 'Unknown error'}`);
        await refreshStatus();
        setIsLoading(false);
    };

    const handleStartRvc = async () => {
        setIsLoading(true);
        addLog(`Starting RVC server (${useCpuMode ? 'CPU' : 'GPU/Auto'})...`);
        const res = await window.electronAPI.rvcStartServer({ forceCpu: useCpuMode, verboseLogs: rvcVerboseLogs });
        addLog(res.success ? 'RVC server started.' : `RVC start failed: ${res.error?.message || 'Unknown error'}`);
        await refreshStatus();
        setIsLoading(false);
    };

    const handleStopRvc = async () => {
        setIsLoading(true);
        if (rvcTestEnabled || rvcTestRunning) {
            setRvcTestEnabled(false);
            await stopRvcTestMode(true);
        }
        await window.electronAPI.rvcStopServer();
        addLog('RVC server stopped.');
        await refreshStatus();
        setIsLoading(false);
    };

    const handlePickRvcInput = async () => {
        const selected = await window.electronAPI.selectFile(['wav'], true);
        if (selected.success && selected.paths && selected.paths.length > 0) {
            setRvcInputPaths(selected.paths);
            addLog(`RVC input: ${selected.paths.length} file(s) selected`);
        }
    };

    const handleOpenRvcModelsFolder = async () => {
        const res = await window.electronAPI.rvcOpenModelsFolder();
        if (res.success) {
            addLog(`Opened RVC models folder: ${res.path || '(unknown path)'}`);
        } else {
            addLog(`Failed to open RVC models folder: ${res.error || 'Unknown error'}`);
        }
    };

    const handleOpenAppVolumeSettings = async () => {
        try {
            const res = await window.electronAPI.invoke('open-app-volume-settings');
            if (res?.success) {
                addLog('Opened Windows "App volume and device preferences".');
            } else {
                addLog(`Failed to open app volume settings: ${res?.error || 'Unknown error'}`);
            }
        } catch (error) {
            addLog(`Failed to open app volume settings: ${String(error)}`);
        }
    };

    const handleResetInputCleanupProfile = () => {
        rvcTestNoiseFloorRef.current = 0.004;
        rvcTestGateGainRef.current = 1;
        rvcTestSpecNoiseMagRef.current = null;
        rvcTestVadNoiseRmsRef.current = 0.006;
        rvcTestVadHangoverFramesRef.current = 0;
        addLog('Input cleanup profile reset. Keep silence for 1-2 seconds to relearn ambient noise.');
    };

    const handleToggleRvcVerboseLogs = async () => {
        const next = !rvcVerboseLogs;
        const res = await window.electronAPI.rvcSetVerboseLogs(next);
        if (!res?.success) {
            addLog(`Failed to set RVC verbose logs: ${res?.error || 'Unknown error'}`);
            return;
        }
        setRvcVerboseLogs(!!res.verboseLogs);
        addLog(`RVC verbose logs: ${res.verboseLogs ? 'ON' : 'OFF'}`);
        if (res.requiresRestart) {
            addLog('Restart RVC server to apply Python-side log verbosity.');
        }
    };

    const handleToggleComputeMode = async () => {
        const nextUseCpu = !useCpuMode;
        setUseCpuMode(nextUseCpu);
        addLog(`Compute mode changed: ${nextUseCpu ? 'CPU' : 'GPU/Auto'} (default is GPU/Auto).`);

        const ttsRunning = ttsStatus.runtimeState === 'running';
        const rvcRunning = rvcStatus.runtimeState === 'running';
        if (!ttsRunning && !rvcRunning) {
            addLog('Mode will apply on next server start.');
            return;
        }

        setIsLoading(true);
        try {
            if (ttsRunning) {
                addLog('Restarting SBV2 server to apply compute mode...');
                await window.electronAPI.ttsStopServer();
                await window.electronAPI.ttsStartServer({ forceCpu: nextUseCpu });
            }
            if (rvcRunning) {
                addLog('Restarting RVC server to apply compute mode...');
                await window.electronAPI.rvcStopServer();
                await window.electronAPI.rvcStartServer({ forceCpu: nextUseCpu, verboseLogs: rvcVerboseLogs });
            }
            addLog('Compute mode applied.');
        } catch (error) {
            addLog(`Failed to apply compute mode: ${String(error)}`);
        } finally {
            await refreshStatus();
            setIsLoading(false);
        }
    };

    const applyTtsPreset = async (preset: TtsPreset) => {
        setSelectedTtsModel(preset.modelId);
        setSelectedStyle(preset.style);
        setSpeed(preset.speed);
        setPitch(preset.pitch);
        setIntonation(preset.intonation);
        setStyleWeight(preset.styleWeight ?? 1.0);
        setSdpRatio(preset.sdpRatio ?? 0.2);
        setNoiseScale(preset.noiseScale ?? 0.6);
        setNoiseScaleW(preset.noiseScaleW ?? 0.8);
        await window.electronAPI.ttsSetModel(preset.modelId);
        addLog(`SBV2 preset loaded: ${preset.name}`);
    };

    const applyJpExtraEmotionPreset = () => {
        setSbv2AutoEmotionStrength('strong');
        setSbv2AutoEmotionApplyMode('auto_style');
        setSbv2AutoEmotionAnalyzerMode('hybrid');
        setSbv2AutoEmotionClassifierBlend(0.58);
        setSbv2AutoEmotionThreshold(0.50);
        setSbv2JpExtraEmotionBoost(true);
        setSbv2JpExtraBoostLevel(0.78);
        setAssistTextWeight((v) => Math.max(v, 1.18));
        setStyleWeight((v) => Math.max(v, 1.15));
        setIntonation((v) => Math.max(v, 1.08));
        setSdpRatio((v) => Math.max(v, 0.28));
        setNoiseScale((v) => Math.max(v, 0.62));
        setNoiseScaleW((v) => Math.max(v, 0.84));
        addLog('Applied JP-Extra emotion preset (strong).');
    };

    const applyRvcPreset = async (preset: RvcPreset) => {
        setSelectedRvcModel(preset.modelId);
        setRvcF0Method(preset.f0Method);
        setRvcTranspose(preset.transpose);
        setRvcIndexRate(preset.indexRate);
        setRvcProtect(preset.protect);
        setRvcFilterRadius(preset.filterRadius);
        setRvcRmsMixRate(preset.rmsMixRate);
        setRvcResampleSr(preset.resampleSr);
        await window.electronAPI.rvcSetModel(preset.modelId);
        addLog(`RVC preset loaded: ${preset.name}`);
    };

    const buildSpeakerScanIds = (speakerCount: number, currentSid: number, limit: number = 12): number[] => {
        const maxSid = Math.max(0, speakerCount - 1);
        if (maxSid === 0) return [0];

        const target = Math.max(2, Math.min(limit, speakerCount));
        const set = new Set<number>();
        set.add(0);
        set.add(maxSid);
        set.add(Math.max(0, Math.min(maxSid, currentSid)));

        if (target > 3) {
            const step = maxSid / (target - 1);
            for (let i = 0; i < target; i++) {
                set.add(Math.round(i * step));
            }
        }

        return Array.from(set).sort((a, b) => a - b);
    };

    const rvcSpeakerScanAbortRef = useRef(false);

    const handleScanSpeakerIds = async (fullScan: boolean = false) => {
        if (rvcStatus.runtimeState !== 'running') {
            addLog('Start RVC server before speaker scan.');
            return;
        }
        if (!selectedRvcModel) {
            addLog('Select an RVC model before speaker scan.');
            return;
        }

        const inputPath = rvcInputPaths[0] || lastSbv2WavPath || '';
        if (!inputPath) {
            addLog('Speaker scan requires RVC input WAV (or previous SBV2 output).');
            return;
        }

        let ids: number[];
        if (fullScan) {
            ids = Array.from({ length: rvcSpeakerCount }, (_, i) => i);
        } else {
            ids = buildSpeakerScanIds(rvcSpeakerCount, rvcSpeakerId, 12);
        }
        if (ids.length === 0) {
            addLog('No speaker IDs available for scan.');
            return;
        }

        rvcSpeakerScanAbortRef.current = false;
        setRvcSpeakerScanRunning(true);
        setRvcSpeakerScanResults([]);
        addLog(`Speaker scan started (${fullScan ? 'FULL' : 'quick'}): ${ids.length} IDs`);

        try {
            for (let idx = 0; idx < ids.length; idx++) {
                if (rvcSpeakerScanAbortRef.current) {
                    addLog('Speaker scan aborted by user.');
                    break;
                }
                const sid = ids[idx];
                addLog(`Speaker scan [${idx + 1}/${ids.length}] SID ${sid}...`);

                const res = await window.electronAPI.rvcConvert({
                    inputPath,
                    modelId: selectedRvcModel,
                    indexPath: selectedRvcIndexPath || undefined,
                    speakerId: sid,
    
                    f0Method: rvcF0Method,
                    transpose: rvcTranspose,
                    indexRate: rvcIndexRate,
                    protect: rvcProtect,
                    filterRadius: rvcFilterRadius,
                    rmsMixRate: rvcRmsMixRate,
    
                    resampleSr: rvcResampleSr,
                });

                if (!res.success) {
                    const err = res.error?.message || 'Unknown error';
                    setRvcSpeakerScanResults((prev) => [...prev, { sid, error: err }]);
                    continue;
                }

                let url: string | null = null;
                if (res.audioBase64) {
                    url = `data:audio/wav;base64,${res.audioBase64}`;
                } else if (res.wavPath) {
                    url = await readAudioAsDataUrl(res.wavPath);
                }

                setRvcSpeakerScanResults((prev) => [...prev, { sid, audioUrl: url || undefined }]);
            }
        } catch (error) {
            addLog(`Speaker scan failed: ${String(error)}`);
        } finally {
            setRvcSpeakerScanRunning(false);
            rvcSpeakerScanAbortRef.current = false;
            addLog('Speaker scan finished.');
        }
    };

    const readAudioAsDataUrl = async (wavPath: string | undefined): Promise<string | null> => {
        if (!wavPath) return null;
        const audioData = await window.electronAPI.readAudioFile(wavPath);
        if (!audioData.success || !audioData.base64) {
            return null;
        }
        return `data:audio/wav;base64,${audioData.base64}`;
    };

    const splitTextForAutoEmotion = (input: string): string[] => {
        const normalized = (input || '').replace(/\r\n/g, '\n').trim();
        if (!normalized) return [];

        const coarse = normalized
            .split(/(?<=[。！？!?…\n])/g)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        const merged: string[] = [];
        const shortLen = 20;
        for (const seg of coarse) {
            if (merged.length === 0) {
                merged.push(seg);
                continue;
            }
            if (seg.length < shortLen || merged[merged.length - 1].length < shortLen) {
                merged[merged.length - 1] = `${merged[merged.length - 1]} ${seg}`.trim();
            } else {
                merged.push(seg);
            }
        }

        const maxLen = 240;
        const out: string[] = [];
        for (const seg of merged) {
            if (seg.length <= maxLen) {
                out.push(seg);
                continue;
            }
            let rest = seg;
            while (rest.length > maxLen) {
                const region = rest.slice(0, maxLen);
                const punct = Math.max(
                    region.lastIndexOf('。'),
                    region.lastIndexOf('！'),
                    region.lastIndexOf('!'),
                    region.lastIndexOf('？'),
                    region.lastIndexOf('?'),
                    region.lastIndexOf('、'),
                    region.lastIndexOf(','),
                    region.lastIndexOf(';'),
                    region.lastIndexOf('；'),
                );
                const cut = punct >= 80 ? punct + 1 : maxLen;
                out.push(rest.slice(0, cut).trim());
                rest = rest.slice(cut).trim();
            }
            if (rest.length > 0) out.push(rest);
        }

        return out.filter((s) => s.length > 0);
    };

    const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

    const analyzeAutoEmotionSegment = (segment: string): AutoEmotionAnalysis => {
        const textNorm = segment.trim();
        const ruleScores: Record<AutoEmotion, number> = {
            neutral: 0.45,
            joy: 0.0,
            sadness: 0.0,
            anger: 0.0,
            fear: 0.0,
        };
        const reasons: string[] = [];

        for (const [emotion, words] of Object.entries(AUTO_EMOTION_KEYWORDS) as [Exclude<AutoEmotion, 'neutral'>, string[]][]) {
            let hits = 0;
            for (const w of words) {
                if (textNorm.includes(w)) {
                    hits += 1;
                }
            }
            if (hits > 0) {
                ruleScores[emotion] += hits * 0.9;
                reasons.push(`${emotion}:kw${hits}`);
            }
        }

        const exclam = (textNorm.match(/[!！]/g) || []).length;
        const quest = (textNorm.match(/[?？]/g) || []).length;
        const ellipsis = (textNorm.match(/[…\.]{2,}/g) || []).length;
        const comma = (textNorm.match(/[、,]/g) || []).length;

        if (exclam > 0) {
            ruleScores.joy += 0.45 * exclam;
            ruleScores.anger += 0.55 * exclam;
            reasons.push(`!x${exclam}`);
        }
        if (quest > 0) {
            ruleScores.fear += 0.4 * quest;
            ruleScores.neutral += 0.1 * quest;
            reasons.push(`?x${quest}`);
        }
        if (ellipsis > 0) {
            ruleScores.fear += 0.4 * ellipsis;
            ruleScores.sadness += 0.3 * ellipsis;
            reasons.push(`...x${ellipsis}`);
        }
        if (comma >= 3 && textNorm.length > 50) {
            ruleScores.neutral += 0.2;
        }
        if (/[wｗ笑]/i.test(textNorm)) {
            ruleScores.joy += 0.45;
            reasons.push('laugh');
        }
        if (/(ない|ません|できない|無理|いや|ダメ)/.test(textNorm)) {
            ruleScores.sadness += 0.25;
            ruleScores.fear += 0.2;
        }

        // Lightweight linear classifier (local, no external runtime).
        const kwCountByEmotion: Record<AutoEmotion, number> = {
            neutral: 0,
            joy: 0,
            sadness: 0,
            anger: 0,
            fear: 0,
        };
        for (const [emotion, words] of Object.entries(AUTO_EMOTION_KEYWORDS) as [Exclude<AutoEmotion, 'neutral'>, string[]][]) {
            for (const w of words) {
                if (textNorm.includes(w)) {
                    kwCountByEmotion[emotion] += 1;
                }
            }
        }
        const charLen = textNorm.length;
        const hasLaugh = /[wｗ笑]/i.test(textNorm);
        const hasNegation = /(ない|ません|できない|無理|いや|ダメ)/.test(textNorm);
        const hasUncertain = /(かな|かも|どうしよう|不安|心配|迷)/.test(textNorm);
        const hasStrongAssertive = /(だろ|だぞ|絶対|許せない|ふざけるな)/.test(textNorm);
        const classifierFeatureGain = activeActingProfile.classifierFeatureGain;
        const classifierEmotionBias = activeActingProfile.classifierEmotionBias;

        const classifierLogits: Record<AutoEmotion, number> = {
            neutral: -0.02 + (classifierEmotionBias.neutral || 0),
            joy: -0.08 + (classifierEmotionBias.joy || 0),
            sadness: -0.10 + (classifierEmotionBias.sadness || 0),
            anger: -0.12 + (classifierEmotionBias.anger || 0),
            fear: -0.09 + (classifierEmotionBias.fear || 0),
        };
        classifierLogits.neutral += 0.012 * Math.min(80, charLen) * classifierFeatureGain.neutralContext;
        classifierLogits.neutral += 0.16 * Math.min(6, comma) * classifierFeatureGain.neutralContext;
        classifierLogits.neutral += 0.08 * (charLen > 48 ? 1 : 0) * classifierFeatureGain.neutralContext;
        classifierLogits.joy += 0.95 * kwCountByEmotion.joy * classifierFeatureGain.keyword;
        classifierLogits.joy += 0.45 * exclam * classifierFeatureGain.punctuation;
        classifierLogits.joy += (hasLaugh ? 0.55 : 0) * classifierFeatureGain.laughter;
        classifierLogits.sadness += 0.95 * kwCountByEmotion.sadness * classifierFeatureGain.keyword;
        classifierLogits.sadness += 0.32 * ellipsis * classifierFeatureGain.punctuation;
        classifierLogits.sadness += (hasNegation ? 0.30 : 0) * classifierFeatureGain.negation;
        classifierLogits.anger += 1.02 * kwCountByEmotion.anger * classifierFeatureGain.keyword;
        classifierLogits.anger += 0.62 * exclam * classifierFeatureGain.punctuation;
        classifierLogits.anger += (hasStrongAssertive ? 0.35 : 0) * classifierFeatureGain.assertive;
        classifierLogits.fear += 1.0 * kwCountByEmotion.fear * classifierFeatureGain.keyword;
        classifierLogits.fear += 0.54 * quest * classifierFeatureGain.punctuation;
        classifierLogits.fear += 0.28 * ellipsis * classifierFeatureGain.punctuation;
        classifierLogits.fear += (hasUncertain ? 0.35 : 0) * classifierFeatureGain.uncertainty;

        const logitsMax = Math.max(...Object.values(classifierLogits));
        const temperature = clamp(activeActingProfile.classifierTemperature, 0.35, 3.0);
        const expMap = (Object.entries(classifierLogits) as [AutoEmotion, number][])
            .map(([emotion, logit]) => [emotion, Math.exp((logit - logitsMax) / temperature)] as const);
        const expSum = expMap.reduce((acc, [, v]) => acc + v, 0) + 1e-9;
        const classifierScores: Record<AutoEmotion, number> = {
            neutral: 0,
            joy: 0,
            sadness: 0,
            anger: 0,
            fear: 0,
        };
        for (const [emotion, v] of expMap) {
            classifierScores[emotion] = v / expSum;
        }

        const analyzerMode = sbv2AutoEmotionAnalyzerMode;
        const blend = clamp(sbv2AutoEmotionClassifierBlend, 0, 1);
        const scores: Record<AutoEmotion, number> = {
            neutral: 0,
            joy: 0,
            sadness: 0,
            anger: 0,
            fear: 0,
        };
        for (const emotion of ['neutral', 'joy', 'sadness', 'anger', 'fear'] as AutoEmotion[]) {
            if (analyzerMode === 'rule') {
                scores[emotion] = ruleScores[emotion];
            } else if (analyzerMode === 'classifier') {
                scores[emotion] = classifierScores[emotion];
            } else {
                // Hybrid: rule (deterministic cues) + classifier (smooth probabilities).
                scores[emotion] = ruleScores[emotion] * (1 - blend)
                    + classifierScores[emotion] * blend * activeActingProfile.hybridClassifierScale;
            }
        }

        const entries = (Object.entries(scores) as [AutoEmotion, number][])
            .sort((a, b) => b[1] - a[1]);
        const top = entries[0];
        const second = entries[1];
        const total = entries.reduce((acc, [, v]) => acc + Math.max(0, v), 0) + 1e-6;
        const confidence = clamp((top[1] - second[1]) / total * 1.6 + 0.5, 0, 1);
        const punctuationDrive = clamp((exclam + quest + ellipsis + comma * 0.2) / 6, 0, 1);
        const intensity = clamp((top[1] / (top[1] + 1.0)) * 0.75 + punctuationDrive * 0.25, 0, 1);

        return {
            emotion: top[0],
            confidence,
            intensity,
            scoreByEmotion: scores,
            reason: `${analyzerMode}:${reasons.join(',') || 'baseline'}`
                + `; blend=${blend.toFixed(2)}; temp=${temperature.toFixed(2)}; top=${top[0]}`,
        };
    };

    const resolvePauseMsForSegment = (segment: string, emotion: AutoEmotion, intensity: number): number => {
        const trimmed = segment.trim();
        const last = trimmed[trimmed.length - 1] || '';
        const pauseConfig = activeActingProfile.pauseMsByPunct;

        let base = pauseConfig.default;
        if (last === '、' || last === ',') base = pauseConfig.comma;
        else if (last === '。') base = pauseConfig.period;
        else if (last === '！' || last === '!') base = pauseConfig.exclamation;
        else if (last === '？' || last === '?') base = pauseConfig.question;
        else if (last === '…') base = pauseConfig.ellipsis;

        if (ACTING_PAUSE_MS_BY_PUNCT[last] !== undefined) {
            const compat = ACTING_PAUSE_MS_BY_PUNCT[last];
            base = Math.max(base, compat * 0.75);
        }
        if (trimmed.includes('…') || /\.\.\./.test(trimmed)) {
            base = Math.max(base, pauseConfig.ellipsis);
        }
        if (/\n/.test(segment)) {
            base = Math.max(base, pauseConfig.newline);
        }

        const factor = activeActingProfile.pauseEmotionMultiplier[emotion] ?? 1.0;
        const dynamic = 0.90 + intensity * 0.24;
        return Math.round(clamp(base * factor * dynamic, 60, 560));
    };

    const chooseAutoEmotionStyle = (
        emotion: AutoEmotion,
        confidence: number,
        intensity: number,
        availableStyles: string[],
        fallbackStyle: string,
        applyMode: AutoEmotionApplyMode,
        aggressiveStyleSwitch: boolean,
    ): string => {
        const preferredBase = activeActingProfile.baselineStyle || fallbackStyle || 'Neutral';
        if (applyMode === 'fixed_style') {
            if (availableStyles.includes(preferredBase)) return preferredBase;
            return availableStyles[0] || preferredBase || 'Neutral';
        }

        // Showpiece-only style switching for stability.
        const isShowcase = aggressiveStyleSwitch
            ? (confidence >= 0.52 || intensity >= 0.42)
            : (confidence >= 0.72 && intensity >= 0.58);
        if (!isShowcase) {
            if (availableStyles.includes(preferredBase)) return preferredBase;
            return availableStyles[0] || preferredBase || 'Neutral';
        }

        const mapped = activeActingProfile.styleMap[emotion] || AUTO_EMOTION_STYLE_MAP[emotion];
        if (availableStyles.includes(mapped)) return mapped;
        const hinted = findEmotionStyleByHints(emotion, availableStyles);
        if (hinted) return hinted;
        if (availableStyles.includes(preferredBase)) return preferredBase;
        return availableStyles[0] || preferredBase || 'Neutral';
    };

    const buildDirectionalAssistText = (
        baseAssistText: string,
        autoEmotion?: AutoEmotion,
        override?: AssistDirectionOverride,
    ): string => {
        const manual = (baseAssistText || '').trim();
        const preset = override?.preset ?? assistDirectionPreset;
        const strength = clamp(override?.strength ?? assistDirectionStrength, 0, 1);
        if (preset === 'none') {
            return manual;
        }
        const def = ASSIST_DIRECTION_PROMPTS[preset];
        const band = getAssistDirectionStrengthBand(strength);
        const withReinforce = band.label === 'strong' || strength >= 0.58;
        const conflict = autoEmotion && autoEmotion !== def.mappedEmotion && autoEmotion !== 'neutral'
            ? `補助として${AUTO_EMOTION_EMOJI[autoEmotion]}の要素を弱く残す。`
            : '';
        const directionText = [
            `${band.text}。`,
            def.primary,
            withReinforce ? def.reinforce : '',
            conflict,
        ]
            .filter(Boolean)
            .join('');
        return manual ? `${directionText}${manual}` : directionText;
    };

    const resolveAssistParams = (
        baseAssistText: string,
        baseAssistTextWeight: number,
        autoEmotion?: AutoEmotion,
        override?: AssistDirectionOverride,
    ): {
        resolvedAssistText: string;
        resolvedAssistTextWeight: number;
        forcedEmotion: AutoEmotion | null;
        conflict: boolean;
        reason: string;
    } => {
        const safeBaseWeight = clamp(baseAssistTextWeight, 0, 2);
        const preset = override?.preset ?? assistDirectionPreset;
        const strength = clamp(override?.strength ?? assistDirectionStrength, 0, 1);
        if (preset === 'none') {
            return {
                resolvedAssistText: (baseAssistText || '').trim(),
                resolvedAssistTextWeight: safeBaseWeight,
                forcedEmotion: null,
                conflict: false,
                reason: 'direction=none',
            };
        }
        const def = ASSIST_DIRECTION_PROMPTS[preset];
        const band = getAssistDirectionStrengthBand(strength);
        const conflict = !!autoEmotion && autoEmotion !== def.mappedEmotion;
        const conflictPenalty = def.mappedEmotion === 'neutral' && conflict ? 0.75 : 1.0;
        const delta = (0.12 + 0.88 * strength) * band.gain * conflictPenalty;
        const resolvedAssistTextWeight = clamp(safeBaseWeight + delta, 0, 2);
        return {
            resolvedAssistText: buildDirectionalAssistText(baseAssistText, autoEmotion, override),
            resolvedAssistTextWeight,
            forcedEmotion: def.mappedEmotion,
            conflict,
            reason: `direction=${preset}; strength=${strength.toFixed(2)}; band=${band.label}; delta=${delta.toFixed(2)}`,
        };
    };

    const buildEmotionAssistText = (
        emotion: AutoEmotion,
        intensity: number,
        jpExtraBoostActive: boolean,
        boostLevel: number,
        baseAssistText: string,
    ): string => {
        const baseAssist = (baseAssistText || '').trim();
        if (!jpExtraBoostActive) {
            return baseAssist;
        }
        const emotionPromptMap: Record<AutoEmotion, string> = {
            neutral: '自然で聞き取りやすい口調で話す',
            joy: '明るく前向きで、笑顔が伝わるような口調で話す',
            sadness: '少し落ち着き、切なさをにじませる口調で話す',
            anger: '語気をやや強めて、キレを保った口調で話す',
            fear: '不安げで慎重な、少し迷いのある口調で話す',
        };
        const strength = clamp(boostLevel * 0.5 + intensity * 0.5, 0, 1);
        const strengthPrompt = strength >= 0.72
            ? '感情ははっきり強めに'
            : strength >= 0.45
                ? '感情を自然に込めて'
                : '感情は控えめに';
        const jpPrompt = `${strengthPrompt}。${emotionPromptMap[emotion]}。`;
        return baseAssist ? `${jpPrompt}${baseAssist}` : jpPrompt;
    };

    const buildAssistDirectionOptimization = (
        sourceText: string,
    ): AssistDirectionOptimizationResult => {
        const textBody = (sourceText || '').trim();
        const fallback: AssistDirectionOptimizationResult = {
            enabled: false,
            isLongForm: false,
            preset: assistDirectionPreset,
            strength: assistDirectionStrength,
            dominantEmotion: 'neutral',
            averageIntensity: 0,
            segmentCount: 0,
            charCount: textBody.length,
            reason: 'auto-optimize disabled or short text',
        };
        if (!assistDirectionAutoOptimize) {
            return fallback;
        }
        if (!textBody) {
            return {
                ...fallback,
                enabled: true,
                reason: 'auto-optimize enabled but empty text',
            };
        }

        const segments = splitTextForAutoEmotion(textBody);
        const isLongForm = textBody.length >= 120 || segments.length >= 3;
        if (!isLongForm) {
            return {
                ...fallback,
                enabled: true,
                reason: `auto-optimize enabled but short text (chars=${textBody.length}, segments=${segments.length})`,
                segmentCount: segments.length,
            };
        }

        const analyses = segments.map((seg) => analyzeAutoEmotionSegment(seg));
        const aggScores: Record<AutoEmotion, number> = {
            neutral: 0,
            joy: 0,
            sadness: 0,
            anger: 0,
            fear: 0,
        };
        let intensitySum = 0;
        for (const a of analyses) {
            intensitySum += a.intensity;
            for (const emotionKey of ['neutral', 'joy', 'sadness', 'anger', 'fear'] as AutoEmotion[]) {
                aggScores[emotionKey] += a.scoreByEmotion[emotionKey] || 0;
            }
        }
        const dominantEmotion = (Object.entries(aggScores) as [AutoEmotion, number][])
            .sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
        const averageIntensity = analyses.length > 0
            ? clamp(intensitySum / analyses.length, 0, 1)
            : 0;

        const punctuationDrive = clamp(
            ((textBody.match(/[!?！？]/g)?.length || 0)
                + (textBody.match(/…|\.\.\./g)?.length || 0) * 0.7) / Math.max(2, segments.length * 2),
            0,
            1,
        );
        const globalPreset = assistDirectionPreset === 'none'
            ? mapEmotionToDirectionPreset(dominantEmotion)
            : assistDirectionPreset;
        const baseStrength = assistDirectionPreset === 'none'
            ? clamp(0.26 + averageIntensity * 0.42 + punctuationDrive * 0.22 + Math.min(0.14, segments.length * 0.02), 0.20, 0.95)
            : clamp(assistDirectionStrength * 0.72 + (0.24 + averageIntensity * 0.34 + punctuationDrive * 0.20) * 0.28, 0, 1);

        return {
            enabled: true,
            isLongForm: true,
            preset: globalPreset,
            strength: baseStrength,
            dominantEmotion,
            averageIntensity,
            segmentCount: segments.length,
            charCount: textBody.length,
            reason: `long-text context preset=${globalPreset}, dominant=${dominantEmotion}, avgInt=${averageIntensity.toFixed(2)}, punct=${punctuationDrive.toFixed(2)}`,
        };
    };

    const mapAutoEmotionToParams = (
        segment: string,
        analysis: AutoEmotionAnalysis,
        segmentIndex: number,
        segmentCount: number,
        availableStyles: string[],
        directionOptimization?: AssistDirectionOptimizationResult,
    ): { resolvedEmotion: AutoEmotion; params: AutoEmotionSynthesisParams; reason: string } => {
        const jpExtraBoostActive = sbv2JpExtraEmotionBoost && selectedTtsLikelyJpExtra;
        const boostLevel = clamp(sbv2JpExtraBoostLevel, 0, 1);
        let emotion = analysis.emotion;
        let confidence = analysis.confidence;
        let intensity = analysis.intensity;
        let conflictClampApplied = false;

        if (sbv2AutoEmotionOverride !== 'auto') {
            emotion = sbv2AutoEmotionOverride;
            confidence = 1.0;
            intensity = Math.max(intensity, 0.65);
        } else {
            const effectiveThreshold = clamp(
                sbv2AutoEmotionThreshold - (jpExtraBoostActive ? 0.10 * boostLevel : 0),
                0.35,
                0.90,
            );
            if (confidence < effectiveThreshold) {
                emotion = 'neutral';
                intensity = Math.min(intensity, 0.35);
            }
        }

        let directionOverride: AssistDirectionOverride | undefined;
        if (directionOptimization?.enabled && directionOptimization.isLongForm) {
            const progress = segmentCount <= 1 ? 0.5 : clamp(segmentIndex / (segmentCount - 1), 0, 1);
            const localPreset = mapEmotionToDirectionPreset(analysis.emotion);
            const useManualPreset = assistDirectionPreset !== 'none';
            const basePreset = useManualPreset
                ? assistDirectionPreset
                : (analysis.confidence >= 0.58 ? localPreset : directionOptimization.preset);
            const localStrength = clamp(0.24 + analysis.intensity * 0.52 + analysis.confidence * 0.24, 0, 1);
            const mergedStrength = clamp(directionOptimization.strength * 0.62 + localStrength * 0.38, 0, 1);
            const arcGain = basePreset === 'calm'
                ? (1.06 - progress * 0.16)
                : (0.90 + progress * 0.24);
            directionOverride = {
                preset: basePreset,
                strength: clamp(mergedStrength * arcGain, 0, 1),
            };
        }

        const directionAssist = resolveAssistParams(assistText, assistTextWeight, emotion, directionOverride);
        const emotionBeforeDirection = emotion;
        if (sbv2AutoEmotionOverride === 'auto' && directionAssist.forcedEmotion) {
            emotion = directionAssist.forcedEmotion;
            if (emotion !== emotionBeforeDirection) {
                if (emotion === 'neutral') {
                    // calm/neutral direction wins: keep prosody moderate to avoid overacting.
                    const effectiveStrength = clamp(directionOverride?.strength ?? assistDirectionStrength, 0, 1);
                    const cap = clamp(0.48 + effectiveStrength * 0.22, 0.48, 0.70);
                    intensity = Math.min(intensity, cap);
                    conflictClampApplied = true;
                } else {
                    // explicit direction wins: keep some auto emotion influence as support.
                    const effectiveStrength = clamp(directionOverride?.strength ?? assistDirectionStrength, 0, 1);
                    intensity = clamp(intensity * 0.62 + effectiveStrength * 0.55, 0, 1);
                }
                confidence = Math.max(
                    confidence,
                    0.58 + clamp(directionOverride?.strength ?? assistDirectionStrength, 0, 1) * 0.22,
                );
            }
        }

        if (jpExtraBoostActive && emotion !== 'neutral') {
            confidence = clamp(confidence + 0.08 * boostLevel, 0, 1);
            intensity = clamp(intensity + 0.12 * boostLevel, 0, 1);
        }

        const gainPreset = AUTO_EMOTION_STRENGTH_GAIN[sbv2AutoEmotionStrength];
        const emotionGain = activeActingProfile.emotionGain[emotion] ?? 1.0;
        const boostGain = jpExtraBoostActive ? (1 + 0.28 * boostLevel) : 1.0;
        const scaled = clamp(intensity * gainPreset * emotionGain * boostGain, 0, 1);
        const d = activeActingProfile.prosodyDeltaByEmotion[emotion]
            || activeActingProfile.prosodyDeltaByEmotion.neutral;
        const curve = activeActingProfile.intensityCurveByEmotion[emotion]
            || activeActingProfile.intensityCurveByEmotion.neutral;
        const progress = segmentCount <= 1 ? 0.5 : clamp(segmentIndex / (segmentCount - 1), 0, 1);
        const curveFactor = curve.start + (curve.end - curve.start) * progress;
        const acted = clamp(scaled * curveFactor, 0, jpExtraBoostActive ? 1.45 : 1.25);

        const style = chooseAutoEmotionStyle(
            emotion,
            confidence,
            acted,
            availableStyles,
            selectedStyle,
            sbv2AutoEmotionApplyMode,
            jpExtraBoostActive
                || assistDirectionPreset !== 'none'
                || ((directionOverride?.preset ?? 'none') !== 'none'),
        );
        const jpStyleWeightBoost = jpExtraBoostActive && emotion !== 'neutral'
            ? 0.22 * boostLevel
            : 0;
        const baseAssistWeight = clamp(directionAssist.resolvedAssistTextWeight, 0.0, 2.0);
        const boostedAssistWeight = jpExtraBoostActive && emotion !== 'neutral'
            ? clamp(baseAssistWeight + 0.45 * boostLevel * acted, 0.0, 2.0)
            : baseAssistWeight;
        const mappedAssistText = buildEmotionAssistText(
            emotion,
            acted,
            jpExtraBoostActive,
            boostLevel,
            directionAssist.resolvedAssistText,
        );

        const params: AutoEmotionSynthesisParams = {
            style,
            speed: clamp(speed + d.speed * acted, activeActingProfile.prosodyLimits.speed[0], activeActingProfile.prosodyLimits.speed[1]),
            // Pitch is intentionally conservative in Acting Engine v1.
            pitch: clamp(pitch + d.pitch * acted, activeActingProfile.prosodyLimits.pitch[0], activeActingProfile.prosodyLimits.pitch[1]),
            intonation: clamp(intonation + d.intonation * acted, activeActingProfile.prosodyLimits.intonation[0], activeActingProfile.prosodyLimits.intonation[1]),
            styleWeight: clamp(styleWeight + d.styleWeight * acted + jpStyleWeightBoost, activeActingProfile.prosodyLimits.styleWeight[0], activeActingProfile.prosodyLimits.styleWeight[1]),
            assistTextWeight: boostedAssistWeight,
            pauseMs: resolvePauseMsForSegment(segment, emotion, acted),
            curveFactor,
            assistText: mappedAssistText,
            jpExtraBoostApplied: jpExtraBoostActive,
        };
        return {
            resolvedEmotion: emotion,
            params,
            reason: `${analysis.reason}; dir=${directionAssist.reason}; conf=${confidence.toFixed(2)}; int=${acted.toFixed(2)}; curve=${curveFactor.toFixed(2)}; conflictClamp=${conflictClampApplied ? 'on' : 'off'}; jpExtraBoost=${jpExtraBoostActive ? boostLevel.toFixed(2) : 'off'}`,
        };
    };

    const decodeSbv2SynthesisToSegment = async (
        res: any,
        decodeContext: AudioContext,
        pauseMs: number,
    ): Promise<{ segment: AutoEmotionAudioSegment; wavPath: string | null; audioBase64: string }> => {
        let base64: string | undefined = res.audioBase64;
        if (!base64 && res.wavPath) {
            const audioData = await window.electronAPI.readAudioFile(res.wavPath);
            if (audioData?.success && audioData.base64) {
                base64 = audioData.base64;
            }
        }
        if (!base64) {
            throw new Error('Failed to decode SBV2 segment audio.');
        }

        const decoded = await decodeContext.decodeAudioData(base64ToArrayBuffer(base64).slice(0));
        const ch = Math.max(1, decoded.numberOfChannels);
        const mono = new Float32Array(decoded.length);
        for (let c = 0; c < ch; c++) {
            const channel = decoded.getChannelData(c);
            for (let i = 0; i < decoded.length; i++) {
                mono[i] += channel[i] / ch;
            }
        }

        return {
            segment: {
                samples: mono,
                sampleRate: decoded.sampleRate,
                pauseMs,
            },
            wavPath: res.wavPath || null,
            audioBase64: base64,
        };
    };

    const resampleMonoFloat = (input: Float32Array, srcRate: number, dstRate: number): Float32Array => {
        if (srcRate === dstRate || input.length === 0) return input;
        const outLen = Math.max(1, Math.round(input.length * dstRate / srcRate));
        const out = new Float32Array(outLen);
        const ratio = srcRate / dstRate;
        for (let i = 0; i < outLen; i++) {
            const pos = i * ratio;
            const i0 = Math.floor(pos);
            const i1 = Math.min(input.length - 1, i0 + 1);
            const frac = pos - i0;
            out[i] = input[i0] * (1 - frac) + input[i1] * frac;
        }
        return out;
    };

    const joinAutoEmotionSegments = (
        segments: AutoEmotionAudioSegment[],
        crossfadeMs: number = 20,
    ): { audioBase64: string; sampleRate: number; durationMs: number } => {
        if (segments.length === 0) {
            return {
                audioBase64: pcm16ToWavBase64([], 16000, 1),
                sampleRate: 16000,
                durationMs: 0,
            };
        }

        const outputSr = segments[0].sampleRate;
        const merged: number[] = [];

        for (let s = 0; s < segments.length; s++) {
            const seg = segments[s];
            const mono = seg.sampleRate === outputSr ? seg.samples : resampleMonoFloat(seg.samples, seg.sampleRate, outputSr);
            const crossfadeSamples = Math.min(
                Math.floor(outputSr * crossfadeMs / 1000),
                merged.length,
                mono.length,
            );

            if (merged.length === 0) {
                for (let i = 0; i < mono.length; i++) merged.push(mono[i]);
            } else if (crossfadeSamples > 0) {
                const start = merged.length - crossfadeSamples;
                for (let i = 0; i < crossfadeSamples; i++) {
                    const t = (i + 1) / crossfadeSamples;
                    merged[start + i] = merged[start + i] * (1 - t) + mono[i] * t;
                }
                for (let i = crossfadeSamples; i < mono.length; i++) merged.push(mono[i]);
            } else {
                for (let i = 0; i < mono.length; i++) merged.push(mono[i]);
            }

            if (s < segments.length - 1) {
                const pauseSamples = Math.max(0, Math.floor(seg.pauseMs * outputSr / 1000));
                for (let i = 0; i < pauseSamples; i++) merged.push(0);
            }
        }

        // Peak normalization with conservative boost cap.
        let peak = 0;
        for (let i = 0; i < merged.length; i++) {
            const av = Math.abs(merged[i]);
            if (av > peak) peak = av;
        }
        if (peak > 1e-6) {
            const norm = Math.min(1.45, 0.95 / peak);
            for (let i = 0; i < merged.length; i++) {
                merged[i] = clamp(merged[i] * norm, -1, 1);
            }
        }

        const pcm16: number[] = new Array<number>(merged.length);
        for (let i = 0; i < merged.length; i++) {
            const v = clamp(merged[i], -1, 1);
            pcm16[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
        }
        const audioBase64 = pcm16ToWavBase64(pcm16, outputSr, 1);
        const durationMs = Math.round(pcm16.length / outputSr * 1000);
        return { audioBase64, sampleRate: outputSr, durationMs };
    };

    const applyActingDsp = async (
        audioBase64: string,
    ): Promise<{ audioBase64: string; sampleRate: number; durationMs: number } | null> => {
        if (!audioBase64) return null;

        const decodeContext = new AudioContext();
        let decoded: AudioBuffer;
        try {
            decoded = await decodeContext.decodeAudioData(base64ToArrayBuffer(audioBase64).slice(0));
        } finally {
            try {
                await decodeContext.close();
            } catch {
                // ignore
            }
        }

        const mono = new Float32Array(decoded.length);
        const channels = Math.max(1, decoded.numberOfChannels);
        for (let ch = 0; ch < channels; ch++) {
            const data = decoded.getChannelData(ch);
            for (let i = 0; i < decoded.length; i++) {
                mono[i] += data[i] / channels;
            }
        }

        const offline = new OfflineAudioContext(1, mono.length, decoded.sampleRate);
        const srcBuffer = offline.createBuffer(1, mono.length, decoded.sampleRate);
        srcBuffer.getChannelData(0).set(mono);
        const source = offline.createBufferSource();
        source.buffer = srcBuffer;

        // EQ: low-cut rumble + presence lift.
        const highpass = offline.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 80;
        highpass.Q.value = 0.707;

        const presence = offline.createBiquadFilter();
        presence.type = 'peaking';
        presence.frequency.value = 3200;
        presence.Q.value = 0.7;
        presence.gain.value = 1.8;

        // De-esser (band split): compress upper band only.
        const lowBand = offline.createBiquadFilter();
        lowBand.type = 'lowpass';
        lowBand.frequency.value = 4300;
        lowBand.Q.value = 0.707;

        const highBand = offline.createBiquadFilter();
        highBand.type = 'highpass';
        highBand.frequency.value = 4300;
        highBand.Q.value = 0.707;

        const deEsser = offline.createDynamicsCompressor();
        deEsser.threshold.value = -36;
        deEsser.knee.value = 0;
        deEsser.ratio.value = 8;
        deEsser.attack.value = 0.001;
        deEsser.release.value = 0.08;

        const highBandGain = offline.createGain();
        highBandGain.gain.value = 0.82;

        const sum = offline.createGain();
        sum.gain.value = 1.0;

        // Body compressor.
        const compressor = offline.createDynamicsCompressor();
        compressor.threshold.value = -21;
        compressor.knee.value = 12;
        compressor.ratio.value = 3;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.18;

        // Limiter.
        const limiter = offline.createDynamicsCompressor();
        limiter.threshold.value = -4;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.001;
        limiter.release.value = 0.06;

        source.connect(highpass);
        highpass.connect(presence);
        presence.connect(lowBand);
        presence.connect(highBand);
        lowBand.connect(sum);
        highBand.connect(deEsser);
        deEsser.connect(highBandGain);
        highBandGain.connect(sum);
        sum.connect(compressor);
        compressor.connect(limiter);
        limiter.connect(offline.destination);
        source.start(0);

        const rendered = await offline.startRendering();
        const out = rendered.getChannelData(0);

        let peak = 0;
        for (let i = 0; i < out.length; i++) {
            const av = Math.abs(out[i]);
            if (av > peak) peak = av;
        }
        const outScale = peak > 1e-6 ? Math.min(1, 0.92 / peak) : 1;
        const pcm16 = new Array<number>(out.length);
        for (let i = 0; i < out.length; i++) {
            const s = clamp(out[i] * outScale, -1, 1);
            pcm16[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        }

        return {
            audioBase64: pcm16ToWavBase64(pcm16, rendered.sampleRate, 1),
            sampleRate: rendered.sampleRate,
            durationMs: Math.round((pcm16.length / rendered.sampleRate) * 1000),
        };
    };

    const synthesizeSbv2WithAutoEmotion = async (sourceText: string = text): Promise<{
        audioBase64: string;
        mergedAudioBase64: string;
        sampleRate: number;
        durationMs: number;
        wavPath: string | null;
        traces: AutoEmotionSegmentTrace[];
        rawSegments: { index: number; audioBase64: string }[];
    } | null> => {
        const segments = splitTextForAutoEmotion(sourceText);
        if (segments.length === 0) {
            addLog('Auto Emotion: no text to synthesize.');
            return null;
        }
        const directionOptimization = buildAssistDirectionOptimization(sourceText);
        if (directionOptimization.enabled && directionOptimization.isLongForm) {
            addLog(
                `Direction auto-optimize: preset=${directionOptimization.preset}, `
                + `strength=${directionOptimization.strength.toFixed(2)}, `
                + `segments=${directionOptimization.segmentCount}, chars=${directionOptimization.charCount}`,
            );
        }

        const availableStyles = ttsModels.find((m) => m.id === selectedTtsModel)?.styles || [];
        const decodeContext = new AudioContext();
        const audioSegments: AutoEmotionAudioSegment[] = [];
        const traces: AutoEmotionSegmentTrace[] = [];
        const rawSegments: { index: number; audioBase64: string }[] = [];
        const debugRows: string[] = [];
        let firstWavPath: string | null = null;

        try {
            for (let i = 0; i < segments.length; i++) {
                const segmentText = segments[i];
                const analysis = analyzeAutoEmotionSegment(segmentText);
                const mapped = mapAutoEmotionToParams(
                    segmentText,
                    analysis,
                    i,
                    segments.length,
                    availableStyles,
                    directionOptimization,
                );

                setSbv2AutoEmotionDetected({
                    emotion: mapped.resolvedEmotion,
                    confidence: analysis.confidence,
                    intensity: analysis.intensity,
                    segmentIndex: i + 1,
                    segmentCount: segments.length,
                });

                const row = `${i + 1}/${segments.length} ${AUTO_EMOTION_EMOJI[mapped.resolvedEmotion]} `
                    + `conf=${analysis.confidence.toFixed(2)} int=${analysis.intensity.toFixed(2)} `
                    + `style=${mapped.params.style} spd=${mapped.params.speed.toFixed(2)} `
                    + `pit=${mapped.params.pitch.toFixed(2)} inton=${mapped.params.intonation.toFixed(2)} `
                    + `aw=${mapped.params.assistTextWeight.toFixed(2)} `
                    + `pause=${mapped.params.pauseMs}ms curve=${mapped.params.curveFactor.toFixed(2)} `
                    + `${mapped.params.jpExtraBoostApplied ? '[JPX]' : ''} (${mapped.reason})`;
                debugRows.push(row);
                addLog(`AutoEmotion ${row}`);

                const res = await window.electronAPI.ttsSynthesize({
                    text: segmentText,
                    modelId: selectedTtsModel,
                    style: mapped.params.style,
                    speed: mapped.params.speed,
                    pitch: mapped.params.pitch,
                    intonation: mapped.params.intonation,
                    styleWeight: mapped.params.styleWeight,
                    sdpRatio,
                    noiseScale,
                    noiseScaleW,
                    assistText: mapped.params.assistText,
                    assistTextWeight: mapped.params.assistTextWeight,
                });

                if (!res.success) {
                    addLog(`SBV2 auto emotion failed on segment ${i + 1}: ${res.error?.message || 'Unknown error'}`);
                    return null;
                }

                const decoded = await decodeSbv2SynthesisToSegment(res, decodeContext, mapped.params.pauseMs);
                if (segments.length === 1) {
                    firstWavPath = decoded.wavPath;
                }
                rawSegments.push({
                    index: i,
                    audioBase64: decoded.audioBase64,
                });
                audioSegments.push(decoded.segment);
                traces.push({
                    index: i,
                    text: segmentText,
                    emotion: mapped.resolvedEmotion,
                    confidence: analysis.confidence,
                    intensity: analysis.intensity,
                    style: mapped.params.style,
                    speed: mapped.params.speed,
                    pitch: mapped.params.pitch,
                    intonation: mapped.params.intonation,
                    styleWeight: mapped.params.styleWeight,
                    pauseMs: mapped.params.pauseMs,
                    curveFactor: mapped.params.curveFactor,
                    reason: mapped.reason,
                });
            }
        } finally {
            try {
                await decodeContext.close();
            } catch {
                // ignore
            }
        }

        setSbv2AutoEmotionDebugRows(debugRows.slice(-12));
        const merged = joinAutoEmotionSegments(audioSegments, activeActingProfile.crossfadeMs || 20);
        let finalAudio = merged;
        if (sbv2ActingDspEnabled) {
            const dsp = await applyActingDsp(merged.audioBase64);
            if (dsp) {
                finalAudio = dsp;
                addLog(`Acting DSP applied. duration=${(dsp.durationMs / 1000).toFixed(2)}s sr=${dsp.sampleRate}`);
            }
        }
        return {
            audioBase64: finalAudio.audioBase64,
            mergedAudioBase64: merged.audioBase64,
            sampleRate: finalAudio.sampleRate,
            durationMs: finalAudio.durationMs,
            wavPath: segments.length === 1 ? firstWavPath : null,
            traces,
            rawSegments,
        };
    };

    const handleSynthesize = async (
        sourceTextOverride?: string,
        options?: { forceAutoEmotion?: boolean; autoPlayAfterSynthesize?: boolean; waitForPlaybackEnd?: boolean },
    ): Promise<boolean> => {
        const sourceText = sourceTextOverride ?? text;
        const directionOptimization = buildAssistDirectionOptimization(sourceText);
        const resolvedAssistGlobal = resolveAssistParams(
            assistText,
            assistTextWeight,
            undefined,
            directionOptimization.enabled && directionOptimization.isLongForm
                ? { preset: directionOptimization.preset, strength: directionOptimization.strength }
                : undefined,
        );
        const effectiveAutoEmotion = mode === 'sbv2'
            ? (options?.forceAutoEmotion ? true : sbv2AutoEmotionEnabled)
            : sbv2AutoEmotionEnabled;
        const shouldAutoPlay = !!options?.autoPlayAfterSynthesize;
        let producedFinalAudio = false;
        outputAudioAutoPlayPendingRef.current = shouldAutoPlay;
        setIsRunningAction(true);
        setAudioUrl(null);
        setIntermediateAudioUrl(null);

        const maybeWaitForPlaybackEnd = async (): Promise<boolean> => {
            if (!producedFinalAudio || !shouldAutoPlay || !options?.waitForPlaybackEnd) {
                return true;
            }
            const ended = await waitForOutputPlaybackEnd(90000);
            if (!ended) {
                addLog('Playback wait timed out in preview sequence.');
                return false;
            }
            return true;
        };

        if (mode !== 'rvc') {
            addLog(
                `Assist resolved: preset=${assistDirectionPreset}, strength=${assistDirectionStrength.toFixed(2)}, `
                + `weight=${resolvedAssistGlobal.resolvedAssistTextWeight.toFixed(2)}, reason=${resolvedAssistGlobal.reason}`,
            );
            if (directionOptimization.enabled) {
                addLog(`Assist auto-optimize status: ${directionOptimization.reason}`);
            }
        }

        try {
            if (mode === 'sbv2') {
                if (effectiveAutoEmotion) {
                    const autoRes = await synthesizeSbv2WithAutoEmotion(sourceText);
                    if (!autoRes) {
                        return false;
                    }
                    setLastSbv2WavPath(autoRes.wavPath);
                    setAudioUrl(`data:audio/wav;base64,${autoRes.audioBase64}`);
                    producedFinalAudio = true;
                    addLog(`SBV2 auto-emotion synthesis complete. segments=${splitTextForAutoEmotion(sourceText).length} duration=${(autoRes.durationMs / 1000).toFixed(2)}s`);
                    if (!autoRes.wavPath) {
                        addLog('Auto Emotion output is merged in renderer; "Use SBV2" for RVC input is unavailable for multi-segment output.');
                    }

                    if (sbv2ActingAutoSaveOutput) {
                        try {
                            const saveRes = await window.electronAPI.invoke('tts-save-acting-bundle', {
                                projectName: 'Voice Studio Acting Engine v1',
                                inputText: sourceText,
                                segments: autoRes.traces,
                                params: {
                                    modelId: selectedTtsModel,
                                    baseStyle: selectedStyle,
                                    actingProfileId: activeActingProfile.id,
                                    actingProfileName: activeActingProfile.name,
                                    speed,
                                    pitch,
                                    intonation,
                                    styleWeight,
                                    sdpRatio,
                                    noiseScale,
                                    noiseScaleW,
                                    assistText,
                                    assistTextWeight,
                                    assistDirectionPreset,
                                    assistDirectionStrength,
                                    assistDirectionAutoOptimize,
                                    resolvedAssistText: resolvedAssistGlobal.resolvedAssistText,
                                    resolvedAssistTextWeight: resolvedAssistGlobal.resolvedAssistTextWeight,
                                    autoEmotion: {
                                        enabled: effectiveAutoEmotion,
                                        strength: sbv2AutoEmotionStrength,
                                        applyMode: sbv2AutoEmotionApplyMode,
                                        analyzerMode: sbv2AutoEmotionAnalyzerMode,
                                        classifierBlend: sbv2AutoEmotionClassifierBlend,
                                        classifierTemperature: activeActingProfile.classifierTemperature,
                                        hybridClassifierScale: activeActingProfile.hybridClassifierScale,
                                        classifierFeatureGain: activeActingProfile.classifierFeatureGain,
                                        classifierEmotionBias: activeActingProfile.classifierEmotionBias,
                                        override: sbv2AutoEmotionOverride,
                                        threshold: sbv2AutoEmotionThreshold,
                                        dspEnabled: sbv2ActingDspEnabled,
                                        jpExtraBoostEnabled: sbv2JpExtraEmotionBoost,
                                        jpExtraBoostLevel: sbv2JpExtraBoostLevel,
                                    },
                                },
                                rawSegments: autoRes.rawSegments,
                                mergedAudioBase64: autoRes.mergedAudioBase64,
                                finalAudioBase64: autoRes.audioBase64,
                            });
                            if (saveRes?.success && saveRes.outputDir) {
                                setSbv2ActingLastOutputDir(saveRes.outputDir);
                                addLog(`Acting bundle saved: ${saveRes.outputDir}`);
                            } else if (!saveRes?.success) {
                                addLog(`Acting bundle save failed: ${saveRes?.error || 'Unknown error'}`);
                            }
                        } catch (saveError) {
                            addLog(`Acting bundle save error: ${String(saveError)}`);
                        }
                    }
                    return await maybeWaitForPlaybackEnd();
                }

                const res = await window.electronAPI.ttsSynthesize({
                    text: sourceText,
                    modelId: selectedTtsModel,
                    style: selectedStyle,
                    speed,
                    pitch,
                    intonation,
                    styleWeight,
                    sdpRatio,
                    noiseScale,
                    noiseScaleW,
                    assistText: resolvedAssistGlobal.resolvedAssistText,
                    assistTextWeight: resolvedAssistGlobal.resolvedAssistTextWeight,
                });

                if (!res.success) {
                    addLog(`SBV2 synthesis failed: ${res.error?.message || 'Unknown error'}`);
                    return false;
                }

                setLastSbv2WavPath(res.wavPath || null);
                if (res.audioBase64) {
                    setAudioUrl(`data:audio/wav;base64,${res.audioBase64}`);
                } else {
                    setAudioUrl(await readAudioAsDataUrl(res.wavPath));
                }
                producedFinalAudio = true;
                addLog('SBV2 synthesis complete.');
                return await maybeWaitForPlaybackEnd();
            }

            if (mode === 'rvc') {
                const paths = rvcInputPaths.length > 0 ? rvcInputPaths : (lastSbv2WavPath ? [lastSbv2WavPath] : []);
                if (paths.length === 0) {
                    addLog('RVC input WAV を選択してください。');
                    return false;
                }

                const total = paths.length;
                setRvcBatchProgress(total > 1 ? { current: 0, total } : null);

                let lastAudioUrl: string | null = null;
                let failCount = 0;

                for (let i = 0; i < total; i++) {
                    if (total > 1) {
                        setRvcBatchProgress({ current: i + 1, total });
                        addLog(`RVC batch [${i + 1}/${total}]: ${paths[i].split(/[/\\]/).pop()}`);
                    }

                    const res = await window.electronAPI.rvcConvert({
                        inputPath: paths[i],
                        modelId: selectedRvcModel,
                        indexPath: selectedRvcIndexPath || undefined,
                        speakerId: rvcSpeakerId,

                        f0Method: rvcF0Method,
                        transpose: rvcTranspose,
                        indexRate: rvcIndexRate,
                        protect: rvcProtect,
                        filterRadius: rvcFilterRadius,
                        rmsMixRate: rvcRmsMixRate,

                        resampleSr: rvcResampleSr,
                    });

                    if (!res.success) {
                        addLog(`RVC convert failed [${i + 1}/${total}]: ${res.error?.message || 'Unknown error'}`);
                        failCount++;
                        continue;
                    }

                    if (res.audioBase64) {
                        lastAudioUrl = `data:audio/wav;base64,${res.audioBase64}`;
                    } else {
                        lastAudioUrl = await readAudioAsDataUrl(res.wavPath);
                    }
                    addLog(`RVC conversion complete [${i + 1}/${total}]${res.wavPath ? ': ' + res.wavPath : ''}`);
                }

                setRvcBatchProgress(null);
                if (lastAudioUrl) {
                    setAudioUrl(lastAudioUrl);
                    producedFinalAudio = true;
                }
                if (total > 1) {
                    addLog(`RVC batch done: ${total - failCount}/${total} succeeded.`);
                }
                if (!producedFinalAudio) {
                    return false;
                }
                return await maybeWaitForPlaybackEnd();
            }

            const pipelineRes = await window.electronAPI.voiceSynthesize({
                text: sourceText,
                mode: 'sbv2+rvc',
                sbv2: {
                    modelId: selectedTtsModel,
                    style: selectedStyle,
                    speed,
                    pitch,
                    intonation,
                    styleWeight,
                    sdpRatio,
                    noiseScale,
                    noiseScaleW,
                    assistText: resolvedAssistGlobal.resolvedAssistText,
                    assistTextWeight: resolvedAssistGlobal.resolvedAssistTextWeight,
                },
                rvc: {
                    modelId: selectedRvcModel,
                    indexPath: selectedRvcIndexPath || undefined,
                    speakerId: rvcSpeakerId,
    
                    f0Method: rvcF0Method,
                    transpose: rvcTranspose,
                    indexRate: rvcIndexRate,
                    protect: rvcProtect,
                    filterRadius: rvcFilterRadius,
                    rmsMixRate: rvcRmsMixRate,
    
                    resampleSr: rvcResampleSr,
                },
            });

            if (!pipelineRes.success) {
                addLog(`Pipeline failed: ${pipelineRes.error?.message || 'Unknown error'}`);
                return false;
            }

            if (pipelineRes.intermediateWavPath) {
                setIntermediateAudioUrl(await readAudioAsDataUrl(pipelineRes.intermediateWavPath));
                setLastSbv2WavPath(pipelineRes.intermediateWavPath);
            }

            if (pipelineRes.audioBase64) {
                setAudioUrl(`data:audio/wav;base64,${pipelineRes.audioBase64}`);
            } else {
                setAudioUrl(await readAudioAsDataUrl(pipelineRes.wavPath));
            }
            producedFinalAudio = true;
            addLog('SBV2 + RVC pipeline complete.');
            return await maybeWaitForPlaybackEnd();
        } catch (error) {
            addLog(`Action failed: ${String(error)}`);
            return false;
        } finally {
            if (!producedFinalAudio) {
                outputAudioAutoPlayPendingRef.current = false;
            }
            setIsRunningAction(false);
        }
    };

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            padding: '24px',
            gap: '16px',
            backgroundColor: 'var(--color-bg-secondary)',
            color: 'var(--color-text)',
            fontFamily: 'Inter, sans-serif',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button onClick={() => navigate('/')} style={btnStyle('secondary')}>← Back</button>
                    <h1 style={{ margin: 0, fontSize: '24px' }}>Voice Studio</h1>
                    <span style={{ ...badgeStyle, backgroundColor: activeStatus.runtimeState === 'running' ? '#10b981' : '#ef4444' }}>
                        {activeStatus.runtimeState.toUpperCase()}
                    </span>
                </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => setMode('sbv2')} style={tabStyle(mode === 'sbv2')}>SBV2 Only</button>
                <button onClick={() => setMode('rvc')} style={tabStyle(mode === 'rvc')}>RVC Only</button>
                <button onClick={() => setMode('sbv2+rvc')} style={tabStyle(mode === 'sbv2+rvc')}>SBV2 + RVC</button>
            </div>

            <div style={{ ...cardStyle, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', color: '#cbd5e1' }}>
                    <div>Compute Mode: <strong>{useCpuMode ? 'CPU' : 'GPU/Auto (Default)'}</strong></div>
                    <div>RVC Verbose Logs: <strong>{rvcVerboseLogs ? 'ON' : 'OFF'}</strong></div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={handleToggleComputeMode} disabled={isLoading} style={btnStyle('secondary')}>
                        Switch to {useCpuMode ? 'GPU/Auto' : 'CPU'}
                    </button>
                    <button onClick={handleToggleRvcVerboseLogs} disabled={isLoading} style={btnStyle('secondary')}>
                        Logs {rvcVerboseLogs ? 'ON' : 'OFF'}
                    </button>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: '16px', minHeight: 0, flex: 1 }}>
                <div style={{ ...cardStyle, overflowY: 'auto' }}>
                    {(mode === 'sbv2' || mode === 'sbv2+rvc') && (
                        <>
                            <h3 style={sectionTitleStyle}>SBV2</h3>
                            <div style={rowStyle}>
                                {ttsStatus.installState === 'not_installed' ? (
                                    <button disabled={isLoading} onClick={handleInstallTts} style={btnStyle('primary')}>Install SBV2</button>
                                ) : ttsStatus.runtimeState !== 'running' ? (
                                    <button disabled={isLoading} onClick={handleStartTts} style={btnStyle('primary')}>Start SBV2</button>
                                ) : (
                                    <button disabled={isLoading} onClick={handleStopTts} style={btnStyle('danger')}>Stop SBV2</button>
                                )}
                            </div>

                            <label
                                style={labelStyle}
                                title="SBV2 の音声モデルを選択します。モデルごとに声質や対応スタイルが変わります。"
                            >
                                Model
                            </label>
                            <select
                                value={selectedTtsModel}
                                onChange={async (e) => {
                                    const modelId = e.target.value;
                                    setSelectedTtsModel(modelId);
                                    const model = ttsModels.find((m) => m.id === modelId);
                                    if (model) {
                                        setSelectedStyle(model.defaultStyle || model.styles[0] || 'Neutral');
                                    }
                                    await window.electronAPI.ttsSetModel(modelId);
                                }}
                                style={inputStyle}
                                disabled={ttsStatus.runtimeState !== 'running'}
                            >
                                <option value="">(select)</option>
                                {ttsModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>

                            <label
                                style={labelStyle}
                                title="話し方スタイルを選択します。落ち着き/明るさなどの表現が変わります。"
                            >
                                Style
                            </label>
                            <select value={selectedStyle} onChange={(e) => setSelectedStyle(e.target.value)} style={inputStyle}>
                                {(ttsModels.find((m) => m.id === selectedTtsModel)?.styles || []).map((s) => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>

                            <label
                                style={labelStyle}
                                title="話速の倍率です。↑ 速くなる / ↓ ゆっくりになる。"
                            >
                                Speed: {speed.toFixed(2)}
                            </label>
                            <input type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="音程のシフト量です。↑ 高い声になる / ↓ 低い声になる。"
                            >
                                Pitch: {pitch.toFixed(1)}
                            </label>
                            <input type="range" min="-12" max="12" step="0.5" value={pitch} onChange={(e) => setPitch(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="抑揚の強さです。↑ 抑揚が強くなる / ↓ 平坦になる。"
                            >
                                Intonation: {intonation.toFixed(2)}
                            </label>
                            <input type="range" min="0" max="2" step="0.05" value={intonation} onChange={(e) => setIntonation(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="選択した Style の効き具合です。↑ スタイル色が強くなる / ↓ 素の読み方に近づく。"
                            >
                                Style Weight: {styleWeight.toFixed(2)}
                            </label>
                            <input type="range" min="0.1" max="5" step="0.1" value={styleWeight} onChange={(e) => setStyleWeight(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="リズム/長さの揺らぎ比率です。↑ 変化が増える / ↓ 安定した読みになる。"
                            >
                                SDP Ratio: {sdpRatio.toFixed(2)}
                            </label>
                            <input type="range" min="0" max="1" step="0.01" value={sdpRatio} onChange={(e) => setSdpRatio(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="生成時ノイズ量です。↑ 表現の揺らぎが増える / ↓ クリアで安定しやすい。"
                            >
                                Noise: {noiseScale.toFixed(2)}
                            </label>
                            <input type="range" min="0.1" max="1" step="0.01" value={noiseScale} onChange={(e) => setNoiseScale(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="時間方向ノイズ量です。↑ 話速・抑揚の揺れが増える / ↓ リズムが安定する。"
                            >
                                NoiseW: {noiseScaleW.toFixed(2)}
                            </label>
                            <input type="range" min="0.1" max="1" step="0.01" value={noiseScaleW} onChange={(e) => setNoiseScaleW(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="文体・文脈から感情を推定し、Style/Prosody/間を自動で調整します。"
                            >
                                <input
                                    type="checkbox"
                                    checked={sbv2AutoEmotionEnabled}
                                    onChange={(e) => setSbv2AutoEmotionEnabled(e.target.checked)}
                                    disabled={mode !== 'sbv2'}
                                    style={{ marginRight: '8px' }}
                                />
                                Acting Engine v1 (SBV2)
                            </label>
                            {mode !== 'sbv2' && (
                                <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '6px' }}>
                                    Acting Engine v1 currently applies in SBV2 Only mode.
                                </div>
                            )}
                            {sbv2AutoEmotionEnabled && (
                                <>
                                    <label
                                        style={labelStyle}
                                        title="演技マッピングのプロファイルです。キャラ別に切り替え・保存できます。"
                                    >
                                        Acting Profile
                                    </label>
                                    <select
                                        value={selectedActingProfileId}
                                        onChange={(e) => {
                                            const nextId = e.target.value;
                                            setSelectedActingProfileId(nextId);
                                            const profile = actingProfiles.find((p) => p.id === nextId);
                                            if (profile) {
                                                applyActingProfileToUi(profile);
                                            }
                                        }}
                                        style={inputStyle}
                                    >
                                        {actingProfiles.map((p) => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </select>
                                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                                        <button onClick={() => { void loadActingProfiles(selectedActingProfileId); }} style={btnStyle('secondary')}>
                                            Reload
                                        </button>
                                        <button onClick={() => { void handleRestoreBundledActingProfiles(); }} style={btnStyle('secondary')}>
                                            Restore Bundled
                                        </button>
                                        <button onClick={() => { void handleUpdateCurrentActingProfile(); }} style={btnStyle('secondary')}>
                                            Save Current
                                        </button>
                                        <button onClick={() => { void handleSaveActingProfileAsNew(); }} style={btnStyle('secondary')}>
                                            Save As New
                                        </button>
                                        <button
                                            onClick={() => { void handleDeleteCurrentActingProfile(); }}
                                            style={btnStyle('danger')}
                                            disabled={isBundledActingProfileId(activeActingProfile.id)}
                                        >
                                            Delete
                                        </button>
                                    </div>
                                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '8px' }}>
                                        baseline={activeActingProfile.baselineStyle}, crossfade={activeActingProfile.crossfadeMs}ms, temp={activeActingProfile.classifierTemperature.toFixed(2)}
                                    </div>

                                    <label
                                        style={labelStyle}
                                        title="感情補正の強さです。控えめ/標準/強めを選択できます。"
                                    >
                                        Strength
                                    </label>
                                    <select
                                        value={sbv2AutoEmotionStrength}
                                        onChange={(e) => setSbv2AutoEmotionStrength(e.target.value as AutoEmotionStrengthPreset)}
                                        style={inputStyle}
                                    >
                                        <option value="subtle">控えめ</option>
                                        <option value="standard">標準</option>
                                        <option value="strong">強め</option>
                                    </select>

                                    <label
                                        style={labelStyle}
                                        title="Style固定+Prosodyのみ自動が安全。Style自動切替は演出重視です。"
                                    >
                                        Apply Mode
                                    </label>
                                    <select
                                        value={sbv2AutoEmotionApplyMode}
                                        onChange={(e) => setSbv2AutoEmotionApplyMode(e.target.value as AutoEmotionApplyMode)}
                                        style={inputStyle}
                                    >
                                        <option value="fixed_style">Style固定 + Prosody/間のみ</option>
                                        <option value="auto_style">Styleも自動切替</option>
                                    </select>

                                    <label
                                        style={labelStyle}
                                        title="JP-Extra系モデルで、感情Style選択・閾値・assist_text補強を有効化します。"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={sbv2JpExtraEmotionBoost}
                                            onChange={(e) => setSbv2JpExtraEmotionBoost(e.target.checked)}
                                            style={{ marginRight: '8px' }}
                                        />
                                        JP-Extra Emotion Boost
                                    </label>
                                    {sbv2JpExtraEmotionBoost && (
                                        <>
                                            <label
                                                style={labelStyle}
                                                title="JP-Extraブーストの強度です。上げるほどStyle切替・感情反映が強くなります。"
                                            >
                                                JP-Extra Boost Level: {sbv2JpExtraBoostLevel.toFixed(2)}
                                            </label>
                                            <input
                                                type="range"
                                                min="0.00"
                                                max="1.00"
                                                step="0.01"
                                                value={sbv2JpExtraBoostLevel}
                                                onChange={(e) => setSbv2JpExtraBoostLevel(Number(e.target.value))}
                                                style={rangeStyle}
                                            />
                                        </>
                                    )}
                                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                                        <button
                                            onClick={applyJpExtraEmotionPreset}
                                            style={btnStyle('secondary')}
                                        >
                                            Apply JP-Extra Strong Preset
                                        </button>
                                    </div>
                                    <div style={{ fontSize: '11px', color: selectedTtsLikelyJpExtra ? '#86efac' : '#fca5a5', marginBottom: '8px' }}>
                                        Selected model "{selectedTtsModel || '(none)'}": {selectedTtsLikelyJpExtra ? 'JP-Extra/emotion style detected' : 'JP-Extra/emotion style not detected'}
                                    </div>

                                    <label
                                        style={labelStyle}
                                        title="感情推定エンジンです。hybrid はルールと軽量分類器を合成します。"
                                    >
                                        Analyzer
                                    </label>
                                    <select
                                        value={sbv2AutoEmotionAnalyzerMode}
                                        onChange={(e) => setSbv2AutoEmotionAnalyzerMode(e.target.value as AutoEmotionAnalyzerMode)}
                                        style={inputStyle}
                                    >
                                        <option value="hybrid">hybrid (recommended)</option>
                                        <option value="classifier">lightweight classifier</option>
                                        <option value="rule">rule-based</option>
                                    </select>
                                    {sbv2AutoEmotionAnalyzerMode === 'hybrid' && (
                                        <>
                                            <label
                                                style={labelStyle}
                                                title="hybrid時の分類器寄与率です。上げると滑らか、下げるとルール重視になります。"
                                            >
                                                Classifier Blend: {sbv2AutoEmotionClassifierBlend.toFixed(2)}
                                            </label>
                                            <input
                                                type="range"
                                                min="0.00"
                                                max="1.00"
                                                step="0.01"
                                                value={sbv2AutoEmotionClassifierBlend}
                                                onChange={(e) => setSbv2AutoEmotionClassifierBlend(Number(e.target.value))}
                                                style={rangeStyle}
                                            />
                                        </>
                                    )}
                                    {sbv2AutoEmotionAnalyzerMode !== 'rule' && (
                                        <>
                                            <label
                                                style={labelStyle}
                                                title="分類器の温度です。低いほど判定が鋭く、高いほどなだらかになります。"
                                            >
                                                Classifier Temperature: {activeActingProfile.classifierTemperature.toFixed(2)}
                                            </label>
                                            <input
                                                type="range"
                                                min="0.35"
                                                max="2.50"
                                                step="0.01"
                                                value={activeActingProfile.classifierTemperature}
                                                onChange={(e) => {
                                                    const v = clamp(Number(e.target.value), 0.35, 3);
                                                    updateActiveActingProfileDraft((p) => ({ ...p, classifierTemperature: v }));
                                                }}
                                                style={rangeStyle}
                                            />
                                            {sbv2AutoEmotionAnalyzerMode === 'hybrid' && (
                                                <>
                                                    <label
                                                        style={labelStyle}
                                                        title="hybridで分類器スコアをどれだけ拡大するかの係数です。"
                                                    >
                                                        Hybrid Classifier Scale: {activeActingProfile.hybridClassifierScale.toFixed(2)}
                                                    </label>
                                                    <input
                                                        type="range"
                                                        min="0.20"
                                                        max="6.00"
                                                        step="0.05"
                                                        value={activeActingProfile.hybridClassifierScale}
                                                        onChange={(e) => {
                                                            const v = clamp(Number(e.target.value), 0.2, 6);
                                                            updateActiveActingProfileDraft((p) => ({ ...p, hybridClassifierScale: v }));
                                                        }}
                                                        style={rangeStyle}
                                                    />
                                                </>
                                            )}
                                            <div
                                                style={{
                                                    marginBottom: '8px',
                                                    border: '1px solid #334155',
                                                    borderRadius: '6px',
                                                    padding: '8px',
                                                    background: '#0f172a',
                                                }}
                                            >
                                                <div style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '6px' }}>
                                                    Classifier Feature Gain
                                                </div>
                                                <label style={{ ...labelStyle, marginBottom: '4px' }}>
                                                    Keyword: {activeActingProfile.classifierFeatureGain.keyword.toFixed(2)}
                                                </label>
                                                <input
                                                    type="range"
                                                    min="0.20"
                                                    max="2.50"
                                                    step="0.01"
                                                    value={activeActingProfile.classifierFeatureGain.keyword}
                                                    onChange={(e) => {
                                                        const v = clamp(Number(e.target.value), 0.2, 2.5);
                                                        updateActiveActingProfileDraft((p) => ({
                                                            ...p,
                                                            classifierFeatureGain: { ...p.classifierFeatureGain, keyword: v },
                                                        }));
                                                    }}
                                                    style={rangeStyle}
                                                />
                                                <label style={{ ...labelStyle, marginBottom: '4px' }}>
                                                    Punctuation: {activeActingProfile.classifierFeatureGain.punctuation.toFixed(2)}
                                                </label>
                                                <input
                                                    type="range"
                                                    min="0.20"
                                                    max="2.50"
                                                    step="0.01"
                                                    value={activeActingProfile.classifierFeatureGain.punctuation}
                                                    onChange={(e) => {
                                                        const v = clamp(Number(e.target.value), 0.2, 2.5);
                                                        updateActiveActingProfileDraft((p) => ({
                                                            ...p,
                                                            classifierFeatureGain: { ...p.classifierFeatureGain, punctuation: v },
                                                        }));
                                                    }}
                                                    style={rangeStyle}
                                                />
                                                <label style={{ ...labelStyle, marginBottom: '4px' }}>
                                                    Uncertainty: {activeActingProfile.classifierFeatureGain.uncertainty.toFixed(2)}
                                                </label>
                                                <input
                                                    type="range"
                                                    min="0.20"
                                                    max="2.50"
                                                    step="0.01"
                                                    value={activeActingProfile.classifierFeatureGain.uncertainty}
                                                    onChange={(e) => {
                                                        const v = clamp(Number(e.target.value), 0.2, 2.5);
                                                        updateActiveActingProfileDraft((p) => ({
                                                            ...p,
                                                            classifierFeatureGain: { ...p.classifierFeatureGain, uncertainty: v },
                                                        }));
                                                    }}
                                                    style={rangeStyle}
                                                />
                                                <label style={{ ...labelStyle, marginBottom: '4px' }}>
                                                    Negation: {activeActingProfile.classifierFeatureGain.negation.toFixed(2)}
                                                </label>
                                                <input
                                                    type="range"
                                                    min="0.20"
                                                    max="2.50"
                                                    step="0.01"
                                                    value={activeActingProfile.classifierFeatureGain.negation}
                                                    onChange={(e) => {
                                                        const v = clamp(Number(e.target.value), 0.2, 2.5);
                                                        updateActiveActingProfileDraft((p) => ({
                                                            ...p,
                                                            classifierFeatureGain: { ...p.classifierFeatureGain, negation: v },
                                                        }));
                                                    }}
                                                    style={rangeStyle}
                                                />
                                                <label style={{ ...labelStyle, marginBottom: '4px' }}>
                                                    Laughter: {activeActingProfile.classifierFeatureGain.laughter.toFixed(2)}
                                                </label>
                                                <input
                                                    type="range"
                                                    min="0.20"
                                                    max="2.50"
                                                    step="0.01"
                                                    value={activeActingProfile.classifierFeatureGain.laughter}
                                                    onChange={(e) => {
                                                        const v = clamp(Number(e.target.value), 0.2, 2.5);
                                                        updateActiveActingProfileDraft((p) => ({
                                                            ...p,
                                                            classifierFeatureGain: { ...p.classifierFeatureGain, laughter: v },
                                                        }));
                                                    }}
                                                    style={rangeStyle}
                                                />
                                                <label style={{ ...labelStyle, marginBottom: '4px' }}>
                                                    Assertive: {activeActingProfile.classifierFeatureGain.assertive.toFixed(2)}
                                                </label>
                                                <input
                                                    type="range"
                                                    min="0.20"
                                                    max="2.50"
                                                    step="0.01"
                                                    value={activeActingProfile.classifierFeatureGain.assertive}
                                                    onChange={(e) => {
                                                        const v = clamp(Number(e.target.value), 0.2, 2.5);
                                                        updateActiveActingProfileDraft((p) => ({
                                                            ...p,
                                                            classifierFeatureGain: { ...p.classifierFeatureGain, assertive: v },
                                                        }));
                                                    }}
                                                    style={rangeStyle}
                                                />
                                                <label style={{ ...labelStyle, marginBottom: '4px' }}>
                                                    Neutral Context: {activeActingProfile.classifierFeatureGain.neutralContext.toFixed(2)}
                                                </label>
                                                <input
                                                    type="range"
                                                    min="0.20"
                                                    max="2.50"
                                                    step="0.01"
                                                    value={activeActingProfile.classifierFeatureGain.neutralContext}
                                                    onChange={(e) => {
                                                        const v = clamp(Number(e.target.value), 0.2, 2.5);
                                                        updateActiveActingProfileDraft((p) => ({
                                                            ...p,
                                                            classifierFeatureGain: { ...p.classifierFeatureGain, neutralContext: v },
                                                        }));
                                                    }}
                                                    style={rangeStyle}
                                                />
                                            </div>
                                            <div
                                                style={{
                                                    marginBottom: '8px',
                                                    border: '1px solid #334155',
                                                    borderRadius: '6px',
                                                    padding: '8px',
                                                    background: '#0f172a',
                                                }}
                                            >
                                                <div style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '6px' }}>
                                                    Emotion Bias
                                                </div>
                                                {(['neutral', 'joy', 'sadness', 'anger', 'fear'] as AutoEmotion[]).map((emotionKey) => (
                                                    <div key={`bias-${emotionKey}`} style={{ marginBottom: '6px' }}>
                                                        <label style={{ ...labelStyle, marginBottom: '2px' }}>
                                                            {emotionKey}: {activeActingProfile.classifierEmotionBias[emotionKey].toFixed(2)}
                                                        </label>
                                                        <input
                                                            type="range"
                                                            min="-1.00"
                                                            max="1.00"
                                                            step="0.01"
                                                            value={activeActingProfile.classifierEmotionBias[emotionKey]}
                                                            onChange={(e) => {
                                                                const v = clamp(Number(e.target.value), -1, 1);
                                                                updateActiveActingProfileDraft((p) => ({
                                                                    ...p,
                                                                    classifierEmotionBias: {
                                                                        ...p.classifierEmotionBias,
                                                                        [emotionKey]: v,
                                                                    },
                                                                }));
                                                            }}
                                                            style={rangeStyle}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        </>
                                    )}

                                    <label
                                        style={labelStyle}
                                        title="推定信頼度の閾値です。下げると感情付与されやすく、上げると中立にフォールバックしやすくなります。"
                                    >
                                        Confidence Threshold: {sbv2AutoEmotionThreshold.toFixed(2)}
                                    </label>
                                    <input
                                        type="range"
                                        min="0.45"
                                        max="0.80"
                                        step="0.01"
                                        value={sbv2AutoEmotionThreshold}
                                        onChange={(e) => setSbv2AutoEmotionThreshold(Number(e.target.value))}
                                        style={rangeStyle}
                                    />

                                    <label
                                        style={labelStyle}
                                        title="推定結果を手動上書きします。Autoで自動判定に戻します。"
                                    >
                                        Override Emotion
                                    </label>
                                    <select
                                        value={sbv2AutoEmotionOverride}
                                        onChange={(e) => setSbv2AutoEmotionOverride(e.target.value as AutoEmotionOverride)}
                                        style={inputStyle}
                                    >
                                        <option value="auto">auto</option>
                                        <option value="neutral">neutral</option>
                                        <option value="joy">joy</option>
                                        <option value="sadness">sadness</option>
                                        <option value="anger">anger</option>
                                        <option value="fear">fear</option>
                                    </select>

                                    <label
                                        style={labelStyle}
                                        title="最終音声にEQ/De-esser/Compressor/Limiterを適用します。"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={sbv2ActingDspEnabled}
                                            onChange={(e) => setSbv2ActingDspEnabled(e.target.checked)}
                                            style={{ marginRight: '8px' }}
                                        />
                                        Final DSP (EQ/Comp/De-esser/Limiter)
                                    </label>

                                    <label
                                        style={labelStyle}
                                        title="合成ごとに output/input.txt, segments.json, raw_segments, merged.wav, final.wav を保存します。"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={sbv2ActingAutoSaveOutput}
                                            onChange={(e) => setSbv2ActingAutoSaveOutput(e.target.checked)}
                                            style={{ marginRight: '8px' }}
                                        />
                                        Auto Save Acting Output Bundle
                                    </label>

                                    {sbv2ActingLastOutputDir && (
                                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                                            <div
                                                style={{
                                                    fontSize: '11px',
                                                    color: '#94a3b8',
                                                    flex: 1,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                }}
                                                title={sbv2ActingLastOutputDir}
                                            >
                                                Output: {sbv2ActingLastOutputDir}
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    await window.electronAPI.openFolder(sbv2ActingLastOutputDir);
                                                }}
                                                style={btnStyle('secondary')}
                                            >
                                                Open
                                            </button>
                                        </div>
                                    )}

                                    <div style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '6px' }}>
                                        Detected:{' '}
                                        {sbv2AutoEmotionDetected
                                            ? `${AUTO_EMOTION_EMOJI[sbv2AutoEmotionDetected.emotion]} `
                                            + `(conf=${sbv2AutoEmotionDetected.confidence.toFixed(2)}, `
                                            + `int=${sbv2AutoEmotionDetected.intensity.toFixed(2)}) `
                                            + `[${sbv2AutoEmotionDetected.segmentIndex}/${sbv2AutoEmotionDetected.segmentCount}]`
                                            : '(none)'}
                                    </div>
                                    {sbv2AutoEmotionDebugRows.length > 0 && (
                                        <div style={{
                                            marginBottom: '10px',
                                            fontSize: '11px',
                                            color: '#94a3b8',
                                            maxHeight: '120px',
                                            overflowY: 'auto',
                                            border: '1px solid #334155',
                                            borderRadius: '6px',
                                            padding: '6px',
                                            backgroundColor: '#0f172a',
                                        }}>
                                            {sbv2AutoEmotionDebugRows.map((row, idx) => (
                                                <div key={`ae-row-${idx}`}>{row}</div>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}

                            <label style={labelStyle}>SBV2 Presets</label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                                {ttsPresets.map((preset) => (
                                    <button key={preset.id} onClick={() => applyTtsPreset(preset)} style={presetBtnStyle}>{preset.name}</button>
                                ))}
                            </div>
                        </>
                    )}

                    {(mode === 'rvc' || mode === 'sbv2+rvc') && (
                        <>
                            <h3 style={sectionTitleStyle}>RVC</h3>
                            <div style={rowStyle}>
                                {rvcStatus.installState === 'not_installed' ? (
                                    <button disabled={isLoading} onClick={handleInstallRvc} style={btnStyle('primary')}>Install RVC</button>
                                ) : rvcStatus.runtimeState !== 'running' ? (
                                    <button disabled={isLoading} onClick={handleStartRvc} style={btnStyle('primary')}>Start RVC</button>
                                ) : (
                                    <button disabled={isLoading} onClick={handleStopRvc} style={btnStyle('danger')}>Stop RVC</button>
                                )}
                                <button disabled={isLoading} onClick={handleOpenRvcModelsFolder} style={btnStyle('secondary')}>
                                    Open Models Folder
                                </button>
                            </div>

                            <label
                                style={labelStyle}
                                title="使用する RVC モデル (.pth) を選択します。モデルごとに変換先の声質が異なります。"
                            >
                                RVC Model
                            </label>
                            <select
                                value={selectedRvcModel}
                                onChange={async (e) => {
                                    const modelId = e.target.value;
                                    setSelectedRvcModel(modelId);
                                    const setRes = await window.electronAPI.rvcSetModel(modelId);
                                    const spkCount = Number(setRes?.speaker_count || 1);
                                    setRvcSpeakerCount(spkCount > 0 ? spkCount : 1);
                                    setRvcSpeakerId(0);
                                    addLog(`RVC model ${modelId}: speaker count = ${spkCount > 0 ? spkCount : 1}`);
                                    const indexFiles = await window.electronAPI.rvcListModelIndexes(modelId);
                                    setRvcIndexFiles(indexFiles || []);
                                    const firstIndex = indexFiles && indexFiles.length > 0 ? indexFiles[0] : '';
                                    setSelectedRvcIndexPath(firstIndex);
                                    if (firstIndex) {
                                        addLog(`Using index file: ${firstIndex}`);
                                        if (rvcIndexRate <= 0) {
                                            setRvcIndexRate(0.75);
                                        }
                                    } else {
                                        setRvcIndexRate(0);
                                        setRvcProtect(0.33);
                                        setRvcRmsMixRate(0.25);
                                        addLog(`Model ${modelId} has no index file. Applied no-index safe defaults.`);
                                    }
                                }}
                                style={inputStyle}
                                disabled={rvcStatus.runtimeState !== 'running'}
                            >
                                <option value="">(select)</option>
                                {rvcModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>

                            <label
                                style={labelStyle}
                                title="RVC の検索インデックス (.index) を選択します。通常は同じモデルフォルダ内の index を使います。"
                            >
                                Index File (same model directory)
                            </label>
                            <select
                                value={selectedRvcIndexPath}
                                onChange={(e) => {
                                    const value = e.target.value;
                                    setSelectedRvcIndexPath(value);
                                    if (value) {
                                        addLog(`Selected index file: ${value}`);
                                        if (rvcIndexRate <= 0) {
                                            setRvcIndexRate(0.75);
                                        }
                                    } else {
                                        addLog('Index file disabled (no index).');
                                        setRvcIndexRate(0);
                                    }
                                }}
                                style={inputStyle}
                                disabled={rvcStatus.runtimeState !== 'running'}
                            >
                                <option value="">(none)</option>
                                {rvcIndexFiles.map((p) => <option key={p} value={p}>{p.split(/[/\\]/).pop() || p}</option>)}
                            </select>

                            <label
                                style={labelStyle}
                                title="ピッチ抽出アルゴリズムです。rmvpe は品質重視、harvest は安定寄り、crepe は環境依存で挙動が変わります。"
                            >
                                F0 Method
                            </label>
                            <select value={rvcF0Method} onChange={(e) => setRvcF0Method(e.target.value as RvcF0Method)} style={inputStyle}>
                                <option value="rmvpe">rmvpe</option>
                                <option value="harvest">harvest</option>
                                <option value="crepe">crepe</option>
                            </select>

                            <label
                                style={labelStyle}
                                title="モデル内の話者IDです。IDを変えると目標話者が変わります。↑/↓ で別話者へ切り替え。"
                            >
                                Speaker ID: {rvcSpeakerId} / {Math.max(0, rvcSpeakerCount - 1)}
                            </label>
                            <input
                                type="range"
                                min="0"
                                max={Math.max(0, rvcSpeakerCount - 1)}
                                step="1"
                                value={Math.min(rvcSpeakerId, Math.max(0, rvcSpeakerCount - 1))}
                                onChange={(e) => setRvcSpeakerId(Number(e.target.value))}
                                style={rangeStyle}
                            />

                            <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                                <button
                                    onClick={() => handleScanSpeakerIds(false)}
                                    disabled={rvcSpeakerScanRunning || rvcStatus.runtimeState !== 'running' || !selectedRvcModel}
                                    style={btnStyle('secondary')}
                                >
                                    Quick Scan (12)
                                </button>
                                <button
                                    onClick={() => handleScanSpeakerIds(true)}
                                    disabled={rvcSpeakerScanRunning || rvcStatus.runtimeState !== 'running' || !selectedRvcModel}
                                    style={btnStyle('primary')}
                                >
                                    Full Scan ({rvcSpeakerCount})
                                </button>
                                {rvcSpeakerScanRunning && (
                                    <button
                                        onClick={() => { rvcSpeakerScanAbortRef.current = true; }}
                                        style={btnStyle('danger')}
                                    >
                                        Stop Scan
                                    </button>
                                )}
                                {rvcSpeakerScanResults.length > 0 && !rvcSpeakerScanRunning && (
                                    <button
                                        onClick={() => setRvcSpeakerScanResults([])}
                                        style={btnStyle('secondary')}
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>

                            {rvcSpeakerScanRunning && (
                                <div style={{ fontSize: '12px', color: '#60a5fa', marginBottom: '8px' }}>
                                    Scanning... {rvcSpeakerScanResults.length} / {rvcSpeakerCount} completed
                                </div>
                            )}

                            {rvcSpeakerScanResults.length > 0 && (
                                <div style={{
                                    marginBottom: '12px',
                                    padding: '8px',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    borderRadius: '8px',
                                    background: 'rgba(0,0,0,0.12)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '6px',
                                    maxHeight: '400px',
                                    overflowY: 'auto',
                                }}>
                                    <div style={{ fontSize: '12px', color: '#cbd5e1', position: 'sticky', top: 0, background: 'rgba(0,0,0,0.8)', padding: '4px 0', zIndex: 1 }}>
                                        Speaker Scan Results ({rvcSpeakerScanResults.length})
                                    </div>
                                    {rvcSpeakerScanResults.map((item) => (
                                        <div key={`scan-sid-${item.sid}`} style={{ display: 'flex', alignItems: 'center', gap: '6px', minHeight: '36px' }}>
                                            <button
                                                onClick={() => setRvcSpeakerId(item.sid)}
                                                style={{ ...btnStyle('secondary'), minWidth: '80px', fontSize: '11px', padding: '4px 8px' }}
                                            >
                                                SID {item.sid}
                                            </button>
                                            {item.audioUrl ? (
                                                <audio controls src={item.audioUrl} style={{ width: '100%', height: '32px' }} />
                                            ) : (
                                                <span style={{ fontSize: '11px', color: '#fca5a5' }}>
                                                    {item.error || 'no audio'}
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            <label
                                style={labelStyle}
                                title="半音単位のキー変更です。↑ 高くなる / ↓ 低くなる。"
                            >
                                Transpose: {rvcTranspose}
                            </label>
                            <input type="range" min="-12" max="12" step="1" value={rvcTranspose} onChange={(e) => setRvcTranspose(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="index 参照の強さです。↑ 変換先の声色に寄る / ↓ 元音声の特徴を残しやすい。"
                            >
                                Index Rate: {rvcIndexRate.toFixed(2)}
                            </label>
                            <input type="range" min="0" max="1" step="0.01" value={rvcIndexRate} onChange={(e) => setRvcIndexRate(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="子音保護の強さです。↑ 子音の崩れを抑える / ↓ 変換のかかりを強める。"
                            >
                                Protect: {rvcProtect.toFixed(2)}
                            </label>
                            <input type="range" min="0" max="0.5" step="0.01" value={rvcProtect} onChange={(e) => setRvcProtect(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="F0 平滑化の半径です。↑ ピッチがなめらかになる / ↓ 変化が鋭くなる。"
                            >
                                Filter Radius: {rvcFilterRadius}
                            </label>
                            <input type="range" min="0" max="7" step="1" value={rvcFilterRadius} onChange={(e) => setRvcFilterRadius(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="元音声の音量エンベロープ混合率です。↑ 元の抑揚を残す / ↓ 変換側の抑揚が強く出る。"
                            >
                                RMS Mix Rate: {rvcRmsMixRate.toFixed(2)}
                            </label>
                            <input type="range" min="0" max="1" step="0.01" value={rvcRmsMixRate} onChange={(e) => setRvcRmsMixRate(Number(e.target.value))} style={rangeStyle} />

                            <label
                                style={labelStyle}
                                title="出力サンプルレート(Hz)です。0 はモデル既定。↑ 高域保持しやすいが容量/負荷増。↓ 軽量だが高域は減る。"
                            >
                                Resample SR
                            </label>
                            <input type="number" value={rvcResampleSr} onChange={(e) => setRvcResampleSr(Number(e.target.value) || 0)} style={inputStyle} />

                            <label style={labelStyle}>RVC Presets</label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {rvcPresets.map((preset) => (
                                    <button key={preset.id} onClick={() => applyRvcPreset(preset)} style={presetBtnStyle}>{preset.name}</button>
                                ))}
                            </div>

                            <label
                                style={labelStyle}
                                title="入力音声（マイク/特定アプリ）をリアルタイム変換してスピーカーへ出すテスト機能です。"
                            >
                                RVC Test Mode (Input to Voice Change to Speaker)
                            </label>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                                <button
                                    onClick={() => setRvcTestEnabled((v) => !v)}
                                    disabled={
                                        rvcStatus.runtimeState !== 'running'
                                        || !selectedRvcModel
                                        || (rvcTestInputSource === 'app' && !selectedRvcTestProcessPid)
                                        || (rvcTestCallRelayEnabled && !selectedRvcTestCallOutputDeviceId)
                                    }
                                    style={btnStyle(rvcTestEnabled ? 'danger' : 'secondary')}
                                >
                                    {rvcTestEnabled ? 'Test Mode: ON' : 'Test Mode: OFF'}
                                </button>
                                <span style={{ fontSize: '12px', color: rvcTestRunning ? '#10b981' : '#9ca3af' }}>
                                    {rvcTestRunning ? 'Streaming' : 'Idle'}
                                </span>
                            </div>

                            <label
                                style={labelStyle}
                                title="テストモードの入力元です。マイクか特定アプリのどちらかを選択します。"
                            >
                                Test Input Source
                            </label>
                            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                                <button
                                    onClick={() => setRvcTestInputSource('mic')}
                                    disabled={rvcTestRunning}
                                    style={btnStyle(rvcTestInputSource === 'mic' ? 'primary' : 'secondary')}
                                >
                                    Microphone
                                </button>
                                <button
                                    onClick={() => {
                                        setRvcTestInputSource('app');
                                        void refreshRvcTestProcesses();
                                    }}
                                    disabled={rvcTestRunning}
                                    style={btnStyle(rvcTestInputSource === 'app' ? 'primary' : 'secondary')}
                                >
                                    Specific App
                                </button>
                            </div>

                            <label
                                style={labelStyle}
                                title="入力前処理です。Noise Cancel はゲート、BGM Removal は帯域強調、Spectral Denoise は定常ノイズ抑制、Speech-only Convert は非音声チャンクを変換しません。"
                            >
                                Input Cleanup
                            </label>
                            <label style={{ ...labelStyle, marginTop: '4px' }}>
                                <input
                                    type="checkbox"
                                    checked={rvcTestNoiseCancel}
                                    onChange={(e) => setRvcTestNoiseCancel(e.target.checked)}
                                    disabled={rvcTestRunning}
                                    style={{ marginRight: '8px' }}
                                />
                                Noise Cancel (Mic/App)
                            </label>
                            <label style={{ ...labelStyle, marginTop: '4px' }}>
                                <input
                                    type="checkbox"
                                    checked={rvcTestBgmRemoval}
                                    onChange={(e) => setRvcTestBgmRemoval(e.target.checked)}
                                    disabled={rvcTestRunning}
                                    style={{ marginRight: '8px' }}
                                />
                                BGM Removal (Mic/App)
                            </label>
                            <label style={{ ...labelStyle, marginTop: '4px' }}>
                                <input
                                    type="checkbox"
                                    checked={rvcTestSpectralDenoise}
                                    onChange={(e) => setRvcTestSpectralDenoise(e.target.checked)}
                                    disabled={rvcTestRunning}
                                    style={{ marginRight: '8px' }}
                                />
                                Spectral Denoise (Mic/App)
                            </label>
                            {rvcTestBgmRemoval && (
                                <>
                                    <label
                                        style={{ ...labelStyle, marginTop: '4px' }}
                                        title="BGM除去の強さです。高すぎると声が細くなります。"
                                    >
                                        BGM Removal Strength: {rvcTestBgmRemovalStrength.toFixed(2)}
                                    </label>
                                    <input
                                        type="range"
                                        min="0.2"
                                        max="1"
                                        step="0.05"
                                        value={rvcTestBgmRemovalStrength}
                                        onChange={(e) => setRvcTestBgmRemovalStrength(Number(e.target.value))}
                                        style={rangeStyle}
                                        disabled={rvcTestRunning}
                                    />
                                </>
                            )}
                            {rvcTestSpectralDenoise && (
                                <>
                                    <label
                                        style={{ ...labelStyle, marginTop: '4px' }}
                                        title="スペクトル減算の強さです。上げるほど環境ノイズを抑えますが、上げすぎると金属音が出ます。"
                                    >
                                        Spectral Strength: {rvcTestSpectralStrength.toFixed(2)}
                                    </label>
                                    <input
                                        type="range"
                                        min="0.2"
                                        max="1.4"
                                        step="0.02"
                                        value={rvcTestSpectralStrength}
                                        onChange={(e) => setRvcTestSpectralStrength(Number(e.target.value))}
                                        style={rangeStyle}
                                        disabled={rvcTestRunning}
                                    />
                                    <label
                                        style={{ ...labelStyle, marginTop: '4px' }}
                                        title="減算後の残留ノイズ床です。低いほど静かですが、低すぎると声の歪みが増えます。"
                                    >
                                        Spectral Floor: {rvcTestSpectralFloor.toFixed(2)}
                                    </label>
                                    <input
                                        type="range"
                                        min="0.02"
                                        max="0.35"
                                        step="0.01"
                                        value={rvcTestSpectralFloor}
                                        onChange={(e) => setRvcTestSpectralFloor(Number(e.target.value))}
                                        style={rangeStyle}
                                        disabled={rvcTestRunning}
                                    />
                                    <button
                                        onClick={handleResetInputCleanupProfile}
                                        style={{ ...btnStyle('secondary'), marginBottom: '8px' }}
                                    >
                                        Reset Noise Profile
                                    </button>
                                </>
                            )}
                            <label style={{ ...labelStyle, marginTop: '4px' }}>
                                <input
                                    type="checkbox"
                                    checked={rvcTestSpeechOnlyConvert}
                                    onChange={(e) => setRvcTestSpeechOnlyConvert(e.target.checked)}
                                    disabled={rvcTestRunning}
                                    style={{ marginRight: '8px' }}
                                />
                                Speech-only Convert (VAD Gate)
                            </label>
                            {rvcTestSpeechOnlyConvert && (
                                <>
                                    <label
                                        style={{ ...labelStyle, marginTop: '4px' }}
                                        title="高いほど厳しく判定します。キーボード/マウス音が残る場合は上げてください。"
                                    >
                                        VAD Aggressiveness: {rvcTestVadAggressiveness}
                                    </label>
                                    <input
                                        type="range"
                                        min="0"
                                        max="3"
                                        step="1"
                                        value={rvcTestVadAggressiveness}
                                        onChange={(e) => setRvcTestVadAggressiveness(Number(e.target.value))}
                                        style={rangeStyle}
                                        disabled={rvcTestRunning}
                                    />
                                    <label
                                        style={{ ...labelStyle, marginTop: '4px' }}
                                        title="この時間以上の連続音声があった時だけ変換を開始します。短いクリック音誤検出を抑えます。"
                                    >
                                        VAD Min Speech (ms): {rvcTestVadMinSpeechMs}
                                    </label>
                                    <input
                                        type="range"
                                        min="40"
                                        max="320"
                                        step="20"
                                        value={rvcTestVadMinSpeechMs}
                                        onChange={(e) => setRvcTestVadMinSpeechMs(Number(e.target.value))}
                                        style={rangeStyle}
                                        disabled={rvcTestRunning}
                                    />
                                    <label
                                        style={{ ...labelStyle, marginTop: '4px' }}
                                        title="音声が途切れた後もしばらく変換を維持する時間です。語尾欠けを抑えます。"
                                    >
                                        VAD Hangover (ms): {rvcTestVadHangoverMs}
                                    </label>
                                    <input
                                        type="range"
                                        min="60"
                                        max="420"
                                        step="20"
                                        value={rvcTestVadHangoverMs}
                                        onChange={(e) => setRvcTestVadHangoverMs(Number(e.target.value))}
                                        style={rangeStyle}
                                        disabled={rvcTestRunning}
                                    />
                                </>
                            )}

                            {rvcTestInputSource === 'app' && (
                                <>
                                    <label
                                        style={labelStyle}
                                        title="入力対象のアプリを選択します。音声を出しているプロセスのみ有効です。"
                                    >
                                        App (Input)
                                    </label>
                                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                                        <select
                                            value={selectedRvcTestProcessPid !== null ? String(selectedRvcTestProcessPid) : ''}
                                            onChange={(e) => {
                                                const value = e.target.value;
                                                setSelectedRvcTestProcessPid(value ? Number(value) : null);
                                            }}
                                            style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
                                            disabled={rvcTestRunning}
                                        >
                                            <option value="">(select app)</option>
                                            {rvcTestProcesses.map((p) => (
                                                <option key={`${p.pid}-${p.name}`} value={p.pid}>
                                                    {p.name} (PID: {p.pid}){p.title ? ` - ${p.title}` : ''}
                                                </option>
                                            ))}
                                        </select>
                                        <button
                                            onClick={() => { void refreshRvcTestProcesses(); }}
                                            style={btnStyle('secondary')}
                                            disabled={rvcTestRunning}
                                        >
                                            Refresh
                                        </button>
                                    </div>
                                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '8px' }}>
                                        Avoid overlap by routing the source app to another output device from Windows settings.
                                    </div>
                                    <button
                                        onClick={handleOpenAppVolumeSettings}
                                        style={{ ...btnStyle('secondary'), marginBottom: '8px' }}
                                    >
                                        Open App Volume Settings
                                    </button>
                                    <label
                                        style={labelStyle}
                                        title="元アプリをミュートします。キャプチャまで止まる環境があるため、通常はOFF推奨です。"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={rvcTestMuteSourceApp}
                                            onChange={(e) => setRvcTestMuteSourceApp(e.target.checked)}
                                            disabled={rvcTestRunning}
                                            style={{ marginRight: '8px' }}
                                        />
                                        Experimental: Mute source app (may break capture)
                                    </label>
                                </>
                            )}

                            {rvcTestInputSource === 'mic' && (
                                <>
                                    <label
                                        style={labelStyle}
                                        title="RVC テストモードで使う入力マイクを選択します。"
                                    >
                                        Microphone (Input)
                                    </label>
                                    <select
                                        value={selectedMicDeviceId}
                                        onChange={(e) => setSelectedMicDeviceId(e.target.value)}
                                        style={inputStyle}
                                        disabled={rvcTestRunning}
                                    >
                                        <option value="">(default)</option>
                                        {micDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                                    </select>
                                    {(() => {
                                        const selectedMic = micDevices.find((d) => d.deviceId === selectedMicDeviceId);
                                        if (!selectedMic || !isLikelyVirtualMicInput(selectedMic.label)) return null;
                                        return (
                                            <div style={{ fontSize: '11px', color: '#fca5a5', marginBottom: '8px' }}>
                                                Selected mic is a virtual cable endpoint. Physical mic voice will not enter
                                                unless you route it into this cable first.
                                            </div>
                                        );
                                    })()}
                                </>
                            )}

                            <label
                                style={labelStyle}
                                title="RVC テストモードの再生先スピーカーを選択します。"
                            >
                                Speaker (Output)
                            </label>
                            <select
                                value={selectedSpeakerDeviceId}
                                onChange={(e) => setSelectedSpeakerDeviceId(e.target.value)}
                                style={inputStyle}
                            >
                                <option value="">(system default)</option>
                                {speakerDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                            </select>

                            <label
                                style={labelStyle}
                                title="変換音声を仮想オーディオ出力へも同時送出し、Teams/Discordの入力へ回す用途です。"
                            >
                                <input
                                    type="checkbox"
                                    checked={rvcTestCallRelayEnabled}
                                    onChange={(e) => setRvcTestCallRelayEnabled(e.target.checked)}
                                    style={{ marginRight: '8px' }}
                                />
                                Relay Converted Voice to Call App (Virtual Mic Route)
                            </label>
                            {rvcTestCallRelayEnabled && (
                                <>
                                    <label
                                        style={labelStyle}
                                        title="VB-CABLE等の仮想ケーブルの再生側デバイスを選択してください。"
                                    >
                                        Call App Output Device (Virtual Cable Input)
                                    </label>
                                    <select
                                        value={selectedRvcTestCallOutputDeviceId}
                                        onChange={(e) => setSelectedRvcTestCallOutputDeviceId(e.target.value)}
                                        style={inputStyle}
                                    >
                                        <option value="">(select virtual output device)</option>
                                        {speakerDevices.map((d) => (
                                            <option key={`call-${d.deviceId}`} value={d.deviceId}>
                                                {isLikelyVirtualMicOutput(d.label) ? `[Recommended] ${d.label}` : d.label}
                                            </option>
                                        ))}
                                    </select>
                                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '8px' }}>
                                        In Teams/Discord, set microphone input to the paired recording endpoint
                                        (example: output "CABLE Input" pairs with input "CABLE Output").
                                    </div>
                                    {rvcTestCallOutputCandidates.length === 0 && (
                                        <div style={{ fontSize: '11px', color: '#fca5a5', marginBottom: '8px' }}>
                                            No virtual-cable-like output detected. Install VB-CABLE/VoiceMeeter and select it here.
                                        </div>
                                    )}
                                </>
                            )}

                            <label
                                style={labelStyle}
                                title="リアルタイム変換の処理チャンク長です。↑ 安定しやすいが遅延増 / ↓ 低遅延だが負荷・途切れリスク増。"
                            >
                                Test Chunk (ms): {rvcTestChunkMs}
                            </label>
                            <input
                                type="range"
                                min="200"
                                max="1500"
                                step="100"
                                value={rvcTestChunkMs}
                                onChange={(e) => setRvcTestChunkMs(Number(e.target.value))}
                                style={rangeStyle}
                                disabled={rvcTestRunning}
                            />
                        </>
                    )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minHeight: 0 }}>
                    <div style={cardStyle}>
                        {(mode === 'sbv2' || mode === 'sbv2+rvc') && (
                            <>
                                <label style={labelStyle}>Acting Preview Script</label>
                                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                                    <select
                                        value={selectedActingPreviewScriptId}
                                        onChange={(e) => setSelectedActingPreviewScriptId(e.target.value)}
                                        style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
                                    >
                                        {activeActingPreviewScripts.map((s) => (
                                            <option key={s.id} value={s.id}>{s.label}</option>
                                        ))}
                                    </select>
                                    <button onClick={handleLoadActingPreviewScript} style={btnStyle('secondary')}>
                                        Load
                                    </button>
                                    <button
                                        onClick={() => { void handleRunActingPreview(); }}
                                        style={btnStyle('primary')}
                                        disabled={isRunningAction || actingPreviewContinuousRunning}
                                    >
                                        Load + Synthesize
                                    </button>
                                    {actingPreviewContinuousRunning && (
                                        <button
                                            onClick={handleStopActingPreviewSequence}
                                            style={btnStyle('secondary')}
                                        >
                                            Stop Sequence
                                        </button>
                                    )}
                                </div>
                                <label
                                    style={{ ...labelStyle, marginBottom: '6px' }}
                                    title="Auto EmotionがOFFでも、このボタン経由の試聴だけ一時的にAuto Emotionを適用します。"
                                >
                                    <input
                                        type="checkbox"
                                        checked={actingPreviewForceAutoEmotion}
                                        onChange={(e) => setActingPreviewForceAutoEmotion(e.target.checked)}
                                        disabled={mode !== 'sbv2'}
                                        style={{ marginRight: '8px' }}
                                    />
                                    Preview時にAuto Emotionを一時適用
                                </label>
                                <label
                                    style={{ ...labelStyle, marginBottom: '6px' }}
                                    title="Load + Synthesize 実行後、生成音声を自動再生します。"
                                >
                                    <input
                                        type="checkbox"
                                        checked={actingPreviewAutoPlay}
                                        onChange={(e) => setActingPreviewAutoPlay(e.target.checked)}
                                        style={{ marginRight: '8px' }}
                                    />
                                    Preview後に自動再生
                                </label>
                                <label
                                    style={{ ...labelStyle, marginBottom: '6px' }}
                                    title="ONで選択中スクリプトから末尾まで連続で試聴します。"
                                >
                                    <input
                                        type="checkbox"
                                        checked={actingPreviewContinuousMode}
                                        onChange={(e) => setActingPreviewContinuousMode(e.target.checked)}
                                        disabled={actingPreviewContinuousRunning}
                                        style={{ marginRight: '8px' }}
                                    />
                                    連続プレビュー（選択位置から最後まで）
                                </label>
                                <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '8px' }}>
                                    profile: {activeActingProfile.name}
                                    {mode !== 'sbv2' ? ' (force option applies in SBV2 Only mode)' : ''}
                                </div>
                                <label style={labelStyle}>Text</label>
                                <textarea
                                    value={text}
                                    onChange={(e) => setText(e.target.value)}
                                    style={{ ...inputStyle, minHeight: '90px', resize: 'vertical', marginBottom: '10px' }}
                                />
                                <label style={labelStyle}>Assist Text</label>
                                <input value={assistText} onChange={(e) => setAssistText(e.target.value)} style={inputStyle} />
                                <label
                                    style={labelStyle}
                                    title="Assist Text の効き具合です。JP-Extraでは感情誘導に効きやすいです。"
                                >
                                    Assist Text Weight: {assistTextWeight.toFixed(2)}
                                </label>
                                <input
                                    type="range"
                                    min="0.00"
                                    max="2.00"
                                    step="0.01"
                                    value={assistTextWeight}
                                    onChange={(e) => setAssistTextWeight(Number(e.target.value))}
                                    style={rangeStyle}
                                />
                                <label
                                    style={labelStyle}
                                    title="話し方の方向性を高レベル指定します。Auto Emotion併用時はこの指定が優先されます。"
                                >
                                    Direction Preset
                                </label>
                                <select
                                    value={assistDirectionPreset}
                                    onChange={(e) => setAssistDirectionPreset(e.target.value as AssistDirectionPreset)}
                                    style={inputStyle}
                                >
                                    <option value="none">none (既存互換)</option>
                                    <option value="bright">bright（明るい）</option>
                                    <option value="dark">dark（暗い）</option>
                                    <option value="joy">joy（喜）</option>
                                    <option value="anger">anger（怒）</option>
                                    <option value="sadness">sadness（哀）</option>
                                    <option value="fear">fear（不安）</option>
                                    <option value="calm">calm（穏やか）</option>
                                </select>
                                <label
                                    style={labelStyle}
                                    title="方向性の強さです。上げるほど演出は強くなりますが、不自然になるリスクも増えます。"
                                >
                                    Direction Strength: {assistDirectionStrength.toFixed(2)}
                                </label>
                                <input
                                    type="range"
                                    min="0.00"
                                    max="1.00"
                                    step="0.01"
                                    value={assistDirectionStrength}
                                    onChange={(e) => setAssistDirectionStrength(Number(e.target.value))}
                                    style={rangeStyle}
                                    disabled={assistDirectionPreset === 'none'}
                                />
                                <label
                                    style={labelStyle}
                                    title="長文時に文脈を解析し、Direction Preset / Strength / Assist Weight を自動最適化します。"
                                >
                                    <input
                                        type="checkbox"
                                        checked={assistDirectionAutoOptimize}
                                        onChange={(e) => setAssistDirectionAutoOptimize(e.target.checked)}
                                        style={{ marginRight: '8px' }}
                                    />
                                    Auto Optimize Direction Params (Long Text)
                                </label>
                                {assistDirectionPreset === 'none' ? (
                                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '8px' }}>
                                        Direction Preset が none のため、既存の Assist Text 動作を維持します。
                                    </div>
                                ) : (
                                    <div
                                        style={{
                                            fontSize: '11px',
                                            color: assistDirectionStrength >= 0.85 ? '#fca5a5' : '#94a3b8',
                                            marginBottom: '8px',
                                        }}
                                    >
                                        Auto Emotion と競合する場合は Direction Preset を優先します。
                                        {assistDirectionStrength >= 0.85 ? ' 強度が高いため過演出に注意。' : ''}
                                    </div>
                                )}
                            </>
                        )}

                        {mode === 'rvc' && (
                            <>
                                <label style={labelStyle}>Input WAV ({rvcInputPaths.length} file{rvcInputPaths.length !== 1 ? 's' : ''})</label>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                    <input
                                        value={rvcInputPaths.length === 1 ? rvcInputPaths[0] : (rvcInputPaths.length > 1 ? `${rvcInputPaths.length} files selected` : '')}
                                        onChange={(e) => setRvcInputPaths(e.target.value ? [e.target.value] : [])}
                                        style={{ ...inputStyle, flex: 1 }}
                                        placeholder="C:\\path\\to\\input.wav (multiple select OK)"
                                    />
                                    <button onClick={handlePickRvcInput} style={btnStyle('secondary')}>Browse</button>
                                    <button onClick={() => setRvcInputPaths(lastSbv2WavPath ? [lastSbv2WavPath] : [])} style={btnStyle('secondary')} disabled={!lastSbv2WavPath}>Use SBV2</button>
                                    {rvcInputPaths.length > 0 && <button onClick={() => setRvcInputPaths([])} style={btnStyle('secondary')}>Clear</button>}
                                </div>
                                {rvcInputPaths.length > 1 && (
                                    <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px', maxHeight: '60px', overflowY: 'auto' }}>
                                        {rvcInputPaths.map((p, i) => <div key={i}>{i + 1}. {p.split(/[/\\]/).pop()}</div>)}
                                    </div>
                                )}
                                {rvcBatchProgress && (
                                    <div style={{ fontSize: '12px', color: '#60a5fa', marginTop: '4px' }}>
                                        Processing {rvcBatchProgress.current}/{rvcBatchProgress.total}...
                                    </div>
                                )}
                            </>
                        )}

                        <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => { void handleSynthesize(); }}
                                disabled={isRunningAction}
                                style={{ ...btnStyle('primary'), padding: '12px 26px', fontSize: '15px' }}
                            >
                                {isRunningAction ? 'Processing...' : (mode === 'rvc' ? 'Convert' : 'Synthesize')}
                            </button>
                        </div>
                    </div>

                    <div style={cardStyle}>
                        <h3 style={sectionTitleStyle}>Audio Output</h3>
                        {mode === 'sbv2+rvc' && intermediateAudioUrl && (
                            <div style={{ marginBottom: '12px' }}>
                                <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>Intermediate (SBV2)</div>
                                <audio controls src={intermediateAudioUrl} style={{ width: '100%' }} />
                            </div>
                        )}
                        {audioUrl ? (
                            <audio ref={outputAudioElementRef} controls src={audioUrl} style={{ width: '100%' }} />
                        ) : (
                            <div style={{ color: '#9ca3af', fontSize: '13px' }}>No audio generated yet.</div>
                        )}
                    </div>

                    <div style={{ ...cardStyle, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={sectionTitleStyle}>Logs</h3>
                            <button onClick={() => setLogs([])} style={btnStyle('secondary')}>Clear</button>
                        </div>
                        <div style={{
                            marginTop: '8px',
                            flex: 1,
                            overflowY: 'auto',
                            backgroundColor: '#111827',
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            padding: '10px',
                            fontFamily: 'Consolas, monospace',
                            fontSize: '12px',
                        }}>
                            {logs.map((log, i) => <div key={`${i}-${log}`}>{log}</div>)}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '14px',
    padding: '16px',
};

const sectionTitleStyle: React.CSSProperties = {
    margin: 0,
    marginBottom: '10px',
    fontSize: '14px',
    color: '#cbd5e1',
};

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '12px',
    color: '#94a3b8',
    marginBottom: '4px',
    marginTop: '10px',
};

const inputStyle: React.CSSProperties = {
    width: '100%',
    backgroundColor: '#1f2937',
    border: '1px solid #374151',
    color: '#f9fafb',
    borderRadius: '8px',
    padding: '8px 10px',
};

const rangeStyle: React.CSSProperties = {
    width: '100%',
};

const rowStyle: React.CSSProperties = {
    display: 'flex',
    gap: '8px',
    marginBottom: '8px',
};

const presetBtnStyle: React.CSSProperties = {
    width: '100%',
    textAlign: 'left',
    padding: '8px',
    backgroundColor: '#374151',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
};

const badgeStyle: React.CSSProperties = {
    color: '#fff',
    fontSize: '11px',
    borderRadius: '999px',
    padding: '4px 10px',
    fontWeight: 700,
};

const tabStyle = (active: boolean): React.CSSProperties => ({
    border: '1px solid #374151',
    borderRadius: '8px',
    padding: '8px 12px',
    cursor: 'pointer',
    backgroundColor: active ? '#2563eb' : '#1f2937',
    color: '#fff',
    fontWeight: 600,
});

const btnStyle = (variant: 'primary' | 'secondary' | 'danger'): React.CSSProperties => {
    const base: React.CSSProperties = {
        border: 'none',
        borderRadius: '8px',
        padding: '8px 12px',
        cursor: 'pointer',
        color: '#fff',
        fontWeight: 600,
    };
    if (variant === 'primary') return { ...base, backgroundColor: '#2563eb' };
    if (variant === 'danger') return { ...base, backgroundColor: '#dc2626' };
    return { ...base, backgroundColor: '#374151' };
};

export default VoiceStudioScreen;
