import React, { useState, useEffect, useRef } from 'react';

const Live2DControllerScreen: React.FC = () => {
    const [status, setStatus] = useState<any>(null);
    const [logs, setLogs] = useState<any[]>([]);
    const [modelPath, setModelPath] = useState('');
    const [paramId, setParamId] = useState('ParamAngleX');
    const [paramValue, setParamValue] = useState(0);

    const logEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Subscribe to events
        const unsubscribe = window.electronAPI.cubismOnEvent((event: any) => {
            if (event.type === 'Event' && event.name === 'Host.Status') {
                setStatus(event.payload);
            } else {
                setLogs(prev => [...prev.slice(-99), event]); // Keep last 100
            }
        });

        // Initial Ping
        window.electronAPI.cubismSendCommand('Command', 'Host.Ping', {});

        return () => {
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    const handleLoadModel = async () => {
        if (!modelPath) return;
        addToLog('Sending Model.Load: ' + modelPath);
        await window.electronAPI.cubismSendCommand('Command', 'Model.Load', { path: modelPath });
    };

    const handleParamChange = async (val: number) => {
        setParamValue(val);
        // Throttle? For now direct send.
        await window.electronAPI.cubismSendCommand('Command', 'Param.Set', { id: paramId, value: val });
    };

    const addToLog = (msg: string) => {
        setLogs(prev => [...prev.slice(-99), { type: 'Local', name: 'Info', payload: { message: msg }, ts: new Date().toISOString() }]);
    }

    return (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#111', color: '#eee', padding: '20px' }}>
            <h1 style={{ marginBottom: '20px' }}>Live2D Controller</h1>

            {/* Status Panel */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '20px', padding: '10px', background: '#222', borderRadius: '8px' }}>
                <div>FPS: {status?.fps?.toFixed(1) || '--'}</div>
                <div>Memory: {status?.memoryMb?.toFixed(1) || '--'} MB</div>
                <div>Model: {status?.activeModel || 'None'}</div>
                <div>Motion: {status?.activeMotion || 'None'}</div>
            </div>

            <div style={{ display: 'flex', flex: 1, gap: '20px', minHeight: 0 }}>
                {/* Controls */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>

                    {/* Model Loader */}
                    <div style={{ padding: '15px', background: '#222', borderRadius: '8px' }}>
                        <h3>Load Model</h3>
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <input
                                type="text"
                                value={modelPath}
                                onChange={(e) => setModelPath(e.target.value)}
                                placeholder="C:\AG\Models\MyModel\model3.json"
                                style={{ flex: 1, padding: '8px', background: '#333', color: 'white', border: '1px solid #444', borderRadius: '4px' }}
                            />
                            <button onClick={handleLoadModel} style={{ padding: '8px 16px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                                Load
                            </button>
                        </div>
                    </div>

                    {/* Param Tester */}
                    <div style={{ padding: '15px', background: '#222', borderRadius: '8px' }}>
                        <h3>Parameter Test</h3>
                        <div style={{ marginBottom: '10px' }}>
                            <label>ID: </label>
                            <input
                                type="text"
                                value={paramId}
                                onChange={(e) => setParamId(e.target.value)}
                                style={{ padding: '4px', background: '#333', color: 'white', border: '1px solid #444' }}
                            />
                        </div>
                        <input
                            type="range"
                            min="-30"
                            max="30"
                            step="0.1"
                            value={paramValue}
                            onChange={(e) => handleParamChange(parseFloat(e.target.value))}
                            style={{ width: '100%' }}
                        />
                        <div style={{ textAlign: 'center' }}>{paramValue.toFixed(1)}</div>
                    </div>

                </div>

                {/* Logs */}
                <div style={{ flex: 1, background: '#000', borderRadius: '8px', padding: '10px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {logs.map((log, i) => (
                        <div key={i} style={{ marginBottom: '4px', borderBottom: '1px solid #222', paddingBottom: '4px' }}>
                            <span style={{ color: '#888' }}>[{new Date(log.ts).toLocaleTimeString()}]</span>
                            <span style={{ color: log.type === 'Command' ? '#60a5fa' : log.type === 'Event' ? '#34d399' : '#f472b6', margin: '0 8px' }}>
                                {log.type?.toUpperCase()}
                            </span>
                            <span style={{ fontWeight: 'bold' }}>{log.name}:</span>
                            <span style={{ marginLeft: '8px', color: '#ccc' }}>
                                {JSON.stringify(log.payload)}
                            </span>
                        </div>
                    ))}
                    <div ref={logEndRef} />
                </div>
            </div>
        </div>
    );
};

export default Live2DControllerScreen;
