// Driving feel only. Motor calibration belongs to the tank firmware.
export const DRIVE = Object.freeze({
  start: 25,
  full: 100,
  slow: 35,
  pivot: 45,
  rampMs: 800,
  innerRatio: 0.55,
});

export function createDriveController() {
  let direction = 0;
  let updatedAt = 0;
  let speed = DRIVE.start;
  return {
    reset() {
      direction = 0;
      updatedAt = 0;
      speed = DRIVE.start;
    },
    update(forward, turn, slow, now) {
      if (forward !== direction) {
        direction = forward;
        speed = DRIVE.start;
      } else if (forward) {
        speed +=
          (Math.max(0, now - updatedAt) * (DRIVE.full - DRIVE.start)) /
          DRIVE.rampMs;
      }
      updatedAt = now;
      if (!forward) {
        const speed = slow ? DRIVE.start : DRIVE.pivot;
        return { left: turn * speed || 0, right: -turn * speed || 0 };
      }
      // Releasing Shift ramps up from slow gear instead of jumping to full speed.
      speed = Math.min(slow ? DRIVE.slow : DRIVE.full, speed);
      let left = forward * speed;
      let right = forward * speed;
      // Keep both tracks moving during a turn, including when reversing.
      if (turn * forward > 0) right *= DRIVE.innerRatio;
      if (turn * forward < 0) left *= DRIVE.innerRatio;
      return { left: Math.round(left) || 0, right: Math.round(right) || 0 };
    },
  };
}
