/**
 * 調査サービス
 * Gemini API を使用してテキストの意味や背景情報を調査する
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ResearchResult } from '../types';

class ResearchService {
    private genAI: GoogleGenerativeAI | null = null;
    private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;
    private history: ResearchResult[] = [];
    private maxHistorySize = 10;

    /**
     * API キーで初期化
     */
    initialize(apiKey: string): void {
        if (!apiKey) {
            throw new Error('API キーが設定されていません');
        }
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    }

    /**
     * テキストを調査
     */
    async research(query: string): Promise<ResearchResult> {
        if (!this.model) {
            throw new Error('ResearchService が初期化されていません');
        }

        // 短すぎるテキストのチェック
        const trimmedQuery = query.trim();
        if (trimmedQuery.length < 2) {
            return {
                query: trimmedQuery,
                summary: '',
                details: [],
                error: 'テキストが短すぎます。2文字以上選択してください。',
            };
        }

        try {
            const prompt = `
以下のテキストについて調査し、JSON形式で回答してください。

調査対象: "${trimmedQuery}"

回答形式（必ずこの形式で回答）:
{
  "summary": "1〜3文での簡潔な説明",
  "details": [
    "詳細情報1",
    "詳細情報2",
    "詳細情報3"
  ],
  "relatedLinks": [
    {"title": "関連リンクのタイトル", "url": "https://..."},
  ]
}

注意事項:
- 専門用語や略語の場合は、正式名称と意味を説明してください
- 人名、地名、組織名の場合は、背景情報を含めてください
- 技術用語の場合は、用途や使い方も説明してください
- 関連リンクは実在する信頼性の高いサイトのみ（Wikipedia、公式サイトなど）を1〜3件
- 該当する情報が見つからない場合は、summaryに「該当する情報が見つかりませんでした」と記載
`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();

            // JSON を抽出してパース
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('有効な応答を取得できませんでした');
            }

            const parsed = JSON.parse(jsonMatch[0]);

            const researchResult: ResearchResult = {
                query: trimmedQuery,
                summary: parsed.summary || '',
                details: parsed.details || [],
                relatedLinks: parsed.relatedLinks || [],
            };

            // 履歴に追加
            this.addToHistory(researchResult);

            return researchResult;

        } catch (error) {
            console.error('Research error:', error);

            const result: ResearchResult = {
                query: trimmedQuery,
                summary: '',
                details: [],
                error: error instanceof Error ? error.message : '調査中にエラーが発生しました',
            };

            return result;
        }
    }

    /**
     * 履歴に追加
     */
    private addToHistory(result: ResearchResult): void {
        this.history.unshift(result);
        if (this.history.length > this.maxHistorySize) {
            this.history.pop();
        }
    }

    /**
     * 履歴を取得
     */
    getHistory(): ResearchResult[] {
        return [...this.history];
    }

    /**
     * 履歴をクリア
     */
    clearHistory(): void {
        this.history = [];
    }

    /**
     * 初期化済みかどうか
     */
    isInitialized(): boolean {
        return this.model !== null;
    }

    /**
     * テキストを要約
     */
    async generateSummary(text: string, contextTag?: string): Promise<string> {
        if (!this.model) {
            throw new Error('ResearchService が初期化されていません');
        }

        const contextHint = contextTag && contextTag !== 'free'
            ? `これは「${contextTag}」の文脈での会話です。`
            : '';

        const prompt = `
${contextHint}
以下のテキストを簡潔に要約してください。

テキスト:
"""
${text}
"""

要約のポイント:
- 主要なポイントを3〜5点で箇条書き
- 重要なキーワードや数値は保持
- 全体を200文字以内で要約

回答形式（箇条書きで）:
`;

        try {
            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error) {
            console.error('Summary generation error:', error);
            throw error;
        }
    }

    /**
     * 議事録を生成
     */
    async generateMeetingNotes(text: string, contextTag?: string): Promise<string> {
        if (!this.model) {
            throw new Error('ResearchService が初期化されていません');
        }

        const contextHint = contextTag && contextTag !== 'free'
            ? `これは「${contextTag}」の文脈での会話です。`
            : '';

        const prompt = `
${contextHint}
以下のテキストから議事録・ミーティングノートを作成してください。

テキスト:
"""
${text}
"""

議事録フォーマット:
## 議題・テーマ
（話し合われた主なテーマ）

## 主要なポイント
- ポイント1
- ポイント2
- ポイント3

## 決定事項
- 決定事項があれば記載

## アクションアイテム
- 誰が何をいつまでにやるか（言及されている場合）

## 次のステップ
- 今後の予定や次回について（言及されている場合）

注意: テキストから読み取れる情報のみを記載し、推測は避けてください。
`;

        try {
            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error) {
            console.error('Meeting notes generation error:', error);
            throw error;
        }
    }
}

export const researchService = new ResearchService();
