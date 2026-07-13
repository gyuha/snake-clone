import Phaser from 'phaser';
import { ArenaScene } from './ArenaScene';

/** 오프라인 아레나 (M1 코어 — `?mode=offline` 개발/데모용) */
export function createGame(parent: HTMLElement): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#101418',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [ArenaScene],
  });
}
