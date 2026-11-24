import { createHash } from 'node:crypto';
import { exactFields, need, WORKFLOW } from './contract.mjs';
import { PINNED_PATHS } from './transport.mjs';

// policy.hashesは別途レビューした固定値。取得した内容から自動採用してはいけない。
// この関数でも取得経路・レビュー実施自体の真正性は証明しない。
export function validateWorkflowPolicy(workflow, sha, files, policy) {
  exactFields(policy, ['workflowId', 'hashes'], 'INVALID_WORKFLOW_POLICY');
  exactFields(policy.hashes, PINNED_PATHS, 'INCOMPLETE_WORKFLOW_PINS');
  exactFields(files, PINNED_PATHS, 'INCOMPLETE_WORKFLOW_FILES');
  need(Number.isSafeInteger(policy.workflowId) && policy.workflowId > 0 && workflow?.id === policy.workflowId &&
    workflow.path === WORKFLOW && workflow.state === 'active' && /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha), 'WORKFLOW_TARGET_MISMATCH');
  for (const path of PINNED_PATHS) {
    const expected = policy.hashes[path];
    need(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) && !/^0+$/.test(expected), 'WORKFLOW_PIN_UNSET');
    const file = files[path]; exactFields(file, ['ref', 'body'], 'INVALID_WORKFLOW_FILE');
    const b = file.body;
    need(file.ref === sha && b?.type === 'file' && b.path === path && b.encoding === 'base64' &&
      typeof b.content === 'string' && Number.isSafeInteger(b.size) && b.size > 0 && b.size <= 131072, 'WORKFLOW_CONTENT_MISMATCH');
    const encoded = b.content.replaceAll('\n', '');
    need(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'INVALID_CONTENT_ENCODING');
    const bytes = Buffer.from(encoded, 'base64');
    need(bytes.toString('base64') === encoded && bytes.length === b.size, 'INVALID_CONTENT_ENCODING');
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    need(b.sha === blob && createHash('sha256').update(bytes).digest('hex') === expected, 'WORKFLOW_HASH_MISMATCH');
  }
  return { status: 'mock_workflow_pins_match', executionAllowed: false };
}
