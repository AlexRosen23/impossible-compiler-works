// Language safety bounds. These are enforced by the core (lexer, parser, checker, interpreter, VM), never by
// the UI. The reference interpreter and the VM enforce the *semantic* limits (iterations, draws, string length)
// identically, so a program that hits one fails the same way in both. Fuel and stack depth are VM-only
// machine limits, set high enough that the semantic limits trip first for any checked program.
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
  /** VM-only. */
  fuelPerFrame: number;
  maxStack: number;
  maxCallDepth: number;
  maxBytecodeInstrs: number;
  /** Trace capture (debugger) bounds. */
  maxTraceSteps: number;
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
  fuelPerFrame: 20_000_000,
  maxStack: 1_024,
  maxCallDepth: 64,
  maxBytecodeInstrs: 200_000,
  maxTraceSteps: 2_000_000,
});
