// Lobby physics. Pure (no DOM) so it can be simulated outside the browser.
// Units: pixels and seconds. Integrate with a fixed timestep of STEP.

export const STEP = 1 / 240;

export const params = {
  damping: 2.5, // velocity decay rate, 1/s
  maxSpeed: 350, // px/s
  collisionStiffness: 900, // 1/s², per px of overlap
  spaceStiffness: 30, // 1/s², per px of intrusion into personal space
  centerStiffness: 1.5, // pull on online pals and groups back toward the center
  centerFreeRadius: 40, // no center pull within this distance
  offlineStiffness: 12, // push offline pals out of the inner area
  offlineInnerRadius: 230, // offline pals rest outside this distance from center
  wallStiffness: 400,
  wallMargin: 4,
  mouseRadius: 70,
  mouseStrength: 2500, // px/s² at the cursor
  wanderStrength: 18, // px/s² of slow, smooth drift
  memberStiffness: 150, // spring pulling group members onto their slot
  referenceRadius: 20, // size at which mouse/wander forces are unscaled
};

/**
 * kind:
 *  - "online"  free-floating, pulled toward the center
 *  - "offline" free-floating, pushed out of the inner area
 *  - "group"   free-floating, pulled toward the center
 *  - "member"  sits on a slot relative to `anchor`; ignores collisions
 *  - "attached" rigidly fixed to a slot on `anchor` and collides on its behalf
 *               (e.g. a group's label); pushes it receives move the anchor
 */
export class Body {
  x;
  y;
  vx = 0;
  vy = 0;
  ax = 0;
  ay = 0;
  radius;
  /** Extra gap (px) this body likes to keep from its neighbours. */
  space = 0;
  kind = "online";
  /** For members and attached bodies: the body they follow, plus slot offset from its center. */
  anchor = null;
  slotX = 0;
  slotY = 0;
  #wander = [0, 1, 2, 3].map(() => ({
    freq: 0.25 + Math.random() * 0.6,
    phase: Math.random() * Math.PI * 2,
  }));

  constructor(x, y, radius) {
    this.x = x;
    this.y = y;
    this.radius = radius;
  }

  get mass() {
    return Math.max(this.radius, 1) ** 2;
  }

  wander(time) {
    const [a, b, c, d] = this.#wander;
    return [
      Math.sin(time * a.freq + a.phase) + 0.5 * Math.sin(time * b.freq + b.phase),
      Math.sin(time * c.freq + c.phase) + 0.5 * Math.sin(time * d.freq + d.phase),
    ];
  }
}

function interact(a, b) {
  // Attached bodies collide on behalf of their anchor.
  const ownerA = a.kind === "attached" ? a.anchor : a;
  const ownerB = b.kind === "attached" ? b.anchor : b;
  if (ownerA === ownerB) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const space = (a.space + b.space) / 2;
  const reach = a.radius + b.radius + space;
  if (Math.abs(dx) > reach || Math.abs(dy) > reach) return;
  const distSq = dx * dx + dy * dy;
  if (distSq >= reach * reach) return;

  let dist = Math.sqrt(distSq);
  let nx, ny;
  if (dist < 1e-6) {
    // Exactly on top of each other: pick a random direction.
    const angle = Math.random() * Math.PI * 2;
    nx = Math.cos(angle);
    ny = Math.sin(angle);
    dist = 0;
  } else {
    nx = dx / dist;
    ny = dy / dist;
  }

  const gap = dist - a.radius - b.radius;
  let push = params.spaceStiffness * (space - gap);
  if (gap < 0) push += params.collisionStiffness * -gap;

  // Lighter bodies get pushed further.
  const total = ownerA.mass + ownerB.mass;
  const aShare = (push * ownerB.mass) / total;
  const bShare = (push * ownerA.mass) / total;
  ownerA.ax -= nx * aShare;
  ownerA.ay -= ny * aShare;
  ownerB.ax += nx * bShare;
  ownerB.ay += ny * bShare;
}

function wallForce(pos, radius, size) {
  const low = pos - radius - params.wallMargin;
  if (low < 0) return -low * params.wallStiffness;
  const high = pos + radius + params.wallMargin - size;
  if (high > 0) return -high * params.wallStiffness;
  return 0;
}

/**
 * Advance the simulation by one fixed step.
 * @param {Body[]} bodies
 * @param {{ width: number, height: number, mouse: {x: number, y: number} | null, time: number }} world
 * @param {number} dt
 */
export function step(bodies, world, dt = STEP) {
  const { width, height, mouse, time } = world;
  const cx = width / 2;
  const cy = height / 2;

  for (const b of bodies) {
    b.ax = 0;
    b.ay = 0;
    if (b.kind === "attached") {
      b.x = b.anchor.x + b.slotX;
      b.y = b.anchor.y + b.slotY;
    }
  }

  const free = bodies.filter((b) => b.kind !== "member");
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      interact(free[i], free[j]);
    }
  }

  for (const b of bodies) {
    if (b.kind === "attached") continue;
    const scale = Math.min(1, params.referenceRadius / Math.max(b.radius, 1));
    const [wx, wy] = b.wander(time);

    if (b.kind === "member") {
      // Damped spring onto the slot, relative to the group's motion.
      const k = params.memberStiffness;
      const c = 2 * Math.sqrt(k);
      const tx = b.anchor.x + b.slotX;
      const ty = b.anchor.y + b.slotY;
      b.ax += k * (tx - b.x) - c * (b.vx - b.anchor.vx);
      b.ay += k * (ty - b.y) - c * (b.vy - b.anchor.vy);
      b.ax += wx * params.wanderStrength * 0.3;
      b.ay += wy * params.wanderStrength * 0.3;
      continue;
    }

    const dx = b.x - cx;
    const dy = b.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
    if (b.kind === "offline") {
      const intrusion = params.offlineInnerRadius - dist;
      if (intrusion > 0) {
        b.ax += (dx / dist) * intrusion * params.offlineStiffness;
        b.ay += (dy / dist) * intrusion * params.offlineStiffness;
      }
    } else {
      const excess = dist - params.centerFreeRadius;
      if (excess > 0) {
        b.ax -= (dx / dist) * excess * params.centerStiffness;
        b.ay -= (dy / dist) * excess * params.centerStiffness;
      }
    }

    b.ax += wallForce(b.x, b.radius, width);
    b.ay += wallForce(b.y, b.radius, height);

    if (mouse) {
      const mx = b.x - mouse.x;
      const my = b.y - mouse.y;
      const reach = params.mouseRadius + b.radius;
      const md = Math.sqrt(mx * mx + my * my);
      if (md < reach && md > 1e-6) {
        const strength = params.mouseStrength * (1 - md / reach) * scale;
        b.ax += (mx / md) * strength;
        b.ay += (my / md) * strength;
      }
    }

    b.ax += wx * params.wanderStrength * scale;
    b.ay += wy * params.wanderStrength * scale;
  }

  const damping = Math.exp(-params.damping * dt);
  for (const b of bodies) {
    if (b.kind === "attached") continue;
    b.vx = (b.vx + b.ax * dt) * damping;
    b.vy = (b.vy + b.ay * dt) * damping;
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed > params.maxSpeed) {
      b.vx *= params.maxSpeed / speed;
      b.vy *= params.maxSpeed / speed;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.kind !== "member") {
      // Hard stop at the canvas edge.
      const r = Math.min(b.radius, width / 2, height / 2);
      if (b.x < r) [b.x, b.vx] = [r, Math.max(b.vx, 0)];
      if (b.x > width - r) [b.x, b.vx] = [width - r, Math.min(b.vx, 0)];
      if (b.y < r) [b.y, b.vy] = [r, Math.max(b.vy, 0)];
      if (b.y > height - r) [b.y, b.vy] = [height - r, Math.min(b.vy, 0)];
    }
  }
}
