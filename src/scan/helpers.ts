import { urlKey } from '../security/url';
import { sha256 as hash } from '../util/misc';

export { hash as sha256 };

export function urlKeySafe(url: string): string {
  try {
    return urlKey(url);
  } catch {
    return url;
  }
}

export { pLimit, sleep } from '../util/misc';
