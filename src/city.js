// 第二幕的世界：地下城市“深泉”。
// 城市按真实的收支运转：地热发电、光田种粮、循环水、通风排热。所有数字都有单位。
import { satVaporKPa, hash01 } from './physics.js';

export const CITY = { name: '深泉', founded: 2041, sealed: 2098, pop: 21400 };

/** 区域。depth 为地面以下的米数；岩温随深度每百米升约 3°C，所以越深越热 */
export const DISTRICTS = {
  gate: { name: '闸口', depth: 35, airT: 26, rh: 40, hue: [210, 214, 220], desc: '气闸、检疫站和一间值班室。墙上的应急灯两百年没灭过，地上的沙是你带进来的。' },
  hall: { name: '议事厅', depth: 120, airT: 24, rh: 50, hue: [232, 214, 170], desc: '环形的石阶会场，旁边是户籍处的三个窗口。墙上刻着历届议员的名字，最早的一排已经被摸得发亮。' },
  market: { name: '中庭集市', depth: 140, airT: 24, rh: 55, hue: [246, 208, 140], desc: '一个六层楼高的岩洞，顶上挂着一盏模拟日光的大灯。摊位、食堂、告示栏、公共水龙头都在这里，全城的人每天至少路过一次。' },
  school: { name: '学堂与医馆', depth: 160, airT: 24, rh: 50, hue: [220, 232, 214], desc: '一条安静的侧廊，左边是学堂，右边是医馆。走廊里晾着孩子们画的画——画的大多是他们没见过的东西：云、雨、河。' },
  homes: { name: '环廊居住区', depth: 180, airT: 23, rh: 50, hue: [240, 200, 150], desc: '一圈一圈凿进岩壁的住家，门口种着照得到廊灯的葱和薄荷。孟九的客栈在最外圈，专收没有住处的人。' },
  archive: { name: '档案馆', depth: 200, airT: 21, rh: 35, hue: [200, 206, 226], desc: '恒温恒湿，比别处都干、都凉。开架区谁都能看，闭架区的铁门上有两把锁。' },
  farms: { name: '光田', depth: 240, airT: 28, rh: 75, hue: [236, 120, 200], desc: '一层叠一层的水培架，望不到头。灯是紫红色的——植物只要红光和蓝光，多一分别的颜色都是浪费电。空气又湿又甜。' },
  water: { name: '水厂', depth: 320, airT: 19, rh: 85, hue: [120, 190, 230], desc: '蓄水库像一个黑色的湖，对岸的灯照不到这边。回水管、净化塔、溢流渠都从这里出发。这里是全城最凉的地方。' },
  heat: { name: '热井', depth: 860, airT: 39, rh: 60, wind: 3, hue: [240, 130, 70], desc: '全城的电都从这里来。岩壁烫手，管道里是从更深处抽上来的高压热水。每干四十分钟必须进冷却舱歇二十分钟，这是写进规程的。' },
};

const EDGES = [
  ['gate', 'market', 6],
  ['market', 'hall', 4],
  ['market', 'school', 5],
  ['market', 'homes', 5],
  ['market', 'farms', 8],
  ['homes', 'archive', 6],
  ['homes', 'farms', 6],
  ['farms', 'water', 7],
  ['water', 'heat', 15],
];
export function links(id) {
  const out = [];
  for (const [a, b, min] of EDGES) {
    if (a === id) out.push({ to: b, minutes: min });
    if (b === id) out.push({ to: a, minutes: min });
  }
  return out;
}

/** 城里的“白天”：06–22 点亮大灯，其余时间只留廊灯 */
export function lightsOn(tMin) {
  const h = (tMin % 1440) / 60;
  return h >= 6 && h < 22;
}

/** 某个区域此刻的环境，格式与地表的 climate() 相同，可直接交给人体模型 */
export function cityEnv(id, tMin, { cooled = false } = {}) {
  const d = DISTRICTS[id];
  const airT = cooled ? 24 : d.airT - (lightsOn(tMin) ? 0 : 1);
  const rh = cooled ? 45 : d.rh;
  return {
    day: Math.floor(tMin / 1440),
    hour: (tMin % 1440) / 60,
    sunElev: -1,
    dni: 0,
    dhi: 0,
    ghi: 0,
    airT,
    groundT: airT,
    soilT: airT,
    wind: cooled ? 0.5 : d.wind ?? 0.5, // 热井有强制通风
    vapor: (rh / 100) * satVaporKPa(airT),
    rh,
    storm: 0,
    isDay: lightsOn(tMin),
  };
}

// —— 每天的城中大事（由种子决定）——
export const EVENTS = {
  none: { name: '平常的一天', note: '各系统运行正常。' },
  well: { name: '一号热井检修', note: '发电量降到八成，光田分区轮流熄灯。' },
  pump: { name: '三号回水泵故障', note: '回收率下降，水厂在招临时工，工钱加四分之一。' },
  harvest: { name: '光田收获日', note: '新粮入库，食堂和摊位今天便宜两成。' },
  vote: { name: '议事厅表决日', note: '今天表决的是光田第九层的扩建案。旁听席对所有人开放。' },
};
export function eventOn(seed, day) {
  const r = hash01(seed + 307, day);
  if (day === 0) return 'none';
  return r < 0.45 ? 'none' : r < 0.6 ? 'well' : r < 0.74 ? 'pump' : r < 0.88 ? 'harvest' : 'vote';
}

export function newCity(seed) {
  return { seed, reservoirM3: 90000, foodDays: 41 }; // 水库是满的：溢流渠一直在往地表排水，绿洲就是这么来的
}

const RESERVOIR_CAP = 90000;

/** 此刻的城市收支。纯函数，供界面显示和每小时结算 */
export function citySystems(city, tMin) {
  const day = Math.floor(tMin / 1440);
  const h = (tMin % 1440) / 60;
  const ev = eventOn(city.seed, day);
  const pop = CITY.pop;

  // 电：地热供电；最大的用户是光田的灯（每人约 3.6 kW 才够种出一个人的口粮）
  const supplyMW = 118 * (ev === 'well' ? 0.8 : 1);
  const farmWantMW = h >= 4 && h < 22 ? 78 : 6;
  const ventMW = 17;
  const waterMW = 6;
  const homesMW = 9 + 7 * Math.max(0, Math.sin((Math.PI * (h - 6)) / 16));
  const farmMW = Math.min(farmWantMW, supplyMW - ventMW - waterMW - homesMW);
  const lit = farmWantMW > 6 ? farmMW / farmWantMW : 0; // 光田亮灯比例
  const demandMW = farmMW + ventMW + waterMW + homesMW;

  // 粮：亮灯才长
  const eatKcalH = (pop * 2300) / 24;
  const growKcalH = lit > 0 ? ((pop * 2300 * 1.04) / 18) * lit : 0;

  // 水：含水层补给 − 没能回收的损失；水库满了就从溢流渠排到地表
  const recycle = ev === 'pump' ? 0.88 : 0.96;
  const useM3h = (pop * 0.13) / 24;
  const lossM3h = useM3h * (1 - recycle) + 14 * (lit > 0 ? 1 : 0.4);
  const netM3h = 52 - lossM3h;
  const overflowLs = city.reservoirM3 >= RESERVOIR_CAP ? Math.max(0, (netM3h * 1000) / 3600) : 0;

  // 气：人耗氧，光田产氧；中庭的二氧化碳随人流起伏
  const o2UseKgH = (pop * 0.84) / 24;
  const o2MakeKgH = growKcalH * 0.00057;
  const crowd = lightsOn(tMin) ? 0.5 + 0.5 * Math.sin((Math.PI * (h - 6)) / 16) : 0.1;
  const co2ppm = Math.round(620 + 520 * crowd + (ev === 'well' ? 90 : 0));

  return {
    event: ev,
    supplyMW,
    demandMW,
    farmMW,
    lit,
    eatKcalH,
    growKcalH,
    recycle,
    netM3h,
    overflowLs,
    o2UseKgH,
    o2MakeKgH,
    co2ppm,
    heatMW: demandMW + (pop * 100) / 1e6, // 用掉的电和人的体热最终都变成热，要排出去
    foodPrice: Math.min(2, Math.max(0.8, Math.sqrt(40 / city.foodDays))) * (ev === 'harvest' ? 0.8 : 1),
  };
}

/** 每小时结算一次库存 */
export function cityTick(city, tMin) {
  const s = citySystems(city, tMin);
  city.reservoirM3 = Math.min(RESERVOIR_CAP, city.reservoirM3 + s.netM3h);
  city.foodDays += (s.growKcalH - s.eatKcalH) / (CITY.pop * 2300);
}

// —— 学堂的四堂课：深泉人从小学到的历史 ——
export const LESSONS = [
  '第一课。二十一世纪三十年代，热浪和干旱一年比一年长，大河一条接一条断流。各国开始修建“深层避难与水源工程”，把人和水一起搬到地下。深泉是其中的第七号。',
  '第二课。2041 年，第一批六千人下井。那时闸门是开着的，地表和地下一直有往来：上面送来机器和种子，下面送出水。',
  '第三课。2098 年，议事厅表决封闸。课本上只有一句话：“地表已无可往来者。”沈老师念到这里停了一下，说：“这句话你们要背，考试会考。”',
  '第四课。封闸之后的一百二十八年，深泉靠地热、光田和循环水自给自足，人口从六千长到两万一千。“我们是最后的人，”课本的最后一页写着，“所以每一个人都不能浪费。”',
];

/**
 * 居民。at: [起, 止, 区域] 的作息表（小时）；不在表里的时间是在家睡觉。
 * lines: 按熟悉程度依次说的话，可以是字符串，也可以是 (state, sys) => 字符串。
 */
export const NPCS = [
  {
    id: 'warden', name: '祁守常', age: 58, role: '闸官', sponsor: true, at: [[6, 20, 'gate']],
    lines: [
      '“……人？”他手里的油壶掉在地上。“从上面？你是从上面下来的？”',
      '“我爹是闸官，我爷爷也是。规程上写着：手轮每旬上油一次，闸外积沙每年清一次。清沙那条早就没人管了，上油我一次没落过。三十年，我以为我在给一扇不会再开的门上油。”',
      '“他们会跟你说上面没人了。课本上是这么写的。你就站在这儿，他们还是会这么说。别急，慢慢来。”',
      '“你要落户，得有人作保。要是户籍处问起，就说祁守常给你作保。我这辈子就等来你这一个从门外进来的，不保你保谁。”',
      '“闸口的灯要是哪天灭了，你来告诉我一声。”',
    ],
  },
  {
    id: 'doctor', name: '文殊兰', age: 34, role: '检疫医生', at: [[8, 16, 'gate'], [16, 20, 'school']],
    lines: [
      '“别动，让我看看你的眼睛。……晒伤，脱水，脚底全是水泡。书上写过这些，我从来没亲眼见过。”',
      '“我们这儿最常见的病是缺维生素 D 和湿疹。没人中暑，没人晒伤。你身上的毛病，我得翻两百年前的医书。”',
      '“你的心肺比这里所有人都好。我们一辈子不走远路——最远的路是从闸口到热井，坐升降机二十分钟。”',
      '“我想问你一件事，你不想答就不答：上面……有多少人？”',
    ],
  },
  {
    id: 'cook', name: '鲁春梅', age: 51, role: '食堂掌勺', sponsor: true, at: [[5, 21, 'market']],
    lines: [
      '“新来的？脸生。……等等，你这身皮是怎么回事，掉色了？”她伸手摸了摸你晒黑的胳膊。',
      (s, sys) => (sys.foodPrice > 1.05 ? '“粮价又涨了，别怪我。库里的存粮一少，上面就让我们每勺少打一点。”' : '“今天的菜是莴苣、豆子、菌子。天天都是莴苣、豆子、菌子。过节有鱼。”'),
      '“我男人在热井干了二十年，肺不行了。那地方给的度多，可那是拿命换的。你要是缺钱，先去光田，别去热井。”',
      '“你吃饭的样子像是有人要抢。没人抢，坐下慢慢吃。……行了，户籍处要是找人作保，我给你作。能把我的饭吃这么香的人坏不到哪去。”',
      '“上面真的有雨吗？从天上掉下来的水？不要钱？”',
    ],
  },
  {
    id: 'trader', name: '塔依尔', age: 36, role: '旧货商', at: [[9, 21, 'market']],
    lines: [
      '“旧时代的东西，我全收。杯子、扣子、带字的纸。越没用的越值钱——有用的早被用坏了。”',
      '“你身上要是有上面带下来的东西，拿给我看看。价钱好说。”',
      '“我卖得最好的是一块碎玻璃，蓝的。买主说它是天的颜色。我没见过天，我说您说是就是。”',
      '“告诉你个行情：在这儿，度就是电，电就是光，光就是粮。所以度就是饭。谁管着热井，谁就管着所有人的饭碗。”',
    ],
  },
  {
    id: 'foreman', name: '贺青禾', age: 41, role: '光田组长', sponsor: true, at: [[5, 15, 'farms'], [18, 20, 'market']],
    lines: [
      '“会干活吗？采收，六个钟头，三十度。手要轻，根不能伤，伤了根这一槽就废了。”',
      (s, sys) => (sys.lit < 0.95 && sys.lit > 0 ? '“又熄了两个分区。热井一检修，我的莴苣就得摸黑。灯少亮一个钟头，全城就少吃一顿。”' : '“一个人一年的口粮，要三十平米的架子、三千多瓦的灯，一刻不停地照。两万一千人，你自己算。”'),
      '“我们种的东西，祖宗是两百年前从上面带下来的那一批种子。一代一代留种，越留越弱。我做梦都想要新种子。”',
      '“你干活不偷懒。落户要保人是吧？写我的名字。光田缺人，我巴不得你留下。”',
      '“你在上面……见过长在土里的东西吗？不用灯的那种？”',
    ],
  },
  {
    id: 'pipe', name: '周渡', age: 63, role: '老管道工', sponsor: true, at: [[7, 17, 'water'], [19, 21, 'market']],
    lines: [
      '“巡管，六个钟头，三十六度。带你走一遍：听见哪儿嘶嘶响就拿粉笔画个圈。就这么个活，我干了四十五年。”',
      (s, sys) => (sys.overflowLs > 0 ? `“水库是满的。含水层每个钟头给我们五十多方，用不完的就从溢流渠排出去——现在是每秒 ${sys.overflowLs.toFixed(0)} 升。排到哪？上面。上面早没人了，流到哪算哪。”` : '“这两天水库没满，溢流渠是干的。回水泵一坏，全城的水就得省着用。”'),
      '“……你说什么？溢流渠的出口，长了树？有鸟？”他很久没说话。“我排了四十五年的水。我以为是往坟里倒。”',
      '“落户的事，我给你作保。你喝过我排出去的水，这就算我认识你了。”',
      '“溢流渠能走人。当年修的时候就是当检修道用的。这话我只跟你说。”',
    ],
  },
  {
    id: 'tech', name: '伏燧', age: 29, role: '热井技师', at: [[11, 13, 'market'], [14, 22, 'heat']],
    lines: [
      '“热井巡检，四个钟头，六十度。听着多是吧？下去你就知道为什么了。干四十分钟，进冷却舱歇二十分钟，谁也不许逞能。”',
      '“一百一十八兆瓦。白天光田一开灯，全城的用电就顶到一百一十七。就剩这么一丝余量，哪口井打个喷嚏，上面就得熄灯。”',
      '“一号井的出水温度每年降一点。不多，百分之一。没人爱听这个。议事厅说再打一口井就是了——往哪打？再往下，人就下不去了。”',
      '“你们上面用什么发电？……什么都不用？那晚上怎么办？”',
    ],
  },
  {
    id: 'teacher', name: '沈知白', age: 47, role: '学堂先生', at: [[8, 16, 'school'], [17, 19, 'archive']],
    lines: [
      '“你可以来听课，不收度。四堂课，讲完深泉的两百年。孩子们七岁就听过了，你是我教过的年纪最大的新生。”',
      '“我教了二十年‘地表已无可往来者’。现在一个可往来者坐在我的教室里。你说我明天该怎么讲这一课？”',
      '“课本是议事厅审过的。我不是说它是假的。我是说，写它的人和封闸的人是同一批人。”',
      '“我下了课会去档案馆。2098 年的表决记录应该在那里。应该在。”',
    ],
  },
  {
    id: 'kid', name: '小满', age: 11, role: '学生', at: [[8, 15, 'school'], [16, 19, 'market']],
    lines: [
      '“你就是那个上面来的人？！你的脸为什么是这个颜色？疼不疼？”',
      '“太阳是不是真的能把人烫死？我们老师说能。那你怎么没死？”',
      '“我画过云。老师说画得不对，可是她也没见过。你看这个对不对？”她举起一张纸，上面是一团灰色的、长着腿的东西。',
      '“我长大了要当闸官。祁爷爷说闸官最没用，我觉得不是。门要是没人看，开了都没人知道。”',
    ],
  },
  {
    id: 'clerk', name: '庞正则', age: 55, role: '户籍官', at: [[8, 18, 'hall']],
    lines: [
      '“姓名。出生区。父母户籍号。……没有？一样都没有？”他把笔放下了。“表上没有‘地表’这一栏。”',
      '“规矩我可以告诉你：落户要三样。干满三个工，说明你养得活自己；有一位居民作保，说明有人认你；本人到场。上一次有人走这条规矩，是一百多年前。”',
      '“我查了条文。封闸的决议只说关门，没说门外来的人不算人。所以你的申请我会收。别谢我，谢写条文的人粗心。”',
    ],
  },
  {
    id: 'council', name: '黎映川', age: 62, role: '议员', at: [[10, 17, 'hall']],
    lines: [
      '“我听说了。全城都听说了。”她打量你很久。“你知道你走进来这件事，比你这个人麻烦得多吗？”',
      '“两万一千人相信自己是最后的人。这个念头让他们不浪费一滴水、一度电，让他们一百多年没打过一次仗。你一个人就把它戳破了。”',
      '“有人要我把你送回闸外，有人要我明天就开闸。我两边都不会答应。你先活成一个普通居民，让大家习惯你。别的以后再说。”',
      '“2098 年为什么封闸？课本上有。课本之外的，在档案馆的闭架区。钥匙有两把，一把在议事厅。”',
    ],
  },
  {
    id: 'archivist', name: '简默', age: 38, role: '档案员', at: [[9, 19, 'archive']],
    lines: [
      '“开架区随便看。闭架区要居民证，还要议事厅的条子。”他头也没抬。',
      '“你想查封闸的记录。这个月你是第四个来问的，前三个都是在你进城之后。”',
      '“我管着这些卷宗十五年。有一箱我自己也调不出来：编号和闸门上那串字是同一个。”',
    ],
  },
  {
    id: 'inn', name: '孟九', age: 44, role: '客栈老板', at: [[6, 24, 'homes']],
    lines: [
      '“铺位十二度一晚，热水随便用。住我这儿的都是跟家里吵了架的、刚成年等分房的。你是头一个真没家的。”',
      '“夜里十点熄大灯，早上六点亮。刚来的人都说睡不着——没有天黑，只有关灯。你倒好，倒头就睡。”',
      '“大伙儿背后叫你‘上面的’。没恶意。这城里一百多年没来过生人，他们连‘外地人’这个词都得现想。”',
      '“我奶奶的奶奶是从上面下来的。她留下一句话，家里一直当胡话传：‘门不是我们关的。’”',
    ],
  },
  {
    id: 'singer', name: '阿絮', age: 26, role: '采收工，晚上在中庭唱歌', at: [[6, 14, 'farms'], [18, 23, 'market']],
    lines: [
      '她在调一把用旧管材做的琴。“我唱的都是老歌。两百年前的。唱雨，唱河，唱一种叫‘春天’的东西。没人知道那是什么，可是大家爱听。”',
      '“有一首歌里说‘风吹在脸上’。风我知道，通风井里有。可是歌里的风好像是件好事。”',
      '“你给我讲讲雨吧。不用讲得好听，讲真的就行。我想知道我唱了这么多年，唱的到底是什么。”',
    ],
  },
];

/** 此刻在某区域、醒着的居民 */
export function peopleAt(id, tMin) {
  const h = (tMin % 1440) / 60;
  return NPCS.filter((n) => n.at.some(([a, b, where]) => where === id && h >= a && h < b));
}
