// Snapshot support for SceneBuilder (the debugger rewinds by restoring these).
import { SceneBuilder } from './scene.ts';
export interface SceneSnap { n: number; stack: unknown }
export function snapScene(s: SceneBuilder): SceneSnap {
  return { n: s.cmds.length, stack: (s as unknown as { stack: unknown[] }).stack.slice() };
}
export function restoreScene(s: SceneBuilder, snap: SceneSnap): void {
  s.cmds.length = snap.n;
  (s as unknown as { stack: unknown[] }).stack = (snap.stack as unknown[]).slice();
}
