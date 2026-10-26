/**
 * Tiny synthesized sounds for the home page demo (no audio files). They are scheduled on the audio clock from the same
 * timing numbers the animation uses (see landing-timing.ts), so a staple's "ka-chunk" lands on the frame the stapler
 * hits. Browsers only allow sound after the visitor has clicked something, so nothing here ever plays on page load.
 */
let ctx: AudioContext | null = null;

/** Call from a click handler. Returns null if the browser has no Web Audio. */
export function audioReady(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function noise(c: AudioContext, seconds: number): AudioBufferSourceNode {
  const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * seconds)), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buffer;
  return src;
}

/** A staple going in: a sharp click, a short low thunk and a faint metallic tick. `inMs` = milliseconds from now. */
export function playStaple(inMs: number): void {
  const c = audioReady();
  if (!c) return;
  const t = c.currentTime + Math.max(0, inMs) / 1000;
  const master = c.createGain();
  master.gain.value = 0.55;
  master.connect(c.destination);

  const click = noise(c, 0.04);
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1800;
  const clickGain = c.createGain();
  clickGain.gain.setValueAtTime(0.0001, t);
  clickGain.gain.exponentialRampToValueAtTime(0.7, t + 0.002);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  click.connect(hp).connect(clickGain).connect(master);
  click.start(t);

  const thunk = c.createOscillator();
  thunk.type = "sine";
  thunk.frequency.setValueAtTime(170, t);
  thunk.frequency.exponentialRampToValueAtTime(65, t + 0.09);
  const thunkGain = c.createGain();
  thunkGain.gain.setValueAtTime(0.0001, t);
  thunkGain.gain.exponentialRampToValueAtTime(0.55, t + 0.004);
  thunkGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  thunk.connect(thunkGain).connect(master);
  thunk.start(t);
  thunk.stop(t + 0.14);

  const tick = c.createOscillator();
  tick.type = "triangle";
  tick.frequency.value = 2600;
  const tickGain = c.createGain();
  tickGain.gain.setValueAtTime(0.0001, t + 0.012);
  tickGain.gain.exponentialRampToValueAtTime(0.09, t + 0.015);
  tickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  tick.connect(tickGain).connect(master);
  tick.start(t + 0.012);
  tick.stop(t + 0.08);
}

/** A sheet of paper folding: a soft rising swish of filtered noise ending in a quiet thump. */
export function playFold(inMs: number, durationMs: number): void {
  const c = audioReady();
  if (!c) return;
  const t = c.currentTime + Math.max(0, inMs) / 1000;
  const d = durationMs / 1000;
  const master = c.createGain();
  master.gain.value = 0.5;
  master.connect(c.destination);

  const src = noise(c, d + 0.05);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(2400, t + d * 0.8);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + d * 0.45);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  src.connect(bp).connect(g).connect(master);
  src.start(t);

  const thump = c.createOscillator();
  thump.type = "sine";
  thump.frequency.value = 95;
  const tg = c.createGain();
  tg.gain.setValueAtTime(0.0001, t + d * 0.92);
  tg.gain.exponentialRampToValueAtTime(0.25, t + d * 0.95);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.08);
  thump.connect(tg).connect(master);
  thump.start(t + d * 0.92);
  thump.stop(t + d + 0.1);
}
