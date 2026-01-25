import React from 'react';
import type { AudioDevice } from '../types';

interface AudioDeviceSelectorProps {
    devices: AudioDevice[];
    selectedDeviceId: string | null;
    onDeviceChange: (deviceId: string) => void;
    disabled?: boolean;
    onRefresh: () => void;
}

export const AudioDeviceSelector: React.FC<AudioDeviceSelectorProps> = ({
    devices,
    selectedDeviceId,
    onDeviceChange,
    disabled = false,
    onRefresh,
}) => {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="select-wrapper">
                <select
                    className="select"
                    value={selectedDeviceId || ''}
                    onChange={(e) => onDeviceChange(e.target.value)}
                    disabled={disabled}
                >
                    <option value="" disabled>
                        オーディオデバイスを選択
                    </option>
                    {devices.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `デバイス ${device.deviceId.slice(0, 8)}...`}
                        </option>
                    ))}
                </select>
                <span className="select-arrow">▼</span>
            </div>
            <button
                className="btn btn-icon"
                onClick={onRefresh}
                disabled={disabled}
                title="デバイス一覧を更新"
                style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)' }}
            >
                🔄
            </button>
        </div>
    );
};
