const key = String(process.env.VITE_OPENROUTER_API_KEY || "").trim();
if (!key) {
  console.error("VITE_OPENROUTER_API_KEY is missing");
  process.exit(1);
}

const tries = [
  { model: "minimax/speech-2.8-turbo", voice: "English_ManWithDeepVoice", response_format: "mp3" },
  { model: "deepgram/aura-2", voice: "aura-2-odysseus-en", response_format: "mp3", speed: 0.92 },
];

let ok = false;
let speechSample = null;
for (const cfg of tries) {
  const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://welcome-bikers.github.io/welcome-bikers/",
      "X-Title": "Welcome Bikers CI TTS probe",
    },
    body: JSON.stringify({
      ...cfg,
      input: "Yo bro. Real Bro online. Lets ride.",
    }),
  });
  if (!res.ok) {
    console.warn("TTS try failed", cfg.model, res.status, (await res.text()).slice(0, 160));
    continue;
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 1000) {
    console.warn("TTS too small", cfg.model, buf.byteLength);
    continue;
  }
  console.log("TTS OK", cfg.model, cfg.voice, "bytes=", buf.byteLength);
  speechSample = Buffer.from(buf);
  ok = true;
  break;
}

if (!ok) {
  console.error("All TTS probes failed");
  process.exit(1);
}

const transcription = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://welcome-bikers.github.io/welcome-bikers/",
    "X-Title": "Welcome Bikers CI voice roundtrip",
  },
  body: JSON.stringify({
    model: "openai/whisper-1",
    input_audio: { data: speechSample.toString("base64"), format: "mp3" },
  }),
});
const transcriptBody = await transcription.text();
if (!transcription.ok) {
  console.error("STT probe failed", transcription.status, transcriptBody.slice(0, 300));
  process.exit(1);
}
const transcript = String(JSON.parse(transcriptBody)?.text || "").trim();
if (!/real|bro|online|ride/i.test(transcript)) {
  console.error("STT probe returned an unexpected transcript", transcript.slice(0, 160));
  process.exit(1);
}
console.log("Voice roundtrip OK transcript=", transcript.slice(0, 100));
