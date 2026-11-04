import { Body, STEP, step } from "./physics.js";

const width = 600;
const height = 600;
const palRadius = 20;
const offlineRadius = palRadius * 0.6;
const maxGroupRadius = 70;
const badgeRadius = 10;
const labelFont = "italic 700 13px system-ui, sans-serif";
const labelColliderRadius = 9;
const backendUrl = "http://localhost:3000";

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById("canvas");
const context = canvas.getContext("2d");
const measureContext = document.createElement("canvas").getContext("2d");
measureContext.font = labelFont;

/** Mouse position in canvas coordinates, or null when outside the canvas. */
let mouse = null;

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

function circlePath(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}

/** Draw an image clipped to a circle, scaled to cover it and centered. */
function drawCircleImage(ctx, img, x, y, r, fallback) {
  ctx.save();
  circlePath(ctx, x, y, r);
  if (img) {
    ctx.clip();
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const scale = Math.max((2 * r) / iw, (2 * r) / ih);
    ctx.drawImage(img, x - (iw * scale) / 2, y - (ih * scale) / 2, iw * scale, ih * scale);
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
      this.img = img;
      this.grayImg = grayscale(img);
    });
  }

  get radius() {
    return Math.max(0, this.size.value);
  }

  get targetRadius() {
    if (this.gone) return 0;
    return this.status ? palRadius : offlineRadius;
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
  img = null;
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
    loadImage(activity.backgroundURL, (img) => (this.img = img));
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
    drawCircleImage(ctx, this.img, x, y, r, "gray");
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
    drawCircleImage(ctx, this.img, x, y, r, "gray");
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

/** Put each pal in the group for its current activity, creating or emptying groups as needed. */
function syncGroups() {
  for (const pal of pals) {
    const wanted = !pal.gone && pal.status && knownActivities.has(pal.activity) ? pal.activity : null;
    if (pal.group && pal.group.activityID !== wanted) {
      pal.group.members = pal.group.members.filter((m) => m !== pal);
      pal.group = null;
    }
    if (wanted && !pal.group) {
      let group = groups.find((g) => g.activityID === wanted);
      if (!group) {
        const [bx, by] = pal.badgeOffset();
        group = new Group(wanted, knownActivities.get(wanted), pal.body.x + bx, pal.body.y + by);
        groups.push(group);
      }
      group.members.push(pal);
      pal.group = group;
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
  circles.forEach((g) => g.drawCircle(context));
  // Offline at the bottom, then free online pals, then group members on top of their circles.
  const layer = (p) => (p.inCircle ? 2 : p.status ? 1 : 0);
  [...pals].sort((a, b) => layer(a) - layer(b)).forEach((p) => p.draw(context));
  groups.filter((g) => g.mode === "badge").forEach((g) => g.drawBadge(context));
  circles.forEach((g) => g.drawLabel(context));
}

let simTime = 0;
let accumulator = 0;
let lastFrame = null;

function frame(now) {
  // Cap the frame time so returning to a background tab doesn't explode the sim.
  const dt = lastFrame === null ? 0 : Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  // Groups first: pals need to know whether their group is a circle or a badge.
  groups.forEach((g) => g.updateBody(dt));
  pals.forEach((p) => p.updateBody(dt));
  pals = pals.filter((p) => !(p.gone && p.size.value < 0.5));
  groups = groups.filter((g) => !(g.dying && g.size.value < 0.5));

  const bodies = [
    ...groups.flatMap((g) => [g.body, ...g.labelBodies]),
    ...pals.map((p) => p.body),
  ];
  accumulator += dt;
  while (accumulator >= STEP) {
    step(bodies, { width, height, mouse, time: simTime }, STEP);
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
});
canvas.addEventListener("pointerleave", () => {
  mouse = null;
});

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
            Object.assign(pal, {
              name: data.name,
              status: data.status,
              activity: data.activity,
              gone: false,
            });
          } else {
            pal = new Pal(data);
            pals.push(pal);
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
