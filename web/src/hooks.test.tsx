// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useControls } from "./hooks";
import type { ClientMessage } from "./protocol";

let root: Root;
let host: HTMLDivElement;
const send = vi.fn((_message: ClientMessage) => true);
const fire = vi.fn();
function Harness({ enabled = true }: { enabled?: boolean }) {
  useControls(enabled, send, fire);
  return (
    <>
      <button>Navigation</button>
      <input aria-label="Name" />
    </>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  send.mockClear();
  fire.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function key(code: string, type = "keydown", target: EventTarget = window) {
  act(() =>
    target.dispatchEvent(
      new KeyboardEvent(type, { code, bubbles: true, cancelable: true }),
    ),
  );
}
const last = () => send.mock.calls.at(-1)?.[0];
describe("driver safety and timing", () => {
  it("sends repeated drive at 20 Hz even when input does not change", () => {
    key("KeyW");
    act(() => vi.advanceTimersByTime(1000));
    expect(send).toHaveBeenCalledTimes(20);
    expect(last()).toEqual({ type: "drive", left: 60, right: 60, turret: 0 });
  });
  it("stops immediately on key release and window blur, without resuming stale input", () => {
    key("KeyW");
    act(() => vi.advanceTimersByTime(50));
    key("KeyW", "keyup");
    expect(last()).toMatchObject({ left: 0, right: 0 });
    key("KeyW");
    act(() => vi.advanceTimersByTime(50));
    act(() => window.dispatchEvent(new Event("blur")));
    expect(last()).toMatchObject({ left: 0, right: 0 });
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => vi.advanceTimersByTime(50));
    expect(last()).toMatchObject({ left: 0, right: 0 });
  });
  it("allows movement after clicking navigation but ignores typing in forms", () => {
    key("KeyW", "keydown", host.querySelector("button")!);
    act(() => vi.advanceTimersByTime(50));
    expect(last()).toMatchObject({ left: 60, right: 60 });
    act(() => host.querySelector("input")!.focus());
    expect(last()).toMatchObject({ left: 0, right: 0 });
    key("KeyW", "keydown", host.querySelector("input")!);
    act(() => vi.advanceTimersByTime(50));
    expect(last()).toMatchObject({ left: 0, right: 0 });
  });
  it("sends zero on locking controls and stops subsequent movement", () => {
    key("KeyW");
    act(() => vi.advanceTimersByTime(50));
    act(() => root.render(<Harness enabled={false} />));
    expect(last()).toMatchObject({ left: 0, right: 0 });
    const count = send.mock.calls.length;
    key("KeyW");
    act(() => vi.advanceTimersByTime(1000));
    expect(send).toHaveBeenCalledTimes(count);
  });
  it("fires on space once, without hijacking input fields", () => {
    key("Space");
    expect(fire).toHaveBeenCalledTimes(1);
    key("Space", "keydown", host.querySelector("input")!);
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
