import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

interface DailyUsage {
    date: string; // YYYY-MM-DD
    geminiRequests: number;
    geminiTokens: number;
    speechMinutes: number; // For the whole month ideally, but let's track daily for granular data + monthly aggregation
}



interface UsageData {
    daily: DailyUsage[];
}

class UsageStore {
    private filePath: string;
    private data: UsageData;

    constructor() {
        this.filePath = path.join(app.getPath('userData'), 'usage.json');
        this.data = this.loadData();
    }

    private loadData(): UsageData {
        try {
            if (fs.existsSync(this.filePath)) {
                return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            }
        } catch (error) {
            console.error('Failed to load usage data:', error);
        }
        return { daily: [] };
    }

    private saveData(): void {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (error) {
            console.error('Failed to save usage data:', error);
        }
    }

    private getTodayStr(): string {
        return new Date().toISOString().split('T')[0];
    }

    private getMonthStr(): string {
        return this.getTodayStr().slice(0, 7); // YYYY-MM
    }

    private getTodayRecord(): DailyUsage {
        const today = this.getTodayStr();
        let record = this.data.daily.find(d => d.date === today);
        if (!record) {
            record = { date: today, geminiRequests: 0, geminiTokens: 0, speechMinutes: 0 };
            this.data.daily.push(record);
            // Keep only last 60 days to avoid infinite growth
            if (this.data.daily.length > 60) {
                this.data.daily.shift();
            }
        }
        return record;
    }

    trackGeminiUsage(tokens: number): void {
        const record = this.getTodayRecord();
        record.geminiRequests += 1;
        record.geminiTokens += tokens;
        this.saveData();
    }

    trackSpeechUsage(seconds: number): void {
        const record = this.getTodayRecord();
        record.speechMinutes += seconds / 60;
        this.saveData();
    }

    getUsageStats() {
        const today = this.getTodayStr();
        const month = this.getMonthStr();

        const dailyRecord = this.data.daily.find(d => d.date === today) || { geminiRequests: 0, geminiTokens: 0, speechMinutes: 0 };

        // Calculate monthly totals
        const monthlyRecord = this.data.daily
            .filter(d => d.date.startsWith(month))
            .reduce((acc, curr) => ({
                geminiRequests: acc.geminiRequests + curr.geminiRequests,
                geminiTokens: acc.geminiTokens + curr.geminiTokens,
                speechMinutes: acc.speechMinutes + curr.speechMinutes
            }), { geminiRequests: 0, geminiTokens: 0, speechMinutes: 0 });

        return {
            today: dailyRecord,
            month: monthlyRecord,
            limits: {
                geminiFreeRequests: 1500, // Daily limit
                speechFreeMinutes: 60,    // Monthly limit (standard free tier)
            }
        };
    }
}

export const usageStore = new UsageStore();
