// State shared by the information field decoders: the options, the diagnostics so far, and how
// a defect is tolerated or rejected.

import { decodeUtf8Binary, isAscii } from '../bytes.js';
import type { DiagnosticCode } from '../codes.js';
import { diagnostic, type Diagnostic, type ParseOptions } from '../diagnostics.js';

/** Thrown inside the decoders when the packet is rejected; caught at the top. */
export class Rejected {
  constructor(readonly code: DiagnosticCode) {}
}

export class DecodeContext {
  readonly diagnostics: Diagnostic[] = [];
  private nonUtf8Reported = false;

  constructor(
    readonly options: ParseOptions,
    /** The destination address (Mic-E carries half its position there). */
    readonly destination: string,
  ) {}

  info(code: DiagnosticCode): void {
    this.diagnostics.push(diagnostic('info', code));
  }

  /** Rejects the packet: an error, then nothing more is decoded. */
  fail(code: DiagnosticCode): never {
    this.diagnostics.push(diagnostic('error', code));
    throw new Rejected(code);
  }

  /** A tolerable defect: a warning when tolerated, else the packet is rejected. */
  tolerate(code: DiagnosticCode): void {
    if (this.options.tolerates(code)) this.diagnostics.push(diagnostic('warning', code));
    else this.fail(code);
  }

  /**
   * A tolerable defect that a strict decoder reads differently rather than rejecting: returns
   * whether it is tolerated, with a warning if so.
   */
  allows(code: DiagnosticCode): boolean {
    if (!this.options.tolerates(code)) return false;
    this.diagnostics.push(diagnostic('warning', code));
    return true;
  }

  /**
   * Decodes a text field from its bytes (a binary string): UTF-8, or when it is not valid UTF-8,
   * the whole field as Latin-1 with one `non-utf8-text` warning for the packet. Then, last, the
   * text's control characters are judged: one `control-character-in-text` warning for the text
   * (`judgeControl` false for text that is data, which is not judged).
   */
  text(binary: string, judgeControl = true): string {
    let result = binary;
    if (!isAscii(binary)) {
      const decoded = decodeUtf8Binary(binary);
      if (decoded !== undefined) {
        result = decoded;
      } else if (!this.nonUtf8Reported) {
        this.nonUtf8Reported = true;
        this.tolerate('non-utf8-text');
      }
    }
    if (judgeControl) this.judgeControl(result);
    return result;
  }

  /** Judges a text's control characters: a byte below 0x20 or 0x7F, one warning for the text. */
  judgeControl(text: string): void {
    if (CONTROL_RE.test(text)) this.tolerate('control-character-in-text');
  }
}

/** A control character: below U+0020, or U+007F. */
const CONTROL_RE = /[\x00-\x1f\x7f]/;
