// Language safety bounds. These are enforced by the core (lexer, parser, checker, interpreter, VM), never by
// the UI. The reference interpreter and the VM enforce the *semantic* limits (iterations, user-function calls,
// draws, scene size, string length) identically, so a program that hits one fails the same way in both. The
// VM's call-depth limit and the interpreter's host-stack needs are enforced statically by the checker (S004,
// S005), so neither rejects a checked program at run time for depth. Fuel is a machine limit kept separately
// by each executor: the VM counts instructions (R006), the reference interpreter counts evaluation steps
// (R014). Each has a per-frame and a whole-run budget, so the total work of any run is bounded. A run stopped
// by fuel is reported as a resource limit of that executor, never as a divergence.
export interface Limits {
  maxSourceChars: number;
  maxTokens: number;
  maxAstNodes: number;
  maxSymbols: number;
  maxStringLength: number;
  maxListLiteral: number;
  maxFixtureLength: number;
  maxIterationsPerFrame: number;
  maxDrawsPerFrame: number;
  maxGroupDepth: number;
  maxFrames: number;
  maxCanvas: number;
  maxErrors: number;
  maxExprDepth: number;
  /** Semantic, both executors: user-function calls per frame (R013). */
  maxCallsPerFrame: number;
  /** Semantic, both executors: scene size units per frame and per run (R005). A shape costs 1, a path 1 + its
   * points, a text 1 + one per 16 characters. */
  maxSceneUnitsPerFrame: number;
  maxSceneUnits: number;
  /** Static (checker, S005): the deepest chain of nested syntax across calls the reference interpreter may need. */
  maxNestingWeight: number;
  /** VM-only. */
  fuelPerFrame: number;
  fuelPerRun: number;
  /** Reference-interpreter-only evaluation steps (R014). */
  refFuelPerFrame: number;
  refFuelPerRun: number;
  maxStack: number;
  maxCallDepth: number;
  maxBytecodeInstrs: number;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxSourceChars: 64_000,
  maxTokens: 20_000,
  maxAstNodes: 20_000,
  maxSymbols: 2_000,
  maxStringLength: 1_000,
  maxListLiteral: 1_000,
  maxFixtureLength: 10_000,
  maxIterationsPerFrame: 100_000,
  maxDrawsPerFrame: 10_000,
  maxGroupDepth: 32,
  maxFrames: 240,
  maxCanvas: 4096,
  maxErrors: 50,
  maxExprDepth: 200,
  maxCallsPerFrame: 100_000,
  maxSceneUnitsPerFrame: 20_000,
  maxSceneUnits: 1_000_000,
  maxNestingWeight: 1_200,
  fuelPerFrame: 20_000_000,
  fuelPerRun: 200_000_000,
  refFuelPerFrame: 20_000_000,
  refFuelPerRun: 200_000_000,
  maxStack: 1_024,
  maxCallDepth: 64,
  maxBytecodeInstrs: 200_000,
});
