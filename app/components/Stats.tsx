import { Container } from "@/app/components/ui/Container";
import { Icon } from "@/app/components/ui/Icon";
import { STATS } from "@/app/data/stats";

// แถบสถิติพื้นกรมท่า >= 4 ตัวเลข — REQ-9.1, 17.4
export function Stats() {
  return (
    <section
      id="stats"
      aria-labelledby="stats-heading"
      className="relative overflow-hidden bg-primary py-14 text-surface lg:py-20"
    >
      {/* ลวดลายพื้นหลังจาง */}
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full opacity-10"
        aria-hidden="true"
      >
        <defs>
          <pattern
            id="stats-grid"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="2" cy="2" r="1.5" fill="#FDB913" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#stats-grid)" />
      </svg>

      <Container className="relative">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-accent">
            ความมั่นคงที่พิสูจน์ได้
          </p>
          <h2 id="stats-heading" className="text-surface">
            เคียงข้างคนไทยมากว่า 75 ปี
          </h2>
        </div>
        <dl className="grid grid-cols-2 gap-6 lg:grid-cols-5">
          {STATS.map((s) => (
            <div
              key={s.id}
              className="flex flex-col items-center gap-2 rounded-lg border border-surface/10 bg-surface/5 p-5 text-center"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Icon name={s.icon} size={24} />
              </span>
              <dd className="text-h2 font-bold text-surface">{s.value}</dd>
              <dt className="text-caption text-surface/80">{s.label}</dt>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
