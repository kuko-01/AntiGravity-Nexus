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
                AntiGravity Nexus
            </h1>

            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '16px',
                width: '100%',
                maxWidth: '900px',
            }}>
                {/* Audio Capture Card */}
                <div
                    onClick={() => handleNavigate('/capture')}
                    style={{
                        background: 'var(--color-surface)',
                        borderRadius: '12px',
                        padding: '24px',
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
                        fontSize: '3rem',
                        marginBottom: '12px'
                    }}>
                        🎙️
                    </div>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '4px', color: 'var(--color-text)' }}>
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
                        borderRadius: '12px',
                        padding: '24px',
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
                        fontSize: '3rem',
                        marginBottom: '12px'
                    }}>
                        📂
                    </div>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '4px', color: 'var(--color-text)' }}>
                        フォルダ整理
                    </h2>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        AIが散らかったフォルダを解析し、整理された構造を提案します。
                    </p>
                </div>

                {/* Nano Studio Card */}
                <div
                    onClick={() => handleNavigate('/nano')}
                    style={{
                        background: 'var(--color-surface)',
                        borderRadius: '12px',
                        padding: '24px',
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
                        fontSize: '3rem',
                        marginBottom: '12px'
                    }}>
                        🎨
                    </div>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '4px', color: 'var(--color-text)' }}>
                        Nano Studio
                    </h2>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        Gemini 2.5 Flashで高品質な画像を生成します。
                    </p>
                </div>

                {/* AI Character Card */}
                <div
                    onClick={() => handleNavigate('/character')}
                    style={{
                        background: 'var(--color-surface)',
                        borderRadius: '12px',
                        padding: '24px',
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
                        fontSize: '3rem',
                        marginBottom: '12px'
                    }}>
                        🦊
                    </div>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '4px', color: 'var(--color-text)' }}>
                        AI Character
                    </h2>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        テキスト会話とSBV2+RVC音声でキャラクター対話を行います。
                    </p>
                </div>


                {/* Model Trainer Card */}
                <div
                    onClick={() => handleNavigate('/trainer')}
                    style={{
                        background: 'var(--color-surface)',
                        borderRadius: '12px',
                        padding: '24px',
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
                        fontSize: '3rem',
                        marginBottom: '12px'
                    }}>
                        🧠
                    </div>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '4px', color: 'var(--color-text)' }}>
                        Model Trainer
                    </h2>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        自分だけの音声モデルを作成・学習します (Beta)。
                    </p>
                </div>

                {/* Voice Studio Card */}
                <div
                    onClick={() => handleNavigate('/tts')}
                    style={{
                        background: 'var(--color-surface)',
                        borderRadius: '12px',
                        padding: '24px',
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
                        fontSize: '3rem',
                        marginBottom: '12px'
                    }}>
                        🗣️
                    </div>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '4px', color: 'var(--color-text)' }}>
                        Voice Studio
                    </h2>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        Style-Bert-VITS2による高品質なローカル音声合成。
                    </p>
                </div>

                {/* Live2D Controller Card */}
                <div
                    onClick={() => handleNavigate('/live2d')}
                    style={{
                        background: 'var(--color-surface)',
                        borderRadius: '12px',
                        padding: '24px',
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
                        fontSize: '3rem',
                        marginBottom: '12px'
                    }}>
                        👾
                    </div>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '4px', color: 'var(--color-text)' }}>
                        Live2D Controller
                    </h2>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        Unityホスト経由でLive2Dモデルを制御します。
                    </p>
                </div>
            </div>
        </div>
    );
};

export default HomeScreen;
