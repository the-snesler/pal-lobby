// Synthesized lobby sounds (WebAudio, no audio files). Off until the user turns them on.

const storageKey = "pal-lobby-sound";
/** C major pentatonic over two octaves, in semitones above the base note. */
const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
const baseFrequency = 523.25; // C5
/** Gap between queued sounds so a burst of events doesn't turn into one noisy blob. */
const spacing = 0.07;
/** Drop sounds that would start further than this in the future. */
const maxQueue = 0.8;

let enabled = localStorage.getItem(storageKey) === "on";
/** @type {AudioContext | null} */
let audio = null;
let master = null;
let nextStart = 0;

function ensureContext() {
  if (!audio) {
    audio = new AudioContext();
    master = audio.createGain();
    master.gain.value = 0.35;
    // Keep overlapping sounds from clipping.
    const compressor = audio.createDynamicsCompressor();
    master.connect(compressor).connect(audio.destination);
  }
  if (audio.state === "suspended") audio.resume();
}

// Browsers only allow audio after a user gesture, so (re)unlock on clicks.
addEventListener("pointerdown", () => {
  if (enabled) ensureContext();
});

export function isSoundEnabled() {
  return enabled;
}

export function setSoundEnabled(on) {
  enabled = on;
  localStorage.setItem(storageKey, on ? "on" : "off");
  if (on) ensureContext();
}

/** A stable note for a string, so each pal (or game) has its own pitch. */
function noteFor(key) {
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.codePointAt(0)) | 0;
  const semitones = scale[Math.abs(hash) % scale.length];
  return baseFrequency * 2 ** (semitones / 12);
}

function tone(freq, start, { type = "sine", attack = 0.005, decay = 0.2, gain = 0.4, glideTo, glideTime = 0.05 } = {}) {
  const osc = audio.createOscillator();
  const env = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + glideTime);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
  osc.connect(env).connect(master);
  osc.start(start);
  osc.stop(start + attack + decay + 0.05);
}

function bell(freq, start, gain) {
  tone(freq, start, { decay: 0.7, gain });
  tone(freq * 2.01, start, { decay: 0.3, gain: gain * 0.25 });
}

const sounds = {
  /** Pal comes online: a quick upward pop. */
  online: (f, t) => tone(f * 0.6, t, { glideTo: f, glideTime: 0.04, decay: 0.12, gain: 0.5 }),
  /** Pal goes offline: a soft falling bloop. */
  offline: (f, t) => tone(f, t, { glideTo: f * 0.5, glideTime: 0.25, decay: 0.28, gain: 0.22 }),
  /** Starts a game alone (badge appears). */
  startGame: (f, t) => {
    tone(f, t, { type: "triangle", decay: 0.1, gain: 0.3 });
    tone(f * 1.5, t + 0.07, { type: "triangle", decay: 0.16, gain: 0.3 });
  },
  /** Leaves a game. */
  leaveGame: (f, t) => {
    tone(f * 1.5, t, { type: "triangle", decay: 0.1, gain: 0.22 });
    tone(f, t + 0.07, { type: "triangle", decay: 0.16, gain: 0.22 });
  },
  /** Joins a game that already has a circle. */
  joinGroup: (f, t) => {
    [1, 1.25, 1.5].forEach((ratio, i) => tone(f * ratio, t + i * 0.06, { type: "triangle", decay: 0.14, gain: 0.28 }));
  },
  /** Second player joins: the badge becomes a circle. */
  groupForms: (f, t) => {
    [1, 1.25, 1.5, 2].forEach((ratio, i) => bell((f / 2) * ratio, t + i * 0.06, 0.3));
  },
  /** Cursor lands on a pal. */
  hover: (f, t) => tone(f * 2, t, { decay: 0.03, gain: 0.05 }),
};

/**
 * @param {keyof typeof sounds} name
 * @param {string} key pitch seed, e.g. a pal or activity id
 * @param {{ queue?: boolean }} options queue=false plays now or not at all
 */
export function play(name, key, { queue = true } = {}) {
  if (!enabled || !audio || audio.state !== "running") return;
  const now = audio.currentTime;
  let start = now;
  if (queue) {
    start = Math.max(now, nextStart);
    if (start - now > maxQueue) return;
    nextStart = start + spacing;
  }
  sounds[name](noteFor(key), start);
}
