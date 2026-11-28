// Game sounds, synthesized in the browser now that the tank has no buzzer.
// They use the voices of an 8-bit console: square and triangle waves plus a
// coarse noise channel for shots and explosions.

const VOLUME = 0.12;

// Each sound schedules its voices from time t on the output node.
const recipes = {
  // A short thump: a noise burst closing down plus a falling square.
  fire(v, t) {
    v.noise(t, 0.12, { volume: 0.9, from: 4000, to: 500, coarse: 3 });
    v.tone(t, 0.09, { wave: "square", from: 320, to: 70, volume: 0.5 });
  },
  // A metallic clang: two bright squares ringing out over a noise click.
  hurt(v, t) {
    v.noise(t, 0.03, { volume: 0.6, from: 8000, to: 6000, coarse: 1 });
    v.tone(t, 0.2, { wave: "square", from: 1250, volume: 0.35 });
    v.tone(t, 0.16, { wave: "square", from: 1870, volume: 0.25 });
    v.tone(t + 0.05, 0.14, { wave: "triangle", from: 620, to: 400, volume: 0.6 });
  },
  // A long rumbling explosion with a sinking tone underneath.
  death(v, t) {
    v.noise(t, 0.9, { volume: 1, from: 2500, to: 150, coarse: 6 });
    v.noise(t + 0.08, 0.5, { volume: 0.5, from: 1200, to: 200, coarse: 10 });
    v.tone(t, 0.5, { wave: "triangle", from: 180, to: 35, volume: 0.8 });
  },
  // A rising arpeggio that ends on a held note.
  respawn(v, t) {
    const notes = [392, 523, 659, 784, 1047];
    notes.forEach((f, i) =>
      v.tone(t + i * 0.065, 0.06, { wave: "square", from: f, volume: 0.35, sustain: true }),
    );
    v.tone(t + notes.length * 0.065, 0.22, { wave: "square", from: 1319, volume: 0.35 });
  },
  // Two quick bright blips for the shooter.
  hitConfirm(v, t) {
    v.tone(t, 0.04, { wave: "square", from: 1760, volume: 0.3, sustain: true });
    v.tone(t + 0.045, 0.09, { wave: "square", from: 2349, volume: 0.3 });
  },
  // A short fanfare for a kill.
  killConfirm(v, t) {
    [1047, 1319, 1568].forEach((f, i) =>
      v.tone(t + i * 0.06, 0.055, { wave: "square", from: f, volume: 0.3, sustain: true }),
    );
    v.tone(t + 0.18, 0.25, { wave: "square", from: 2093, volume: 0.3 });
  },
};

export function createSoundPlayer() {
  let context = null;
  let output = null;
  const noiseBuffers = new Map();

  // Browsers keep audio suspended until the user interacts with the page, so
  // call this from a click or key press handler.
  function unlock() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!context) {
      context = new AudioContext();
      output = context.createGain();
      output.gain.value = VOLUME;
      output.connect(context.destination);
    }
    if (context.state === "suspended") context.resume().catch(() => {});
  }

  // Square-wave noise that holds each random level for `coarse` samples,
  // which gives the gritty sound of an 8-bit noise channel.
  function noiseBuffer(coarse) {
    if (!noiseBuffers.has(coarse)) {
      const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const data = buffer.getChannelData(0);
      let level = 1;
      for (let i = 0; i < data.length; i++) {
        if (i % coarse === 0) level = Math.random() < 0.5 ? -1 : 1;
        data[i] = level;
      }
      noiseBuffers.set(coarse, buffer);
    }
    return noiseBuffers.get(coarse);
  }

  // An envelope that starts at `volume` and decays to silence over `length`,
  // or holds the level when `sustain` is set, for notes in a melody.
  function envelope(t, length, volume, sustain) {
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.003);
    if (sustain) {
      gain.gain.setValueAtTime(volume, t + length - 0.005);
      gain.gain.linearRampToValueAtTime(0, t + length);
    } else {
      gain.gain.exponentialRampToValueAtTime(0.001, t + length);
    }
    gain.connect(output);
    return gain;
  }

  const voices = {
    tone(t, length, { wave, from, to = from, volume, sustain = false }) {
      const oscillator = context.createOscillator();
      oscillator.type = wave;
      oscillator.frequency.setValueAtTime(from, t);
      if (to !== from) oscillator.frequency.exponentialRampToValueAtTime(to, t + length);
      const gain = envelope(t, length, volume, sustain);
      oscillator.connect(gain);
      oscillator.onended = () => gain.disconnect();
      oscillator.start(t);
      oscillator.stop(t + length + 0.01);
    },
    noise(t, length, { volume, from, to = from, coarse }) {
      const source = context.createBufferSource();
      source.buffer = noiseBuffer(coarse);
      source.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(from, t);
      if (to !== from) filter.frequency.exponentialRampToValueAtTime(to, t + length);
      const gain = envelope(t, length, volume, false);
      source.connect(filter).connect(gain);
      source.onended = () => gain.disconnect();
      source.start(t);
      source.stop(t + length + 0.01);
    },
  };

  // Sounds overlap rather than cut each other off, since one page hears both
  // a shot and the hit that follows it a moment later.
  function play(name) {
    // Skip rather than queue: a sound that plays seconds late is confusing.
    if (!context || context.state !== "running" || !recipes[name]) return;
    recipes[name](voices, context.currentTime + 0.01);
  }

  function close() {
    context?.close().catch(() => {});
    context = output = null;
    noiseBuffers.clear();
  }

  return { unlock, play, close };
}
