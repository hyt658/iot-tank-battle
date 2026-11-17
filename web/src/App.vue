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

// 页面与设置
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
  lobby: "自由练习",
  countdown: "准备交战",
  running: "比赛进行中",
  ended: "比赛结束",
};
const statuses = {
  connected: "已连接",
  connecting: "连接中",
  reconnecting: "正在重连",
  disconnected: "未连接",
};
const directions = [
  { key: "KeyW", label: "W", action: "前进", arrow: "↑" },
  { key: "KeyA", label: "A", action: "左转", arrow: "←" },
  { key: "KeyS", label: "S", action: "后退", arrow: "↓" },
  { key: "KeyD", label: "D", action: "右转", arrow: "→" },
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
  if (!tank.online) return "连接中断";
  if (locked.value) return "控制已锁定";
  return tank.alive ? "可以行动" : `复活 ${Math.ceil(tank.respawn_ms / 1000)}s`;
}

// 连接：模拟模式与真实服务器使用同一套消息。
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
          // 只在进入比赛时回正，后续刷新和复活不覆盖瞄准角度。
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
    error.value = exception.message || "连接失败";
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

// 驾驶：固定 20 Hz 发送；松键、失焦、断线或锁定立即停车。
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

// 设置、帮助与重置确认共用一个弹窗。
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
    formError.value = "请输入有效地址，例如 ws://10.42.0.1:8000";
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
    error.value = "当前浏览器不支持全屏，可使用浏览器的全屏功能";
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
      <a href="#" class="brand" aria-label="Tank Arena 首页"
        ><span class="brand-mark">⊕</span
        ><span
          >TANK<span class="brand-light">ARENA</span
          ><small>LOCAL MULTIPLAYER COMBAT</small></span
        ></a
      >
      <nav aria-label="主导航">
        <button :class="{ selected: player }" @click="swapRole('player')">
          驾驶控制
        </button>
        <button :class="{ selected: !player }" @click="swapRole('spectator')">
          观战计分
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
          aria-label="新标签页打开计分板"
          title="新标签页打开计分板，保留当前玩家连接"
          >↗</a
        >
        <button
          class="icon-button"
          aria-label="操作帮助"
          @click="openDialog('help')"
        >
          ?
        </button>
        <button
          class="icon-button"
          aria-label="连接设置"
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
          <h1>{{ player ? "准备好，进入战场。" : "每一发，都改变战局。" }}</h1>
          <p>
            {{
              player
                ? "掌控履带，转动炮塔。下一次命中，由你决定。"
                : "实时关注双方战况，掌握比赛的每一个转折。"
            }}
          </p>
        </div>
        <button class="secondary small" @click="openDialog('settings')">
          <span class="mode-dot"></span
          >{{ settings.demo ? "模拟演练" : "实机连接" }} ›
        </button>
      </div>
      <div class="environment-note" :class="{ 'live-note': !settings.demo }">
        <span
          ><b>{{ settings.demo ? "模拟模式" : "真实服务器" }}</b
          >{{
            settings.demo
              ? "本页使用假数据，不会控制实体坦克。切换到观战页可以开始比赛。"
              : `${settings.server} · 所有比赛数据由服务器提供`
          }}</span
        >
        <label v-if="settings.demo" class="bot-toggle"
          ><input v-model="bot" type="checkbox" />自动对手</label
        >
      </div>
      <div v-if="error" class="error-banner" role="alert">
        <span>{{ error }}</span
        ><button aria-label="关闭提示" @click="error = ''">×</button>
      </div>
      <div v-if="!connected" class="error-banner" role="status">
        <span>{{
          status === "reconnecting"
            ? "连接中断，驾驶已停止；每秒尝试重连。"
            : "等待连接和服务器状态，驾驶暂不可用。"
        }}</span
        ><button @click="connect()">重新连接</button>
      </div>

      <section class="match-strip" aria-label="比赛状态">
        <div class="match-phase">
          <span class="live-dot"></span>
          <div>
            <span class="eyebrow">{{
              stage === "lobby" ? "PRACTICE SESSION" : "MATCH / 01"
            }}</span
            ><strong>{{ state ? phases[stage] : "等待比赛数据" }}</strong>
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
              ? "自由练习 · 不消耗弹药"
              : "先达 5 杀 / 限时 3 分钟"
          }}</span>
        </div>
      </section>
      <div v-if="stage === 'ended'" class="result-banner" role="status">
        <div>
          <strong>{{
            state.winner
              ? `TANK 0${state.winner} 赢得比赛`
              : "势均力敌，本局平局"
          }}</strong>
          <p>比赛已结束，坦克控制已锁定。请在观战页重置下一局。</p>
        </div>
      </div>
      <div v-if="stage === 'countdown'" class="countdown-banner" role="status">
        准备交战 <b>{{ Math.ceil(state.time_left_ms / 1000) }}</b><span
          >倒计时期间控制已锁定</span
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
              ><i></i>{{ tank.online ? "在线" : "离线" }}</span
            >
          </div>
          <div class="tank-title">
            <div>
              <h2>{{ tank.player || "等待玩家" }}</h2>
              <span>{{
                !player
                  ? "参赛玩家"
                  : tank.id === settings.tankId
                    ? "你的坦克"
                    : "对手坦克"
              }}</span>
            </div>
            <div class="tank-glyph" aria-hidden="true">
              <i class="track left"></i><i class="track right"></i
              ><i class="hull"></i><i class="turret"><i></i></i>
            </div>
          </div>
          <div class="stat-label">
            <span>装甲血量</span
            ><strong>{{ tank.hp }}<small> / 5</small></strong>
          </div>
          <div class="meter hp" :aria-label="`血量 ${tank.hp}/5`">
            <span
              v-for="n in 5"
              :key="n"
              :class="{ filled: n <= tank.hp }"
            ></span>
          </div>
          <div class="stat-label">
            <span>剩余弹药</span
            ><strong>{{ tank.ammo }}<small> / 10</small></strong>
          </div>
          <div class="meter ammo" :aria-label="`弹药 ${tank.ammo}/10`">
            <span
              v-for="n in 10"
              :key="n"
              :class="{ filled: n <= tank.ammo }"
            ></span>
          </div>
          <div class="kd">
            <div>
              <span>击杀</span
              ><strong>{{ String(tank.kills).padStart(2, "0") }}</strong>
            </div>
            <div>
              <span>死亡</span
              ><strong>{{ String(tank.deaths).padStart(2, "0") }}</strong>
            </div>
            <span class="life" :class="{ dead: !tank.alive }">{{
              tankStatus(tank)
            }}</span>
          </div>
        </section>
        <div v-if="!state" class="panel loading first-tank">等待坦克数据…</div>

        <section v-if="player" class="aim-panel panel">
          <div class="section-label">
            <span>⊕ 炮塔瞄准</span><span class="mono">TURRET CONTROL</span>
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
                  ? "等待连接"
                  : locked
                    ? "控制已锁定"
                    : paused
                      ? "控制已暂停"
                      : !own?.alive
                        ? `复活中 · ${Math.ceil((own?.respawn_ms ?? 0) / 1000)}s`
                        : enabled
                          ? "瞄准系统就绪"
                          : "控制已锁定"
              }}
            </div>
            <div v-if="now - lastShot < 220" class="shot-flash"></div>
          </div>
          <div class="angle-control">
            <div>
              <span>炮塔角度</span
              ><strong>{{ angle > 0 ? "+" : "" }}{{ angle }}°</strong>
            </div>
            <input
              v-model.number="angle"
              aria-label="炮塔角度"
              type="range"
              min="-90"
              max="90"
              :disabled="!enabled"
            /><span>左</span><span>右</span>
          </div>
          <button class="fire-button" :disabled="!fireReady" @click="fire">
            <span>⊕</span
            ><span
              >{{ cooldown ? `装填中 ${(cooldown / 1000).toFixed(1)}s` : "开火"
              }}<small>{{
                own?.alive ? "FIRE CANNON" : "等待复活"
              }}</small></span
            ><kbd>SPACE</kbd>
          </button>
          <p class="hint aim-hint">移动鼠标瞄准 · 点击瞄准区或按空格开火</p>
          <div class="aim-footnote">
            这是炮塔角度示意，不是摄像头画面或坦克定位。
          </div>
        </section>

        <section v-if="player" class="drive-panel panel">
          <div class="section-label">
            <span>履带控制</span><span class="mono">W A S D</span>
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
          <p class="hint">按住方向键驾驶，松开即停止</p>
          <button
            class="stop-button"
            :class="{ resume: paused }"
            :disabled="!connected"
            @click="togglePause"
          >
            {{ paused ? "▶ 恢复控制" : "Ⅱ 暂停驾驶 / 停车" }}
          </button>
        </section>
        <section v-else class="match-management panel">
          <div class="section-label">
            <span>比赛管理</span
            ><button
              class="icon-button"
              aria-label="全屏观战"
              @click="fullScreen"
            >
              ⛶
            </button>
          </div>
          <h2>
            {{
              stage === "lobby"
                ? "双方就绪，即刻开战。"
                : stage === "running"
                  ? "交火进行中。"
                  : stage === "ended"
                    ? "准备下一场对决。"
                    : "战斗即将开始。"
            }}
          </h2>
          <p>3 秒准备 · 5 点血量 · 5 秒复活 · 先到 5 杀获胜</p>
          <div class="management-buttons">
            <button
              class="primary"
              :disabled="!startReady"
              @click="send({ type: 'game', action: 'start' })"
            >
              ▶ 开始比赛</button
            ><button
              class="secondary"
              :disabled="!connected"
              @click="openDialog('reset')"
            >
              ↻ 重置比赛</button
            ><button
              v-if="settings.demo"
              class="text-button"
              @click="swapRole('player')"
            >
              返回驾驶 ›
            </button>
          </div>
          <p v-if="stage === 'lobby' && !startReady" class="hint">
            需要两台坦克在线，且各有一名玩家。
          </p>
        </section>

        <section class="feed panel">
          <div class="section-label">
            <span>战场动态</span><span class="mono">LIVE FEED</span>
          </div>
          <div
            class="feed-list"
            role="log"
            aria-label="战场动态"
            aria-live="polite"
            aria-relevant="additions"
          >
            <div v-if="!feed.length" class="feed-empty">
              <span>等待第一发炮火</span
              ><small>命中与击杀记录将在这里显示</small>
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
                {{ item.kind === "kill" ? "击毁" : "命中" }}
                <b :class="`text-team-${item.target}`"
                  >0{{ item.target }}</b
                ></span
              ><time>{{
                new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })
              }}</time>
            </div>
          </div>
        </section>
      </div>
      <footer>
        <span>切出窗口自动停车</span
        ><span>20 Hz 控制 · 1 s 开火间隔 · 3 s 弹药恢复</span
        ><span class="footer-brand">TANK ARENA / 01</span>
      </footer>
    </main>

    <dialog
      ref="dialog"
      class="dialog"
      :aria-label="
        modal === 'settings'
          ? '连接你的战场'
          : modal === 'reset'
            ? '重置这场比赛？'
            : '驾驶员操作指南'
      "
      @cancel.prevent="closeDialog"
    >
      <div class="dialog-heading">
        <h2>
          {{
            modal === "settings"
              ? "连接你的战场"
              : modal === "reset"
                ? "重置这场比赛？"
                : "驾驶员操作指南"
          }}
        </h2>
        <button class="icon-button" aria-label="关闭弹窗" @click="closeDialog">
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
            <b>模拟演练</b><small>无需硬件，直接体验</small></button
          ><button
            type="button"
            :class="{ active: !draft.demo }"
            @click="draft.demo = false"
          >
            <b>真实服务器</b><small>连接本地 Wi-Fi 战场</small>
          </button>
        </div>
        <label v-if="!draft.demo" class="field"
          >服务器地址<input
            v-model="draft.server"
            placeholder="ws://10.42.0.1:8000"
            required
          /><small
            >先连接 tank-arena Wi-Fi；网页会自动选择连接路径。</small
          ></label
        >
        <label class="field"
          >进入方式<select v-model="draft.role">
            <option value="player">玩家 · 驾驶坦克</option>
            <option value="spectator">观众 · 计分与比赛管理</option>
          </select></label
        >
        <div v-if="draft.role === 'player'" class="form-row">
          <label class="field"
            >玩家名字<input
              v-model="draft.name"
              maxlength="24"
              required /></label
          ><label class="field"
            >坦克编号<select v-model.number="draft.tankId">
              <option :value="1">TANK 01</option>
              <option :value="2">TANK 02</option>
            </select></label
          >
        </div>
        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        <p class="dialog-note">
          {{
            draft.demo
              ? "演练数据只存在当前标签页，刷新后重新开始。后端就绪后，在这里切换连接即可。"
              : "真实模式不使用假数据补位。切换成观众会释放玩家连接；实战请另开计分页，并选择真实服务器。"
          }}
        </p>
        <button class="primary full" type="submit">
          {{ draft.demo ? "进入模拟战场" : "连接服务器" }}
        </button>
      </form>
      <template v-else-if="modal === 'reset'"
        ><p class="dialog-note">
          当前比分、血量和弹药将重置，所有坦克返回自由练习阶段。
        </p>
        <div class="management-buttons">
          <button class="secondary" @click="closeDialog">取消</button
          ><button class="primary" @click="resetMatch">确认重置</button>
        </div></template
      >
      <template v-else-if="modal === 'help'"
        ><div class="help-grid">
          <span><kbd>W</kbd><kbd>S</kbd></span>
          <p>前进 / 后退</p>
          <span><kbd>A</kbd><kbd>D</kbd></span>
          <p>原地左转 / 右转</p>
          <kbd>鼠标</kbd>
          <p>在瞄准区移动以转动炮塔</p>
          <kbd>SPACE</kbd>
          <p>开火，每发间隔 1 秒</p>
        </div>
        <p class="dialog-note">
          失焦会清除按键并发送停车指令。倒计时、死亡、比赛结束和断线期间不能驾驶。比赛开始时炮塔回正到
          0°。实物端仍需实现 300 ms 超时停车。
        </p>
        <p class="dialog-note">
          模拟模式中允许的射击会模拟命中，不模拟位置、红外和障碍。每个标签页的模拟比赛彼此独立。
        </p>
        <button class="primary full" @click="closeDialog">
          明白，准备出发
        </button></template
      >
    </dialog>
  </div>
</template>
