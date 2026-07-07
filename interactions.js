// Fluid pointer interactions: a soft glow that trails the cursor across
// the whole popup, plus a subtle magnetic tilt on cards/buttons tagged
// with the .tilt class. Everything degrades to nothing under
// prefers-reduced-motion, and is entirely inert when the pointer leaves.
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return;

  const glow = document.getElementById("cursor-glow");
  let glowVisible = false;
  let rafId = null;
  let targetX = 0, targetY = 0;
  let currentX = 0, currentY = 0;

  function animateGlow() {
    // Ease the glow toward the pointer instead of snapping to it --
    // this is what reads as "fluid" rather than just "tracked".
    currentX += (targetX - currentX) * 0.18;
    currentY += (targetY - currentY) * 0.18;
    glow.style.transform = `translate(${currentX}px, ${currentY}px)`;
    rafId = requestAnimationFrame(animateGlow);
  }

  document.addEventListener("mousemove", (e) => {
    targetX = e.clientX;
    targetY = e.clientY;
    if (!glowVisible) {
      glowVisible = true;
      glow.classList.add("visible");
    }
    if (!rafId) rafId = requestAnimationFrame(animateGlow);

    // Update the per-panel spotlight (background radial-gradient position)
    // for every glass panel currently under/near the pointer.
    document.querySelectorAll(".glass-panel").forEach((panel) => {
      const rect = panel.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      panel.style.setProperty("--mx", `${x}px`);
      panel.style.setProperty("--my", `${y}px`);
    });
  });

  document.addEventListener("mouseleave", () => {
    glowVisible = false;
    glow.classList.remove("visible");
  });

  // Magnetic tilt: elements tilt a few degrees toward the pointer while
  // hovered, and spring back to neutral on leave.
  const MAX_TILT_DEG = 5;
  const MAX_LIFT_PX = 3;

  document.querySelectorAll(".tilt").forEach((el) => {
    el.addEventListener("mousemove", (e) => {
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      const rotateX = (-py * MAX_TILT_DEG).toFixed(2);
      const rotateY = (px * MAX_TILT_DEG).toFixed(2);
      el.style.transform =
        `perspective(600px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-${MAX_LIFT_PX}px)`;
    });

    el.addEventListener("mouseleave", () => {
      el.style.transform = "";
    });

    el.addEventListener("mousedown", () => {
      el.style.transform = "scale(0.97)";
    });
  });
})();
