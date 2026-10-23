// All names, counts and file contents are fictional preview data.
export const characters = [
  { id: 'hunter', name: '波利猎人', job: '猎人', jobId: 11, profiles: 3 },
  { id: 'wizard', name: '晨雾', job: '巫师', jobId: 9, profiles: 1 },
];
export const profiles = [
  { id: 1, title: '猎人 · 斐扬树林日常', job: '猎人', jobId: 11, author: '林间晚风', code: 'HNT-0826', uses: 183, likes: 46, liked: false, used: false, date: '2026-10-23', description: '适合刚转职的猎人。以普攻为主，设置了低血量回城和箭矢补给；出发前记得换成自己的回城点。', map: 'pay_fild08' },
  { id: 2, title: '巫师 · 火墙练级与补给', job: '巫师', jobId: 9, author: '路过的魔法师', code: 'WIZ-1732', uses: 124, likes: 38, liked: false, used: false, date: '2026-10-22', description: '火墙配合火箭术，优先处理主动怪。带有坐下回蓝和药水补给，技能等级请按自己的情况调整。', map: 'geffen_fild10' },
  { id: 3, title: '牧师 · 双人队伍跟随辅助', job: '牧师', jobId: 8, author: '奶油面包', code: 'PTY-0621', uses: 79, likes: 29, liked: false, used: false, date: '2026-10-21', description: '给队友治疗、加速和天使之赐福。先设置跟随的队友名称，再按队伍的消耗调整补给。', map: 'prt_fild08' },
  { id: 4, title: '刺客 · 普攻拾取方案', job: '刺客', jobId: 12, author: '月下散步', code: 'SIN-3146', uses: 57, likes: 17, liked: false, used: false, date: '2026-10-20', description: '日常普攻练级，附常用拾取与存仓规则。把不需要的材料移出拾取清单即可。', map: 'moc_fild17' },
  { id: 5, title: '十字军 · 长时间练级', job: '十字军', jobId: 14, author: '普隆德拉守门员', code: 'CRU-2405', uses: 44, likes: 12, liked: false, used: false, date: '2026-10-19', description: '重视生存和回城补给，药水不足时停止战斗。适合以普攻为主的练级方式。', map: 'gef_fild14' },
  { id: 6, title: '猎人 · 弓手村轻量版', job: '猎人', jobId: 11, author: '波利猎人', mine: true, code: 'BOW-0918', uses: 0, likes: 0, liked: false, used: false, date: '2026-10-18', description: '', map: 'pay_fild01' },
];
export const fileNames = ['config.txt', 'mon_control.txt', 'pickupitems.txt', 'items_control.txt', 'timeouts.txt'];
export function filesFor(profile) {
  return {
    'config.txt': `# ${profile.title}\nlockMap ${profile.map}\nattackAuto 2\nroute_randomWalk 1\n\n# 请按角色情况调整\nuseSelf_item 红色药水 {\n  hp < 50%\n}`,
    'mon_control.txt': 'all 1 0 0\n波利 1 0 0',
    'pickupitems.txt': 'all 1\n杰勒比结晶 1',
    'items_control.txt': 'all 0 1 0\n红色药水 100 0 0',
    'timeouts.txt': 'ai_attack 0.2\nai_route 0.5\nai_items_take 1',
  };
}
console.assert(profiles.length === 6 && new Set(profiles.map(p => p.code)).size === profiles.length);
console.assert(profiles.every(p => p.uses >= 0 && p.likes >= 0 && /^[A-Z]{3}-\d{4}$/.test(p.code)));
