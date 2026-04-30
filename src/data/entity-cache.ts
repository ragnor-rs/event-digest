import fs from 'fs';
import path from 'path';

import { Logger } from '../shared/logger';

export interface CachedChannel {
  id: string;
  accessHash: string;
}

export class EntityCache {
  private filePath: string;
  private cache: Record<string, CachedChannel>;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    const cacheDir = path.join(process.cwd(), '.cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    this.filePath = path.join(cacheDir, 'resolved_entities.json');
    this.cache = fs.existsSync(this.filePath)
      ? JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      : {};
  }

  get(username: string): CachedChannel | undefined {
    return this.cache[username.toLowerCase()];
  }

  set(username: string, channel: CachedChannel): void {
    this.cache[username.toLowerCase()] = channel;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      this.logger.error('Failed to save resolved_entities.json', error);
    }
  }
}
