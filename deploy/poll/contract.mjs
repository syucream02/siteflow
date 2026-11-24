// 第1段階: 形式・整合性だけを検査する。API、署名、本人承認は検証しない。
// この結果から実配信してはいけない。外部検証との安全な接続は第2段階。
export const REPOSITORY = 'syucream02/siteflow';
export const IMAGE_REPOSITORY = 'ghcr.io/syucream02/siteflow';
export const WORKFLOW = '.github/workflows/ci.yml';
export const MAX_APPROVAL_SECONDS = 3600; // 既存cd-check.shと同じ上限。

export function need(condition, code) {
  if (!condition) throw new Error(code); // 入力値をエラーメッセージへ含めない。
}

// JSON由来の通常オブジェクトを対象とし、未知項目・getter・symbolも拒否する。
export function exactFields(value, keys, code = 'INVALID_FIELDS') {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  need([Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  need(ownKeys.length === keys.length && keys.every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value') &&
    descriptors[key].enumerable), code);
}

const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
export const isDigest = value => typeof value === 'string' && value.startsWith('sha256:') && hash(value.slice(7));
export const isTime = value => Number.isSafeInteger(value) && value >= 0;

const recordKeys = ['schemaVersion', 'repository', 'workflow', 'sha', 'runId', 'attempt',
  'imageRepository', 'digest', 'migrationDigest', 'schemaHash', 'approved'];

export function validateReleaseRecord(record) {
  exactFields(record, recordKeys, 'INVALID_RECORD_FIELDS');
  need(record.schemaVersion === 1 && record.repository === REPOSITORY &&
    record.workflow === WORKFLOW && record.imageRepository === IMAGE_REPOSITORY, 'RECORD_SOURCE_MISMATCH');
  need(sha(record.sha) && id(record.runId) && id(record.attempt), 'INVALID_RELEASE_IDENTITY');
  need(isDigest(record.digest) && isDigest(record.migrationDigest) && hash(record.schemaHash), 'INVALID_IMAGE_OR_SCHEMA');
  need(record.approved === true, 'RECORD_NOT_MARKED_APPROVED');
  // approved:trueは既存形式の必須値にすぎず、承認の証明ではない。
  return { ...record };
}

export function releaseIdentity(record) {
  validateReleaseRecord(record);
  // 既存cd-check.shの消費マーカー名を再利用。artifact差し替えでIDを変えない。
  return `used-${record.runId}-a${record.attempt}`;
}

const inputKeys = ['repository', 'branch', 'mainSha', 'runId', 'attempt', 'artifactId',
  'artifactCreatedAt', 'permissionUpdatedAt', 'expiresAt', 'releaseEnabled',
  'consumedIds', 'image', 'migration', 'schemaHash', 'migrationRequired'];

// inputは後続adapterから受け取るローカル判定材料。GitHubのwire形式ではない。
// 時刻はUTC Unix秒。取得元・真正性・最新性は未保証で、"verified"フラグも受け取らない。
export function assessRelease(record, input, now) {
  validateReleaseRecord(record);
  exactFields(input, inputKeys, 'INVALID_INPUT_FIELDS');
  need(isTime(now), 'INVALID_NOW');
  need(input.repository === REPOSITORY && input.branch === 'main' &&
    sha(input.mainSha) && input.mainSha === record.sha, 'SOURCE_OR_MAIN_MISMATCH');
  need(id(input.runId) && id(input.attempt) && id(input.artifactId) &&
    input.runId === record.runId && input.attempt === record.attempt, 'ARTIFACT_RUN_MISMATCH');
  for (const [image, digest] of [[input.image, record.digest], [input.migration, record.migrationDigest]]) {
    exactFields(image, ['repository', 'digest', 'revision'], 'INVALID_IMAGE_FIELDS');
    need(image.repository === IMAGE_REPOSITORY && isDigest(image.digest) && image.digest === digest &&
      sha(image.revision) && image.revision === record.sha, 'IMAGE_IDENTITY_MISMATCH');
  }
  need(hash(input.schemaHash) && input.schemaHash === record.schemaHash, 'SCHEMA_MISMATCH');
  need(input.migrationRequired === false, 'MIGRATION_REQUIRED_OR_UNKNOWN');
  need(input.releaseEnabled === 'true', 'RELEASE_DISABLED_OR_UNKNOWN');
  need([input.artifactCreatedAt, input.permissionUpdatedAt, input.expiresAt].every(isTime), 'INVALID_APPROVAL_TIME');
  need(input.permissionUpdatedAt < input.artifactCreatedAt && input.artifactCreatedAt <= now &&
    now < input.expiresAt && input.expiresAt > input.artifactCreatedAt &&
    input.expiresAt - input.artifactCreatedAt <= MAX_APPROVAL_SECONDS, 'APPROVAL_EXPIRED_OR_INCONSISTENT');
  need(Array.isArray(input.consumedIds) && input.consumedIds.every(value =>
    typeof value === 'string' && /^used-[1-9][0-9]{0,19}-a[1-9][0-9]{0,19}$/.test(value)) &&
    new Set(input.consumedIds).size === input.consumedIds.length, 'INVALID_CONSUMED_IDS');
  // consumedIdsは呼び出し元のスナップショットであり、永続的な一回性の証明ではない。
  // 後続実装ではロックの下で読み戻し、ID消費を永続化してから副作用を開始する。
  const releaseId = releaseIdentity(record);
  need(!input.consumedIds.includes(releaseId), 'RELEASE_ALREADY_CONSUMED');
  return {
    status: 'external_verification_required', localChecks: 'passed', executionAllowed: false,
    releaseId, artifactId: input.artifactId, expiresAt: input.expiresAt,
    pendingChecks: ['github_owner_approval', 'ci_success', 'artifact_authenticity',
      'current_main', 'current_environment_permission'],
  };
}
