import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  CircleHelp,
  Crosshair,
  ExternalLink,
  Gamepad2,
  Gauge,
  Maximize2,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Settings2,
  Shield,
  Swords,
  Target,
  Trophy,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { canDrive, socketUrl } from "./protocol";
import type { ConnectionSettings, TankState } from "./protocol";
import { useControls, useSession } from "./hooks";
import type { FeedItem } from "./hooks";
import { demoArena } from "./connection";

const initial: ConnectionSettings = {
  demo: true,
  server: "ws://10.42.0.1:8000",
  role: location.hash === "#spectator" ? "spectator" : "player",
  tankId: 1,
  name: "Player 01",
};
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
const formatTime = (ms: number) =>
  `${Math.floor(Math.ceil(ms / 1000) / 60)
    .toString()
    .padStart(
      2,
      "0",
    )}:${(Math.ceil(ms / 1000) % 60).toString().padStart(2, "0")}`;

function TankGlyph({
  angle = 0,
  className = "",
}: {
  angle?: number;
  className?: string;
}) {
  return (
    <div className={`tank-glyph ${className}`} aria-hidden="true">
      <i className="track left" />
      <i className="track right" />
      <i className="hull" />
      <i className="turret" style={{ transform: `rotate(${angle}deg)` }}>
        <i />
      </i>
    </div>
  );
}
function Meter({
  value,
  max,
  kind,
}: {
  value: number;
  max: number;
  kind: "hp" | "ammo";
}) {
  return (
    <div
      className={`meter ${kind}`}
      aria-label={`${kind === "hp" ? "血量" : "弹药"} ${value}/${max}`}
    >
      {Array.from({ length: max }, (_, i) => (
        <span className={i < value ? "filled" : ""} key={i} />
      ))}
    </div>
  );
}
function TankCard({
  tank,
  yours,
  large = false,
  locked = false,
}: {
  tank: TankState;
  yours: boolean;
  large?: boolean;
  locked?: boolean;
}) {
  return (
    <section className={`tank-card team-${tank.id} ${large ? "large" : ""}`}>
      <div className="card-overline">
        <span>TANK / 0{tank.id}</span>
        <span className={`tiny-status ${tank.online ? "online" : ""}`}>
          <i />
          {tank.online ? "在线" : "离线"}
        </span>
      </div>
      <div className="tank-title">
        <div>
          <h2>{tank.player || "等待玩家"}</h2>
          <span>{large ? "参赛玩家" : yours ? "你的坦克" : "对手坦克"}</span>
        </div>
        <TankGlyph />
      </div>
      <div className="stat-label">
        <span>
          <Shield size={14} /> 装甲血量
        </span>
        <strong>
          {tank.hp}
          <small> / 5</small>
        </strong>
      </div>
      <Meter value={tank.hp} max={5} kind="hp" />
      <div className="stat-label">
        <span>
          <Zap size={14} /> 剩余弹药
        </span>
        <strong>
          {tank.ammo}
          <small> / 10</small>
        </strong>
      </div>
      <Meter value={tank.ammo} max={10} kind="ammo" />
      <div className="kd">
        <div>
          <span>击杀</span>
          <strong>{String(tank.kills).padStart(2, "0")}</strong>
        </div>
        <div>
          <span>死亡</span>
          <strong>{String(tank.deaths).padStart(2, "0")}</strong>
        </div>
        <span className={`life ${tank.alive ? "" : "dead"}`}>
          {!tank.online
            ? "连接中断"
            : locked
              ? "控制已锁定"
              : tank.alive
                ? "可以行动"
                : `复活 ${Math.ceil(tank.respawn_ms / 1000)}s`}
        </span>
      </div>
    </section>
  );
}
function Feed({ items }: { items: FeedItem[] }) {
  return (
    <section className="feed panel">
      <div className="section-label">
        <span>
          <Activity size={16} /> 战场动态
        </span>
        <span className="mono">LIVE FEED</span>
      </div>
      <div
        className="feed-list"
        role="log"
        aria-label="战场动态"
        aria-live="polite"
        aria-relevant="additions"
      >
        {!items.length && (
          <div className="feed-empty">
            <Radio size={24} />
            <span>等待第一发炮火</span>
            <small>命中与击杀记录将在这里显示</small>
          </div>
        )}
        {items.slice(0, 6).map((item) => (
          <div className={`feed-row ${item.event.kind}`} key={item.id}>
            {item.event.kind === "kill" ? (
              <Swords size={16} />
            ) : (
              <Crosshair size={16} />
            )}
            <span>
              <b className={`text-team-${item.event.shooter}`}>
                TANK 0{item.event.shooter}
              </b>{" "}
              {item.event.kind === "kill" ? "击毁" : "命中"}{" "}
              <b className={`text-team-${item.event.target}`}>
                0{item.event.target}
              </b>
            </span>
            <time>
              {new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })}
            </time>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [settings, setSettings] = useState(initial);
  const [revision, setRevision] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [paused, setPaused] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [bot, setBot] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [lastShot, setLastShot] = useState(0);
  const shotRef = useRef(0);
  const { state, status, error, setError, feed, send } = useSession(
    settings,
    revision,
  );
  const connected = status === "connected";
  const player = settings.role === "player";
  const own = state?.tanks.find((t) => t.id === settings.tankId);
  const enemy = state?.tanks.find((t) => t.id !== settings.tankId);
  const enabled =
    connected &&
    player &&
    canDrive(state, settings.tankId) &&
    !paused &&
    !showSettings &&
    !showHelp;
  const fireReady =
    enabled &&
    (state?.status === "lobby" || (own?.ammo ?? 0) > 0) &&
    now - lastShot >= 1000;
  const fire = () => {
    if (
      !enabled ||
      Date.now() - shotRef.current < 1000 ||
      (state?.status !== "lobby" && !own?.ammo)
    )
      return;
    if (send({ type: "fire" })) {
      shotRef.current = Date.now();
      setLastShot(shotRef.current);
    }
  };
  const controls = useControls(enabled, send, fire, state?.status);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    demoArena.botEnabled = bot;
  }, [bot]);
  const swapRole = (role: ConnectionSettings["role"]) => {
    controls.stop();
    setPaused(false);
    setResetConfirm(false);
    setSettings((s) => ({ ...s, role }));
  };
  const fullScreen = () => {
    const operation = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    operation?.catch(() =>
      setError("当前浏览器不支持全屏，可使用浏览器的全屏功能"),
    );
  };
  const cooldown = Math.max(0, 1000 - (now - lastShot));
  const stage = state?.status || "lobby";
  const locked = !connected || stage === "countdown" || stage === "ended";
  const startReady =
    connected &&
    stage === "lobby" &&
    !!state?.tanks.every((t) => t.online && t.player);
  const togglePause = () => {
    controls.stop();
    setPaused((p) => !p);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a href="#" className="brand" aria-label="Tank Arena 首页">
          <span className="brand-mark">
            <Crosshair size={23} />
          </span>
          <span>
            TANK<span className="brand-light">ARENA</span>
            <small>LOCAL MULTIPLAYER COMBAT</small>
          </span>
        </a>
        <nav aria-label="主导航">
          <button
            className={player ? "selected" : ""}
            onClick={() => swapRole("player")}
          >
            <Gamepad2 size={17} />
            驾驶控制
          </button>
          <button
            className={!player ? "selected" : ""}
            onClick={() => swapRole("spectator")}
          >
            <Trophy size={17} />
            观战计分
          </button>
        </nav>
        <div className="header-tools">
          <span className={`connection-badge ${connected ? "good" : "bad"}`}>
            {connected ? <Wifi size={15} /> : <WifiOff size={15} />}
            {statuses[status]}
          </span>
          {!settings.demo && (
            <a
              href="#spectator"
              target="_blank"
              rel="noopener noreferrer"
              className="icon-button"
              aria-label="新标签页打开计分板"
              title="新标签页打开计分板（保留当前玩家连接）"
            >
              <ExternalLink size={17} />
            </a>
          )}
          <button
            className="icon-button"
            aria-label="操作帮助"
            onClick={() => {
              controls.stop();
              setShowHelp(true);
            }}
          >
            <CircleHelp size={19} />
          </button>
          <button
            className="icon-button"
            aria-label="连接设置"
            onClick={() => {
              controls.stop();
              setShowSettings(true);
            }}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>

      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">
              <span /> COMMAND CENTER{" "}
              <span className="muted">/ {player ? "PILOT" : "SPECTATOR"}</span>
            </div>
            <h1>{player ? "准备好，进入战场。" : "每一发，都改变战局。"}</h1>
            <p>
              {player
                ? "掌控履带，转动炮塔。下一次命中，由你决定。"
                : "实时关注双方战况，掌握比赛的每一个转折。"}
            </p>
          </div>
          <button
            className="secondary small"
            onClick={() => {
              controls.stop();
              setShowSettings(true);
            }}
          >
            <span className={`mode-dot ${settings.demo ? "" : "real"}`} />
            {settings.demo ? "模拟演练" : "实机连接"}
            <ChevronRight size={15} />
          </button>
        </div>
        <div className={`environment-note ${settings.demo ? "" : "live-note"}`}>
          <span>
            <Radio size={15} />
            <b>{settings.demo ? "模拟模式" : "真实服务器"}</b>
            {settings.demo
              ? "本页使用假数据，不会控制实体坦克。可直接练习操作，或切换到观战页开始比赛。"
              : `${settings.server} · 所有比赛数据由服务器提供`}
          </span>
          {settings.demo && (
            <label className="bot-toggle">
              <input
                type="checkbox"
                checked={bot}
                onChange={(e) => setBot(e.target.checked)}
              />
              自动对手
            </label>
          )}
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="关闭提示" onClick={() => setError("")}>
              <X size={17} />
            </button>
          </div>
        )}
        {!connected && (
          <div className="error-banner connection-alert" role="status">
            <span>
              {status === "reconnecting"
                ? "连接中断，驾驶已停止；每秒尝试重连。"
                : "等待连接和服务器状态，驾驶暂不可用。"}
            </span>
            <button onClick={() => setRevision((r) => r + 1)}>重新连接</button>
          </div>
        )}

        <section className={`match-strip ${stage}`} aria-label="比赛状态">
          <div className="match-phase">
            <span className="live-dot" />
            <div>
              <span className="eyebrow">
                {stage === "lobby" ? "PRACTICE SESSION" : "MATCH / 01"}
              </span>
              <strong>{phases[stage]}</strong>
            </div>
          </div>
          <div className="score-line">
            <span className="team-label text-team-1">TANK 01</span>
            <b>{state?.tanks.find((t) => t.id === 1)?.kills ?? "—"}</b>
            <span className="score-divider">:</span>
            <b>{state?.tanks.find((t) => t.id === 2)?.kills ?? "—"}</b>
            <span className="team-label text-team-2">TANK 02</span>
          </div>
          <div className="match-time">
            <strong>
              {stage === "lobby" ? "∞" : formatTime(state?.time_left_ms ?? 0)}
            </strong>
            <span>
              {stage === "lobby"
                ? "自由练习 · 不消耗弹药"
                : "先达 5 杀 / 限时 3 分钟"}
            </span>
          </div>
        </section>

        {stage === "ended" && (
          <div className="result-banner" role="status">
            <Trophy size={26} />
            <div>
              <strong>
                {state?.winner
                  ? `TANK 0${state.winner} 赢得比赛`
                  : "势均力敌，本局平局"}
              </strong>
              <p>比赛已结束，坦克控制已锁定。请在观战页重置下一局。</p>
            </div>
          </div>
        )}
        {stage === "countdown" && (
          <div className="countdown-banner" role="status">
            准备交战 <b>{Math.ceil((state?.time_left_ms ?? 0) / 1000)}</b>{" "}
            <span>倒计时期间控制已锁定</span>
          </div>
        )}

        {player ? (
          <div className="pilot-grid">
            <div className="left-column">
              {own ? (
                <TankCard tank={own} yours locked={locked} />
              ) : (
                <div className="panel loading">等待坦克数据…</div>
              )}
              <section className="drive-panel panel">
                <div className="section-label">
                  <span>
                    <Gamepad2 size={16} />
                    履带控制
                  </span>
                  <span className="mono">W A S D</span>
                </div>
                <div className="drive-layout">
                  <div className="d-pad">
                    {[
                      ["KeyW", "W", ArrowUp],
                      ["KeyA", "A", ArrowLeft],
                      ["KeyS", "S", ArrowDown],
                      ["KeyD", "D", ArrowRight],
                    ].map(([code, label, Icon]) => {
                      const KeyIcon = Icon as typeof ArrowUp;
                      return (
                        <button
                          key={String(code)}
                          className={`pad-key ${String(label).toLowerCase()}`}
                          aria-label={`${label} ${label === "W" ? "前进" : label === "S" ? "后退" : label === "A" ? "左转" : "右转"}`}
                          disabled={!enabled}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            controls.setKey(String(code), true);
                          }}
                          onPointerUp={() =>
                            controls.setKey(String(code), false)
                          }
                          onPointerCancel={controls.stop}
                          onLostPointerCapture={() =>
                            controls.setKey(String(code), false)
                          }
                        >
                          <KeyIcon size={15} />
                          <span>{String(label)}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="track-values">
                    <span>
                      LEFT <b>{controls.drive.left}</b>
                    </span>
                    <span>
                      RIGHT <b>{controls.drive.right}</b>
                    </span>
                  </div>
                </div>
                <p className="hint">按住方向键驾驶，松开即停止</p>
                <button
                  className={`stop-button ${paused ? "resume" : ""}`}
                  onClick={togglePause}
                  disabled={!connected}
                >
                  {paused ? <Play size={15} /> : <Pause size={15} />}
                  {paused ? "恢复控制" : "暂停驾驶 / 停车"}
                </button>
              </section>
            </div>
            <section className="aim-panel panel">
              <div className="section-label">
                <span>
                  <Crosshair size={17} />
                  炮塔瞄准
                </span>
                <span className="mono">TURRET CONTROL</span>
              </div>
              <div
                className="aim-area"
                onPointerMove={(e) => {
                  if (enabled && e.pointerType === "mouse") {
                    const box = e.currentTarget.getBoundingClientRect();
                    controls.setAngle(
                      ((e.clientX - box.left) / box.width) * 180 - 90,
                    );
                  }
                }}
                onClick={fire}
              >
                <div className="aim-grid" />
                <span className="compass north">FRONT / 0°</span>
                <span className="compass west">−90°</span>
                <span className="compass east">+90°</span>
                <div className="radar">
                  <div className="radar-inner" />
                  <div
                    className="aim-line"
                    style={{ transform: `rotate(${controls.drive.turret}deg)` }}
                  />
                  <TankGlyph
                    angle={controls.drive.turret}
                    className="hero-tank"
                  />
                </div>
                <div className="aim-tag">
                  <span className={`status-square ${enabled ? "" : "off"}`} />
                  {!connected
                    ? "等待连接"
                    : paused
                      ? "控制已暂停"
                      : !own?.alive
                        ? `复活中 · ${Math.ceil((own?.respawn_ms ?? 0) / 1000)}s`
                        : enabled
                          ? "瞄准系统就绪"
                          : "控制已锁定"}
                </div>
                {now - lastShot < 220 && <div className="shot-flash" />}
              </div>
              <div className="angle-control">
                <div>
                  <span>炮塔角度</span>
                  <strong>
                    {controls.drive.turret > 0 ? "+" : ""}
                    {controls.drive.turret}°
                  </strong>
                </div>
                <input
                  aria-label="炮塔角度"
                  type="range"
                  min="-90"
                  max="90"
                  value={controls.drive.turret}
                  disabled={!enabled}
                  onChange={(e) => controls.setAngle(Number(e.target.value))}
                />
                <span>左</span>
                <span>右</span>
              </div>
              <button
                className="fire-button"
                disabled={!fireReady}
                onClick={fire}
              >
                <Crosshair size={21} />
                <span>
                  {cooldown > 0
                    ? `装填中 ${(cooldown / 1000).toFixed(1)}s`
                    : "开火"}
                  <small>{!own?.alive ? "等待复活" : "FIRE CANNON"}</small>
                </span>
                <kbd>SPACE</kbd>
              </button>
              <p className="hint aim-hint">
                移动鼠标瞄准 · 点击瞄准区或按空格开火
              </p>
              <div className="aim-footnote">
                <Shield size={12} />
                这是炮塔角度示意，不是摄像头画面或坦克定位。
              </div>
            </section>
            <div className="right-column">
              {enemy && <TankCard tank={enemy} yours={false} locked={locked} />}
              <Feed items={feed} />
            </div>
          </div>
        ) : (
          <>
            <div className="spectator-grid">
              {state?.tanks.map((tank) => (
                <TankCard
                  key={tank.id}
                  tank={tank}
                  yours={false}
                  large
                  locked={locked}
                />
              ))}
              <div className="versus">VS</div>
            </div>
            <div className="spectator-bottom">
              <section className="match-management panel">
                <div className="section-label">
                  <span>
                    <Gauge size={17} />
                    比赛管理
                  </span>
                  <button
                    className="icon-button"
                    aria-label="全屏观战"
                    onClick={fullScreen}
                  >
                    <Maximize2 size={16} />
                  </button>
                </div>
                <h2>
                  {stage === "lobby"
                    ? "双方就绪，即刻开战。"
                    : stage === "running"
                      ? "交火进行中。"
                      : stage === "ended"
                        ? "准备下一场对决。"
                        : "战斗即将开始。"}
                </h2>
                <p>3 秒准备 · 5 点血量 · 5 秒复活 · 先到 5 杀获胜</p>
                <div className="management-buttons">
                  <button
                    className="primary"
                    disabled={!startReady}
                    onClick={() => {
                      setResetConfirm(false);
                      send({ type: "game", action: "start" });
                    }}
                  >
                    <Play size={17} />
                    开始比赛
                  </button>
                  <button
                    className="secondary"
                    disabled={!connected}
                    onClick={() => setResetConfirm(true)}
                  >
                    <RotateCcw size={16} />
                    重置比赛
                  </button>
                  {settings.demo && (
                    <button
                      className="text-button"
                      onClick={() => swapRole("player")}
                    >
                      返回驾驶 <ChevronRight size={16} />
                    </button>
                  )}
                </div>
                {!startReady && stage === "lobby" && (
                  <p className="hint">需要两台坦克在线，且各有一名玩家。</p>
                )}
              </section>
              <Feed items={feed} />
            </div>
          </>
        )}

        <footer>
          <span>
            <Shield size={13} /> 切出窗口自动停车
          </span>
          <span>20 Hz 控制 · 1 s 开火间隔 · 3 s 弹药恢复</span>
          <span className="footer-brand">
            TANK ARENA <b> / </b> 01
          </span>
        </footer>
      </main>
      {showSettings && (
        <SettingsDialog
          settings={settings}
          close={() => setShowSettings(false)}
          apply={(value) => {
            controls.stop();
            setPaused(false);
            setSettings(value);
            setShowSettings(false);
          }}
        />
      )}
      {showHelp && (
        <Dialog title="驾驶员操作指南" close={() => setShowHelp(false)}>
          <div className="help-grid">
            <span>
              <kbd>W</kbd>
              <kbd>S</kbd>
            </span>
            <p>前进 / 后退</p>
            <span>
              <kbd>A</kbd>
              <kbd>D</kbd>
            </span>
            <p>原地左转 / 右转</p>
            <span>
              <kbd>鼠标</kbd>
            </span>
            <p>在瞄准区移动以转动炮塔</p>
            <span>
              <kbd>SPACE</kbd>
            </span>
            <p>开火，每发间隔 1 秒</p>
          </div>
          <p className="dialog-note">
            切出窗口会清除按键并发送停车指令。倒计时、死亡、比赛结束或断线期间无法驾驶。实物端仍需实现
            300 ms 超时停车。
          </p>
          <p className="dialog-note">
            模拟模式：两名玩家自动就绪，允许的射击会模拟命中，不模拟红外、位置或障碍。切换观战页可以开始和重置比赛；每个浏览器标签页的模拟比赛彼此独立。
          </p>
          <button className="primary full" onClick={() => setShowHelp(false)}>
            <Check size={16} />
            明白，准备出发
          </button>
        </Dialog>
      )}
      {resetConfirm && (
        <Dialog title="重置这场比赛？" close={() => setResetConfirm(false)}>
          <p className="dialog-note">
            当前比分、血量和弹药将重置，所有坦克返回自由练习阶段。
          </p>
          <div className="management-buttons">
            <button
              className="secondary"
              onClick={() => setResetConfirm(false)}
            >
              取消
            </button>
            <button
              className="primary"
              onClick={() => {
                send({ type: "game", action: "reset" });
                setResetConfirm(false);
              }}
            >
              确认重置
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function SettingsDialog({
  settings,
  close,
  apply,
}: {
  settings: ConnectionSettings;
  close: () => void;
  apply: (s: ConnectionSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState("");
  return (
    <Dialog title="连接你的战场" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            if (!draft.demo) socketUrl(draft.server, draft.role);
            apply({ ...draft, name: draft.name.trim() || "Player" });
          } catch {
            setError("请输入有效地址，例如 ws://10.42.0.1:8000");
          }
        }}
      >
        <div className="mode-choices">
          <button
            type="button"
            className={draft.demo ? "active" : ""}
            onClick={() => setDraft((d) => ({ ...d, demo: true }))}
          >
            <Target size={20} />
            <b>模拟演练</b>
            <small>无需硬件，直接体验</small>
          </button>
          <button
            type="button"
            className={!draft.demo ? "active" : ""}
            onClick={() => setDraft((d) => ({ ...d, demo: false }))}
          >
            <Wifi size={20} />
            <b>真实服务器</b>
            <small>连接本地 Wi-Fi 战场</small>
          </button>
        </div>
        {!draft.demo && (
          <label className="field">
            服务器地址
            <input
              autoComplete="off"
              value={draft.server}
              onChange={(e) =>
                setDraft((d) => ({ ...d, server: e.target.value }))
              }
              placeholder="ws://10.42.0.1:8000"
              required
            />
            <small>
              先连接 tank-arena Wi-Fi；网页会自动选择对应的连接路径。
            </small>
          </label>
        )}
        <label className="field">
          进入方式
          <select
            value={draft.role}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                role: e.target.value as ConnectionSettings["role"],
              }))
            }
          >
            <option value="player">玩家 · 驾驶坦克</option>
            <option value="spectator">观众 · 计分与比赛管理</option>
          </select>
        </label>
        {draft.role === "player" && (
          <div className="form-row">
            <label className="field">
              玩家名字
              <input
                value={draft.name}
                maxLength={24}
                required
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
              />
            </label>
            <label className="field">
              坦克编号
              <select
                value={draft.tankId}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    tankId: Number(e.target.value) as 1 | 2,
                  }))
                }
              >
                <option value="1">TANK 01</option>
                <option value="2">TANK 02</option>
              </select>
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <p className="dialog-note">
          {draft.demo
            ? "演练数据只存在当前标签页，刷新后重新开始。后端就绪后，在这里切换连接即可。"
            : "真实模式不会使用假数据补位。同一标签页切换观众身份会释放玩家连接；比赛管理请另开计分页，并在新页面选择真实服务器。"}
        </p>
        <button type="submit" className="primary full">
          <Radio size={17} />
          {draft.demo ? "进入模拟战场" : "连接服务器"}
        </button>
      </form>
    </Dialog>
  );
}
