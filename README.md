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
│  │ Audio Play  │◀───│ Edge TTS    │◀───│ OpenClaw Session    │  │
│  │             │    │ (British)   │    │ (Claude/GPT/etc)    │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **Join/leave voice channels** via chat command or gateway RPC
- **Speech-to-text** via OpenAI Whisper API
- **Opus decoding** using @discordjs/opus
- **AI responses** via main OpenClaw session (uses your configured model)
- **Full tool access** — voice has access to all agent tools and memory
- **Text-to-speech** via Edge TTS (en-GB-SoniaNeural voice)
- **Voice activity detection** (VAD) with configurable silence threshold

## Requirements

- Node.js 18+
- OpenAI API key (for Whisper STT)
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
            "silenceThresholdMs": 1500
          }
        }
      }
    }
  }
}
```

## Usage

### Via chat
Just ask the agent to join or leave voice:
- "Join voice channel"
- "Leave voice"

### Via gateway RPC
```bash
openclaw gateway call discord-voice.join --params '{"channelId":"CHANNEL_ID"}'
openclaw gateway call discord-voice.leave --params '{"channelId":"CHANNEL_ID"}'
openclaw gateway call discord-voice.status
```

### Via slash command
```
/voice join <channel-id>
/voice leave <channel-id>
/voice status
```

## How It Works

1. Plugin joins voice channel via @discordjs/voice
2. Subscribes to audio streams from users
3. Opus audio packets are decoded to PCM in real-time
4. VAD detects speech end (silence threshold)
5. PCM audio is wrapped in WAV header and sent to Whisper
6. Transcribed text is routed through main OpenClaw session
7. Response is converted to speech via Edge TTS
8. Audio is played back in the voice channel

## Session Integration

Voice messages are routed through the main OpenClaw agent via `runEmbeddedPiAgent`:

- **Uses your configured model** (Claude Opus, GPT-4, etc.)
- **Full tool access** — can search web, read files, check calendar, etc.
- **Session memory** — voice conversations are logged to session context
- **Voice-specific session** — each Discord user gets their own session (`voice:discord:<userId>`)

Voice responses include a system prompt that encourages brief, conversational replies suitable for spoken output.

## TODO

- [x] Strip emoji from voice responses (TTS reads them as garbage)
- [ ] Optimize VAD to avoid cutting off speech
- [ ] Add local Whisper support (whisper.cpp)
