import { Workspace } from "@/components/siteflow/workspace";
import Link from "next/link";
export default function Home() { return <>
  {process.env.NODE_ENV === 'development' && <nav aria-label="接続版への移動" style={{ padding: '10px 24px', background: '#e8f1ed', fontSize: 14 }}><Link href="/workspace">ログインしてDB接続版を開く →</Link></nav>}
  <Workspace />
</>; }
