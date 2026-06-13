import { Container } from "@/app/components/ui/Container";
import { Icon, type IconName } from "@/app/components/ui/Icon";

const COLUMNS: { heading: string; links: { label: string; href: string }[] }[] =
  [
    {
      heading: "ผลิตภัณฑ์",
      links: [
        { label: "ประกันชีวิต", href: "#insurance-types" },
        { label: "ประกันสุขภาพ", href: "#insurance-types" },
        { label: "ประกันรถยนต์", href: "#insurance-types" },
        { label: "ประกันเดินทาง", href: "#insurance-types" },
        { label: "ประกันอุบัติเหตุ", href: "#insurance-types" },
      ],
    },
    {
      heading: "ศูนย์บริการ",
      links: [
        { label: "สาขาภาคกลาง", href: "#services" },
        { label: "สาขาภาคเหนือ", href: "#services" },
        { label: "สาขาภาคอีสาน", href: "#services" },
        { label: "สาขาภาคใต้", href: "#services" },
        { label: "ค้นหาสาขาใกล้คุณ", href: "#services" },
      ],
    },
    {
      heading: "เกี่ยวกับเรา",
      links: [
        { label: "ประวัติบริษัท", href: "#stats" },
        { label: "ข่าวสารและกิจกรรม", href: "#articles" },
        { label: "ร่วมงานกับเรา", href: "#stats" },
        { label: "นักลงทุนสัมพันธ์", href: "#stats" },
        { label: "ติดต่อเรา", href: "#services" },
      ],
    },
  ];

const SOCIAL: { icon: IconName; label: string }[] = [
  { icon: "facebook", label: "Facebook" },
  { icon: "line", label: "LINE" },
  { icon: "youtube", label: "YouTube" },
  { icon: "instagram", label: "Instagram" },
];

// footer ไดเรกทอรีหลายคอลัมน์ + ยุบมือถือ — REQ-13.1, 13.2
export function Footer() {
  return (
    <footer className="bg-primary text-surface">
      <Container className="pt-12 pb-6 lg:pt-16 lg:pb-8">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          {/* brand + contact */}
          <div>
            <div className="flex items-center gap-2.5">
              <svg
                width="36"
                height="36"
                viewBox="0 0 40 40"
                aria-hidden="true"
              >
                <path
                  d="M20 3 5 8v9c0 8.5 5.7 14.4 15 18 9.3-3.6 15-9.5 15-18V8Z"
                  fill="#FDB913"
                />
                <path
                  d="M13 19l4.5 4.5L28 13"
                  fill="none"
                  stroke="#0E1C50"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-h3 font-bold text-surface">
                วิริยะประกันภัย
              </span>
            </div>
            <p className="mt-4 max-w-xs text-caption text-surface/75">
              บริษัท วิริยะประกันภัย จำกัด (มหาชน)
              เคียงข้างคนไทยด้วยความคุ้มครองที่ไว้ใจได้มากว่า 75 ปี
            </p>
            <div className="mt-4 flex items-center gap-2 text-body font-semibold">
              <Icon name="phone" size={18} />
              สายด่วน 1557
            </div>
            <ul className="mt-4 flex gap-3">
              {SOCIAL.map((s) => (
                <li key={s.label}>
                  <a
                    href="#main"
                    aria-label={s.label}
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-surface/10 text-surface transition-colors hover:bg-accent hover:text-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Icon name={s.icon} size={20} />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* directory columns */}
          {COLUMNS.map((col) => (
            <nav key={col.heading} aria-label={col.heading}>
              <h3 className="text-body font-semibold text-surface">
                {col.heading}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      className="text-caption text-surface/75 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-surface/15 pt-6 text-caption text-surface/70 sm:flex-row sm:items-center sm:justify-between">
          <p>
            ใบอนุญาตประกอบธุรกิจประกันวินาศภัย เลขที่ 1557/2490 กำกับโดย คปภ.
          </p>
          <p>© 2569 บริษัท วิริยะประกันภัย จำกัด (มหาชน) สงวนลิขสิทธิ์</p>
        </div>
      </Container>
    </footer>
  );
}
