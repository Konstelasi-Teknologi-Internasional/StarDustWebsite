export default function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
}: {
  id: string;
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="section" id={id}>
      <div className="shell">
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="section-title">{title}</h2>
        {lede && <p className="section-lede">{lede}</p>}
        {children}
      </div>
    </section>
  );
}
