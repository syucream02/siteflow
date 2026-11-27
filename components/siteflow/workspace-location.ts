'use client';

import { useSyncExternalStore } from 'react';
import { confirmNavigation } from './draft-guard';
const eventName = 'siteflow-location';
const listeners = new Set<() => void>();
let accepted: string | null = null, index = 0, restoring = false;
function publish() { accepted = window.location.search; for (const callback of listeners) callback(); }
function pop() {
  if (restoring) { restoring = false; return; }
  const next = window.history.state?.siteflowIndex;
  if (confirmNavigation()) { index = typeof next === 'number' ? next : index; publish(); }
  else if (typeof next === 'number' && next !== index) { restoring = true; window.history.go(index - next); }
  else { window.history.replaceState(window.history.state, '', window.location.pathname + accepted + window.location.hash); }
}
function link(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(target instanceof HTMLAnchorElement) || target.target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  if (target.href === window.location.href) return;
  if (!confirmNavigation()) { event.preventDefault(); event.stopPropagation(); }
}
function subscribe(callback: () => void) {
  if (!listeners.size) {
    accepted = window.location.search; index = window.history.state?.siteflowIndex ?? 0;
    window.history.replaceState({ ...window.history.state, siteflowIndex: index }, '', window.location.href);
    window.addEventListener('popstate', pop); document.addEventListener('click', link, true);
    window.addEventListener(eventName, publish);
  }
  listeners.add(callback);
  return () => { listeners.delete(callback); if (!listeners.size) { window.removeEventListener('popstate', pop); document.removeEventListener('click', link, true); window.removeEventListener(eventName, publish); } };
}
export function useWorkspaceLocation() {
  return useSyncExternalStore(subscribe, () => accepted ?? window.location.search, () => '');
}
export function changeWorkspaceLocation(params: URLSearchParams, force = false) {
  const search = params.toString(), next = window.location.pathname + (search ? '?' + search : '') + window.location.hash;
  if (next === window.location.pathname + window.location.search + window.location.hash) return;
  if (!force && !confirmNavigation()) return;
  index++;
  window.history.pushState({ ...window.history.state, siteflowIndex: index }, '', next);
  window.dispatchEvent(new Event(eventName));
}
