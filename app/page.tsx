import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import styles from './page.module.css';

export const metadata: Metadata = {
  title: 'SiteFlow | チームの仕事を、ひとつの場所に。',
  description: '案件の担当・進捗・変更の経緯を共有し、進捗会議の確認事項や次の対応につなげる業務管理ツールです。',
};

const features = [
  { number: '01', title: '案件管理', text: '担当・進捗・状態と変更の経緯を、チームで確認できます。', image: '/siteflow/project-search.png', alt: '架空データで案件名、担当、状態、進捗率を絞り込む案件一覧' },
  { number: '02', title: '進捗会議と記録', text: '案件の確認状況と前回からの変化を、会議の記録に残します。', image: '/siteflow/meeting-records.png', alt: '架空データの会議画面で相談内容と記録を確認している様子' },
  { number: '03', title: '対応事項の引き継ぎ', text: '次回までの対応と担当を記録し、未対応の内容を選んで引き継げます。', image: '/siteflow/meeting-records.png', alt: '架空データの会議画面に表示された次回までの対応事項' },
  { number: '04', title: 'チーム管理', text: 'チームのメンバーや役割を、権限に応じて管理します。', image: '/siteflow/team-management.png', alt: '架空データのチーム設定画面でメンバーと役割を確認している様子' },
];

export default function Home() {
  return <main className={styles.page}>
    <a className={styles.skipLink} href="#main">本文へ移動</a>
    <header className={styles.header}>
      <Link className={styles.brand} href="/" aria-label="SiteFlow ホーム">SiteFlow<span>チームの仕事を、ひとつの場所に。</span></Link>
      <Link className={styles.headerLink} href="/workspace">既存アカウントでログイン</Link>
    </header>

    <div id="main">
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>TEAM PROJECT WORKSPACE</p>
          <h1 id="hero-title">チームの仕事を、<br />ひとつの場所に。</h1>
          <p className={styles.lead}>案件の担当・進捗・変更の経緯を共有し、進捗会議の確認事項や次の対応につなげる業務管理ツールです。</p>
          <div className={styles.actions}>
            <Link className={styles.primaryButton} href="/demo">デモを試す<span aria-hidden="true">→</span></Link>
            <Link className={styles.secondaryButton} href="/workspace">ログイン</Link>
          </div>
          <p className={styles.loginHint}>ログインは既存アカウント向けです。新規登録は受け付けていません。</p>
        </div>
        <figure className={styles.heroImage}>
          <div className={styles.heroCrop}><Image src="/siteflow/project-search.png" alt="架空データの案件一覧と検索条件" fill priority sizes="(max-width: 800px) 100vw, 55vw" /></div>
          <figcaption>統合版の案件一覧 · ローカル検証画面・架空データ</figcaption>
        </figure>
      </section>

      <section className={styles.problem} aria-labelledby="problem-title">
        <p className={styles.eyebrow}>WHY SITEFLOW</p>
        <h2 id="problem-title">担当や進捗が分散して、次の動きが見えにくい。</h2>
        <p>案件の現在地だけでなく、会議で確認したことや、次に誰が対応するかを同じ流れでたどれるようにします。</p>
      </section>

      <section className={styles.features} aria-labelledby="features-title">
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>WORKFLOW</p><h2 id="features-title">日々の確認を、次の対応へ。</h2></div><p>実装済みの機能を、架空データの画面で紹介します。</p></div>
        <div className={styles.featureGrid}>
          {features.map((feature, index) => <article className={styles.featureCard} key={feature.number}>
            <div className={styles.featureImage}>
              <Image src={feature.image} alt={feature.alt} width={1440} height={1080} loading={index === 0 ? 'eager' : 'lazy'} />
              <span>ローカル検証画面</span>
            </div>
            <div className={styles.featureText}><span className={styles.featureNumber}>{feature.number}</span><h3>{feature.title}</h3><p>{feature.text}</p></div>
          </article>)}
        </div>
      </section>

      <section className={styles.demo} aria-labelledby="demo-title">
        <div><p className={styles.eyebrow}>TRY THE DEMO</p><h2 id="demo-title">まずは、気軽に操作してみる。</h2><p>アカウント登録は不要です。デモはブラウザー内で動き、入力した内容は業務データベースへ保存されません。再読み込みすると初期状態に戻ります。</p><p className={styles.demoLimit}>デモは一部機能の体験版です。統合版の案件検索・会議・チーム管理を操作する場合は、別途ログインが必要です。</p></div>
        <Link className={styles.primaryButton} href="/demo">インメモリデモを開く<span aria-hidden="true">→</span></Link>
      </section>
    </div>

    <footer className={styles.footer}><span>SiteFlow</span><span>架空データを使った学習用ポートフォリオ</span><Link href="/workspace">既存アカウントのログイン</Link></footer>
  </main>;
}
