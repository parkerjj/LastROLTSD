import { HallApiError, normalizeShareCode, type SharedProfileDetail, type SharedProfilePage, type SharedProfileQuery } from './profile-hall-api';
import type { SharedProfileCopyInput, SharedProfileCopyResult } from '../../worker/src/ke/shared-profile-types';
import { profileHallApi } from './profile-hall-api';

const createdAt = Date.now();

const seedProfiles: SharedProfileDetail[] = [
  {
    id: 1, title: '猎人 · 斐扬树林日常', description: '适合刚转职的猎人。以普攻为主，设置了低血量回城和箭矢补给；出发前记得换成自己的回城点。', job_id: 11,
    author: { id: 'hunter-author', display_name: '林间晚风' }, share_code: 'HNT-0826', like_count: 46, use_count: 183, liked_by_me: false, used_by_me: false, is_mine: false,
    created_at: createdAt - 1 * 86_400_000, updated_at: createdAt - 1 * 86_400_000,
    config_text: '# 猎人 · 斐扬树林日常\nlockMap pay_fild08\nattackAuto 2\nroute_randomWalk 1\n\n# 请按角色情况调整\nuseSelf_item 红色药水 {\n  hp < 50%\n}',
    mon_control: 'all 1 0 0\n波利 1 0 0', pickupitems: 'all 1\n杰勒比结晶 1', items_control: 'all 0 1 0\n红色药水 100 0 0', timeouts: 'ai_attack 0.2\nai_route 0.5\nai_items_take 1',
  },
  {
    id: 2, title: '巫师 · 火墙练级与补给', description: '火墙配合火箭术，优先处理主动怪。带有坐下回蓝和药水补给，技能等级请按自己的情况调整。', job_id: 9,
    author: { id: 'wizard-author', display_name: '路过的魔法师' }, share_code: 'WIZ-1732', like_count: 38, use_count: 124, liked_by_me: false, used_by_me: false, is_mine: false,
    created_at: createdAt - 2 * 86_400_000, updated_at: createdAt - 2 * 86_400_000,
    config_text: '# 巫师 · 火墙练级与补给\nlockMap geffen_fild10\nattackAuto 2\nroute_randomWalk 1\nuseSelf_skill MG_FIREWALL {\n  lvl 10\n}',
    mon_control: 'all 1 0 0\n蓝色魔物 1 0 0', pickupitems: 'all 1\n蓝色药草 1', items_control: 'all 0 1 0\n蓝色药水 80 0 0', timeouts: 'ai_attack 0.3\nai_route 0.8\nai_items_take 1',
  },
  {
    id: 3, title: '牧师 · 双人队伍跟随辅助', description: '给队友治疗、加速和天使之赐福。先设置跟随的队友名称，再按队伍的消耗调整补给。', job_id: 8,
    author: { id: 'priest-author', display_name: '奶油面包' }, share_code: 'PTY-0621', like_count: 29, use_count: 79, liked_by_me: false, used_by_me: false, is_mine: false,
    created_at: createdAt - 3 * 86_400_000, updated_at: createdAt - 3 * 86_400_000,
    config_text: '# 牧师 · 双人队伍跟随辅助\nlockMap prt_fild08\nfollow 1\nfollowTarget 队友名称\nattackAuto 0',
    mon_control: 'all 0 0 0', pickupitems: 'all 0', items_control: 'all 0 1 0\n蓝色药水 80 0 0', timeouts: 'ai_attack 0.4\nai_route 0.7\nai_items_take 1',
  },
  {
    id: 4, title: '刺客 · 普攻拾取方案', description: '日常普攻练级，附常用拾取与存仓规则。把不需要的材料移出拾取清单即可。', job_id: 12,
    author: { id: 'assassin-author', display_name: '月下散步' }, share_code: 'SIN-3146', like_count: 17, use_count: 57, liked_by_me: false, used_by_me: false, is_mine: false,
    created_at: createdAt - 4 * 86_400_000, updated_at: createdAt - 4 * 86_400_000,
    config_text: '# 刺客 · 普攻拾取方案\nlockMap moc_fild17\nattackAuto 2\nroute_randomWalk 1\nroute_avoidWalls 1',
    mon_control: 'all 1 0 0', pickupitems: 'all 1\n杰勒比结晶 1', items_control: 'all 0 1 0\n红色药水 100 0 0', timeouts: 'ai_attack 0.2\nai_route 0.5\nai_items_take 1',
  },
  {
    id: 5, title: '十字军 · 长时间练级', description: '重视生存和回城补给，药水不足时停止战斗。适合以普攻为主的练级方式。', job_id: 14,
    author: { id: 'crusader-author', display_name: '普隆德拉守门员' }, share_code: 'CRU-2405', like_count: 12, use_count: 44, liked_by_me: false, used_by_me: false, is_mine: false,
    created_at: createdAt - 5 * 86_400_000, updated_at: createdAt - 5 * 86_400_000,
    config_text: '# 十字军 · 长时间练级\nlockMap gef_fild14\nattackAuto 2\nroute_randomWalk 1\nreturnToSavePoint 1',
    mon_control: 'all 1 0 0', pickupitems: 'all 1\n蜂蜜 1', items_control: 'all 0 1 0\n红色药水 120 0 0', timeouts: 'ai_attack 0.3\nai_route 0.8\nai_items_take 1',
  },
  {
    id: 6, title: '猎人 · 弓手村轻量版', description: '', job_id: 11,
    author: { id: 'demo-viewer', display_name: '波利猎人' }, share_code: 'BOW-0918', like_count: 0, use_count: 0, liked_by_me: false, used_by_me: false, is_mine: true,
    created_at: createdAt - 6 * 86_400_000, updated_at: createdAt - 6 * 86_400_000,
    config_text: '# 猎人 · 弓手村轻量版\nlockMap pay_fild01\nattackAuto 2\nroute_randomWalk 1',
    mon_control: 'all 1 0 0', pickupitems: 'all 1', items_control: 'all 0 1 0', timeouts: 'ai_attack 0.2\nai_route 0.5\nai_items_take 1',
  },
];

type DemoProfile = SharedProfileDetail & { sharingStatus?: 'WITHDRAWN' };
type ProfileHallApiClient = typeof profileHallApi;

export function createProfileHallDemoApi(): ProfileHallApiClient {
  const profiles: DemoProfile[] = structuredClone(seedProfiles);
  let nextProfileId = 9000;

  return {
    async list(query: SharedProfileQuery, signal?: AbortSignal): Promise<SharedProfilePage> {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const sorted = profiles
        .filter((profile) => profile.sharingStatus !== 'WITHDRAWN')
        .filter((profile) => query.job_ids !== undefined
          ? profile.job_id !== null && query.job_ids.includes(profile.job_id)
          : query.job_id === undefined || profile.job_id === query.job_id)
        .sort((a, b) => query.sort === 'uses'
          ? b.use_count - a.use_count
          : query.sort === 'likes'
            ? b.like_count - a.like_count
            : b.created_at - a.created_at);
      const start = (query.page - 1) * 20;
      return {
        items: structuredClone(sorted.slice(start, start + 20).map(({ config_text: _config, mon_control: _mon, pickupitems: _pickup, items_control: _items, timeouts: _timeouts, sharingStatus: _status, ...summary }) => summary)),
        page: query.page, page_size: 20, total: sorted.length,
      };
    },
    async byId(id: number, signal?: AbortSignal): Promise<SharedProfileDetail> {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const profile = profiles.find((item) => item.id === id && item.sharingStatus !== 'WITHDRAWN');
      if (!profile) throw new HallApiError(404, 'NOT_FOUND', '找不到这套演示配置。');
      return structuredClone(profile);
    },
    async byCode(code: string, signal?: AbortSignal): Promise<SharedProfileDetail> {
      const normalized = normalizeShareCode(code);
      const profile = profiles.find((item) => item.share_code === normalized && item.sharingStatus !== 'WITHDRAWN');
      if (!profile) throw new HallApiError(404, 'NOT_FOUND', '找不到这套演示配置。');
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return structuredClone(profile);
    },
    async like(id: number, liked: boolean): Promise<{ liked: boolean; like_count: number }> {
      const profile = profiles.find((item) => item.id === id && item.sharingStatus !== 'WITHDRAWN');
      if (!profile) throw new HallApiError(404, 'NOT_FOUND', '找不到这套演示配置。');
      if (!profile.is_mine && profile.liked_by_me !== liked) {
        profile.liked_by_me = liked;
        profile.like_count += liked ? 1 : -1;
      }
      return { liked: profile.liked_by_me, like_count: profile.like_count };
    },
    async copy(id: number, _input: SharedProfileCopyInput): Promise<SharedProfileCopyResult> {
      const profile = profiles.find((item) => item.id === id && item.sharingStatus !== 'WITHDRAWN');
      if (!profile) throw new HallApiError(404, 'NOT_FOUND', '找不到这套演示配置。');
      if (!profile.used_by_me) {
        profile.used_by_me = true;
        profile.use_count += 1;
      }
      return { profile_id: nextProfileId++, name: `${profile.title}（演示副本）`, use_count: profile.use_count, duplicate: false };
    },
    async withdraw(id: number): Promise<void> {
      const profile = profiles.find((item) => item.id === id && item.is_mine);
      if (!profile) throw new HallApiError(404, 'NOT_FOUND', '找不到可撤回的演示配置。');
      profile.sharingStatus = 'WITHDRAWN';
    },
    async characters() {
      return {
        characters: [
          { aid: 1000001, cid: 2000002, nid: 3000003, char_name: '波利猎人', job_id: 11 },
          { aid: 1000001, cid: 2000004, nid: 3000005, char_name: '晨雾', job_id: 9 },
        ],
      };
    },
  };
}
