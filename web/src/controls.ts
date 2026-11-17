import type { Drive } from "./protocol";

export const movementKeys = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowLeft",
  "ArrowDown",
  "ArrowRight",
]);
export function driveFromKeys(keys: Set<string>, turret: number): Drive {
  const forward =
    Number(keys.has("KeyW") || keys.has("ArrowUp")) -
    Number(keys.has("KeyS") || keys.has("ArrowDown"));
  const turn =
    Number(keys.has("KeyD") || keys.has("ArrowRight")) -
    Number(keys.has("KeyA") || keys.has("ArrowLeft"));
  const limit = (n: number) => Math.max(-100, Math.min(100, n));
  return {
    type: "drive",
    left: limit((forward + turn) * 60),
    right: limit((forward - turn) * 60),
    turret,
  };
}
export function isEditing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input, select, textarea, [contenteditable="true"]')
  );
}
