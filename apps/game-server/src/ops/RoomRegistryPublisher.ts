import { createClient } from 'redis';
import type { RoomMetricsRegistry } from './RoomMetricsRegistry';

const KEY_PREFIX = 'serpent:room-registry:';

export interface RoomRegistryPublisherOptions {
  url: string;
  instanceId: string;
  region: string;
  endpoint: string;
  roomName: string;
  capacity: number;
  modes: string[];
  metrics: RoomMetricsRegistry;
  isDraining: () => boolean;
  now?: () => number;
  ttlSeconds?: number;
}

/** 게임 서버 프로세스의 수용량을 TTL heartbeat로 Redis에 게시한다. */
export class RoomRegistryPublisher {
  private readonly client;
  private readonly key: string;
  private readonly now: () => number;
  private readonly ttlSeconds: number;

  constructor(private readonly options: RoomRegistryPublisherOptions) {
    this.client = createClient({ url: options.url });
    this.key = `${KEY_PREFIX}${options.instanceId}`;
    this.now = options.now ?? Date.now;
    this.ttlSeconds = options.ttlSeconds ?? 15;
    this.client.on('error', (error) => console.error('[room-registry] redis error', error));
  }

  async start(): Promise<void> { await this.client.connect(); await this.publish(); }

  async publish(): Promise<void> {
    const snapshot = this.options.metrics.snapshot();
    const observedRtts = snapshot.rooms.map((room) => room.averageRttMs).filter((rtt): rtt is number => rtt !== null);
    const averageRttMs = observedRtts.length === 0 ? null : observedRtts.reduce((sum, rtt) => sum + rtt, 0) / observedRtts.length;
    await this.client.set(this.key, JSON.stringify({
      instanceId: this.options.instanceId,
      updatedAt: this.now(),
      region: this.options.region,
      endpoint: this.options.endpoint,
      roomName: this.options.roomName,
      players: snapshot.humans,
      capacity: this.options.capacity,
      averageRttMs,
      modes: this.options.modes,
      draining: this.options.isDraining(),
    }), { EX: this.ttlSeconds });
  }

  async stop(): Promise<void> {
    if (!this.client.isOpen) return;
    await this.client.del(this.key);
    await this.client.quit();
  }
}
