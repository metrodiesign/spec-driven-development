import { Badge } from "@/app/components/ui/Badge";
import { Card } from "@/app/components/ui/Card";
import { Container } from "@/app/components/ui/Container";
import { Icon } from "@/app/components/ui/Icon";
import { SectionHeading } from "@/app/components/ui/SectionHeading";
import { SmartImage } from "@/app/components/ui/SmartImage";
import { ARTICLES } from "@/app/data/articles";

const TH_MONTHS = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

function formatThaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

// กริดบทความ >= 8 + author avatar — REQ-10.1
export function Articles() {
  return (
    <section
      id="articles"
      aria-labelledby="articles-heading"
      className="bg-bg py-14 lg:py-20"
    >
      <Container>
        <SectionHeading
          eyebrow="ความรู้ประกันและการเงิน"
          title="บทความแนะนำสำหรับคุณ"
          description="อัปเดตความรู้เรื่องประกันและการวางแผนการเงินจากผู้เชี่ยวชาญ"
          action={
            <a
              href="#articles"
              className="inline-flex items-center gap-1.5 text-body font-semibold text-primary transition-colors hover:text-primary-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              ดูบทความทั้งหมด
              <Icon name="arrowRight" size={18} />
            </a>
          }
        />
        <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {ARTICLES.map((a) => (
            <li key={a.id}>
              <Card interactive>
                <a
                  href="#articles"
                  className="flex h-full flex-col focus-visible:outline-none"
                >
                  <div className="relative aspect-[5/3] w-full bg-bg">
                    <SmartImage
                      src={a.imageUrl}
                      alt={a.title}
                      fill
                      sizes="(max-width:640px) 100vw, (max-width:1024px) 50vw, 25vw"
                      className="object-cover"
                      fallbackIcon="document"
                    />
                  </div>
                  <div className="flex flex-1 flex-col gap-3 p-5">
                    <span className="self-start">
                      <Badge tone="accent">{a.category}</Badge>
                    </span>
                    <h3 className="text-h3 leading-snug text-text">
                      {a.title}
                    </h3>
                    <div className="mt-auto flex items-center gap-3 pt-2">
                      <span className="relative h-9 w-9 overflow-hidden rounded-full bg-bg">
                        <SmartImage
                          src={a.author.avatarUrl}
                          alt={a.author.name}
                          fill
                          sizes="36px"
                          className="object-cover"
                          fallbackIcon="user"
                        />
                      </span>
                      <span className="flex flex-col">
                        <span className="text-caption font-medium text-text">
                          {a.author.name}
                        </span>
                        <span className="text-caption text-text-muted">
                          {formatThaiDate(a.date)}
                        </span>
                      </span>
                    </div>
                  </div>
                </a>
              </Card>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
