<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import {
  canDrive,
  normalizeServer,
  openSocket,
  pageRoute,
  socketUrl,
} from "./connection.js";
import { createDriveController } from "./controls.js";

const route = pageRoute(location.pathname);
const home = ["/", "/index.html"].includes(location.pathname);
const player = route?.role === "player";
const stations = [
  { path: "/player/1", label: "Tank 01", current: route?.tankId === 1 },
  { path: "/player/2", label: "Tank 02", current: route?.tankId === 2 },
  { path: "/control", label: "Console", current: route?.role === "control" },
];
const serverKey = "tank-arena.server";
function initialServer() {
  try {
    const saved = sessionStorage.getItem(serverKey);
    if (saved) return saved;
  } catch {
    // Storage may be disabled by the browser.
  }
  return import.meta.env.DEV
    ? `${location.protocol}//${location.hostname}:8000`
    : location.origin;
}
const settings = ref({
  ...route,
  server: initialServer(),
  name: new URLSearchParams(location.search).get("name")?.trim() || "",
});
const joined = ref(!player || !!settings.value.name);
const state = shallowRef(null);
const status = ref("idle");
const error = ref("");
const feed = ref([]);
const paused = ref(false);
const focused = ref(!document.hidden && document.hasFocus());
const slow = ref(false);
const now = ref(Date.now());
const lastShot = ref(0);
const angle = ref(0);
const drive = ref({ left: 0, right: 0 });
const pressed = ref(new Set());
const isFullScreen = ref(false);
const dial = ref(null);
const turretEl = ref(null);
const leftTread = ref(null);
const rightTread = ref(null);
const modal = ref("");
const dialog = ref(null);
const draft = ref({});
const formError = ref("");
const pending = ref(false);
const feedback = ref({ text: "", kind: "", until: 0 });
const killCall = ref({ text: "", until: 0 });
const phases = {
  lobby: "Free practice",
  countdown: "Get ready",
  running: "Match in progress",
  ended: "Match ended",
};
const statuses = {
  idle: "Not connected",
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};
const directions = [
  { key: "KeyW", label: "W", action: "Forward", arrow: "↑" },
  { key: "KeyA", label: "A", action: "Turn left", arrow: "←" },
  { key: "KeyS", label: "S", action: "Reverse", arrow: "↓" },
  { key: "KeyD", label: "D", action: "Turn right", arrow: "→" },
];
// Dial geometry, in SVG units. The turret rotates about this point.
const PIVOT = { x: 320, y: 312 };
const AIM_DEADZONE = 16;
// Display-only slew rate, close to a hobby servo under load.
const TURRET_DEG_PER_S = 360;
const TREAD_UNITS_PER_MS = 0.28;
const dialTicks = Array.from({ length: 13 }, (_, i) => ({
  angle: i * 15 - 90,
  major: i % 3 === 0,
}));
const connected = computed(() => status.value === "connected");
const stage = computed(() => state.value?.status);
const own = computed(() =>
  state.value?.tanks.find((t) => t.id === route?.tankId),
);
const tanks = computed(() =>
  [...(state.value?.tanks ?? [])].sort((a, b) =>
    player
      ? Number(b.id === route.tankId) - Number(a.id === route.tankId)
      : a.id - b.id,
  ),
);
const enabled = computed(
  () =>
    connected.value &&
    player &&
    canDrive(state.value, route.tankId) &&
    focused.value &&
    !paused.value &&
    !modal.value,
);
const cooldown = computed(() =>
  Math.max(0, 1000 - (now.value - lastShot.value)),
);
const fireReady = computed(
  () =>
    enabled.value &&
    !cooldown.value &&
    (stage.value === "lobby" || own.value?.ammo > 0),
);
const startReady = computed(
  () =>
    connected.value &&
    !pending.value &&
    stage.value === "lobby" &&
    state.value.tanks.every((t) => t.online && t.player),
);
const result = computed(() => {
  if (!state.value?.winner) return "The match is a draw";
  if (player)
    return state.value.winner === route.tankId ? "Victory!" : "Defeat";
  return `TANK 0${state.value.winner} wins the match`;
});
const aimStatus = computed(() => {
  if (!connected.value) return "Waiting for connection";
  if (!own.value?.online) return "Tank offline";
  if (["countdown", "ended"].includes(stage.value)) return "Controls locked";
  if (!own.value?.alive)
    return `Respawn in ${seconds(own.value?.respawn_ms)} s`;
  if (paused.value) return "Controls paused";
  if (!focused.value) return "Window inactive · stopped";
  if (own.value?.protected_ms)
    return `Protected · ${seconds(own.value.protected_ms)} s`;
  return "Ready to aim";
});
const fireLabel = computed(() => {
  if (cooldown.value) return `Reloading ${seconds(cooldown.value)} s`;
  if (stage.value === "running" && own.value?.alive && !own.value.ammo)
    return "Out of ammo";
  return "Fire cannon";
});
const visibleFeedback = computed(() =>
  feedback.value.until > now.value ? feedback.value : null,
);
const seconds = (ms) => ((ms || 0) / 1000).toFixed(1);
function formatTime(ms) {
  const s = Math.ceil((ms || 0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function tankStatus(tank) {
  if (!tank.online) return "Offline";
  // Tanks do not respawn after the match ends.
  if (stage.value === "ended") return tank.alive ? "Match ended" : "Destroyed";
  if (!tank.alive) return `Respawn in ${seconds(tank.respawn_ms)} s`;
  if (!tank.player) return "Waiting for player";
  if (tank.protected_ms) return `Protected · ${seconds(tank.protected_ms)} s`;
  if (stage.value === "countdown") return "Controls locked";
  return "Ready";
}

let connection = null;
let session = 0;
let eventId = 0;
const motion = createDriveController();
const keys = new Set();
const pointerKeys = new Map();
const movementKeys = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowLeft",
  "ArrowDown",
  "ArrowRight",
]);
function send(message) {
  return connection?.send(message) ?? false;
}
function stop() {
  keys.clear();
  pointerKeys.clear();
  pressed.value = new Set();
  slow.value = false;
  motion.reset();
  drive.value = { left: 0, right: 0 };
  if (player) send({ type: "drive", left: 0, right: 0, turret: angle.value });
}
function connect(next = settings.value) {
  if (!route) return;
  session++;
  stop();
  connection?.close();
  connection = null;
  settings.value = { ...next, ...route };
  state.value = null;
  pending.value = false;
  status.value = "connecting";
  error.value = "";
  feed.value = [];
  feedback.value.until = killCall.value.until = 0;
  const activeSession = session;
  try {
    connection = openSocket(settings.value, {
      status(value) {
        if (session !== activeSession) return;
        status.value = value;
        if (value !== "connected") {
          stop();
          pending.value = false;
        }
      },
      message(message) {
        if (session !== activeSession) return;
        if (message.type === "state") {
          const previous = state.value?.status;
          if (message.status === "running" && previous !== "running")
            angle.value = 0;
          if (
            previous !== message.status &&
            ["lobby", "countdown"].includes(message.status)
          ) {
            feed.value = [];
            feedback.value.until = killCall.value.until = 0;
          }
          state.value = message;
          pending.value = false;
        } else if (message.type === "error") {
          error.value = message.message;
          pending.value = false;
        } else if (["hit", "kill"].includes(message.type)) {
          const at = Date.now();
          feed.value = [{ ...message, id: ++eventId, at }, ...feed.value].slice(
            0,
            30,
          );
          if (player)
            feedback.value = {
              kind: message.target === route.tankId ? "damage" : "hit",
              text:
                message.target === route.tankId
                  ? message.type === "kill"
                    ? "TANK DESTROYED"
                    : "YOU WERE HIT"
                  : message.type === "kill"
                    ? "KILL CONFIRMED"
                    : "HIT CONFIRMED",
              until: at + 1000,
            };
          if (message.type === "kill")
            killCall.value = {
              text: `TANK 0${message.shooter} destroyed TANK 0${message.target}`,
              until: at + 4500,
            };
        }
      },
    });
  } catch (exception) {
    error.value = exception.message || "Connection failed";
    status.value = "disconnected";
  }
}
function join() {
  try {
    const next = { ...settings.value, name: settings.value.name.trim() };
    socketUrl(next);
    const url = new URL(location.href);
    url.searchParams.set("name", next.name);
    history.replaceState(null, "", url);
    joined.value = true;
    connect(next);
  } catch (exception) {
    error.value = exception.message;
  }
}
function sendDrive() {
  if (!enabled.value) return;
  const has = (key) => keys.has(key) || [...pointerKeys.values()].includes(key);
  const forward =
    Number(has("KeyW") || has("ArrowUp")) -
    Number(has("KeyS") || has("ArrowDown"));
  const turn =
    Number(has("KeyD") || has("ArrowRight")) -
    Number(has("KeyA") || has("ArrowLeft"));
  pressed.value = new Set(
    [
      forward > 0 && "KeyW",
      forward < 0 && "KeyS",
      turn < 0 && "KeyA",
      turn > 0 && "KeyD",
    ].filter(Boolean),
  );
  slow.value = keys.has("ShiftLeft") || keys.has("ShiftRight");
  drive.value = motion.update(forward, turn, slow.value, performance.now());
  send({ type: "drive", ...drive.value, turret: angle.value });
}
watch(
  enabled,
  (value) => {
    if (!value) stop();
  },
  { flush: "sync" },
);
function isTyping(target) {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      'input:not([type="range"]),select,textarea,[contenteditable="true"]',
    )
  );
}
function keydown(event) {
  if (!player || !joined.value || modal.value || isTyping(event.target)) return;
  // macOS never sends keyup for letters released while Cmd is held, so a
  // shortcut must not leave a drive key stuck down.
  if (event.metaKey || event.ctrlKey || event.altKey) {
    if (keys.size) stop();
    return;
  }
  const isArrow = event.code.startsWith("Arrow");
  if (isArrow && event.target?.matches?.('input[type="range"]')) return;
  const isFireKey =
    event.code === "Space" && !event.target?.closest?.("button");
  // Keep the page from scrolling during locked phases too.
  if (isArrow || isFireKey) event.preventDefault();
  if (!enabled.value) return;
  if (
    movementKeys.has(event.code) ||
    event.code === "ShiftLeft" ||
    event.code === "ShiftRight"
  ) {
    event.preventDefault();
    // Do not restore a held key after a blur, pause or phase change.
    if (event.repeat && !keys.has(event.code)) return;
    const isNew = !keys.has(event.code);
    keys.add(event.code);
    if (isNew) sendDrive();
  }
  if (isFireKey && !event.repeat) fire();
}
function keyup(event) {
  if (keys.delete(event.code)) sendDrive();
}
function blur() {
  focused.value = false;
  stop();
}
function focus() {
  stop();
  focused.value = !document.hidden && document.hasFocus();
}
function visibility() {
  if (document.hidden) blur();
  else focus();
}
function focusIn(event) {
  if (isTyping(event.target)) stop();
}
function pressDirection(event, key) {
  if (!enabled.value) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  pointerKeys.set(event.pointerId, key);
  sendDrive();
}
function releaseDirection(event) {
  pointerKeys.delete(event.pointerId);
  sendDrive();
}
function aim(event) {
  if (!enabled.value || event.pointerType !== "mouse") return;
  // Aim from anywhere on the page, but hold still while reaching for a control.
  if (event.target?.closest?.("button,a,input,dialog")) return;
  const matrix = dial.value?.getScreenCTM();
  if (!matrix) return;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
    matrix.inverse(),
  );
  const dx = point.x - PIVOT.x;
  const dy = point.y - PIVOT.y;
  // Bearing is unstable on the pivot and directly behind it, where a 1px move
  // would otherwise swing the turret from one end stop to the other.
  if (Math.hypot(dx, dy) < AIM_DEADZONE) return;
  if (dy > 0 && Math.abs(dx) < AIM_DEADZONE) return;
  const bearing = (Math.atan2(dx, -dy) * 180) / Math.PI;
  angle.value = Math.round(Math.max(-90, Math.min(90, bearing)));
}
function releaseFocus(event) {
  // After a mouse click, Space must fire rather than re-press this button.
  if (event.detail) event.currentTarget.blur();
}
let frame = 0;
let frameAt = 0;
let shownAngle = 0;
let leftOffset = 0;
let rightOffset = 0;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function animate(time) {
  const dt = Math.min(250, time - (frameAt || time));
  frameAt = time;
  const step = (TURRET_DEG_PER_S * dt) / 1000;
  const gap = angle.value - shownAngle;
  shownAngle = reducedMotion.matches
    ? angle.value
    : shownAngle + Math.sign(gap) * Math.min(Math.abs(gap), step);
  turretEl.value?.setAttribute(
    "transform",
    `rotate(${shownAngle.toFixed(2)} ${PIVOT.x} ${PIVOT.y})`,
  );
  if (!reducedMotion.matches) {
    leftOffset += (drive.value.left / 100) * dt * TREAD_UNITS_PER_MS;
    rightOffset += (drive.value.right / 100) * dt * TREAD_UNITS_PER_MS;
    leftTread.value?.setAttribute("stroke-dashoffset", leftOffset.toFixed(1));
    rightTread.value?.setAttribute("stroke-dashoffset", rightOffset.toFixed(1));
  }
  frame = requestAnimationFrame(animate);
}
function fire() {
  if (
    !enabled.value ||
    Date.now() - lastShot.value < 1000 ||
    (stage.value !== "lobby" && !own.value?.ammo)
  )
    return;
  if (send({ type: "fire" })) lastShot.value = Date.now();
}
function togglePause() {
  stop();
  paused.value = !paused.value;
}
function command(type) {
  error.value = "";
  pending.value = true;
  if (!send({ type })) {
    pending.value = false;
    error.value = "Command not sent. Check the server connection.";
  }
}
async function openDialog(kind) {
  stop();
  draft.value = { ...settings.value };
  formError.value = "";
  modal.value = kind;
  await nextTick();
  dialog.value?.showModal();
}
function closeDialog() {
  dialog.value?.close();
  modal.value = "";
}
function applySettings() {
  try {
    const next = { ...draft.value, ...route, name: draft.value.name.trim() };
    socketUrl(next);
    next.server = new URL(normalizeServer(next.server)).origin;
    try {
      sessionStorage.setItem(serverKey, next.server);
    } catch {
      // The selected server still applies to the current page.
    }
    if (player) {
      const url = new URL(location.href);
      url.searchParams.set("name", next.name);
      history.replaceState(null, "", url);
    }
    connect(next);
    joined.value = true;
    paused.value = false;
    closeDialog();
  } catch (exception) {
    formError.value = exception.message;
  }
}
function resetMatch() {
  command("reset");
  closeDialog();
}
async function fullScreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    error.value =
      "Full screen is unavailable. Use the full-screen option in your browser menu.";
  }
}
function pageHide() {
  blur();
  connection?.close();
}
function pageShow(event) {
  if (!event.persisted) return;
  focus();
  if (joined.value) connect();
}
function fullScreenChange() {
  isFullScreen.value = !!document.fullscreenElement;
}
let driveTimer, clockTimer;
onMounted(() => {
  if (!route) return;
  if (joined.value) connect();
  if (player) frame = requestAnimationFrame(animate);
  driveTimer = setInterval(sendDrive, 50);
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 50);
  if (player) window.addEventListener("pointermove", aim);
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("pageshow", pageShow);
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("focusin", focusIn);
  document.addEventListener("fullscreenchange", fullScreenChange);
});
onUnmounted(() => {
  session++;
  stop();
  connection?.close();
  clearInterval(driveTimer);
  clearInterval(clockTimer);
  cancelAnimationFrame(frame);
  window.removeEventListener("pointermove", aim);
  window.removeEventListener("keydown", keydown);
  window.removeEventListener("keyup", keyup);
  window.removeEventListener("blur", blur);
  window.removeEventListener("focus", focus);
  window.removeEventListener("pagehide", pageHide);
  window.removeEventListener("pageshow", pageShow);
  document.removeEventListener("visibilitychange", visibility);
  document.removeEventListener("focusin", focusIn);
  document.removeEventListener("fullscreenchange", fullScreenChange);
});
</script>

<template>
  <main v-if="!route" class="station-picker">
    <span class="eyebrow">{{ home ? "TANK ARENA" : "TANK ARENA / 404" }}</span>
    <h1>{{ home ? "Choose your station." : "Page not found." }}</h1>
    <p>Choose a player station or open the control console.</p>
    <nav class="management-buttons" aria-label="Available pages">
      <a class="secondary" href="/player/1">Tank 01</a>
      <a class="secondary" href="/player/2">Tank 02</a>
      <a class="secondary" href="/control">Control console</a>
    </nav>
  </main>
  <div
    v-else
    class="app-shell"
    :class="[{ console: !player }, visibleFeedback?.kind]"
  >
    <header class="topbar">
      <a
        class="brand"
        href="/"
        aria-label="Tank Arena home"
      >
        <span class="brand-mark">⊕</span
        ><span
          >TANK<span class="brand-light">ARENA</span
          ><small>LOCAL MULTIPLAYER COMBAT</small></span
        >
      </a>
      <nav aria-label="Main navigation">
        <a
          v-for="station in stations"
          :key="station.path"
          :class="{ selected: station.current }"
          :aria-current="station.current ? 'page' : undefined"
          :href="station.current ? undefined : station.path"
        >{{ station.label }}</a>
      </nav>
      <div class="header-tools">
        <span
          class="connection-badge"
          role="status"
          :class="connected ? 'good' : 'bad'"
          >● {{ statuses[status] }}</span
        >
        <button
          class="icon-button"
          aria-label="Controls and help"
          @click="openDialog('help')"
        >
          ?
        </button>
        <button
          class="icon-button"
          aria-label="Connection settings"
          @click="openDialog('settings')"
        >
          ⚙
        </button>
      </div>
    </header>
    <main>
      <div class="page-heading">
        <div>
          <span class="eyebrow">{{
            player ? `PILOT / TANK 0${route.tankId}` : "CONTROL CONSOLE"
          }}</span>
          <h1>{{ player ? "Ready for battle." : "Every shot counts." }}</h1>
          <p>
            {{
              player
                ? "Take the controls. Aim your turret. Make every shot count."
                : "Live match status, player readiness and match controls."
            }}
          </p>
        </div>
        <button v-if="!player" class="secondary" @click="fullScreen">
          {{ isFullScreen ? "Exit full screen" : "Full screen" }}
        </button>
      </div>
      <div v-if="error" class="error-banner" role="alert">
        <span>{{ error }}</span><button
          aria-label="Dismiss message"
          @click="error = ''"
        >
          ×
        </button>
      </div>
      <form
        v-if="player && !joined"
        class="join-panel panel"
        @submit.prevent="join"
      >
        <h2>Join Tank 0{{ route.tankId }}</h2>
        <p>
          Connect to iot-tank-arena Wi-Fi, then enter your name. Joining
          replaces any existing player for this tank.
        </p>
        <label class="field"
          >Player name<input
            v-model="settings.name"
            required
            maxlength="24"
            autocomplete="nickname"
            placeholder="Your name"
        /></label>
        <button class="primary" type="submit">Join tank</button>
      </form>
      <template v-else>
        <div v-if="!connected" class="error-banner" role="status">
          <span
            >{{
              status === "disconnected"
                ? "Connection closed. Automatic reconnect is stopped. Check the reason above before reconnecting."
                : "Waiting for the server. Driving is disabled; connection retries run every second."
            }}{{
              state ? " Displayed match data is from the last connection." : ""
            }}</span
          >
          <button @click="connect()">Reconnect</button>
        </div>
        <section
          class="match-strip"
          aria-label="Match status"
          :class="{ stale: !connected }"
        >
          <div class="match-phase">
            <span class="eyebrow">{{
              connected ? "LIVE MATCH" : "AWAITING CONNECTION"
            }}</span><strong>{{
              state ? phases[stage] : "Waiting for match data"
            }}</strong>
          </div>
          <div class="score-line">
            <span class="text-team-1">TANK 01</span
            ><b>{{ state?.tanks.find((t) => t.id === 1)?.kills ?? "—" }}</b
            ><span>:</span
            ><b>{{ state?.tanks.find((t) => t.id === 2)?.kills ?? "—" }}</b
            ><span class="text-team-2">TANK 02</span>
          </div>
          <div class="match-time">
            <strong>{{
              !state
                ? "—"
                : stage === "lobby"
                  ? "∞"
                  : formatTime(state.time_left_ms)
            }}</strong><span>{{
              stage === "lobby"
                ? "Practice · Unlimited ammo"
                : "First to 5 kills / 3 min"
            }}</span>
          </div>
        </section>
        <div
          v-if="connected && stage === 'ended'"
          class="result-banner"
          role="status"
        >
          <strong>{{ result }}</strong>
          <p>
            {{
              player
                ? "Controls locked. Wait for the console to reset the match."
                : "Match complete. Reset to return to free practice."
            }}
          </p>
        </div>
        <div
          v-if="connected && stage === 'countdown'"
          class="countdown-banner"
          role="status"
        >
          <span>GET READY</span><b>{{ Math.ceil(state.time_left_ms / 1000) }}</b
          ><span>Controls locked during countdown</span>
        </div>
        <div
          v-if="!player && killCall.until > now"
          class="kill-call"
          role="status"
        >
          {{ killCall.text }}
        </div>
        <div class="battle-grid" :class="player ? 'pilot' : 'spectator'">
          <section
            v-for="(tank, index) in tanks"
            :key="tank.id"
            class="tank-card"
            :class="[
              `team-${tank.id}`,
              index === 0 ? 'first-tank' : 'second-tank',
              {
                large: !player,
                protected: tank.protected_ms > 0,
                stale: !connected,
              },
            ]"
          >
            <div class="card-overline">
              <span>TANK / 0{{ tank.id }}</span
              ><span :class="tank.online ? 'good' : 'bad'">{{
                tank.online ? "Online" : "Offline"
              }}</span>
            </div>
            <div class="tank-title">
              <div>
                <h2>{{ tank.player || "Waiting for player" }}</h2>
                <span>{{
                  !player
                    ? "Player"
                    : tank.id === route.tankId
                      ? "Your tank"
                      : "Opponent"
                }}</span>
              </div>
              <div class="tank-glyph" aria-hidden="true">
                <i class="track left"></i><i class="track right"></i
                ><i class="hull"></i><i class="turret"><i></i></i>
              </div>
            </div>
            <div class="stat-label">
              <span>Health</span><strong>{{ tank.hp }} / 5</strong>
            </div>
            <div class="meter hp" :aria-label="`Health ${tank.hp}/5`">
              <span
                v-for="n in 5"
                :key="n"
                :class="{ filled: n <= tank.hp }"
              ></span>
            </div>
            <template v-if="!player || tank.id === route.tankId">
              <div class="stat-label">
                <span>Ammo</span><strong>{{ tank.ammo }} / 10</strong>
              </div>
              <div class="meter ammo" :aria-label="`Ammo ${tank.ammo}/10`">
                <span
                  v-for="n in 10"
                  :key="n"
                  :class="{ filled: n <= tank.ammo }"
                ></span>
              </div>
              <div class="kd">
                <div>
                  <span>Kills</span><strong>{{ tank.kills }}</strong>
                </div>
                <div>
                  <span>Deaths</span><strong>{{ tank.deaths }}</strong>
                </div>
              </div>
            </template>
            <div
              class="life"
              :class="{ dead: !tank.alive, shield: tank.protected_ms > 0 }"
            >
              {{ tankStatus(tank) }}
            </div>
          </section>
          <div v-if="!state" class="panel loading first-tank">
            Waiting for tank data…
          </div>
          <section v-if="player" class="aim-panel panel">
            <div class="section-label">
              <span>⊕ Aim</span><span class="mono">TURRET CONTROL</span>
            </div>
            <div
              class="aim-area"
              :class="[`team-${route.tankId}`, { locked: !enabled }]"
              @click="fire"
            >
              <svg
                ref="dial"
                class="turret-dial"
                viewBox="0 0 640 440"
                role="img"
                :aria-label="`Turret aimed at ${angle} degrees`"
              >
                <path
                  class="dial-sector"
                  d="M50 312 A270 270 0 0 1 590 312 Z"
                />
                <path class="dial-ring" d="M115 312 A205 205 0 0 1 525 312" />
                <line
                  v-for="tick in dialTicks"
                  :key="tick.angle"
                  class="dial-tick"
                  :class="{ major: tick.major }"
                  x1="320"
                  y1="42"
                  x2="320"
                  :y2="tick.major ? 66 : 54"
                  :transform="`rotate(${tick.angle} 320 312)`"
                />
                <text class="dial-label" x="320" y="26">FRONT 0°</text>
                <text class="dial-label" x="62" y="346">−90° L</text>
                <text class="dial-label" x="578" y="346">+90° R</text>
                <g :transform="`rotate(${angle} 320 312)`">
                  <line class="aim-ray" x1="320" y1="312" x2="320" y2="42" />
                  <circle class="aim-reticle" cx="320" cy="42" r="12" />
                  <circle class="aim-dot" cx="320" cy="42" r="3" />
                </g>
                <g class="dial-tank">
                  <rect class="tank-track" x="222" y="196" width="42" height="236" rx="14" />
                  <rect class="tank-track" x="376" y="196" width="42" height="236" rx="14" />
                  <line ref="leftTread" class="tank-tread" x1="243" y1="202" x2="243" y2="426" />
                  <line ref="rightTread" class="tank-tread" x1="397" y1="202" x2="397" y2="426" />
                  <rect class="tank-hull" x="258" y="208" width="124" height="212" rx="16" />
                  <path class="tank-detail" d="M272 232 H368 M284 396 H356 M284 406 H356" />
                  <g ref="turretEl">
                    <g :class="{ recoil: now - lastShot < 220 }">
                      <circle v-if="now - lastShot < 120" class="muzzle-flash" cx="320" cy="96" r="26" />
                      <rect class="tank-barrel" x="311" y="128" width="18" height="140" rx="3" />
                      <rect class="tank-muzzle" x="305" y="116" width="30" height="24" rx="4" />
                    </g>
                    <rect class="tank-turret" x="270" y="262" width="100" height="100" rx="32" />
                    <circle class="tank-hatch" cx="320" cy="312" r="17" />
                  </g>
                </g>
              </svg>
              <div class="aim-tag">{{ aimStatus }}</div>
              <div
                v-if="visibleFeedback"
                class="combat-feedback"
                :class="visibleFeedback.kind"
                role="status"
              >
                {{ visibleFeedback.text }}
              </div>
            </div>
            <div class="angle-control">
              <label for="angle">Turret angle</label
              ><strong>{{ angle > 0 ? "+" : "" }}{{ angle }}°</strong
              ><input
                id="angle"
                v-model.number="angle"
                type="range"
                min="-90"
                max="90"
                :disabled="!enabled"
                @pointerup="$event.currentTarget.blur()"
              /><span>Left</span><span>Right</span>
            </div>
            <button
              class="fire-button"
              :disabled="!fireReady"
              @click="
                fire();
                releaseFocus($event);
              "
            >
              <span>{{ fireLabel }}</span><kbd>SPACE</kbd>
            </button>
            <progress
              class="cooldown-meter"
              max="1000"
              :value="1000 - cooldown"
              aria-label="Fire cooldown"
            ></progress>
            <p class="hint">
              Move the mouse anywhere to aim. Click the aiming area or press
              Space to fire.
            </p>
          </section>
          <section v-if="player" class="drive-panel panel">
            <div class="section-label">
              <span>Drive</span
              ><span :class="slow ? 'good' : 'mono'">{{
                slow ? "SLOW GEAR" : "W A S D"
              }}</span>
            </div>
            <div class="drive-layout">
              <div class="d-pad">
                <button
                  v-for="direction in directions"
                  :key="direction.key"
                  class="pad-key"
                  :class="[
                    direction.label.toLowerCase(),
                    { active: pressed.has(direction.key) },
                  ]"
                  :aria-label="`${direction.label} ${direction.action}`"
                  :disabled="!enabled"
                  @pointerdown.prevent="pressDirection($event, direction.key)"
                  @pointerup="releaseDirection"
                  @pointercancel="stop"
                  @lostpointercapture="releaseDirection"
                >
                  <span>{{ direction.arrow }}</span><span>{{
                    direction.label
                  }}</span>
                </button>
              </div>
              <div class="track-values">
                <span
                  >LEFT <b>{{ drive.left }}</b></span
                ><span
                  >RIGHT <b>{{ drive.right }}</b></span
                >
              </div>
            </div>
            <p class="hint">
              Hold to accelerate. Release to stop. Hold <kbd>SHIFT</kbd> for
              slow gear.
            </p>
            <button
              class="stop-button"
              :class="{ resume: paused }"
              :disabled="!connected"
              @click="
                togglePause();
                releaseFocus($event);
              "
            >
              {{ paused ? "Resume controls" : "Pause / Stop" }}
            </button>
          </section>
          <section v-else class="match-management panel">
            <div class="section-label"><span>Match controls</span></div>
            <h2>
              {{
                stage === "running"
                  ? "Battle in progress."
                  : stage === "ended"
                    ? "Ready for the next round."
                    : "Ready for both players."
              }}
            </h2>
            <p>3 s countdown · 5 HP · 5 s respawn · 3 s protection</p>
            <ul
              v-if="!state || stage === 'lobby'"
              class="readiness"
              aria-label="Pre-match readiness"
            >
              <li v-for="tank in state?.tanks ?? []" :key="tank.id">
                <b>TANK 0{{ tank.id }}</b
                ><span :class="connected && tank.online ? 'good' : 'bad'">{{
                  connected && tank.online
                    ? "✓ Tank online"
                    : "✕ Tank not ready"
                }}</span
                ><span :class="connected && tank.player ? 'good' : 'bad'">{{
                  connected && tank.player
                    ? `✓ ${tank.player}`
                    : "✕ Waiting for player"
                }}</span>
              </li>
            </ul>
            <div class="management-buttons">
              <button
                class="primary"
                :disabled="!startReady"
                @click="command('start')"
              >
                Start match</button
              ><button
                class="secondary"
                :disabled="!connected || pending"
                @click="openDialog('reset')"
              >
                Reset match
              </button>
            </div>
            <p v-if="stage === 'lobby' && !startReady" class="hint">
              Both tanks and both players must be connected before starting.
            </p>
          </section>
          <section class="feed panel">
            <div class="section-label">
              <span>{{ player ? "Battle log" : "Kill feed" }}</span><span
                class="mono"
                >LIVE FEED</span
              >
            </div>
            <div
              class="feed-list"
              role="log"
              aria-label="Battle log"
              aria-live="polite"
              aria-relevant="additions"
            >
              <p v-if="!feed.length" class="hint">
                Confirmed hits and kills will appear here.
              </p>
              <div
                v-for="item in feed.slice(0, 8)"
                :key="item.id"
                class="feed-row"
                :class="item.type"
              >
                <span
                  ><b :class="`text-team-${item.shooter}`"
                    >TANK 0{{ item.shooter }}</b
                  >
                  {{ item.type === "kill" ? "destroyed" : "hit" }}
                  <b :class="`text-team-${item.target}`"
                    >TANK 0{{ item.target }}</b
                  ></span
                ><time>{{
                  new Date(item.at).toLocaleTimeString("en-GB", {
                    hour12: false,
                  })
                }}</time>
              </div>
            </div>
          </section>
        </div>
      </template>
      <footer>
        <span>Live server · {{ settings.server }}</span
        ><span>Auto-stop when the window loses focus</span
        ><span>TANK ARENA</span>
      </footer>
    </main>
    <dialog
      ref="dialog"
      :aria-label="
        modal === 'settings'
          ? 'Connection settings'
          : modal === 'reset'
            ? 'Reset this match?'
            : 'Pilot guide'
      "
      @cancel.prevent="closeDialog"
    >
      <div class="dialog-heading">
        <h2>
          {{
            modal === "settings"
              ? "Connection settings"
              : modal === "reset"
                ? "Reset this match?"
                : "Pilot guide"
          }}
        </h2>
        <button
          class="icon-button"
          aria-label="Close dialog"
          @click="closeDialog"
        >
          ×
        </button>
      </div>
      <form v-if="modal === 'settings'" @submit.prevent="applySettings">
        <label class="field"
          >Server address<input
            v-model="draft.server"
            required
            placeholder="http://192.168.2.1:8000" /></label
        ><label v-if="player" class="field"
          >Player name<input v-model="draft.name" required maxlength="24"
        /></label>
        <p class="dialog-note">
          {{
            player
              ? `This page controls Tank 0${route.tankId}. Leaving this page disconnects the player. A new connection replaces the previous player for this tank.`
              : "The console can run on several screens at once. Only the console can start or reset a match."
          }}
        </p>
        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        <button class="primary full" type="submit">Connect to server</button>
      </form>
      <template v-else-if="modal === 'reset'"
        ><p class="dialog-note">
          Scores, health and ammo will reset. Both tanks return to free
          practice. Player connections stay active.
        </p>
        <div class="management-buttons">
          <button class="secondary" @click="closeDialog">Cancel</button
          ><button
            class="primary"
            :disabled="!connected || pending"
            @click="resetMatch"
          >
            Confirm reset
          </button>
        </div></template
      >
      <template v-else-if="modal === 'help'"
        ><div class="help-grid">
          <kbd>W / S or ↑ / ↓</kbd>
          <p>Forward / reverse. Hold to accelerate, release to stop.</p>
          <kbd>A / D or ← / →</kbd>
          <p>Gentle turns while moving; medium-speed turns on the spot.</p>
          <kbd>SHIFT</kbd>
          <p>Slow gear for precise positioning.</p>
          <kbd>MOUSE</kbd>
          <p>Move anywhere on the page to aim. Buttons and sliders hold the turret still.</p>
          <kbd>SPACE / CLICK</kbd>
          <p>Fire once per second. Live matches consume ammo.</p>
        </div>
        <p class="dialog-note">
          Losing focus stops the tank. Controls are locked during countdown,
          death and match end. The turret recenters at match start. Respawn
          takes 5 seconds and grants 3 seconds of protection.
        </p>
        <button class="primary full" @click="closeDialog">
          Got it
        </button></template
      >
    </dialog>
  </div>
</template>
