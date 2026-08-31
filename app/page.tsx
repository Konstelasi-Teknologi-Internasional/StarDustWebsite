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

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />

        <Section
          id="mirror"
          eyebrow="01 · where the data lives"
          title="One row of truth, mirrored into an index."
          lede={
            <>
              The complete JSON payload is always the system of record. Fields you mark
              filterable are <em>additionally</em> mirrored into typed, indexed slot
              columns on a 1:1 extension page — so a filter reads a real index instead of
              scanning JSON. Edit the payload below and write it.
            </>
          }
        >
          <SlotMirror />
        </Section>

        <Section
          id="joins"
          eyebrow="02 · why not EAV"
          title="Every EAV condition is another self-join."
          lede={
            <>
              The classic attribute table makes a narrower question cost more, because each
              filtered attribute needs its own join and the intermediate result has to be
              carried through all of them. StarDust joins one page, once, no matter how many
              conditions you stack on it.
            </>
          }
        >
          <JoinSwamp />
        </Section>

        <Section
          id="lifecycle"
          eyebrow="03 · the honest caveat"
          title="Filterable is a promise the daemons keep, not an instant."
          lede={
            <>
              This is the behaviour that trips up nearly everyone, so it gets its own section
              rather than a footnote. Marking a field filterable records an intention and
              returns immediately — two background daemons then do the work that makes
              filtering actually possible.
            </>
          }
        >
          <FieldLifecycle />
        </Section>

        <Section
          id="daemons"
          eyebrow="04 · the moving parts"
          title="Four daemons. No broker between them."
          lede={
            <>
              They never talk to each other directly — MySQL is the only coordination point,
              with claims taken under <code>FOR UPDATE SKIP LOCKED</code> and singletons held
              by advisory lock. Run more Reconcilers and Chroniclers for throughput; the
              Watcher and Liberator stay one apiece.
            </>
          }
        >
          <DaemonBoard />
        </Section>

        <Section
          id="status"
          eyebrow="05 · straight answers"
          title="Whether you should actually use this."
          lede={
            <>
              StarDust is a <strong>v0.3.0 pre-release</strong>. <code>main</code> and the{' '}
              <code>0.3.x</code> tags are a breaking architectural migration away from the
              legacy 0.2.x line, driven by scalability limits and OOM vulnerabilities in the
              old design. <strong>Neither line has reached 1.0.</strong> If you need
              something to run today, <code>^0.2.0-alpha.x</code> is the more settled of the
              two and still receives critical fixes on <code>support/v0.2</code> — but it is
              an alpha as well, and choosing it means adopting an architecture this project
              has already moved off.
            </>
          }
        >
          <Fit />

          <div className={styles.reqs}>
            <div className={styles.req}>
              <span className={styles.reqLabel}>PHP</span>
              <strong>8.1+</strong>
              <em>tested on 8.1 – 8.4</em>
            </div>
            <div className={styles.req}>
              <span className={styles.reqLabel}>Database</span>
              <strong>MySQL 8.0.13+</strong>
              <em>or Percona Server 8.0.13+</em>
            </div>
            <div className={styles.req}>
              <span className={styles.reqLabel}>Runtime deps</span>
              <strong>psr/log · psr/clock</strong>
              <em>interfaces only — no framework, no ORM</em>
            </div>
            <div className={styles.req}>
              <span className={styles.reqLabel}>Rejected</span>
              <strong className={styles.no}>MariaDB · MySQL ≤ 5.7</strong>
              <em>refuses to start rather than corrupt the registry</em>
            </div>
          </div>
        </Section>

        <Section
          id="start"
          eyebrow="06 · get started"
          title="Five minutes, one command."
          lede="Brings up MySQL, bootstraps the schema, seeds a sample model, runs a filtered query, and starts all four daemons."
        >
          <div className={styles.startGrid}>
            <CodeBlock code={QUICKSTART} lang="bash" title="try it" copyable />
            <CodeBlock code={BOOTSTRAP} lang="php" title="or wire it into your app" copyable />
          </div>

          <div className={styles.wire}>
            <div className={styles.wireText}>
              <h3>Filters arrive as JSON, too.</h3>
              <p>
                HTTP gateways rarely hold a PHP AST. The wire format decodes into the same
                closed filter tree — twelve operators, full AND/OR/NOT, a thirteen-code error
                taxonomy, and every rejection carries a JSON Pointer to the offending node.
                It ships as a normative JSON Schema so your clients can validate in any
                language.
              </p>
              <a className="btn" href={DOCS} target="_blank" rel="noreferrer">
                Read the full documentation ↗
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
