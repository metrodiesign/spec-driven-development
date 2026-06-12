import { Container } from "@/app/components/ui/Container";
import { Icon } from "@/app/components/ui/Icon";
import { SectionHeading } from "@/app/components/ui/SectionHeading";
import { SERVICES } from "@/app/data/services";

// กริดบริการ >= 12 + ไอคอน SVG + hover/focus state — REQ-6.1..6.3
export function Services() {
  return (
    <section
      id="services"
      aria-labelledby="services-heading"
      className="bg-surface py-14 lg:py-20"
    >
      <Container>
        <SectionHeading
          eyebrow="บริการออนไลน์"
          title="ทำธุรกรรมประกันได้ครบ จบในที่เดียว"
          description="เลือกบริการที่ต้องการ ใช้งานได้ตลอด 24 ชั่วโมง ไม่ต้องไปสาขา"
          action={
            <a
              href="#services"
              className="inline-flex items-center gap-1.5 text-body font-semibold text-primary transition-colors hover:text-primary-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              ดูทั้งหมด
              <Icon name="arrowRight" size={18} />
            </a>
          }
        />
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7 lg:gap-4">
          {SERVICES.map((s) => (
            <li key={s.id}>
              <a
                href={s.href}
                className="group flex h-full flex-col items-center gap-3 rounded-lg border border-border bg-surface p-4 text-center transition-all duration-200 hover:-translate-y-1 hover:border-primary hover:shadow-cardHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-border text-primary transition-colors duration-200 group-hover:bg-primary group-hover:text-surface">
                  <Icon name={s.icon} size={24} />
                </span>
                <span className="text-caption font-medium leading-tight text-text">
                  {s.label}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
