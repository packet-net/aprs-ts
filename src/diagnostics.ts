import { DIAGNOSTIC_MEANINGS, isTolerable, TOLERABLE_CODES, type DiagnosticCode, type TolerableCode } from './codes.js';

/** How serious a diagnostic is. */
export type Severity = 'info' | 'warning' | 'error';

/**
 * Something the decoder noticed about a packet: a defect it tolerated (`warning`), one that
 * stopped it (`error`), or a remark (`info`, e.g. an obsolete format).
 */
export interface Diagnostic {
  readonly severity: Severity;
  readonly code: DiagnosticCode;
  /** A plain ASCII description. */
  readonly message: string;
}

/** Makes a diagnostic with the standard description of its code. */
export function diagnostic(severity: Severity, code: DiagnosticCode, detail?: string): Diagnostic {
  const meaning = DIAGNOSTIC_MEANINGS[code];
  return { severity, code, message: detail ? `${meaning} ${detail}` : meaning };
}

/** Formats a diagnostic as `severity:code`, the form the conformance vectors use. */
export function formatDiagnostic(d: Diagnostic): string {
  return `${d.severity}:${d.code}`;
}

/**
 * Which defects the decoder tolerates. A lenient decoder (the default) tolerates every tolerable
 * code, with a warning; a strict one tolerates none, and rejects a packet at the first defect.
 * Each code can be switched on or off by itself.
 *
 * ```ts
 * ParseOptions.lenient;                                  // the default
 * ParseOptions.strict;
 * ParseOptions.lenient.without('trailing-line-break');   // lenient, except for that one
 * ParseOptions.strict.with('lowercase-hemisphere');      // strict, except for that one
 * ```
 */
export class ParseOptions {
  /** Tolerates every tolerable defect, with a warning. */
  static readonly lenient: ParseOptions = new ParseOptions(new Set(TOLERABLE_CODES));
  /** Tolerates nothing. */
  static readonly strict: ParseOptions = new ParseOptions(new Set());

  private readonly tolerated: ReadonlySet<TolerableCode>;

  private constructor(tolerated: ReadonlySet<TolerableCode>) {
    this.tolerated = tolerated;
  }

  /** Options that tolerate exactly these codes. */
  static tolerating(codes: Iterable<TolerableCode>): ParseOptions {
    const set = new Set<TolerableCode>();
    for (const code of codes) {
      if (!isTolerable(code)) throw new RangeError(`${String(code)} is not a tolerable code`);
      set.add(code);
    }
    return new ParseOptions(set);
  }

  /** These options, also tolerating `code`. */
  with(code: TolerableCode): ParseOptions {
    if (!isTolerable(code)) throw new RangeError(`${String(code)} is not a tolerable code`);
    const set = new Set(this.tolerated);
    set.add(code);
    return new ParseOptions(set);
  }

  /** These options, no longer tolerating `code`. */
  without(code: TolerableCode): ParseOptions {
    const set = new Set(this.tolerated);
    set.delete(code);
    return new ParseOptions(set);
  }

  /** Whether `code` is tolerated. */
  tolerates(code: DiagnosticCode): boolean {
    return this.tolerated.has(code as TolerableCode);
  }

  /** The tolerated codes. */
  get toleratedCodes(): readonly TolerableCode[] {
    return [...this.tolerated];
  }
}
