import type { Change, CompareResult } from '../types';
import type { ReviewController, ReviewMarkView } from '../ui/viewer';
import { call } from './http';
import type { ReviewMark, SavedComparison } from './types';

/** FNV-1a 32-bit hash as 8 hex characters. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable keys for changes, derived from their text (not their position), so a
 * teammate re-opening the same files gets the same keys. The prefix numbers
 * repeated identical changes ("0-…", "1-…") so each still gets its own mark.
 * Only this hash is sent to the server, never the text.
 */
export function changeKeys(result: CompareResult): Map<number, string> {
  const seen = new Map<string, number>();
  const keys = new Map<number, string>();
  for (const c of result.changes) {
    const hash = fnv1a(`${c.type}\u0000${c.leftText}\u0000${c.rightText}`);
    const n = seen.get(hash) ?? 0;
    seen.set(hash, n + 1);
    keys.set(c.id, `${n}-${hash}`);
  }
  return keys;
}

export interface ReviewSession {
  saved: SavedComparison | null;
  /** Marks keyed by change key (survives re-comparison with other settings). */
  marks: Map<string, ReviewMark>;
}

/** Build the viewer's review controller for the current result and saved record. */
export function reviewController(
  result: CompareResult,
  session: ReviewSession,
  workspaceName: string,
  userName: string,
  enable: (() => void) | undefined,
): ReviewController {
  const keys = changeKeys(result);
  const byId = new Map<number, ReviewMarkView>();
  for (const c of result.changes) {
    const m = session.marks.get(keys.get(c.id)!);
    if (m) byId.set(c.id, { status: m.status, note: m.note, by: m.updated_by_name });
  }
  const saved = session.saved;
  const canEdit = saved?.save_level === 'progress';
  return {
    marks: byId,
    canEdit,
    label: !saved
      ? 'Not saved. Only you can see this comparison.'
      : canEdit
        ? `Saving review progress to ${workspaceName}`
        : `Logged in ${workspaceName} history (review marks aren’t saved)`,
    onEnableProgress: canEdit ? undefined : enable,
    enableLabel: saved ? 'Also save review progress' : 'Save & track review',
    async onMark(changeId: number, status, note) {
      if (!saved) return false;
      const key = keys.get(changeId)!;
      const res = await call(`/api/comparisons/${saved.id}/reviews/${key}`, { method: 'PUT', json: { status, note } });
      if (!res.ok) return false;
      if (!status && !note) {
        session.marks.delete(key);
        byId.delete(changeId);
      } else {
        const mark: ReviewMark = { change_key: key, status: status ?? 'reviewed', note, updated_at: new Date().toISOString(), updated_by_name: userName };
        session.marks.set(key, mark);
        byId.set(changeId, { status: mark.status, note, by: userName });
      }
      return true;
    },
  };
}

export type { Change };
