/// 通用界面用词表（英 → 简体中文）。
///
/// 网页上的按钮、菜单、标签页常常只有一两个词，翻译引擎拿不到上下文，只能取最常见的词义：
/// Light → 光、Fork → 叉、License → 执照、Raw → 生的。整段文字正好是这些界面词时，
/// 直接用这张表里的译法，不交给引擎。
///
/// 来源是各类网站通用的界面词汇（账户、导航、设置、购物、代码托管、文档站、百科），
/// 不针对哪个具体网站；只在整段完全等于词条时才用，句子里出现的照常交给引擎。
const UI_ZH: Record<string, string> = {
  // 账户
  'sign in': '登录', 'log in': '登录', 'login': '登录', 'sign up': '注册', 'register': '注册',
  'sign out': '退出登录', 'log out': '退出登录', 'logout': '退出登录', 'create account': '创建账户',
  'create an account': '创建账户', 'my account': '我的账户', 'account': '账户', 'profile': '个人资料',
  'forgot password?': '忘记密码？', 'forgot password': '忘记密码', 'password': '密码', 'username': '用户名',
  // 通用动作
  'get started': '开始使用', 'get started for free': '免费开始使用', 'learn more': '了解更多', 'read more': '阅读更多',
  'see more': '查看更多', 'show more': '显示更多', 'show less': '收起', 'see all': '查看全部', 'view all': '查看全部',
  'more': '更多', 'hide': '隐藏', 'show': '显示', 'close': '关闭', 'cancel': '取消', 'ok': '确定', 'save': '保存',
  'edit': '编辑', 'delete': '删除', 'remove': '移除', 'add': '添加', 'share': '分享', 'copy': '复制', 'copied': '已复制',
  'download': '下载', 'upload': '上传', 'search': '搜索', 'filter': '筛选', 'filters': '筛选', 'sort': '排序',
  'sort by': '排序方式', 'apply': '应用', 'reset': '重置', 'submit': '提交', 'send': '发送', 'back': '返回',
  'continue': '继续', 'done': '完成', 'retry': '重试', 'refresh': '刷新', 'subscribe': '订阅', 'unsubscribe': '取消订阅',
  'follow': '关注', 'reply': '回复', 'comments': '评论', 'comment': '评论', 'print': '打印', 'expand': '展开',
  'collapse': '收起', 'expand all': '全部展开', 'collapse all': '全部收起', 'select all': '全选', 'skip': '跳过',
  'skip to content': '跳到正文', 'skip to main content': '跳到正文', 'back to top': '返回顶部',
  // 导航、站点
  'home': '首页', 'menu': '菜单', 'about': '关于', 'about us': '关于我们', 'contact': '联系我们', 'contact us': '联系我们',
  'contact sales': '联系销售', 'help': '帮助', 'help center': '帮助中心', 'support': '支持', 'docs': '文档',
  'documentation': '文档', 'pricing': '价格', 'plans': '套餐', 'blog': '博客', 'careers': '招聘', 'jobs': '职位',
  'news': '新闻', 'events': '活动', 'community': '社区', 'resources': '资源', 'products': '产品', 'solutions': '解决方案',
  'features': '功能', 'overview': '概览', 'enterprise': '企业版', 'customers': '客户', 'partners': '合作伙伴',
  'developers': '开发者', 'company': '公司', 'legal': '法律信息', 'status': '状态', 'changelog': '更新日志',
  'download app': '下载应用', 'language': '语言', 'languages': '语言', 'settings': '设置', 'preferences': '偏好设置',
  'notifications': '通知', 'messages': '消息', 'dashboard': '仪表盘', 'explore': '探索', 'trending': '热门',
  // 隐私、条款、Cookie
  'privacy': '隐私', 'privacy policy': '隐私政策', 'terms': '条款', 'terms of service': '服务条款', 'terms of use': '使用条款',
  'cookie settings': 'Cookie 设置', 'cookie preferences': 'Cookie 偏好设置', 'cookies settings': 'Cookie 设置',
  'accept': '接受', 'accept all': '全部接受', 'accept all cookies': '接受所有 Cookie', 'reject all': '全部拒绝',
  'decline': '拒绝', 'manage preferences': '管理偏好设置', 'manage cookies': '管理 Cookie', 'necessary': '必要',
  // 购物
  'cart': '购物车', 'shopping cart': '购物车', 'checkout': '结算', 'add to cart': '加入购物车', 'buy now': '立即购买',
  'wishlist': '心愿单', 'orders': '订单', 'free': '免费', 'free trial': '免费试用', 'start free trial': '开始免费试用',
  'try for free': '免费试用', 'try it free': '免费试用', 'view details': '查看详情', 'details': '详情',
  'in stock': '有货', 'out of stock': '缺货', 'shipping': '配送', 'returns': '退货', 'reviews': '评价', 'deals': '优惠',
  'monthly': '按月', 'yearly': '按年', 'annually': '按年', 'per month': '每月', 'most popular': '最受欢迎',
  // 外观（主题）
  'light': '浅色', 'dark': '深色', 'auto': '自动', 'automatic': '自动', 'system': '跟随系统', 'theme': '主题',
  'appearance': '外观', 'color': '颜色', 'colour': '颜色', 'text': '文字', 'width': '宽度', 'small': '小', 'standard': '标准',
  'large': '大', 'wide': '宽',
  // 代码托管
  'code': '代码', 'issues': '议题', 'pull requests': '拉取请求', 'projects': '项目', 'wiki': 'Wiki', 'security': '安全',
  'insights': '洞察', 'fork': '复刻', 'forks': '复刻', 'star': '星标', 'stars': '星标', 'watch': '关注', 'watchers': '关注者',
  'raw': '原始文件', 'blame': '追溯', 'history': '历史记录', 'branches': '分支', 'branch': '分支', 'tags': '标签',
  'releases': '发布版本', 'packages': '软件包', 'contributors': '贡献者', 'license': '许可证', 'readme': 'README',
  'about this repository': '关于此仓库', 'go to file': '转到文件', 'add file': '添加文件', 'clone': '克隆',
  'commits': '提交', 'files': '文件', 'repository': '仓库', 'homepage': '主页', 'dependencies': '依赖项',
  'dependents': '依赖方', 'versions': '版本', 'version': '版本', 'install': '安装', 'weekly downloads': '每周下载量',
  'last publish': '最近发布', 'unpacked size': '解压后大小', 'total files': '文件总数', 'issues & pull requests': '议题和拉取请求',
  // 文档站
  'examples': '示例', 'example': '示例', 'syntax': '语法', 'parameters': '参数', 'return value': '返回值',
  'description': '说明', 'specifications': '规范', 'browser compatibility': '浏览器兼容性', 'see also': '另请参阅',
  'on this page': '本页内容', 'in this article': '本文内容', 'table of contents': '目录', 'contents': '目录',
  'edit this page': '编辑此页', 'view source': '查看源代码', 'show source': '查看源代码', 'report a bug': '报告问题',
  'previous topic': '上一主题', 'next topic': '下一主题', 'this page': '本页', 'previous': '上一页', 'next': '下一页',
  'getting started': '入门', 'tutorials': '教程', 'tutorial': '教程', 'reference': '参考', 'guides': '指南', 'guide': '指南',
  'concepts': '概念', 'tasks': '任务', 'installation': '安装', 'configuration': '配置', 'api reference': 'API 参考',
  'containers': '容器', 'nodes': '节点', 'clusters': '集群', 'services': '服务', 'deployments': '部署',
  // 开发文档站常见的栏目、导航词（有道单独翻常取日常义：Playground→操场、Performance→表演、Engine→发动机）
  'playground': '演练场', 'performance': '性能', 'development': '开发', 'develop': '开发', 'engine': '引擎',
  'forms': '表单', 'form': '表单', 'essentials': '基础知识', 'fundamentals': '基础知识', 'basics': '基础',
  'breaking changes': '破坏性变更', 'advanced': '高级', 'advanced level': '高级', 'beginner': '入门', 'intermediate': '中级',
  'administration': '管理', 'admin': '管理', 'mirrors': '镜像', 'mirror': '镜像', 'mirror list': '镜像列表', 'mirror status': '镜像状态',
  'showcase': '案例展示', 'integrations': '集成', 'plugins': '插件', 'plugin': '插件', 'extensions': '扩展', 'templates': '模板',
  'components': '组件', 'deploy': '部署', 'deployment': '部署', 'hosting': '托管', 'roadmap': '路线图', 'sponsor': '赞助',
  'sponsors': '赞助商', 'release notes': '发布说明', 'migration guide': '迁移指南', 'troubleshooting': '故障排除', 'faq': '常见问题',
  'faqs': '常见问题', 'learn': '学习', 'build': '构建', 'testing': '测试', 'debugging': '调试', 'routing': '路由',
  'middleware': '中间件', 'authentication': '身份验证', 'authorization': '授权', 'database': '数据库', 'storage': '存储',
  'functions': '函数', 'realtime': '实时', 'models': '模型', 'datasets': '数据集', 'chat': '聊天', 'forum': '论坛', 'forums': '论坛',
  'newsletter': '新闻通讯', 'press': '媒体报道', 'cookies': 'Cookie', 'cookie policy': 'Cookie 政策', 'accept cookies': '接受 Cookie',
  'cookie notice': 'Cookie 声明', 'crates': 'Crate', 'packages & crates': '包', 'libraries': '库', 'library': '库', 'modules': '模块',
  'directives': '指令', 'sitemap': '网站地图', 'glossary': '术语表', 'what\'s new': '新功能',
  'get the app': '获取应用', 'try it': '试一试', 'try it now': '立即试用', 'book a demo': '预约演示', 'request a demo': '申请演示',
  // 文档站、产品站常见按钮和栏目（第二批）
  'collapse sidebar': '收起侧边栏', 'expand sidebar': '展开侧边栏', 'toggle sidebar': '切换侧边栏', 'extras': '附加内容',
  'processes': '进程', 'go to repo': '前往仓库', 'go to repository': '前往仓库', 'create an issue': '提交议题', 'open an issue': '提交议题',
  'accept required only': '仅接受必要 Cookie', 'reject optional': '拒绝非必要 Cookie', 'accept required': '仅接受必要 Cookie',
  'download notebook': '下载 Notebook', 'run in google colab': '在 Google Colab 中运行', 'operations': '运维', 'index': '索引',
  'swag': '周边商品', 'api docs': 'API 文档', 'edit on github': '在 GitHub 上编辑', 'view on github': '在 GitHub 上查看',
  'edit this page on github': '在 GitHub 上编辑此页', 'copy page': '复制页面', 'copy markdown': '复制 Markdown', 'ask ai': '问 AI',
  'search docs': '搜索文档', 'search documentation': '搜索文档', 'was this page helpful?': '此页面有帮助吗？', 'yes': '是', 'no': '否',
  'feedback': '反馈', 'give feedback': '提供反馈', 'send feedback': '发送反馈', 'next steps': '后续步骤', 'prerequisites': '前提条件',
  'requirements': '要求', 'quick start': '快速开始', 'quickstart': '快速开始', 'how-to guides': '操作指南', 'explanation': '说明',
  'contribute': '贡献', 'contributing': '参与贡献', 'code of conduct': '行为准则', 'security policy': '安全策略', 'self-hosted': '自托管',
  'open source': '开源', 'use cases': '使用场景', 'case studies': '案例研究', 'marketplace': '市场', 'webinars': '网络研讨会',
  'podcast': '播客', 'videos': '视频', 'courses': '课程', 'certification': '认证', 'contact support': '联系支持', 'talk to sales': '联系销售',
  'start for free': '免费开始', 'get a demo': '获取演示', 'book demo': '预约演示', 'watch live': '观看直播', 'sign up for free': '免费注册', 'dark mode': '深色模式',
  'light mode': '浅色模式', 'system default': '跟随系统', 'what\'s next': '接下来', 'overview & concepts': '概览与概念', 'api': 'API',
  'sdks': 'SDK', 'cli reference': 'CLI 参考', 'self-hosting': '自托管', 'integrations & plugins': '集成与插件', 'community forum': '社区论坛',
  // 百科
  'article': '条目', 'talk': '讨论', 'read': '阅读', 'view history': '查看历史', 'tools': '工具', '(top)': '（顶部）',
  'main page': '首页', 'random article': '随机条目', 'donate': '捐款', 'references': '参考文献', 'notes': '注释',
  'external links': '外部链接', 'further reading': '延伸阅读', 'what links here': '链入页面', 'related changes': '相关更改',
  'cite this page': '引用此页', 'print/export': '打印/导出', 'download as pdf': '下载为 PDF',
};

/// "数字 + 单位" 的计数短语（论坛、新闻站、代码托管站的信息行）："154 comments"、"8 hours ago"、"1.2k stars"。
/// 有道单独翻常出错（"27 comments"→"27日评论"、"41 comments"→"41岁的评论"），这里直接给译法
const COUNT_UNIT: Record<string, string> = {
  comment: '条评论', comments: '条评论', reply: '条回复', replies: '条回复', point: '分', points: '分', vote: '票', votes: '票',
  view: '次浏览', views: '次浏览', like: '个赞', likes: '个赞', star: '个星标', stars: '个星标', fork: '个复刻', forks: '个复刻',
  follower: '位关注者', followers: '位关注者', download: '次下载', downloads: '次下载', member: '位成员', members: '位成员',
  answer: '个回答', answers: '个回答', share: '次分享', shares: '次分享', result: '条结果', results: '条结果',
  item: '项', items: '项', file: '个文件', files: '个文件', commit: '次提交', commits: '次提交', contributor: '位贡献者', contributors: '位贡献者',
};
const AGO_UNIT: Record<string, string> = {
  second: '秒', seconds: '秒', minute: '分钟', minutes: '分钟', min: '分钟', mins: '分钟', hour: '小时', hours: '小时',
  day: '天', days: '天', week: '周', weeks: '周', month: '个月', months: '个月', year: '年', years: '年',
};
function countPhrase(key: string, text: string): string | undefined {
  // 数字不能以点结尾（"3.4. Comments" 是章节号，不是 3.4 条评论）
  let m = key.match(/^(\d[\d,]*(?:\.\d+)?[km]?) ([a-z]+)$/);
  if (m && COUNT_UNIT[m[2]]) return `${m[1].toUpperCase()} ${COUNT_UNIT[m[2]]}`;
  const ago = (n: string, u: string) => AGO_UNIT[u] ? `${/^an?$/.test(n) ? 1 : n} ${AGO_UNIT[u]}前` : undefined;
  m = key.match(/^(an?|\d+) ([a-z]+) ago$/);
  if (m) return ago(m[1], m[2]);
  // 论坛信息行："408 points by firelex 8 hours ago"、"via carlana 6 hours ago"、"submitted 3 hours ago by x"（用户名原样）
  const raw = text.trim().replace(/\s+/g, ' ');
  m = raw.match(/^(\d[\d,]*) (?:points?|votes?) by (\S+) (an?|\d+) ([a-z]+) ago$/i);
  if (m && ago(m[3], m[4].toLowerCase())) return `${m[1]} 分 · ${m[2]} · ${ago(m[3], m[4].toLowerCase())}`;
  m = raw.match(/^(?:via|by|authored by|submitted by) (\S+) (an?|\d+) ([a-z]+) ago$/i);
  if (m && ago(m[2], m[3].toLowerCase())) return `${m[1]} · ${ago(m[2], m[3].toLowerCase())}`;
  if (key === 'discuss') return '讨论';
  if (key === 'just now') return '刚刚';
  return undefined;
}

/// 整段文字就是一个界面词时返回固定译法，否则返回 undefined（交给引擎）
export function uiTerm(text: string, targetLang: string): string | undefined {
  const lang = targetLang.toLowerCase();
  if (!(lang === 'zh' || lang === 'zh-cn' || lang === 'zh-hans')) return undefined;
  const key = text.trim().replace(/\s+/g, ' ').replace(/\s*[›»>→⌄]$/, '').toLowerCase();
  if (key.length > 40) return undefined;
  return UI_ZH[key] ?? countPhrase(key, text);
}

/// 常见技术产品、公司名。整段就是这个名字时不翻；句中首字母大写出现（不在句首）时遮起来不翻。
/// 只收"会被当成普通英文词翻掉"或者经常被音译的那些。
export const BRAND_WORDS = [
  'Rust', 'Go', 'Golang', 'Swift', 'Kotlin', 'Ruby', 'Rails', 'Django', 'Flask', 'React', 'Vue', 'Angular', 'Svelte',
  'Node', 'Deno', 'Bun', 'Docker', 'Kubernetes', 'Git', 'Yarn', 'Vite', 'Webpack', 'Redis', 'Postgres', 'PostgreSQL',
  'MySQL', 'SQLite', 'MongoDB', 'Kafka', 'Spark', 'Nginx', 'Ubuntu', 'Debian', 'Fedora', 'Homebrew', 'Vercel',
  'Netlify', 'Heroku', 'Cloudflare', 'AWS', 'Azure', 'Stripe', 'Shopify', 'PayPal', 'Spotify', 'Netflix', 'YouTube',
  'Reddit', 'Discord', 'Telegram', 'WhatsApp', 'Zoom', 'Dropbox', 'Jira', 'Confluence', 'Trello', 'Asana', 'Linear',
  'Canva', 'Adobe', 'Photoshop', 'Steam', 'Nintendo', 'PlayStation', 'Xbox', 'Mac', 'MacBook', 'iMac', 'iPad',
  'iPhone', 'AirPods', 'Apple', 'Microsoft', 'Amazon', 'Meta', 'Facebook', 'Instagram', 'TikTok', 'Wikipedia',
  'Tailwind', 'Bootstrap', 'Electron', 'Unity', 'Godot', 'Blender', 'Notion', 'Slack', 'Figma', 'Chrome', 'Safari',
  'Firefox', 'Chromium', 'Android', 'Windows', 'Linux', 'Python', 'Java', 'JavaScript', 'TypeScript', 'Perl',
  'Haskell', 'Scala', 'Elixir', 'Erlang', 'Julia', 'Dart', 'Flutter', 'Laravel', 'Symfony', 'Spring', 'Express',
  'Next.js', 'Nuxt', 'Remix', 'Astro', 'GraphQL', 'Terraform', 'Ansible', 'Jenkins', 'CircleCI', 'Travis', 'Grafana',
  'Prometheus', 'Elasticsearch', 'Kibana', 'Tailwind CSS', 'pandas', 'conda', 'Cargo', 'Vitest', 'Prisma', 'Jest',
  'Eloquent', 'Herd', 'Proton', 'Sentry', 'Markdown', 'Airtable', 'Zapier', 'Mastodon', 'WordPress', 'FreeBSD',
  'Audacity', 'Thunderbird', 'Inkscape', 'Raspberry Pi', 'Hacker News', 'OpenStreetMap', 'Hugging Face',
  'Transformers', 'Signal', 'Obsidian', 'SvelteKit', 'Gatsby', 'Hugo', 'Jekyll', 'Pydantic', 'Starlette', 'Uvicorn',
  'Gunicorn', 'Celery', 'Poetry', 'Ruff', 'Pytest', 'Keras', 'Matplotlib', 'SciPy', 'Scikit-learn', 'Streamlit',
  'Gradio', 'LangChain', 'Ollama', 'Copilot', 'Cursor', 'Postman', 'Insomnia', 'Chocolatey', 'Vagrant', 'Packer',
  'Consul', 'Vault', 'Nomad', 'RabbitMQ', 'Cassandra', 'Neo4j', 'DuckDB', 'ClickHouse', 'Snowflake', 'Databricks',
  'Airflow', 'dbt', 'Sketch', 'Framer', 'Webflow', 'Squarespace', 'Wix', 'Ghost', 'Substack', 'Medium', 'Twilio',
  'Auth0', 'Okta', 'Clerk', 'Neon', 'PlanetScale', 'Turso', 'Upstash', 'Fly.io', 'Render', 'Railway', 'jQuery',
  'IntelliJ', 'IntelliJ IDEA', 'PyCharm', 'WebStorm', 'Supabase', 'Firebase', 'NumPy', 'PyTorch', 'TensorFlow',
  'Jupyter', 'Anaconda', 'Babel', 'Parcel', 'Wayland', 'Wine', 'ESLint', 'Prettier', 'Rollup', 'esbuild',
];
