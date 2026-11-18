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
  demoArena,
  openDemo,
  openSocket,
  socketUrl,
} from "./connection.js";

// Page and settings
const settings = ref({
  demo: true,
  server: "ws://10.42.0.1:8000",
  role: location.hash === "#spectator" ? "spectator" : "player",
  tankId: 1,
  name: "Player 01",
});
const state = shallowRef(null);
const status = ref("connecting");
const error = ref("");
const feed = ref([]);
const paused = ref(false);
const bot = ref(true);
const now = ref(Date.now());
const lastShot = ref(0);
const angle = ref(0);
const drive = ref({ left: 0, right: 0 });
const modal = ref("");
const dialog = ref(null);
const draft = ref({});
const formError = ref("");
const phases = {
  lobby: "Free practice",
  countdown: "Get ready",
  running: "Match in progress",
  ended: "Match ended",
};
const statuses = {
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

const connected = computed(() => status.value === "connected");
const player = computed(() => settings.value.role === "player");
const stage = computed(() => state.value?.status ?? "lobby");
const own = computed(() =>
  state.value?.tanks.find((t) => t.id === settings.value.tankId),
);
const tanks = computed(() =>
  [...(state.value?.tanks ?? [])].sort((a, b) =>
    player.value
      ? Number(b.id === settings.value.tankId) -
        Number(a.id === settings.value.tankId)
      : a.id - b.id,
  ),
);
const enabled = computed(
  () =>
    connected.value &&
    player.value &&
    canDrive(state.value, settings.value.tankId) &&
    !paused.value &&
    !modal.value,
);
const locked = computed(
  () => !connected.value || ["countdown", "ended"].includes(stage.value),
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
    stage.value === "lobby" &&
    state.value?.tanks.every((t) => t.online && t.player),
);

function formatTime(ms) {
  const seconds = Math.ceil(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function tankStatus(tank) {
  if (!tank.online) return "Connection lost";
  if (locked.value) return "Controls locked";
  return tank.alive ? "Ready" : `Respawn in ${Math.ceil(tank.respawn_ms / 1000)}s`;
}

// Demo and server connections use the same messages.
let connection = null;
let session = 0;
let eventId = 0;
function send(message) {
  return connection?.send(message) ?? false;
}
function connect(next = settings.value) {
  session++;
  stop();
  connection?.close();
  connection = null;
  settings.value = { ...next };
  state.value = null;
  status.value = "connecting";
  error.value = "";
  feed.value = [];
  const activeSession = session;
  try {
    connection = (next.demo ? openDemo : openSocket)(settings.value, {
      status(value) {
        if (session === activeSession) status.value = value;
      },
      message(message) {
        if (session !== activeSession) return;
        if (message.type === "state") {
          // Recenter only when entering a match, not on updates or respawn.
          if (message.status === "running" && state.value?.status !== "running")
            angle.value = 0;
          state.value = message;
        }
        if (message.type === "error") error.value = message.message;
        if (message.type === "event")
          feed.value = [
            { ...message, id: ++eventId, at: Date.now() },
            ...feed.value,
          ].slice(0, 30);
      },
    });
  } catch (exception) {
    error.value = exception.message || "Connection failed";
    status.value = "disconnected";
  }
}
function swapRole(role) {
  if (settings.value.role === role) return;
  connect({ ...settings.value, role });
  paused.value = false;
}
watch(bot, (value) => {
  demoArena.botEnabled = value;
});

// Send drive commands at 20 Hz; stop on release, blur, disconnect or lock.
const keys = new Set();
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
let focused = true;
function stop() {
  keys.clear();
  drive.value = { left: 0, right: 0 };
  if (player.value)
    send({ type: "drive", left: 0, right: 0, turret: angle.value });
}
function sendDrive() {
  if (!enabled.value) return;
  const has = (key) => focused && keys.has(key);
  const forward =
    Number(has("KeyW") || has("ArrowUp")) -
    Number(has("KeyS") || has("ArrowDown"));
  const turn =
    Number(has("KeyD") || has("ArrowRight")) -
    Number(has("KeyA") || has("ArrowLeft"));
  const clamp = (value) => Math.max(-100, Math.min(100, value));
  drive.value = {
    left: clamp((forward + turn) * 60),
    right: clamp((forward - turn) * 60),
  };
  send({ type: "drive", ...drive.value, turret: angle.value });
}
watch(
  enabled,
  (value) => {
    if (!value) stop();
  },
  { flush: "sync" },
);
function isEditing(target) {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input,select,textarea,[contenteditable="true"]')
  );
}
function keydown(event) {
  if (!enabled.value || isEditing(event.target)) return;
  if (movementKeys.has(event.code)) {
    event.preventDefault();
    focused = true;
    keys.add(event.code);
  }
  if (event.code === "Space" && !event.target?.closest?.("button")) {
    event.preventDefault();
    if (!event.repeat) fire();
  }
}
function keyup(event) {
  if (movementKeys.has(event.code)) {
    keys.delete(event.code);
    sendDrive();
  }
}
function blur() {
  focused = false;
  stop();
}
function focus() {
  keys.clear();
  focused = true;
}
function visibility() {
  if (document.hidden) blur();
  else focus();
}
function focusIn(event) {
  if (isEditing(event.target)) stop();
}
function pressDirection(event, key) {
  if (!enabled.value) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  focused = true;
  keys.add(key);
  sendDrive();
}
function releaseDirection(key) {
  keys.delete(key);
  sendDrive();
}
function aim(event) {
  if (!enabled.value || event.pointerType !== "mouse") return;
  const bounds = event.currentTarget.getBoundingClientRect();
  angle.value = Math.round(
    Math.max(
      -90,
      Math.min(90, ((event.clientX - bounds.left) / bounds.width) * 180 - 90),
    ),
  );
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

// Settings, help and reset confirmation share one dialog.
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
    if (!draft.value.demo) socketUrl(draft.value.server, draft.value.role);
    connect({ ...draft.value, name: draft.value.name.trim() || "Player" });
    paused.value = false;
    closeDialog();
  } catch {
    formError.value = "Enter a valid address, such as ws://10.42.0.1:8000.";
  }
}
function resetMatch() {
  send({ type: "game", action: "reset" });
  closeDialog();
}
async function fullScreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    error.value = "Full screen is unavailable. Try the full-screen option in your browser menu.";
  }
}

let driveTimer;
let clockTimer;
onMounted(() => {
  connect();
  driveTimer = setInterval(sendDrive, 50);
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 100);
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  window.addEventListener("pagehide", blur);
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("focusin", focusIn);
});
onUnmounted(() => {
  session++;
  stop();
  connection?.close();
  clearInterval(driveTimer);
  clearInterval(clockTimer);
  window.removeEventListener("keydown", keydown);
  window.removeEventListener("keyup", keyup);
  window.removeEventListener("blur", blur);
  window.removeEventListener("focus", focus);
  window.removeEventListener("pagehide", blur);
  document.removeEventListener("visibilitychange", visibility);
  document.removeEventListener("focusin", focusIn);
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a href="#" class="brand" aria-label="Tank Arena home"
        ><span class="brand-mark">⊕</span
        ><span
          >TANK<span class="brand-light">ARENA</span
          ><small>LOCAL MULTIPLAYER COMBAT</small></span
        ></a
      >
      <nav aria-label="Main navigation">
        <button :class="{ selected: player }" @click="swapRole('player')">
          Pilot
        </button>
        <button :class="{ selected: !player }" @click="swapRole('spectator')">
          Scoreboard
        </button>
      </nav>
      <div class="header-tools">
        <span class="connection-badge" :class="connected ? 'good' : 'bad'"
          >● {{ statuses[status] }}</span
        >
        <a
          v-if="!settings.demo"
          class="icon-button"
          href="#spectator"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open scoreboard in a new tab"
          title="Open the scoreboard in a new tab and keep this player connected"
          >↗</a
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
          <div class="eyebrow">
            <span></span> COMMAND CENTER
            <span class="muted">/ {{ player ? "PILOT" : "SPECTATOR" }}</span>
          </div>
          <h1>{{ player ? "Ready for battle." : "Every shot counts." }}</h1>
          <p>
            {{
              player
                ? "Take the controls. Aim your turret. Make your next shot count."
                : "Follow both tanks and every turn of the match in real time."
            }}
          </p>
        </div>
        <button class="secondary small" @click="openDialog('settings')">
          <span class="mode-dot"></span
          >{{ settings.demo ? "Demo" : "Live connection" }} ›
        </button>
      </div>
      <div class="environment-note" :class="{ 'live-note': !settings.demo }">
        <span
          ><b>{{ settings.demo ? "Demo mode" : "Live server" }}</b
          >{{
            settings.demo
              ? "Simulated data only. Open the Scoreboard to start a match."
              : `${settings.server} · All match data comes from the server`
          }}</span
        >
        <label v-if="settings.demo" class="bot-toggle"
          ><input v-model="bot" type="checkbox" />Auto opponent</label
        >
      </div>
      <div v-if="error" class="error-banner" role="alert">
        <span>{{ error }}</span
        ><button aria-label="Dismiss message" @click="error = ''">×</button>
      </div>
      <div v-if="!connected" class="error-banner" role="status">
        <span>{{
          status === "reconnecting"
            ? "Connection lost. Driving stopped. Retrying every second."
            : "Waiting for the connection and match data. Driving is unavailable."
        }}</span
        ><button @click="connect()">Reconnect</button>
      </div>

      <section class="match-strip" aria-label="Match status">
        <div class="match-phase">
          <span class="live-dot"></span>
          <div>
            <span class="eyebrow">{{
              stage === "lobby" ? "PRACTICE SESSION" : "MATCH / 01"
            }}</span
            ><strong>{{ state ? phases[stage] : "Waiting for match data" }}</strong>
          </div>
        </div>
        <div class="score-line">
          <span class="team-label text-team-1">TANK 01</span
          ><b>{{ state?.tanks.find((t) => t.id === 1)?.kills ?? "—" }}</b
          ><span class="score-divider">:</span
          ><b>{{ state?.tanks.find((t) => t.id === 2)?.kills ?? "—" }}</b
          ><span class="team-label text-team-2">TANK 02</span>
        </div>
        <div class="match-time">
          <strong>{{
            !state
              ? "—"
              : stage === "lobby"
                ? "∞"
                : formatTime(state.time_left_ms)
          }}</strong
          ><span>{{
            stage === "lobby"
              ? "Practice · Unlimited ammo"
              : "First to 5 kills / 3 min"
          }}</span>
        </div>
      </section>
      <div v-if="stage === 'ended'" class="result-banner" role="status">
        <div>
          <strong>{{
            state.winner
              ? `TANK 0${state.winner} wins the match`
              : "The match is a draw"
          }}</strong>
          <p>Match over. Controls are locked. Reset the match from the Scoreboard.</p>
        </div>
      </div>
      <div v-if="stage === 'countdown'" class="countdown-banner" role="status">
        Get ready <b>{{ Math.ceil(state.time_left_ms / 1000) }}</b><span
          >Controls locked during countdown</span
        >
      </div>

      <div class="battle-grid" :class="player ? 'pilot' : 'spectator'">
        <section
          v-for="(tank, index) in tanks"
          :key="tank.id"
          class="tank-card"
          :class="[
            `team-${tank.id}`,
            index === 0 ? 'first-tank' : 'second-tank',
            { large: !player },
          ]"
        >
          <div class="card-overline">
            <span>TANK / 0{{ tank.id }}</span
            ><span class="tiny-status" :class="{ online: tank.online }"
              ><i></i>{{ tank.online ? "Online" : "Offline" }}</span
            >
          </div>
          <div class="tank-title">
            <div>
              <h2>{{ tank.player || "Waiting for player" }}</h2>
              <span>{{
                !player
                  ? "Player"
                  : tank.id === settings.tankId
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
            <span>Health</span
            ><strong>{{ tank.hp }}<small> / 5</small></strong>
          </div>
          <div class="meter hp" :aria-label="`Health ${tank.hp}/5`">
            <span
              v-for="n in 5"
              :key="n"
              :class="{ filled: n <= tank.hp }"
            ></span>
          </div>
          <div class="stat-label">
            <span>Ammo</span
            ><strong>{{ tank.ammo }}<small> / 10</small></strong>
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
              <span>Kills</span
              ><strong>{{ String(tank.kills).padStart(2, "0") }}</strong>
            </div>
            <div>
              <span>Deaths</span
              ><strong>{{ String(tank.deaths).padStart(2, "0") }}</strong>
            </div>
            <span class="life" :class="{ dead: !tank.alive }">{{
              tankStatus(tank)
            }}</span>
          </div>
        </section>
        <div v-if="!state" class="panel loading first-tank">Waiting for tank data…</div>

        <section v-if="player" class="aim-panel panel">
          <div class="section-label">
            <span>⊕ Aim</span><span class="mono">TURRET CONTROL</span>
          </div>
          <div class="aim-area" @pointermove="aim" @click="fire">
            <div class="aim-grid"></div>
            <span class="compass north">FRONT / 0°</span
            ><span class="compass west">−90°</span
            ><span class="compass east">+90°</span>
            <div class="radar">
              <div class="radar-inner"></div>
              <div
                class="aim-line"
                :style="{ transform: `rotate(${angle}deg)` }"
              ></div>
              <div class="tank-glyph hero-tank" aria-hidden="true">
                <i class="track left"></i><i class="track right"></i
                ><i class="hull"></i
                ><i class="turret" :style="{ transform: `rotate(${angle}deg)` }"
                  ><i></i
                ></i>
              </div>
            </div>
            <div class="aim-tag">
              <span class="status-square" :class="{ off: !enabled }"></span
              >{{
                !connected
                  ? "Waiting for connection"
                  : locked
                    ? "Controls locked"
                    : paused
                      ? "Controls paused"
                      : !own?.alive
                        ? `Respawning · ${Math.ceil((own?.respawn_ms ?? 0) / 1000)}s`
                        : enabled
                          ? "Ready to aim"
                          : "Controls locked"
              }}
            </div>
            <div v-if="now - lastShot < 220" class="shot-flash"></div>
          </div>
          <div class="angle-control">
            <div>
              <span>Turret angle</span
              ><strong>{{ angle > 0 ? "+" : "" }}{{ angle }}°</strong>
            </div>
            <input
              v-model.number="angle"
              aria-label="Turret angle"
              type="range"
              min="-90"
              max="90"
              :disabled="!enabled"
            /><span>Left</span><span>Right</span>
          </div>
          <button class="fire-button" :disabled="!fireReady" @click="fire">
            <span>⊕</span
            ><span
              >{{ cooldown ? `Reloading ${(cooldown / 1000).toFixed(1)}s` : "Fire"
              }}<small>{{
                own?.alive ? "FIRE CANNON" : "Awaiting respawn"
              }}</small></span
            ><kbd>SPACE</kbd>
          </button>
          <p class="hint aim-hint">Move the mouse to aim · Click here or press Space to fire</p>
          <div class="aim-footnote">
            Turret angle display only; no camera feed or tank tracking.
          </div>
        </section>

        <section v-if="player" class="drive-panel panel">
          <div class="section-label">
            <span>Drive</span><span class="mono">W A S D</span>
          </div>
          <div class="drive-layout">
            <div class="d-pad">
              <button
                v-for="direction in directions"
                :key="direction.key"
                class="pad-key"
                :class="direction.label.toLowerCase()"
                :aria-label="`${direction.label} ${direction.action}`"
                :disabled="!enabled"
                @pointerdown.prevent="pressDirection($event, direction.key)"
                @pointerup="releaseDirection(direction.key)"
                @pointercancel="stop"
                @lostpointercapture="releaseDirection(direction.key)"
              >
                <span>{{ direction.arrow }}</span
                ><span>{{ direction.label }}</span>
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
          <p class="hint">Hold WASD or arrow keys to drive. Release to stop.</p>
          <button
            class="stop-button"
            :class="{ resume: paused }"
            :disabled="!connected"
            @click="togglePause"
          >
            {{ paused ? "▶ Resume" : "Ⅱ Pause / Stop" }}
          </button>
        </section>
        <section v-else class="match-management panel">
          <div class="section-label">
            <span>Match controls</span
            ><button
              class="icon-button"
              aria-label="Full-screen scoreboard"
              @click="fullScreen"
            >
              ⛶
            </button>
          </div>
          <h2>
            {{
              stage === "lobby"
                ? "Both sides ready. Start the match."
                : stage === "running"
                  ? "Battle in progress."
                  : stage === "ended"
                    ? "Ready for the next round."
                    : "The battle starts soon."
            }}
          </h2>
          <p>3 s countdown · 5 HP · 5 s respawn · First to 5 kills wins</p>
          <div class="management-buttons">
            <button
              class="primary"
              :disabled="!startReady"
              @click="send({ type: 'game', action: 'start' })"
            >
              ▶ Start match</button
            ><button
              class="secondary"
              :disabled="!connected"
              @click="openDialog('reset')"
            >
              ↻ Reset match</button
            ><button
              v-if="settings.demo"
              class="text-button"
              @click="swapRole('player')"
            >
              Back to pilot ›
            </button>
          </div>
          <p v-if="stage === 'lobby' && !startReady" class="hint">
            Both tanks must be online, with one player each.
          </p>
        </section>

        <section class="feed panel">
          <div class="section-label">
            <span>Battle log</span><span class="mono">LIVE FEED</span>
          </div>
          <div
            class="feed-list"
            role="log"
            aria-label="Battle log"
            aria-live="polite"
            aria-relevant="additions"
          >
            <div v-if="!feed.length" class="feed-empty">
              <span>Waiting for the first shot</span
              ><small>Hits and kills will appear here</small>
            </div>
            <div
              v-for="item in feed.slice(0, 6)"
              :key="item.id"
              class="feed-row"
              :class="item.kind"
            >
              <span
                ><b :class="`text-team-${item.shooter}`"
                  >TANK 0{{ item.shooter }}</b
                >
                {{ item.kind === "kill" ? "destroyed" : "hit" }}
                <b :class="`text-team-${item.target}`"
                  >0{{ item.target }}</b
                ></span
              ><time>{{
                new Date(item.at).toLocaleTimeString("en", { hour12: false })
              }}</time>
            </div>
          </div>
        </section>
      </div>
      <footer>
        <span>Auto-stop when the window loses focus</span
        ><span>20 Hz control · 1 s fire cooldown · 3 s ammo regen</span
        ><span class="footer-brand">TANK ARENA / 01</span>
      </footer>
    </main>

    <dialog
      ref="dialog"
      class="dialog"
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
        <button class="icon-button" aria-label="Close dialog" @click="closeDialog">
          ×
        </button>
      </div>
      <form v-if="modal === 'settings'" @submit.prevent="applySettings">
        <div class="mode-choices">
          <button
            type="button"
            :class="{ active: draft.demo }"
            @click="draft.demo = true"
          >
            <b>Demo</b><small>Try it without hardware</small></button
          ><button
            type="button"
            :class="{ active: !draft.demo }"
            @click="draft.demo = false"
          >
            <b>Live server</b><small>Connect over local Wi-Fi</small>
          </button>
        </div>
        <label v-if="!draft.demo" class="field"
          >Server address<input
            v-model="draft.server"
            placeholder="ws://10.42.0.1:8000"
            required
          /><small
            >Connect to tank-arena Wi-Fi first. The connection path is selected automatically.</small
          ></label
        >
        <label class="field"
          >Join as<select v-model="draft.role">
            <option value="player">Player · Drive a tank</option>
            <option value="spectator">Spectator · Scores and match controls</option>
          </select></label
        >
        <div v-if="draft.role === 'player'" class="form-row">
          <label class="field"
            >Player name<input
              v-model="draft.name"
              maxlength="24"
              required /></label
          ><label class="field"
            >Tank<select v-model.number="draft.tankId">
              <option :value="1">TANK 01</option>
              <option :value="2">TANK 02</option>
            </select></label
          >
        </div>
        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        <p class="dialog-note">
          {{
            draft.demo
              ? "Each tab has its own demo match. Refresh to start over. Switch to Live server here when the backend is ready."
              : "Live mode requires server data. Switching to Spectator disconnects your player. To keep driving, open the Scoreboard in a new tab and select Live server there."
          }}
        </p>
        <button class="primary full" type="submit">
          {{ draft.demo ? "Enter demo" : "Connect to server" }}
        </button>
      </form>
      <template v-else-if="modal === 'reset'"
        ><p class="dialog-note">
          Scores, health and ammo will reset. Both tanks will return to free practice.
        </p>
        <div class="management-buttons">
          <button class="secondary" @click="closeDialog">Cancel</button
          ><button class="primary" @click="resetMatch">Confirm reset</button>
        </div></template
      >
      <template v-else-if="modal === 'help'"
        ><div class="help-grid">
          <span><kbd>W</kbd><kbd>S</kbd></span>
          <p>Move forward / Reverse</p>
          <span><kbd>A</kbd><kbd>D</kbd></span>
          <p>Turn left / Turn right</p>
          <kbd>Mouse</kbd>
          <p>Move within the aiming area to rotate the turret</p>
          <kbd>SPACE</kbd>
          <p>Fire, with a 1-second cooldown</p>
        </div>
        <p class="dialog-note">
          Leaving the window releases the controls and sends a stop command. Driving is disabled during countdown, while dead, after the match or when disconnected. The turret returns to 0° when the match starts.
        </p>
        <p class="dialog-note">
          In demo mode, valid shots simulate hits. Position, infrared signals and obstacles are not simulated. Each tab runs a separate match.
        </p>
        <button class="primary full" @click="closeDialog">
          Got it. Ready to go.
        </button></template
      >
    </dialog>
  </div>
</template>
