import { hash, need } from './contract.mjs';

export const finalStatus = m => m.mode === 'publish' ? 'COMMITTED' : 'CANDIDATE_READY';
export function checkFinal(m, record) {
  need(record?.manifestHash === hash(JSON.stringify(m)) && record.status === finalStatus(m), 'FINAL_RECORD_MISMATCH');
  return record;
}
// Absence after a timeout is not proof that the request cannot still commit.
// FINAL and ABORT mutually exclude each other in conditional transactions.
export async function resolveDecision(ledger, m) {
  const final = await ledger.get(`FINAL#${m.releaseId}`);
  if (final) return { outcome: 'COMMITTED', record: checkFinal(m, final) };
  try { await ledger.fence(m); return { outcome: 'ABORTED' }; }
  catch {
    const late = await ledger.get(`FINAL#${m.releaseId}`);
    if (late) return { outcome: 'COMMITTED', record: checkFinal(m, late) };
    const abort = await ledger.get(`ABORT#${m.releaseId}`);
    need(abort?.manifestHash === hash(JSON.stringify(m)), 'DECISION_UNKNOWN');
    return { outcome: 'ABORTED' };
  }
}
