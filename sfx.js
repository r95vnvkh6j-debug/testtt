// Lightweight, dependency-free UI sound design.
// Every sound is synthesized on the fly with the Web Audio API -- no
// external audio files, so nothing to fetch and nothing that can break
// under the extension's CSP. Volumes are kept low and tones short so it
// reads as "premium polish", not noisy.
window.KryptonSFX = (() => {
  let ctx = null;
  let unlocked = false;
  const MASTER_GAIN = 0.16;

  function getCtx() {
    if (!ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioContextClass();
    }
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function tone({ freq = 440, duration = 0.12, type = "sine", gain = 1, glideTo = null, delay = 0 }) {
    const c = getCtx();
    const osc = c.createOscillator();
    const amp = c.createGain();
    const now = c.currentTime + delay;

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (glideTo !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(glideTo, 1), now + duration);
    }

    const peak = MASTER_GAIN * gain;
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(peak, now + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(amp).connect(c.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  const sounds = {
    hover: () => tone({ freq: 720, duration: 0.055, type: "sine", gain: 0.35 }),
    click: () => {
      tone({ freq: 340, duration: 0.09, type: "sine", gain: 0.7, glideTo: 520 });
    },
    dragEnter: () => tone({ freq: 500, duration: 0.14, type: "triangle", gain: 0.5, glideTo: 720 }),
    success: () => {
      tone({ freq: 523.25, duration: 0.14, type: "sine", gain: 0.8 });
      tone({ freq: 659.25, duration: 0.16, type: "sine", gain: 0.7, delay: 0.09 });
      tone({ freq: 783.99, duration: 0.22, type: "sine", gain: 0.6, delay: 0.18 });
    },
    error: () => {
      tone({ freq: 220, duration: 0.16, type: "sawtooth", gain: 0.5 });
      tone({ freq: 165, duration: 0.22, type: "sawtooth", gain: 0.45, delay: 0.1 });
    },
    progress: () => tone({ freq: 880, duration: 0.03, type: "sine", gain: 0.12 }),
  };

  function play(name) {
    if (!sounds[name]) return;
    try {
      sounds[name]();
      unlocked = true;
    } catch (e) {
      // Audio can legitimately fail (autoplay policy before first gesture,
      // context creation issues, etc.) -- never let SFX break the UI.
    }
  }

  return { play };
})();

// Wire up simple declarative hooks: any element with data-sfx="click" or
// data-sfx="hover" plays the matching sound automatically.
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-sfx]").forEach((el) => {
    const name = el.getAttribute("data-sfx");
    if (name === "hover") {
      el.addEventListener("mouseenter", () => window.KryptonSFX.play("hover"));
    } else {
      el.addEventListener("click", () => window.KryptonSFX.play(name));
    }
  });

  const dropZone = document.getElementById("drop-zone");
  if (dropZone) {
    dropZone.addEventListener("dragenter", () => window.KryptonSFX.play("dragEnter"));
  }
});
