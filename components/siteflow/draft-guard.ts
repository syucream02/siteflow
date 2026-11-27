'use client';

import { useLayoutEffect, useRef } from 'react';

type Draft = { dirty: boolean; busy: boolean; discard: () => void };
const drafts = new Map<object, Draft>();
const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
let warning = false;
function updateWarning() {
  const needed = [...drafts.values()].some(d => d.dirty || d.busy);
  if (needed === warning) return;
  warning = needed;
  if (needed) window.addEventListener('beforeunload', warn);
  else window.removeEventListener('beforeunload', warn);
}

// Separate owners are aggregated: finishing one request cannot unlock another form.
export function useDraftGuard(dirty: boolean, busy: boolean, discard: () => void) {
  const owner = useRef({});
  useLayoutEffect(() => {
    const key = owner.current;
    drafts.set(key, { dirty, busy, discard }); updateWarning();
    return () => { drafts.delete(key); updateWarning(); };
  }, [dirty, busy, discard]);
  return () => { drafts.delete(owner.current); updateWarning(); };
}

export function confirmNavigation() {
  const current = [...drafts.values()];
  if (current.some(d => d.busy)) return false;
  if (current.some(d => d.dirty) && !window.confirm('未保存の入力があります。破棄して移動しますか？\nOK：破棄して移動 ／ キャンセル：画面に残る')) return false;
  drafts.clear(); updateWarning();
  for (const d of current) if (d.dirty) d.discard();
  return true;
}

// Security invalidation must not ask whether sensitive drafts should be retained.
export function clearDraftGuards() { drafts.clear(); updateWarning(); }

export function sameSelection(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && new Set(a).size === new Set(b).size && a.every(id => b.includes(id));
}
