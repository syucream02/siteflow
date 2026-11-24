import { exactFields, isTime, MAX_APPROVAL_SECONDS, need } from './contract.mjs';
import { githubTime } from './github.mjs';
import { checkCandidate } from './check.mjs';
import { readReleaseArchive } from './archive.mjs';
import { validateWorkflowPolicy } from './workflow-policy.mjs';
import { PINNED_PATHS } from './transport.mjs';

// 模擬取得の原本だけを一度引き渡す。認証済みGitHub情報の証明ではない。
const mockEvidence = new WeakMap();
export function takeMockAcquisitionEvidence(result) {
  const entry = mockEvidence.get(result);
  need(entry && JSON.stringify(result) === entry.summary, 'INVALID_OR_USED_MOCK_ACQUISITION');
  mockEvidence.delete(result);
  return structuredClone(entry.evidence);
}

// 模擬通信の取得手順。実行許可・永続化・Docker/DB操作は含まない。
export async function acquireMockRelease(config) {
  let stage = 'CONFIG'; // 例外には固定工程名だけを付け、本文・token・URLは含めない。
  try {
    exactFields(config, ['transport', 'credential', 'policy', 'local', 'now'], 'INVALID_ACQUIRE_CONFIG');
    const { transport, credential, now } = config;
    need(transport?.mode === 'mock-only' && typeof now === 'function', 'MOCK_TRANSPORT_REQUIRED');
    const policy = structuredClone(config.policy), local = structuredClone(config.local);
    exactFields(policy, ['github', 'workflow'], 'INVALID_ACQUIRE_POLICY');
    exactFields(local, ['image', 'migration', 'schemaHash', 'migrationRequired', 'consumedIds'], 'INVALID_LOCAL_CONTEXT');
    const started = now(); let last = started;
    const clock = () => {
      const time = now(); need(isTime(time) && time >= last && time - started <= 300, 'ACQUIRE_DEADLINE');
      last = time; return time;
    };
    const get = async (operation, p = {}) => {
      clock(); const body = await transport.getJson(operation, p, credential); clock();
      return structuredClone(body);
    };
    stage = 'REPOSITORY';
    const repository = await get('repository');
    need(repository.id === policy.github.repositoryId && repository.full_name === 'syucream02/siteflow', 'REPOSITORY_MISMATCH');
    const mainRef = await get('main'), sha = mainRef.object?.sha;
    need(mainRef.ref === 'refs/heads/main' && mainRef.object.type === 'commit' &&
      typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha), 'MAIN_REQUIRED');
    const variable = await get('permission');
    need(variable.name === 'SITEFLOW_RELEASE_ENABLED' && variable.value === 'true', 'RELEASE_DISABLED');
    const workflow = await get('workflow');
    need(workflow.id === policy.github.workflowId && workflow.path === '.github/workflows/ci.yml', 'WORKFLOW_MISMATCH');
    async function pages(operation, p, key, limit) {
      const all = []; let total;
      for (let page = 1; page <= 5; page++) {
        const body = await get(operation, { ...p, page });
        need(Number.isSafeInteger(body.total_count) && body.total_count >= 0 && body.total_count <= limit &&
          Array.isArray(body[key]), 'PAGE_REJECTED');
        total ??= body.total_count;
        need(body.total_count === total && body[key].length === Math.min(100, total - all.length), 'PAGE_CHANGED_OR_INCOMPLETE');
        all.push(...body[key]);
        need(all.every(x => Number.isSafeInteger(x.id) && x.id > 0) && new Set(all.map(x => x.id)).size === all.length, 'DUPLICATE_PAGE_IDS');
        if (all.length === total) return { total_count: total, [key]: all };
      }
      throw new Error('PAGE_LIMIT');
    }
    stage = 'RUNS';
    const runs = await pages('runs', { sha }, 'workflow_runs', 500);
    need(runs.workflow_runs.length > 0 && runs.workflow_runs.every(r => r.head_sha === sha && r.head_branch === 'main' &&
      r.event === 'push' && r.workflow_id === workflow.id), 'RUN_LIST_MISMATCH');
    const selected = runs.workflow_runs.reduce((a, b) => a.id > b.id ? a : b);
    need(selected.run_attempt === 1 && selected.status === 'completed' && selected.conclusion === 'success', 'LATEST_RUN_NOT_APPROVED');
    const runId = String(selected.id), run = await get('run', { runId });
    const identity = r => [r.id, r.workflow_id, r.head_sha, r.head_branch, r.event, r.run_attempt, r.status, r.conclusion,
      r.path, r.url, r.repository?.id, r.repository?.full_name, r.head_repository?.id, r.head_repository?.full_name];
    need(JSON.stringify(identity(run)) === JSON.stringify(identity(selected)), 'RUN_CHANGED');
    const attempt = await get('attempt', { runId });
    need(JSON.stringify(identity(attempt)) === JSON.stringify(identity(run)), 'ATTEMPT_MISMATCH');
    stage = 'APPROVAL_METADATA';
    const jobs = await pages('jobs', { runId }, 'jobs', 2);
    const approvals = await get('approvals', { runId }), environment = await get('environment');
    const artifacts = await pages('artifacts', { runId }, 'artifacts', 100);
    const name = `approved-release-${sha}-${runId}-1`;
    const matches = artifacts.artifacts.filter(a => a.name === name);
    need(matches.length === 1, 'ARTIFACT_AMBIGUOUS');
    const artifact = await get('artifact', { artifactId: String(matches[0].id) });
    const artifactIdentity = a => [a.id, a.name, a.digest, a.size_in_bytes, a.expired, a.created_at, a.expires_at,
      a.workflow_run?.id, a.workflow_run?.repository_id, a.workflow_run?.head_repository_id, a.workflow_run?.head_sha, a.workflow_run?.head_branch];
    need(JSON.stringify(artifactIdentity(artifact)) === JSON.stringify(artifactIdentity(matches[0])), 'ARTIFACT_CHANGED');
    stage = 'WORKFLOW_PINS';
    const files = {};
    for (const path of PINNED_PATHS) files[path] = { ref: sha, body: await get('content', { path, sha }) };
    validateWorkflowPolicy(workflow, sha, files, policy.workflow);
    stage = 'ARCHIVE';
    clock(); const bytes = await transport.downloadArtifact(String(artifact.id), credential); clock();
    const parsed = await readReleaseArchive(bytes, artifact);
    const createdAt = Math.floor(githubTime(artifact.created_at));
    const input = { repository: repository.full_name, branch: 'main', mainSha: sha, runId, attempt: '1',
      artifactId: String(artifact.id), artifactCreatedAt: createdAt,
      permissionUpdatedAt: Math.floor(githubTime(variable.updated_at)), expiresAt: createdAt + MAX_APPROVAL_SECONDS,
      releaseEnabled: variable.value, ...local };
    const responses = { repository, workflow, run, jobs, approvals, environment, mainRef, variable, artifacts };
    stage = 'CONSISTENCY';
    const result = checkCandidate({ record: parsed.record, input, responses, policy: policy.github, archiveBytes: bytes }, clock());
    stage = 'RECHECK';
    const finalMain = await get('main'), finalPermission = await get('permission'), finalRun = await get('run', { runId });
    need(finalMain.ref === mainRef.ref && finalMain.object?.type === 'commit' && finalMain.object.sha === sha, 'MAIN_CHANGED');
    need(finalPermission.name === variable.name && finalPermission.value === 'true' &&
      finalPermission.updated_at === variable.updated_at, 'PERMISSION_CHANGED');
    need(JSON.stringify(identity(finalRun)) === JSON.stringify(identity(run)) && finalRun.updated_at === run.updated_at, 'RUN_CHANGED');
    const finalRuns = await pages('runs', { sha }, 'workflow_runs', 500);
    need(finalRuns.workflow_runs.length > 0 && finalRuns.workflow_runs.every(r => r.head_sha === sha && r.head_branch === 'main' &&
      r.event === 'push' && r.workflow_id === workflow.id), 'RUN_LIST_CHANGED');
    const latest = finalRuns.workflow_runs.reduce((a, b) => a.id > b.id ? a : b);
    need(JSON.stringify(identity(latest)) === JSON.stringify(identity(selected)), 'LATEST_RUN_CHANGED');
    const finalArtifact = await get('artifact', { artifactId: String(artifact.id) });
    need(JSON.stringify(artifactIdentity(finalArtifact)) === JSON.stringify(artifactIdentity(artifact)), 'ARTIFACT_CHANGED');
    need(clock() < result.expiresAt, 'APPROVAL_EXPIRED');
    // resultは実通信の証明ではない。state.mjsのauthorized入口も追加しない。
    const summary = { ...result, acquisition: 'mock-only', workflowPins: 'compared_not_authenticated' };
    mockEvidence.set(summary, { summary: JSON.stringify(summary), evidence: {
      githubData: { record: parsed.record, input, responses, policy: policy.github, archiveBytes: bytes },
      workflow: { files, policy: policy.workflow },
    } });
    return summary;
  } catch { const error = new Error('MOCK_ACQUISITION_REJECTED'); error.stage = stage; throw error; }
}
