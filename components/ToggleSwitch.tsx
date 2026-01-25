import React from 'react';

interface ToggleSwitchProps {
    isOn: boolean;
    onChange: (isOn: boolean) => void;
    disabled?: boolean;
    label?: string;
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
    isOn,
    onChange,
    disabled = false,
    label,
}) => {
    const handleChange = () => {
        if (!disabled) {
            onChange(!isOn);
        }
    };

    return (
        <div className="toggle-container">
            {label && <span className="toggle-label">{label}</span>}
            <label className="toggle-switch">
                <input
                    type="checkbox"
                    className="toggle-input"
                    checked={isOn}
                    onChange={handleChange}
                    disabled={disabled}
                />
                <span className="toggle-slider"></span>
            </label>
            <span
                style={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    color: isOn ? 'var(--color-success)' : 'var(--color-text-muted)',
                }}
            >
                {isOn ? 'ON' : 'OFF'}
            </span>
        </div>
    );
};
