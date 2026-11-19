import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedImageDigest } from '../deploy/image-record.mjs';
import { releaseEnabled } from '../deploy/release-record.mjs';
const repo='ghcr.io/syucream02/siteflow', sha='a'.repeat(40), digest='sha256:'+'b'.repeat(64);
const image=()=>({Config:{Labels:{'org.opencontainers.image.revision':sha}},RepoDigests:[repo+'@'+digest]});
test('公開するrepositoryのdigestとGit revisionを一緒に確認する',()=>{
  const value=image();value.RepoDigests.unshift('other.example/image@sha256:'+'c'.repeat(64));
  assert.equal(verifiedImageDigest(value,repo,sha),digest);
});
test('revision不一致・タグ・別repo・曖昧なdigestは拒否する',()=>{
  const revision=image();revision.Config.Labels['org.opencontainers.image.revision']='c'.repeat(40);
  assert.throws(()=>verifiedImageDigest(revision,repo,sha));
  for(const refs of [[],[repo+':latest'],['other/image@'+digest],[repo+'@'+digest,repo+'@sha256:'+'d'.repeat(64)]]){
    assert.throws(()=>verifiedImageDigest({...image(),RepoDigests:refs},repo,sha));
  }
  assert.throws(()=>verifiedImageDigest(image(),'other/image',sha));
});
test('許可スイッチは明示trueだけ有効、未設定は無効、誤記は拒否する',()=>{
  assert.equal(releaseEnabled('true'),true);
  for(const value of [undefined,'','false'])assert.equal(releaseEnabled(value),false);
  for(const value of ['TRUE','yes','1'])assert.throws(()=>releaseEnabled(value));
});
