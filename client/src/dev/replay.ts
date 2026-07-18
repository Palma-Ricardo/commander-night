// Replay (design §12) — feed a recorded session (recorder.toJsonl output) back
// through the codec. C0 skeleton: decodes and dispatches to a sink; from C1 on,
// the sink grows into the real store-routing layer so replays re-drive stores
// headlessly (the §13 replay test tier).

import { decode } from '../protocol/codec';
import type { ServerMsg } from '../protocol/protocol';
import type { TraceDirection } from './recorder';

export interface ReplaySink {
  onServerMsg?(msg: ServerMsg, line: number): void;
  onClientMsg?(msg: unknown, line: number): void;
}

export interface ReplayReport {
  lines: number;                              // non-blank JSONL lines seen
  inbound: number;                            // decoded server → client messages
  outbound: number;                           // client → server commands
  errors: { line: number; error: string }[];  // 1-based line numbers
}

export function replayJsonl(
  jsonl: string,
  sink: ReplaySink = {},
  opts: { strict?: boolean } = {},
): ReplayReport {
  const strict = opts.strict ?? true;         // fixtures should be clean; opt out explicitly
  const report: ReplayReport = { lines: 0, inbound: 0, outbound: 0, errors: [] };

  const rawLines = jsonl.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const line = i + 1;
    const raw = rawLines[i]?.trim();
    if (!raw) continue;
    report.lines++;

    let entry: { dir?: TraceDirection; msg?: unknown };
    try {
      entry = JSON.parse(raw) as { dir?: TraceDirection; msg?: unknown };
    } catch (e) {
      report.errors.push({ line, error: `unparseable line: ${(e as Error).message}` });
      continue;
    }
    if (entry.dir !== 'in' && entry.dir !== 'out') {
      report.errors.push({ line, error: `missing/invalid dir: ${JSON.stringify(entry.dir)}` });
      continue;
    }

    if (entry.dir === 'out') {
      report.outbound++;
      sink.onClientMsg?.(entry.msg, line);
      continue;
    }

    const r = decode(entry.msg, { strict });
    if (!r.ok) {
      report.errors.push({ line, error: r.error });
    } else if (r.msg === null) {
      report.errors.push({ line, error: `ignored unknown type '${r.ignoredType}' in replay` });
    } else {
      report.inbound++;
      sink.onServerMsg?.(r.msg, line);
    }
  }
  return report;
}
