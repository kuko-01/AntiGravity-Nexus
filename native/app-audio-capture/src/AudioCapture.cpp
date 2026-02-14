#include "AudioCapture.h"
#include <combaseapi.h>
#include <iostream>
#include <propidl.h>

// Use __uuidof instead of defining static GUIDs to avoid linker conflicts

// Helper class for async activation
// Implements IAgileObject to support MTA callbacks as per Microsoft guidelines
class ActivateAudioInterfaceCompletionHandler : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
public:
    ActivateAudioInterfaceCompletionHandler() : m_refCount(1), m_hrResult(E_FAIL), m_audioClient(nullptr) {
        m_event = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    }

    ~ActivateAudioInterfaceCompletionHandler() {
        if (m_event) CloseHandle(m_event);
        if (m_audioClient) m_audioClient->Release();
    }

    // IUnknown
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (riid == IID_IUnknown) {
            *ppv = static_cast<IUnknown*>(static_cast<IActivateAudioInterfaceCompletionHandler*>(this));
            AddRef();
            return S_OK;
        } else if (riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        } else if (riid == __uuidof(IAgileObject)) {
            *ppv = static_cast<IAgileObject*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override {
        return InterlockedIncrement(&m_refCount);
    }

    STDMETHODIMP_(ULONG) Release() override {
        ULONG count = InterlockedDecrement(&m_refCount);
        if (count == 0) delete this;
        return count;
    }

    // IActivateAudioInterfaceCompletionHandler
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT hrActivate = E_FAIL;
        IUnknown* punkAudioInterface = nullptr;

        HRESULT hr = operation->GetActivateResult(&hrActivate, &punkAudioInterface);
        std::cout << "[AudioCapture] ActivateCompleted: GetActivateResult hr=0x" << std::hex << hr << ", hrActivate=0x" << hrActivate << std::dec << std::endl;
        
        if (SUCCEEDED(hr) && SUCCEEDED(hrActivate)) {
            punkAudioInterface->QueryInterface(__uuidof(IAudioClient), (void**)&m_audioClient);
            m_hrResult = S_OK;
        } else {
            m_hrResult = FAILED(hr) ? hr : hrActivate;
        }

        if (punkAudioInterface) punkAudioInterface->Release();
        SetEvent(m_event);
        return S_OK;
    }

    HRESULT Wait(DWORD timeout = INFINITE) {
        DWORD result = WaitForSingleObject(m_event, timeout);
        return (result == WAIT_OBJECT_0) ? m_hrResult : E_FAIL;
    }

    IAudioClient* GetAudioClient() {
        IAudioClient* client = m_audioClient;
        m_audioClient = nullptr; // Transfer ownership
        return client;
    }

private:
    LONG m_refCount;
    HANDLE m_event;
    HRESULT m_hrResult;
    IAudioClient* m_audioClient;
};

AudioCapture::AudioCapture() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
}

AudioCapture::~AudioCapture() {
    StopCapture();
    CoUninitialize();
}

bool AudioCapture::InitializeLoopbackCapture(DWORD processId) {
    std::cout << "[AudioCapture] InitializeLoopbackCapture called for PID: " << processId << std::endl;
    
    // Set up activation parameters for process-specific loopback
    AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
    activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.TargetProcessId = processId;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    // Initialize PROPVARIANT properly using PropVariantInit
    PROPVARIANT activateParams;
    PropVariantInit(&activateParams);
    activateParams.vt = VT_BLOB;
    activateParams.blob.cbSize = sizeof(activationParams);
    activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

    // Create completion handler
    ActivateAudioInterfaceCompletionHandler* handler = new ActivateAudioInterfaceCompletionHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    std::cout << "[AudioCapture] Calling ActivateAudioInterfaceAsync..." << std::endl;
    
    // Use VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK for process loopback
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activateParams,
        handler,
        &asyncOp
    );

    if (FAILED(hr)) {
        std::cout << "[AudioCapture] ActivateAudioInterfaceAsync failed with HRESULT: 0x" << std::hex << hr << std::dec << std::endl;
        handler->Release();
        if (asyncOp) asyncOp->Release();
        return false;
    }

    std::cout << "[AudioCapture] Waiting for activation to complete..." << std::endl;
    
    // Wait for activation to complete
    hr = handler->Wait(5000); // 5 second timeout
    if (FAILED(hr)) {
        std::cout << "[AudioCapture] Activation wait failed with HRESULT: 0x" << std::hex << hr << std::dec << std::endl;
        handler->Release();
        asyncOp->Release();
        return false;
    }

    m_audioClient = handler->GetAudioClient();
    handler->Release();
    asyncOp->Release();

    if (!m_audioClient) {
        std::cout << "[AudioCapture] GetAudioClient returned null" << std::endl;
        return false;
    }

    std::cout << "[AudioCapture] Got AudioClient, setting up capture format..." << std::endl;

    // For process loopback, GetMixFormat returns E_NOTIMPL
    // Use a fixed format as per Microsoft sample (16-bit PCM, stereo, 44100 Hz)
    m_waveFormat = (WAVEFORMATEX*)CoTaskMemAlloc(sizeof(WAVEFORMATEX));
    if (!m_waveFormat) {
        std::cout << "[AudioCapture] Failed to allocate WAVEFORMATEX" << std::endl;
        Cleanup();
        return false;
    }

    m_waveFormat->wFormatTag = WAVE_FORMAT_PCM;
    m_waveFormat->nChannels = 2;
    m_waveFormat->nSamplesPerSec = 44100;
    m_waveFormat->wBitsPerSample = 16;
    m_waveFormat->nBlockAlign = m_waveFormat->nChannels * m_waveFormat->wBitsPerSample / 8;
    m_waveFormat->nAvgBytesPerSec = m_waveFormat->nSamplesPerSec * m_waveFormat->nBlockAlign;
    m_waveFormat->cbSize = 0;

    std::cout << "[AudioCapture] Capture format: " << m_waveFormat->nChannels << " channels, " 
              << m_waveFormat->nSamplesPerSec << " Hz, " 
              << m_waveFormat->wBitsPerSample << " bits" << std::endl;

    // Initialize the audio client in loopback mode with auto convert PCM flag
    hr = m_audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        200000, // 20ms buffer (in 100-nanosecond units)
        0,
        m_waveFormat,
        nullptr
    );

    if (FAILED(hr)) {
        std::cout << "[AudioCapture] IAudioClient::Initialize failed with HRESULT: 0x" << std::hex << hr << std::dec << std::endl;
        Cleanup();
        return false;
    }

    // Get the capture client
    hr = m_audioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&m_captureClient);
    if (FAILED(hr)) {
        std::cout << "[AudioCapture] GetService(IAudioCaptureClient) failed with HRESULT: 0x" << std::hex << hr << std::dec << std::endl;
        Cleanup();
        return false;
    }

    std::cout << "[AudioCapture] Initialization complete!" << std::endl;
    return true;
}

// New: Initialize system-wide loopback capture using default render endpoint
bool AudioCapture::InitializeSystemLoopback() {
    std::cout << "[AudioCapture] InitializeSystemLoopback called" << std::endl;
    
    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    IMMDevice* device = nullptr;
    
    // Create device enumerator
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        nullptr,
        CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        (void**)&deviceEnumerator
    );
    
    if (FAILED(hr)) {
        std::cout << "[AudioCapture] Failed to create device enumerator: 0x" << std::hex << hr << std::dec << std::endl;
        return false;
    }
    
    // Get default audio render endpoint (speakers/headphones)
    hr = deviceEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr)) {
        std::cout << "[AudioCapture] Failed to get default render endpoint: 0x" << std::hex << hr << std::dec << std::endl;
        deviceEnumerator->Release();
        return false;
    }
    
    // Activate audio client
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&m_audioClient);
    device->Release();
    deviceEnumerator->Release();
    
    if (FAILED(hr) || !m_audioClient) {
        std::cout << "[AudioCapture] Failed to activate audio client: 0x" << std::hex << hr << std::dec << std::endl;
        return false;
    }
    
    // For system loopback, use the same fixed format as per-app capture
    // to ensure consistent audio quality and avoid noise issues
    m_waveFormat = (WAVEFORMATEX*)CoTaskMemAlloc(sizeof(WAVEFORMATEX));
    if (!m_waveFormat) {
        std::cout << "[AudioCapture] Failed to allocate WAVEFORMATEX" << std::endl;
        Cleanup();
        return false;
    }

    m_waveFormat->wFormatTag = WAVE_FORMAT_PCM;
    m_waveFormat->nChannels = 2;
    m_waveFormat->nSamplesPerSec = 44100;
    m_waveFormat->wBitsPerSample = 16;
    m_waveFormat->nBlockAlign = m_waveFormat->nChannels * m_waveFormat->wBitsPerSample / 8;
    m_waveFormat->nAvgBytesPerSec = m_waveFormat->nSamplesPerSec * m_waveFormat->nBlockAlign;
    m_waveFormat->cbSize = 0;
    
    std::cout << "[AudioCapture] System capture format: " << m_waveFormat->nChannels << " channels, " 
              << m_waveFormat->nSamplesPerSec << " Hz, " 
              << m_waveFormat->wBitsPerSample << " bits" << std::endl;
    
    // Initialize audio client in LOOPBACK mode with auto convert PCM flag
    hr = m_audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        200000, // 20ms buffer
        0,
        m_waveFormat,
        nullptr
    );
    
    if (FAILED(hr)) {
        std::cout << "[AudioCapture] IAudioClient::Initialize (system loopback) failed: 0x" << std::hex << hr << std::dec << std::endl;
        Cleanup();
        return false;
    }
    
    // Get capture client
    hr = m_audioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&m_captureClient);
    if (FAILED(hr)) {
        std::cout << "[AudioCapture] GetService(IAudioCaptureClient) failed: 0x" << std::hex << hr << std::dec << std::endl;
        Cleanup();
        return false;
    }
    
    std::cout << "[AudioCapture] System loopback initialization complete!" << std::endl;
    return true;
}

bool AudioCapture::StartCapture(DWORD processId, AudioCallback callback) {
    std::lock_guard<std::mutex> lock(m_mutex);

    if (m_isCapturing) {
        return false;
    }

    m_callback = callback;
    m_targetProcessId = processId;
    m_stopRequested = false;
    m_isSystemCapture = false;

    if (!InitializeLoopbackCapture(processId)) {
        return false;
    }

    // Start the audio client
    HRESULT hr = m_audioClient->Start();
    if (FAILED(hr)) {
        Cleanup();
        return false;
    }

    m_isCapturing = true;
    m_captureThread = std::thread(&AudioCapture::CaptureThread, this);

    return true;
}

// New: Start system-wide audio capture
bool AudioCapture::StartSystemCapture(AudioCallback callback) {
    std::lock_guard<std::mutex> lock(m_mutex);

    if (m_isCapturing) {
        return false;
    }

    m_callback = callback;
    m_targetProcessId = 0;
    m_stopRequested = false;
    m_isSystemCapture = true;

    if (!InitializeSystemLoopback()) {
        return false;
    }

    // Start the audio client
    HRESULT hr = m_audioClient->Start();
    if (FAILED(hr)) {
        std::cout << "[AudioCapture] Failed to start system capture: 0x" << std::hex << hr << std::dec << std::endl;
        Cleanup();
        return false;
    }

    m_isCapturing = true;
    m_captureThread = std::thread(&AudioCapture::CaptureThread, this);

    std::cout << "[AudioCapture] System-wide capture started!" << std::endl;
    return true;
}

void AudioCapture::CaptureThread() {
    while (!m_stopRequested) {
        UINT32 packetLength = 0;
        HRESULT hr = m_captureClient->GetNextPacketSize(&packetLength);

        if (FAILED(hr)) {
            break;
        }

        while (packetLength > 0 && !m_stopRequested) {
            BYTE* data = nullptr;
            UINT32 numFramesAvailable = 0;
            DWORD flags = 0;

            hr = m_captureClient->GetBuffer(&data, &numFramesAvailable, &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                break;
            }

            if (data && numFramesAvailable > 0 && m_callback) {
                size_t dataSize = numFramesAvailable * m_waveFormat->nBlockAlign;
                
                // If silence, send zeros
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    std::vector<uint8_t> silence(dataSize, 0);
                    m_callback(silence.data(), dataSize, 
                               m_waveFormat->nChannels, 
                               m_waveFormat->nSamplesPerSec,
                               m_waveFormat->wBitsPerSample / 8);
                } else {
                    m_callback(data, dataSize,
                               m_waveFormat->nChannels,
                               m_waveFormat->nSamplesPerSec,
                               m_waveFormat->wBitsPerSample / 8);
                }
            }

            m_captureClient->ReleaseBuffer(numFramesAvailable);
            m_captureClient->GetNextPacketSize(&packetLength);
        }

        Sleep(10); // Small sleep to prevent busy-waiting
    }
}

void AudioCapture::StopCapture() {
    m_stopRequested = true;

    if (m_captureThread.joinable()) {
        m_captureThread.join();
    }

    std::lock_guard<std::mutex> lock(m_mutex);
    
    if (m_audioClient) {
        m_audioClient->Stop();
    }

    Cleanup();
    m_isCapturing = false;
}

void AudioCapture::Cleanup() {
    if (m_captureClient) {
        m_captureClient->Release();
        m_captureClient = nullptr;
    }
    if (m_audioClient) {
        m_audioClient->Release();
        m_audioClient = nullptr;
    }
    if (m_waveFormat) {
        CoTaskMemFree(m_waveFormat);
        m_waveFormat = nullptr;
    }
}

bool AudioCapture::IsCapturing() const {
    return m_isCapturing;
}
