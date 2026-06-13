import type { HeroCampaign } from "@/app/data/types";

// ภาพแคมเปญ hero — banner สำเร็จรูป (ข้อความ + CTA ฝังในรูปแล้ว) เก็บใน public/images/hero/
// สไลด์ = รูปเดียวคลิกทั้งใบ; headline ใช้เป็น alt/aria-label, display/items = metadata ภายใน
const img = (name: string) => `/images/hero/${name}.jpg`;

// แคมเปญ hero 6 รายการ (REQ-4.4)
export const HERO_CAMPAIGNS: HeroCampaign[] = [
  {
    id: "hc-motor",
    headline: "ประกันรถยนต์ชั้น 1 คุ้มครองครบ จบทุกอุบัติเหตุ",
    display: "DRIVE WITH CARE",
    items: [
      { label: "ซ่อมห้าง", sublabel: "ศูนย์มาตรฐาน" },
      { label: "ลากฟรี", sublabel: "24 ชม. ทั่วไทย" },
      { label: "คู่กรณี", sublabel: "คุ้มครองเต็ม" },
      { label: "น้ำท่วม", sublabel: "ภัยธรรมชาติ" },
    ],
    ctaLabel: "เช็คเบี้ยเลย",
    ctaHref: "#calculator",
    imageUrl: img("motor"),
    icon: "motor",
  },
  {
    id: "hc-health",
    headline: "ประกันสุขภาพเหมาจ่าย ดูแลคุณทุกย่างก้าว เจ็บป่วยไม่ต้องกังวล",
    display: "TOTAL HEALTH CARE",
    items: [
      { label: "เหมาจ่าย", sublabel: "สูงสุด 5 ล้าน/ปี" },
      { label: "รพ. คู่สัญญา", sublabel: "ทั่วประเทศ" },
      { label: "ผู้ป่วยใน", sublabel: "ห้องเดี่ยวมาตรฐาน" },
      { label: "อุ่นใจ", sublabel: "ทุกช่วงเวลา" },
    ],
    ctaLabel: "ดูรายละเอียด",
    ctaHref: "#promotions",
    imageUrl: img("health"),
    icon: "health",
  },
  {
    id: "hc-life",
    headline: "ประกันชีวิต เพื่อคนที่คุณรัก วางแผนอนาคต มั่นคงเพื่อครอบครัว",
    display: "LIFE SECURE",
    items: [
      { label: "คุ้มครองชีวิต", sublabel: "ทุนสูง" },
      { label: "ออมทรัพย์", sublabel: "ผลตอบแทนแน่นอน" },
      { label: "ลดหย่อนภาษี", sublabel: "สูงสุด 1 แสน" },
      { label: "มรดก", sublabel: "ส่งต่อคนที่รัก" },
    ],
    ctaLabel: "ปรึกษาเรา",
    ctaHref: "#promotions",
    imageUrl: img("life"),
    icon: "life",
  },
  {
    id: "hc-travel",
    headline: "ประกันเดินทางต่างประเทศ เที่ยวสนุก อุ่นใจทุกทริปทั่วโลก",
    display: "TRAVEL SAFE",
    items: [
      { label: "ค่ารักษา ตปท.", sublabel: "สูงสุด 5 ล้าน" },
      { label: "เที่ยวบินดีเลย์", sublabel: "ชดเชยรายชม." },
      { label: "กระเป๋าหาย", sublabel: "ชดเชยเต็ม" },
      { label: "ช่วยเหลือฉุกเฉิน", sublabel: "24 ชม. ทั่วโลก" },
    ],
    ctaLabel: "ซื้อออนไลน์ลด 10%",
    ctaHref: "#promotions",
    imageUrl: img("travel"),
    icon: "travel",
  },
  {
    id: "hc-home",
    headline:
      "ประกันบ้านและที่อยู่อาศัย คุ้มครองบ้านที่คุณรัก จากอัคคีภัยและภัยพิบัติ",
    display: "HOME SHIELD",
    items: [
      { label: "อัคคีภัย", sublabel: "คุ้มครองเต็ม" },
      { label: "ภัยธรรมชาติ", sublabel: "น้ำท่วม/พายุ" },
      { label: "ทรัพย์สิน", sublabel: "ภายในบ้าน" },
      { label: "โจรกรรม", sublabel: "ชดเชยตามจริง" },
    ],
    ctaLabel: "คำนวณเบี้ย",
    ctaHref: "#calculator",
    imageUrl: img("home"),
    icon: "home",
  },
  {
    id: "hc-accident",
    headline: "ประกันอุบัติเหตุส่วนบุคคล จ่ายเบี้ยน้อย คุ้มครองหลักล้าน",
    display: "FAMILY SHIELD",
    items: [
      { label: "คุ้มครอง 24 ชม.", sublabel: "ทั่วโลก" },
      { label: "ค่ารักษา", sublabel: "ตามจริง" },
      { label: "วงเงินสูง", sublabel: "สูงสุด 5 ล้าน" },
      { label: "เบี้ยเริ่มต้น", sublabel: "เดือนละ 200" },
    ],
    ctaLabel: "สมัครเลย",
    ctaHref: "#promotions",
    imageUrl: img("accident"),
    icon: "accident",
  },
];
