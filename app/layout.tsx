import type { Metadata } from "next";
import { IBM_Plex_Sans_Thai } from "next/font/google";
import "./globals.css";

// Thai web font, self-hosted at build time -> runtime ไม่ง้อ network (REQ-15.1)
const ibmPlexSansThai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "วิริยะประกันภัย — ประกันที่ดูแลคุณทุกช่วงชีวิต",
  description:
    "พอร์ทัลประกันภัยครบวงจร: เปรียบเทียบแผนประกันชีวิต สุขภาพ รถยนต์ เดินทาง คำนวณเบี้ยประกันออนไลน์ จัดการกรมธรรม์ และแจ้งเคลมได้ในที่เดียว",
  keywords: [
    "ประกันภัย",
    "ประกันชีวิต",
    "ประกันสุขภาพ",
    "ประกันรถยนต์",
    "คำนวณเบี้ยประกัน",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="th" className={ibmPlexSansThai.variable}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-surface"
        >
          ข้ามไปยังเนื้อหาหลัก
        </a>
        {children}
      </body>
    </html>
  );
}
