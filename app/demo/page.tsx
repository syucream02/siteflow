import type { Metadata } from 'next';
import { Workspace } from '@/components/siteflow/workspace';

export const metadata: Metadata = {
  title: 'インメモリデモ | SiteFlow',
  description: 'アカウント登録不要で操作できる、SiteFlowの一部機能の体験版です。データはブラウザー内だけで扱われ、再読み込みで初期状態に戻ります。',
};

export default function DemoPage() {
  return <Workspace />;
}
