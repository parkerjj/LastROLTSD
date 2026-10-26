// 机房 / 云厂商 ASN 组织关键词。注意：本文件不得 import 任何模块，补数脚本（.mjs）会直接引用它。
export const HOSTING_ORG_KEYWORDS: readonly string[] = [
  'alibaba',
  'aliyun',
  'tencent',
  'huawei cloud',
  'amazon',
  'aws',
  'google cloud',
  'google llc',
  'microsoft',
  'azure',
  'digitalocean',
  'vultr',
  'choopa',
  'linode',
  'akamai',
  'ovh',
  'hetzner',
  'oracle',
  'contabo',
  'm247',
  'leaseweb',
  'cloudflare',
];

export function isHostingOrg(org: string | null): boolean {
  if (!org) return false;
  const lower = org.toLowerCase();
  return HOSTING_ORG_KEYWORDS.some((keyword) => lower.includes(keyword));
}
