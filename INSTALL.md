# Installation

## Prerequisites

1. **ffmpeg** - Required for audio processing
   ```bash
   # Ubuntu/Debian
   sudo apt install ffmpeg
   
   # macOS
   brew install ffmpeg
   ```

2. **System audio libraries**
   ```bash
   # Ubuntu/Debian
   sudo apt install libasound2-dev libopus-dev
   
   # macOS (usually pre-installed)
   brew install opus
   ```

3. **Edge TTS** - For text-to-speech
   ```bash
   pip install edge-tts
   ```

4. **OpenAI API key** - For Whisper STT

## Install the plugin

```bash
cd ~/.openclaw/workspace/discord-voice
npm install
npx tsc --noEmit false --outDir dist
```

The plugin is loaded via the `plugins.load.paths` config.

## Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/home/YOUR_USER/.openclaw/workspace/discord-voice"
      ]
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

## Discord Bot Permissions

Your bot needs these permissions:
- Connect (to voice channels)
- Speak (to play audio)
- Use Voice Activity

Bot intents (Discord Developer Portal):
- GUILDS
- GUILD_VOICE_STATES

## Usage

### Via chat
Just ask the agent to join or leave voice — it will use the gateway RPC.

### Via gateway RPC
```bash
openclaw gateway call discord-voice.join --params '{"channelId":"CHANNEL_ID"}'
openclaw gateway call discord-voice.leave --params '{"channelId":"CHANNEL_ID"}'
openclaw gateway call discord-voice.status
```

### Slash commands
```
/voice join <channel-id>
/voice leave <channel-id>
/voice status
```

## How it works

1. Plugin joins Discord voice channel using @discordjs/voice
2. Receives Opus-encoded audio packets from Discord
3. Decodes Opus to PCM using @discordjs/opus
4. VAD detects end of speech (silence threshold)
5. PCM audio is wrapped in WAV and sent to Whisper API
6. Transcribed text is routed through main OpenClaw session
7. Response is converted to speech via Edge TTS
8. Audio is played back in the voice channel

## Troubleshooting

### "No compatible encryption modes"
- Install DAVE protocol support: `npm install @snazzah/davey`
- This is required for Discord's end-to-end voice encryption

### "No audio" or "Opus error"
- Ensure `@discordjs/opus` and `sodium-native` are installed
- Run `npm rebuild` in the plugin directory

### "Connection timeout"
- Check bot has permissions in the voice channel
- Ensure bot intents are enabled in Discord Developer Portal

### "Transcription empty"
- Verify OpenAI API key is valid and has credits
- Check Whisper rate limits (3 RPM on free tier)

### "Audio too short"
- Speak longer phrases (Whisper needs at least 0.1 seconds)
- VAD might be cutting off speech too early
