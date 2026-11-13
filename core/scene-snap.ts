// Snapshot support for SceneBuilder (the debugger rewinds and fast-forwards by restoring these). Commands are
// immutable, so a snapshot copies the array of references, not the commands. Restoring must replace the array
// (not truncate it): a restore can move forward in time to a later checkpoint.
import type { DrawCmd, SceneBuilder } from './scene.ts';
export interface SceneSnap { cmds: DrawCmd[]; stack: unknown[]; units: number }
export function snapScene(s: SceneBuilder): SceneSnap {
  return { cmds: s.cmds.slice(), stack: (s as unknown as { stack: unknown[] }).stack.slice(), units: s.units };
}
export function restoreScene(s: SceneBuilder, snap: SceneSnap): void {
  s.cmds = snap.cmds.slice();
  s.units = snap.units;
  (s as unknown as { stack: unknown[] }).stack = snap.stack.slice();
}
