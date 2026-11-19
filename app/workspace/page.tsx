import Link from 'next/link';
import { ConnectedWorkspace } from '@/components/siteflow/connected-workspace';
import { headers } from 'next/headers';
import { readWorkspaceConnection, workspacePageEnabled } from '@/lib/siteflow/workspace-connection';

export const dynamic = 'force-dynamic';

export default async function WorkspacePage() {
  const connection = readWorkspaceConnection(process.env);
  const host = (await headers()).get('host');
  if (!workspacePageEnabled(connection, host)) return <main style={{ maxWidth: 640, margin: '60px auto', padding: 24 }}>
    <h1>SiteFlow 案件ワークスペース</h1><p>この接続では案件ワークスペースを利用できません。プレビューの準備状況を確認してください。</p><Link href="/">指摘管理デモへ</Link>
  </main>;
  return <ConnectedWorkspace connection={connection.mode === 'public' || connection.mode === 'public-integrated' ? 'public' : 'local'} />;
}
