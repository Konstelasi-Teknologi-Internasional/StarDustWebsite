'use client';

import { useTranslations } from '@/lib/i18n';
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
  const t = useTranslations('playground');

  return (
    <section className={styles.section} id="tables" aria-labelledby="tables-title" tabIndex={-1}>
      <p className="eyebrow">{t('tableInspector.eyebrow')}</p>
      <h2 id="tables-title" className={styles.title}>
        {t('tableInspector.title')}
      </h2>
      <p className="section-lede">
        {t('tableInspector.lede1')}
        <code>bootstrap()</code>
        {t('tableInspector.lede2')}
        <code>DDL</code>
        {t('tableInspector.lede3')}
      </p>

      <div className={styles.beats}>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>{t('tableInspector.beat1Title')}</h3>
          <p>
            {t('tableInspector.beat1Body1')}
            <code>stardust_fields</code>
            {t('tableInspector.beat1Body2')}
            <code>is_filterable = 1</code>
            {t('tableInspector.beat1Body3')}
            <code>stardust_slot_assignments</code>
            {t('tableInspector.beat1Body4')}
          </p>
        </div>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>
            <code>entry_data.fields</code>
            {t('tableInspector.beat2TitleSuffix')}
          </h3>
          <p>
            {t('tableInspector.beat2Body1')}
            <code>UPDATE</code>
            {t('tableInspector.beat2Body2')}
          </p>
        </div>
      </div>

      <WorldInspector />
    </section>
  );
}
