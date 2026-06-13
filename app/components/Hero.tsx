import { Container } from "@/app/components/ui/Container";
import { Icon, type IconName } from "@/app/components/ui/Icon";
import { HeroCampaignSlider } from "@/app/components/HeroCampaignSlider";

// 4 ทางลัด — REQ-4.2 (ไอคอน + ป้ายชื่อ ในกริด 2x2 มีเส้นคั่น)
const SHORTCUTS: {
  label: string;
  icon: IconName;
  href: string;
  color: string;
}[] = [
  {
    label: "ซื้อประกัน",
    icon: "cartPlus",
    href: "#insurance-types",
    color: "text-primary",
  },
  {
    label: "เช็กกรมธรรม์",
    icon: "document",
    href: "#services",
    color: "text-primary",
  },
  {
    label: "แจ้งเคลม",
    icon: "claim",
    href: "#services",
    color: "text-primary",
  },
  {
    label: "ติดต่อเรา",
    icon: "contact",
    href: "#services",
    color: "text-primary",
  },
];

// hero แบ่งซ้าย 30% (การ์ดทางลัด) — ขวา 70% (slider แคมเปญ) — REQ-4.1..4.5
export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="bg-bg py-10 lg:py-14">
      <Container className="grid items-stretch gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,7fr)]">
        {/* ซ้าย 30%: การ์ดทางลัด + แถบลิงก์ */}
        {/* Responsive: การ์ดอยู่ล่าง slider (order-2); desktop กลับเป็นซ้าย (lg:order-1) */}
        <div className="order-2 flex flex-col gap-4 lg:order-1">
          <h1 id="hero-heading" className="sr-only">
            วิริยะประกันภัย ประกันที่ดูแลคุณทุกช่วงชีวิต
          </h1>

          <div className="flex flex-1 flex-col rounded-xl border border-border bg-surface shadow-card">
            {/* header: club points + ลงทะเบียน/เข้าสู่ระบบ + V Point badge */}
            <div className="flex items-start justify-between gap-3 p-6">
              <div>
                <p className="text-caption text-text-muted">
                  สมัครสมาชิกวันนี้ รับ 20 V Points!
                </p>
                <a
                  href="#calculator"
                  className="mt-1 inline-flex items-center gap-1 text-h3 font-bold text-primary transition-colors hover:text-primary-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  ลงทะเบียน / เข้าสู่ระบบ
                  <Icon name="chevronRight" size={18} />
                </a>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-bg px-2.5 py-1.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-caption font-bold text-primary-dark">
                  V
                </span>
                <span className="text-caption font-medium text-text">
                  Point
                </span>
              </span>
            </div>

            {/* 2x2 ทางลัด มีเส้นคั่น (cross divider) */}
            <div className="grid flex-1 grid-cols-2 border-t border-border">
              {SHORTCUTS.map((s, i) => (
                <a
                  key={s.label}
                  href={s.href}
                  className={`group flex flex-col items-center justify-center gap-2.5 border-border p-6 text-center transition-colors hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    i < 2 ? "border-b" : ""
                  } ${i % 2 === 0 ? "border-r" : ""}`}
                >
                  <Icon name={s.icon} size={30} className={s.color} />
                  <span className="text-body font-medium text-text transition-colors group-hover:text-primary">
                    {s.label}
                  </span>
                </a>
              ))}
            </div>
          </div>

          {/* แถบลิงก์ "ไปยังแผนยอดนิยม" แยกด้านล่าง — REQ-4.2 */}
          <a
            href="#promotions"
            className="flex items-center justify-between rounded-xl border border-border bg-surface px-5 py-4 text-body text-text shadow-card transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span>
              ไปยัง<span className="font-semibold"> แผนประกันยอดนิยม</span>
            </span>
            <Icon name="chevronRight" size={18} />
          </a>
        </div>

        {/* ขวา 70%: แบนเนอร์แคมเปญ (slider 6 รายการ) */}
        <HeroCampaignSlider className="order-1 lg:order-2" />
      </Container>
    </section>
  );
}
