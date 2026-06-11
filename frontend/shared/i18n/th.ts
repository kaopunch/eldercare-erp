// Thai UI strings — single source for both portals.
// Rule (CLAUDE.md): no hardcoded UI strings inside components.
export const th = {
  common: {
    appName: 'อุ่นใจ Care',
    loading: 'กำลังโหลด...',
    save: 'บันทึก',
    cancel: 'ยกเลิก',
    confirm: 'ยืนยัน',
    back: 'ย้อนกลับ',
    next: 'ถัดไป',
    error_generic: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง',
    offline_notice: 'ออฟไลน์อยู่ — ข้อมูลจะถูกส่งเมื่อกลับมาออนไลน์',
  },
  customer: {
    portalName: 'อุ่นใจ Care — สำหรับครอบครัว',
    scaffold_welcome: 'พอร์ทัลครอบครัว (อยู่ระหว่างพัฒนา — M1)',
  },
  caregiver: {
    portalName: 'อุ่นใจ Care — สำหรับผู้ดูแล',
    scaffold_welcome: 'พอร์ทัลผู้ดูแล (อยู่ระหว่างพัฒนา — M1)',
    sos: 'SOS',
  },
} as const;

export type ThStrings = typeof th;
