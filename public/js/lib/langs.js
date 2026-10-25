// Languages, genres and per-language translation notes.

export const LANGS = [
  { code: "zh", name: "จีน", en: "Chinese", cjk: true },
  { code: "ja", name: "ญี่ปุ่น", en: "Japanese", cjk: true },
  { code: "ko", name: "เกาหลี", en: "Korean", cjk: true },
  { code: "en", name: "อังกฤษ", en: "English" },
  { code: "vi", name: "เวียดนาม", en: "Vietnamese" },
  { code: "id", name: "อินโดนีเซีย", en: "Indonesian" },
  { code: "th", name: "ไทย", en: "Thai" },
  { code: "es", name: "สเปน", en: "Spanish" },
  { code: "fr", name: "ฝรั่งเศส", en: "French" },
  { code: "de", name: "เยอรมัน", en: "German" },
  { code: "pt", name: "โปรตุเกส", en: "Portuguese" },
  { code: "ru", name: "รัสเซีย", en: "Russian" },
];

export const langByCode = (code) => LANGS.find((l) => l.code === code) || LANGS[0];

// Guess the source language from the script of the text.
export function detectLang(text) {
  const s = text.slice(0, 4000);
  const count = (re) => (s.match(re) || []).length;
  const kana = count(/[぀-ヿ]/g);
  const hangul = count(/[가-힯]/g);
  const han = count(/[一-鿿]/g);
  const thai = count(/[฀-๿]/g);
  const cyr = count(/[Ѐ-ӿ]/g);
  const vi = count(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi);
  const latin = count(/[a-z]/gi);
  if (hangul > 20) return "ko";
  if (kana > 20) return "ja";
  if (han > 20) return "zh";
  if (thai > 20) return "th";
  if (cyr > 20) return "ru";
  if (vi > 10) return "vi";
  if (latin > 20) return "en";
  return "zh";
}

export const GENRES = [
  {
    id: "wuxia",
    name: "กำลังภายใน / จีนโบราณ",
    style: "สำนวนนิยายกำลังภายในไทย ภาษากึ่งโบราณ กระชับ มีจังหวะ ใช้สรรพนาม ข้า/เจ้า/ท่าน/ข้าน้อย ตามฐานะ ใช้คำว่า วิชา กระบวนท่า ลมปราณ สำนัก ตามแบบนิยายจีนแปลไทย",
  },
  {
    id: "xianxia",
    name: "เซียน / ฝึกตน / แฟนตาซีจีน",
    style: "สำนวนนิยายเซียนแปลไทย ใช้ ข้า/เจ้า/ท่าน ตามฐานะ คำศัพท์การฝึกตน (ขั้น ระดับ ปราณ แก่นทอง สมบัติวิเศษ) ต้องคงที่ตามอภิธานศัพท์",
  },
  {
    id: "fantasy",
    name: "แฟนตาซี / ระบบเกม",
    style: "สำนวนนิยายแฟนตาซีไทยสมัยใหม่ อ่านลื่น ข้อความระบบ/หน้าต่างสถานะให้คงรูปแบบวงเล็บเดิม ชื่อสกิลใช้ตามอภิธานศัพท์",
  },
  {
    id: "romance-historical",
    name: "โรแมนติกย้อนยุค / วังหลัง",
    style: "สำนวนนิยายรักย้อนยุคไทย ภาษาสุภาพ อ่อนโยน ใช้ราชาศัพท์หรือคำยกย่องให้เหมาะกับยศ สรรพนาม ข้า/เจ้า/หม่อมฉัน/เพคะ ตามฐานะ",
  },
  {
    id: "modern",
    name: "ปัจจุบัน / ออฟฟิศ / วัยรุ่น",
    style: "ภาษาไทยปัจจุบัน เป็นธรรมชาติ บทพูดเหมือนคนไทยพูดจริง สรรพนาม ฉัน/ผม/นาย/เธอ/คุณ ตามความสัมพันธ์",
  },
  {
    id: "bl",
    name: "BL / Yaoi",
    style: "สำนวนนิยายวายไทย อารมณ์ชัด บทพูดเป็นธรรมชาติ สรรพนามของคู่หลักต้องคงที่ตลอดเรื่อง",
  },
  {
    id: "mystery",
    name: "สืบสวน / สยองขวัญ",
    style: "ภาษาไทยกระชับ สร้างบรรยากาศ ไม่ขยายความเกินต้นฉบับ รายละเอียดเบาะแสต้องครบถ้วน",
  },
  {
    id: "classic",
    name: "วรรณกรรมคลาสสิก",
    style: "ภาษาไทยวรรณกรรม สละสลวย รักษาน้ำเสียงและจังหวะของผู้เขียน ไม่ทำให้ทันสมัยเกินยุคของเรื่อง",
  },
];

export const genreById = (id) => GENRES.find((g) => g.id === id) || GENRES[0];

// How names from a Chinese source are written in Thai.
export const NAME_STYLES = {
  zh: [
    { id: "mandarin", name: "สำเนียงจีนกลาง (นิยายแปลยุคใหม่)", rule: "ทับศัพท์ชื่อจีนด้วยสำเนียงจีนกลาง เช่น 李 = หลี่, 張 = จาง" },
    { id: "hokkien", name: "สำเนียงแต้จิ๋ว/ฮกเกี้ยน (นิยายกำลังภายในยุคเก่า)", rule: "ทับศัพท์ชื่อจีนแบบนิยายกำลังภายในไทยยุคเก่า (แต้จิ๋ว/ฮกเกี้ยน) เช่น 孫悟空 = ซุนหงอคง, 張 = เตีย ถ้ามีชื่อที่คนไทยรู้จักอยู่แล้วให้ใช้ชื่อนั้น" },
    { id: "meaning", name: "แปลความหมายชื่อวิชา/สถานที่", rule: "ชื่อคนทับศัพท์สำเนียงจีนกลาง แต่ชื่อวิชา กระบวนท่า และสถานที่ให้แปลความหมายเป็นไทย เช่น 花果山 = เขาบุปผาผลไม้" },
  ],
  ja: [
    { id: "keep", name: "คงคำยกย่อง (-ซัง, -คุง, -จัง, เซ็นไป)", rule: "คงคำต่อท้ายชื่อแบบญี่ปุ่น เช่น -ซัง -คุง -จัง -ซามะ และคำว่า เซ็นไป/รุ่นพี่ ตามต้นฉบับ" },
    { id: "thai", name: "แปลงเป็นแบบไทย (คุณ, พี่, น้อง)", rule: "แปลงคำยกย่องญี่ปุ่นเป็นคำไทยที่ใกล้เคียง เช่น -ซัง = คุณ, เซ็นไป = รุ่นพี่" },
  ],
  ko: [
    { id: "keep", name: "คงคำเรียกแบบเกาหลี (ออปป้า, ซอนแบ, ฮยอง)", rule: "คงคำเรียกขานแบบเกาหลี เช่น ออปป้า ฮยอง นูนา ซอนแบ -ซี ตามต้นฉบับ" },
    { id: "thai", name: "แปลงเป็นแบบไทย (พี่, รุ่นพี่)", rule: "แปลงคำเรียกขานเกาหลีเป็นคำไทย เช่น 오빠/형 = พี่, 선배 = รุ่นพี่, -씨 = คุณ" },
  ],
};

// Larger CJK chunks reduce API calls and the per-call delays imposed by free-tier limits.
// If a model cannot return a full chunk, the pipeline halves it and retries.
export const chunkSizeFor = (code) => (langByCode(code).cjk ? 5000 : 8000);

// Source-language pitfalls the translator prompt warns about (written for a Thai target, still useful otherwise).
export const LANG_NOTES = {
  zh: "Chinese narration formulas (話說, 且說, 卻說, 只見, 但見) become natural Thai openers such as กล่าวถึง / ฝ่าย / เห็นแต่; the chapter-end formula 且聽下回分解 becomes โปรดติดตามตอนต่อไป. Translate four-character idioms by meaning, not word by word. Poems stay as verse lines.",
  ja: "Japanese often drops the subject: add one in the translation only where the reader needs it. Map first-person pronouns by register and keep them fixed per character: 私→ฉัน/ผม, 僕→ผม, 俺→ข้า/ฉัน, あたし→ฉัน, 吾輩/余/拙者→ข้าพเจ้า. Show sentence-final particles' tone with Thai particles only where natural. Keep onomatopoeia vivid.",
  ko: "Korean speech levels decide politeness: 존댓말 lines get Thai polite endings (ครับ/ค่ะ/นะคะ) fitting the speaker's gender, 반말 lines get none. Dialect or rough speech should sound rough in Thai too. Kinship terms used as address follow the address setting.",
  vi: "Vietnamese pronouns are kinship terms (anh, chị, em, ông, bà, cô, chú, bác, mày, tao): pick the Thai term that matches the relationship (พี่, น้อง, ลุง, ป้า, ตา, ยาย, มึง/กู for insults) and keep it consistent for each pair of characters. Village titles (lý trưởng, chánh tổng) become Thai village office titles.",
  en: "Do not follow English word order: restructure into natural target sentences, split long sentences, translate idioms by meaning, and render dialogue tags (he said) naturally rather than literally every time.",
};
