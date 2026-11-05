import { Body, STEP, step } from "./physics.js";
import { isSoundEnabled, play, setSoundEnabled } from "./sound.js";

const width = 600;
const height = 600;
const palRadius = 20;
const offlineRadius = palRadius * 0.6;
const maxGroupRadius = 70;
const badgeRadius = 10;
const labelFont = "italic 700 13px system-ui, sans-serif";
const labelColliderRadius = 9;
const nameFont = "italic 800 13px system-ui, sans-serif";
const subtitleFont = "italic 600 10px system-ui, sans-serif";
/** Names are tilted up a little, like a sticker. */
const nameAngle = -0.2;
const nameMaxWidth = 120;
/** Collider radius covering one outlined line of name text, and a name plus subtitle. */
const nameColliderRadius = 9;
const nameSubtitleColliderRadius = 14;
const backendUrl = "http://localhost:3000";

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById("canvas");
const context = canvas.getContext("2d");
const measureContext = document.createElement("canvas").getContext("2d");

/** Mouse position in canvas coordinates, or null when outside the canvas. */
let mouse = null;
/** Smoothed cursor speed, px/s. The cursor only shoves pals while it's moving. */
let mouseSpeed = 0;
let lastPointer = null;
/** @type {Pal | null} */
let hovered = null;

function loadImage(url, onLoad) {
  if (!url) return;
  const img = new Image();
  img.onload = () => onLoad(img);
  img.src = url;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** A damped spring for animating a value. Under-damped springs overshoot, giving a "pop". */
class Spring {
  velocity = 0;

  constructor(value, stiffness, dampingRatio) {
    this.value = value;
    this.stiffness = stiffness;
    this.damping = 2 * dampingRatio * Math.sqrt(stiffness);
  }

  update(target, dt) {
    // Substep so large frame times stay stable.
    for (let left = dt; left > 0; left -= STEP) {
      const h = Math.min(STEP, left);
      this.velocity += (this.stiffness * (target - this.value) - this.damping * this.velocity) * h;
      this.value += this.velocity * h;
    }
  }
}

function measure(text, font) {
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/** Dark text with a white outline, readable over avatars and game art. */
function outlineText(ctx, text, x, y, font, color, outline) {
  ctx.font = font;
  ctx.lineJoin = "round";
  ctx.lineWidth = outline;
  ctx.strokeStyle = "white";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function circlePath(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}

/** Draw an image clipped to a circle, scaled to cover it and centered. */
/**
 * Canvas has no mipmapping, so an image drawn far smaller than its size aliases (and
 * shimmers as it moves). Pre-halve it down to `minSize` and draw from the closest level.
 * @returns {(HTMLImageElement | HTMLCanvasElement)[]} largest first
 */
function mipmaps(img, minSize = 16) {
  const levels = [img];
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  while (Math.min(w, h) / 2 >= minSize) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    const level = document.createElement("canvas");
    level.width = w;
    level.height = h;
    const ctx = level.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(levels[levels.length - 1], 0, 0, w, h);
    levels.push(level);
  }
  return levels;
}

/** Cover-fit an image (or mip chain) into a circle. */
function drawCircleImage(ctx, img, x, y, r, fallback) {
  ctx.save();
  circlePath(ctx, x, y, r);
  if (img) {
    ctx.clip();
    const levels = Array.isArray(img) ? img : [img];
    const iw = levels[0].naturalWidth || levels[0].width;
    const ih = levels[0].naturalHeight || levels[0].height;
    const scale = Math.max((2 * r) / iw, (2 * r) / ih);
    // Smallest level that's still at least as big as what lands on screen.
    const deviceWidth = iw * scale * ctx.getTransform().a;
    let level = levels[0];
    for (const candidate of levels) {
      if (candidate.width < deviceWidth) break;
      level = candidate;
    }
    ctx.drawImage(level, x - (iw * scale) / 2, y - (ih * scale) / 2, iw * scale, ih * scale);
  } else {
    ctx.fillStyle = fallback;
    ctx.fill();
  }
  ctx.restore();
}

class Pal {
  id;
  name;
  avatarURL;
  status;
  activity;
  /** @type {Group | null} */
  group = null;
  /** Set when the pal disappears from the backend's list; shrinks out, then is removed. */
  gone = false;
  img = null;
  grayImg = null;
  /** Displayed radius. Starts at 0 so pals pop in. */
  size = new Spring(0, 220, 0.55);
  body;
  /** Current name layout, or null while hidden. */
  nameLabel = null;
  /** Invisible bodies along the name so neighbours don't drift over it. */
  nameBodies = [];

  constructor({ id, name, avatarURL, status, activity }) {
    this.id = id ?? name;
    this.name = name;
    this.avatarURL = avatarURL;
    this.status = status;
    this.activity = activity;
    this.body = new Body(
      Math.random() * (width - 2 * palRadius) + palRadius,
      Math.random() * (height - 2 * palRadius) + palRadius,
      0
    );
    loadImage(avatarURL, (img) => {
      this.img = mipmaps(img);
      this.grayImg = mipmaps(grayscale(img));
    });
  }

  get radius() {
    return Math.max(0, this.size.value);
  }

  get targetRadius() {
    if (this.gone) return 0;
    const base = this.status ? palRadius : offlineRadius;
    return this === hovered ? base * 1.15 : base;
  }

  /** Sitting inside a group circle, as opposed to free (possibly wearing a badge). */
  get inCircle() {
    return this.group?.mode === "circle";
  }

  /** Where a solo-game badge sits, relative to the pal's center: the upper-right rim. */
  badgeOffset() {
    const d = this.radius * 0.8;
    return [d * Math.SQRT1_2, -d * Math.SQRT1_2];
  }

  updateBody(dt) {
    this.size.update(this.targetRadius, dt);
    const body = this.body;
    body.radius = this.radius;
    if (this.inCircle) {
      body.kind = "member";
      body.anchor = this.group.body;
      [body.slotX, body.slotY] = this.group.slotFor(this);
      body.space = 0;
    } else {
      body.kind = this.status ? "online" : "offline";
      body.anchor = null;
      body.space = this.status ? 26 : 10;
    }
    body.ignoreMouse = this === hovered;
    this.layoutName();
  }

  /**
   * Name to the lower right of the avatar, tilted up. Solo players get their game as a subtitle.
   * Offline names only show on hover.
   */
  layoutName() {
    const r = this.radius;
    const isHovered = this === hovered;
    const alpha = isHovered ? 1 : clamp01((r - 10) / 8);
    if (!this.name || alpha <= 0 || this.gone || !(this.status || isHovered)) {
      this.nameLabel = null;
      this.nameBodies = [];
      return;
    }
    const soloGame = this.group?.mode === "badge" && !this.group.dying ? this.group.name : null;
    measureContext.font = nameFont;
    const text = truncate(measureContext, this.name, nameMaxWidth);
    measureContext.font = subtitleFont;
    const subtitle = soloGame && truncate(measureContext, soloGame, nameMaxWidth);
    const textWidth = Math.max(measure(text, nameFont), subtitle ? measure(subtitle, subtitleFont) + 2 : 0);

    // Flip to the left near the right edge (with some hysteresis so it doesn't flicker).
    // Members point their names outward so they don't run across the circle.
    const overflow = this.body.x + r * 0.7 + textWidth * Math.cos(nameAngle) - (width - 4);
    const flip = this.inCircle
      ? this.body.slotX < -1
      : this.nameLabel?.flip
        ? overflow > -20
        : overflow > 0;
    const side = flip ? -1 : 1;
    const ox = side * r * 0.7;
    const oy = r * 0.4;
    this.nameLabel = { text, subtitle, alpha, flip, ox, oy };

    // Offline names only show on hover, so they don't need to push anything.
    if (!this.status) {
      this.nameBodies = [];
      return;
    }
    // One row of circles covering the text block (centered between name and subtitle).
    const radius = subtitle ? nameSubtitleColliderRadius : nameColliderRadius;
    const ly = subtitle ? 6.5 : 0;
    const count = Math.max(1, Math.ceil(textWidth / (radius * 1.6)));
    const cos = Math.cos(nameAngle);
    const sin = Math.sin(nameAngle);
    while (this.nameBodies.length < count) {
      const b = new Body(this.body.x, this.body.y, radius);
      b.kind = "attached";
      b.anchor = this.body;
      b.space = 4;
      this.nameBodies.push(b);
    }
    this.nameBodies.length = count;
    this.nameBodies.forEach((b, i) => {
      b.radius = radius;
      const t = count === 1 ? textWidth / 2 : radius + ((textWidth - 2 * radius) * i) / (count - 1);
      const lx = side * t;
      b.slotX = ox + lx * cos - ly * sin;
      b.slotY = oy + lx * sin + ly * cos;
    });
  }

  /** @param {CanvasRenderingContext2D} ctx */
  drawName(ctx) {
    const label = this.nameLabel;
    if (!label) return;
    ctx.save();
    ctx.globalAlpha = label.alpha;
    ctx.translate(this.body.x + label.ox, this.body.y + label.oy);
    ctx.rotate(nameAngle);
    ctx.textAlign = label.flip ? "right" : "left";
    ctx.textBaseline = "middle";
    outlineText(ctx, label.text, 0, 0, nameFont, "#111", 4);
    if (label.subtitle) {
      outlineText(ctx, label.subtitle, label.flip ? -2 : 2, 13, subtitleFont, "#555", 3);
    }
    ctx.restore();
  }

  /** @param {CanvasRenderingContext2D} ctx */
  draw(ctx) {
    const { x, y } = this.body;
    const r = this.radius;
    if (r < 0.5) return;
    if (this.status) {
      drawCircleImage(ctx, this.img, x, y, r, "#555");
    } else {
      drawCircleImage(ctx, this.grayImg, x, y, r, "#222");
    }
    if (this.inCircle) {
      // Separate members from the game art behind them.
      circlePath(ctx, x, y, r);
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

/** Pre-render the offline look once instead of running a canvas filter every frame. */
function grayscale(img) {
  const off = document.createElement("canvas");
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const ctx = off.getContext("2d");
  ctx.filter = "grayscale(100%) brightness(50%)";
  ctx.drawImage(img, 0, 0);
  return off;
}

/**
 * Everyone playing one game. With 2+ members it's a circle floating on its own with
 * the members inside; with one member it's a small badge pinned to that pal.
 */
class Group {
  activityID;
  name;
  /** @type {Pal[]} */
  members = [];
  /** @type {"circle" | "badge"} */
  mode = "badge";
  /** The pal wearing the badge (kept while the group shrinks away). */
  badgePal = null;
  /** Cover art (for the circle) and icon (for the badge), as mip chains. */
  img = null;
  icon = null;
  size = new Spring(0, 140, 0.45);
  body;
  /** Current label layout, or null while it's hidden. */
  label = null;
  /** Invisible bodies along the label so pals don't drift over it. */
  labelBodies = [];

  constructor(activityID, activity, x, y) {
    this.activityID = activityID;
    this.name = activity.name;
    this.body = new Body(x, y, 0);
    this.body.space = 30;
    loadImage(activity.backgroundURL, (img) => (this.img = mipmaps(img)));
    loadImage(activity.iconURL, (img) => (this.icon = mipmaps(img)));
  }

  get dying() {
    return this.members.length === 0;
  }

  get radius() {
    return Math.max(0, this.size.value);
  }

  get targetRadius() {
    if (this.dying) return 0;
    if (this.mode === "badge") return badgeRadius;
    const circles = groups.filter((g) => g.mode === "circle" && !g.dying).length;
    return Math.min(maxGroupRadius, 45 + 8 * this.members.length, 400 / circles);
  }

  /** Offset of a member's slot from the group's center: an inner ring, poking past the rim. */
  slotFor(pal) {
    const n = this.members.length;
    const index = this.members.indexOf(pal);
    // Rotate by half a step so nobody sits on top of the label.
    const angle = -Math.PI / 2 + ((index + 0.5) * 2 * Math.PI) / n;
    const d = Math.max(0, this.radius - palRadius * 0.6);
    return [d * Math.cos(angle), d * Math.sin(angle)];
  }

  updateBody(dt) {
    // Keep the last mode while dying so it shrinks away where it was.
    if (this.members.length >= 2) {
      this.mode = "circle";
    } else if (this.members.length === 1) {
      this.mode = "badge";
      this.badgePal = this.members[0];
    }
    this.size.update(this.targetRadius, dt);

    const body = this.body;
    if (this.mode === "circle") {
      body.kind = "group";
      body.anchor = null;
      // Room for members poking past the rim.
      body.radius = this.radius + palRadius * 0.4;
    } else {
      // Ride along on the pal; the spring makes it fly there smoothly after a circle collapses.
      body.kind = "member";
      body.anchor = this.badgePal.body;
      [body.slotX, body.slotY] = this.badgePal.badgeOffset();
      body.radius = this.radius;
    }
    this.layoutLabel();
  }

  /** The game name above the ring (or below, near the top edge), faded in with size. */
  layoutLabel() {
    const r = this.radius;
    const alpha = clamp01((r - 25) / 25);
    if (this.mode !== "circle" || this.dying || alpha <= 0 || !this.name) {
      this.label = null;
      this.labelBodies = [];
      return;
    }
    const ring = r + 7;
    // Hysteresis so it doesn't flicker when hovering near the edge.
    const top = this.body.y - ring - 24;
    const below = this.label?.below ? top < 10 : top < 0;
    measureContext.font = labelFont;
    const text = truncate(measureContext, this.name, Math.max(120, r * 2.6));
    const textWidth = measureContext.measureText(text).width;
    this.label = { text, alpha, ring, below };

    const count = Math.max(1, Math.ceil(textWidth / (labelColliderRadius * 2.5)));
    const spread = Math.max(0, textWidth / 2 - labelColliderRadius);
    const offsetY = (below ? 1 : -1) * (ring + 17);
    while (this.labelBodies.length < count) {
      const b = new Body(this.body.x, this.body.y, labelColliderRadius);
      b.kind = "attached";
      b.anchor = this.body;
      b.space = 6;
      this.labelBodies.push(b);
    }
    this.labelBodies.length = count;
    this.labelBodies.forEach((b, i) => {
      b.slotX = count === 1 ? 0 : -spread + (2 * spread * i) / (count - 1);
      b.slotY = offsetY;
    });
  }

  /** @param {CanvasRenderingContext2D} ctx */
  drawCircle(ctx) {
    const { x, y } = this.body;
    const r = this.radius;
    if (r < 0.5) return;
    this.drawArt(ctx, x, y, r);
    // Outer ring fades in as the circle grows.
    const alpha = clamp01((r - 15) / 25);
    if (alpha > 0) {
      ctx.save();
      ctx.globalAlpha = alpha;
      circlePath(ctx, x, y, r + 7);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.2)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** @param {CanvasRenderingContext2D} ctx */
  drawBadge(ctx) {
    const { x, y } = this.body;
    const r = this.radius;
    if (r < 0.5) return;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    circlePath(ctx, x, y, r + 2);
    ctx.fillStyle = "white";
    ctx.fill();
    ctx.restore();
    this.drawArt(ctx, x, y, r);
  }

  /** The icon at badge size, the cover art at circle size, crossfading while it grows or shrinks. */
  drawArt(ctx, x, y, r) {
    const cover = this.img ?? this.icon;
    const icon = this.icon ?? this.img;
    const t = clamp01((r - badgeRadius * 1.5) / 20);
    if (t < 1) {
      // Some icons are transparent PNGs, often white glyphs, so give them a dark backing.
      if (this.icon) {
        circlePath(ctx, x, y, r);
        ctx.fillStyle = "#2a2d33";
        ctx.fill();
      }
      drawCircleImage(ctx, icon, x, y, r, "gray");
    }
    if (t > 0) {
      ctx.save();
      ctx.globalAlpha = t;
      drawCircleImage(ctx, cover, x, y, r, "gray");
      ctx.restore();
    }
  }

  /** Game name with a tick down to the ring. */
  drawLabel(ctx) {
    if (!this.label) return;
    const { x, y } = this.body;
    const { text, alpha, ring, below } = this.label;
    const dir = below ? 1 : -1;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = labelFont;
    ctx.textAlign = "center";

    ctx.beginPath();
    ctx.moveTo(x, y + dir * ring);
    ctx.lineTo(x, y + dir * (ring + 7));
    ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textBaseline = below ? "top" : "bottom";
    const ty = y + dir * (ring + 9);
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "white";
    ctx.strokeText(text, x, ty);
    ctx.fillStyle = "#222";
    ctx.fillText(text, x, ty);
    ctx.restore();
  }
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(text.slice(0, end) + "…").width > maxWidth) end--;
  return text.slice(0, end).trimEnd() + "…";
}

/** @type {Pal[]} */
let pals = [];
/** @type {Group[]} */
let groups = [];
/** Activities keyed by "type:id", matching pal.activity. */
const knownActivities = new Map();

/** False until the first snapshot is in, so loading the page isn't a wall of sound. */
let soundsReady = false;
function sound(name, key) {
  if (soundsReady) play(name, key);
}

/** Put each pal in the group for its current activity, creating or emptying groups as needed. */
function syncGroups() {
  for (const pal of pals) {
    const wanted = !pal.gone && pal.status && knownActivities.has(pal.activity) ? pal.activity : null;
    if (pal.group && pal.group.activityID !== wanted) {
      pal.group.members = pal.group.members.filter((m) => m !== pal);
      pal.group = null;
      if (!pal.gone && pal.status) sound("leaveGame", pal.id);
    }
    if (wanted && !pal.group) {
      let group = groups.find((g) => g.activityID === wanted);
      if (!group) {
        const [bx, by] = pal.badgeOffset();
        group = new Group(wanted, knownActivities.get(wanted), pal.body.x + bx, pal.body.y + by);
        groups.push(group);
      }
      const before = group.members.length;
      group.members.push(pal);
      pal.group = group;
      if (before === 0) sound("startGame", pal.id);
      else if (before === 1) sound("groupForms", wanted);
      else sound("joinGroup", pal.id);
    }
  }
}

// --- Rendering ---

let pixelRatio = 0;
function resizeCanvas() {
  if (pixelRatio === window.devicePixelRatio) return;
  pixelRatio = window.devicePixelRatio;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

function render() {
  resizeCanvas();
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, width, height);
  const circles = groups.filter((g) => g.mode === "circle");
  const badges = groups.filter((g) => g.mode === "badge");
  const others = drawOrder().filter((p) => p !== hovered);
  circles.forEach((g) => g.drawCircle(context));
  others.forEach((p) => p.draw(context));
  badges.filter((g) => g.badgePal !== hovered).forEach((g) => g.drawBadge(context));
  others.forEach((p) => p.drawName(context));
  circles.forEach((g) => g.drawLabel(context));
  // The hovered pal goes over everything.
  if (hovered) {
    hovered.draw(context);
    badges.filter((g) => g.badgePal === hovered).forEach((g) => g.drawBadge(context));
    hovered.drawName(context);
  }
}

/** Offline at the bottom, then free online pals, then group members on top of their circles. */
function drawOrder() {
  const layer = (p) => (p.inCircle ? 2 : p.status ? 1 : 0);
  return [...pals].sort((a, b) => layer(a) - layer(b));
}

/** The topmost pal under the cursor. */
function findHovered() {
  if (!mouse) return null;
  const order = drawOrder();
  // Keep the current one if the cursor is still on it, even if it's drawn underneath.
  if (hovered && order.includes(hovered)) order.push(hovered);
  for (let i = order.length - 1; i >= 0; i--) {
    const p = order[i];
    if (p.gone) continue;
    const dx = mouse.x - p.body.x;
    const dy = mouse.y - p.body.y;
    if (dx * dx + dy * dy <= (p.radius + 3) ** 2) return p;
  }
  return null;
}

let simTime = 0;
let accumulator = 0;
let lastFrame = null;

function frame(now) {
  // Cap the frame time so returning to a background tab doesn't explode the sim.
  const dt = lastFrame === null ? 0 : Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  const nowHovered = findHovered();
  if (nowHovered && nowHovered !== hovered) play("hover", nowHovered.id, { queue: false });
  hovered = nowHovered;
  canvas.style.cursor = hovered ? "pointer" : "";
  mouseSpeed *= Math.exp(-8 * dt);

  // Groups first: pals need to know whether their group is a circle or a badge.
  groups.forEach((g) => g.updateBody(dt));
  pals.forEach((p) => p.updateBody(dt));
  pals = pals.filter((p) => !(p.gone && p.size.value < 0.5));
  groups = groups.filter((g) => !(g.dying && g.size.value < 0.5));

  const bodies = [
    ...groups.flatMap((g) => [g.body, ...g.labelBodies]),
    ...pals.flatMap((p) => [p.body, ...p.nameBodies]),
  ];
  const world = {
    width,
    height,
    mouse: mouse && { ...mouse, push: clamp01(mouseSpeed / 700) },
  };
  accumulator += dt;
  while (accumulator >= STEP) {
    step(bodies, { ...world, time: simTime }, STEP);
    simTime += STEP;
    accumulator -= STEP;
  }

  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

canvas.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  mouse = {
    x: ((event.clientX - rect.left) * width) / rect.width,
    y: ((event.clientY - rect.top) * height) / rect.height,
  };
  if (lastPointer) {
    const elapsed = Math.max((event.timeStamp - lastPointer.time) / 1000, 0.001);
    const speed = Math.hypot(mouse.x - lastPointer.x, mouse.y - lastPointer.y) / elapsed;
    mouseSpeed = mouseSpeed * 0.6 + speed * 0.4;
  }
  lastPointer = { ...mouse, time: event.timeStamp };
});
canvas.addEventListener("pointerleave", () => {
  mouse = null;
  lastPointer = null;
});

const soundToggle = document.getElementById("soundToggle");
function updateSoundToggle() {
  soundToggle.textContent = isSoundEnabled() ? "🔊 Sound on" : "🔇 Sound off";
}
soundToggle.addEventListener("click", () => {
  setSoundEnabled(!isSoundEnabled());
  updateSoundToggle();
  play("online", "toggle");
});
updateSoundToggle();

// --- Backend ---

function setStatus(key, ok) {
  const el = document.getElementById(key);
  if (!el) return;
  el.classList.remove("status-unknown", "status-ok", "status-error");
  el.classList.add(`status-${ok ? "ok" : "error"}`);
}

function updateStatus() {
  fetch(`${backendUrl}/api/status`)
    .then((res) => res.json())
    .then((data) => {
      for (const [key, value] of Object.entries(data)) {
        setStatus(key, value);
      }
    })
    .catch((e) => {
      console.error(e);
      setStatus("backend", false);
    });
}
updateStatus();

document.getElementById("steamLogin").addEventListener("click", () => {
  fetch(`${backendUrl}/api/steamLogin`)
    .then((res) => res.json())
    .then(({ qrData, sessionId }) => {
      document.getElementById("qrimg").src = qrData;
      document.getElementById("qrtext").innerText = "Waiting for login...";
      document.getElementById("qr").style.display = "block";
      const ws = new WebSocket(`ws://localhost:3000/ws/${sessionId}`);
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        document.getElementById("qrtext").innerText = data.msg;
      };
      ws.onclose = () => {
        document.getElementById("qr").style.display = "none";
      };
    });
});

function startMonitor() {
  fetch(`${backendUrl}/api/monitor`)
    .then((res) => res.json())
    .then(({ sessionId }) => {
      const ws = new WebSocket(`ws://localhost:3000/ws/${sessionId}`);
      const logQueue = [];
      /** Activities we've asked the backend about and are still waiting on. */
      const requested = new Set();

      const handlePals = (newPals) => {
        const seen = new Set();
        for (const data of newPals) {
          const id = data.id ?? data.name;
          seen.add(id);
          let pal = pals.find((p) => p.id === id);
          if (pal) {
            if (!pal.status && data.status) sound("online", id);
            if (pal.status && !data.status) sound("offline", id);
            Object.assign(pal, {
              name: data.name,
              status: data.status,
              activity: data.activity,
              gone: false,
            });
          } else {
            pal = new Pal(data);
            pals.push(pal);
            if (pal.status) sound("online", id);
          }
          if (pal.activity && !knownActivities.has(pal.activity) && !requested.has(pal.activity)) {
            requested.add(pal.activity);
            ws.send(JSON.stringify({ type: "activity", id: pal.activity }));
          }
        }
        for (const pal of pals) {
          if (!seen.has(pal.id)) pal.gone = true;
        }
        syncGroups();
        soundsReady = true;
      };

      const handleActivities = (newActivities) => {
        for (const activity of [newActivities].flat()) {
          const key = `${activity.type}:${activity.id}`;
          knownActivities.set(key, activity);
          requested.delete(key);
        }
        syncGroups();
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "msg" || data.type === "err") {
          logQueue.push(data.msg);
        } else if (data.type === "pals") {
          const newPals = JSON.parse(data.msg);
          handlePals(newPals);
          logQueue.push(JSON.stringify(newPals, null, 2));
        } else if (data.type === "activities") {
          const newActivities = JSON.parse(data.msg);
          handleActivities(newActivities);
          logQueue.push(JSON.stringify(newActivities, null, 2));
        } else {
          logQueue.push("Unknown message type: " + data.type);
        }
        while (logQueue.length > 10) {
          logQueue.shift();
        }
        document.getElementById("monitor").innerText = logQueue.join("\n");
      };
    });
}
startMonitor();
