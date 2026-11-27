import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectSearchQuery, withoutKnownTrackingParameters } from '../lib/siteflow/domain.ts';

test('案件検索はページ既定値と空条件を正規化する', () => {
  assert.deepEqual(parseProjectSearchQuery(new URLSearchParams('q=%20%20')), { limit: 20 });
});
test('案件検索の全条件と境界を受理する', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.deepEqual(parseProjectSearchQuery(new URLSearchParams({ q: ' 橋梁%_\\ ', primaryUserId: id, supportUserId: id, status: 'DONE', progressMin: '0', progressMax: '100', limit: '50', cursor: id })),
    { limit: 50, cursor: id, q: '橋梁%_\\', primaryUserId: id, supportUserId: id, status: 'DONE', progressMin: 0, progressMax: 100 });
});
test('画面URLでは既知のUTM計測値を検索条件から分離し、業務条件を維持する', () => {
  const params = withoutKnownTrackingParameters(new URLSearchParams('team=team-id&view=projects&utm_source=chat&utm_campaign=portfolio&q=橋梁&status=REVIEW'));
  params.delete('team'); params.delete('view');
  assert.deepEqual([...params.entries()], [['q', '橋梁'], ['status', 'REVIEW']]);
  assert.deepEqual(parseProjectSearchQuery(params), { limit: 20, q: '橋梁', status: 'REVIEW' });
});
test('既知UTM値が重複していても画面の検索条件を壊さない', () => {
  const params = withoutKnownTrackingParameters(new URLSearchParams('utm_source=a&utm_source=b&q=橋梁'));
  assert.deepEqual(parseProjectSearchQuery(params), { limit: 20, q: '橋梁' });
});
test('未知のURLパラメーターは画面側でも検索条件エラーとして維持する', () => {
  const params = withoutKnownTrackingParameters(new URLSearchParams('q=橋梁&unexpected=value'));
  assert.equal(parseProjectSearchQuery(params), null);
});
for (const query of ['other=x', 'q=a&q=b', 'status=DONE&status=REVIEW', 'primaryUserId=x', 'supportUserId=x', 'status=done', 'progressMin=-1', 'progressMax=101', 'progressMin=1.5', 'progressMin=01', 'progressMin=', 'progressMin=60&progressMax=40', 'limit=51', 'cursor=x', 'q=%00', 'q=%0A', 'q=' + 'a'.repeat(101)]) {
  test(`案件検索は不正な条件を拒否する: ${query.slice(0, 45)}`, () => assert.equal(parseProjectSearchQuery(new URLSearchParams(query)), null));
}
test('進捗100％の検索で完了状態を勝手に追加しない', () => {
  assert.deepEqual(parseProjectSearchQuery(new URLSearchParams('progressMin=100')), { limit: 20, progressMin: 100 });
});
test('キーワードは空白分割や互換文字変換をしない', () => {
  assert.equal(parseProjectSearchQuery(new URLSearchParams({ q: '橋梁 Ａ' })).q, '橋梁 Ａ');
});
