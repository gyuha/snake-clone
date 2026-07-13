type Tone = 'kill' | 'death';

type BrowserAudioContext = typeof AudioContext;

function audioConstructor(): BrowserAudioContext | undefined {
  const browser = globalThis as unknown as { AudioContext?: BrowserAudioContext; webkitAudioContext?: BrowserAudioContext };
  return browser.AudioContext ?? browser.webkitAudioContext;
}

/**
 * 사용자 입력 뒤에만 AudioContext를 unlock한다. 외부 음원/자동재생 없이도 중요한
 * gameplay 결과에 짧은 피드백을 주며, 시각적 결과/HUD는 항상 별도로 유지된다.
 */
export class SoundFeedback {
  private context?: AudioContext;

  constructor(private readonly volume: number) {}

  unlock(): void {
    if (this.volume <= 0) return;
    const Constructor = audioConstructor();
    if (!Constructor) return;
    this.context ??= new Constructor();
    void this.context.resume().catch(() => undefined);
  }

  play(tone: Tone): void {
    const context = this.context;
    if (!context || context.state !== 'running' || this.volume <= 0) return;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = tone === 'kill' ? 'triangle' : 'sawtooth';
      oscillator.frequency.setValueAtTime(tone === 'kill' ? 660 : 180, now);
      if (tone === 'kill') oscillator.frequency.exponentialRampToValueAtTime(920, now + 0.09);
      else oscillator.frequency.exponentialRampToValueAtTime(90, now + 0.16);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.min(0.12, this.volume * 0.12), now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (tone === 'kill' ? 0.11 : 0.19));
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + (tone === 'kill' ? 0.12 : 0.2));
    } catch {
      // 브라우저 정책/오디오 장치 오류는 플레이 흐름을 중단시키지 않는다.
    }
  }
}
