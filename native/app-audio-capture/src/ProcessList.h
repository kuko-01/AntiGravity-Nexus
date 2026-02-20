#pragma once

#include <windows.h>
#include <vector>
#include <string>

struct AudioProcessInfo {
    DWORD pid;
    std::wstring name;
    std::wstring title;
};

class ProcessList {
public:
    static std::vector<AudioProcessInfo> GetAudioProcesses();
    static bool SetProcessMute(DWORD pid, bool mute);
    static bool GetProcessMute(DWORD pid, bool& muted);
    
private:
    static std::wstring GetProcessName(DWORD pid);
    static std::wstring GetWindowTitle(DWORD pid);
};
