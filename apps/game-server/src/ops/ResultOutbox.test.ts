import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ResultOutbox } from './ResultOutbox';

describe('ResultOutbox (PRD §9.7)', () => {
  it('디스크 write-ahead 결과를 새 outbox 인스턴스가 복원한다', async () => {
    const path = join(tmpdir(), `serpent-outbox-${Date.now()}-${Math.random()}.json`);
    try {
      const first = new ResultOutbox(path);
      await first.load();
      first.enqueue({ matchId: 'm1', userId: 'u1', body: { matchId: 'm1', rank: 1, score: 10, length: 20, survivalMs: 30, kills: 0, reason: 'boundary' } });
      await first.flush();

      const restored = new ResultOutbox(path);
      await restored.load();
      expect(restored.length).toBe(1);
      expect(restored.peek()).toMatchObject({ matchId: 'm1', userId: 'u1' });
      restored.shift();
      await restored.flush();
      expect(restored.length).toBe(0);
    } finally { await rm(path, { force: true }); }
  });
});
