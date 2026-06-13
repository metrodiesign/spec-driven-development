import type { Article } from "@/app/data/types";

const cover = (seed: string) => `https://picsum.photos/seed/${seed}/600/360`;
const avatar = (seed: string) => `https://picsum.photos/seed/${seed}/80/80`;

// >= 8 ใบ + author avatar รูปจริง — REQ-10.1
export const ARTICLES: Article[] = [
  {
    id: "art-1",
    title: "เลือกประกันสุขภาพอย่างไรให้คุ้มที่สุดในปี 2026",
    category: "สุขภาพ",
    imageUrl: cover("art-health"),
    author: { name: "พญ. ศิริพร วงศ์ไทย", avatarUrl: avatar("author-1") },
    date: "2026-05-20",
  },
  {
    id: "art-2",
    title: "5 ข้อควรรู้ก่อนทำประกันรถยนต์ชั้น 1",
    category: "รถยนต์",
    imageUrl: cover("art-motor"),
    author: { name: "สมชาย ใจดี", avatarUrl: avatar("author-2") },
    date: "2026-05-12",
  },
  {
    id: "art-3",
    title: "วางแผนเกษียณด้วยประกันสะสมทรัพย์",
    category: "การเงิน",
    imageUrl: cover("art-savings"),
    author: { name: "ดร. อนันต์ ทรัพย์มั่น", avatarUrl: avatar("author-3") },
    date: "2026-05-08",
  },
  {
    id: "art-4",
    title: "เดินทางต่างประเทศ ทำไมต้องมีประกันเดินทาง",
    category: "เดินทาง",
    imageUrl: cover("art-travel"),
    author: { name: "นภัสสร เที่ยวรอบโลก", avatarUrl: avatar("author-4") },
    date: "2026-04-29",
  },
  {
    id: "art-5",
    title: "ประกันมะเร็ง คุ้มครองอะไรบ้าง เลือกแบบไหนดี",
    category: "สุขภาพ",
    imageUrl: cover("art-cancer"),
    author: { name: "พญ. ศิริพร วงศ์ไทย", avatarUrl: avatar("author-1") },
    date: "2026-04-22",
  },
  {
    id: "art-6",
    title: "คุ้มครองบ้านจากภัยน้ำท่วม เตรียมตัวอย่างไร",
    category: "ที่อยู่อาศัย",
    imageUrl: cover("art-home"),
    author: { name: "วิชัย มั่นคง", avatarUrl: avatar("author-5") },
    date: "2026-04-15",
  },
  {
    id: "art-7",
    title: "ประกันชีวิตควบการลงทุน เหมาะกับใคร",
    category: "การเงิน",
    imageUrl: cover("art-life"),
    author: { name: "ดร. อนันต์ ทรัพย์มั่น", avatarUrl: avatar("author-3") },
    date: "2026-04-03",
  },
  {
    id: "art-8",
    title: "ขั้นตอนแจ้งเคลมออนไลน์ ง่ายใน 5 นาที",
    category: "บริการ",
    imageUrl: cover("art-claim"),
    author: { name: "สมชาย ใจดี", avatarUrl: avatar("author-2") },
    date: "2026-03-28",
  },
  {
    id: "art-9",
    title: "ประกันอุบัติเหตุสำหรับครอบครัว ต้องดูอะไร",
    category: "อุบัติเหตุ",
    imageUrl: cover("art-accident"),
    author: { name: "นภัสสร เที่ยวรอบโลก", avatarUrl: avatar("author-4") },
    date: "2026-03-19",
  },
];
