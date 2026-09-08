/**
 * 防滥用：后台强制配额，不依赖前端限制。
 */
import { config } from '../config';
import * as repo from '../db/repository';
import { hashIp } from '../util/misc';

const IP_SALT = process.env.FP_IP_SALT || 'freshpage-v0-ip-salt';

export function ipHash(ip: string): string {
  return hashIp(ip || 'unknown', IP_SALT);
}

export interface RateDecision {
  allowed: boolean;
  reason?: string;
  retryAfterSec?: number;
}

export function checkScanCreation(clientIpHashes: string, domain: string): RateDecision {
  const now = Date.now();
  const windowIndex = Math.floor(now / config.abuse.ipWindowMs);
  const day = new Date().toISOString().slice(0, 10);

  const windowKey = `ip:${clientIpHashes}:${windowIndex}`;
  const dayKey = `ipday:${clientIpHashes}:${day}`;

  const windowCount = repo.bumpCounter(windowKey);
  if (windowCount > config.abuse.maxScansPerIpPerWindow) {
    return {
      allowed: false,
      reason: '提交太频繁了，请稍后再试。',
      retryAfterSec: Math.ceil(config.abuse.ipWindowMs / 1000),
    };
  }

  const dayCount = repo.bumpCounter(dayKey);
  if (dayCount > config.abuse.maxScansPerIpPerDay) {
    return { allowed: false, reason: '今天的检查次数已达上限，请明天再试。', retryAfterSec: 3600 };
  }

  const failures = repo.getFailureCounter(domain);
  if (failures >= config.abuse.failureThreshold) {
    return {
      allowed: false,
      reason: '这个网站最近多次检查失败，已暂时冷却，请稍后再试。',
      retryAfterSec: Math.ceil(config.abuse.failureCooldownMs / 1000),
    };
  }

  const usage = repo.getDailyUsage(day);
  if (usage.pages_crawled >= config.abuse.dailyPageBudget) {
    return { allowed: false, reason: '系统今日的检查额度已用完，请明天再试。', retryAfterSec: 3600 };
  }

  return { allowed: true };
}

/** 结果页匿名投票者标识（不保存 IP 原文）。 */
export function voterHash(cookieValue: string | undefined, ip: string): string {
  return cookieValue ? hashIp(cookieValue, IP_SALT) : ipHash(ip);
}
