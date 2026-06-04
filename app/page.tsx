import { UtilityBar } from "@/app/components/UtilityBar";
import { Header } from "@/app/components/Header";
import { Hero } from "@/app/components/Hero";
import { InsuranceTypes } from "@/app/components/InsuranceTypes";
import { Services } from "@/app/components/Services";
import { Promotions } from "@/app/components/Promotions";
import { PremiumCalculator } from "@/app/components/PremiumCalculator";
import { Stats } from "@/app/components/Stats";
import { Articles } from "@/app/components/Articles";
import { Testimonials } from "@/app/components/Testimonials";
import { AppDownload } from "@/app/components/AppDownload";
import { Footer } from "@/app/components/Footer";

// ประกอบ 12 section ตามลำดับ REQ-1.1
export default function Home() {
  return (
    <>
      {/* (1) utility bar + (2) sticky header */}
      <UtilityBar />
      <Header />
      <main id="main">
        <Hero /> {/* (3) hero */}
        <InsuranceTypes /> {/* (4) ประเภทประกัน */}
        <Services /> {/* (5) บริการ */}
        <Promotions /> {/* (6) โปรโมชั่น */}
        <PremiumCalculator /> {/* (7) เครื่องคำนวณเบี้ย */}
        <Stats /> {/* (8) แถบสถิติ */}
        <Articles /> {/* (9) บทความ */}
        <Testimonials /> {/* (10) testimonials */}
        <AppDownload /> {/* (11) ดาวน์โหลดแอป */}
      </main>
      <Footer /> {/* (12) footer */}
    </>
  );
}
