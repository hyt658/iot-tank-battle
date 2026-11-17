import { useCallback, useEffect, useRef, useState } from "react";
import { openDemo, openSocket } from "./connection";
import type { Connection } from "./connection";
import { driveFromKeys, isEditing, movementKeys } from "./controls";
import type {
  BattleEvent,
  ClientMessage,
  ConnectionSettings,
  ConnectionStatus,
  Drive,
  StateMessage,
} from "./protocol";

export interface FeedItem {
  id: number;
  at: number;
  event: BattleEvent;
}
export function useSession(settings: ConnectionSettings, revision: number) {
  const [state, setState] = useState<StateMessage | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState("");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const connection = useRef<Connection | null>(null);
  const sessionSettings = useRef(settings);
  const count = useRef(0);
  useEffect(() => {
    let active = true;
    sessionSettings.current = settings;
    setState(null);
    setStatus("connecting");
    setError("");
    setFeed([]);
    try {
      const conn = (settings.demo ? openDemo : openSocket)(settings, {
        status: (status) => {
          if (active) setStatus(status);
        },
        message: (message) => {
          if (!active) return;
          if (message.type === "state") setState(message);
          if (message.type === "error") setError(message.message);
          if (message.type === "event")
            setFeed((items) =>
              [
                { id: ++count.current, at: Date.now(), event: message },
                ...items,
              ].slice(0, 30),
            );
        },
      });
      connection.current = conn;
      return () => {
        active = false;
        if (settings.role === "player")
          conn.send({ type: "drive", left: 0, right: 0, turret: 0 });
        conn.close();
        connection.current = null;
      };
    } catch (error) {
      setError(error instanceof Error ? error.message : "连接失败");
      setStatus("disconnected");
    }
    return () => {
      active = false;
    };
  }, [settings, revision]);
  const send = useCallback(
    (message: ClientMessage) => connection.current?.send(message) ?? false,
    [],
  );
  const current = sessionSettings.current === settings;
  return {
    state: current ? state : null,
    status: current ? status : ("connecting" as ConnectionStatus),
    error,
    setError,
    feed: current ? feed : [],
    send,
  };
}

export function useControls(
  enabled: boolean,
  send: (m: ClientMessage) => boolean,
  fire: () => void,
) {
  const [drive, setDrive] = useState<Drive>({
    type: "drive",
    left: 0,
    right: 0,
    turret: 0,
  });
  const keys = useRef(new Set<string>());
  const angle = useRef(0);
  const focused = useRef(true);
  const fireRef = useRef(fire);
  fireRef.current = fire;
  const stop = useCallback(() => {
    keys.current.clear();
    const stopped: Drive = {
      type: "drive",
      left: 0,
      right: 0,
      turret: angle.current,
    };
    send(stopped);
    setDrive(stopped);
  }, [send]);
  const setAngle = useCallback((value: number) => {
    angle.current = Math.round(Math.max(-90, Math.min(90, value)));
    setDrive((d) => ({ ...d, turret: angle.current }));
  }, []);
  const setKey = useCallback(
    (key: string, down: boolean) => {
      if (!enabled) return;
      focused.current = true;
      if (down) keys.current.add(key);
      else keys.current.delete(key);
      const value = driveFromKeys(keys.current, angle.current);
      send(value);
      setDrive(value);
    },
    [enabled, send],
  );
  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }
    const down = (event: KeyboardEvent) => {
      if (isEditing(event.target)) return;
      if (movementKeys.has(event.code)) {
        event.preventDefault();
        focused.current = true;
        keys.current.add(event.code);
      }
      if (
        event.code === "Space" &&
        !(event.target instanceof HTMLElement && event.target.closest("button"))
      ) {
        event.preventDefault();
        if (!event.repeat) fireRef.current();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (movementKeys.has(event.code)) {
        keys.current.delete(event.code);
        const value = driveFromKeys(keys.current, angle.current);
        send(value);
        setDrive(value);
      }
    };
    const blur = () => {
      focused.current = false;
      stop();
    };
    const focus = () => {
      keys.current.clear();
      focused.current = true;
    };
    const visibility = () => {
      if (document.hidden) blur();
      else focus();
    };
    const focusIn = (event: FocusEvent) => {
      if (isEditing(event.target)) stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    window.addEventListener("pagehide", blur);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("focusin", focusIn);
    const timer = setInterval(() => {
      const value = driveFromKeys(
        focused.current ? keys.current : new Set(),
        angle.current,
      );
      send(value);
      setDrive((previous) =>
        previous.left === value.left &&
        previous.right === value.right &&
        previous.turret === value.turret
          ? previous
          : value,
      );
    }, 50);
    return () => {
      clearInterval(timer);
      stop();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pagehide", blur);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("focusin", focusIn);
    };
  }, [enabled, send, stop]);
  return { drive, stop, setAngle, setKey };
}
