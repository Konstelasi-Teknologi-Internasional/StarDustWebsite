import styles from './Fit.module.css';

const GOOD = [
  'You need user-defined or per-tenant dynamic fields that are still filterable at native index speed, without standing up a search cluster.',
  'You already run MySQL 8.0.13+ or Percona, and can keep background processes alive — systemd, supervisor, or containers.',
  'You want a framework-neutral engine you drop in via Composer. No ORM, no query builder, nothing pulled into your app.',
  'You can tolerate a newly filterable field becoming queryable shortly after the fact rather than instantly.',
];

const BAD = [
  'Cron-only or shell-less shared hosting. Without a running Watcher, slot capacity is never replenished and new filterable writes fall back to unindexed JSON.',
  'MariaDB, or MySQL 5.7 and older. Both are actively rejected at boot — CI keeps a job that expects the suite to fail on MariaDB.',
  'Strong read-after-write consistency on filters immediately after a retype or promotion. The field serves from JSON until its backfill lands.',
  'Full-text, fuzzy, or substring search. The default driver ships exact match, comparison, range, set membership, and anchored prefix — nothing else.',
  'Page numbers, jump-to-page, or a total result count. Reads are cursor-paginated and forward-sequential, deliberately.',
];

export default function Fit() {
  return (
    <div className={styles.grid}>
      <div className={`panel ${styles.card} ${styles.good}`}>
        <div className="panel-head">
          <span>a good fit if</span>
          <span className="tag tag-indexed">
            <span className="dot" />
            yes
          </span>
        </div>
        <ul className={styles.list}>
          {GOOD.map(t => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>

      <div className={`panel ${styles.card} ${styles.bad}`}>
        <div className="panel-head">
          <span>probably not a fit if</span>
          <span className="tag tag-error">
            <span className="dot" />
            no
          </span>
        </div>
        <ul className={styles.list}>
          {BAD.map(t => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
