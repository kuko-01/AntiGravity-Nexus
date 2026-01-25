import React from 'react';

interface ResearchButtonProps {
    selectedText: string;
    isLoading: boolean;
    onClick: () => void;
}

export const ResearchButton: React.FC<ResearchButtonProps> = ({
    selectedText,
    isLoading,
    onClick,
}) => {
    const hasSelection = selectedText.length > 0;

    return (
        <div className="research-button-container">
            <div className="selected-text-preview">
                {hasSelection ? (
                    <>
                        選択中：<span>「{selectedText.slice(0, 30)}{selectedText.length > 30 ? '...' : ''}」</span>
                    </>
                ) : (
                    'テキストを選択してください'
                )}
            </div>
            <button
                className="btn btn-primary"
                onClick={onClick}
                disabled={!hasSelection || isLoading}
            >
                {isLoading ? (
                    <>
                        <span className="spinner" style={{ width: 16, height: 16 }}></span>
                        調査中...
                    </>
                ) : (
                    <>
                        🔍 調査
                    </>
                )}
            </button>
        </div>
    );
};
