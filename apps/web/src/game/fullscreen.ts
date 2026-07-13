export interface FullscreenDocument {
  fullscreenEnabled?: boolean;
  fullscreenElement?: unknown | null;
  exitFullscreen?: () => Promise<void>;
}

export interface FullscreenElement {
  requestFullscreen?: () => Promise<void>;
}

export function fullscreenSupported(doc: FullscreenDocument): boolean {
  return doc.fullscreenEnabled !== false;
}

/** 브라우저가 거절해도 게임 흐름을 깨지 않는 전체 화면 토글. */
export async function toggleFullscreen(element: FullscreenElement, doc: FullscreenDocument): Promise<boolean> {
  if (!fullscreenSupported(doc)) return false;
  try {
    if (doc.fullscreenElement) {
      if (!doc.exitFullscreen) return false;
      await doc.exitFullscreen();
    } else {
      if (!element.requestFullscreen) return false;
      await element.requestFullscreen();
    }
    return true;
  } catch {
    return false;
  }
}
