import { exactFields, isDigest, isTime, need, REPOSITORY, WORKFLOW, validateReleaseRecord } from './contract.mjs';

// 第2段階: 渡された模擬API本文の整合性だけを検査する。HTTP・認証処理なし。
// API本文には公式の追加項目があるため、使用する項目を検査し、他項目は信頼根拠にしない。
// ローカルenvelope/policyには未知項目を許容しない。これらも本番の信頼証明ではない。
// 仕様: https://docs.github.com/en/rest/actions/workflow-runs
// https://docs.github.com/en/rest/actions/workflow-jobs
// https://docs.github.com/en/rest/actions/artifacts
// https://docs.github.com/en/rest/actions/variables
// https://docs.github.com/en/rest/actions/workflows
// https://docs.github.com/en/rest/git/refs
const API = `https://api.github.com/repos/${REPOSITORY}`;
const responseKeys = ['repository', 'workflow', 'run', 'jobs', 'approvals', 'environment',
  'mainRef', 'variable', 'artifacts'];
const policyKeys = ['repositoryId', 'workflowId', 'environmentId', 'approverId'];
const positiveId = value => Number.isSafeInteger(value) && value > 0;

function object(value, code) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  // getterを呼ばずに拒否。API由来のJSON以外を誤って評価しない。
  need(Reflect.ownKeys(value).every(key => typeof key === 'string' &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), code);
}

export function githubTime(value) {
  need(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value), 'INVALID_GITHUB_TIME');
  const ms = Date.parse(value);
  need(Number.isSafeInteger(ms) && ms >= 0 &&
    new Date(ms).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'), 'INVALID_GITHUB_TIME');
  return ms / 1000;
}

function completedJob(job, run, now) {
  object(job, 'INVALID_JOB');
  need(positiveId(job.id) && job.run_id === run.id && job.run_url === `${API}/actions/runs/${run.id}` &&
    job.head_sha === run.head_sha && job.head_branch === 'main', 'JOB_RUN_MISMATCH');
  need(job.status === 'completed' && job.conclusion === 'success', 'JOB_NOT_SUCCESSFUL');
  const started = githubTime(job.started_at), completed = githubTime(job.completed_at);
  need(githubTime(run.created_at) <= started && started <= completed && completed <= now, 'JOB_TIME_MISMATCH');
  return { started, completed };
}

export function validateGithubResponses(record, responses, policy, now) {
  validateReleaseRecord(record);
  exactFields(responses, responseKeys, 'INVALID_GITHUB_RESPONSE_SET');
  exactFields(policy, policyKeys, 'INVALID_GITHUB_POLICY');
  need(policyKeys.every(key => positiveId(policy[key])) && isTime(now), 'INVALID_POLICY_OR_TIME');
  for (const key of responseKeys.filter(key => key !== 'approvals')) object(responses[key], 'INVALID_GITHUB_RESPONSE');
  const { repository, workflow, run, jobs, approvals, environment, mainRef, variable, artifacts } = responses;
  need(repository.id === policy.repositoryId && repository.full_name === REPOSITORY, 'REPOSITORY_MISMATCH');
  need(workflow.id === policy.workflowId && workflow.path === WORKFLOW && workflow.state === 'active', 'WORKFLOW_MISMATCH');
  need(positiveId(run.id) && String(run.id) === record.runId && run.workflow_id === workflow.id &&
    run.path === WORKFLOW && run.url === `${API}/actions/runs/${run.id}`, 'RUN_WORKFLOW_MISMATCH');
  // review historyにattempt/job IDはない。初回だけを対象にし、再実行を推測で結び付けない。
  need(record.attempt === '1' && run.run_attempt === 1, 'RERUN_NOT_SUPPORTED');
  for (const repo of [run.repository, run.head_repository]) {
    object(repo, 'INVALID_RUN_REPOSITORY');
    need(repo.id === policy.repositoryId && repo.full_name === REPOSITORY, 'RUN_REPOSITORY_MISMATCH');
  }
  need(run.event === 'push' && run.head_branch === 'main' && run.head_sha === record.sha, 'RUN_SOURCE_MISMATCH');
  need(run.status === 'completed' && run.conclusion === 'success', 'RUN_NOT_SUCCESSFUL');
  need(githubTime(run.created_at) <= githubTime(run.updated_at) && githubTime(run.updated_at) <= now, 'RUN_TIME_MISMATCH');
  object(mainRef.object, 'INVALID_MAIN_OBJECT');
  need(mainRef.ref === 'refs/heads/main' && mainRef.object.type === 'commit' &&
    mainRef.object.sha === record.sha, 'LATEST_MAIN_MISMATCH');
  need(environment.id === policy.environmentId && environment.name === 'production', 'ENVIRONMENT_MISMATCH');

  // レビュー済み現CIのjobは2件。ページ欠落・重複・構成変更は停止する。
  need(jobs.total_count === 2 && Array.isArray(jobs.jobs) && jobs.jobs.length === 2, 'INCOMPLETE_OR_CHANGED_JOBS');
  const names = jobs.jobs.map(job => { object(job, 'INVALID_JOB'); return job.name; });
  need(names.filter(name => name === 'docker-build').length === 1 &&
    names.filter(name => name === 'release-approved').length === 1 &&
    positiveId(jobs.jobs[0].id) && jobs.jobs[0].id !== jobs.jobs[1].id, 'AMBIGUOUS_JOBS');
  const build = completedJob(jobs.jobs.find(job => job.name === 'docker-build'), run, now);
  const release = completedJob(jobs.jobs.find(job => job.name === 'release-approved'), run, now);
  need(build.completed <= release.started && release.completed <= githubTime(run.updated_at), 'CI_RELEASE_ORDER_MISMATCH');

  // review historyはrun単位。APIが保証しない並び順・時刻・attemptを補わない。
  need(Array.isArray(approvals) && approvals.length === 1, 'MISSING_OR_AMBIGUOUS_APPROVAL');
  const approval = approvals[0]; object(approval, 'INVALID_APPROVAL');
  object(approval.user, 'INVALID_APPROVER');
  need(approval.state === 'approved' && approval.user.login === 'syucream02' &&
    approval.user.type === 'User' && approval.user.id === policy.approverId, 'OWNER_APPROVAL_REQUIRED');
  need(Array.isArray(approval.environments) && approval.environments.length === 1, 'AMBIGUOUS_APPROVAL_ENVIRONMENT');
  const target = approval.environments[0]; object(target, 'INVALID_APPROVAL_ENVIRONMENT');
  need(target.id === environment.id && target.name === environment.name, 'APPROVAL_ENVIRONMENT_MISMATCH');

  need(variable.name === 'SITEFLOW_RELEASE_ENABLED' && variable.value === 'true', 'CURRENT_PERMISSION_DISABLED');
  const permissionUpdatedAt = githubTime(variable.updated_at);
  need(githubTime(variable.created_at) <= permissionUpdatedAt && permissionUpdatedAt <= now, 'INVALID_PERMISSION_TIME');
  need(Number.isSafeInteger(artifacts.total_count) && artifacts.total_count >= 1 &&
    artifacts.total_count <= 100 && Array.isArray(artifacts.artifacts) &&
    artifacts.total_count === artifacts.artifacts.length, 'INCOMPLETE_ARTIFACT_PAGE');
  const expectedName = `approved-release-${record.sha}-${record.runId}-${record.attempt}`;
  const ids = new Set();
  for (const a of artifacts.artifacts) {
    object(a, 'INVALID_ARTIFACT');
    need(positiveId(a.id) && typeof a.name === 'string' && !ids.has(a.id), 'AMBIGUOUS_ARTIFACT_IDS');
    ids.add(a.id);
  }
  const matches = artifacts.artifacts.filter(a => a.name === expectedName);
  need(matches.length === 1, 'APPROVAL_ARTIFACT_MISSING_OR_AMBIGUOUS');
  const artifact = matches[0]; object(artifact.workflow_run, 'INVALID_ARTIFACT_RUN');
  const origin = artifact.workflow_run;
  need(origin.id === run.id && origin.repository_id === policy.repositoryId &&
    origin.head_repository_id === policy.repositoryId && origin.head_branch === 'main' &&
    origin.head_sha === record.sha, 'ARTIFACT_RUN_OR_SHA_MISMATCH');
  need(artifact.url === `${API}/actions/artifacts/${artifact.id}` &&
    artifact.archive_download_url === `${API}/actions/artifacts/${artifact.id}/zip`, 'ARTIFACT_LOCATION_MISMATCH');
  need(artifact.expired === false && isDigest(artifact.digest) &&
    Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 &&
    artifact.size_in_bytes <= 131072, 'INVALID_ARTIFACT_METADATA');
  const createdAt = githubTime(artifact.created_at), retentionEndsAt = githubTime(artifact.expires_at);
  need(release.started <= createdAt && createdAt <= release.completed && createdAt <= now &&
    now < retentionEndsAt && permissionUpdatedAt < createdAt, 'ARTIFACT_TIME_OR_PERMISSION_MISMATCH');
  return {
    status: 'mock_github_consistency_passed', executionAllowed: false,
    repository: REPOSITORY, branch: 'main', mainSha: run.head_sha,
    runId: String(run.id), attempt: '1', artifactId: String(artifact.id),
    artifactCreatedAt: Math.floor(createdAt), permissionUpdatedAt: Math.floor(permissionUpdatedAt),
    releaseEnabled: variable.value, artifactZipDigest: artifact.digest,
    artifactZipBytes: artifact.size_in_bytes,
    // 以下はAPIによる直接証明ではなく、レビュー済み現workflowを前提とする対応検査。
    approvalBinding: 'same_run_environment_and_reviewed_workflow_assumption',
  };
}
