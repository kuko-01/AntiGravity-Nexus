#include <napi.h>
#include "AudioCapture.h"
#include "ProcessList.h"
#include <memory>

static std::unique_ptr<AudioCapture> g_audioCapture;
static Napi::ThreadSafeFunction g_tsfn;

// Convert wide string to UTF-8
std::string WideToUtf8(const std::wstring& wstr) {
    if (wstr.empty()) return "";
    int size = WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string result(size - 1, 0);
    WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), -1, &result[0], size, nullptr, nullptr);
    return result;
}

// Get list of processes that are outputting audio
Napi::Value GetAudioProcesses(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    auto processes = ProcessList::GetAudioProcesses();
    Napi::Array result = Napi::Array::New(env, processes.size());
    
    for (size_t i = 0; i < processes.size(); i++) {
        Napi::Object proc = Napi::Object::New(env);
        proc.Set("pid", Napi::Number::New(env, processes[i].pid));
        proc.Set("name", Napi::String::New(env, WideToUtf8(processes[i].name)));
        proc.Set("title", Napi::String::New(env, WideToUtf8(processes[i].title)));
        result.Set(i, proc);
    }
    
    return result;
}

// Start capturing audio from a specific process
Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
        result.Set("success", Napi::Boolean::New(env, false));
        result.Set("error", Napi::String::New(env, "Invalid arguments: expected (pid: number, callback: function)"));
        return result;
    }
    
    DWORD pid = info[0].As<Napi::Number>().Uint32Value();
    Napi::Function callback = info[1].As<Napi::Function>();
    
    // Create thread-safe function for calling back to JavaScript
    g_tsfn = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "AudioDataCallback",
        0,
        1,
        [](Napi::Env) { /* cleanup */ }
    );
    
    if (!g_audioCapture) {
        g_audioCapture = std::make_unique<AudioCapture>();
    }
    
    bool success = g_audioCapture->StartCapture(pid, 
        [](const uint8_t* data, size_t size, int channels, int sampleRate, int bytesPerSample) {
            // Copy data to avoid lifetime issues
            auto dataCopy = std::make_shared<std::vector<uint8_t>>(data, data + size);
            
            g_tsfn.NonBlockingCall([dataCopy, channels, sampleRate, bytesPerSample](Napi::Env env, Napi::Function jsCallback) {
                Napi::Object audioData = Napi::Object::New(env);
                audioData.Set("buffer", Napi::Buffer<uint8_t>::Copy(env, dataCopy->data(), dataCopy->size()));
                audioData.Set("channels", Napi::Number::New(env, channels));
                audioData.Set("sampleRate", Napi::Number::New(env, sampleRate));
                audioData.Set("bytesPerSample", Napi::Number::New(env, bytesPerSample));
                
                jsCallback.Call({ audioData });
            });
        }
    );
    
    result.Set("success", Napi::Boolean::New(env, success));
    if (!success) {
        result.Set("error", Napi::String::New(env, "Failed to start capture. Windows 10 build 20348+ required."));
        g_tsfn.Release();
    }
    
    return result;
}

// Stop audio capture
Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (g_audioCapture) {
        g_audioCapture->StopCapture();
    }
    
    if (g_tsfn) {
        g_tsfn.Release();
    }
    
    return env.Undefined();
}

// Start capturing system-wide audio (new)
Napi::Value StartSystemCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    
    if (info.Length() < 1 || !info[0].IsFunction()) {
        result.Set("success", Napi::Boolean::New(env, false));
        result.Set("error", Napi::String::New(env, "Invalid arguments: expected (callback: function)"));
        return result;
    }
    
    Napi::Function callback = info[0].As<Napi::Function>();
    
    // Create thread-safe function for calling back to JavaScript
    g_tsfn = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "SystemAudioDataCallback",
        0,
        1,
        [](Napi::Env) { /* cleanup */ }
    );
    
    if (!g_audioCapture) {
        g_audioCapture = std::make_unique<AudioCapture>();
    }
    
    bool success = g_audioCapture->StartSystemCapture(
        [](const uint8_t* data, size_t size, int channels, int sampleRate, int bytesPerSample) {
            // Copy data to avoid lifetime issues
            auto dataCopy = std::make_shared<std::vector<uint8_t>>(data, data + size);
            
            g_tsfn.NonBlockingCall([dataCopy, channels, sampleRate, bytesPerSample](Napi::Env env, Napi::Function jsCallback) {
                Napi::Object audioData = Napi::Object::New(env);
                audioData.Set("buffer", Napi::Buffer<uint8_t>::Copy(env, dataCopy->data(), dataCopy->size()));
                audioData.Set("channels", Napi::Number::New(env, channels));
                audioData.Set("sampleRate", Napi::Number::New(env, sampleRate));
                audioData.Set("bytesPerSample", Napi::Number::New(env, bytesPerSample));
                
                jsCallback.Call({ audioData });
            });
        }
    );
    
    result.Set("success", Napi::Boolean::New(env, success));
    if (!success) {
        result.Set("error", Napi::String::New(env, "Failed to start system capture."));
        g_tsfn.Release();
    }
    
    return result;
}

// Check if capture is active
Napi::Value IsCapturing(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    bool capturing = g_audioCapture && g_audioCapture->IsCapturing();
    return Napi::Boolean::New(env, capturing);
}

// Set mute state for a specific process audio session
Napi::Value SetProcessMute(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
        result.Set("success", Napi::Boolean::New(env, false));
        result.Set("error", Napi::String::New(env, "Invalid arguments: expected (pid: number, mute: boolean)"));
        return result;
    }

    DWORD pid = info[0].As<Napi::Number>().Uint32Value();
    bool mute = info[1].As<Napi::Boolean>().Value();

    bool success = ProcessList::SetProcessMute(pid, mute);
    result.Set("success", Napi::Boolean::New(env, success));
    if (!success) {
        result.Set("error", Napi::String::New(env, "Audio session for process not found or mute operation failed."));
    }
    return result;
}

// Get mute state for a specific process audio session
Napi::Value GetProcessMute(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    if (info.Length() < 1 || !info[0].IsNumber()) {
        result.Set("success", Napi::Boolean::New(env, false));
        result.Set("error", Napi::String::New(env, "Invalid arguments: expected (pid: number)"));
        return result;
    }

    DWORD pid = info[0].As<Napi::Number>().Uint32Value();
    bool muted = false;
    bool found = ProcessList::GetProcessMute(pid, muted);

    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("found", Napi::Boolean::New(env, found));
    result.Set("muted", Napi::Boolean::New(env, muted));
    return result;
}

// Initialize the module
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("getAudioProcesses", Napi::Function::New(env, GetAudioProcesses));
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("startSystemCapture", Napi::Function::New(env, StartSystemCapture));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    exports.Set("isCapturing", Napi::Function::New(env, IsCapturing));
    exports.Set("setProcessMute", Napi::Function::New(env, SetProcessMute));
    exports.Set("getProcessMute", Napi::Function::New(env, GetProcessMute));
    return exports;
}

NODE_API_MODULE(app_audio_capture, Init)

