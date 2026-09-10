import CodeBlock from '@/components/CodeBlock';
import DaemonBoard from '@/components/DaemonBoard';
import FieldLifecycle from '@/components/FieldLifecycle';
import Fit from '@/components/Fit';
import Footer from '@/components/Footer';
import Hero from '@/components/Hero';
import JoinSwamp from '@/components/JoinSwamp';
import Nav from '@/components/Nav';
import Section from '@/components/Section';
import { DOCS } from '@/lib/links';
import SlotMirror from '@/components/SlotMirror';
import styles from './page.module.css';

const QUICKSTART = `docker compose up          # MySQL + bootstrap + seed + all four daemons
docker compose logs init   # the seeded query, already answered`;

const WIRE = `{
  "version": "1",
  "filter": {
    "op": "and",
    "args": [
      { "op": "eq", "field": { "model": "invoice", "name": "status" }, "value": "paid" },
      { "op": "gt", "field": { "model": "invoice", "name": "amount" }, "value": 100 },
      { "op": "is_not_null", "field": { "model": "invoice", "name": "due_date" } }
    ]
  }
}`;

const BOOTSTRAP = `use StarDust\\Config\\Config;
use StarDust\\StarDust;

$engine = new StarDust(new Config(pdo: $pdo));
$engine->bootstrap();   // idempotent, non-destructive

$model = $engine->schemaBuilder()->createModel(1, 'company', [
    new FieldDefinition('name',      'string', isFilterable: true),
    new FieldDefinition('employees', 'int',    isFilterable: true),
    new FieldDefinition('city',      'string'),
]);`;

export default function IdHome() {
  return (
    <>
      <Nav />
      <main id="main">
        <Hero />

        <Section
          id="mirror"
          eyebrow="01 · tempat data berada"
          title="Satu baris sumber utama, dicerminkan ke dalam indeks."
          lede={
            <>
              Payload JSON lengkap selalu merupakan sistem catatan sumber. Field yang Anda tandai
              sebagai dapat difilter secara tambahan dicerminkan ke kolom slot bertipe dan terindeks
              pada extension page 1:1 — jadi filter membaca indeks asli, bukan memindai JSON. Edit
              payload di bawah, lalu write.
            </>
          }
        >
          <SlotMirror />
        </Section>

        <Section
          id="joins"
          eyebrow="02 · mengapa bukan EAV"
          title="Setiap kondisi EAV adalah self-join lain."
          lede={
            <>
              Tabel atribut klasik membuat pertanyaan yang lebih spesifik menjadi lebih mahal, karena
              setiap atribut yang difilter memerlukan join-nya sendiri dan hasil antaranya harus
              dibawa melalui semuanya. StarDust cukup join satu page, sekali, tidak peduli berapa
              banyak kondisi yang Anda tumpuk di atasnya.
            </>
          }
        >
          <JoinSwamp />
        </Section>

        <Section
          id="lifecycle"
          eyebrow="03 · catatan jujur"
          title="Dapat difilter adalah janji yang daemon jaga, bukan instan."
          lede={
            <>
              Ini adalah perilaku yang membingungkan hampir semua orang, jadi mendapat bagiannya
              sendiri, bukan sekadar catatan kaki. Menandai field sebagai dapat difilter itu instan
              — cuma mencatat permintaan itu dan langsung kembali. Pekerjaan yang sebenarnya, yang
              membuat penyaringan itu benar-benar berfungsi, dikerjakan setelahnya oleh dua daemon
              latar belakang.
            </>
          }
        >
          <FieldLifecycle />
        </Section>

        <Section
          id="daemons"
          eyebrow="04 · bagian yang bergerak"
          title="Empat daemon. Tidak ada broker di antara mereka."
          lede={
            <>
              Mereka tidak pernah berbicara langsung satu sama lain — MySQL adalah satu-satunya titik
              koordinasi, dengan klaim diambil melalui <code>FOR UPDATE SKIP LOCKED</code> dan
              singleton dipegang oleh advisory lock. Jalankan lebih banyak Reconciler dan Chronicler
              untuk throughput; Watcher dan Liberator tetap masing-masing satu.
            </>
          }
        >
          <DaemonBoard />
        </Section>

        <Section
          id="status"
          eyebrow="05 · jawaban langsung"
          title="Apakah Anda sebaiknya benar-benar menggunakan ini."
          lede={
            <>
              StarDust adalah <strong>pre-release v0.3.0</strong>. <code>main</code> dan tag{' '}
              <code>0.3.x</code> merupakan migrasi arsitektur besar yang menjauh dari lini 0.2.x
              lama, didorong oleh batasan skalabilitas dan kerentanan OOM pada desain lama.{' '}
              <strong>Tidak ada lini yang telah mencapai 1.0.</strong> Jika Anda memerlukan sesuatu
              untuk dijalankan hari ini, <code>^0.2.0-alpha.x</code> adalah yang lebih stabil di
              antara keduanya dan masih menerima perbaikan kritis di <code>support/v0.2</code> —
              tetapi itu juga masih alpha, dan memilihnya berarti mengadopsi arsitektur yang sudah
              ditinggalkan proyek ini.
            </>
          }
        >
          <Fit />

          <div className={styles.reqs}>
            <div className={styles.req}>
              <span className={styles.reqLabel}>PHP</span>
              <strong>8.1+</strong>
              <em>diuji pada 8.1 – 8.4</em>
            </div>
            <div className={styles.req}>
              <span className={styles.reqLabel}>Database</span>
              <strong>MySQL 8.0.13+</strong>
              <em>atau Percona Server 8.0.13+</em>
            </div>
            <div className={styles.req}>
              <span className={styles.reqLabel}>Dependensi runtime</span>
              <strong>psr/log · psr/clock</strong>
              <em>hanya interface — tanpa framework, tanpa ORM</em>
            </div>
            <div className={styles.req}>
              <span className={styles.reqLabel}>Ditolak</span>
              <strong className={styles.no}>MariaDB · MySQL ≤ 5.7</strong>
              <em>menolak untuk memulai daripada merusak registry</em>
            </div>
          </div>
        </Section>

        <Section
          id="start"
          eyebrow="06 · mulai sekarang"
          title="Lima menit, satu perintah."
          lede="Menyalakan MySQL, mem-bootstrap skema, menyemai model contoh, menjalankan query yang difilter, dan memulai keempat daemon."
        >
          <div className={styles.startGrid}>
            <CodeBlock code={QUICKSTART} lang="bash" title="coba" copyable />
            <CodeBlock code={BOOTSTRAP} lang="php" title="atau pasang ke aplikasi Anda" copyable />
          </div>

          <div className={styles.wire}>
            <div className={styles.wireText}>
              <h3>Filter juga datang sebagai JSON.</h3>
              <p>
                Gateway HTTP jarang menyimpan AST PHP. Wire format ini di-decode menjadi filter tree
                tertutup yang sama — dua belas operator, AND/OR/NOT penuh, taksonomi error dengan
                tiga belas kode, dan setiap penolakan membawa JSON Pointer ke node yang bermasalah.
                Ini disediakan sebagai JSON Schema normatif sehingga klien Anda dapat memvalidasi
                dalam bahasa apa pun.
              </p>
              <a className="btn" href={DOCS} target="_blank" rel="noreferrer">
                Baca dokumentasi lengkap ↗
              </a>
            </div>
            <CodeBlock code={WIRE} lang="json" title="QueryFilter v1" />
          </div>
        </Section>
      </main>
      <Footer />
    </>
  );
}
