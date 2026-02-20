#include "ProcessList.h"
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <Psapi.h>
#include <set>

#pragma comment(lib, "Psapi.lib")

// Use __uuidof instead of defining static GUIDs to avoid linker conflicts

namespace {
bool InitializeComForAudio(bool& shouldUninitialize) {
    shouldUninitialize = false;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (SUCCEEDED(hr)) {
        shouldUninitialize = true;
        return true;
    }
    if (hr == RPC_E_CHANGED_MODE) {
        // COM is already initialized on this thread with a different model.
        return true;
    }
    return false;
}
}

std::wstring ProcessList::GetProcessName(DWORD pid) {
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProcess) return L"Unknown";

    wchar_t processName[MAX_PATH] = L"Unknown";
    DWORD size = MAX_PATH;
    
    if (QueryFullProcessImageNameW(hProcess, 0, processName, &size)) {
        // Extract just the filename
        wchar_t* lastSlash = wcsrchr(processName, L'\\');
        if (lastSlash) {
            CloseHandle(hProcess);
            return std::wstring(lastSlash + 1);
        }
    }

    CloseHandle(hProcess);
    return std::wstring(processName);
}

std::wstring ProcessList::GetWindowTitle(DWORD pid) {
    struct EnumData {
        DWORD pid;
        std::wstring title;
    } data = { pid, L"" };

    EnumWindows([](HWND hwnd, LPARAM lParam) -> BOOL {
        auto* data = reinterpret_cast<EnumData*>(lParam);
        DWORD windowPid;
        GetWindowThreadProcessId(hwnd, &windowPid);
        
        if (windowPid == data->pid && IsWindowVisible(hwnd)) {
            wchar_t title[256];
            GetWindowTextW(hwnd, title, 256);
            if (wcslen(title) > 0) {
                data->title = title;
                return FALSE; // Stop enumeration
            }
        }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&data));

    return data.title;
}

std::vector<AudioProcessInfo> ProcessList::GetAudioProcesses() {
    std::vector<AudioProcessInfo> result;
    std::set<DWORD> addedPids;

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), (void**)&deviceEnumerator
    );

    if (FAILED(hr)) {
        CoUninitialize();
        return result;
    }

    IMMDevice* device = nullptr;
    hr = deviceEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    
    if (FAILED(hr)) {
        deviceEnumerator->Release();
        CoUninitialize();
        return result;
    }

    IAudioSessionManager2* sessionManager = nullptr;
    hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&sessionManager);
    
    if (FAILED(hr)) {
        device->Release();
        deviceEnumerator->Release();
        CoUninitialize();
        return result;
    }

    IAudioSessionEnumerator* sessionEnumerator = nullptr;
    hr = sessionManager->GetSessionEnumerator(&sessionEnumerator);
    
    if (FAILED(hr)) {
        sessionManager->Release();
        device->Release();
        deviceEnumerator->Release();
        CoUninitialize();
        return result;
    }

    int sessionCount = 0;
    sessionEnumerator->GetCount(&sessionCount);

    for (int i = 0; i < sessionCount; i++) {
        IAudioSessionControl* sessionControl = nullptr;
        hr = sessionEnumerator->GetSession(i, &sessionControl);
        
        if (SUCCEEDED(hr)) {
            IAudioSessionControl2* sessionControl2 = nullptr;
            hr = sessionControl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&sessionControl2);
            
            if (SUCCEEDED(hr)) {
                DWORD pid = 0;
                hr = sessionControl2->GetProcessId(&pid);
                
                if (SUCCEEDED(hr) && pid != 0 && addedPids.find(pid) == addedPids.end()) {
                    // Check if session is active
                    AudioSessionState state;
                    sessionControl->GetState(&state);
                    
                    if (state == AudioSessionStateActive) {
                        AudioProcessInfo info;
                        info.pid = pid;
                        info.name = GetProcessName(pid);
                        info.title = GetWindowTitle(pid);
                        
                        result.push_back(info);
                        addedPids.insert(pid);
                    }
                }
                sessionControl2->Release();
            }
            sessionControl->Release();
        }
    }

    sessionEnumerator->Release();
    sessionManager->Release();
    device->Release();
    deviceEnumerator->Release();
    CoUninitialize();

    return result;
}

bool ProcessList::SetProcessMute(DWORD pid, bool mute) {
    if (pid == 0) return false;

    bool shouldUninitialize = false;
    if (!InitializeComForAudio(shouldUninitialize)) {
        return false;
    }

    bool found = false;
    bool applied = false;

    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), (void**)&deviceEnumerator
    );

    if (SUCCEEDED(hr) && deviceEnumerator) {
        IMMDeviceCollection* deviceCollection = nullptr;
        hr = deviceEnumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &deviceCollection);

        if (SUCCEEDED(hr) && deviceCollection) {
            UINT deviceCount = 0;
            deviceCollection->GetCount(&deviceCount);

            for (UINT d = 0; d < deviceCount; d++) {
                IMMDevice* device = nullptr;
                if (FAILED(deviceCollection->Item(d, &device)) || !device) {
                    continue;
                }

                IAudioSessionManager2* sessionManager = nullptr;
                hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&sessionManager);
                device->Release();

                if (FAILED(hr) || !sessionManager) {
                    continue;
                }

                IAudioSessionEnumerator* sessionEnumerator = nullptr;
                hr = sessionManager->GetSessionEnumerator(&sessionEnumerator);
                sessionManager->Release();

                if (FAILED(hr) || !sessionEnumerator) {
                    continue;
                }

                int sessionCount = 0;
                sessionEnumerator->GetCount(&sessionCount);

                for (int i = 0; i < sessionCount; i++) {
                    IAudioSessionControl* sessionControl = nullptr;
                    if (FAILED(sessionEnumerator->GetSession(i, &sessionControl)) || !sessionControl) {
                        continue;
                    }

                    IAudioSessionControl2* sessionControl2 = nullptr;
                    hr = sessionControl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&sessionControl2);
                    if (SUCCEEDED(hr) && sessionControl2) {
                        DWORD sessionPid = 0;
                        hr = sessionControl2->GetProcessId(&sessionPid);
                        sessionControl2->Release();

                        if (SUCCEEDED(hr) && sessionPid == pid) {
                            ISimpleAudioVolume* simpleVolume = nullptr;
                            hr = sessionControl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&simpleVolume);
                            if (SUCCEEDED(hr) && simpleVolume) {
                                found = true;
                                if (SUCCEEDED(simpleVolume->SetMute(mute, nullptr))) {
                                    applied = true;
                                }
                                simpleVolume->Release();
                            }
                        }
                    }

                    sessionControl->Release();
                }

                sessionEnumerator->Release();
            }

            deviceCollection->Release();
        }

        deviceEnumerator->Release();
    }

    if (shouldUninitialize) {
        CoUninitialize();
    }

    return found && applied;
}

bool ProcessList::GetProcessMute(DWORD pid, bool& muted) {
    muted = false;
    if (pid == 0) return false;

    bool shouldUninitialize = false;
    if (!InitializeComForAudio(shouldUninitialize)) {
        return false;
    }

    bool found = false;
    bool allMuted = true;

    IMMDeviceEnumerator* deviceEnumerator = nullptr;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), (void**)&deviceEnumerator
    );

    if (SUCCEEDED(hr) && deviceEnumerator) {
        IMMDeviceCollection* deviceCollection = nullptr;
        hr = deviceEnumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &deviceCollection);

        if (SUCCEEDED(hr) && deviceCollection) {
            UINT deviceCount = 0;
            deviceCollection->GetCount(&deviceCount);

            for (UINT d = 0; d < deviceCount; d++) {
                IMMDevice* device = nullptr;
                if (FAILED(deviceCollection->Item(d, &device)) || !device) {
                    continue;
                }

                IAudioSessionManager2* sessionManager = nullptr;
                hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&sessionManager);
                device->Release();

                if (FAILED(hr) || !sessionManager) {
                    continue;
                }

                IAudioSessionEnumerator* sessionEnumerator = nullptr;
                hr = sessionManager->GetSessionEnumerator(&sessionEnumerator);
                sessionManager->Release();

                if (FAILED(hr) || !sessionEnumerator) {
                    continue;
                }

                int sessionCount = 0;
                sessionEnumerator->GetCount(&sessionCount);

                for (int i = 0; i < sessionCount; i++) {
                    IAudioSessionControl* sessionControl = nullptr;
                    if (FAILED(sessionEnumerator->GetSession(i, &sessionControl)) || !sessionControl) {
                        continue;
                    }

                    IAudioSessionControl2* sessionControl2 = nullptr;
                    hr = sessionControl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&sessionControl2);
                    if (SUCCEEDED(hr) && sessionControl2) {
                        DWORD sessionPid = 0;
                        hr = sessionControl2->GetProcessId(&sessionPid);
                        sessionControl2->Release();

                        if (SUCCEEDED(hr) && sessionPid == pid) {
                            ISimpleAudioVolume* simpleVolume = nullptr;
                            hr = sessionControl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&simpleVolume);
                            if (SUCCEEDED(hr) && simpleVolume) {
                                BOOL isMuted = FALSE;
                                if (SUCCEEDED(simpleVolume->GetMute(&isMuted))) {
                                    found = true;
                                    if (!isMuted) {
                                        allMuted = false;
                                    }
                                }
                                simpleVolume->Release();
                            }
                        }
                    }

                    sessionControl->Release();
                }

                sessionEnumerator->Release();
            }

            deviceCollection->Release();
        }

        deviceEnumerator->Release();
    }

    if (shouldUninitialize) {
        CoUninitialize();
    }

    if (found) {
        muted = allMuted;
    }
    return found;
}
