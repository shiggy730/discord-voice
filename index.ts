/**
 * Discord Voice Plugin for OpenClaw
 *
 * Adds voice channel support: STT → OpenClaw → TTS → playback
 */

import {
  Client,
  GatewayIntentBits,
  VoiceChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  VoiceConnection,
  getVoiceConnection,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import { OpusEncoder } from "@discordjs/opus";
import { Readable } from "stream";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { loadCoreAgentDeps, type CoreAgentDeps, type CoreConfig } from "./core-bridge.js";

// Types for OpenClaw plugin API
interface PluginApi {
  config: any;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  runtime: {
    tts: {
      textToSpeech: (opts: { text: string; cfg: any }) => Promise<{ buffer: Buffer }>;
    };
    gateway: {
      call: (method: string, params: any) => Promise<any>;
    };
  };
  registerService: (service: Service) => void;
  registerCommand: (command: Command) => void;
  registerGatewayMethod: (name: string, handler: any) => void;
}

interface Service {
  id: string;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
}

interface Command {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: any) => Promise<{ text: string }> | { text: string };
}

// Plugin state
let client: Client | null = null;
let activeConnections: Map<string, VoiceConnection> = new Map();
let api: PluginApi;
let coreDeps: CoreAgentDeps | null = null;

// ============================================
// Session-based Response Generation
// ============================================

async function generateSessionResponse(userMessage: string, userId: string): Promise<string | null> {
  if (!coreDeps) {
    try {
      coreDeps = await loadCoreAgentDeps();
    } catch (err) {
      api.logger.error(`Failed to load core deps: ${err}`);
      return null;
    }
  }

  const cfg = api.config as CoreConfig;
  const agentId = "main";

  // Resolve paths
  const storePath = coreDeps.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = coreDeps.resolveAgentDir(cfg, agentId);
  const workspaceDir = coreDeps.resolveAgentWorkspaceDir(cfg, agentId);

  // Ensure workspace exists
  await coreDeps.ensureAgentWorkspace({ dir: workspaceDir });

  // Use voice-specific session key tied to Discord user
  const sessionKey = `voice:discord:${userId}`;
  const now = Date.now();

  // Load or create session entry
  const sessionStore = coreDeps.loadSessionStore(storePath);
  let sessionEntry = sessionStore[sessionKey] as { sessionId: string; updatedAt: number } | undefined;

  if (!sessionEntry) {
    sessionEntry = {
      sessionId: randomUUID(),
      updatedAt: now,
    };
    sessionStore[sessionKey] = sessionEntry;
    await coreDeps.saveSessionStore(storePath, sessionStore);
  }

  const sessionId = sessionEntry.sessionId;
  const sessionFile = coreDeps.resolveSessionFilePath(sessionId, sessionEntry, { agentId });

  // Resolve model from config (use configured default)
  const modelRef = `${coreDeps.DEFAULT_PROVIDER}/${coreDeps.DEFAULT_MODEL}`;
  const slashIndex = modelRef.indexOf("/");
  const provider = slashIndex === -1 ? coreDeps.DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);

  // Resolve thinking level
  const thinkLevel = coreDeps.resolveThinkingDefault({ cfg, provider, model });

  // Resolve agent identity
  const identity = coreDeps.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";

  // Voice-specific system prompt
  const extraSystemPrompt = `You are ${agentName} responding via voice in a Discord voice channel. Keep responses brief and conversational (1-3 sentences) since they'll be spoken aloud. Be natural and friendly.

CRITICAL VOICE RULES:
1. NEVER use emoji characters - they get read aloud as garbage text
2. NEVER use emoji shortcodes like :smile: or :martial_arts_uniform:
3. NEVER reference your emoji or identity marker in voice responses
4. Just speak naturally as a friendly assistant

You have access to all your normal tools and memory.`;

  // Resolve timeout
  const timeoutMs = coreDeps.resolveAgentTimeoutMs({ cfg });
  const runId = `voice:discord:${userId}:${Date.now()}`;

  try {
    api.logger.info(`Running agent for voice response...`);
    const result = await coreDeps.runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      messageProvider: "discord-voice",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: userMessage,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs,
      runId,
      lane: "voice",
      extraSystemPrompt,
      agentDir,
    });

    // Extract text from payloads
    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const text = texts.join(" ") || null;

    if (!text && result.meta?.aborted) {
      api.logger.warn("Response generation was aborted");
      return null;
    }

    return text;
  } catch (err) {
    api.logger.error(`Session response failed: ${err}`);
    return null;
  }
}

// ============================================
// Speech-to-Text (STT)
// ============================================

async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const config = api.config.plugins?.entries?.["discord-voice"]?.config;
  const provider = config?.stt?.provider || "openai";
  if (provider === "openai") {
    return transcribeWithOpenAI(audioBuffer, config);
  } else if (provider === "local-whisper") {
    return transcribeWithLocalWhisper(audioBuffer, config);
  } else if (provider === "deepgram") {
    return transcribeWithDeepgram(audioBuffer, config);
  }

  throw new Error(`Unknown STT provider: ${provider}`);
}

function createWavHeader(pcmLength: number, sampleRate: number = 48000, channels: number = 2, bitsPerSample: number = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmLength, 40);

  return header;
}

async function transcribeWithOpenAI(audioBuffer: Buffer, config: any): Promise<string> {
  const apiKey = config?.stt?.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key not configured");

  // The audioBuffer now contains decoded PCM data (48kHz, stereo, 16-bit)
  const ts = Date.now();
  const wavPath = join(tmpdir(), `openclaw-voice-${ts}.wav`);

  try {
    // Create WAV file with proper header
    const wavHeader = createWavHeader(audioBuffer.length, 48000, 2, 16);
    const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
    writeFileSync(wavPath, wavBuffer);

    const formData = new FormData();
    const fileBlob = new Blob([readFileSync(wavPath)], { type: "audio/wav" });
    formData.append("file", fileBlob, "audio.wav");
    formData.append("model", config?.stt?.model || "whisper-1");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    const result = await response.json() as { text?: string; error?: any };
    if (result.error) {
      // Log Whisper API errors but continue
      return "";
    }
    return result.text || "";
  } finally {
    try { unlinkSync(wavPath); } catch {}
  }
}

async function transcribeWithLocalWhisper(audioBuffer: Buffer, config: any): Promise<string> {
  // TODO: Implement local Whisper via whisper.cpp or similar
  throw new Error("Local Whisper not yet implemented");
}

async function transcribeWithDeepgram(audioBuffer: Buffer, config: any): Promise<string> {
  // TODO: Implement Deepgram STT
  throw new Error("Deepgram not yet implemented");
}

// ============================================
// Voice Activity Detection (VAD)
// ============================================

// Opus decoder for converting Discord audio to PCM
let opusDecoder: any = null;
try {
  opusDecoder = new OpusEncoder(48000, 2);
} catch (e) {
  console.error(`Failed to create OpusEncoder: ${e}`);
}

class VoiceActivityDetector {
  private pcmChunks: Buffer[] = [];
  private silenceStart: number | null = null;
  private speaking: boolean = false;
  private silenceThreshold: number;
  private onSpeechEnd: (audio: Buffer) => void;

  constructor(silenceThresholdMs: number, onSpeechEnd: (audio: Buffer) => void) {
    this.silenceThreshold = silenceThresholdMs;
    this.onSpeechEnd = onSpeechEnd;
  }

  processAudio(chunk: Buffer, isSpeaking: boolean) {
    if (isSpeaking) {
      this.speaking = true;
      this.silenceStart = null;

      // Decode Opus frame to PCM
      if (opusDecoder && chunk.length > 0) {
        try {
          const pcm = opusDecoder.decode(chunk);
          this.pcmChunks.push(pcm);
        } catch (e) {
          // Some packets might be invalid, skip them
        }
      }
    } else if (this.speaking && this.pcmChunks.length > 0) {
      // Stream ended - process accumulated PCM audio immediately
      const fullAudio = Buffer.concat(this.pcmChunks);
      this.pcmChunks = [];
      this.speaking = false;
      this.silenceStart = null;
      this.onSpeechEnd(fullAudio);
    }
  }
}

// ============================================
// Voice Connection Handler
// ============================================

async function handleVoiceConnection(
  channel: VoiceChannel,
  guildId: string
) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guildId,
    adapterCreator: channel.guild.voiceAdapterCreator as any, // Type assertion for discord.js version mismatch
    selfDeaf: false,
    selfMute: false,
  });

  activeConnections.set(channel.id, connection);

  // Wait for connection to be ready
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  api.logger.info(`Joined voice channel: ${channel.name}`);

  try {
    const receiver = connection.receiver;
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,  // Keep playing even if connection hiccups
        maxMissedFrames: 50,  // Allow more missed frames before stopping (default is 5)
      },
    });
    connection.subscribe(player);

  // Listen to each user's audio
  receiver.speaking.on("start", (userId) => {
    api.logger.info(`User ${userId} started speaking`);
    const config = api.config.plugins?.entries?.["discord-voice"]?.config;
    const silenceMs = config?.vad?.silenceThresholdMs || 1500;

    const vad = new VoiceActivityDetector(silenceMs, async (audioBuffer) => {
      try {
        // 1. Transcribe speech
        const text = await transcribeAudio(audioBuffer);
        if (!text.trim()) return;

        api.logger.info(`[Voice] User said: "${text}"`);

        try {
          // 2. Generate response through main OpenClaw session
          const replyText = await generateSessionResponse(text, userId);
          
          if (!replyText) {
            api.logger.warn(`No response generated for voice input`);
            return;
          }
          
          api.logger.info(`[Voice] Response: "${replyText}"`);
          
          // 3. Strip emoji from response (TTS reads them as garbage)
          // Comprehensive emoji regex covering all common ranges
          const emojiRegex = /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F0FF}]|[\u{1F100}-\u{1F1FF}]|[\u{200D}]|[\u{FE0F}]|[\u{FE0E}]|[\u{2300}-\u{23FF}]|[\u{2B50}-\u{2B55}]|[\u{231A}-\u{231B}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2614}-\u{2615}]|[\u{2648}-\u{2653}]|[\u{267F}]|[\u{2693}]|[\u{26A1}]|[\u{26AA}-\u{26AB}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26CE}]|[\u{26D4}]|[\u{26EA}]|[\u{26F2}-\u{26F3}]|[\u{26F5}]|[\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}]/gu;
          // Also strip Discord-style shortcodes like :emoji_name:
          const shortcodeRegex = /:[a-z0-9_+-]+:/gi;
          // Strip backslash escapes that might appear
          const escapeRegex = /\\u\{?[0-9A-Fa-f]+\}?/g;
          // Strip markdown formatting
          const markdownRegex = /\*\*|__|\*|_|~~|`{1,3}|#{1,6}\s|>\s|\[\[|\]\]|\[|\]|\(|\)/g;
          // Strip backslash-n and other escape sequences
          const escapeSeqRegex = /\\[nrt"'\\]/g;
          
          let textWithoutEmoji = replyText
            .replace(emojiRegex, '')
            .replace(shortcodeRegex, '')
            .replace(escapeRegex, '')
            .replace(markdownRegex, '')
            .replace(escapeSeqRegex, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          
          // Debug: log hex codes of any remaining non-ASCII
          const hexDebug = [...textWithoutEmoji].map(c => c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16)}` : c).join('');
          api.logger.info(`[Voice] After emoji strip: "${textWithoutEmoji}"`);
          api.logger.info(`[Voice] Hex debug: "${hexDebug}"`);
          
          // Debug: write to temp file for inspection
          const debugPath = join(tmpdir(), 'voice-debug.txt');
          writeFileSync(debugPath, `Original: ${replyText}\n\nStripped: ${textWithoutEmoji}\n\nHex: ${hexDebug}\n`);
          api.logger.info(`[Voice] Debug written to: ${debugPath}`);
          
          // If still empty after stripping, use a default
          if (!textWithoutEmoji) {
            textWithoutEmoji = "I hear you!";
          }
          
          // 4. Generate TTS using edge-tts CLI
          // Write text to file to avoid shell escaping issues
          const ttsPath = join(tmpdir(), `tts-${Date.now()}.mp3`);
          const textPath = join(tmpdir(), `tts-text-${Date.now()}.txt`);
          writeFileSync(textPath, textWithoutEmoji);
          execSync(`/home/shiggy730/anaconda3/envs/natsu/bin/edge-tts --voice "en-GB-SoniaNeural" --file "${textPath}" --write-media "${ttsPath}"`, { stdio: 'pipe' });
          try { unlinkSync(textPath); } catch {}
          
          // 5. Pre-buffer audio file into memory to reduce disk I/O stuttering
          const audioBuffer = readFileSync(ttsPath);
          const audioStream = Readable.from(audioBuffer);
          
          // 6. Play audio response with buffering settings
          const resource = createAudioResource(audioStream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
          });
          resource.volume?.setVolume(1.0);  // Ensure volume is set
          player.play(resource);
          
          // Clean up temp file after playback starts
          setTimeout(() => {
            try { unlinkSync(ttsPath); } catch {}
          }, 5000);
        } catch (err: any) {
          api.logger.error(`Voice response error: ${err}`);
        }

      } catch (err) {
        api.logger.error(`Voice processing error: ${err}`);
      }
    });

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 100 },
    });

    audioStream.on("data", (chunk) => {
      vad.processAudio(chunk, true);
    });

    audioStream.on("end", () => {
      vad.processAudio(Buffer.alloc(0), false);
    });

    audioStream.on("error", (err) => {
      api.logger.error(`Audio stream error for ${userId}: ${err}`);
    });
  });

  } catch (err) {
    api.logger.error(`Voice setup error: ${err}`);
  }

  return connection;
}

// ============================================
// Plugin Commands
// ============================================

async function resolveVoiceChannel(nameOrId: string): Promise<VoiceChannel | null> {
  if (!client) return null;
  
  // Try direct ID fetch first
  if (/^\d+$/.test(nameOrId)) {
    try {
      const channel = await client.channels.fetch(nameOrId);
      if (channel?.type === 2) return channel as VoiceChannel;
    } catch {}
  }
  
  // Search by name across all guilds
  const nameLower = nameOrId.toLowerCase();
  for (const [, guild] of client.guilds.cache) {
    const channels = await guild.channels.fetch();
    for (const [, channel] of channels) {
      if (channel?.type === 2 && channel.name.toLowerCase() === nameLower) {
        return channel as VoiceChannel;
      }
    }
  }
  return null;
}

function registerCommands() {
  api.logger.info("[discord-voice] Registering /vc command...");
  // /vc join <channel-name-or-id>
  api.registerCommand({
    name: "vc",
    description: "Voice channel controls: join, leave, status",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim().split(/\s+/) || [];
      const action = args[0];
      const channelArg = args.slice(1).join(" "); // Allow multi-word channel names

      if (action === "join" && channelArg) {
        const channel = await resolveVoiceChannel(channelArg);
        if (!channel) {
          return { text: `❌ Voice channel not found: ${channelArg}` };
        }
        await handleVoiceConnection(channel, channel.guildId);
        return { text: `🎙️ Joined voice channel: ${channel.name}` };
      }

      if (action === "leave") {
        if (channelArg) {
          // Leave specific channel
          const channel = await resolveVoiceChannel(channelArg);
          if (channel) {
            const conn = activeConnections.get(channel.id);
            if (conn) {
              conn.destroy();
              activeConnections.delete(channel.id);
              return { text: `👋 Left voice channel: ${channel.name}` };
            }
          }
          return { text: `Not in channel: ${channelArg}` };
        } else {
          // Leave all channels
          if (activeConnections.size === 0) {
            return { text: "Not in any voice channels" };
          }
          for (const [id, conn] of activeConnections) {
            conn.destroy();
            activeConnections.delete(id);
          }
          return { text: "👋 Left all voice channels" };
        }
      }

      if (action === "status") {
        if (activeConnections.size === 0) {
          return { text: "Not in any voice channels" };
        }
        const names: string[] = [];
        for (const [id] of activeConnections) {
          try {
            const ch = await client?.channels.fetch(id);
            names.push(ch?.type === 2 ? (ch as VoiceChannel).name : id);
          } catch {
            names.push(id);
          }
        }
        return { text: `🎙️ Active in: ${names.join(", ")}` };
      }

      return { text: "Usage: /vc join|leave|status [channel-name-or-id]" };
    },
  });
  api.logger.info("[discord-voice] /vc command registered successfully");
}

// ============================================
// Gateway RPC Methods
// ============================================

function registerGatewayMethods() {
  api.registerGatewayMethod("discord-voice.join", async ({ params, respond }) => {
    const { channelId } = params;
    const channel = await client?.channels.fetch(channelId);
    if (!channel || channel.type !== 2) {
      respond(false, { error: "Invalid voice channel" });
      return;
    }
    await handleVoiceConnection(channel as VoiceChannel, channel.guildId);
    respond(true, { ok: true, channelId });
  });

  api.registerGatewayMethod("discord-voice.leave", async ({ params, respond }) => {
    const { channelId } = params;
    const conn = activeConnections.get(channelId);
    if (conn) {
      conn.destroy();
      activeConnections.delete(channelId);
      respond(true, { ok: true });
    } else {
      respond(false, { error: "Not in channel" });
    }
  });

  api.registerGatewayMethod("discord-voice.status", ({ respond }) => {
    respond(true, {
      connected: client?.isReady() || false,
      activeChannels: Array.from(activeConnections.keys()),
    });
  });
}

// ============================================
// Plugin Entry Point
// ============================================

export default function register(pluginApi: PluginApi) {
  api = pluginApi;

  api.registerService({
    id: "discord-voice",

    start: async () => {
      const config = api.config.plugins?.entries?.["discord-voice"]?.config;

      // Use plugin-specific token or fall back to main Discord token
      const token = config?.botToken || api.config.channels?.discord?.token;
      if (!token) {
        api.logger.warn("Discord voice: No bot token configured");
        return;
      }

      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates,
        ],
      });

      await client.login(token);
      api.logger.info("Discord voice plugin started");

      // Auto-join configured channels
      if (config?.autoJoin?.enabled && config?.autoJoin?.channelIds) {
        for (const channelId of config.autoJoin.channelIds) {
          try {
            const channel = await client.channels.fetch(channelId);
            if (channel?.type === 2) {
              await handleVoiceConnection(channel as VoiceChannel, channel.guildId);
            }
          } catch (err) {
            api.logger.error(`Failed to auto-join ${channelId}: ${err}`);
          }
        }
      }
    },

    stop: async () => {
      // Leave all voice channels
      for (const conn of Array.from(activeConnections.values())) {
        conn.destroy();
      }
      activeConnections.clear();

      // Disconnect client
      client?.destroy();
      client = null;
      api.logger.info("Discord voice plugin stopped");
    },
  });

  registerCommands();
  registerGatewayMethods();
}
