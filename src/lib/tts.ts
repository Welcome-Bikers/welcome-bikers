/** Neural TTS for Real Bro via the server-side proxy, with Web Speech fallback. */

import { withAbortTimeout } from "./net";
import { resolveProxyBase, speechUrl } from "./orProxy";

export type SpeechEvents = {
  onStart?: () => void;
  onEnd?: () => void;
};

type WebSpeechFallback = (text: string, events: SpeechEvents) => Promise<boolean>;

/** Deep male chain — bass / street energy when the provider allows. */
const TTS_TRIES: { model: string; voice: string; format: "mp3" | "pcm"; speed?: number; prompt?: string }[] = [
  {
    model: "minimax/speech-2.8-turbo",
    voice: "English_ManWithDeepVoice",
    format: "mp3",
  },
  {
    model: "deepgram/aura-2",
    voice: "aura-2-odysseus-en",
    format: "mp3",
    speed: 0.92,
  },
  {
    model: "google/gemini-3.1-flash-tts-preview",
    voice: "Charon",
    format: "pcm",
    prompt:
      "Speak as a deep-voiced male street biker: calm gangsta swagger, natural human pacing, warm bass, never robotic.",
  },
];

const MAX_CACHE_ITEMS = 24;
const TTS_DEADLINE_MS = 18_000;
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

const cache = new Map<string, Blob>();
let sharedAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;
let pendingSpeechAbort: AbortController | null = null;
let currentPlaybackStop: (() => void) | null = null;
let playGeneration = 0;
let audioUnlocked = false;
let unlockInFlight = false;
let unlockGeneration = 0;

function getAudio(): HTMLAudioElement {
  if (sharedAudio) return sharedAudio;
  const audio = new Audio();
  audio.setAttribute("playsinline", "true");
  audio.setAttribute("webkit-playsinline", "true");
  (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
  audio.preload = "auto";
  sharedAudio = audio;
  return audio;
}

/**
 * Must be called directly from a tap/click handler. It primes the shared audio
 * element so a later async neural response can play on iOS.
 */
export function unlockNeuralVoice() {
  if (audioUnlocked || unlockInFlight || currentPlaybackStop) return;
  try {
    const audio = getAudio();
    const generation = playGeneration;
    const requestGeneration = ++unlockGeneration;
    unlockInFlight = true;
    audio.src = SILENT_WAV;
    audio.volume = 0;
    const pending = audio.play();
    void pending.then(() => {
      if (requestGeneration !== unlockGeneration) return;
      unlockInFlight = false;
      if (generation !== playGeneration || currentPlaybackStop) return;
      audioUnlocked = true;
      audio.pause();
      audio.currentTime = 0;
      audio.volume = 1;
      audio.removeAttribute("src");
      audio.load();
    }).catch(() => {
      if (requestGeneration !== unlockGeneration) return;
      unlockInFlight = false;
      audio.volume = 1;
    });
  } catch {
    unlockInFlight = false;
    // Web Speech fallback remains available.
  }
}

export function hushNeuralVoice() {
  playGeneration += 1;
  if (unlockInFlight) {
    unlockGeneration += 1;
    unlockInFlight = false;
  }
  pendingSpeechAbort?.abort(new DOMException("Speech cancelled", "AbortError"));
  pendingSpeechAbort = null;
  currentPlaybackStop?.();
  currentPlaybackStop = null;
  try {
    const audio = sharedAudio;
    if (audio) {
      audio.pause();
      audio.volume = 1;
      audio.removeAttribute("src");
      audio.load();
    }
  } catch {
    // Ignore media cleanup failures.
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

function pcmToWav(pcm: ArrayBuffer, sampleRate = 24_000): Blob {
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm));
  return new Blob([buffer], { type: "audio/wav" });
}

function remember(text: string, blob: Blob) {
  if (cache.size >= MAX_CACHE_ITEMS) {
    const first = cache.keys().next().value;
    if (typeof first === "string") cache.delete(first);
  }
  cache.set(text, blob);
}

async function fetchSpeech(text: string, signal: AbortSignal): Promise<Blob | null> {
  const cached = cache.get(text);
  if (cached) return cached;
  const deadline = Date.now() + TTS_DEADLINE_MS;

  for (let proxyAttempt = 0; proxyAttempt < 2; proxyAttempt += 1) {
    if (signal.aborted || Date.now() >= deadline) return null;
    let base = "";
    try {
      base = await withAbortTimeout(
        (stepSignal) => resolveProxyBase(proxyAttempt > 0, stepSignal),
        Math.min(6_000, deadline - Date.now()),
        signal,
      );
    } catch {
      if (signal.aborted) return null;
      continue;
    }
    if (!base) continue;

    let rotateProxy = false;
    for (const tryCfg of TTS_TRIES) {
      const remaining = deadline - Date.now();
      if (signal.aborted || remaining <= 0) return null;
      try {
        const body: Record<string, unknown> = {
          model: tryCfg.model,
          input: text,
          voice: tryCfg.voice,
          response_format: tryCfg.format,
        };
        if (tryCfg.speed != null) body.speed = tryCfg.speed;
        if (tryCfg.prompt) body.provider = { options: { google: { prompt: tryCfg.prompt } } };

        const result = await withAbortTimeout(async (stepSignal) => {
          const response = await fetch(speechUrl(base), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: stepSignal,
            body: JSON.stringify(body),
          });
          if (!response.ok) return { response, raw: null as ArrayBuffer | null };
          return { response, raw: await response.arrayBuffer() };
        }, Math.min(8_000, remaining), signal);

        if (!result.response.ok) continue;
        if (!result.raw?.byteLength) continue;
        const blob = tryCfg.format === "pcm"
          ? pcmToWav(result.raw)
          : new Blob([result.raw], { type: "audio/mpeg" });
        remember(text, blob);
        return blob;
      } catch {
        if (signal.aborted) return null;
        rotateProxy = true;
        break;
      }
    }
    if (!rotateProxy) break;
  }
  return null;
}

function playBlob(blob: Blob, events: SpeechEvents, generation: number): Promise<boolean> {
  const audio = getAudio();
  const url = URL.createObjectURL(blob);
  currentObjectUrl = url;
  audio.src = url;
  audio.volume = 1;
  audio.preload = "auto";

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let started = false;
    let watchdog = window.setTimeout(() => settle(), 60_000);

    const cleanup = () => {
      window.clearTimeout(watchdog);
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      audio.onloadedmetadata = null;
      if (currentPlaybackStop === stop) currentPlaybackStop = null;
      if (currentObjectUrl === url) {
        URL.revokeObjectURL(url);
        currentObjectUrl = null;
      }
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (started) events.onEnd?.();
      resolve(started);
    };
    const stop = () => settle();
    currentPlaybackStop = stop;

    audio.onplaying = () => {
      if (started || generation !== playGeneration) return;
      started = true;
      audioUnlocked = true;
      events.onStart?.();
    };
    audio.onloadedmetadata = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(settle, Math.min(120_000, Math.ceil(audio.duration * 1_000) + 8_000));
    };
    audio.onended = settle;
    audio.onerror = settle;
    void audio.play().catch(settle);
  });
}

/**
 * Resolves after playback ends (or cannot start). onStart is driven by the
 * actual media/speech event, so UI text can appear with the first audible word.
 */
export async function speakBroNeural(
  text: string,
  events: SpeechEvents = {},
  webSpeak?: WebSpeechFallback,
): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return false;

  hushNeuralVoice();
  const requestGeneration = playGeneration;
  const controller = new AbortController();
  pendingSpeechAbort = controller;
  try {
    const blob = await fetchSpeech(clean, controller.signal);
    if (pendingSpeechAbort === controller) pendingSpeechAbort = null;
    if (controller.signal.aborted || requestGeneration !== playGeneration) return false;
    if (blob) {
      const played = await playBlob(blob, events, requestGeneration);
      if (played || requestGeneration !== playGeneration) return played;
    }
    return webSpeak ? webSpeak(clean, events) : false;
  } catch {
    if (pendingSpeechAbort === controller) pendingSpeechAbort = null;
    if (controller.signal.aborted || requestGeneration !== playGeneration) return false;
    return webSpeak ? webSpeak(clean, events) : false;
  }
}
