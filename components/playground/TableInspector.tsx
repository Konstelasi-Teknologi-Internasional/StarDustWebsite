'use client';

import WorldInspector from './WorldInspector';
import styles from './TableInspector.module.css';

/**
 * Section B — what that became in MySQL.
 *
 * Section A wrote rows. This one shows which rows, in which tables, with the
 * engine's own column names — and shows just as deliberately the tables that
 * are still empty, because the absences are the lesson:
 *
 * - Marking a field filterable wrote `is_filterable = 1` to the registry and
 *   nothing anywhere else. There is no slot row. There is not even a page.
 * - `bootstrap()` creates the schema and provisions no capacity. The first
 *   `entry_slots_page_N` table does not exist until something needs one.
 *
 * The `DDL` toggle on each panel is what keeps the section honest: the claim
 * is that these are the engine's columns, and a reader who does not believe it
 * can read the `CREATE TABLE` without leaving the page.
 */
export default function TableInspector() {
  return (
    <section className={styles.section} id="tables" aria-labelledby="tables-title" tabIndex={-1}>
      <p className="eyebrow">section b</p>
      <h2 id="tables-title" className={styles.title}>
        What that became in MySQL
      </h2>
      <p className="section-lede">
        Same names, same columns, same nullability as the schema{' '}
        <code>bootstrap()</code> creates — open the <code>DDL</code> on any panel and
        check. What you defined above is in the registry tables. Everything else is
        empty, and stays empty until something specific makes it otherwise.
      </p>

      <div className={styles.beats}>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>Metadata and storage are different tables</h3>
          <p>
            The registry describes your models; the data plane holds your data. Defining
            a field wrote to the first and not the second, which is why{' '}
            <code>stardust_fields</code> has a row saying <code>is_filterable = 1</code>{' '}
            while <code>stardust_slot_assignments</code> has nothing at all. The gap
            between those two is not a bug being fixed later — it is a promise waiting
            for a daemon to keep it.
          </p>
        </div>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>
            <code>entry_data.fields</code> is keyed by name
          </h3>
          <p>
            Not by field id. That one encoding choice is why renaming a field cannot be
            an <code>UPDATE</code> on a registry row: every stored payload in the model
            is on the old key, and all of them have to be rewritten. Worth noticing now,
            because it is what makes renaming a field under load interesting later.
          </p>
        </div>
      </div>

      <WorldInspector />
    </section>
  );
}
