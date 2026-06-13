// แสดงจำนวนเงินเป็นจำนวนเต็มบาท คั่นหลักพันด้วย "," — REQ-8.9
export function formatTHB(amount: number): string {
  return Math.round(amount).toLocaleString("en-US");
}
