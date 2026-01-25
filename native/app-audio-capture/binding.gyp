{
  "targets": [
    {
      "target_name": "app_audio_capture",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": [
        "src/main.cpp",
        "src/AudioCapture.cpp",
        "src/ProcessList.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "-lole32.lib",
              "-loleaut32.lib",
              "-lmmdevapi.lib",
              "-lpropsys.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ]
      ]
    }
  ]
}
