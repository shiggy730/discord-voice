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
let followedUsers: Set<string> = new Set();
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
  const extraSystemPrompt = `You are ${agentName} responding via voice in a Discord voice channel. Keep responses brief and conversational (1-3 sentences) since they'll be spoken aloud. Be natural and friendly. You have access to all your normal tools and memory.`;

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
    const player = createAudioPlayer();
    connection.subscribe(player);

    api.logger.info(`Voice receiver ready, listening for audio...`);

  // Listen to each user's audio
  receiver.speaking.on("start", (userId) => {
    api.logger.info(`[DEBUG] User ${userId} started speaking`);
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
          
          // 3. Generate TTS using edge-tts CLI
          const ttsPath = join(tmpdir(), `tts-${Date.now()}.mp3`);
          const safeText = replyText.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/'/g, "'\\''");
          execSync(`/home/shiggy730/anaconda3/envs/natsu/bin/edge-tts --voice "en-GB-SoniaNeural" --text "${safeText}" --write-media "${ttsPath}"`, { stdio: 'pipe' });
          
          // 4. Play audio response
          const resource = createAudioResource(ttsPath);
          player.play(resource);
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

    api.logger.info(`[DEBUG] Subscribed to audio stream for user ${userId}`);

    let chunkCount = 0;
    audioStream.on("data", (chunk) => {
      chunkCount++;
      if (chunkCount === 1 || chunkCount % 50 === 0) {
        api.logger.info(`[DEBUG] Received audio chunk #${chunkCount} (${chunk.length} bytes) from user ${userId}`);
      }
      // Discord sends Opus-encoded audio, need to decode
      // VAD would analyze the decoded PCM
      vad.processAudio(chunk, true);
    });

    audioStream.on("end", () => {
      api.logger.info(`[DEBUG] Audio stream ended for user ${userId}, total chunks: ${chunkCount}`);
      vad.processAudio(Buffer.alloc(0), false);
    });
  });

  } catch (err) {
    api.logger.error(`Voice setup error: ${err}`);
  }

  return connection;
}

// ============================================
// Follow-the-User (Auto-join when user joins voice)
// ============================================

function setupFollowUser() {
  if (!client) return;

  client.on("voiceStateUpdate", async (oldState, newState) => {
    const config = api.config.plugins?.entries?.["discord-voice"]?.config;

    // Check if follow mode is enabled
    if (!config?.followUser?.enabled) return;

    const userId = newState.member?.id;
    if (!userId) return;

    // Check if this user should be followed
    const followIds = config.followUser?.userIds || [];
    const followOwner = config.followUser?.followOwner !== false;
    const ownerIds = api.config.owner || [];

    const shouldFollow =
      followIds.includes(userId) ||
      (followOwner && ownerIds.includes(userId));

    if (!shouldFollow) return;

    // User joined a voice channel
    if (newState.channel && newState.channel.type === 2) {
      const channelId = newState.channel.id;

      // Don't rejoin if already in this channel
      if (activeConnections.has(channelId)) return;

      api.logger.info(`Following ${userId} to voice channel: ${newState.channel.name}`);

      try {
        await handleVoiceConnection(
          newState.channel as VoiceChannel,
          newState.guild.id
        );
        followedUsers.add(userId);
      } catch (err) {
        api.logger.error(`Failed to follow user to voice: ${err}`);
      }
    }

    // User left voice channel - optionally leave too
    if (oldState.channel && !newState.channel && followedUsers.has(userId)) {
      const channelId = oldState.channel.id;

      if (config.followUser?.leaveWhenEmpty !== false) {
        // Check if any followed users are still in the channel
        const channel = oldState.channel as VoiceChannel;
        const followedStillPresent = channel.members.some(member => {
          const memberId = member.id;
          return followIds.includes(memberId) ||
                 (followOwner && ownerIds.includes(memberId));
        });

        if (!followedStillPresent) {
          api.logger.info(`User left, leaving voice channel: ${oldState.channel.name}`);
          const conn = activeConnections.get(channelId);
          if (conn) {
            conn.destroy();
            activeConnections.delete(channelId);
          }
        }
      }

      followedUsers.delete(userId);
    }
  });

  api.logger.info("Follow-user mode initialized");
}

// ============================================
// Plugin Commands
// ============================================

function registerCommands() {
  // /voice join <channel-id>
  api.registerCommand({
    name: "voice",
    description: "Voice channel controls: join, leave, status",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim().split(/\s+/) || [];
      const action = args[0];
      const channelId = args[1];

      if (action === "join" && channelId) {
        const channel = await client?.channels.fetch(channelId);
        if (!channel || channel.type !== 2) { // 2 = VoiceChannel
          return { text: "Invalid voice channel ID" };
        }
        await handleVoiceConnection(channel as VoiceChannel, channel.guildId);
        return { text: `🎙️ Joined voice channel: ${channel.name}` };
      }

      if (action === "leave" && channelId) {
        const conn = activeConnections.get(channelId);
        if (conn) {
          conn.destroy();
          activeConnections.delete(channelId);
          return { text: "👋 Left voice channel" };
        }
        return { text: "Not in that channel" };
      }

      if (action === "status") {
        const channels = Array.from(activeConnections.keys());
        if (channels.length === 0) {
          return { text: "Not in any voice channels" };
        }
        return { text: `🎙️ Active in: ${channels.join(", ")}` };
      }

      return { text: "Usage: /voice join|leave|status [channel-id]" };
    },
  });
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

      // Setup follow-user mode
      setupFollowUser();

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
