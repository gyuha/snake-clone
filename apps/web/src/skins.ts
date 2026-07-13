/** 기본 스킨 8종 (FR-COS-01) — 능력 없는 공정한 코스메틱, 색상만 다르다 */
export interface Skin {
  id: number;
  name: string;
  head: number;
  body: number;
  boost: number;
  /** CSS 미리보기용 */
  css: string;
}

export const SKINS: Skin[] = [
  { id: 0, name: '에메랄드', head: 0x6fd79a, body: 0x4ea56f, boost: 0x9be27f, css: '#4ea56f' },
  { id: 1, name: '코발트', head: 0x7fa2e8, body: 0x5a7fd6, boost: 0xa8c4f5, css: '#5a7fd6' },
  { id: 2, name: '선셋', head: 0xf0a868, body: 0xd97f3e, boost: 0xf7c489, css: '#d97f3e' },
  { id: 3, name: '루비', head: 0xe87f8e, body: 0xc95560, boost: 0xf2a3ae, css: '#c95560' },
  { id: 4, name: '아메시스트', head: 0xb58ae0, body: 0x8f5fc7, boost: 0xd0aef0, css: '#8f5fc7' },
  { id: 5, name: '골드', head: 0xe8d377, body: 0xc9ac3e, boost: 0xf5e6a3, css: '#c9ac3e' },
  { id: 6, name: '터쿼이즈', head: 0x72d8ce, body: 0x3fada2, boost: 0x9fe8e0, css: '#3fada2' },
  { id: 7, name: '슬레이트', head: 0xa8b4c0, body: 0x7c8894, boost: 0xc8d2dc, css: '#7c8894' },
];

export function skinOf(id: number): Skin {
  return SKINS[id] ?? SKINS[0]!;
}
