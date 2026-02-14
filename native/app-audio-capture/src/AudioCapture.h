#pragma once

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <napi.h>
#include <thread>
#include <atomic>
#include <mutex>
#include <functional>

// Manual definitions for process loopback (Windows 10 build 20348+)
// These are normally in audioclientactivationparams.h but may not be available in older SDK

#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

typedef enum _PROCESS_LOOPBACK_MODE {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;

typedef struct _AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    DWORD TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef enum _AUDIOCLIENT_ACTIVATION_TYPE {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef struct _AUDIOCLIENT_ACTIVATION_PARAMS {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    };
} AUDIOCLIENT_ACTIVATION_PARAMS;

class AudioCapture {
public:
    using AudioCallback = std::function<void(const uint8_t* data, size_t size, int channels, int sampleRate, int bytesPerSample)>;

    AudioCapture();
    ~AudioCapture();

    // Process-specific capture (existing)
    bool StartCapture(DWORD processId, AudioCallback callback);
    
    // System-wide capture (new)
    bool StartSystemCapture(AudioCallback callback);
    
    void StopCapture();
    bool IsCapturing() const;

private:
    void CaptureThread();
    bool InitializeLoopbackCapture(DWORD processId);
    bool InitializeSystemLoopback(); // New: System-wide loopback
    void Cleanup();

    IAudioClient* m_audioClient = nullptr;
    IAudioCaptureClient* m_captureClient = nullptr;
    WAVEFORMATEX* m_waveFormat = nullptr;
    
    std::thread m_captureThread;
    std::atomic<bool> m_isCapturing{false};
    std::atomic<bool> m_stopRequested{false};
    std::mutex m_mutex;
    
    AudioCallback m_callback;
    DWORD m_targetProcessId = 0;
    bool m_isSystemCapture = false; // New: Flag for system-wide capture
};
