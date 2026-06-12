import type { InsuranceType } from "@/app/data/types";

const img = (seed: string) => `https://picsum.photos/seed/${seed}/600/420`;

// >= 6 ใบ ครบ 8 หมวด — REQ-5.1
export const INSURANCE_TYPES: InsuranceType[] = [
  {
    id: "life-1",
    category: "life",
    name: "ประกันชีวิตตลอดชีพ",
    tagline: "คุ้มครองยาวนาน สร้างมรดกให้คนที่รัก",
    imageUrl: img("viriyah-life"),
    planHref: "#insurance-types",
  },
  {
    id: "health-1",
    category: "health",
    name: "ประกันสุขภาพเหมาจ่าย",
    tagline: "ค่ารักษาเหมาจ่ายสูงสุด 5 ล้านบาท/ปี",
    imageUrl: img("viriyah-health"),
    planHref: "#insurance-types",
  },
  {
    id: "motor-1",
    category: "motor",
    name: "ประกันรถยนต์ชั้น 1",
    tagline: "ซ่อมห้าง ลากฟรี อุ่นใจทุกเส้นทาง",
    imageUrl: img("viriyah-motor"),
    planHref: "#insurance-types",
  },
  {
    id: "travel-1",
    category: "travel",
    name: "ประกันเดินทางต่างประเทศ",
    tagline: "คุ้มครองทั่วโลก เคลมง่าย ครอบคลุมโควิด",
    imageUrl: img("viriyah-travel"),
    planHref: "#insurance-types",
  },
  {
    id: "accident-1",
    category: "accident",
    name: "ประกันอุบัติเหตุส่วนบุคคล",
    tagline: "ชดเชยรายวัน คุ้มครอง 24 ชม. ทั่วโลก",
    imageUrl: img("viriyah-accident"),
    planHref: "#insurance-types",
  },
  {
    id: "home-1",
    category: "home",
    name: "ประกันบ้านอยู่อาศัย",
    tagline: "คุ้มครองไฟไหม้ น้ำท่วม โจรกรรม",
    imageUrl: img("viriyah-home"),
    planHref: "#insurance-types",
  },
  {
    id: "cancer-1",
    category: "cancer",
    name: "ประกันมะเร็งเจอจ่ายจบ",
    tagline: "ตรวจพบรับเงินก้อนทันที ดูแลค่ารักษา",
    imageUrl: img("viriyah-cancer"),
    planHref: "#insurance-types",
  },
  {
    id: "savings-1",
    category: "savings",
    name: "ประกันสะสมทรัพย์ 10/5",
    tagline: "ออมสั้น คุ้มครองยาว การันตีผลตอบแทน",
    imageUrl: img("viriyah-savings"),
    planHref: "#insurance-types",
  },
  {
    id: "health-2",
    category: "health",
    name: "ประกันสุขภาพเด็กเล็ก",
    tagline: "ดูแลลูกน้อยตั้งแต่แรกเกิดถึง 15 ปี",
    imageUrl: img("viriyah-health-kid"),
    planHref: "#insurance-types",
  },
  {
    id: "motor-2",
    category: "motor",
    name: "ประกันรถยนต์ชั้น 2+",
    tagline: "คุ้มครองคู่กรณี + รถหายไฟไหม้ คุ้มค่า",
    imageUrl: img("viriyah-motor-2"),
    planHref: "#insurance-types",
  },
];
