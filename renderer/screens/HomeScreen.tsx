import React from 'react';
import { useNavigate } from 'react-router-dom';

const HomeScreen: React.FC = () => {
    const navigate = useNavigate();

    const handleNavigate = (path: string) => {
        navigate(path);
    };

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            background: 'var(--color-bg-secondary)', // Use theme background
            color: 'var(--color-text)',
            padding: '24px'
        }}>
            <h1 style={{
                fontSize: '2.5rem',
                marginBottom: '48px',
                background: 'linear-gradient(45deg, #4f46e5, #ec4899)', // Similar to app accent
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                fontWeight: 'bold'
            }}>
                Gemini Tools Hub
            </h1>

            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '24px',
                width: '100%',
                maxWidth: '800px',
            }}>
                {/* Audio Capture Card */}
                <div
                    onClick={() => handleNavigate('/capture')}
                    style={{
                        background: 'var(--color-surface)',
                        borderRadius: '16px',
                        padding: '32px',
                        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                        cursor: 'pointer',
                        transition: 'transform 0.2s, box-shadow 0.2s',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        textAlign: 'center',
                        border: '1px solid var(--color-border)'
                    }}
                    onMouseEnter={e => {
                        e.currentTarget.style.transform = 'translateY(-5px)';
                        e.currentTarget.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)';
                    }}
                    onMouseLeave={e => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)';
                    }}
                >
                    <div style={{
                        fontSize: '4rem',
                        marginBottom: '16px'
                    }}>
                        🎙️
                    </div>
                    <h2 style={{ fontSize: '1.5rem', marginBottom: '8px', color: 'var(--color-text)' }}>
                        音声キャプチャ
                    </h2>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        PC音声やマイク入力からリアルタイムで文字起こしを行います。
                    </p>
                </div>

                {/* Folder Organizer Card */}
                <div
                    onClick={() => handleNavigate('/organizer')}
                    style={{
                        background: 'var(--color-surface)',
                        borderRadius: '16px',
                        padding: '32px',
                        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                        cursor: 'pointer',
                        transition: 'transform 0.2s, box-shadow 0.2s',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        textAlign: 'center',
                        border: '1px solid var(--color-border)'
                    }}
                    onMouseEnter={e => {
                        e.currentTarget.style.transform = 'translateY(-5px)';
                        e.currentTarget.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)';
                    }}
                    onMouseLeave={e => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)';
                    }}
                >
                    <div style={{
                        fontSize: '4rem',
                        marginBottom: '16px'
                    }}>
                        📂
                    </div>
                    <h2 style={{ fontSize: '1.5rem', marginBottom: '8px', color: 'var(--color-text)' }}>
                        フォルダ整理
                    </h2>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        AIが散らかったフォルダを解析し、整理された構造を提案します。
                    </p>
                </div>
            </div>
        </div>
    );
};

export default HomeScreen;
