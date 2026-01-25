import React from 'react';
import type { ResearchResult } from '../types';

interface ResearchPanelProps {
    result: ResearchResult | null;
    isLoading: boolean;
}

export const ResearchPanel: React.FC<ResearchPanelProps> = ({ result, isLoading }) => {
    if (isLoading) {
        return (
            <div className="research-empty">
                <div className="spinner"></div>
                <p>調査中...</p>
            </div>
        );
    }

    if (!result) {
        return (
            <div className="research-empty">
                <span className="research-empty-icon">🔍</span>
                <div>
                    <p>調査結果がありません</p>
                    <p style={{ fontSize: '0.8rem', marginTop: '8px' }}>
                        ログ内のテキストを選択して「調査」ボタンを押してください
                    </p>
                </div>
            </div>
        );
    }

    if (result.error) {
        return (
            <div className="research-result">
                <div className="research-query">
                    検索ワード：<span className="research-query-text">{result.query}</span>
                </div>
                <div className="research-error">
                    <span>⚠️</span>
                    {result.error}
                </div>
            </div>
        );
    }

    return (
        <div className="research-result">
            <div className="research-query">
                検索ワード：<span className="research-query-text">{result.query}</span>
            </div>

            {result.summary && (
                <div
                    className="research-summary"
                    style={{
                        whiteSpace: 'pre-wrap',
                        lineHeight: '1.6',
                        fontSize: '0.95rem',
                    }}
                >
                    {result.summary}
                </div>
            )}

            {result.details && result.details.length > 0 && (
                <div className="research-details">
                    {result.details.map((detail, index) => (
                        <div key={index} className="research-detail-item">
                            {detail}
                        </div>
                    ))}
                </div>
            )}

            {result.relatedLinks && result.relatedLinks.length > 0 && (
                <div className="research-links">
                    <div className="research-links-title">関連リンク</div>
                    {result.relatedLinks.map((link, index) => (
                        <a
                            key={index}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="research-link"
                            onClick={(e) => {
                                e.preventDefault();
                                // Electron では外部リンクをシェルで開く
                                window.open(link.url, '_blank');
                            }}
                        >
                            🔗 {link.title}
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
};
