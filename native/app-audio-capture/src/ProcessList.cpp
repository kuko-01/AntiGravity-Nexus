#include "ProcessList.h"
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <Psapi.h>
#include <set>

#pragma comment(lib, "Psapi.lib")

// Use __uuidof instead of defining static GUIDs to avoid linker conflicts

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
