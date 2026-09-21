export interface ReleaseChange {
  category: string;
  title: string;
  description: string;
}

export interface ReleaseNote {
  version: string;
  date: string;
  title: string;
  summary: string;
  changes: ReleaseChange[];
}

/**
 * 更新说明的唯一内容来源。
 * 新增版本时，把新对象放在数组最前面即可，页面会按数组顺序展示。
 */
export const releaseNotes: ReleaseNote[] = [
  {
    version: '0.3.0',
    date: '2026-09-21',
    title: '搜索体验与市场详情',
    summary: '把常用的筛选和查看动作收拢到一次搜索里，让找到合适的在售商品更直接。',
    changes: [
      {
        category: '搜索',
        title: '词条组合筛选',
        description: '支持同时添加多个词条条件，并选择全部满足或满足任一。',
      },
      {
        category: '定位',
        title: '四城地图标记',
        description: '搜索结果保留商人坐标，可直接打开对应地图查看位置。',
      },
      {
        category: '历史',
        title: '价格历史入口',
        description: '每条在售记录都可以展开价格变化和推断售出记录。',
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-09-19',
    title: '目录搜索上线',
    summary: '建立由站点维护的物品目录，让搜索结果和物品展示使用稳定的物品 ID。',
    changes: [
      {
        category: '目录',
        title: '物品名称与别名',
        description: '搜索支持官方目录中的名称和别名，未知物品也会保留 ID 展示。',
      },
      {
        category: '结果',
        title: '分组结果视图',
        description: '按物品、商店和玩家命中位置组织结果，便于快速比较价格。',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-18',
    title: '露天市场初版',
    summary: '公开市场记录的第一版浏览入口，先把在售商品、商店和地图信息放在一起。',
    changes: [
      {
        category: '市场',
        title: '在售商品搜索',
        description: '可以按关键词、价格、地图和商店类型查询当前市场记录。',
      },
      {
        category: '资料',
        title: '交易信息展示',
        description: '结果包含商品、价格、数量、地图、摊主和更新时间。',
      },
    ],
  },
];
