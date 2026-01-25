import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AnalysisResult, CopyPlanItem, SuggestedStructure, OrganizerFile } from '../types';

class FolderOrganizerService {
    private genAI: GoogleGenerativeAI | null = null;
    private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;

    initialize(apiKey: string) {
        if (!apiKey) throw new Error('API Key required');
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({
            model: 'gemini-2.0-flash-exp',
            generationConfig: { responseMimeType: 'application/json' }
        });
    }

    /**
     * フォルダを解析
     */
    async analyzeFolder(path: string): Promise<AnalysisResult> {
        const result = await window.electronAPI.organizerAnalyzeFolder(path);
        if (!result.success || !result.files || !result.stats) {
            throw new Error(result.error || 'Failed to analyze folder');
        }
        return { files: result.files, stats: result.stats };
    }

    /**
     * AIを使用してフォルダ構造を提案
     */
    async suggestStructure(files: OrganizerFile[], mode: 'conservative' | 'standard' | 'aggressive' = 'standard', useDeepAnalysis: boolean = false): Promise<SuggestedStructure> {
        if (!this.model) throw new Error('Service not initialized');

        // ファイルリストを簡略化してプロンプトに含める
        // NOTE: ファイル数が多すぎる場合は間引くか、代表的なものだけ送る必要がある
        // Token制限回避のため、解析対象を先頭50件に制限し、残りはルールベースで処理する

        const simplifiedFiles = await Promise.all(files.slice(0, 50).map(async (f) => {
            const basicInfo = {
                name: f.name,
                ext: f.extension,
                year: new Date(f.mtime).getFullYear(),
            };

            // Deep Analysis: 詳細解析モード（Aggressive選択時のみ有効化を想定）
            // PDF, Word, Excel, PPTX などのテキストを読み取る
            if (useDeepAnalysis && ['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.log'].includes(f.extension.toLowerCase())) {
                try {
                    const result = await window.electronAPI.organizerReadContent(f.path);
                    if (result.success && result.text) {
                        return { ...basicInfo, content: result.text.slice(0, 500) }; // 先頭500文字だけ送信
                    }
                } catch (e) {
                    console.warn(`Failed to read content for ${f.name}`, e);
                }
            }
            return basicInfo;
        }));

        const prompt = `
以下のファイルリストを整理するためのフォルダ構造を提案してください。
整理モード: ${mode}
${useDeepAnalysis ? '★詳細解析モード有効: ファイルの中身(content)も考慮して分類してください。' : ''}

モード定義:
- conservative: 最小限の変更（拡張子別など）
- standard: 一般的なベストプラクティス（「Documents/Report」や「Images/2024」など）
- aggressive: ファイル名や日付から文脈を深く推測して細かく分類${useDeepAnalysis ? '。中身のテキスト情報も活用して、プロジェクト名や内容に基づいたフォルダを作成してください。' : ''}

ファイルリスト:
${JSON.stringify(simplifiedFiles, null, 2)}

回答は以下のJSON形式のみで出力してください:
{
  "summary": "提案の概要（1行）",
  "items": [
    { "sourcePath": "元のファイル名", "destinationPath": "推奨相対パス/ファイル名", "reason": "理由" }
  ]
}
注意: sourcePathは入力リストのnameと完全に一致させてください。destinationPathは新しいフォルダ構造を含みます。
`;

        try {
            const result = await this.model.generateContent(prompt);
            const response = result.response;
            const text = response.text(); // JSON mode returns raw JSON, no markdown
            const parsed = JSON.parse(text);

            // 1. AIの結果（ファイル名）をフルパスに変換
            const fileMap = new Map(files.map(f => [f.name, f.path]));
            const aiItemsWithFullPath = parsed.items.map((item: any) => {
                const fullPath = fileMap.get(item.sourcePath);
                if (!fullPath) return null;
                return {
                    ...item,
                    sourcePath: fullPath
                };
            }).filter((i: any) => i !== null) as CopyPlanItem[];

            // 2. AIが処理しなかった残りのファイルを特定（フルパスで比較）
            const handledPaths = new Set(aiItemsWithFullPath.map((i) => i.sourcePath));
            const remainingFiles = files.filter(f => !handledPaths.has(f.path));

            // 3. 残りのファイルをルールベースで処理
            const heuristicsItems = this.applyHeuristics(remainingFiles, mode);

            return {
                summary: parsed.summary,
                items: [...aiItemsWithFullPath, ...heuristicsItems]
            };
        } catch (error) {
            console.error('AI Suggestion error:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            // AI失敗時はルールベースのみで返す
            return {
                summary: `AI提案に失敗しました (${errorMessage})。ルールベースで分類します。`,
                items: this.applyHeuristics(files, mode)
            };
        }
    }

    /**
     * ルールベースでの簡易分類（AIの補助・フォールバック）
     */
    private applyHeuristics(files: OrganizerFile[], mode: string): CopyPlanItem[] {
        return files.map(f => {
            let folder = 'Others';
            const ext = f.extension.toLowerCase();

            if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp'].includes(ext)) folder = 'Images';
            else if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) folder = 'Videos';
            else if (['.mp3', '.wav', '.aac', '.m4a'].includes(ext)) folder = 'Audio';
            else if (['.doc', '.docx', '.pdf', '.txt', '.md', '.xlsx', '.pptx'].includes(ext)) folder = 'Documents';
            else if (['.zip', '.rar', '.7z', '.tar'].includes(ext)) folder = 'Archives';
            else if (['.exe', '.msi', '.bat', '.sh'].includes(ext)) folder = 'Apps';

            // standard/aggressiveモードなら日付サブフォルダを追加
            if (mode !== 'conservative' && folder !== 'Others') {
                const year = new Date(f.mtime).getFullYear();
                folder = `${folder}/${year}`;
            }

            return {
                sourcePath: f.path, // 注意: AIプロンプトではnameを使ったが、実際のプランにはfull pathが必要
                // ここでは heuristics なので full path がある前提
                // AIの結果とマージする際は name -> full path のマッピングが必要
                destinationPath: `${folder}/${f.name}`,
                reason: 'Extension-based heuristic'
            };
        });
    }



    async executeCopy(plan: CopyPlanItem[], outputRoot: string) {
        return await window.electronAPI.organizerExecuteCopy(plan, outputRoot);
    }
}

export const folderOrganizerService = new FolderOrganizerService();
