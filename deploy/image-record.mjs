import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function verifiedImageDigest(image, repository, sha) {
  if (repository !== 'ghcr.io/syucream02/siteflow' || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('INVALID_IMAGE_IDENTITY');
  if (image?.Config?.Labels?.['org.opencontainers.image.revision'] !== sha) throw Error('IMAGE_REVISION_MISMATCH');
  const refs = [...new Set((image.RepoDigests ?? []).filter(ref => ref.startsWith(repository + '@')))];
  if (refs.length !== 1 || !new RegExp('^' + repository.replaceAll('.', '\\.') + '@sha256:[a-f0-9]{64}$').test(refs[0])) throw Error('IMMUTABLE_IMAGE_DIGEST_REQUIRED');
  return refs[0].slice(repository.length + 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_REPOSITORY !== 'syucream02/siteflow' || !process.env.GITHUB_OUTPUT) throw Error('CI_CONTEXT_REQUIRED');
    const sha = process.env.GITHUB_SHA;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('INVALID_REVISION');
    const repository = 'ghcr.io/syucream02/siteflow';
    const digests = ['','-migration'].map(suffix => {
      const result = spawnSync('docker', ['image','inspect',`${repository}:${sha}${suffix}`], { encoding:'utf8', stdio:'pipe', timeout:30000 });
      if (result.status !== 0) throw Error('IMAGE_INSPECTION_FAILED');
      return verifiedImageDigest(JSON.parse(result.stdout)[0], repository, sha);
    });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digests[0]}\nmigration_digest=${digests[1]}\n`);
  } catch { console.error('CI_IMAGE_IDENTITY_REJECTED'); process.exitCode=1; }
}
