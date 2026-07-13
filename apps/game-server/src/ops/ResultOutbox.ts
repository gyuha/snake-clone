import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ResultMessage } from '@serpent/protocol';

export interface PendingResult {
  matchId: string;
  userId: string;
  body: ResultMessage;
}

/**
 * API/DB 일시 장애와 게임 프로세스 재시작 사이에서도 결과를 보존하는 작은
 * write-ahead outbox. 환경 변수가 없으면 메모리 큐로 동작해 개발 흐름을 유지한다.
 */
export class ResultOutbox {
  constructor(private readonly path = process.env.SERPENT_RESULT_OUTBOX_PATH) {}
  private queue: PendingResult[] = [];
  private loaded = false;
  private writing = Promise.resolve();

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return;
      this.queue = parsed.filter(this.isPendingResult);
    } catch {
      // 첫 실행/손상 파일은 새 outbox로 시작한다. 원본 파일을 덮기 전까지는 보존된다.
    }
  }

  enqueue(item: PendingResult): void {
    this.queue.push(item);
    void this.persist();
  }

  peek(): PendingResult | undefined { return this.queue[0]; }
  shift(): void { this.queue.shift(); void this.persist(); }
  get length(): number { return this.queue.length; }
  /** 종료 훅/테스트에서 현재 write-ahead 작업 완료를 기다릴 때 사용한다. */
  async flush(): Promise<void> { await this.writing; }

  private isPendingResult(value: unknown): value is PendingResult {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<PendingResult>;
    return typeof item.matchId === 'string' && typeof item.userId === 'string' && Boolean(item.body) && typeof item.body === 'object';
  }

  private persist(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const snapshot = JSON.stringify(this.queue);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path!), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.path!);
    }).catch(() => undefined); // 다음 결과/플러시는 계속 시도한다.
    return this.writing;
  }
}
