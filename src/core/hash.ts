// One SHA-256 for the whole checker, shared by Node (server, CLI, tests) and the browser (static demo build).
// It is the dependency-free implementation the Compiler wing already ships; wings/compiler/tests cross-check it
// against node:crypto, and tests/hash.test.ts does the same for the strings this package hashes.
import { sha256 } from '../../wings/compiler/core/sha256.ts';

export const sha256Hex = (s: string): string => sha256(s);
