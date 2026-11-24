import { createHash } from 'node:crypto';

export const REPOSITORY = 'syucream02/siteflow';
export const IMAGE_REPOSITORY = 'ghcr.io/syucream02/siteflow';
export const SIGNER_WORKFLOW = '.github/workflows/siteflow-deploy.yml';
export const REGION = 'ap-southeast-2';
export const INSTANCE = 'REQUIRES_APPROVED_INSTANCE_ID';
export const LIMITS = Object.freeze({ lease: 30, lifetime: 600, pollMs: 5000, clockSkew: 5 });
export function need(value, code) { if (!value) throw new Error(code); }
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const copy = value => structuredClone(value);
export function releaseId(value) { need(typeof value === 'string' && /^deploy-[1-9][0-9]{0,19}-1$/.test(value), 'INVALID_RELEASE_ID'); return value; }
const keys = ['version','repository','repositoryId','signerWorkflow','signerSha','implementationSha','protectionReviewHash','releaseId','sha','digest','migrationDigest','schemaHash','ciRunId','ciAttempt','deployRunId','attempt','runCreatedAt','issuedAt','expiresAt','epoch','mode'];
export function validateProtectionReview(m,policy,now){
  const r=policy.manualProtectionReview;
  need(r?.confirmed===true&&r.reviewer==='syucream02'&&r.repositoryId===m.repositoryId&&r.environment==='production'&&r.bypassDisabled===true,'MANUAL_PROTECTION_REVIEW_REQUIRED');
  need(Number.isSafeInteger(r.reviewedAt)&&Number.isSafeInteger(r.expiresAt)&&r.reviewedAt<=m.issuedAt&&r.expiresAt>now&&r.expiresAt>=m.expiresAt&&r.expiresAt-r.reviewedAt<=86400,'PROTECTION_REVIEW_EXPIRED');
  need(m.protectionReviewHash===hash(JSON.stringify(r)),'PROTECTION_REVIEW_MISMATCH');return r;
}
export function verifyImplementation(actual,expected){need(/^[a-f0-9]{40}$/.test(actual??'')&&!/^0+$/.test(actual)&&actual===expected,'IMPLEMENTATION_NOT_PINNED');}
export function validateManifest(m, now, policy) {
  need(m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length === keys.length && keys.every(k => Object.hasOwn(m,k)), 'INVALID_MANIFEST_FIELDS');
  need(m.version === 2 && m.repository === REPOSITORY && m.repositoryId === policy.repositoryId, 'REPOSITORY_MISMATCH');
  need(m.signerWorkflow === SIGNER_WORKFLOW && /^[a-f0-9]{40}$/.test(m.signerSha) && m.signerSha === policy.signerSha, 'SIGNER_MISMATCH');
  verifyImplementation(m.implementationSha,policy.implementationSha);validateProtectionReview(m,policy,now);
  need(/^[a-f0-9]{40}$/.test(m.sha) && /^sha256:[a-f0-9]{64}$/.test(m.digest) && /^sha256:[a-f0-9]{64}$/.test(m.migrationDigest) && /^[a-f0-9]{64}$/.test(m.schemaHash), 'IMAGE_OR_SCHEMA_FORMAT');
  need(['ciRunId','deployRunId'].every(k => typeof m[k] === 'string' && /^[1-9][0-9]{0,19}$/.test(m[k])) && Number.isSafeInteger(m.ciAttempt) && m.ciAttempt > 0 && m.attempt === 1, 'INVALID_RUN');
  need(releaseId(m.releaseId) === `deploy-${m.deployRunId}-1`, 'RELEASE_ID_MISMATCH');
  need(['runCreatedAt','issuedAt','expiresAt','epoch'].every(k => Number.isSafeInteger(m[k])) && m.epoch > 0, 'INVALID_TIME_OR_EPOCH');
  need(m.runCreatedAt <= m.issuedAt && m.issuedAt <= now && m.expiresAt > now && m.expiresAt > m.issuedAt && m.expiresAt - m.issuedAt <= LIMITS.lifetime, 'APPROVAL_EXPIRED_OR_FUTURE');
  need(['candidate','publish'].includes(m.mode) && policy.allowedModes.includes(m.mode), 'MODE_NOT_APPROVED');
  return m;
}
export function verifyAdmission(m, evidence) {
  const { ci, deployment, approvals, mainSha, protection } = evidence;
  need(mainSha === m.sha, 'MAIN_MISMATCH');
  need(ci && ci.repository === REPOSITORY && ci.id === m.ciRunId && ci.attempt === m.ciAttempt && ci.event === 'push' && ci.branch === 'main' && ci.workflow === '.github/workflows/ci.yml' && ci.sha === m.sha && ci.status === 'completed' && ci.conclusion === 'success', 'CI_NOT_SUCCESSFUL');
  need(deployment && deployment.id === m.deployRunId && deployment.repository === REPOSITORY && deployment.ref === 'refs/heads/main' && deployment.attempt === 1 && deployment.createdAt === m.runCreatedAt && deployment.signerSha === m.signerSha, 'DEPLOYMENT_MISMATCH');
  need(protection?.reviewers?.length === 1 && protection.reviewers[0] === 'syucream02' && protection.bypass === false && protection.bypassReviewHash===m.protectionReviewHash && protection.mainOnly === true, 'PROTECTION_MISMATCH');
  const relevant = approvals?.filter(a => a.environment === 'production');
  // Do not guess ordering or silently reuse an earlier approval in a history.
  need(relevant?.length === 1 && relevant[0].state === 'approved' && relevant[0].user === 'syucream02', 'OWNER_APPROVAL_REQUIRED');
  need(evidence.images?.digest === m.digest && evidence.images?.migrationDigest === m.migrationDigest && evidence.images?.sha === m.sha && evidence.images?.schemaHash === m.schemaHash, 'CI_IMAGE_RECORD_MISMATCH');
}
export function validateSnapshot(m, snapshot, now) {
  const { control, stop, lease, grant } = snapshot;
  need(control && Number.isSafeInteger(control.epoch) && control.epoch === m.epoch && m.runCreatedAt >= control.notBefore, 'EPOCH_MISMATCH');
  need(!stop, 'STOP_PRESENT');
  need(grant?.manifest === JSON.stringify(m) && grant.manifestHash === hash(grant.manifest), 'GRANT_CHANGED');
  need(lease && lease.manifestHash === grant.manifestHash && lease.epoch === m.epoch && lease.releaseId === m.releaseId, 'LEASE_IDENTITY_MISMATCH');
  need(Number.isSafeInteger(lease.updatedAt) && Number.isSafeInteger(lease.expiresAt) && lease.updatedAt <= now + LIMITS.clockSkew && lease.updatedAt >= m.issuedAt && lease.expiresAt > now && lease.expiresAt > lease.updatedAt && lease.expiresAt <= lease.updatedAt + LIMITS.lease && lease.expiresAt <= m.expiresAt && m.expiresAt > now, 'LEASE_EXPIRED_OR_INVALID');
}
export function assertImage(m, image, migration, receipt) {
  need(image.repository === IMAGE_REPOSITORY && image.digest === m.digest && image.revision === m.sha, 'IMAGE_MISMATCH');
  need(migration.repository === IMAGE_REPOSITORY && migration.digest === m.migrationDigest && migration.revision === m.sha, 'MIGRATION_IMAGE_MISMATCH');
  need(receipt?.verified === true && receipt.schemaHash === m.schemaHash && receipt.migrationDigest === m.migrationDigest && receipt.databaseName === 'siteflow_public_app' && receipt.databaseHost === 'mysql.siteflow.test' && receipt.caMatches === true, 'SCHEMA_RECEIPT_MISMATCH');
}
export function assertAction(mode, action) {
  need(!['migrate','db-push','db-reset','sql'].includes(action), 'MIGRATION_FORBIDDEN');
  need(!['nginx-switch','nginx-reload','commit'].includes(action) || mode === 'publish', 'CANDIDATE_CANNOT_PUBLISH');
  need(['pull','candidate','ready','nginx-switch','nginx-reload','commit'].includes(action), 'UNKNOWN_ACTION');
}
