import Phaser from 'phaser';
import { ArenaScene } from './ArenaScene';
import { OnlineScene } from './OnlineScene';

/** `?mode=online[&server=ws://...]` 이면 온라인 모드, 아니면 오프라인 (M2) */
export function createGame(parent: HTMLElement): Phaser.Game {
  const mode = new URLSearchParams(window.location.search).get('mode');
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#101418',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: mode === 'online' ? [OnlineScene] : [ArenaScene],
  });
}
