import { Body, STEP, step } from "./physics.js";

const width = 600;
const height = 600;
const palRadius = 20;
const offlineRadius = palRadius * 0.6;
const maxGroupRadius = 70;
/** How quickly displayed sizes ease toward their targets, 1/s. */
const sizeRate = 8;
const backendUrl = "http://localhost:3000";

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById("canvas");
const context = canvas.getContext("2d");

/** Mouse position in canvas coordinates, or null when outside the canvas. */
let mouse = null;

function loadImage(url, onLoad) {
  if (!url) return;
  const img = new Image();
  img.onload = () => onLoad(img);
  img.src = url;
}

function ease(current, target, dt) {
  return current + (target - current) * (1 - Math.exp(-sizeRate * dt));
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
  /** Displayed radius; eases toward targetRadius. Starts at 0 so pals pop in. */
  radius = 0;
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

  get targetRadius() {
    if (this.gone) return 0;
    return this.status ? palRadius : offlineRadius;
  }

  updateBody(dt) {
    this.radius = ease(this.radius, this.targetRadius, dt);
    const body = this.body;
    body.radius = this.radius;
    if (this.group) {
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
    const img = this.status ? this.img : this.grayImg;
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = this.status ? "#555" : "#222";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
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

class Group {
  activityID;
  /** @type {Pal[]} */
  members = [];
  img = null;
  /** Displayed radius; eases toward targetRadius. */
  radius = 0;
  body;

  constructor(activityID, backgroundURL, x, y) {
    this.activityID = activityID;
    this.body = new Body(x, y, 0);
    this.body.kind = "group";
    this.body.space = 30;
    loadImage(backgroundURL, (img) => (this.img = img));
  }

  get dying() {
    return this.members.length === 0;
  }

  get targetRadius() {
    if (this.dying) return 0;
    const live = groups.filter((g) => !g.dying).length;
    return Math.min(maxGroupRadius, 400 / live);
  }

  /** Offset of a member's slot from the group's center. */
  slotFor(pal) {
    const index = this.members.indexOf(pal);
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / this.members.length;
    return [this.radius * Math.cos(angle), this.radius * Math.sin(angle)];
  }

  updateBody(dt) {
    this.radius = ease(this.radius, this.targetRadius, dt);
    // Members sit on the perimeter, so collide with room for them.
    this.body.radius = this.radius + (this.dying ? 0 : palRadius);
  }

  /** @param {CanvasRenderingContext2D} ctx */
  draw(ctx) {
    const { x, y } = this.body;
    const r = this.radius;
    if (r < 0.5) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (this.img) {
      ctx.clip();
      // Cover-fit: fill the circle and center the art.
      const scale = Math.max((2 * r) / this.img.width, (2 * r) / this.img.height);
      const w = this.img.width * scale;
      const h = this.img.height * scale;
      ctx.drawImage(this.img, x - w / 2, y - h / 2, w, h);
    } else {
      ctx.fillStyle = "gray";
      ctx.fill();
    }
    ctx.restore();
  }
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
    const wanted = !pal.gone && knownActivities.has(pal.activity) ? pal.activity : null;
    if (pal.group && pal.group.activityID !== wanted) {
      pal.group.members = pal.group.members.filter((m) => m !== pal);
      pal.group = null;
    }
    if (wanted && !pal.group) {
      let group = groups.find((g) => g.activityID === wanted);
      if (!group) {
        group = new Group(wanted, knownActivities.get(wanted).backgroundURL, pal.body.x, pal.body.y);
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
  groups.forEach((g) => g.draw(context));
  // Offline at the bottom, then free online pals, then group members on top of their groups.
  const layer = (p) => (p.group ? 2 : p.status ? 1 : 0);
  [...pals].sort((a, b) => layer(a) - layer(b)).forEach((p) => p.draw(context));
}

let simTime = 0;
let accumulator = 0;
let lastFrame = null;

function frame(now) {
  // Cap the frame time so returning to a background tab doesn't explode the sim.
  const dt = lastFrame === null ? 0 : Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  pals.forEach((p) => p.updateBody(dt));
  groups.forEach((g) => g.updateBody(dt));
  pals = pals.filter((p) => !(p.gone && p.radius < 0.5));
  groups = groups.filter((g) => !(g.dying && g.radius < 0.5));

  const bodies = [...groups.map((g) => g.body), ...pals.map((p) => p.body)];
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
