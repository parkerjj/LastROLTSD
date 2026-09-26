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
    version: '0.7.0',
    date: '2026-09-26',
    title: '词条查询优化与地图定位重设计',
    summary: '装备词条查询区分数值型与开关型，属性类词条不再需要填数值，空槽位等无效选项自动隐藏；地图定位抽屉展示商店招牌气泡，摊位位置一目了然。',
    changes: [
      {
        category: '词条',
        title: '开关型词条无需填数值',
        description: '「赋予武器/铠甲属性」「武器/铠甲不会被破坏」等属性类词条改为开关型，选中后不再显示比较符和数值输入框，直接生效。',
      },
      {
        category: '词条',
        title: '空槽位等无效选项隐藏',
        description: '「空槽位」等占位词条从下拉选择器中移除，避免误选。',
      },
      {
        category: '搜索',
        title: '词条筛选表单优化',
        description: '查询表单自动隐藏不可选词条，开关型词条显示「无需数值」提示，筛选操作更直观。',
      },
      {
        category: '地图',
        title: '地图定位抽屉重设计',
        description: '地图标记新增 RO 风格招牌气泡显示商店名称，抽屉头部展示地图名、坐标和店名；气泡靠近边缘时尾巴自动锚定星标，不再错位。',
      },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-09-25',
    title: '菜农监控台与一键启动游戏',
    summary: '新增菜农监控台，游戏账号状态随时查，还能一键启动游戏客户端；价格历史补上物品档案卡与重试，图表刻度显示同步修复。',
    changes: [
      {
        category: '监控',
        title: '菜农监控台上线',
        description: '新增「账号监控台」页面，添加游戏账号后随时查看角色等级、经验进度、所在地图和在线状态，支持单个刷新或全部刷新；账号仅保存在你自己的浏览器中。',
      },
      {
        category: '启动',
        title: '一键启动游戏',
        description: '监控台内置「启动稳定版 V1」，默认在新标签页内嵌打开官方网页客户端，也可勾选切换为全屏独立窗口，不再卡在初始化界面。',
      },
      {
        category: '导航',
        title: '全站导航菜单',
        description: '所有页面顶部新增统一导航，搜索市场、账号监控台、玩家登记簿、更新说明一键直达，窄屏下自动折叠为汉堡菜单。',
      },
      {
        category: '隐私',
        title: '账号直连油猴脚本',
        description: '账号状态查询默认由本站中转一次（不记录任何凭证），介意的话可安装「账号监控直连助手」油猴脚本，让浏览器直连官方服务器查询。',
      },
      {
        category: '历史',
        title: '空状态档案卡与重试',
        description: '价格历史查询失败或暂无数据时，展示带物品图标、名称和 ID 的档案卡，并提供「重新查询」按钮，提示文案也更准确。',
      },
      {
        category: '历史',
        title: '图表刻度显示修复',
        description: '修复价格走势图纵轴金额被截断的问题（例如 555.5万z 显示成 55.5万Z），刻度改为整数显示并加宽左侧留白。',
      },
      {
        category: '数据',
        title: '下架商店记录补全',
        description: '修复已收摊商店未记录过期事件的问题，价格历史中的推断售出记录更完整。',
      },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-09-24',
    title: '搜索命中范围与词条展示优化',
    summary: '新增搜索命中范围开关，优化词条展示方式，无结果时提供图鉴兜底查询，让搜索更精准、展示更清晰。',
    changes: [
      {
        category: '搜索',
        title: '命中范围开关',
        description: '高级搜索新增「命中范围」控制，可分别开启/关闭道具名称、商店名称、商人名称三个维度，精准定位想要的结果。',
      },
      {
        category: '展示',
        title: '词条芯片换行展示',
        description: '搜索结果中的词条改为独立的可换行芯片标签，告别文本截断，长词条也能完整显示。',
      },
      {
        category: '详情',
        title: '悬停词条属性',
        description: '鼠标悬停物品详情时，底部新增「词条属性」分区，每个词条以独立小卡片展示，属性一目了然。',
      },
      {
        category: '兜底',
        title: '图鉴历史价格查询',
        description: '搜索无结果时，自动展示物品图鉴中匹配的相关道具，可直接查询历史价格。',
      },
      {
        category: '交互',
        title: '抽屉体验优化',
        description: '地图定位与价格历史抽屉新增底部关闭按钮，打开时主界面显示半透明遮罩，点击即可关闭，两个抽屉互斥显示。',
      },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-09-23',
    title: '浅色界面焕新与 GPT 一键带路',
    summary: '整体换成更清爽的浅色界面，补上市场新鲜度指示和游戏内一键带路，浏览商品、找到摊位都更顺手。',
    changes: [
      {
        category: '界面',
        title: '浅色主题与结果卡片',
        description: '全站改为清爽浅色设计，商店配上露天摊位插画、商人配上冒险者图标，物品名称命中改为独立卡片，层次更清楚。',
      },
      {
        category: '带路',
        title: 'GPT 一键寻路',
        description: '地图弹窗中可一键复制带路指令，粘贴到游戏内 GPT 频道发送，即可自动前往商人坐标，并附操作图示。',
      },
      {
        category: '搜索',
        title: '物品名联想补全',
        description: '输入关键词时按官方物品目录实时联想物品名称，记不全名字也能快速找到。',
      },
      {
        category: '翻页',
        title: '手机翻页更方便',
        description: '结果提示改为“查看 1-20 个商品”，列表顶部新增翻页按钮，搜索或翻页后自动定位到结果区。',
      },
      {
        category: '状态',
        title: '市场新鲜度指示',
        description: '顶部显示市场数据调查员在线、小憩或离线状态，以及最近一次更新时间，一眼判断数据新旧。',
      },
      {
        category: '物品',
        title: '官方物品描述',
        description: '点开物品可查看官方物品说明，了解装备和道具的具体效果。',
      },
      {
        category: '性能',
        title: '搜索响应提速',
        description: '热门搜索结果增加公共缓存，重复查询打开更快。',
      },
      {
        category: '社区',
        title: 'QQ 交流群入口',
        description: '一键复制群号加入玩家交流群，反馈问题和交流物价更方便。',
      },
    ],
  },
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
