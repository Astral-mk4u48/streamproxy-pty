// Splits raw shell stdout into plain text and JSON blobs.
// Plain text goes straight to onText(), JSON gets buffered until it's
// complete then handed off to onJson().
//
// Uses bracket-counting to find JSON, with an ANSI state machine running
// alongside so color codes don't accidentally trigger the bracket counter.
// That state lives on the instance so node-pty splitting a sequence across
// two callbacks isn't a problem — we just pick up where we left off.
//
// Scans in 8k-char slices and yields between them so the extension host
// doesn't freeze up on massive payloads. Chunks queue up and drain one at
// a time so output order is always preserved.
//
// If destroy() fires while we're paused at a yield, the next iteration
// catches it, flushes whatever was buffered as plain text, and exits —
// nothing gets silently dropped.
//
// If the setImmediate yielding still isn't enough, the WebWorker path is
// the full fix:
//   1. Move this into its own worker bundle.
//   2. In pseudoterminal.ts replace `new StreamParser(...)` with a worker
//      that receives chunks via postMessage.
//   3. Worker posts { type: 'text'|'json', ... } messages back.
//   4. pseudoterminal.ts calls onText/onJson from onmessage.

import { randomBytes } from 'crypto';

export interface StreamParserCallbacks {
  onText: (chunk: string) => void;
  onJson: (id: string, payload: unknown) => void;
}

// Yield every 8192 chars. Big enough that normal output never hits it,
// small enough that a 10MB JSON blob yields a bunch of times instead of
// locking the UI for seconds.
const SLICE_CHARS = 8192;

const OPEN  = new Set(['{', '[']);
const CLOSE = new Map([['{', '}'], ['[', ']']]);

// Yield to the event loop every 8k chars so the extension host doesn't
// freeze up on massive payloads. setImmediate fires after I/O callbacks
// but before timers — responsive without busy-waiting.
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Track ANSI escape states across chunks so split sequences don't break
// our bracket matching. node-pty can deliver "ESC[32" in one callback
// and "m" in the next — keeping state on the instance means we always
// resume in the right place.
//
//  ESC Fe   — two-char: ESC + one byte 0x40–0x5F  (e.g. ESC M, ESC =)
//  CSI      — ESC [ ...params... finalByte (0x40–0x7E)
//  OSC      — ESC ] ...payload... BEL(0x07) or ST(ESC \)
//  DCS/PM/APC/SOS — ESC P/^/_/X ... payload ... ST
//  SS2/SS3  — ESC N / ESC O, consume exactly one following byte
type AnsiState =
  | 'none'        // not inside any escape sequence
  | 'esc'         // just saw ESC, waiting on the next byte to know what kind
  | 'csi'         // inside CSI (ESC [), waiting for the final byte
  | 'osc'         // inside OSC (ESC ]), waiting for BEL or ESC
  | 'osc_esc'     // inside OSC, saw ESC — next byte must be \ to close it
  | 'string'      // inside DCS/PM/APC/SOS, waiting for ESC
  | 'string_esc'  // inside one of those, saw ESC — next byte must be \
  | 'ss2ss3';     // SS2/SS3 — eat one more byte then done

export class StreamParser {
  // JSON bracket-counting state
  private textBuffer = '';
  private jsonBuffer = '';
  private depth      = 0;
  private inString   = false;  // inside a JSON string?
  private escape     = false;  // last char was a backslash escape?
  private openChar   = '';     // the { or [ that opened the current capture

  // ANSI state — on the instance so it survives chunk boundaries
  private ansiState: AnsiState = 'none';

  private destroyed = false;

  // Chunks queue here and drain one at a time so ordering is preserved
  // even when a single chunk spans multiple event-loop turns.
  private readonly queue: string[] = [];
  private draining = false;

  constructor(private readonly callbacks: StreamParserCallbacks) {}

  // Queue a chunk for parsing. Fires and forgets — shell.onData doesn't await.
  push(chunk: string): void {
    if (this.destroyed) { return; }
    this.queue.push(chunk);
    if (!this.draining) {
      this.draining = true;
      void this.drainQueue();
    }
  }

  // Bypass the parser entirely and emit straight to onText. Used for echoed
  // keystrokes — bytes the shell bounces back verbatim after the user types.
  // Because echoed output and real program output share the same onData stream
  // there's no structural way to tell them apart; we rely on the caller
  // (pseudoterminal.ts) to gate which path each chunk takes based on a short
  // echo-suppression window that opens on every handleInput write.
  //
  // Importantly, passthrough also resets any partial JSON capture that was
  // open. A stray `{` typed interactively must never contaminate the parser
  // state for the next real JSON blob that a program emits.
  passthrough(chunk: string): void {
    if (this.destroyed) { return; }

    // Discard any half-open JSON capture — it was started by an echoed opener
    // and will never get a matching closer from the same echo window.
    if (this.depth > 0) {
      this.callbacks.onText(this.jsonBuffer);
      this.jsonBuffer = '';
      this.depth      = 0;
      this.openChar   = '';
      this.inString   = false;
      this.escape     = false;
    }

    this.callbacks.onText(chunk);
  }

  // try/finally so draining always resets — if processChunk() ever throws,
  // we don't get stuck with draining=true and silently swallow every future push().
  private async drainQueue(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.destroyed) {
        const chunk = this.queue.shift()!;
        await this.processChunk(chunk);
      }
    } finally {
      this.draining = false;
    }
  }

  // Scan one chunk in SLICE_CHARS bursts. All the state that matters is on
  // `this`, so pausing mid-chunk for a yield is safe — we resume exactly
  // where we left off.
  private async processChunk(chunk: string): Promise<void> {
    // Use a run-start index instead of buf += ch on every iteration.
    // Keeps the hot path to pointer math; string copies only happen at flush boundaries.
    let runStart = 0;

    const appendToText = (end: number): void => {
      if (end > runStart) { this.textBuffer += chunk.slice(runStart, end); }
    };
    const appendToJson = (end: number): void => {
      if (end > runStart) { this.jsonBuffer += chunk.slice(runStart, end); }
    };

    let i = 0;
    let sinceYield = 0;

    for (; i < chunk.length; i++) {
      if (sinceYield >= SLICE_CHARS) {
        await yieldToEventLoop();
        sinceYield = 0;

        // Sanity check: if the terminal was closed while we were asleep,
        // drop out immediately. destroy() already cleared the buffers so
        // there's no point continuing — flush what we had and bail.
        if (this.destroyed) {
          if (i > runStart) { this.callbacks.onText(chunk.slice(runStart, i)); }
          return;
        }
      }
      sinceYield++;

      // Same check for the case where destroy() fired before we ever hit a yield.
      if (this.destroyed) {
        if (i > runStart) { this.callbacks.onText(chunk.slice(runStart, i)); }
        return;
      }

      const ch   = chunk[i];
      const code = chunk.charCodeAt(i);

      // We're inside an ANSI escape sequence — pass the bytes through to
      // whichever buffer is active (terminal still needs to see them) but
      // don't let them anywhere near the JSON bracket counter.
      // ansiState on `this` means split sequences across chunks just work.
      if (this.ansiState !== 'none') {
        if (this.depth > 0) { appendToJson(i); } else { appendToText(i); }
        if (this.depth > 0) { this.jsonBuffer += ch; } else { this.textBuffer += ch; }
        runStart = i + 1;

        switch (this.ansiState) {
          case 'esc':
            if      (ch === '[')                         { this.ansiState = 'csi';    }
            else if (ch === ']')                         { this.ansiState = 'osc';    }
            else if (ch === 'N' || ch === 'O')           { this.ansiState = 'ss2ss3'; }
            else if (ch === 'P' || ch === '^' ||
                     ch === '_' || ch === 'X')           { this.ansiState = 'string'; }
            else                                         { this.ansiState = 'none';   }
            break;

          case 'csi':
            // Params are 0x30–0x3F, intermediates 0x20–0x2F, final byte ends it.
            if (code >= 0x40 && code <= 0x7e)            { this.ansiState = 'none';   }
            break;

          case 'osc':
            if      (ch === '\x07')                      { this.ansiState = 'none';    }
            else if (code === 0x1b)                      { this.ansiState = 'osc_esc'; }
            break;

          case 'osc_esc':
            // ESC \ closes the OSC; anything else and we're still inside it.
            this.ansiState = (ch === '\\') ? 'none' : 'osc';
            break;

          case 'string':
            if (code === 0x1b)                           { this.ansiState = 'string_esc'; }
            break;

          case 'string_esc':
            this.ansiState = (ch === '\\') ? 'none' : 'string';
            break;

          case 'ss2ss3':
            // One byte consumed, done.
            this.ansiState = 'none';
            break;
        }
        continue;
      }

      // Start of a new ANSI escape sequence.
      if (code === 0x1b) {
        if (this.depth > 0) { appendToJson(i); } else { appendToText(i); }
        if (this.depth > 0) { this.jsonBuffer += ch; } else { this.textBuffer += ch; }
        runStart = i + 1;
        this.ansiState = 'esc';
        continue;
      }

      // ── Inside a JSON capture ─────────────────────────────────────────────
      if (this.depth > 0) {
        if (this.escape) {
          this.escape = false;
          continue;
        }
        if (this.inString) {
          if      (ch === '\\') { this.escape = true;   }
          else if (ch === '"')  { this.inString = false; }
          continue;
        }
        if      (ch === '"')                       { this.inString = true; }
        else if (OPEN.has(ch))                     { this.depth++;         }
        else if (ch === CLOSE.get(this.openChar)) {
          this.depth--;
          if (this.depth === 0) {
            // Closing bracket — flush and ship the completed blob.
            appendToJson(i + 1);
            runStart = i + 1;
            this.flushJson();
          }
        }
        continue;
      }

      // ── Looking for a JSON opener ─────────────────────────────────────────
      if (OPEN.has(ch)) {
        appendToText(i);
        this.flushText();
        // runStart stays at i so the opening bracket lands in the JSON buffer.
        runStart      = i;
        this.openChar = ch;
        this.depth    = 1;
        this.inString = false;
        this.escape   = false;
      }
      // Plain text byte — leave it in the run, gets flushed at the next boundary.
    }

    // End of chunk — flush whatever's left.
    if (!this.destroyed) {
      if (this.depth > 0) {
        appendToJson(chunk.length);
      } else {
        appendToText(chunk.length);
        this.flushText();
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.queue.length = 0; // nothing left in the queue is worth processing
    // Flush any partial buffers as plain text so we don't silently drop output.
    if (this.jsonBuffer) { this.callbacks.onText(this.jsonBuffer); this.jsonBuffer = ''; }
    if (this.textBuffer) { this.callbacks.onText(this.textBuffer); this.textBuffer = ''; }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private flushText(): void {
    if (!this.textBuffer) { return; }
    this.callbacks.onText(this.textBuffer);
    this.textBuffer = '';
  }

  private flushJson(): void {
    const raw = this.jsonBuffer;
    this.jsonBuffer = '';
    this.depth      = 0;
    this.openChar   = '';
    this.inString   = false;
    this.escape     = false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not actually valid JSON — pass it through as text so nothing gets lost.
      this.callbacks.onText(raw);
      return;
    }

    // Skip tiny matches like bare `{}` that show up in PS1 prompts.
    if (raw.length < 10) {
      this.callbacks.onText(raw);
      return;
    }

    const id = randomBytes(4).toString('hex');
    this.callbacks.onJson(id, parsed);
  }
}