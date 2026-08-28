import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  categoryReply,
  geocodePlace,
  greeting,
  localChatReply,
  matchPlaces,
  notFoundReply,
  parseIntent,
  rideReply,
  topByCategory,
} from "../lib/assistant";
import { loadPlaces } from "../lib/data";
import { askRealBro, type BroChatTurn } from "../lib/openrouter";
import {
  canMediaRecord,
  preferRecordStt,
  startMicCapture,
  transcribeAudioBlob,
  type RecSession,
} from "../lib/stt";
import { hushVoice, speakText, unlockVoice, warmVoices } from "../lib/voice";
import type { Place, PlaceType } from "../types";

type Phase = "idle" | "listening" | "speaking";
type ProviderState = "unknown" | "online" | "local" | "offline";

type Card = { key: string; name: string; sub: string; lat: number; lon: number; rating?: number | null };

type Msg = { id: number; role: "user" | "bro"; text: string; cards?: Card[] };
type PendingQuery = { text: string; userMessageId: number };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: {
    resultIndex?: number;
    results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
  }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function recognizerCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as new () => SpeechRecognitionLike | undefined) ||
    (w.webkitSpeechRecognition as new () => SpeechRecognitionLike | undefined) ||
    null
  ) as (new () => SpeechRecognitionLike) | null;
}

function placeCard(p: Place): Card {
  return {
    key: p.id,
    name: p.name,
    sub: [p.city, p.country].filter(Boolean).join(", "),
    lat: p.lat,
    lon: p.lon,
    rating: p.rating,
  };
}

function RealBroAvatar({ phase, size = 46 }: { phase: Phase; size?: number }) {
  return (
    <span className={`rb-ava ${phase}`} style={{ width: size, height: size }} data-phase={phase}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <rect x="13" y="21" width="17" height="10" rx="5" fill="#0c0c0c" />
        <rect x="34" y="21" width="17" height="10" rx="5" fill="#0c0c0c" />
        <rect x="28" y="23" width="8" height="4" rx="2" fill="#0c0c0c" />
        <path
          d="M17 34 q15 12 30 0 q1 16 -11 21 q-4 2 -8 0 q-12 -5 -11 -21 z"
          fill="#0c0c0c"
        />
        <path d="M24 36 q8 6 16 0 l-2 5 q-6 4 -12 0 z" fill="#0c0c0c" />
      </svg>
    </span>
  );
}

function VoiceWaveform({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const draw = canvas?.getContext("2d");
    if (!canvas || !draw) return;

    let frame = 0;
    const fit = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      draw.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    fit();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resize?.observe(canvas);

    const paint = (now: number) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      draw.clearRect(0, 0, width, height);
      const bars = 28;
      const gap = 2.5;
      const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars);
      const gradient = draw.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "#29aae1");
      gradient.addColorStop(0.55, "#3d8aff");
      gradient.addColorStop(1, "#e10600");
      draw.fillStyle = gradient;
      for (let i = 0; i < bars; i++) {
        const sample = 0.18 + Math.abs(Math.sin(now / 170 + i * 0.62)) * 0.72;
        const barHeight = Math.max(3, sample * (height - 2));
        draw.beginPath();
        draw.roundRect(i * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight, barWidth / 2);
        draw.fill();
      }
      frame = window.requestAnimationFrame(paint);
    };
    frame = window.requestAnimationFrame(paint);

    return () => {
      window.cancelAnimationFrame(frame);
      resize?.disconnect();
    };
  }, [active]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      className="rb-waveform"
      data-testid="assistant-waveform"
      role="img"
      aria-label="Live voice waveform"
    />
  );
}

let seq = 0;

export function RealBro() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState("");
  const [providerState, setProviderState] = useState<ProviderState>("unknown");
  const msgsRef = useRef<Msg[]>([]);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const captureRef = useRef<RecSession | null>(null);
  const useRecordRef = useRef(false);
  const startingRef = useRef(false);
  const voiceTokenRef = useRef(0);
  const wantListen = useRef(false);
  const heardRef = useRef("");
  const restartTimer = useRef(0);
  const silenceTimer = useRef(0);
  const levelPoll = useRef(0);
  const handleQueryRef = useRef<(raw: string) => Promise<void>>(async () => undefined);
  const lastSubmitRef = useRef({ text: "", at: 0 });
  const queryQueueRef = useRef<PendingQuery[]>([]);
  const workerActiveRef = useRef(false);
  const workerGenerationRef = useRef(0);
  const activeQueryTokenRef = useRef(0);
  const openRef = useRef(false);
  const aliveRef = useRef(true);
  const queryAbortRef = useRef<AbortController | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hasSpeechApi = recognizerCtor() !== null;
  const hasMic = hasSpeechApi || canMediaRecord();
  useRecordRef.current = preferRecordStt(hasSpeechApi);
  openRef.current = open;

  function clearListenTimers() {
    window.clearTimeout(restartTimer.current);
    window.clearTimeout(silenceTimer.current);
    window.clearInterval(levelPoll.current);
  }

  function stopSpeechRecOnly() {
    try {
      recRef.current?.stop();
    } catch {
      /* already ended */
    }
    recRef.current = null;
  }

  async function finishRecord(submit: boolean) {
    const session = captureRef.current;
    captureRef.current = null;
    const token = ++voiceTokenRef.current;
    clearListenTimers();
    wantListen.current = false;
    startingRef.current = false;
    setPhase("idle");
    if (!session) return;
    const blob = await session.stop();
    if (token !== voiceTokenRef.current || !aliveRef.current || !openRef.current) return;
    if (!submit || !blob || !blob.size) {
      setInput("");
      if (token === voiceTokenRef.current) {
        setVoiceNotice(submit ? "No audio was captured. Check microphone access and try again." : "");
      }
      return;
    }
    if (token === voiceTokenRef.current) setVoiceNotice("Transcribing…");
    const controller = new AbortController();
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = controller;
    const text = await transcribeAudioBlob(blob, session.format, controller.signal);
    if (transcribeAbortRef.current === controller) transcribeAbortRef.current = null;
    if (token !== voiceTokenRef.current || !aliveRef.current || !openRef.current) return;
    setInput("");
    if (token === voiceTokenRef.current) {
      setVoiceNotice(
        text ? "" : "Couldn’t transcribe that. Check your connection, then tap the mic and try again.",
      );
    }
    if (text) void handleQueryRef.current(text);
  }

  function stopListening(submit: boolean) {
    if (captureRef.current) {
      void finishRecord(submit);
      return;
    }
    const text = heardRef.current.trim();
    wantListen.current = false;
    startingRef.current = false;
    heardRef.current = "";
    clearListenTimers();
    stopSpeechRecOnly();
    setPhase("idle");
    if (submit && text) {
      setInput("");
      void handleQueryRef.current(text);
    }
  }

  function beginRec() {
    if (useRecordRef.current) return;
    const Ctor = recognizerCtor();
    if (!Ctor || !wantListen.current || startingRef.current) return;
    window.clearTimeout(silenceTimer.current);
    const prev = recRef.current;
    recRef.current = null;
    try {
      prev?.stop();
    } catch {
      /* ignore */
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    // continuous restart is flaky on mobile WebViews; single utterance + silence is stabler.
    const mobile = /Android|Mobile|iPhone|iPad/i.test(navigator.userAgent || "");
    rec.continuous = !mobile;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      if (!wantListen.current) return;
      const start = e.resultIndex ?? 0;
      let interim = "";
      for (let i = start; i < e.results.length; i++) {
        const row = e.results[i];
        const piece = row[0]?.transcript ?? "";
        if (row.isFinal) heardRef.current = `${heardRef.current} ${piece}`.trim();
        else interim += piece;
      }
      setInput([heardRef.current, interim].filter(Boolean).join(" "));
      window.clearTimeout(silenceTimer.current);
      if (heardRef.current) {
        silenceTimer.current = window.setTimeout(() => {
          if (wantListen.current && heardRef.current.trim()) stopListening(true);
        }, mobile ? 1200 : 1600);
      }
    };
    rec.onerror = (err) => {
      const code = err.error || "";
      if (!wantListen.current || code === "not-allowed" || code === "service-not-allowed") {
        if (code === "not-allowed" || code === "service-not-allowed") {
          stopListening(false);
          setVoiceNotice("Microphone access is blocked. Allow it in browser settings and try again.");
        }
        return;
      }
      if ((code === "network" || code === "audio-capture" || code === "aborted") && canMediaRecord()) {
        useRecordRef.current = true;
        stopSpeechRecOnly();
        setVoiceNotice("Switching to reliable voice recording…");
        void beginRecord();
        return;
      }
      window.clearTimeout(restartTimer.current);
      restartTimer.current = window.setTimeout(() => {
        if (wantListen.current) beginRec();
      }, 280);
    };
    rec.onend = () => {
      if (recRef.current !== rec || !wantListen.current) return;
      if (heardRef.current.trim() && !rec.continuous) {
        stopListening(true);
        return;
      }
      window.clearTimeout(restartTimer.current);
      restartTimer.current = window.setTimeout(() => {
        if (wantListen.current) beginRec();
      }, 280);
    };
    recRef.current = rec;
    setPhase("listening");
    setVoiceNotice("Speak now.");
    try {
      rec.start();
    } catch {
      window.clearTimeout(restartTimer.current);
      restartTimer.current = window.setTimeout(() => {
        if (wantListen.current) beginRec();
      }, 320);
    }
  }

  async function beginRecord() {
    if (!wantListen.current || !canMediaRecord() || captureRef.current || startingRef.current) return;
    startingRef.current = true;
    stopSpeechRecOnly();
    clearListenTimers();
    try {
      if (!wantListen.current) {
        startingRef.current = false;
        return;
      }
      const session = await startMicCapture();
      if (!wantListen.current) {
        await session.stop();
        startingRef.current = false;
        return;
      }
      captureRef.current = session;
      startingRef.current = false;
      setPhase("listening");
      setInput("");
      setVoiceNotice("Speak, then tap the red mic again to send.");
      let heardVoice = false;
      let quietMs = 0;
      const startedAt = Date.now();
      levelPoll.current = window.setInterval(() => {
        if (!wantListen.current || !captureRef.current) return;
        const lvl = captureRef.current.level();
        if (lvl > 0.035) {
          heardVoice = true;
          quietMs = 0;
        } else if (heardVoice) {
          quietMs += 100;
          if (quietMs >= 1400 && Date.now() - startedAt > 700) {
            void finishRecord(true);
          }
        }
        if (Date.now() - startedAt > 22_000) void finishRecord(true);
      }, 100);
    } catch {
      wantListen.current = false;
      startingRef.current = false;
      setPhase("idle");
      setInput("");
      setVoiceNotice("Microphone unavailable. Check its permission and close other recording apps.");
    }
  }

  useEffect(() => {
    warmVoices();
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const onVis = () => {
      if (document.visibilityState === "visible" && wantListen.current && !useRecordRef.current && !captureRef.current) {
        beginRec();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      aliveRef.current = false;
      document.removeEventListener("visibilitychange", onVis);
      clearListenTimers();
      wantListen.current = false;
      startingRef.current = false;
      stopSpeechRecOnly();
      const session = captureRef.current;
      captureRef.current = null;
      void session?.stop();
      workerGenerationRef.current += 1;
      activeQueryTokenRef.current += 1;
      queryQueueRef.current = [];
      workerActiveRef.current = false;
      queryAbortRef.current?.abort();
      queryAbortRef.current = null;
      transcribeAbortRef.current?.abort();
      transcribeAbortRef.current = null;
      hushVoice();
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs]);

  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--wb-kb", `${Math.round(inset)}px`);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      document.documentElement.style.setProperty("--wb-kb", "0px");
    };
  }, [open]);

  function push(msg: Omit<Msg, "id">): number {
    const item = { ...msg, id: ++seq };
    const next = [...msgsRef.current, item];
    msgsRef.current = next;
    setMsgs(next);
    return item.id;
  }

  function queryActive(workerGeneration: number, token: number): boolean {
    return (
      aliveRef.current &&
      openRef.current &&
      workerGenerationRef.current === workerGeneration &&
      activeQueryTokenRef.current === token
    );
  }

  async function deliverReply(
    text: string,
    cards: Card[] | undefined,
    workerGeneration: number,
    token: number,
  ) {
    let revealed = false;
    const reveal = () => {
      if (revealed || !queryActive(workerGeneration, token)) return;
      revealed = true;
      push({ role: "bro", text, cards });
    };

    // Never let a late reply steal the audio session from an active microphone.
    if (
      wantListen.current ||
      captureRef.current ||
      startingRef.current ||
      document.visibilityState !== "visible"
    ) {
      hushVoice();
      reveal();
      return;
    }

    const voiceStartDeadline = window.setTimeout(() => {
      if (!revealed && queryActive(workerGeneration, token)) {
        hushVoice();
        reveal();
      }
    }, 10_000);
    const spoken = await speakText(text, "en-US", {
      onStart: () => {
        window.clearTimeout(voiceStartDeadline);
        if (!queryActive(workerGeneration, token)) {
          hushVoice();
          return;
        }
        reveal();
        setPhase("speaking");
      },
      onEnd: () => {
        if (queryActive(workerGeneration, token) && !wantListen.current) setPhase("idle");
      },
    });
    window.clearTimeout(voiceStartDeadline);
    // If both neural and browser speech fail, the rider still gets the answer.
    if (!spoken) reveal();
    if (queryActive(workerGeneration, token) && !wantListen.current) setPhase("idle");
  }

  function openSheet() {
    unlockVoice();
    openRef.current = true;
    setOpen(true);
    if (!msgsRef.current.length) {
      const hello = greeting();
      push({ role: "bro", text: hello });
      // Keep opening silent: a delayed greeting used to start after the rider tapped the mic.
    }
  }

  function closeSheet() {
    openRef.current = false;
    voiceTokenRef.current++;
    setOpen(false);
    hushVoice();
    stopListening(false);
    workerGenerationRef.current += 1;
    activeQueryTokenRef.current += 1;
    queryQueueRef.current = [];
    workerActiveRef.current = false;
    queryAbortRef.current?.abort();
    queryAbortRef.current = null;
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    setBusy(false);
  }

  async function answerRide(
    query: string,
    workerGeneration: number,
    token: number,
    signal: AbortSignal,
    aiReply?: string,
  ) {
    const places = await loadPlaces();
    if (!queryActive(workerGeneration, token)) return;
    const found = matchPlaces(places, query);
    if (found.length) {
      const reply = aiReply || rideReply(found[0].name, false);
      await deliverReply(reply, found.map(placeCard), workerGeneration, token);
      return;
    }
    const geo = await geocodePlace(query, signal);
    if (!queryActive(workerGeneration, token)) return;
    if (geo) {
      const reply = aiReply || rideReply(geo.name, false);
      await deliverReply(
        reply,
        [{ key: `geo-${geo.lat}`, name: geo.name, sub: "Point on the map", lat: geo.lat, lon: geo.lon }],
        workerGeneration,
        token,
      );
      return;
    }
    const reply = aiReply || notFoundReply(query, false);
    await deliverReply(reply, undefined, workerGeneration, token);
  }

  async function answerCategory(
    type: PlaceType,
    workerGeneration: number,
    token: number,
    country?: string,
    aiReply?: string,
  ) {
    const places = await loadPlaces();
    if (!queryActive(workerGeneration, token)) return;
    const list = topByCategory(places, type, country);
    const reply = aiReply || categoryReply(list.length, type, country, false);
    await deliverReply(reply, list.map(placeCard), workerGeneration, token);
  }

  async function processQuery(item: PendingQuery, workerGeneration: number) {
    const token = ++activeQueryTokenRef.current;
    const controller = new AbortController();
    queryAbortRef.current = controller;
    const deadline = window.setTimeout(
      () => controller.abort(new DOMException("Real Bro request timed out", "TimeoutError")),
      35_000,
    );
    try {
      const intent = parseIntent(item.text);
      if (intent.kind === "ride") {
        setProviderState("local");
        await answerRide(intent.query, workerGeneration, token, controller.signal);
        return;
      }
      if (intent.kind === "category") {
        setProviderState("local");
        await answerCategory(intent.type, workerGeneration, token, intent.country);
        return;
      }

      const history: BroChatTurn[] = msgsRef.current
        .filter((message) => message.id < item.userMessageId)
        .slice(-8)
        .map((m) => ({ role: m.role === "bro" ? "assistant" : "user", content: m.text }));
      const ai = await askRealBro(item.text, history, controller.signal);
      if (!queryActive(workerGeneration, token)) return;
      setProviderState(ai ? "online" : "offline");
      if (ai?.intent === "ride" && ai.query) {
        await answerRide(ai.query, workerGeneration, token, controller.signal, ai.reply);
        return;
      }
      if (ai?.intent === "category" && ai.type) {
        await answerCategory(ai.type, workerGeneration, token, ai.country, ai.reply);
        return;
      }
      const reply = ai?.reply || localChatReply(item.text);
      await deliverReply(reply, undefined, workerGeneration, token);
    } catch {
      if (!queryActive(workerGeneration, token)) return;
      setProviderState("offline");
      await deliverReply(localChatReply(item.text), undefined, workerGeneration, token);
    } finally {
      window.clearTimeout(deadline);
      if (queryAbortRef.current === controller) queryAbortRef.current = null;
    }
  }

  async function drainQueue() {
    if (workerActiveRef.current) return;
    const workerGeneration = workerGenerationRef.current;
    workerActiveRef.current = true;
    setBusy(true);
    try {
      while (
        queryQueueRef.current.length &&
        aliveRef.current &&
        openRef.current &&
        workerGenerationRef.current === workerGeneration
      ) {
        const item = queryQueueRef.current.shift();
        if (item) await processQuery(item, workerGeneration);
      }
    } finally {
      if (workerGenerationRef.current !== workerGeneration) return;
      workerActiveRef.current = false;
      setBusy(false);
      if (queryQueueRef.current.length) void drainQueue();
    }
  }

  async function handleQuery(raw: string) {
    const text = raw.trim();
    if (!text || !openRef.current) return;
    const now = Date.now();
    // Voice silence + send (or overlapping recognizers) used to fire the same line twice.
    if (text === lastSubmitRef.current.text && now - lastSubmitRef.current.at < 2200) return;
    lastSubmitRef.current = { text, at: now };
    const userMessageId = push({ role: "user", text });
    queryQueueRef.current.push({ text, userMessageId });
    void drainQueue();
  }
  handleQueryRef.current = handleQuery;

  function handleSend() {
    const text = input;
    if (!text.trim()) return;
    unlockVoice();
    setInput("");
    void handleQuery(text);
  }

  function startListening() {
    if (!hasMic) return;
    if (wantListen.current || captureRef.current) {
      stopListening(true);
      return;
    }
    voiceTokenRef.current++;
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    hushVoice();
    unlockVoice();
    heardRef.current = "";
    wantListen.current = true;
    startingRef.current = false;
    setInput("");
    setVoiceNotice(useRecordRef.current ? "Starting microphone…" : "Starting voice input…");
    if (useRecordRef.current) void beginRecord();
    else beginRec();
  }

  function rideTo(card: Card) {
    closeSheet();
    nav(`/map?to=${card.lat},${card.lon}&name=${encodeURIComponent(card.name)}`);
  }

  const stateLabel =
    phase === "listening"
      ? "Listening…"
      : phase === "speaking"
        ? "Speaking…"
        : busy
          ? "Thinking…"
          : providerState === "online"
            ? "Online"
            : providerState === "local"
              ? "Local search"
            : providerState === "offline"
              ? "Offline mode"
              : "Ready";

  return (
    <>
      <button className="rb-row" data-testid="assistant-row" onClick={openSheet}>
        <span>AI assistant</span>
        <RealBroAvatar phase="idle" />
        <span>«Real Bro»</span>
      </button>

      {open && (
        <>
          <div className="backdrop" onClick={closeSheet} />
          <div className="rb-sheet" data-testid="assistant-sheet">
            <div className="rb-head">
              <RealBroAvatar phase={phase} size={52} />
              <div>
                <b>Real Bro</b>
                <span className="rb-state">{stateLabel}</span>
              </div>
              <button className="icon-btn" aria-label="Close assistant" onClick={closeSheet}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <VoiceWaveform active={phase === "listening"} />
            {voiceNotice && (
              <div className="rb-voice-notice" data-testid="assistant-voice-notice" role="status">
                {voiceNotice}
              </div>
            )}

            <div className="rb-msgs" ref={listRef}>
              {msgs.map((m) => (
                <div key={m.id} className={`rb-bubble ${m.role}`}>
                  {m.text}
                  {m.cards && m.cards.length > 0 && (
                    <div className="rb-cards">
                      {m.cards.map((c) => (
                        <div key={c.key} className="rb-card" data-testid="assistant-card">
                          <div className="rb-card-info">
                            <b>{c.name}</b>
                            <span>
                              {c.rating ? `★ ${c.rating.toFixed(1)} · ` : ""}
                              {c.sub}
                            </span>
                          </div>
                          <button className="rb-go" data-testid="assistant-ride" onClick={() => rideTo(c)}>
                            Go
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="rb-input">
              <input
                data-testid="assistant-input"
                value={input}
                placeholder='Say or type: "what bars are in Montenegro?"'
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSend();
                }}
              />
              {hasMic && (
                <button
                  className={`rb-mic${phase === "listening" ? " on" : ""}`}
                  aria-label="Voice input"
                  onClick={startListening}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="3" width="6" height="11" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                  </svg>
                </button>
              )}
              <button
                className="rb-send"
                data-testid="assistant-send"
                aria-label="Send"
                onClick={handleSend}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 12h14M13 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
