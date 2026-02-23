# Discord Voice Plugin for OpenClaw

A plugin that adds voice channel support to OpenClaw's Discord integration.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Discord Voice Channel                        │
└─────────────────────────┬───────────────────────────────────────┘
                          │ Audio Stream (Opus)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   discord-voice plugin                           │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ Voice Conn  │───▶│ Opus Decode │───▶│ Whisper STT         │  │
│  │ (@discordjs │    │ + VAD       │    │ (OpenAI API)        │  │
│  │  /voice)    │    └─────────────┘    └──────────┬──────────┘  │
│  └─────────────┘                                   │             │
│                                                    ▼             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ Audio Play  │◀───│ Edge TTS    │◀───│ GPT-4o-mini         │  │
│  │             │    │ (British)   │    │ (or Claude)         │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Join/leave voice channels** via slash command or gateway RPC
- **Follow-user mode** — auto-joins when you join voice
- **Speech-to-text** via OpenAI Whisper API
- **Opus decoding** using @discordjs/opus
- **AI responses** via GPT-4o-mini (Claude support planned)
- **Text-to-speech** via Edge TTS (en-GB-SoniaNeural voice)
- **Voice activity detection** (VAD) with configurable silence threshold

## Requirements

- Node.js 18+
- ffmpeg (for audio format conversion)
- OpenAI API key (for Whisper STT and GPT responses)
- Discord bot with voice permissions
- Edge TTS CLI (via Python: `pip install edge-tts`)
- DAVE protocol support (@snazzah/davey) for encrypted voice channels

## Installation

```bash
cd ~/.openclaw/workspace/discord-voice
npm install
npx tsc --noEmit false --outDir dist
```

Then add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/discord-voice"]
    },
    "entries": {
      "discord-voice": {
        "enabled": true,
        "config": {
          "stt": {
            "provider": "openai",
            "openaiApiKey": "sk-..."
          },
          "vad": {
            "enabled": true,
            "silenceThresholdMs": 1500
          },
          "followUser": {
            "enabled": true,
            "followOwner": true,
            "leaveWhenEmpty": true
          }
        }
      }
    }
  }
}
```

## Usage

### Join a voice channel
```bash
openclaw gateway call discord-voice.join --params '{"channelId":"CHANNEL_ID"}'
```

### Leave a voice channel
```bash
openclaw gateway call discord-voice.leave --params '{"channelId":"CHANNEL_ID"}'
```

### Check status
```bash
openclaw gateway call discord-voice.status
```

### Slash command
```
/voice join <channel-id>
/voice leave <channel-id>
/voice status
```

## How It Works

1. Plugin creates a separate Discord client for voice
2. Joins voice channel and subscribes to audio streams
3. Opus audio packets are decoded to PCM in real-time
4. VAD detects speech end (silence threshold)
5. PCM audio is wrapped in WAV header and sent to Whisper
6. Transcribed text is sent to GPT-4o-mini for response
7. Response is converted to speech via Edge TTS
8. Audio is played back in the voice channel

## TODO

- [x] Route voice through main OpenClaw session (for tool access + model agnostic)
- [ ] Fix followUser/leaveWhenEmpty — bot stays in channel after user leaves
- [ ] Optimize VAD to avoid cutting off speech
- [ ] Add local Whisper support (whisper.cpp)

## Session Integration

Voice messages are now routed through the main OpenClaw agent infrastructure via `runEmbeddedPiAgent`. This means:

- **Uses your configured model** (Claude Opus, GPT-4, etc.)
- **Full tool access** — can search web, read files, check calendar, etc.
- **Session memory** — voice conversations are logged to session context
- **Voice-specific session** — each Discord user gets their own session (`voice:discord:<userId>`)

Voice responses include a system prompt that encourages brief, conversational replies suitable for spoken output.
