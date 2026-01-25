import React from 'react';
import type { DesktopSource } from '../types';

interface SourceSelectorProps {
    sources: DesktopSource[];
    selectedSourceId: string | null;
    onSourceChange: (sourceId: string) => void;
    disabled?: boolean;
    onRefresh: () => void;
}

export const SourceSelector: React.FC<SourceSelectorProps> = ({
    sources,
    selectedSourceId,
    onSourceChange,
    disabled = false,
    onRefresh,
}) => {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="select-wrapper">
                <select
                    className="select"
                    value={selectedSourceId || ''}
                    onChange={(e) => onSourceChange(e.target.value)}
                    disabled={disabled}
                >
                    <option value="" disabled>
                        画面を選択してください
                    </option>
                    {sources.map((source) => (
                        <option key={source.id} value={source.id}>
                            {source.name}
                        </option>
                    ))}
                </select>
                <span className="select-arrow">▼</span>
            </div>
            <button
                className="btn btn-icon"
                onClick={onRefresh}
                disabled={disabled}
                title="画面一覧を更新"
                style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)' }}
            >
                🔄
            </button>
        </div>
    );
};
