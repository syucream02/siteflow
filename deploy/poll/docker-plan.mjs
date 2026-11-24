import { exactFields, need, validateReleaseRecord, IMAGE_REPOSITORY } from './contract.mjs';
import { createSwitchPlan, sameSlot, validateNextSlot } from './switch-plan.mjs';
import { assessLinuxStorage, assertLinuxPath, beneath } from './linux-storage.mjs';
import { createHash } from 'node:crypto';

const MiB = 1024 * 1024;
const keys = ['NODE_ENV', 'HOSTNAME', 'PORT', 'SITEFLOW_WORKSPACE_MODE', 'SITEFLOW_PUBLIC_ORIGIN', 'SITEFLOW_DB_HOST', 'SITEFLOW_DB_PORT', 'SITEFLOW_DB_NAME', 'SITEFLOW_DB_USER', 'SITEFLOW_DB_TLS', 'SITEFLOW_DB_CA_FILE', 'SITEFLOW_DB_PASSWORD_FILE', 'SITEFLOW_AUTH_SECRET_FILE'];
const configurationReceipts = new WeakMap();
const releaseIdPattern = /^(?:used-[1-9][0-9]{0,19}-a[1-9][0-9]{0,19}|manual-[a-zA-Z0-9_.-]{1,80})$/;
const configKeys = ['entrypoint', 'cmd', 'user', 'workingDir', 'env', 'mounts', 'portBindings', 'networkMode', 'privileged', 'readonlyRootfs', 'capAdd', 'capDrop', 'securityOpt', 'memory', 'memorySwap', 'nanoCpus', 'pidsLimit', 'ulimits', 'tmpfs', 'restartPolicy', 'logDriver', 'stopTimeout'];
function canonicalConfiguration(config, slot) {
  validateNextSlot(slot); exactFields(config, configKeys, 'INVALID_SAVED_CONTAINER_CONFIGURATION');
  exactFields(config.env, keys, 'PLAINTEXT_SECRET_OR_UNKNOWN_ENV');
  const e = config.env;
  let origin;
  try { origin = new URL(e.SITEFLOW_PUBLIC_ORIGIN); } catch { throw new Error('INVALID_SAVED_PUBLIC_ORIGIN'); }
  need(origin.protocol === 'https:' && origin.origin === e.SITEFLOW_PUBLIC_ORIGIN && !origin.username && !origin.password && !origin.port &&
    typeof e.SITEFLOW_DB_USER === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(e.SITEFLOW_DB_USER) && e.SITEFLOW_DB_USER !== 'root', 'UNSAFE_SAVED_ENV');
  const expected = ['production', '0.0.0.0', '3000', 'public-integrated', origin.origin, 'mysql.siteflow.test', '3306', 'siteflow_public_app', e.SITEFLOW_DB_USER, 'required', '/run/siteflow/ca.pem', '/run/secrets/db-password', '/run/secrets/auth-secret'];
  need(keys.every((k, i) => e[k] === expected[i]), 'UNSAFE_SAVED_ENV');
  need(JSON.stringify(config.entrypoint) === '["node"]' && JSON.stringify(config.cmd) === '["server.js"]' && config.user === '1000:1000' &&
    config.workingDir === '/app' && typeof config.networkMode === 'string' && /^siteflow-[a-z0-9-]{1,60}$/.test(config.networkMode), 'UNSAFE_SAVED_EXECUTION');
  need(Array.isArray(config.mounts) && config.mounts.length === 3, 'UNSAFE_SAVED_MOUNTS');
  const targets = ['/run/secrets/db-password', '/run/secrets/auth-secret', '/run/siteflow/ca.pem'];
  const mounts = targets.map(target => {
    const matches = config.mounts.filter(m => m?.target === target); need(matches.length === 1, 'UNSAFE_SAVED_MOUNTS');
    const m = matches[0]; exactFields(m, ['type', 'source', 'target', 'readOnly'], 'UNSAFE_SAVED_MOUNTS'); assertLinuxPath(m.source);
    need(m.type === 'bind' && m.readOnly === true && (target.endsWith('ca.pem') ? beneath(m.source, '/srv/siteflow-mysql/tls') : beneath(m.source, '/srv/siteflow-mysql/secrets')), 'UNSAFE_SAVED_MOUNTS');
    return { type: m.type, source: m.source, target: m.target, readOnly: m.readOnly };
  });
  need(new Set(mounts.map(m => m.source)).size === 3 && JSON.stringify(config.portBindings) === JSON.stringify([{ hostIp: '127.0.0.1', hostPort: slot.port, containerPort: 3000 }]), 'UNSAFE_SAVED_BINDINGS');
  need(config.privileged === false && config.readonlyRootfs === true && JSON.stringify(config.capAdd) === '[]' && JSON.stringify(config.capDrop) === '["ALL"]' &&
    JSON.stringify(config.securityOpt) === '["no-new-privileges:true"]' && config.memory === 384 * MiB && config.memorySwap === 384 * MiB && config.nanoCpus === 500000000 && config.pidsLimit === 128 &&
    JSON.stringify(config.ulimits) === '{"core":{"soft":0,"hard":0}}' && JSON.stringify(config.tmpfs) === '{"/tmp":"rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=1777"}' &&
    config.restartPolicy === 'no' && config.logDriver === 'none' && config.stopTimeout === 30, 'UNSAFE_SAVED_RESTRICTIONS');
  return { entrypoint: ['node'], cmd: ['server.js'], user: '1000:1000', workingDir: '/app', env: Object.fromEntries(keys.map(k => [k, e[k]])), mounts,
    portBindings: [{ hostIp: '127.0.0.1', hostPort: slot.port, containerPort: 3000 }], networkMode: config.networkMode,
    privileged: false, readonlyRootfs: true, capAdd: [], capDrop: ['ALL'], securityOpt: ['no-new-privileges:true'], memory: 384 * MiB, memorySwap: 384 * MiB,
    nanoCpus: 500000000, pidsLimit: 128, ulimits: { core: { soft: 0, hard: 0 } }, tmpfs: { '/tmp': 'rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=1777' }, restartPolicy: 'no', logDriver: 'none', stopTimeout: 30 };
}
export function validateSavedContainerConfiguration(saved, slot, releaseId) {
  exactFields(saved, ['version', 'releaseId', 'slot', 'configuration', 'hash'], 'INVALID_SAVED_CONFIGURATION_RECORD');
  validateNextSlot(saved.slot);
  need(saved.version === 1 && typeof releaseId === 'string' && releaseIdPattern.test(releaseId) && saved.releaseId === releaseId && sameSlot(saved.slot, slot), 'SAVED_CONFIGURATION_RELEASE_MISMATCH');
  const canonical = canonicalConfiguration(saved.configuration, slot);
  need(createHash('sha256').update(JSON.stringify(canonical)).digest('hex') === saved.hash, 'SAVED_CONFIGURATION_HASH_MISMATCH');
  return { ...structuredClone(saved), configuration: canonical };
}
function configurationReceipt(slot, releaseId, configuration) {
  const canonical = canonicalConfiguration(configuration, slot);
  const record = { version: 1, releaseId, slot: structuredClone(slot), configuration: canonical, hash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
  validateSavedContainerConfiguration(record, slot, releaseId);
  const receipt = Object.freeze({ mode: 'local-configuration-model', executionAllowed: false }); configurationReceipts.set(receipt, record); return receipt;
}
export function takeContainerConfiguration(receipt, slot, releaseId) {
  const saved = configurationReceipts.get(receipt); need(saved, 'ORIGINAL_CONFIGURATION_RECEIPT_REQUIRED');
  configurationReceipts.delete(receipt); return validateSavedContainerConfiguration(saved, slot, releaseId);
}
export function createBootstrapContainerConfiguration(slot, releaseId, configuration) {
  need(slot?.port === 3001 && /^manual-[a-zA-Z0-9_.-]{1,80}$/.test(releaseId), 'EXPLICIT_BOOTSTRAP_CONFIGURATION_REQUIRED');
  return configurationReceipt(slot, releaseId, configuration);
}
export function compareSavedContainerConfiguration(saved, slot, releaseId, observed) {
  const expected = validateSavedContainerConfiguration(saved, slot, releaseId);
  const canonical = canonicalConfiguration(observed, slot);
  need(JSON.stringify(canonical) === JSON.stringify(expected.configuration), 'CONTAINER_CONFIGURATION_MISMATCH');
  return { status: 'mock_saved_configuration_matches', executionAllowed: false };
}
// argvを実行する関数はない。秘密値を受け取らず、許可されたファイル参照のみ計画する。
export function createDockerPlan(data) {
  exactFields(data, ['record', 'stable', 'candidate', 'runtime', 'storage', 'policy', 'files', 'env', 'image', 'resources'], 'INVALID_DOCKER_PLAN_INPUT');
  const { record, stable, candidate, runtime, storage, policy, files, env, image, resources } = data;
  validateReleaseRecord(record); assessLinuxStorage(storage.policy, storage.observation);
  createSwitchPlan(stable, candidate, runtime);
  exactFields(policy, ['origin', 'network', 'databaseHost', 'databaseName', 'databaseUser', 'runtimeEnvFile', 'passwordFile', 'authFile', 'caFile'], 'INVALID_DOCKER_POLICY');
  let origin;
  try { origin = new URL(policy.origin); } catch { throw new Error('INVALID_PUBLIC_ORIGIN'); }
  need(origin.protocol === 'https:' && origin.origin === policy.origin && !origin.username && !origin.password && !origin.port &&
    origin.hostname !== 'localhost' && !origin.hostname.endsWith('.example.com'), 'INVALID_PUBLIC_ORIGIN');
  need(typeof policy.network === 'string' && /^siteflow-[a-z0-9-]{1,60}$/.test(policy.network) && policy.databaseHost === 'mysql.siteflow.test' &&
    policy.databaseName === 'siteflow_public_app' && typeof policy.databaseUser === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(policy.databaseUser) && policy.databaseUser !== 'root', 'INVALID_DATABASE_POLICY');
  exactFields(files, ['runtimeEnvFile', 'passwordFile', 'authFile', 'caFile'], 'INVALID_APP_FILE_METADATA');
  const paths = [];
  for (const key of Object.keys(files)) {
    const f = files[key]; assertLinuxPath(policy[key]);
    exactFields(f, ['path', 'realPath', 'symlink', 'type', 'uid', 'mode', 'bytes', 'uuid', 'parentProtected', 'links'], 'INVALID_APP_FILE');
    need(f.path === policy[key] && f.realPath === f.path && beneath(f.path, storage.policy.mount) && f.path !== storage.policy.mysqlDataDirectory && !beneath(f.path, storage.policy.mysqlDataDirectory) &&
      f.path !== storage.policy.stateDirectory && !beneath(f.path, storage.policy.stateDirectory) && f.symlink === false && f.type === 'file' && f.links === 1 && f.parentProtected === true &&
      f.uuid === storage.policy.uuid && Number.isSafeInteger(f.bytes) && f.bytes > 0 && f.bytes <= (key === 'caFile' ? 65536 : 4096), 'APP_FILE_OUTSIDE_PROTECTED_EBS');
    need(f.uid === (['passwordFile', 'authFile'].includes(key) ? 1000 : 0) &&
      f.mode === (['passwordFile', 'authFile'].includes(key) ? 0o400 : key === 'caFile' ? 0o644 : 0o600), 'APP_FILE_PERMISSION_MISMATCH');
    paths.push(f.path);
  }
  need(new Set(paths).size === 4, 'APP_FILES_OVERLAP');
  exactFields(env, keys, 'PLAINTEXT_SECRET_OR_UNKNOWN_ENV');
  const expected = ['production', '0.0.0.0', '3000', 'public-integrated', policy.origin, policy.databaseHost, '3306', policy.databaseName, policy.databaseUser, 'required', '/run/siteflow/ca.pem', '/run/secrets/db-password', '/run/secrets/auth-secret'];
  need(keys.every((k, i) => env[k] === expected[i]), 'APP_ENV_POLICY_MISMATCH');
  exactFields(image, ['repoDigests', 'revision', 'schemaHash', 'schemaSourceDigest', 'os', 'architecture', 'user', 'entrypoint', 'cmd'], 'INVALID_IMAGE_OBSERVATION');
  const ref = `${IMAGE_REPOSITORY}@${record.digest}`;
  need(candidate.image === ref && Array.isArray(image.repoDigests) && image.repoDigests.length === 1 && image.repoDigests[0] === ref &&
    image.revision === record.sha && image.schemaHash === record.schemaHash && image.schemaSourceDigest === record.digest &&
    image.os === 'linux' && image.architecture === 'amd64' && image.user === 'node' &&
    (image.entrypoint === null || JSON.stringify(image.entrypoint) === JSON.stringify(['docker-entrypoint.sh'])) &&
    JSON.stringify(image.cmd) === JSON.stringify(['node', 'server.js']), 'IMAGE_DIGEST_REVISION_OR_SCHEMA_MISMATCH');
  // 閾値は既存384MiB制限とt3.small用の提案。実負荷測定で別承認のもと再評価する。
  exactFields(resources, ['availableMemoryBytes', 'rootFreeBytes', 'imageUnpackedBytes', 'dockerHealthy', 'mysqlHealthy'], 'INVALID_RESOURCE_OBSERVATION');
  need(resources.dockerHealthy === true && resources.mysqlHealthy === true && Number.isSafeInteger(resources.availableMemoryBytes) &&
    resources.availableMemoryBytes >= (384 + 128 + 256) * MiB && Number.isSafeInteger(resources.imageUnpackedBytes) && resources.imageUnpackedBytes > 0 &&
    Number.isSafeInteger(resources.rootFreeBytes) && resources.rootFreeBytes >= resources.imageUnpackedBytes * 2 + 2 * 1024 * MiB, 'INSUFFICIENT_RUNTIME_RESOURCES');
  const configuration = { entrypoint: ['node'], cmd: ['server.js'], user: '1000:1000', workingDir: '/app', env: structuredClone(env),
    mounts: [
      { type: 'bind', source: policy.passwordFile, target: '/run/secrets/db-password', readOnly: true },
      { type: 'bind', source: policy.authFile, target: '/run/secrets/auth-secret', readOnly: true },
      { type: 'bind', source: policy.caFile, target: '/run/siteflow/ca.pem', readOnly: true },
    ], portBindings: [{ hostIp: '127.0.0.1', hostPort: candidate.port, containerPort: 3000 }], networkMode: policy.network,
    privileged: false, readonlyRootfs: true, capAdd: [], capDrop: ['ALL'], securityOpt: ['no-new-privileges:true'], memory: 384 * MiB, memorySwap: 384 * MiB,
    nanoCpus: 500000000, pidsLimit: 128, ulimits: { core: { soft: 0, hard: 0 } }, tmpfs: { '/tmp': 'rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=1777' }, restartPolicy: 'no', logDriver: 'none', stopTimeout: 30 };
  return { mode: 'local-plan', executionAllowed: false, candidate: structuredClone(candidate), previous: structuredClone(stable),
    configurationReceipt: configurationReceipt(candidate, `used-${record.runId}-a${record.attempt}`, configuration),
    image: ref, pull: { binary: '/usr/bin/docker', args: ['pull', ref] },
    create: { binary: '/usr/bin/docker', args: ['create', '--name', candidate.container, '--label', 'siteflow.managed=poll-release',
      '--network', policy.network, '--env-file', policy.runtimeEnvFile, '--user', '1000:1000', '--entrypoint', 'node', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '384m', '--memory-swap', '384m', '--cpus', '0.5', '--pids-limit', '128',
      '--ulimit', 'core=0', '--restart', 'no', '--log-driver', 'none', '--stop-timeout', '30',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=1777',
      '--mount', `type=bind,source=${policy.passwordFile},target=/run/secrets/db-password,readonly`,
      '--mount', `type=bind,source=${policy.authFile},target=/run/secrets/auth-secret,readonly`,
      '--mount', `type=bind,source=${policy.caFile},target=/run/siteflow/ca.pem,readonly`, '--publish', `127.0.0.1:${candidate.port}:3000`, ref, 'server.js'] },
    steps: ['recheck_permission_lock_mount_resources', 'pull_by_digest', 'inspect_digest_revision_schema_again', 'persist_candidate_intent', 'create_only_new_candidate', 'start_exact_created_container', 'check_candidate_with_public_host_and_https_header'],
    failurePlan: ['keep_existing_nextjs_and_mysql', 'mark_incident_on_uncertain_side_effect', 'review_candidate_without_automatic_delete'],
    pendingChecks: ['image_schema_extraction_bound_to_digest', 'actual_env_file_allowlist_and_readability', 'actual_network_and_db_privileges', 'privileged_fixed_wrapper'],
  };
}
