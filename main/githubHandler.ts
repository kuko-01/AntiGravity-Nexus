import { simpleGit, SimpleGit } from 'simple-git';
import { Octokit } from '@octokit/rest';
import * as fs from 'fs';
import * as path from 'path';

class GitHubHandlerService {
    private octokit: Octokit | null = null;
    private user: string | null = null;

    initialize(token: string) {
        if (!token) return;

        this.octokit = new Octokit({ auth: token });

        // Get authenticated user
        this.octokit.users.getAuthenticated().then(({ data }) => {
            this.user = data.login;
            console.log(`[GitHub] Authenticated as ${this.user}`);
        }).catch(err => {
            console.error('[GitHub] Auth failed:', err);
        });
    }

    /**
     * リポジトリの初期化と作成（Private強制）
     */
    async initRepo(localPath: string, repoName: string): Promise<{ success: boolean; url?: string; error?: string }> {
        if (!this.octokit || !this.user) {
            return { success: false, error: 'Not authenticated' };
        }

        try {
            const git: SimpleGit = simpleGit(localPath);
            await git.init();

            // .gitignore の存在確認・作成 (簡易)
            const gitignorePath = path.join(localPath, '.gitignore');
            if (!fs.existsSync(gitignorePath)) {
                fs.writeFileSync(gitignorePath, "node_modules\n.env\n.DS_Store\n");
            }

            // GitHub上にリポジトリ作成 (Private)
            // Policy: Enforce Private
            const response = await this.octokit.repos.createForAuthenticatedUser({
                name: repoName,
                private: true, // FORCE PRIVATE
                auto_init: false
            });

            const remoteUrl = response.data.clone_url;

            // リモート追加 & Push
            await git.addRemote('origin', remoteUrl);
            await git.add('.');
            await git.commit('Initial commit by Gemini GitHub Manager');
            await git.branch(['-M', 'main']);
            await git.push('origin', 'main');

            return { success: true, url: response.data.html_url };
        } catch (error) {
            console.error('[GitHub] Init Repo Error:', error);
            return { success: false, error: String(error) };
        }
    }

    async getStatus(localPath: string) {
        try {
            const git = simpleGit(localPath);
            const isRepo = await git.checkIsRepo();
            if (!isRepo) return { isRepo: false };

            const status = await git.status();
            return { isRepo: true, status };
        } catch (error) {
            return { isRepo: false, error: String(error) };
        }
    }
}

export const githubHandlerService = new GitHubHandlerService();
