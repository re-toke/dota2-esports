// utils/team-logo-local-data.js
// team-logo-map.json 的 JS 包装模块（由 scripts/sync/fetch-team-logos.js 自动生成，请勿手动修改）
//
// 背景：微信小程序分包直接 require 主包 JSON 存在兼容性问题（返回 null），
//   改为 JS 模块导出，在主包/分包中 require 均稳定可靠（同 upcoming-local-data.js 模式）。
// 运行时用法：league-detail _doEnrichTeamLogos 快照命中 → 零网络；未命中走原查询链。
// 刷新：npm run fetch:logos

module.exports = {
  "generatedAt": 1790885425,
  "source": "opendota",
  "note": "build-time team logo snapshot (active leagues + top rated), refresh via scripts/sync/fetch-team-logos.js",
  "stats": {
    "leaguesCrawled": 24,
    "activeTeamIds": 326,
    "byIdCount": 654,
    "byNameCount": 669
  },
  "byId": {
    "3": {
      "name": "compLexity Gaming",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3.png"
    },
    "4": {
      "name": "EHOME",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/4.png"
    },
    "5": {
      "name": "Invictus Gaming",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5.png"
    },
    "7": {
      "name": "DK",
      "logo": "https://cdn.steamusercontent.com/ugc/782994610325576235/08CF233C343B8550B71199B07A86FCB3E7D01F89/"
    },
    "15": {
      "name": "LGD Gaming",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/15.png"
    },
    "20": {
      "name": "Newbee.mgb",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/20.png"
    },
    "36": {
      "name": "Natus Vincere",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/36.png"
    },
    "39": {
      "name": "Shopify Rebellion",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/39.png"
    },
    "41": {
      "name": "4 Friends + Chrillee",
      "logo": "https://cdn.steamusercontent.com/ugc/706274505311787193/24FA17D5019799AF118AEB4469DDB76D69A66F63/"
    },
    "46": {
      "name": "Team Empire",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/46.png"
    },
    "55": {
      "name": "_PowerRangers",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/55.png"
    },
    "67": {
      "name": "paiN Gaming",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/67.png"
    },
    "166": {
      "name": "Scenario",
      "logo": "https://cdn.steamusercontent.com/ugc/1832407370390600391/4B8EDF6460D5D3210412F6CFC2CBE3764DE863C1/"
    },
    "2163": {
      "name": "Team Liquid",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2163.png"
    },
    "111474": {
      "name": "Alliance",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/111474.png"
    },
    "134900": {
      "name": "iCCup Team",
      "logo": "https://cdn.steamusercontent.com/ugc/576743332782064613/4D8326823462288234562F8D1B8B1C0C4265BA6C/"
    },
    "161707": {
      "name": "mouz",
      "logo": "https://cdn.steamusercontent.com/ugc/1136293535420246123/40F5BB39E4DAA5CFAE9D73C85DB8441C5A3C4408/"
    },
    "293390": {
      "name": "Radical Online X-tremists",
      "logo": "https://cdn.steamusercontent.com/ugc/921253447668725714/13C7456AA325AD7AC03DC7D117483E8DBDAD5486/"
    },
    "349172": {
      "name": "Global Challengers",
      "logo": "https://cdn.steamusercontent.com/ugc/576773266863066111/775914064EA60990D8479A6DCAA87B45FD4EEDD4/"
    },
    "350190": {
      "name": "Ascent Esports",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/350190.png"
    },
    "367492": {
      "name": "Revenge-",
      "logo": "https://cdn.steamusercontent.com/ugc/667955139964290556/60E1A70BA46FA523F5217A48F5A0C9588606137E/"
    },
    "416900": {
      "name": "Orange.Neolution Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/612760050488516720/DF0EE7F44746239DBA83B8F4537758ECBB51655E/"
    },
    "468458": {
      "name": "E.C.",
      "logo": "https://cdn.steamusercontent.com/ugc/882977285055841873/5029916D0E6C0E527029054143275A02693375F3/"
    },
    "484909": {
      "name": "Hyper Glory Team",
      "logo": "https://cdn.steamusercontent.com/ugc/3281181583551777655/6AE767838540BC3CE1624B4D87E0E257DD1927AC/"
    },
    "485526": {
      "name": "Life.",
      "logo": "https://cdn.steamusercontent.com/ugc/903254994325386629/98F3E4A7B2DECCF94FE06DE33EA12049295BBCC5/"
    },
    "498033": {
      "name": "FXOpen E-Sports",
      "logo": "https://cdn.steamusercontent.com/ugc/595873628477068295/F40490019313A0FC878D6555EAFCC068F975169F/"
    },
    "534136": {
      "name": "New Guys",
      "logo": "https://cdn.steamusercontent.com/ugc/527291846450105057/CF0F2BAC9CC10F3F4E4F77990F36EF7877F74C88/"
    },
    "543897": {
      "name": "Mineski",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/543897.png"
    },
    "680683": {
      "name": "Quantic|Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/1117170899589104466/11989B210556A85FCA671890780B2D0C8BC467A4/"
    },
    "688388": {
      "name": "ThePrimeSIAPA?!",
      "logo": "https://cdn.steamusercontent.com/ugc/450671039877684086/E98078DB3227F4E176CC558F846C59F00FB0834B/"
    },
    "726228": {
      "name": "Vici Gaming",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/726228.png"
    },
    "733290": {
      "name": "DoTa GoD SLaYeRs",
      "logo": "https://cdn.steamusercontent.com/ugc/594755788951591763/CAE83CF5B82E3EE966C4F77DA3B21A5A3C3CF571/"
    },
    "818303": {
      "name": "FataL.RaGe.(not)PrO",
      "logo": "https://cdn.steamusercontent.com/ugc/536264712569251126/5CB2DDCD322E71F1EA83F7151B410937A1DFAE58/"
    },
    "883783": {
      "name": "Stay - Free",
      "logo": "https://cdn.steamusercontent.com/ugc/577877533500375019/29F54460D6D8FB68424000E23A7C92D7D2F2BA9C/"
    },
    "995682": {
      "name": "SuperStrongDinosaurs",
      "logo": "https://cdn.steamusercontent.com/ugc/884119748687027366/4E5F67CD1B80D2886939D737E906451741305ABD/"
    },
    "999689": {
      "name": "Titan",
      "logo": "https://cdn.steamusercontent.com/ugc/612798094497099775/B31FD08745284986F02B3FE04021574F964D9FA1/"
    },
    "1061269": {
      "name": "Vivo Keyd Stars",
      "logo": "https://cdn.steamusercontent.com/ugc/5095292505104094637/268CD3E0F09AF23BB67C536D74056E8D8C1488E9/"
    },
    "1079149": {
      "name": "SIGMA.int",
      "logo": "https://cdn.steamusercontent.com/ugc/1047377791103893273/2F86EB8DE06754907CD316B5DD5D4BE9FC8B1F8A/"
    },
    "1087145": {
      "name": "Osliki Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/594766568879356896/536D5835599DC8A99ABF3D224D6D2B894905E9EB/"
    },
    "1148284": {
      "name": "MVP Phoenix",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1148284.png"
    },
    "1194815": {
      "name": "Dwayne 'The John' Rockson",
      "logo": "https://cdn.steamusercontent.com/ugc/685968273337811268/E090D4C9B497CA496D7E32D4F59BA36DD4C846D1/"
    },
    "1236083": {
      "name": "FelMysT",
      "logo": "https://cdn.steamusercontent.com/ugc/847088009729950752/DF0CEFAD8DC30804594D5925A8DA9BC73F182CD3/"
    },
    "1256674": {
      "name": "XPC International",
      "logo": "https://cdn.steamusercontent.com/ugc/50986085993332472/2733A94CBA92F8D2B87DA608536E2E86ECE91D30/"
    },
    "1271771": {
      "name": "Zero Latitude",
      "logo": "https://cdn.steamusercontent.com/ugc/430448599226110019/41D8B7F02B76DD15E16D40E9C1CC8736D4867E06/"
    },
    "1283482": {
      "name": "Scythe.SG-",
      "logo": "https://cdn.steamusercontent.com/ugc/469812062884140883/C9EDFEDE46BCAC0F1C16A5A3196D6947654FE664/"
    },
    "1288401": {
      "name": "R A V E N",
      "logo": "https://cdn.steamusercontent.com/ugc/563268090328234257/8D1D3A5938BFA5D146DC1D26BD2C631C4C23979A/"
    },
    "1291626": {
      "name": "XPC.gg",
      "logo": "https://cdn.steamusercontent.com/ugc/81379587710631266/2733A94CBA92F8D2B87DA608536E2E86ECE91D30/"
    },
    "1333179": {
      "name": "",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1333179.png"
    },
    "1366458": {
      "name": "R a v e",
      "logo": "https://cdn.steamusercontent.com/ugc/357274177493063612/C6646260536702EC11BE924D3CB2D8C696280BC4/"
    },
    "1366506": {
      "name": "Black Sheep!",
      "logo": "https://cdn.steamusercontent.com/ugc/781877465259101475/2A74AC75A9249433C8329D9C8BD869678853E7C2/"
    },
    "1370482": {
      "name": "Doggy Team",
      "logo": "https://cdn.steamusercontent.com/ugc/3280049265377219538/69DDD415F33497854C4EA35A2A96E817E88C0F74/"
    },
    "1371515": {
      "name": "Aware.Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/794063002581119172/C1F4467BD1C24C7E8B72343394F92394C88CFC2A/"
    },
    "1375614": {
      "name": "Newbee",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1375614.png"
    },
    "1410456": {
      "name": "TeamCoast",
      "logo": "https://cdn.steamusercontent.com/ugc/777181466527196630/3206CD32FB9D14B0106F4742AAC23FA7B3C699B3/"
    },
    "1453020": {
      "name": "Sneaky Nyx Assassins",
      "logo": "https://cdn.steamusercontent.com/ugc/3281180234046031347/2975FFC5B5EB653F5165D7D4E8698C30CEE8AF07/"
    },
    "1513164": {
      "name": "aSpera ESports",
      "logo": "https://cdn.steamusercontent.com/ugc/35247586654199397/AA75FD3C7D0AD1399A0F03CAE53CD33AC7CE7C45/"
    },
    "1531850": {
      "name": "North American Rejects",
      "logo": "https://cdn.steamusercontent.com/ugc/598160756144927455/E850C4122F42BB762134853C301E4085A1580B19/"
    },
    "1556150": {
      "name": "SPNV Inspire return",
      "logo": "https://cdn.steamusercontent.com/ugc/3281181583533490678/16F77ED8634829BA95FC93A20EBABC8BF1D45E8E/"
    },
    "1556884": {
      "name": "AftershockGaming Int.",
      "logo": "https://cdn.steamusercontent.com/ugc/776056112971508921/DF725FB62C1B052CE52381747AE7C296A65A4051/"
    },
    "1589592": {
      "name": "Balkan Bears Corleone",
      "logo": "https://cdn.steamusercontent.com/ugc/469811338474849833/18C0455ADE4BFF5B9BF55482E74FF6835CB59137/"
    },
    "1616631": {
      "name": "Flip.Sid3 Tactics NA",
      "logo": "https://cdn.steamusercontent.com/ugc/3280058230258270260/4590F3188910F526B331212FC1EB687AC7795DBF/"
    },
    "1642908": {
      "name": "Natus Vincere US",
      "logo": "https://cdn.steamusercontent.com/ugc/487827175124862465/3ABE239EE4A96C9FEB2EFC2AB79E3E74C622049B/"
    },
    "1679554": {
      "name": "Imba Gaming Vietnam",
      "logo": "https://cdn.steamusercontent.com/ugc/3318339547271934415/E66AF3E340F2A43E62A7A3F0FE7F7F8FA64E7729/"
    },
    "1718551": {
      "name": "ROOT-gaming.com",
      "logo": "https://cdn.steamusercontent.com/ugc/45376357722113646/9F0CCE296749E194BC9DA17079FADD18D3DE8B54/"
    },
    "1730841": {
      "name": "Tamptaxon",
      "logo": "https://cdn.steamusercontent.com/ugc/81379587682633657/52635B11E4D4D8B054EA9E3CDEE99060B7815ADC/"
    },
    "1736743": {
      "name": "Elysium!",
      "logo": "https://cdn.steamusercontent.com/ugc/36344320175287789/DDFB6E1470DA93C229692159BB47E733333FD8F4/"
    },
    "1748111": {
      "name": "Duza Gaming.",
      "logo": "https://cdn.steamusercontent.com/ugc/40848547394192181/FD528DB506FECBE5732923D697D7139C8EE4EF0F/"
    },
    "1773539": {
      "name": "Battle Zone-",
      "logo": "https://cdn.steamusercontent.com/ugc/528385406419881229/5C6A83090C1C1EFD3818475F1A834DB28D1669FD/"
    },
    "1803996": {
      "name": "NAM VEZET-MI IGRAEM",
      "logo": "https://cdn.steamusercontent.com/ugc/575652270942579148/9B38BEC3BEDEE0E300138929E3C802FA9F5ACDCB/"
    },
    "1835728": {
      "name": "Sand Blut",
      "logo": "https://cdn.steamusercontent.com/ugc/415811900445613110/E015598EAAFDA00873521A80E6C803ED41413D4F/"
    },
    "1836806": {
      "name": "the wings gaming",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1836806.png"
    },
    "1838315": {
      "name": "Team Secret",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1838315.png"
    },
    "1846548": {
      "name": "HellRaisers",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1846548.png"
    },
    "1848465": {
      "name": "LaiGaming",
      "logo": "https://cdn.steamusercontent.com/ugc/28466819225810269/A0495348313DA709ACE717D1D4BDFA10FF0F715B/"
    },
    "1866993": {
      "name": "T.O.T",
      "logo": "https://cdn.steamusercontent.com/ugc/44230686471780820/581805D8E5EE6AE00B9E0928F2C77CA3352A5309/"
    },
    "1883502": {
      "name": "Virtus.pro",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1883502.png"
    },
    "1994818": {
      "name": "We Got Late Game",
      "logo": "https://cdn.steamusercontent.com/ugc/711906452532416050/7520B76E54F550FB1662EE3772C9D020E00D6D40/"
    },
    "2006291": {
      "name": "Lajons",
      "logo": "https://cdn.steamusercontent.com/ugc/541884168947857532/A265E0462753D3981E33961066F897E7C1E6AFDC/"
    },
    "2006913": {
      "name": "Vega Squadron",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2006913.png"
    },
    "2019384": {
      "name": "[Flip.Sid3 Tactics]",
      "logo": "https://cdn.steamusercontent.com/ugc/541894212124519280/8F137BA3271FF11A49371D890C2EE6C32C7EF478/"
    },
    "2056165": {
      "name": "Glory Push Mid",
      "logo": "https://cdn.steamusercontent.com/ugc/619592022572057702/B59B8ED89608D77F1EB9BC7DF776C096271B69B7/"
    },
    "2101260": {
      "name": "BigGooooood",
      "logo": "https://cdn.steamusercontent.com/ugc/53249782181410639/A754634D7F2CA2B33322789ED2EBB953DADEEDA5/"
    },
    "2101368": {
      "name": "LaDottA's Stacks",
      "logo": "https://cdn.steamusercontent.com/ugc/546393011940036650/5069EEDFD9C2D36183875F9561FB3EBFF3419372/"
    },
    "2108395": {
      "name": "TNC Predator",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2108395.png"
    },
    "2114078": {
      "name": "eBola eSports United",
      "logo": "https://cdn.steamusercontent.com/ugc/541889954015774548/A4F3945E6E9923DCF69CF5DFBAF3048137998217/"
    },
    "2116622": {
      "name": "TheShiniGamis",
      "logo": "https://cdn.steamusercontent.com/ugc/1930373852687939015/A74BC19ABB1EC83C095E1DFF3429285D6B0B48AE/"
    },
    "2197847": {
      "name": "Burden United",
      "logo": "https://cdn.steamusercontent.com/ugc/710779919460996890/3B9ECD7E13630C51701750EC47D1495542E76BD0/"
    },
    "2224197": {
      "name": "G Guard Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/708527825009376675/5069EEDFD9C2D36183875F9561FB3EBFF3419372/"
    },
    "2244697": {
      "name": "Team Archon",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2244697.png"
    },
    "2257957": {
      "name": "LINCENCIADOS",
      "logo": "https://cdn.steamusercontent.com/ugc/706277591696898479/1DC20898B5DFB8F33CE410C47D93E5C245EC0BFF/"
    },
    "2341983": {
      "name": "пасека",
      "logo": "https://cdn.steamusercontent.com/ugc/2038475377471539322/83F1E1C4E1D66120F33DF08E9289D6942CED0342/"
    },
    "2346476": {
      "name": "LEGIO VICTRIX !",
      "logo": "https://cdn.steamusercontent.com/ugc/543026540283900928/5F8FF9047351094BF1B55A0BC52AB1C9A21B8CB0/"
    },
    "2349091": {
      "name": "TODOPORELPOD",
      "logo": "https://cdn.steamusercontent.com/ugc/27366089383599831/DC075E25714DB82AF324FE4732B46790EA459663/"
    },
    "2384932": {
      "name": "Team OvP.",
      "logo": "https://cdn.steamusercontent.com/ugc/439450841570226042/44C52CC76E72908CE95D250488E4CDF934943EB5/"
    },
    "2390951": {
      "name": "Kanaya",
      "logo": "https://cdn.steamusercontent.com/ugc/532895345481654582/6B0AF87CC0A6D793BD6C81080F14AC5801078549/"
    },
    "2395241": {
      "name": "Artyk Dota",
      "logo": "https://cdn.steamusercontent.com/ugc/428193628077963983/E79C23C12B93B7A4E0755E88C75B58CC190B805D/"
    },
    "2413439": {
      "name": "Team SatuDuaTiga",
      "logo": "https://cdn.steamusercontent.com/ugc/525015750980111983/A97F313C0F62B158F0B5A4969EA1E1E15E5A8608/"
    },
    "2512249": {
      "name": "123",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2512249.png"
    },
    "2519319": {
      "name": "(monkey) Business",
      "logo": "https://cdn.steamusercontent.com/ugc/383162071968605685/B670804CDB13F184D122ACBB8F75E2DB2C959CAF/"
    },
    "2526472": {
      "name": "$5JuNGz$",
      "logo": "https://cdn.steamusercontent.com/ugc/620723145147160586/09F1EF05604FC45B22E2B5986715441FB8FCA786/"
    },
    "2537636": {
      "name": "Elements Pro Gaming",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2537636.png"
    },
    "2552118": {
      "name": "FTD club a",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2552118.png"
    },
    "2552670": {
      "name": "Prodota Gaming",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2552670.png"
    },
    "2576071": {
      "name": "Yellow Submarine",
      "logo": "https://cdn.steamusercontent.com/ugc/2506900380361558769/01D7A1FC1156B0550B4EF9EA2A3A2AF84D9BF884/"
    },
    "2581813": {
      "name": "Execration.安博电竞",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2581813.png"
    },
    "2585896": {
      "name": "eEriness!",
      "logo": "https://cdn.steamusercontent.com/ugc/404556234640411761/4758656C1505E4B00FFACA5DF3C027F0D7D2AD5B/"
    },
    "2586976": {
      "name": "OG",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2586976.png"
    },
    "2621843": {
      "name": "Team. Spirit",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2621843.png"
    },
    "2626685": {
      "name": "KEEN GAMING",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2626685.png"
    },
    "2635099": {
      "name": "CDEC.Y",
      "logo": "https://cdn.steamusercontent.com/ugc/266100190168033440/3164343438ECC6AB8E76D0B59349F00CC4034296/"
    },
    "2642171": {
      "name": "Team AD FINEM",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2642171.png"
    },
    "2659468": {
      "name": "WG.Unity",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2659468.png"
    },
    "2672298": {
      "name": "NoPing Esports",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2672298.png"
    },
    "2714312": {
      "name": "Aggressive 5",
      "logo": "https://cdn.steamusercontent.com/ugc/395581850125148530/0A70A5AE02043F47BBF2DF70FDD698F3602D39B8/"
    },
    "2777247": {
      "name": "",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2777247.png"
    },
    "2780729": {
      "name": "G.star",
      "logo": "https://cdn.steamusercontent.com/ugc/455236803146988180/37D5285DC80FFBEDF84FD0347ADE2E89A4E29731/"
    },
    "2780911": {
      "name": "Eagles GIGABYTE",
      "logo": "https://cdn.steamusercontent.com/ugc/293105300895055647/333101B42C1C0139ED4B1ABB61B8EB46375F30E9/"
    },
    "2783913": {
      "name": "Escape Gaming",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2783913.png"
    },
    "2787008": {
      "name": "Corgi in a Team",
      "logo": "https://cdn.steamusercontent.com/ugc/263835861937179495/E6621DE29134BF92F72B44B595805C2CF6638514/"
    },
    "2789395": {
      "name": "",
      "logo": "https://cdn.steamusercontent.com/ugc/290853501103432645/A972F1905CCA03B8CF677E4BC086717FE025FFE7/"
    },
    "2789717": {
      "name": "Polarity Dota 2",
      "logo": "https://cdn.steamusercontent.com/ugc/290853501095454898/DEF7A669784898DFDAC5B3C92816FEC8D1DA4785/"
    },
    "2790766": {
      "name": "",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2790766.png"
    },
    "2799801": {
      "name": "KanayaGaming",
      "logo": "https://cdn.steamusercontent.com/ugc/503650574692020062/A51B7CDF5125D08A16C8DE146AE719DED7DB2B56/"
    },
    "2850822": {
      "name": "King Arthur & 4 Knights",
      "logo": "https://cdn.steamusercontent.com/ugc/495771811048481437/6125C45CE89495253E3C9754BEDA759E905E811C/"
    },
    "2860081": {
      "name": "team_ftd_a",
      "logo": "https://cdn.steamusercontent.com/ugc/486768327515596173/7FDAF1D8570042B99D93B16A4901E3719B995B9B/"
    },
    "3008699": {
      "name": "Los Magikarps",
      "logo": "https://cdn.steamusercontent.com/ugc/14788690063483691968/4E01289F653136381D26DD438919DE90E1D3CF13/"
    },
    "3018001": {
      "name": "     ",
      "logo": "https://cdn.steamusercontent.com/ugc/823441666992150481/B2C8214136ADBC21D7D0BDFD9E113C3AE9EDBF0B/"
    },
    "3214090": {
      "name": "Hippomaniacs",
      "logo": "https://cdn.steamusercontent.com/ugc/258219525689344926/9A31EAD78B68629E8971934753D4B67D8998B0F3/"
    },
    "3214108": {
      "name": "Team NP",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3214108.png"
    },
    "3259983": {
      "name": "Emit Lortnoc Boss",
      "logo": "https://cdn.steamusercontent.com/ugc/12869046455244693361/EFBB218980A0A6E6A2F818D3E10C5883CFE2FB6C/"
    },
    "3260216": {
      "name": "Team HighGround",
      "logo": "https://cdn.steamusercontent.com/ugc/860608186751615683/A98EFE34990C8B66694B0F23FC22E3A6E0F60A70/"
    },
    "3262331": {
      "name": "Team EVOS",
      "logo": "https://cdn.steamusercontent.com/ugc/2422250350099907755/E3DD3ED79F8C0BE88B7C8D1F5703D6CEF472CF64/"
    },
    "3262512": {
      "name": "ThePrime",
      "logo": "https://cdn.steamusercontent.com/ugc/102856003013929772/A99712F64C2CFD260935B08F37882617C9B00A3D/"
    },
    "3322951": {
      "name": "LEVEL UP",
      "logo": "https://cdn.steamusercontent.com/ugc/18104430192043983857/AB3238A17EE9950F7532A26B1EAAFCF2086FB37A/"
    },
    "3325212": {
      "name": "Natural 9",
      "logo": "https://cdn.steamusercontent.com/ugc/437235714274666198/2EEED3186A9F34FE3798107001498618882EC97B/"
    },
    "3326126": {
      "name": "Team VG.J",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3326126.png"
    },
    "3326680": {
      "name": "Horde",
      "logo": "https://cdn.steamusercontent.com/ugc/253716559970590297/28D42322E370E42F0A371025990F4633C4909FDD/"
    },
    "3326875": {
      "name": "Faceless",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3326875.png"
    },
    "3327985": {
      "name": "RaveDota",
      "logo": "https://cdn.steamusercontent.com/ugc/263847302287787775/C6646260536702EC11BE924D3CB2D8C696280BC4/"
    },
    "3331948": {
      "name": "LGD.Forever Young",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3331948.png"
    },
    "3333433": {
      "name": "",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3333433.png"
    },
    "3349045": {
      "name": "Σ(っ°Д°;)っ",
      "logo": "https://cdn.steamusercontent.com/ugc/790792379089546591/03D82C080390586E69235FC55F36B50CE99AB8FD/"
    },
    "3547682": {
      "name": "Team VGJ",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3547682.png"
    },
    "3580606": {
      "name": "SG e-sports",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3580606.png"
    },
    "3586078": {
      "name": "Geek Fam",
      "logo": "https://cdn.steamusercontent.com/ugc/2011450519782421256/C72214A86E6C450DA8CF1A18AE9539B5CAEE7D45/"
    },
    "3715574": {
      "name": "SG e-sports team",
      "logo": "https://cdn.steamusercontent.com/ugc/936063882399484485/4DD8B4901982E1821341B595BCF90FCC721F0291/"
    },
    "3718685": {
      "name": "MVP.Revolution",
      "logo": "https://cdn.steamusercontent.com/ugc/102854064380052763/02FF74433AAD5CA57A7EE134380640F7B0614C09/"
    },
    "3722485": {
      "name": "B)ears",
      "logo": "https://cdn.steamusercontent.com/ugc/101728066962847284/B07F6E7D1D4ECCDA3AEB4985A222F839C42E1CBE/"
    },
    "3722973": {
      "name": "Team Onyx",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3722973.png"
    },
    "3725701": {
      "name": "Happy  Feet",
      "logo": "https://cdn.steamusercontent.com/ugc/936057564715719132/D928A9DBA926069E387444C29127C90767A14E0F/"
    },
    "3747558": {
      "name": "NoTricks",
      "logo": "https://cdn.steamusercontent.com/ugc/97226460691182956/FE3596BFFDF73974EB8A0ED234EBB6BDD37BACEA/"
    },
    "3785359": {
      "name": "BOOM ID",
      "logo": "https://cdn.steamusercontent.com/ugc/763846429146901501/E85EF58254E8BA84ED8A085512ECA0A6499499FE/"
    },
    "3851150": {
      "name": "NoLogic Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/170412021737626541/FBC216786BB78D03C74E3576F8AB672CC65128E7/"
    },
    "3922738": {
      "name": " Thunder Awaken ///",
      "logo": "https://cdn.steamusercontent.com/ugc/170412655661567888/FEF408443C2CA8AB1953CFA3E530AB9D5EE7ADB7/"
    },
    "3931120": {
      "name": "",
      "logo": "https://cdn.steamusercontent.com/ugc/856103154387259107/F04489EB295120F92A94E3F48297C5FD81D2E5DD/"
    },
    "4010914": {
      "name": "Pariente Gaming ",
      "logo": "https://cdn.steamusercontent.com/ugc/88223956350603792/FCC2C8AE4B3696CC949AD5E71C887C06B6411AAE/"
    },
    "4147900": {
      "name": "15 añitoz",
      "logo": "https://cdn.steamusercontent.com/ugc/170415821555291716/81F6FD809ED0ED5D2383F0F8AFCBFE21ED58654B/"
    },
    "4186376": {
      "name": "Team Singularity",
      "logo": "https://cdn.steamusercontent.com/ugc/809929916643509535/322F82A5A63214DE068DF2FCBC2A5ADC1FDDF6C7/"
    },
    "4251435": {
      "name": "w33ha earthspirit",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/4251435.png"
    },
    "4259604": {
      "name": "Veteran",
      "logo": "https://cdn.steamusercontent.com/ugc/859487850036661871/E651E7B7C63BFD1E1561EF68137B35ADCAEDB52E/"
    },
    "4288603": {
      "name": "Rock.Young",
      "logo": "https://cdn.steamusercontent.com/ugc/924796104665763830/965117DF684B6E3801028E33DF02B8528A18E752/"
    },
    "4372042": {
      "name": "Team Freedom",
      "logo": "https://cdn.steamusercontent.com/ugc/788539568429905171/E19817F8B3BFA2F8CDB6F6694F9E024391E82CA0/"
    },
    "4425527": {
      "name": "Geek Fam",
      "logo": "https://cdn.steamusercontent.com/ugc/770525551623882955/0C4DB2D2430056E2E887CFCB3DD77567F5DE8EE5/"
    },
    "4426165": {
      "name": "xxX",
      "logo": "https://cdn.steamusercontent.com/ugc/842585341023837640/349CE23F40FBA351CE9A5BC4A4388CFFF6B0D30B/"
    },
    "4817649": {
      "name": "496 Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/947347005705942313/366DDC9ACA9760D099E84685DE88D72E9BA65F3E/"
    },
    "4957990": {
      "name": "Dame tus Moneditas",
      "logo": "https://cdn.steamusercontent.com/ugc/866233156519569288/ED7AE93582035B4C0858E4801699170A4EA695A5/"
    },
    "4958284": {
      "name": "Greedy Goblins",
      "logo": "https://cdn.steamusercontent.com/ugc/880874231533664522/D67219502B11783CB04FD68567D5661D3B6C4BDE/"
    },
    "5011202": {
      "name": "Coloss",
      "logo": "https://cdn.steamusercontent.com/ugc/823439759927075414/3E1D37F1E241AC90B3631DDBCD015531E76CD290/"
    },
    "5014799": {
      "name": "Nemiga Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/1761446291384253796/DDD9E9CE3AC50467578944F685C4BD84ED0285B7/"
    },
    "5017210": {
      "name": "Team Resilience",
      "logo": "https://cdn.steamusercontent.com/ugc/14326265454983833183/734A1D8A0938380A48221CDAE1AACB0C5C0AB585/"
    },
    "5026801": {
      "name": "",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5026801.png"
    },
    "5027210": {
      "name": "VGJ Thunder",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5027210.png"
    },
    "5028043": {
      "name": "Sacred",
      "logo": "https://cdn.steamusercontent.com/ugc/861740565655434597/B36208DF4685C3B87FFC3834F572B2AD5251300C/"
    },
    "5028104": {
      "name": "VGJ Storm",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5028104.png"
    },
    "5031582": {
      "name": "2Be.Dota2",
      "logo": "https://cdn.steamusercontent.com/ugc/806619761216522702/A5258FF4D3BD72F19FE436B158B3867B067A7675/"
    },
    "5040783": {
      "name": "Immortals",
      "logo": "https://cdn.steamusercontent.com/ugc/872993216721628296/3840921B905A5B28840C85C6449D1447073A16E5/"
    },
    "5051649": {
      "name": "Immortals",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5051649.png"
    },
    "5055770": {
      "name": "Gorillaz-Pride",
      "logo": "https://cdn.steamusercontent.com/ugc/934927864604413601/D9FF391286B256016F320077FC6B4BEC594FF774/"
    },
    "5059375": {
      "name": "The Final Tribe",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5059375.png"
    },
    "5065748": {
      "name": "Infamous",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5065748.png"
    },
    "5066616": {
      "name": "Team Serenity",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5066616.png"
    },
    "5067988": {
      "name": "ROG TiTans",
      "logo": "https://cdn.steamusercontent.com/ugc/868494063065916993/C67CC3764B12B5007D87434BC78A0AFB8DEEDB6E/"
    },
    "5076975": {
      "name": "New Beginning",
      "logo": "https://cdn.steamusercontent.com/ugc/876372572835722155/862770450D4DFF3DBA4A58F2E16B8D15187E1DB3/"
    },
    "5138280": {
      "name": "Signify",
      "logo": "https://cdn.steamusercontent.com/ugc/832512818113241705/529626C109FCA595D47A5F04C85A76106DA43E6A/"
    },
    "5155538": {
      "name": "Рыцари Hiden pool'а",
      "logo": "https://cdn.steamusercontent.com/ugc/884259198341578366/8C4CC9EDB4D83BD1BA75C279976E493D2923C6ED/"
    },
    "5167450": {
      "name": "boths",
      "logo": "https://cdn.steamusercontent.com/ugc/18181422250618603138/E2EDBD5B7AADCE7CE6581989EBE1526F6F203B55/"
    },
    "5216146": {
      "name": "Team Ever",
      "logo": "https://cdn.steamusercontent.com/ugc/933809026564423087/AB49AACE4D8BCA695854C0B446280EB37F688939/"
    },
    "5228654": {
      "name": "VGJ Storm",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5228654.png"
    },
    "5229127": {
      "name": "Winstrike",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5229127.png"
    },
    "5231224": {
      "name": "Rex Regum Qeon",
      "logo": "https://cdn.steamusercontent.com/ugc/950713289644008496/3B620C9D2CAD1E0FB7EAC4E3D6ACB4C56EC3DAC7/"
    },
    "5270154": {
      "name": "Team Russia",
      "logo": "https://cdn.steamusercontent.com/ugc/938311266632528679/C8EF88E55A960C565ED9D0DC24B404B8E43BC1B8/"
    },
    "5327206": {
      "name": "Thunder Predator",
      "logo": "https://cdn.steamusercontent.com/ugc/2435761146288261002/649A68D573638596F9BE0C50160489B351E10CEC/"
    },
    "5407259": {
      "name": "TNC Tigers",
      "logo": "https://cdn.steamusercontent.com/ugc/923681543827846572/0F5B3F843B4BFFCE3540CEF8268FC47871AE22DA/"
    },
    "5466118": {
      "name": "YOSHIMOTO.DETONATOR",
      "logo": "https://cdn.steamusercontent.com/ugc/921424381009057600/F846ED54123BCE31A1DF03A33879A51CA83E3FF6/"
    },
    "5679840": {
      "name": "SG e-sports",
      "logo": "https://cdn.steamusercontent.com/ugc/954096064657238608/8350343478E4CCB078B7314E8BF26CAE53A718CB/"
    },
    "5680524": {
      "name": "Espada",
      "logo": "https://cdn.steamusercontent.com/ugc/934940542897416439/991754B3053FC38BC803E67A33A663F0F765D9B1/"
    },
    "5725202": {
      "name": "Wind and Rain",
      "logo": "https://cdn.steamusercontent.com/ugc/920302854103492567/67C768AB9721910BE9F29ACF0C8DC6B648B07BC3/"
    },
    "5892936": {
      "name": "Team Xolotl",
      "logo": "https://cdn.steamusercontent.com/ugc/1002520539781239647/4F9428FED9E4850EAF98DC274EC8FC576C9C9595/"
    },
    "5992206": {
      "name": "KSY",
      "logo": "https://cdn.steamusercontent.com/ugc/946212227068317138/91018AD5A7CBEDE3965DE6EAD434B0BF894D1D9B/"
    },
    "5994455": {
      "name": "Team Orca",
      "logo": "https://cdn.steamusercontent.com/ugc/947336408508413358/0FB718DDF99BC7ACA9704C76792C76A31FD5A1E8/"
    },
    "6019885": {
      "name": "Godlike E-Sports",
      "logo": "https://cdn.steamusercontent.com/ugc/947336408508392662/23A2C40943D44B5BE28E278CD55EE0D6D8CD7287/"
    },
    "6187109": {
      "name": "WP Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/957467920323855773/9D6D4E0727AAD415F3C177533D983E63C7B64E05/"
    },
    "6187626": {
      "name": "Tigers",
      "logo": "https://cdn.steamusercontent.com/ugc/993512944601689027/7AE6BB9E621E948AB1C7DCF6EB4DEF5537529912/"
    },
    "6187627": {
      "name": "Tigers",
      "logo": "https://cdn.steamusercontent.com/ugc/941705216659818425/A42295D9071E4E02286FE98A7946C111EB34E32A/"
    },
    "6187657": {
      "name": "Plae8 Neon",
      "logo": "https://cdn.steamusercontent.com/ugc/1840291882364164364/B33D494DF247FC383DB1E0847BB81BE0DA6DB9C3/"
    },
    "6187923": {
      "name": "MangoBay",
      "logo": "https://cdn.steamusercontent.com/ugc/945083790097943557/273A8215CCA4F9173D44934EA972073D3938E6B8/"
    },
    "6189090": {
      "name": "Ødium",
      "logo": "https://cdn.steamusercontent.com/ugc/946209690011725620/D26B8ABFB3C35F4CC7379B0881DD85F3ABBC80D4/"
    },
    "6189996": {
      "name": "Lotac",
      "logo": "https://cdn.steamusercontent.com/ugc/772866954991861623/B62AB6B6CC124B730DC30D1D8A551490E1EBF48A/"
    },
    "6196091": {
      "name": "TEAM TEAM",
      "logo": "https://cdn.steamusercontent.com/ugc/941705094013048629/255CE8E5D541EE17F1851A13802EA56B7E8E0124/"
    },
    "6209804": {
      "name": "Antarctic Penguins",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/6209804.png"
    },
    "6210163": {
      "name": "ASTINI 777",
      "logo": "https://cdn.steamusercontent.com/ugc/943957141155545715/33B8F5C24BF116CC156216D45F6EB3DA851A042F/"
    },
    "6211505": {
      "name": "madjor atendari",
      "logo": "https://cdn.steamusercontent.com/ugc/966475254548861527/D8E88E3056540983989C90CAF90560C5DCBEB3B1/"
    },
    "6212166": {
      "name": "Team Lithium",
      "logo": "https://cdn.steamusercontent.com/ugc/942832810026469014/77A3FF768E7211A13D12777970885D0E72D3E547/"
    },
    "6214538": {
      "name": "Newbee",
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/6214538.png"
    },
    "6214618": {
      "name": "paiN  X",
      "logo": "https://cdn.steamusercontent.com/ugc/945085490139513947/1EA8B514789EF8FA0D0C803F52270F782F2A3563/"
    },
    "6214973": {
      "name": "Ninjas in Pyjamas",
      "logo": "https://cdn.steamusercontent.com/ugc/939457282117079692/28F558E0F2E7BD190435810894A08D2E331CE0EF/"
    },
    "6270648": {
      "name": "Zugzwang",
      "logo": "https://cdn.steamusercontent.com/ugc/960847208267343764/2240B6A8BD6D7DB4803FF46C252D572DD800E179/"
    },
    "6288801": {
      "name": "J.Storm",
      "logo": "https://cdn.steamusercontent.com/ugc/957487078841260737/26B134F665A617D841BECA9E0884883E74B98DFA/"
    },
    "6306243": {
      "name": "16 anos melhor idade",
      "logo": "https://cdn.steamusercontent.com/ugc/947336857389428462/09186E8483157C96CCD1AB9ED46A11D26DB1D96A/"
    },
    "6306453": {
      "name": "WarriorsGaming.Unity",
      "logo": "https://cdn.steamusercontent.com/ugc/947338758893687723/9ED51D18B93C3E1CBA9C58706D45CF42D6F2551C/"
    },
    "6350308": {
      "name": "Team \"ENEMY\"",
      "logo": "https://cdn.steamusercontent.com/ugc/759346451803187923/77FC51B601286C248062881956E9D50E4C221BD7/"
    },
    "6355223": {
      "name": "MalaWarrior",
      "logo": "https://cdn.steamusercontent.com/ugc/961974825774130210/8B8443D039374C666BC933E4821FFCBEDC321FC6/"
    },
    "6378559": {
      "name": "Devil Eyes",
      "logo": "https://cdn.steamusercontent.com/ugc/771733253722221121/74FC9DE6D77B7EBD9964FDBC3D43F2D443A1E48B/"
    },
    "6382242": {
      "name": "Thunder Predator",
      "logo": "https://cdn.steamusercontent.com/ugc/771721592096213701/FB6F45207F9BF03F6D94C1C515DACD45A9C33411/"
    },
    "6382740": {
      "name": "Royal",
      "logo": "https://cdn.steamusercontent.com/ugc/937206137839516292/51F476E62579AA097D2035B9BECC8ADB827660CF/"
    },
    "6382770": {
      "name": "Nikcastrum",
      "logo": "https://cdn.steamusercontent.com/ugc/939459996286755063/A2D3963FFC59F2E31D2E3CA9F67D08482E6437A9/"
    },
    "6391499": {
      "name": "ReckoninG eSports ",
      "logo": "https://cdn.steamusercontent.com/ugc/942812211562949712/1A92BF358F2687A4D74D79C4F9C02A4FAE9738EF/"
    },
    "6409189": {
      "name": "Team Empire Hope",
      "logo": "https://cdn.steamusercontent.com/ugc/788624714192129581/94E7F21983B7BB2007C0273EB9A447386433DB36/"
    },
    "6465093": {
      "name": "ForTheDream",
      "logo": "https://cdn.steamusercontent.com/ugc/963103354433927743/0C67ADA24075FF59172BD96DA67D2A6CEEB32963/"
    },
    "6490251": {
      "name": "Playmakers",
      "logo": "https://cdn.steamusercontent.com/ugc/960853363623870632/935E6FA2E39DB9A9D37B73342F19CFBE460E1D12/"
    },
    "6491135": {
      "name": "Flying Penguins",
      "logo": "https://cdn.steamusercontent.com/ugc/995764507566907229/CB60599857CFB9D6710D508F7FC88A3E8D09FE95/"
    },
    "6615678": {
      "name": "Room310",
      "logo": "https://cdn.steamusercontent.com/ugc/948470338978740210/987A4860BE260F2A4707310760B6B46543BE17B1/"
    },
    "6644139": {
      "name": "Willow.Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/803241677502503644/0CC85973DD07A6E4D0C4201298FB085725FBF1EA/"
    },
    "6666989": {
      "name": "Chaos Esports Club",
      "logo": "https://cdn.steamusercontent.com/ugc/967615741400119713/CE2F84E2109A30E7726191C7A574756407478ECE/"
    },
    "6685591": {
      "name": "ViKin.gg",
      "logo": "https://cdn.steamusercontent.com/ugc/1628571207900914834/9A093A05B2DDED488984470F0FADEFDE1F5EDE9F/"
    },
    "6711290": {
      "name": "Team Singularity",
      "logo": "https://cdn.steamusercontent.com/ugc/985630771489365774/32800A83BD06946300371D8516DEE9DB44593DA5/"
    },
    "6711721": {
      "name": "Old but Gold",
      "logo": "https://cdn.steamusercontent.com/ugc/1001393825054966112/D0C717D7C301782DC2A98CEA5C7235B4E1F3D697/"
    },
    "6736502": {
      "name": "Fourzerozone",
      "logo": "https://cdn.steamusercontent.com/ugc/1004771069909482752/0C5151599DECC6AEFD28F8B114C107BC4B840B20/"
    },
    "6765751": {
      "name": "Belial Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/1678121042186214860/39EDE135A62C1DCCC237B13EEA78A19C940DD1B1/"
    },
    "6846412": {
      "name": "Pacific Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/927086512536623410/25993B497FC97BCCC824C943D6E4F383F25E2DEF/"
    },
    "6849739": {
      "name": "Ωmega Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/1458555594796362184/AB542C336682A319783E2EF6AB24F9ACE0779F0D/"
    },
    "6867546": {
      "name": "Demolition Boys",
      "logo": "https://cdn.steamusercontent.com/ugc/920331113103898352/09E8B9E6F0BFFFFAD0A97CD61DB6B6C1C20EFAC3/"
    },
    "6876721": {
      "name": "Hans Pro Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/781853033311013173/34F2620CE5151465690DE7C106B6EF69F02A4757/"
    },
    "6904594": {
      "name": "TEAM TEAM",
      "logo": "https://cdn.steamusercontent.com/ugc/941705094013048629/255CE8E5D541EE17F1851A13802EA56B7E8E0124/"
    },
    "6904952": {
      "name": "Dark Sided",
      "logo": "https://cdn.steamusercontent.com/ugc/985632674115788384/65B294890EA47B692492FF21FCB428BE38BA6D0D/"
    },
    "6905300": {
      "name": "Reels Royce",
      "logo": "https://cdn.steamusercontent.com/ugc/15690071434125760728/FBE769832327573EE0D40DD6F1DFC281BED2EE99/"
    },
    "6908054": {
      "name": "MT Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/1001395272802177218/93730993D4048D696A6B2ED57373AA454939A168/"
    },
    "6926667": {
      "name": "Room310",
      "logo": "https://cdn.steamusercontent.com/ugc/996891527331578667/88E1C53DDAB462C14126B30F6CFE582BB516CF38/"
    },
    "6928546": {
      "name": "Uvajenie.Hope",
      "logo": "https://cdn.steamusercontent.com/ugc/772852808919660116/0F10A749FBB55C9284AC6D8294D2A955DCE90C0B/"
    },
    "6929895": {
      "name": "Pejuang Dota Badung",
      "logo": "https://cdn.steamusercontent.com/ugc/990136273741176420/D0459811843F8E55E73732623C3564812AB5C226/"
    },
    "6930513": {
      "name": "SexyAsFuck",
      "logo": "https://cdn.steamusercontent.com/ugc/974376024287984103/58FD46A4C433631107F3020A0B3CC3DB9738D8BD/"
    },
    "6951036": {
      "name": "Cignal Ultra Warriors",
      "logo": "https://cdn.steamusercontent.com/ugc/1649964989855561528/65E8E2799787201DB9BB4DE498EFC7888E31F2C8/"
    },
    "6952364": {
      "name": "Goblin Legs",
      "logo": "https://cdn.steamusercontent.com/ugc/911323913848297754/7862FCDB3AC14C164F06684635DF61C75F5A23D2/"
    },
    "6953026": {
      "name": "Butterfly Effec",
      "logo": "https://cdn.steamusercontent.com/ugc/996892020312353198/93338DD0C5CA0C1D24C2EA89464FD239EFAD3AEC/"
    },
    "6953151": {
      "name": "ggngg",
      "logo": "https://cdn.steamusercontent.com/ugc/974375368219777269/8DE61AD6337AF273A5A4F8FD09E945C816E7408C/"
    },
    "6953335": {
      "name": "Vega Academy",
      "logo": "https://cdn.steamusercontent.com/ugc/911323913847931930/059F6C3A08E88545DEB78C2E16C1E9B41D7FB034/"
    },
    "6953913": {
      "name": "FlyToMoon",
      "logo": "https://cdn.steamusercontent.com/ugc/916953413384701477/58A15D27D05A5051190589BBED3CDD362AFC3C86/"
    },
    "7079109": {
      "name": "beastcoast",
      "logo": "https://cdn.steamusercontent.com/ugc/824632623398435452/85EA3FC27708076F8ACC2E5B70E25EEC72B09CC6/"
    },
    "7098928": {
      "name": "Adroit",
      "logo": "https://cdn.steamusercontent.com/ugc/1477695389025464429/C8DDE707B2CC970B42699AC1856B96D03AABED7C/"
    },
    "7118032": {
      "name": "Winstrike Team",
      "logo": "https://cdn.steamusercontent.com/ugc/789748832053588401/447AE24D04DB1E105B26197B8716D702A740F310/"
    },
    "7119388": {
      "name": "Team Spirit",
      "logo": "https://cdn.steamusercontent.com/ugc/1839179120711951766/CD7E0885CB527334205CC7885E9C101B7BC17702/"
    },
    "7137328": {
      "name": "Team Anvorgesa",
      "logo": "https://cdn.steamusercontent.com/ugc/806620216003364773/6F8B820F2FE0B29327C1B9851B987512A8332AB7/"
    },
    "7156567": {
      "name": "Sacred Monarch Cult",
      "logo": "https://cdn.steamusercontent.com/ugc/780732839127611014/4C01B834836542CA2D6122E130363EF917D77F66/"
    },
    "7203342": {
      "name": "Chaos EC",
      "logo": "https://cdn.steamusercontent.com/ugc/785254538964288557/60C71B6F83A686A41F3AC5455A70D930B92C41F0/"
    },
    "7269341": {
      "name": "",
      "logo": "https://cdn.steamusercontent.com/ugc/781854449293846193/3B7DF794677380551069930FBC517F74BE1EA685/"
    },
    "7300277": {
      "name": "KZ TEAM",
      "logo": "https://cdn.steamusercontent.com/ugc/2050878574197691966/63BD4F33584531DD81146CD1BBFF4F7C4BAB6312/"
    },
    "7300685": {
      "name": "Team Drinking",
      "logo": "https://cdn.steamusercontent.com/ugc/772849641574165975/5D991135320889D5A5B0D5B543E1C5AEA7B718BF/"
    },
    "7355202": {
      "name": "0-900",
      "logo": "https://cdn.steamusercontent.com/ugc/1704034601417286784/36BCC7B8CD0F264624D0D51541B0A17EE75185C8/"
    },
    "7359917": {
      "name": "Lowkey",
      "logo": "https://cdn.steamusercontent.com/ugc/780750599790860449/55E39216A68ADCFC25930DE5D27AA8C542C0AB2F/"
    },
    "7390454": {
      "name": "The Oversight",
      "logo": "https://cdn.steamusercontent.com/ugc/2054242960854114119/CB44D64E16DFD662E5862394A07CE83047AE24AC/"
    },
    "7391077": {
      "name": "Thunder Awaken",
      "logo": "https://cdn.steamusercontent.com/ugc/2295213908349975977/C88F0F701B1B451F4275464AEC073DF0C4288FBA/"
    },
    "7404529": {
      "name": "Reality Rift",
      "logo": "https://cdn.steamusercontent.com/ugc/1022822776634092251/D6D106057358BC1992E78DEC8421AEC34C472C4E/"
    },
    "7422789": {
      "name": "9Pandas",
      "logo": "https://cdn.steamusercontent.com/ugc/2485502666697365913/234C3E0EDA6A8E315DC78A5EC2C6C1FBB1DD6657/"
    },
    "7424172": {
      "name": "T1",
      "logo": "https://cdn.steamusercontent.com/ugc/773981969136635863/BE28F059BD864F4820323DE5DDD864D4C353CA87/"
    },
    "7441136": {
      "name": "beastcoast",
      "logo": "https://cdn.steamusercontent.com/ugc/773981410527259604/8B88726CBCA1E1F5FC3368D49BCF84F609B138FF/"
    },
    "7443956": {
      "name": "Black Knight",
      "logo": "https://cdn.steamusercontent.com/ugc/770604271209269505/E2BE9219BD93B22A9A29ECDBC4C68251E1616920/"
    },
    "7453020": {
      "name": "Aster.Aries",
      "logo": "https://cdn.steamusercontent.com/ugc/1021697620249691876/0C6C8F47D723EF0B110292609BFDB64EB7B9553C/"
    },
    "7454504": {
      "name": "Demon Esport",
      "logo": "https://cdn.steamusercontent.com/ugc/767226571494366995/65605597C4930F4078EF26D56BBF9CBFBE0F4A49/"
    },
    "7483893": {
      "name": "Fighting PandaS",
      "logo": "https://cdn.steamusercontent.com/ugc/778498799978614883/0203F5435560EFC32DDBB0B7D170ECF50CCD3BE6/"
    },
    "7498762": {
      "name": "Team Oracle.YOUTH",
      "logo": "https://cdn.steamusercontent.com/ugc/761599357008552749/AD4B630E7D98A59F3923A78A2E55FCB3EDD79789/"
    },
    "7542619": {
      "name": "GALKYNYSH",
      "logo": "https://cdn.steamusercontent.com/ugc/1839180033860671079/ADC9EC54D3B6A50F54E372E97C36809E008BD11B/"
    },
    "7553952": {
      "name": "Chicken Fighters !",
      "logo": "https://cdn.steamusercontent.com/ugc/769486732001897391/E5A91F8FB5ACFE3BC4DF89158B318C4D34960F80/"
    },
    "7554697": {
      "name": "Nigma Galaxy",
      "logo": "https://cdn.steamusercontent.com/ugc/1827894588975105240/421C0D8318D71D5DD31FD08A7933AB622AE26590/"
    },
    "7555613": {
      "name": "OG.Seed",
      "logo": "https://cdn.steamusercontent.com/ugc/1004809121655041802/D9C893AC4F6CF2DA59CB22CF7FE1885133389F9A/"
    },
    "7586931": {
      "name": "Avengers",
      "logo": "https://cdn.steamusercontent.com/ugc/779619985829101396/7AD3F16DB80CC0EB3D429F0B66A85F05D68DF6A7/"
    },
    "7641673": {
      "name": "Aggressive Mode.",
      "logo": "https://cdn.steamusercontent.com/ugc/793133917198581287/2372880E304EFDBEFE73D101E54C0A34D9AA8612/"
    },
    "7653080": {
      "name": "Yangon Galacticos",
      "logo": "https://cdn.steamusercontent.com/ugc/2473119197018002013/9F54FB2ED4476EA67C55994F5FB7CDAC3B882809/"
    },
    "7653600": {
      "name": "Aggressive Mode",
      "logo": "https://cdn.steamusercontent.com/ugc/793133917198591097/2372880E304EFDBEFE73D101E54C0A34D9AA8612/"
    },
    "7669103": {
      "name": "Cyber Legacy",
      "logo": "https://cdn.steamusercontent.com/ugc/1634201755650370035/913F61C7C49EC6330168C986C5F1B0D5D2873361/"
    },
    "7681441": {
      "name": "business associates",
      "logo": "https://cdn.steamusercontent.com/ugc/789755010916561479/354F9DF6125FE48FC70FF8588985EF77E8CDDAAE/"
    },
    "7681903": {
      "name": "IO Dota2",
      "logo": "https://cdn.steamusercontent.com/ugc/772866954992254276/4C6C13691C48BD79E1B9AF3FBC735738520C6F51/"
    },
    "7716206": {
      "name": "Clcombat Team",
      "logo": "https://cdn.steamusercontent.com/ugc/771742768467331494/0472A95C77A0E26D08922566045C5039078C6D78/"
    },
    "7731375": {
      "name": "Neets Uprising",
      "logo": "https://cdn.steamusercontent.com/ugc/793134540759885368/BA2CD08B658CE3F2B3571FAAF20E6242555FC1D5/"
    },
    "7732977": {
      "name": "BOOM Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/2916748038054832/52C6F6228C73CDB6855C04B64FF21D061D2C15A9/"
    },
    "7748744": {
      "name": "CR4ZY",
      "logo": "https://cdn.steamusercontent.com/ugc/777372824325330501/0203F5435560EFC32DDBB0B7D170ECF50CCD3BE6/"
    },
    "7777322": {
      "name": "Oshi hi teo Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/14050897008803262158/1FD5BAE3F059692AEFC7340136D3FB7D0E756F6D/"
    },
    "7801839": {
      "name": "Paladin",
      "logo": "https://cdn.steamusercontent.com/ugc/1186083602257343509/F263A4DBCB8B480B6D75EF6660CC11B0A191089E/"
    },
    "7819701": {
      "name": "VP.Prodigy",
      "logo": "https://cdn.steamusercontent.com/ugc/1009310639742423917/9175453DE6C700E0CC6D547F437B4819F1144A1A/"
    },
    "7822261": {
      "name": "Yolo Knight",
      "logo": "https://cdn.steamusercontent.com/ugc/1019444160331853455/D570A703968576DFB06323900AFCA61FD1519BA5/"
    },
    "7893914": {
      "name": "TEAM SIDERAL",
      "logo": "https://cdn.steamusercontent.com/ugc/1753562761757863552/04DB6105E2437AA7B7C9A21E618522A1853AB8B1/"
    },
    "7913999": {
      "name": "Midas Club",
      "logo": "https://cdn.steamusercontent.com/ugc/17938584415227532642/443B12E7F60402DC99D04CD2359992E5B3511949/"
    },
    "7930695": {
      "name": "FAMILY TEAM",
      "logo": "https://cdn.steamusercontent.com/ugc/1021698582220690828/25303B125189AD8D01A52AF6E5B1C7AA4411869E/"
    },
    "7937681": {
      "name": "DestroyItems",
      "logo": "https://cdn.steamusercontent.com/ugc/1026202486988728855/110EDF7E5BDD7D305792871B1FC584B52A5794A8/"
    },
    "8021940": {
      "name": "New Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/1048723493300485230/77C98B21711C5D6981D6964A17F024EEC8674743/"
    },
    "8048279": {
      "name": "Egoboys",
      "logo": "https://cdn.steamusercontent.com/ugc/1282912715388467447/4049258DD58AFA5FB7608E7DC8AC6B08BA920F15/"
    },
    "8062738": {
      "name": "egoboys",
      "logo": "https://cdn.steamusercontent.com/ugc/1326824069902136066/4049258DD58AFA5FB7608E7DC8AC6B08BA920F15/"
    },
    "8062847": {
      "name": "Galaxy Racer Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/1768194395980957182/F98E05970A8BB8574785B80B004EF148D6F589B7/"
    },
    "8063508": {
      "name": "Adió Chula",
      "logo": "https://cdn.steamusercontent.com/ugc/1466435869869827636/4B0CA2C8DFDEC29008BE78F3EB3F73E2A555D1BF/"
    },
    "8077147": {
      "name": "Omegalil",
      "logo": "https://cdn.steamusercontent.com/ugc/1483327361881225989/BED39500E5C02E2A74BFA84F7504884C3D208824/"
    },
    "8080754": {
      "name": "Panda5",
      "logo": "https://cdn.steamusercontent.com/ugc/1465311368136101760/319912C6631CABB60AC43B7AC14B16C8CA741EAC/"
    },
    "8083854": {
      "name": "cuteanimegirls",
      "logo": "https://cdn.steamusercontent.com/ugc/1486703883910276246/1CFB9D3E73FEF9E4820E6B2B17735FFDA9E3D00C/"
    },
    "8086218": {
      "name": "TEAM BRASIL",
      "logo": "https://cdn.steamusercontent.com/ugc/1494586360945844832/05E4DDCA25CA313396FFDF01C0D8E65141911E91/"
    },
    "8089675": {
      "name": "Escape Velocity",
      "logo": "https://cdn.steamusercontent.com/ugc/1482200421119183052/E2A77696D5B5F77238212747B0940810A9751858/"
    },
    "8097689": {
      "name": "EZKATKA",
      "logo": "https://cdn.steamusercontent.com/ugc/1487830656542207062/86C263EBC729678F33CD308921B2274CE3028F41/"
    },
    "8112124": {
      "name": "Brame",
      "logo": "https://cdn.steamusercontent.com/ugc/1535122449444925400/4FF8F5867A8D86DF5700A8BDAD237A457B52E97B/"
    },
    "8121295": {
      "name": "mudgolems",
      "logo": "https://cdn.steamusercontent.com/ugc/1635325934676609507/8E073AB63209CE73BD08E056B1C6CCE1014B3890/"
    },
    "8131438": {
      "name": "4AM",
      "logo": "https://cdn.steamusercontent.com/ugc/1634200726535406834/8226A44B6C690601A9DEF8CBDA98EF857E9CF658/"
    },
    "8131728": {
      "name": "Ukumari",
      "logo": "https://cdn.steamusercontent.com/ugc/2005821149636251119/8AA0FD65758980E29B762EF7124456B95650118D/"
    },
    "8132093": {
      "name": "01 Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/1539625527765315928/563F5BCDBD36AC91DB60BB2A5C017CFB0020B042/"
    },
    "8145157": {
      "name": "Yellow Submarine",
      "logo": "https://cdn.steamusercontent.com/ugc/1648839325588212512/01D7A1FC1156B0550B4EF9EA2A3A2AF84D9BF884/"
    },
    "8151879": {
      "name": "Among Us",
      "logo": "https://cdn.steamusercontent.com/ugc/1660098812171826030/93B496CC8B327FEB2573D6DDD7C340CB9D09A9AB/"
    },
    "8152371": {
      "name": "draingang",
      "logo": "https://cdn.steamusercontent.com/ugc/1657852538982079794/672FC5225508AD2454DF5748EBAA86C169C57B2E/"
    },
    "8160726": {
      "name": "4Fun",
      "logo": "https://cdn.steamusercontent.com/ugc/1683743254297527294/E931D830AC1CDEB7D249E39F652F9C3ED8175625/"
    },
    "8161113": {
      "name": "Live to Win",
      "logo": "https://cdn.steamusercontent.com/ugc/1684869309280763059/CE8EAFDDA8854D0B380EC63B819149778ACEEE0B/"
    },
    "8168302": {
      "name": "Forest",
      "logo": "https://cdn.steamusercontent.com/ugc/1678114018011000727/D4221B7FF3778B415752910C1B95147BD299A32D/"
    },
    "8168546": {
      "name": "FTD.C.Club",
      "logo": "https://cdn.steamusercontent.com/ugc/1675862404285979604/82B845AD9EBA8C7A59DDCD5AE71975CD8E78B5F7/"
    },
    "8169775": {
      "name": "Geek Fam",
      "logo": "https://cdn.steamusercontent.com/ugc/2047502867535132722/C72214A86E6C450DA8CF1A18AE9539B5CAEE7D45/"
    },
    "8172168": {
      "name": "mudgolems",
      "logo": "https://cdn.steamusercontent.com/ugc/1691625337365419101/8E073AB63209CE73BD08E056B1C6CCE1014B3890/"
    },
    "8193609": {
      "name": "Come down",
      "logo": "https://cdn.steamusercontent.com/ugc/1836910666882174916/13C0F9ECE0232A65FDBAECDD2A44DAE63A17FE73/"
    },
    "8203841": {
      "name": "DestroyItems",
      "logo": "https://cdn.steamusercontent.com/ugc/1680367691784130566/110EDF7E5BDD7D305792871B1FC584B52A5794A8/"
    },
    "8214850": {
      "name": "BLEED",
      "logo": "https://cdn.steamusercontent.com/ugc/2295213538402514054/0B50AC73180D7322D099C37682AFF28BE4C4875E/"
    },
    "8244493": {
      "name": "Team SMG",
      "logo": "https://cdn.steamusercontent.com/ugc/1856049226625971775/C8540DF2478E5EE8890CD4128DE07176F9FE5FA2/"
    },
    "8252662": {
      "name": "BINUS University",
      "logo": "https://cdn.steamusercontent.com/ugc/1663483160481733023/362363116FD98B41F54EE099D64203BA6A1A573A/"
    },
    "8254145": {
      "name": "Execration",
      "logo": "https://cdn.steamusercontent.com/ugc/2490004871924581269/9132E5E0903B2A368A00780415D69766292F5893/"
    },
    "8254400": {
      "name": "beastcoast",
      "logo": "https://cdn.steamusercontent.com/ugc/2008072595679478968/A080A63C70A5DEA039FBC1AE798EE2570E194606/"
    },
    "8255756": {
      "name": "Evil Geniuses",
      "logo": "https://cdn.steamusercontent.com/ugc/1983302387907692940/BAA861E234E1BA39D75DF4CB814A5B76D020BED7/"
    },
    "8255888": {
      "name": "BETBOOM TEAM",
      "logo": "https://cdn.steamusercontent.com/ugc/9995426432403529725/51E13136D4CCC8C7D8062861541A1D13B8ED87E0/"
    },
    "8260983": {
      "name": "TSM",
      "logo": "https://cdn.steamusercontent.com/ugc/1996813186806561034/BC39F0DC131EDC7D7D8A9DCE4933B4A8B0966004/"
    },
    "8261234": {
      "name": "CREEPWAVE",
      "logo": "https://cdn.steamusercontent.com/ugc/1681517831574098379/EDF37F1B1A2A8684DC959A8D0880B70FA6F8C5D2/"
    },
    "8261500": {
      "name": "Xtreme Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/2402194226059610590/E3CF4B6C4B2CFB974A9B415141E4A37317AD4D80/"
    },
    "8261554": {
      "name": "Army Geniuses Mansion ",
      "logo": "https://cdn.steamusercontent.com/ugc/2036229291620856332/487BA4B704ADCA08C99B4F67E0DF5EF3D2F4DFD1/"
    },
    "8261774": {
      "name": "V-Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/1699530468133422483/88FB30CF0880687F9BB0429E3C7B59CF673DC700/"
    },
    "8261818": {
      "name": "Hellbear Smashers",
      "logo": "https://cdn.steamusercontent.com/ugc/1745679796967643438/92B0E956ED01D24C679FECED3D23D01EAB1C3048/"
    },
    "8261882": {
      "name": "felt",
      "logo": "https://cdn.steamusercontent.com/ugc/1755809001572876579/859F0227D4B586D6065C5980CFBBBA0ABAAE184C/"
    },
    "8291895": {
      "name": "Tundra Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/2031716132171967904/07B168B8063D9B22CDAD53AB421ECAF3D4B2E07E/"
    },
    "8300363": {
      "name": "SADBOYS.2",
      "logo": "https://cdn.steamusercontent.com/ugc/1767069358937750377/8EB82A2377D028F043009005D43F6D667BF1832E/"
    },
    "8310936": {
      "name": "Wayfarers",
      "logo": "https://cdn.steamusercontent.com/ugc/1844811606349277848/9115EF5523F852C1EDA27BF1194658188AA197FA/"
    },
    "8335298": {
      "name": "Randoms Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/2416817187172584251/5E7AA2C4896A6EB1212B673B731DD9838ECCFB27/"
    },
    "8351318": {
      "name": "férias com ex",
      "logo": "https://cdn.steamusercontent.com/ugc/1758065850922672770/D397D32D9F6271921174EAE74DA98760E1A07BFA/"
    },
    "8360138": {
      "name": "Neon Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/1905612771137210708/67688ED3000B1B2140DCDD96275E114F3F9F3BC7/"
    },
    "8367062": {
      "name": "Pacific ",
      "logo": "https://cdn.steamusercontent.com/ugc/2421319307290243710/2D572643B2BDCCFDA346E9AB51833351BF8CE35E/"
    },
    "8375259": {
      "name": "Infinity",
      "logo": "https://cdn.steamusercontent.com/ugc/2270441745021468359/0B29AFE6D9B224CB4EDB33A07AAC0D3FD19A00A6/"
    },
    "8375466": {
      "name": "Motivate. Viper Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/1697276876114058177/C93540F44666B466DD577679B40A6C689BE874F8/"
    },
    "8376696": {
      "name": "One Move",
      "logo": "https://cdn.steamusercontent.com/ugc/2429222166861438379/2016A60B73B29A620CFA81A830603361CBB388AD/"
    },
    "8384158": {
      "name": "Into The Breach",
      "logo": "https://cdn.steamusercontent.com/ugc/1795223008077512746/B283A962A0FFF8636A3DC829C3F93BA4C9FEE214/"
    },
    "8406333": {
      "name": "kastuDon",
      "logo": "https://cdn.steamusercontent.com/ugc/1815491317552191607/F961671C1BE095A579C9C917BECCFD53EFD497DC/"
    },
    "8406842": {
      "name": "GRIN Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/2001317420616485713/858FEE24286C9D1CDC77AF3D5F3BDAADEB89D2F9/"
    },
    "8428953": {
      "name": "Sinister 5",
      "logo": "https://cdn.steamusercontent.com/ugc/1758072603532456160/1F5DEE24522DB96F9CCA4F5D9BFCAFF5F47BB658/"
    },
    "8443160": {
      "name": "meow meow",
      "logo": "https://cdn.steamusercontent.com/ugc/1767080909754778108/F20BAA83EA92A2A6F4B5AD62CDFF00E0CE38200B/"
    },
    "8482814": {
      "name": "Ragdoll",
      "logo": "https://cdn.steamusercontent.com/ugc/1697280262050066254/F18A176DAA613BB8B016AE90F4E8D17BE02AAA63/"
    },
    "8495691": {
      "name": "TEAM TEAM",
      "logo": "https://cdn.steamusercontent.com/ugc/1697280124490347885/255CE8E5D541EE17F1851A13802EA56B7E8E0124/"
    },
    "8496030": {
      "name": "Furia Jovem",
      "logo": "https://cdn.steamusercontent.com/ugc/1695028324681823345/3E19FB91AF9863F91DABF16601A7E1EB262E5C9B/"
    },
    "8514342": {
      "name": "Infamous Uesports",
      "logo": "https://cdn.steamusercontent.com/ugc/1691652603942290191/76D5156E3CF7847989185216EEBF36157381CAF9/"
    },
    "8556648": {
      "name": "Osh-Tekk Warriors",
      "logo": "https://cdn.steamusercontent.com/ugc/1702905980605432446/292ED6C94389F1281CB5BE93678E3CC28E7BD794/"
    },
    "8571960": {
      "name": "Team Orca",
      "logo": "https://cdn.steamusercontent.com/ugc/1822272203102401273/0DDED0FB4C6EA41DCE3C3DDB25B3D42A40C3C6BB/"
    },
    "8574561": {
      "name": "Azure Ray",
      "logo": "https://cdn.steamusercontent.com/ugc/2298587339939886506/26FF6DD1070476EAF1C69DD30B259FBB197F0256/"
    },
    "8581305": {
      "name": "Lava BestPc",
      "logo": "https://cdn.steamusercontent.com/ugc/1827892670576860117/693ADB9ACBDBD27BD1EDE14A72D02E8F3870B661/"
    },
    "8588969": {
      "name": "HYDRA",
      "logo": "https://cdn.steamusercontent.com/ugc/2511403980000601665/A9227AFA6C2DD7F9A1A8E0F5C4278579DB10833F/"
    },
    "8589016": {
      "name": "Team WANKA",
      "logo": "https://cdn.steamusercontent.com/ugc/1926996054456055976/4EBBE607134216E7F16DC7E111D16095AD1B5548/"
    },
    "8590538": {
      "name": "Mad Queens Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/1821138407262581214/2473111D6CED1B3429F7565EEC44D7A5E16ED628/"
    },
    "8597391": {
      "name": "Luna Galaxy",
      "logo": "https://cdn.steamusercontent.com/ugc/2038491084577608095/CA67ADB750E3B98E8544FB0CC1D2FF1C9EC27A77/"
    },
    "8597509": {
      "name": "Teletubbies",
      "logo": "https://cdn.steamusercontent.com/ugc/1787361110837767265/4FBB5C3616E4B936E58C6C8956635109028528A8/"
    },
    "8597976": {
      "name": "Talon",
      "logo": "https://cdn.steamusercontent.com/ugc/2028347991408203552/8DC9872DA88071D728A914CE17279959423FA340/"
    },
    "8598633": {
      "name": "Moneymakers",
      "logo": "https://cdn.steamusercontent.com/ugc/2021594397761808667/0D4392B2C152DE0424EBCB6B6DC3A4DBDDCCD12F/"
    },
    "8599101": {
      "name": "Gaimin Gladiators",
      "logo": "https://cdn.steamusercontent.com/ugc/1850419664501191993/5DAAB68FB5604D29E1792A0F35E74B3FE3F3A026/"
    },
    "8605863": {
      "name": "Cloud9",
      "logo": "https://cdn.steamusercontent.com/ugc/2399941883261718982/81DE19B3FD9737B5F16C725D3FB7E72251BE2A81/"
    },
    "8606828": {
      "name": "Wildcard",
      "logo": "https://cdn.steamusercontent.com/ugc/5105424732072463157/803C73A4F9A4C089EFD08A2E572BDFADEB838260/"
    },
    "8621525": {
      "name": "barsa",
      "logo": "https://cdn.steamusercontent.com/ugc/10796235327127884/AA68A8E1303A3AD70C0E5833A04117BEEC546C83/"
    },
    "8634419": {
      "name": "«444» Squad",
      "logo": "https://cdn.steamusercontent.com/ugc/2483261555751237752/8444746CA8F12036A07FB6A2237C3F0A45A14D42/"
    },
    "8638540": {
      "name": "Blackpukers",
      "logo": "https://cdn.steamusercontent.com/ugc/1887597844446270477/6E387B14978698302B904FEB2FC24F45D8CE99B1/"
    },
    "8638867": {
      "name": "Easy Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/1833543457070431639/775F05FC8F1C0E14E1E6DBAB2CBF192165A413E2/"
    },
    "8668460": {
      "name": "Blacklist Rivalry ",
      "logo": "https://cdn.steamusercontent.com/ugc/2050860821377863997/BAE16F709F0AE46642FAD3366C78FD92FD2FD741/"
    },
    "8680612": {
      "name": "noMERCY",
      "logo": "https://cdn.steamusercontent.com/ugc/2072263299220300385/701C7260941442D8CA1765012CBEE385EC2E23A7/"
    },
    "8685986": {
      "name": "ТАНК",
      "logo": "https://cdn.steamusercontent.com/ugc/1848168397345520023/8AD4F1B3BAFEF1120B737CA49509C2858C85B647/"
    },
    "8721219": {
      "name": "Darkside",
      "logo": "https://cdn.steamusercontent.com/ugc/1845922937363804366/B718AFD0F76379ACDDE28F7512FC91B76C478985/"
    },
    "8721917": {
      "name": "shelbywalk",
      "logo": "https://cdn.steamusercontent.com/ugc/15500294396428948218/B3D9E39B396F247D9961EF5905313F9290380F96/"
    },
    "8722443": {
      "name": "Ooredoo Thunders",
      "logo": "https://cdn.steamusercontent.com/ugc/1883094124816874766/6F395B569068034041A162578E78E83902E46E83/"
    },
    "8724984": {
      "name": "Virtus.pro",
      "logo": "https://cdn.steamusercontent.com/ugc/1796396122320355023/2E833B3744ECB93AD9FF3797C0309B4ADB54AD2E/"
    },
    "8728920": {
      "name": "nouns",
      "logo": "https://cdn.steamusercontent.com/ugc/1861686187975269057/6E221E0B04CCB4AEF93A3FDA4DC7873A1BBAFAE2/"
    },
    "8732399": {
      "name": "pangolier s javelinom",
      "logo": "https://cdn.steamusercontent.com/ugc/1852678988747798218/13734C5F707C49CF2880386C3B044D8754667C91/"
    },
    "8737621": {
      "name": "Lava Esports ",
      "logo": "https://cdn.steamusercontent.com/ugc/2020458443820677798/6DBE7E16C897F641DC4BA91F1F04D784905F72B5/"
    },
    "8741331": {
      "name": "Atomic Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/1854933517826836824/47F54E3D687725343A8B56CB6785A0156E3F1423/"
    },
    "8741404": {
      "name": "Equisde somos chavos",
      "logo": "https://cdn.steamusercontent.com/ugc/1827910574771249710/7D8F9013F3C25ADD92CD6ABFAEFA44319DC73089/"
    },
    "8747056": {
      "name": "Virtus.pro2",
      "logo": "https://cdn.steamusercontent.com/ugc/1872947708319301759/087EF97925087F92561983C34475ACBB68A60AE4/"
    },
    "8750317": {
      "name": "Team Sphinx",
      "logo": "https://cdn.steamusercontent.com/ugc/2048607934858898157/B904083AF403DC27F8DC18EA96E2406AEB64BFDA/"
    },
    "8761147": {
      "name": "tam_sme",
      "logo": "https://cdn.steamusercontent.com/ugc/1830165414580693025/0490CB1A1C9A39BE4735653CDA9DF8270BE26CB8/"
    },
    "8769201": {
      "name": "HAVU",
      "logo": "https://cdn.steamusercontent.com/ugc/1833543457080341173/97E231A7DB51D0CA99DD8D8668835FBA8FE7B09C/"
    },
    "8789578": {
      "name": "vezzra",
      "logo": "https://cdn.steamusercontent.com/ugc/2042986495990339051/AD05C5372484A344F81EF3351636B3841D46B38E/"
    },
    "8790102": {
      "name": "Anime Enjoyers",
      "logo": "https://cdn.steamusercontent.com/ugc/1779504675340866269/9B84E5C6529F42243451665477F33B96C1F475F5/"
    },
    "8820521": {
      "name": "NoMatthew",
      "logo": "https://cdn.steamusercontent.com/ugc/2438208701509068489/350B89E8E9FB98BF8027B3FCDE4637AA2A15064D/"
    },
    "8835624": {
      "name": "Team Sangre",
      "logo": "https://cdn.steamusercontent.com/ugc/14219176089841400535/F1E15FF4CC95FFB792428F07BE7F48B1843A3821/"
    },
    "8838314": {
      "name": "Matreshka",
      "logo": "https://cdn.steamusercontent.com/ugc/2289581108031278201/DE2ED21F4DEEB8C3E302C5A0AF9CAF8CC84E8BA8/"
    },
    "8856078": {
      "name": "Balrogs Academy™",
      "logo": "https://cdn.steamusercontent.com/ugc/2020475078797052490/F6FEC85DF2E0E90E8E82CEA182D078E0B7C97554/"
    },
    "8856125": {
      "name": "Ancient Tribe2",
      "logo": "https://cdn.steamusercontent.com/ugc/1990057992897734075/07A293B6565085107C7A440115D66892AA2006FC/"
    },
    "8858106": {
      "name": "Unity Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/1903359885429306314/1A31E4B8947848865DDF8656458180572F6DB941/"
    },
    "8893633": {
      "name": "STUDIO21",
      "logo": "https://cdn.steamusercontent.com/ugc/1912368892091918094/3CF192AF17F69AF5EB695B785E8077A799322CEF/"
    },
    "8894818": {
      "name": "PSG.Quest",
      "logo": "https://cdn.steamusercontent.com/ugc/2481004682513190539/324F8847AD21944686DED20FB3E2C0DEA4154AE7/"
    },
    "8911139": {
      "name": "Manta Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/2478749260055361941/F4D1D80AB29862CA0C957DFAD1456CBE98483F27/"
    },
    "8927141": {
      "name": "tatladderclan",
      "logo": "https://cdn.steamusercontent.com/ugc/2457349000339157388/C4F54B5F7603A9B99B4637B981E187FDA1541E32/"
    },
    "8927162": {
      "name": "YNOT FAN CLUB",
      "logo": "https://cdn.steamusercontent.com/ugc/1978798064098818022/F251312057A2ADE7AA3655A08917372BC5537544/"
    },
    "8936210": {
      "name": "Outsiders From CN",
      "logo": "https://cdn.steamusercontent.com/ugc/2028342277680788691/B504CC3B01CFEB0201FF7B7CE96F50F61196CE29/"
    },
    "8936382": {
      "name": "Indonesia",
      "logo": "https://cdn.steamusercontent.com/ugc/1997939086698116350/3396FD82A230192B8DF91D21C93837E95D1AC23B/"
    },
    "8936568": {
      "name": "МГАФК",
      "logo": "https://cdn.steamusercontent.com/ugc/2031736116034979471/1A61C034BCF52896F2AA0421D033716923CA6880/"
    },
    "8944230": {
      "name": "Yangon Galacticos",
      "logo": "https://cdn.steamusercontent.com/ugc/2473119197018013407/9F54FB2ED4476EA67C55994F5FB7CDAC3B882809/"
    },
    "8944302": {
      "name": "Myth Avenue Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/2077887587643978863/6C1ACCEC01EB0BE4C9C75D82421118973C757DCF/"
    },
    "8944440": {
      "name": "StoRm",
      "logo": "https://cdn.steamusercontent.com/ugc/2028354481551397489/BA39B32EA6335F75295CDB5E36DCB31D3FC93F77/"
    },
    "8951348": {
      "name": "fire beavers",
      "logo": "https://cdn.steamusercontent.com/ugc/1979926046523390782/D449E850DC2A83DDA3984B3788DA054AE404E28E/"
    },
    "8962585": {
      "name": "Star Foxes ",
      "logo": "https://cdn.steamusercontent.com/ugc/2046362392217398188/E6B179AA7B1FAAD9674EE563C044BFDA13502383/"
    },
    "8962689": {
      "name": "Star Foxes",
      "logo": "https://cdn.steamusercontent.com/ugc/2036224757701238372/A6FA8DDA68296D4ED65754301F2C0AEC812321F7/"
    },
    "8970358": {
      "name": "mind takers",
      "logo": "https://cdn.steamusercontent.com/ugc/2001317618118649176/D5F933113354B4991C5D61FB3C6FCEB074507571/"
    },
    "8975618": {
      "name": "Old But Gold",
      "logo": "https://cdn.steamusercontent.com/ugc/2017083824169668422/108D194C49DF4F4A4797950F86160B07EA67C97F/"
    },
    "8975678": {
      "name": "Team Sexy",
      "logo": "https://cdn.steamusercontent.com/ugc/2032861231216761354/13C0C97E4F1B758EDAF89B19C45226E68DFEEA52/"
    },
    "8980561": {
      "name": "Block Roar Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/2001323196957602976/EF30A8E48B45F4299DEDCCDB2BCF9B30ECC49CA7/"
    },
    "8980714": {
      "name": "Team Tough",
      "logo": "https://cdn.steamusercontent.com/ugc/2298586614153129772/34892DA3BE31B7E7E9E4BED828EB54B3A055388A/"
    },
    "8998465": {
      "name": "TpaBoMaH",
      "logo": "https://cdn.steamusercontent.com/ugc/40063924290200515/BD0C76D0F4029CAA32E2F43A04BF6A5F68135820/"
    },
    "9005019": {
      "name": "IHC",
      "logo": "https://cdn.steamusercontent.com/ugc/2514771532510530932/AA92D7C7649DD3366A31E0E1F772356805B73442/"
    },
    "9005165": {
      "name": "Star Foxes",
      "logo": "https://cdn.steamusercontent.com/ugc/2027220095511607538/A6FA8DDA68296D4ED65754301F2C0AEC812321F7/"
    },
    "9017006": {
      "name": "NAVI Junior",
      "logo": "https://cdn.steamusercontent.com/ugc/2909225722380320/5C6EFC9004093ED29E9B48242DE79418BDDBFE30/"
    },
    "9018664": {
      "name": "Team Bright",
      "logo": "https://cdn.steamusercontent.com/ugc/2008081064641074125/98465178D23A5C307E6AA8CE298B17CEBB16B979/"
    },
    "9018710": {
      "name": "Holy Grail",
      "logo": "https://cdn.steamusercontent.com/ugc/2036233631759545038/183C2584681DBC309834BCE5561EA04CDDFFC736/"
    },
    "9025359": {
      "name": "The Covenant",
      "logo": "https://cdn.steamusercontent.com/ugc/2187121345783071266/E1E6B530D0C644B81A08CE51ED03A9BB5698D1C0/"
    },
    "9032897": {
      "name": "Wing Ripper",
      "logo": "https://cdn.steamusercontent.com/ugc/2200631506770437455/E5C9DBEA9D2EECC4F3F98DE49AC1D6D8EE533B88/"
    },
    "9054352": {
      "name": "Fortnite",
      "logo": "https://cdn.steamusercontent.com/ugc/16326258531762154557/88D6A1CB366D006460F6FF183FA8230F26E5C456/"
    },
    "9079901": {
      "name": "The last dark",
      "logo": "https://cdn.steamusercontent.com/ugc/2037359531667015102/14D1DA388EDDCD83477977801CA13A77A40373BE/"
    },
    "9103873": {
      "name": "Infamous Astra",
      "logo": "https://cdn.steamusercontent.com/ugc/2032858469296116678/EDF6030FFA1952797EE94712BB781280D5034932/"
    },
    "9131584": {
      "name": "BB Team",
      "logo": "https://cdn.steamusercontent.com/ugc/9393895253468454856/41CF4EBEB359259E56E03AECEF6A7606CF0A076F/"
    },
    "9142866": {
      "name": "Business Club",
      "logo": "https://cdn.steamusercontent.com/ugc/2031737253379162247/A9D128309B9FC2C328AE048CB69E4D07C67BD26C/"
    },
    "9148266": {
      "name": "AcatSuki",
      "logo": "https://cdn.steamusercontent.com/ugc/2053131008994362284/5E9C97210030F1BE6E890A2B813DD18411C1A12A/"
    },
    "9175127": {
      "name": "Generation of Miracles",
      "logo": "https://cdn.steamusercontent.com/ugc/2018230014077150128/2A5B42C481DCF8BC3A8AF59BB40F2587E10541C8/"
    },
    "9175367": {
      "name": "Business Club",
      "logo": "https://cdn.steamusercontent.com/ugc/2041874097465563602/35B8C3D831CFD2EF5A19512410C18F1B7F9C460A/"
    },
    "9176102": {
      "name": "Team Arava",
      "logo": "https://cdn.steamusercontent.com/ugc/2057636696173009399/4BEC52A21EB8A6E14EC365656FAC33A1C84231BF/"
    },
    "9187132": {
      "name": "MAG.ID",
      "logo": "https://cdn.steamusercontent.com/ugc/2213016405732835572/D7955018FA3AC7FBB78621C5C6D5AD33B9EF673B/"
    },
    "9201870": {
      "name": "ROR",
      "logo": "https://cdn.steamusercontent.com/ugc/2076779599437195979/F472FC7B699006A25B505F6AAC6B12CBF1B73DCF/"
    },
    "9216247": {
      "name": "ASAKURA",
      "logo": "https://cdn.steamusercontent.com/ugc/2370671116173459609/9854CD03A6A44348475DC298295552B5CEA70794/"
    },
    "9216658": {
      "name": "Lion Lover",
      "logo": "https://cdn.steamusercontent.com/ugc/2125194398903885481/3295CDB3D4CB4328A2FA7BD70AB4B18FA724AD1E/"
    },
    "9229377": {
      "name": "DemiGods",
      "logo": "https://cdn.steamusercontent.com/ugc/2109432346272393261/5D02E4493B1E9373C84054C315FA87BCB54A0C66/"
    },
    "9247260": {
      "name": "YodiBrodi Nexus Future",
      "logo": "https://cdn.steamusercontent.com/ugc/2217520643255336308/6E456F96913CB97E109B7676E931994A786BDDFD/"
    },
    "9247354": {
      "name": "Team Falcons",
      "logo": "https://cdn.steamusercontent.com/ugc/2314350571781870059/2B5C9FE9BA0A2DC303A13261444532AA08352843/"
    },
    "9247798": {
      "name": "Passion UA",
      "logo": "https://cdn.steamusercontent.com/ugc/18319865695983129908/E7302CFFC29E4716B28F5BAB4812020B2C61E389/"
    },
    "9248240": {
      "name": "TeamWaska",
      "logo": "https://cdn.steamusercontent.com/ugc/2376297984889887726/F2376446D05157B080B5D506473EE2F1D43097BF/"
    },
    "9255039": {
      "name": "enjoy",
      "logo": "https://cdn.steamusercontent.com/ugc/14410915104676115574/85F6E2C9BBB26A11B37E55AF05BE507E94B06863/"
    },
    "9255238": {
      "name": "ESTAR_BACKS",
      "logo": "https://cdn.steamusercontent.com/ugc/2247920665251197227/5D236EEB62190F9B0FC6F25BDA98DDB3EB6A5F0A/"
    },
    "9255706": {
      "name": "Aurora.1xBet",
      "logo": "https://cdn.steamusercontent.com/ugc/2362769341411270166/E13C592A0E744E1C386E09DE650BE36B85AE8137/"
    },
    "9256136": {
      "name": "Bammysoy",
      "logo": "https://cdn.steamusercontent.com/ugc/2298591238452720970/D1327CB4F1C336091246D8A42CEDCCEBB02F56FC/"
    },
    "9256222": {
      "name": "Wawitas sagazes",
      "logo": "https://cdn.steamusercontent.com/ugc/2295210273364324956/528675A3C5A05E302E1BCD5FB2409479B0A2F632/"
    },
    "9256405": {
      "name": "Level UP esports",
      "logo": "https://cdn.steamusercontent.com/ugc/11124972020884745329/AB3238A17EE9950F7532A26B1EAAFCF2086FB37A/"
    },
    "9263388": {
      "name": "The dudley boys",
      "logo": "https://cdn.steamusercontent.com/ugc/2240039780382774383/E60E1732900AE3CE26C1BEA0BBE7B85CCB872B8E/"
    },
    "9279103": {
      "name": "Business club",
      "logo": "https://cdn.steamusercontent.com/ugc/2315476471672988468/630288F96C4CB6BE1A045382D8638D0E93FC81BF/"
    },
    "9283988": {
      "name": "Invaders",
      "logo": "https://cdn.steamusercontent.com/ugc/2297462073171121106/5EF06B2A21F8BDFA6E3A99CE45C896E47B05A926/"
    },
    "9303076": {
      "name": "Ninja Penguins",
      "logo": "https://cdn.steamusercontent.com/ugc/2321110410943510446/9E5FCD7F361FE09E5F98520D435ECF6642680AEC/"
    },
    "9303383": {
      "name": "L1GA TEAM",
      "logo": "https://cdn.steamusercontent.com/ugc/40063200209690390/20B527165E8E637C83F27A62FFE1AE957CB43018/"
    },
    "9303484": {
      "name": "HEROIC",
      "logo": "https://cdn.steamusercontent.com/ugc/2471984170520125054/B066431AF4D322D300DD5180CEC8F6BA0E85A7F5/"
    },
    "9309054": {
      "name": "DRune",
      "logo": "https://cdn.steamusercontent.com/ugc/2280576552131881929/F0B866F1CF06C9581B6EC01530F3A54A26E6FF40/"
    },
    "9309563": {
      "name": "Skyblades",
      "logo": "https://cdn.steamusercontent.com/ugc/2424697006978293524/F5906F73364F065897D36A2CD1B5AFBB8DE40DCD/"
    },
    "9316029": {
      "name": "5PIVAS",
      "logo": "https://cdn.steamusercontent.com/ugc/2477628251801454155/8FB93CDB48A5AD9FD8B48C577ED07B9A6D5DE0A2/"
    },
    "9323607": {
      "name": "V1dar Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/2294088813186214814/919F642EEBB4E986EF6F29780B9728CC996E0DAE/"
    },
    "9330146": {
      "name": "Sporkface Killaz Div2",
      "logo": "https://cdn.steamusercontent.com/ugc/2276074414692701591/5E311B3953236794EB3E8DF05FE439AF0329B01A/"
    },
    "9337731": {
      "name": "LEVIATAN",
      "logo": "https://cdn.steamusercontent.com/ugc/2476496009610060553/805B58DE6A151FD0946F26A8181F711AB38FDD9F/"
    },
    "9338413": {
      "name": "MOUZ",
      "logo": "https://cdn.steamusercontent.com/ugc/14936784213521439739/3EA33A8516BDE538B7963F044CD1B7AB4B0BB60D/"
    },
    "9345335": {
      "name": "Team Kobolds",
      "logo": "https://cdn.steamusercontent.com/ugc/2462977603804344116/289965BA1A48CC692D9E133DAC9EF95DC590FC64/"
    },
    "9346249": {
      "name": "Geek Fam",
      "logo": "https://cdn.steamusercontent.com/ugc/2492249322244227443/C72214A86E6C450DA8CF1A18AE9539B5CAEE7D45/"
    },
    "9351740": {
      "name": "Yakult Brothers",
      "logo": "https://cdn.steamusercontent.com/ugc/18179376480673513766/A3EDE6125A651D94E1DAAF0F3361ACEB9FB858C4/"
    },
    "9354246": {
      "name": "pig monsters",
      "logo": "https://cdn.steamusercontent.com/ugc/5936377725255412591/EC5CFAD80CD15F84F4E2BFD89366AA57FAE4D09C/"
    },
    "9359842": {
      "name": "Salvation Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/5970154800985346024/DC78EF1BA500CF4791BDDE81A03538E2F5D990EA/"
    },
    "9360651": {
      "name": "Dandelions",
      "logo": "https://cdn.steamusercontent.com/ugc/15715194248994242624/F95A1A1356998D2390CC2D8A57E56041A25BF9F7/"
    },
    "9366478": {
      "name": "HouseHold Warriors",
      "logo": "https://cdn.steamusercontent.com/ugc/2432577673800461225/E7AF4C273DF7AF34DD173E80005AD53BA8E4E674/"
    },
    "9366499": {
      "name": "KEV",
      "logo": "https://cdn.steamusercontent.com/ugc/2470858903185171081/B86EC502336507A8BC8CEDC1E571D9E273B7EAD6/"
    },
    "9366826": {
      "name": "UpStars",
      "logo": "https://cdn.steamusercontent.com/ugc/2475370109679095856/F4A379BD3CB8025AEEFBF095E93849C569032E70/"
    },
    "9366989": {
      "name": "Flux",
      "logo": "https://cdn.steamusercontent.com/ugc/41189100113460376/096249E777121953D6AC624E04AA3C9637A268C9/"
    },
    "9368468": {
      "name": "Twisted Minds",
      "logo": "https://cdn.steamusercontent.com/ugc/2441593112495798517/2CF737A11985595217CF576C9DCB365CEB5A74DE/"
    },
    "9373270": {
      "name": "Night Pulse",
      "logo": "https://cdn.steamusercontent.com/ugc/2479883856029444185/44A2207BF5B75CADD5B02860CC3D78333E4E1E76/"
    },
    "9373474": {
      "name": "Tuc Eht",
      "logo": "https://cdn.steamusercontent.com/ugc/2451718604764286989/DBCD8161274D6944742FFBA79DBB65ECC47CDED6/"
    },
    "9373877": {
      "name": "Team Darleng",
      "logo": "https://cdn.steamusercontent.com/ugc/2442711405517313633/01FD0FD39B4AE9F4775E28C82210E7EF4AFC6898/"
    },
    "9381131": {
      "name": "Uzumaki",
      "logo": "https://cdn.steamusercontent.com/ugc/2466356199630889718/46DF71E78D3B769867F51200FB60F6C692EFFF28/"
    },
    "9381678": {
      "name": "Apex Genesis",
      "logo": "https://cdn.steamusercontent.com/ugc/2441586999439290451/0F48C94C7A1F1E5FCB4A339E23F52CBEE97D8024/"
    },
    "9388293": {
      "name": "4 Amigos",
      "logo": "https://cdn.steamusercontent.com/ugc/2476496009594397006/08A8957CE77F45BB6A7A43F135C7AD90F4F22EFA/"
    },
    "9389381": {
      "name": "Team  KEV",
      "logo": "https://cdn.steamusercontent.com/ugc/2527155798055904204/2AEEDAB9C8203A2C066B01850585C6E37589FF9F/"
    },
    "9402359": {
      "name": "Notorious Thugs",
      "logo": "https://cdn.steamusercontent.com/ugc/5819288008771164199/E44A4357CB7AA7B6F556E307375C95DF1CFE22AD/"
    },
    "9403748": {
      "name": "Dragon Esports Club",
      "logo": "https://cdn.steamusercontent.com/ugc/2467493249717162257/D34CF87168F0C0C6D8BC4580AE02C84E732AEE3A/"
    },
    "9408618": {
      "name": "ritashidog",
      "logo": "https://cdn.steamusercontent.com/ugc/60342078793660354/C2CE1274A269EE773EEBD884D449F29F732A8888/"
    },
    "9409659": {
      "name": "spiky gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/2497884302563869757/495402769E3CA0B57209C58A2A52EF5E38D8513D/"
    },
    "9414008": {
      "name": "Team Lotus ",
      "logo": "https://cdn.steamusercontent.com/ugc/2467488176507453485/AA8BEE3964987A6664C810F80DB21CF25600B6C1/"
    },
    "9414473": {
      "name": "ShIShUlI_V",
      "logo": "https://cdn.steamusercontent.com/ugc/2512521001371768591/C9797250D3ACED7BA22F96F595CB1E39D5429362/"
    },
    "9414800": {
      "name": "Business Club",
      "logo": "https://cdn.steamusercontent.com/ugc/2518151211081909317/069C7E7A630A8FA333ED65FE72820D4091D24953/"
    },
    "9415733": {
      "name": "Team Random",
      "logo": "https://cdn.steamusercontent.com/ugc/2494507313164208609/E51D7AF0DD51BCE6EBA1DE8BE33212EE6594D1CB/"
    },
    "9419768": {
      "name": "Neutron",
      "logo": "https://cdn.steamusercontent.com/ugc/2477620729413646945/4A45B3162ADC2D9FC9B920D594685BD2102E495B/"
    },
    "9426024": {
      "name": "Shadow Reapers",
      "logo": "https://cdn.steamusercontent.com/ugc/2479873167159435718/56CD0109F030FD9C3414E93C567D974CEA3CCCBF/"
    },
    "9426804": {
      "name": "winners gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/2492270927935943978/7F17A8AA7C2C2A18A5C0D496CF17BD7F780AE703/"
    },
    "9432799": {
      "name": "Cuyes e-Sports",
      "logo": "https://cdn.steamusercontent.com/ugc/2499012826582236771/CFDA1E083BBE8D65AF615F5E73A4E193BA38B0C0/"
    },
    "9438887": {
      "name": "Elevate Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/2450600311727141987/D39D9A417D974630BFA31A161C4221DDB2C72223/"
    },
    "9439001": {
      "name": "Free Stack",
      "logo": "https://cdn.steamusercontent.com/ugc/2446096078273768662/E8939FA0F492A90C42B1018C5974EF9AE2599A9F/"
    },
    "9439086": {
      "name": "Stellar Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/2456229811293389870/3F6E0B7F87D2585F2B7007A1717544141755F76A/"
    },
    "9439153": {
      "name": "冥界",
      "logo": "https://cdn.steamusercontent.com/ugc/2440466578744036313/0F2921891CB9FCEB3203BDF81E3AB9E8FE6BEB32/"
    },
    "9443873": {
      "name": "V3tal_GandJuba5",
      "logo": "https://cdn.steamusercontent.com/ugc/2467488268118942117/31B215C8107653CB7AC395B8FBDD249E2B9D14C6/"
    },
    "9444017": {
      "name": "Pomo1ka",
      "logo": "https://cdn.steamusercontent.com/ugc/2458481611077470497/97DDA30B5A0216A46DD938174BFC72E6BDCCE463/"
    },
    "9444022": {
      "name": "1stplaceenj",
      "logo": "https://cdn.steamusercontent.com/ugc/2442719012381761159/D8A6AF84DE249B180A6CD53451EAF563F0980E78/"
    },
    "9444023": {
      "name": "rereametag",
      "logo": "https://cdn.steamusercontent.com/ugc/2497888107818139952/36119E06F607B944EF38672538E3FEF299296757/"
    },
    "9444026": {
      "name": "Courage Company",
      "logo": "https://cdn.steamusercontent.com/ugc/2451726211633407444/CCA6B294EEB44D863076A686BE79B477DB7690BF/"
    },
    "9444031": {
      "name": "Ofis Prezidenta",
      "logo": "https://cdn.steamusercontent.com/ugc/15213337614985874187/C08EBE2A158ECDEDCE9CCC74D4FA128356CB31CC/"
    },
    "9444039": {
      "name": "Amanita",
      "logo": "https://cdn.steamusercontent.com/ugc/2466362910424630018/0F077DE393426906AB0B593F9693D6A9CC042B26/"
    },
    "9444060": {
      "name": "Sosroko",
      "logo": "https://cdn.steamusercontent.com/ugc/2442719012382396222/75ADDA8BB2CCD9B535DB2C6761CD39E4DBDC33DA/"
    },
    "9444069": {
      "name": "Team Chicks",
      "logo": "https://cdn.steamusercontent.com/ugc/2448348511915761126/9C9D289E409F0E02D08EFF2C73FE9D0F9A43F589/"
    },
    "9444155": {
      "name": "Western Wolves",
      "logo": "https://cdn.steamusercontent.com/ugc/2446096712105180450/BA9CE23C1F0F48D31A6C168C58A3E958272C0D66/"
    },
    "9444370": {
      "name": "Bastard Munchen",
      "logo": "https://cdn.steamusercontent.com/ugc/2485503208848871134/1A54EF518AC5753D5AE8119C046A00B105AFE194/"
    },
    "9445138": {
      "name": "Twisted Minds",
      "logo": "https://cdn.steamusercontent.com/ugc/2441593112493017648/2CF737A11985595217CF576C9DCB365CEB5A74DE/"
    },
    "9448501": {
      "name": "TEAM TURTLE",
      "logo": "https://cdn.steamusercontent.com/ugc/2465238196943871680/E2D76C1FAB3A8F86D56B811D15971CD91969B40A/"
    },
    "9448650": {
      "name": "Orrai+4",
      "logo": "https://cdn.steamusercontent.com/ugc/2485503208863898605/4C481558A378A4F503284512CD64F3A620C716B9/"
    },
    "9450071": {
      "name": "Fusion Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/20931146537158351/0940BE82E218C71369C672C95943445AA450EF45/"
    },
    "9460640": {
      "name": "ValenTiny",
      "logo": "https://cdn.steamusercontent.com/ugc/2473119977658518607/386E349C3238B03F4B4404FA1F775BD2285B8B6E/"
    },
    "9466943": {
      "name": "Team Tea",
      "logo": "https://cdn.steamusercontent.com/ugc/2547430415563820852/14C528D0CE511F1534CABBB97EBAECCF0CC22DD0/"
    },
    "9467024": {
      "name": "Dominion",
      "logo": "https://cdn.steamusercontent.com/ugc/2511401442963320919/257CB3B69D75A5BE2033B35AB3DC1EAABFE0B207/"
    },
    "9467224": {
      "name": "Aurora Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/12718684494192239317/812E31EF22D232EFE1F1F147940F3D3BEE55D40D/"
    },
    "9467430": {
      "name": "Blacklist International",
      "logo": "https://cdn.steamusercontent.com/ugc/2541800915846514860/CF1883DC6BFE37EA765A0920324ACE06A410DF63/"
    },
    "9470838": {
      "name": "Infinity",
      "logo": "https://cdn.steamusercontent.com/ugc/2509149818685438891/5B2E6F77EF94D4EF6DDF90A003CA91BEA2C03F31/"
    },
    "9476778": {
      "name": "Eye Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/2548556315446212479/F4D0AD6C0EFC58DCF8DED009E4D51F25BE2DA05F/"
    },
    "9476852": {
      "name": "UZUMAKI",
      "logo": "https://cdn.steamusercontent.com/ugc/2538423216318694079/46DF71E78D3B769867F51200FB60F6C692EFFF28/"
    },
    "9477537": {
      "name": "52turbo",
      "logo": "https://cdn.steamusercontent.com/ugc/13902376277869123176/4222027B4B1F834C27DBDC6D87228726444B182A/"
    },
    "9482900": {
      "name": "Рязань-ВДВ",
      "logo": "https://cdn.steamusercontent.com/ugc/13741096457434928378/380B5E62BB30028B2BFFAE56DBBC839E5F1B915B/"
    },
    "9498970": {
      "name": "AVULUS",
      "logo": "https://cdn.steamusercontent.com/ugc/2484388089175887648/AD2555E0F8E1783B66E6A3F88D0D3481E11BDE2A/"
    },
    "9499095": {
      "name": "Legacy",
      "logo": "https://cdn.steamusercontent.com/ugc/2483257751331641617/0F960E60CEB27A6732146E98A194B9E3F8E29BE4/"
    },
    "9500213": {
      "name": "Bruv123",
      "logo": "https://cdn.steamusercontent.com/ugc/2464121890863035592/69CB2CDE8B7290C49DB92F16EE84811F3D6F7278/"
    },
    "9505239": {
      "name": "Rakuzan",
      "logo": "https://cdn.steamusercontent.com/ugc/14172984088870282/5F013D18FA3BF8B3AEAB8B9EE8785CAD9CAB80AB/"
    },
    "9545744": {
      "name": "Team Kukuys",
      "logo": "https://cdn.steamusercontent.com/ugc/2495646454751623231/64BE465662BBDCBF2128F93AC1BFCB0B8C6E15AF/"
    },
    "9545759": {
      "name": "Waska",
      "logo": "https://cdn.steamusercontent.com/ugc/2492268755024477919/F2376446D05157B080B5D506473EE2F1D43097BF/"
    },
    "9546437": {
      "name": "KUKUYS 2.0",
      "logo": "https://cdn.steamusercontent.com/ugc/2453988791679025351/801DDD227A2677A72F286FCE8D249B818C76D43B/"
    },
    "9546449": {
      "name": "Yangon Galacticos",
      "logo": "https://cdn.steamusercontent.com/ugc/2473119197018013407/9F54FB2ED4476EA67C55994F5FB7CDAC3B882809/"
    },
    "9554242": {
      "name": "Play for Fun",
      "logo": "https://cdn.steamusercontent.com/ugc/2503529021823838530/28113541EE2ACBA2A2A253067487EB0ED0A29323/"
    },
    "9572001": {
      "name": "TEAM VISION",
      "logo": "https://cdn.steamusercontent.com/ugc/10380389074903512947/5D074799695A862D17D4205285315FE20399B28D/"
    },
    "9572357": {
      "name": "Студените",
      "logo": "https://cdn.steamusercontent.com/ugc/2451738894326862300/CEC5C9CBAFF2BBE5E0733B950A1733382B13793F/"
    },
    "9586420": {
      "name": "KIBA ARMS",
      "logo": "https://cdn.steamusercontent.com/ugc/2452865428987917753/782E74D6A8E46FC8D2B0F96490344A50BEF647B9/"
    },
    "9593609": {
      "name": "Nethercore",
      "logo": "https://cdn.steamusercontent.com/ugc/2442732965763263237/79D0D159903371DC20501B6507AA311EF6FAFE86/"
    },
    "9593895": {
      "name": "Gaozu",
      "logo": "https://cdn.steamusercontent.com/ugc/23175424386899819/25AC5B927B5B194D204BE406F53B3ADB1F2B6E4B/"
    },
    "9594647": {
      "name": "PuckChamp",
      "logo": "https://cdn.steamusercontent.com/ugc/11915702531314439/4DA6A4535A1B02E092638D7BBF581E9C89508832/"
    },
    "9600141": {
      "name": "Zero Tenacity",
      "logo": "https://cdn.steamusercontent.com/ugc/23174701605135839/B5A052B86AE5F123031508603154EAD51013C412/"
    },
    "9600942": {
      "name": "WIN",
      "logo": "https://cdn.steamusercontent.com/ugc/17865131697726500115/975506E7B0B7880653EAD90BAA8067AA8329BA9D/"
    },
    "9609099": {
      "name": "Rakuzan",
      "logo": "https://cdn.steamusercontent.com/ugc/13042871481198423/5F013D18FA3BF8B3AEAB8B9EE8785CAD9CAB80AB/"
    },
    "9628678": {
      "name": "Teiko",
      "logo": "https://cdn.steamusercontent.com/ugc/53576717528430814/3FF228A7F7409318EEC092C18C14AF690A009B35/"
    },
    "9629459": {
      "name": "OTHERS",
      "logo": "https://cdn.steamusercontent.com/ugc/61458643626607155/38A49192383ECC5564818F1B0F16CFF2DB32C8AE/"
    },
    "9634742": {
      "name": "Chimera Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/25429846520505742/8CC6F7D4209315AEB9CC55B5224FE95C6E757D91/"
    },
    "9635124": {
      "name": "M80",
      "logo": "https://cdn.steamusercontent.com/ugc/38941270872180974/66B383DCF84EB57927FCAC7F5CE0B6A70D0EDF23/"
    },
    "9640842": {
      "name": "Team Tidebound",
      "logo": "https://cdn.steamusercontent.com/ugc/12094940740270677482/9AD05F0A80A562EE4A833375BF1783B52B3D4C30/"
    },
    "9646485": {
      "name": "Jigglin",
      "logo": "https://cdn.steamusercontent.com/ugc/10795057523687683/EE9A7F08EEEDE9615FB062476EF11BA3F1ECAFDD/"
    },
    "9651185": {
      "name": "Wildcard",
      "logo": "https://cdn.steamusercontent.com/ugc/14173210407158797/EAFCC9BE14FBFC9DC1EA3D03D62772D38F7DF15F/"
    },
    "9652147": {
      "name": "Looking for Org",
      "logo": "https://cdn.steamusercontent.com/ugc/51327907334606511/D1DE8289313290A02D1289BCC3B9FC69BB2ED23A/"
    },
    "9664371": {
      "name": "gazovatorbl",
      "logo": "https://cdn.steamusercontent.com/ugc/8544435822675099/0B0CCE2F22F4721912B21D9805F015116E57583C/"
    },
    "9664724": {
      "name": "ITB.Shuffle",
      "logo": "https://cdn.steamusercontent.com/ugc/10796235338716618/FD2C48006B2AC387BA7EE670FB12C3DAB5B5D134/"
    },
    "9678064": {
      "name": "Moodeng Warriors",
      "logo": "https://cdn.steamusercontent.com/ugc/32190145604852109/E7EE05A8819599AA60D6901AAED6F99225A0C06B/"
    },
    "9678463": {
      "name": "Estar Backs",
      "logo": "https://cdn.steamusercontent.com/ugc/8546247575522013/0940BE82E218C71369C672C95943445AA450EF45/"
    },
    "9691969": {
      "name": "Team Nemesis",
      "logo": "https://cdn.steamusercontent.com/ugc/16578975333650734744/040492179D9E0E83DA0559848D88CFC17A1EFCAC/"
    },
    "9692104": {
      "name": "Nethercore",
      "logo": "https://cdn.steamusercontent.com/ugc/59213011604269927/79D0D159903371DC20501B6507AA311EF6FAFE86/"
    },
    "9699158": {
      "name": "tearlaments",
      "logo": "https://cdn.steamusercontent.com/ugc/13054916969328839/7663A2A47B72EF63B9ACE9860B377CF97B35D98C/"
    },
    "9716354": {
      "name": "Tech Free Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/37822898901000735/CFE84A5E0E4C4D7ECA12AD6D542B0994E7C52949/"
    },
    "9722892": {
      "name": "Trailer Park Boys",
      "logo": "https://cdn.steamusercontent.com/ugc/38949980569189726/53F2180D4DB13B6E96577D16F952B03E879EC514/"
    },
    "9729720": {
      "name": "Virtus.pro",
      "logo": "https://cdn.steamusercontent.com/ugc/34447015205836647/F5F0B39A1483B26EFFAB587AC05EE23316821BA7/"
    },
    "9729767": {
      "name": "BloodyRose",
      "logo": "https://cdn.steamusercontent.com/ugc/13054458466396118/2A7A8AF97F83D018A54851B82EEEDAB1B10FCA52/"
    },
    "9741253": {
      "name": "Edge",
      "logo": "https://cdn.steamusercontent.com/ugc/17884533737171142983/4906E376E7E8A4CCE82DD5F8899CD80F1742C0EF/"
    },
    "9743822": {
      "name": "Teiko",
      "logo": "https://cdn.steamusercontent.com/ugc/9678485233089315/3FF228A7F7409318EEC092C18C14AF690A009B35/"
    },
    "9744229": {
      "name": "Team Den",
      "logo": "https://cdn.steamusercontent.com/ugc/53588581603583302/D6A337DDB250A20844C6B491666FC23AB7BCF178/"
    },
    "9744330": {
      "name": "Somos Nós a Justiça",
      "logo": "https://cdn.steamusercontent.com/ugc/38951882813950031/E0BC702CE1C18CCE5FB7A0BA7C2B006B21C04444/"
    },
    "9758040": {
      "name": "Runa Team",
      "logo": "https://cdn.steamusercontent.com/ugc/23189918875091243/4CEBD73D73236BCAC62F16D2D432532CC2A5D1F2/"
    },
    "9766941": {
      "name": "FLIPSTER TALON",
      "logo": "https://cdn.steamusercontent.com/ugc/16993496185238442896/AEC83EE01F7ABD5F64CE99CCECC2AD4D9B311221/"
    },
    "9776488": {
      "name": "哈哈先生",
      "logo": "https://cdn.steamusercontent.com/ugc/9666272728095801838/BB4DE2D87891D909F89C1C3D85B3DF11C2E8D8AD/"
    },
    "9780800": {
      "name": "OG.LATAM",
      "logo": "https://cdn.steamusercontent.com/ugc/12741081049248012101/CA83F279CEB5DC52AE9FEC1176AC1E55908EEEFA/"
    },
    "9790546": {
      "name": "TEAM NEXT LEVEL",
      "logo": "https://cdn.steamusercontent.com/ugc/16515489788422095080/B5EA1DD5E2BABC4BC77BD2CF53746A6AC9E8E7C4/"
    },
    "9790570": {
      "name": "nouns",
      "logo": "https://cdn.steamusercontent.com/ugc/13457892568934133845/F6CBB7740BB0290E39B91F28D178CD5F06E314ED/"
    },
    "9791362": {
      "name": "Ramzes team",
      "logo": "https://cdn.steamusercontent.com/ugc/11465459637037115132/1B20766D3AEA45D574BEC36CA59141615D6AA738/"
    },
    "9798195": {
      "name": "Cyber Goose",
      "logo": "https://cdn.steamusercontent.com/ugc/10211157587642124035/8782DBD433A137EAC11039A8B5F60DB1304A971C/"
    },
    "9814008": {
      "name": "eSpoiled",
      "logo": "https://cdn.steamusercontent.com/ugc/12151579140932746225/A9E4132B12671244A194F68779793550B1C8C2E8/"
    },
    "9818882": {
      "name": "Стак который ебет",
      "logo": "https://cdn.steamusercontent.com/ugc/10699594615714697364/4852B932300344890E5AE2F6DB96C5595A7DC76A/"
    },
    "9823272": {
      "name": "Team Yandex",
      "logo": "https://cdn.steamusercontent.com/ugc/17599312477106395083/DEE09659361BE8BDB1438FCFE6BF03C8B62A45F9/"
    },
    "9824497": {
      "name": "Team Yakuza",
      "logo": "https://cdn.steamusercontent.com/ugc/13743177005895078824/A6C4ED6057E5BADC96FE7BE720EC260084C534D0/"
    },
    "9824555": {
      "name": "BULDOZER",
      "logo": "https://cdn.steamusercontent.com/ugc/15211449477990013289/3A113B8FD31E7ADE39168DC04BD745FCBF6413C8/"
    },
    "9824702": {
      "name": "PARIVISION",
      "logo": "https://cdn.steamusercontent.com/ugc/11751543457229798134/1569CC553CB72963C8EC4C3F807EE50DA925BDC2/"
    },
    "9824806": {
      "name": "捕畜小分队",
      "logo": "https://cdn.steamusercontent.com/ugc/10902557672389432209/2921E5F43C08F6EF6C3519221C7C4345A57F3EF7/"
    },
    "9828897": {
      "name": "REKONIX",
      "logo": "https://cdn.steamusercontent.com/ugc/16170413258693955016/5ABDC787F5CF4BBDD603F15933D9F5B0F8EB0D8A/"
    },
    "9828954": {
      "name": "Natus Vincere",
      "logo": "https://cdn.steamusercontent.com/ugc/17821893739361860599/92778ECBA667C1267DC87255A3BE5EA947500B48/"
    },
    "9829468": {
      "name": "100MMR",
      "logo": "https://cdn.steamusercontent.com/ugc/16830255701840613626/E0D867F3B960F835DD41F2A6F9649A206211BC1F/"
    },
    "9849484": {
      "name": "Ягодки",
      "logo": "https://cdn.steamusercontent.com/ugc/10850250871597108332/C96A03F2F068C2B9DDCA2D4B89FF7217E450A11D/"
    },
    "9850048": {
      "name": "CHEFBRAND TEAM",
      "logo": "https://cdn.steamusercontent.com/ugc/15428373715270271338/72DACEC44B750A318B12563DA1895F0E5E3AD3C3/"
    },
    "9850944": {
      "name": "Kalmychata",
      "logo": "https://cdn.steamusercontent.com/ugc/14523818912257802998/398546457D88FDA3C9584EDA3587A5DD0FA1C53C/"
    },
    "9867013": {
      "name": "teamMopsi",
      "logo": "https://cdn.steamusercontent.com/ugc/18002348753105163763/7E0C0CDD8F360FF23F3AB61FEFBB9075DEB5BD1A/"
    },
    "9872667": {
      "name": "Pipsqueak+4",
      "logo": "https://cdn.steamusercontent.com/ugc/14017836316804902173/6D59207DB4CBE46D79B9C5007FCD5802858DB860/"
    },
    "9885130": {
      "name": "Perú Rejects",
      "logo": "https://cdn.steamusercontent.com/ugc/10976329918721107017/77707BDD58E2B2C3C34D66940EF3E3EF1249F0E2/"
    },
    "9885654": {
      "name": "Team Aureus",
      "logo": "https://cdn.steamusercontent.com/ugc/11321842346504571852/C7BE0E4CB4BE1E57E10805C7BFBA48D04410C7DF/"
    },
    "9885667": {
      "name": "Team Tea",
      "logo": "https://cdn.steamusercontent.com/ugc/11961897368046967862/BE4C3E94DE2C35A031F987551D50F666D5EA4861/"
    },
    "9885888": {
      "name": "KUKUYS",
      "logo": "https://cdn.steamusercontent.com/ugc/17855972744792417589/0E04B6D0CD7F52E89E7DBAB4F548EB2B81174E27/"
    },
    "9895247": {
      "name": "Rune Eaters",
      "logo": "https://cdn.steamusercontent.com/ugc/11845515088670662060/69AF28B666A859915784A1FF3C77F23E29057C3F/"
    },
    "9895392": {
      "name": "Virtus.pro",
      "logo": "https://cdn.steamusercontent.com/ugc/13061694558372404982/7AC363D410AC6F2F4B016EE7D73B7C266D0113F9/"
    },
    "9906210": {
      "name": "Teiko",
      "logo": "https://cdn.steamusercontent.com/ugc/18334899831341613336/3FF228A7F7409318EEC092C18C14AF690A009B35/"
    },
    "9928636": {
      "name": "Team Lynx",
      "logo": "https://cdn.steamusercontent.com/ugc/14941196846611701531/643518619FD1EC99DB98FC12C5D8970751E16A2E/"
    },
    "9928746": {
      "name": "Most Wanted",
      "logo": "https://cdn.steamusercontent.com/ugc/13403954137763331956/26CFEAF977C2C23834C050817E1C0BACBF252076/"
    },
    "9948367": {
      "name": "Team Spirit Academy",
      "logo": "https://cdn.steamusercontent.com/ugc/16328404359541313451/267BF3359F3B03492C44331ACB4B9C03BD51C728/"
    },
    "9949210": {
      "name": "loodowolfs",
      "logo": "https://cdn.steamusercontent.com/ugc/11925720862554961540/A5FA1F052E6FF631D6D5736B4BD7AB10E3310446/"
    },
    "9956508": {
      "name": "Team Public",
      "logo": "https://cdn.steamusercontent.com/ugc/15961912086983627080/7DB901E4CB0D8137F5B4EAD820C0E35D695936B1/"
    },
    "9957138": {
      "name": "Stariy_Bog",
      "logo": "https://cdn.steamusercontent.com/ugc/12225242090717606500/99D63DC54E826122839B99733219BF814F6090A3/"
    },
    "9964962": {
      "name": "GamerLegion",
      "logo": "https://cdn.steamusercontent.com/ugc/13245379764580870318/1048428BEFAC87EC1C64E15706A4758A173B5BFB/"
    },
    "9988580": {
      "name": "OwNing ProS DaiLy",
      "logo": "https://cdn.steamusercontent.com/ugc/16257640542192296943/F4402A77656703C67B654F0723DF75B035CAC3F2/"
    },
    "10000352": {
      "name": "Rottweilas",
      "logo": "https://cdn.steamusercontent.com/ugc/17677031272276990522/8FC6527F73D0BD86A4F4939428E5ABD50C35DA9F/"
    },
    "10001885": {
      "name": "No Hoodwink",
      "logo": "https://cdn.steamusercontent.com/ugc/17682418430515637520/6BB6DAD54DB6E42F3B063164BCF2805177626F6E/"
    },
    "10019843": {
      "name": "Inner Circle x Insanity",
      "logo": "https://cdn.steamusercontent.com/ugc/9964979241844276783/64DDB27F8A50FEA6869CFD8392ED29CE674E26C1/"
    },
    "10020555": {
      "name": "PlayTime",
      "logo": "https://cdn.steamusercontent.com/ugc/11668290585730417471/FB22B7ED74C1C73D4E27C0CBBBF47FC194611231/"
    },
    "10040534": {
      "name": "Greyhound Team",
      "logo": "https://cdn.steamusercontent.com/ugc/15110032754519552478/16D13F16B97F4F39FD213A979FF40763AE1CD33F/"
    },
    "10047709": {
      "name": "Ilbirs Esports",
      "logo": "https://cdn.steamusercontent.com/ugc/11722874411743504358/FBD50A7D9F04E42BD59A5108C2D6DD346C2947F8/"
    },
    "10081680": {
      "name": "GLYPH",
      "logo": "https://cdn.steamusercontent.com/ugc/9768354035558377058/44D326A1CD73CFB7F7C5F1BC4CAB1F46696B5E4F/"
    },
    "10088088": {
      "name": "stariy_bog Team",
      "logo": "https://cdn.steamusercontent.com/ugc/12953774144384431651/DCF3BE8C5C50491F1D6158D156C040D30EF4C5FE/"
    },
    "10095351": {
      "name": "BloodyRose",
      "logo": "https://cdn.steamusercontent.com/ugc/16958336780697718794/2A7A8AF97F83D018A54851B82EEEDAB1B10FCA52/"
    },
    "10102110": {
      "name": "Satan666",
      "logo": "https://cdn.steamusercontent.com/ugc/18003854356446470324/60058F0E4C503ADDB1EFDD7F8EE0C57A90E323C7/"
    },
    "10108713": {
      "name": "Breeki Cheeki",
      "logo": "https://cdn.steamusercontent.com/ugc/13046866918722230078/08D74D8C858301E567BA96F1BF5BE1BEE7EEE452/"
    },
    "10129287": {
      "name": "В-Восхитительный",
      "logo": "https://cdn.steamusercontent.com/ugc/14562471430578105836/89EF9672D9A0125524496B31BD542D43CF2B38D2/"
    },
    "10135834": {
      "name": "TEAM GRIND",
      "logo": "https://cdn.steamusercontent.com/ugc/18313019652320109896/09DE0090D6F99C3AF44DA97360CCDAEA1CA7D214/"
    },
    "10136133": {
      "name": "Two Move",
      "logo": "https://cdn.steamusercontent.com/ugc/14832539996629907250/104CC9C96E6BE157DA1A8E63FB26084539394C70/"
    },
    "10136357": {
      "name": "Nigma Galaxy ",
      "logo": "https://cdn.steamusercontent.com/ugc/16959999218725724364/1D334B91A52606CA3E0027832D6F646E2A094391/"
    },
    "10144936": {
      "name": "软柿子人身意外饱险",
      "logo": "https://cdn.steamusercontent.com/ugc/13747572253287912032/634BB7C2CACDB9BCA0EC28C8B1F7E204DBE0D33D/"
    },
    "10150413": {
      "name": "Iron Wing",
      "logo": "https://cdn.steamusercontent.com/ugc/16903873521422862552/02513782FE03E7A567B8B8955A0DEF415EF2B624/"
    },
    "10150538": {
      "name": "LGD Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/10055782735581672481/2B2BCEA9CC05286D7164E4548A2EB64CDBC77F31/"
    },
    "10150633": {
      "name": "Pipsqueak + 4",
      "logo": "https://cdn.steamusercontent.com/ugc/17452646076455003343/946D2A15CF8DA1FE5108BF2765BB13E245EDE12B/"
    },
    "10151159": {
      "name": "法式可颂蛋挞",
      "logo": "https://cdn.steamusercontent.com/ugc/13427238561767500350/AB89CBE160BEE755DFD5A363ACFCB8565E5CD14D/"
    },
    "10182357": {
      "name": "1win",
      "logo": "https://cdn.steamusercontent.com/ugc/10678669599334676082/E48827F4A163D4D02F817EA3C32166D5F1D5FC98/"
    },
    "10207447": {
      "name": "Team Nyx",
      "logo": "https://cdn.steamusercontent.com/ugc/15162489985342115020/CD78CAE3D3734D759D3B31CD532BC4E785CB8A86/"
    },
    "10207983": {
      "name": "PlayTime",
      "logo": "https://cdn.steamusercontent.com/ugc/17426031919353601412/893C6B533277C656AE6AB52400741210FE02BE2B/"
    },
    "10208002": {
      "name": "enjoy",
      "logo": "https://cdn.steamusercontent.com/ugc/14853999698200910340/A06003B293C3253EB08A326DC10F1143B6EA329D/"
    },
    "10208003": {
      "name": "GLYPH",
      "logo": "https://cdn.steamusercontent.com/ugc/11904057103673109679/2B3E5608943A5FCFDC06EF078FC4D27FF6491594/"
    },
    "10208008": {
      "name": "REKONIX",
      "logo": "https://cdn.steamusercontent.com/ugc/18172792556440584529/193D31B47CB212A39E2019C47EECA6C16B816CF0/"
    },
    "10208009": {
      "name": "L1GA TEAM",
      "logo": "https://cdn.steamusercontent.com/ugc/14013542982075737694/2D4DE8E5EDEB269953A5F15C731921880FD4E40B/"
    },
    "10208034": {
      "name": "Yakult Brothers",
      "logo": "https://cdn.steamusercontent.com/ugc/15492302862354302144/FF5876487841A44C7295E087CB2CA163006153AE/"
    },
    "10208035": {
      "name": "Zero Tenacity",
      "logo": "https://cdn.steamusercontent.com/ugc/17452795849510339808/BBC7BB6313DA2D1CF99B31B1192000ABB0E7561B/"
    },
    "10208068": {
      "name": "LGD.Pinghu",
      "logo": "https://cdn.steamusercontent.com/ugc/10786613720313814438/F6F1383DC3789553E04AFBA9F97FFDAAAF782CA9/"
    },
    "10208071": {
      "name": "Xtreme Gaming",
      "logo": "https://cdn.steamusercontent.com/ugc/14732624076421982913/6B18884BC5143A2E3E244A4BFC4D9A33C9203953/"
    },
    "10212329": {
      "name": "Team Synapse",
      "logo": "https://cdn.steamusercontent.com/ugc/14176785811446421230/E9FC96999431CDA69AD21FB9FF85FC022E8338BB/"
    },
    "10225542": {
      "name": "DYNASTY",
      "logo": "https://cdn.steamusercontent.com/ugc/15807281118408886740/E8A2A2FE91ACA2C26C900CBE2B5EA874773E1E33/"
    },
    "10225911": {
      "name": "Summer Bear",
      "logo": "https://cdn.steamusercontent.com/ugc/12505334792145161652/9D91802F4FFF1ED1E787558E090E76B7A1B2A596/"
    },
    "10232231": {
      "name": "Klim Sani4",
      "logo": "https://cdn.steamusercontent.com/ugc/17154379317387244703/A3F526268CFCE8F90DC4AC49D48D69ACE33ACEB5/"
    },
    "10232560": {
      "name": "Ice Cream Men",
      "logo": "https://cdn.steamusercontent.com/ugc/11814691842312543047/356DFAC899B1D0DD640CBD8E19E60FF41758917E/"
    },
    "10232572": {
      "name": "Team Kinetix",
      "logo": "https://cdn.steamusercontent.com/ugc/16524648740909764969/8BCDBC95ABC19C5062633F0B5521FFD02BA7B0B2/"
    },
    "10233024": {
      "name": "Team 6seven",
      "logo": "https://cdn.steamusercontent.com/ugc/18154642787197887986/C3A5811E13969747C54423D726254730C3B4BD6D/"
    },
    "10233067": {
      "name": "4ikibamboni",
      "logo": "https://cdn.steamusercontent.com/ugc/16243749796277544889/8E5F0BD0899BF5814D1539AFF11AEBC8A6C7A2FE/"
    },
    "10240261": {
      "name": "Rostikfacekid Club",
      "logo": "https://cdn.steamusercontent.com/ugc/9993881737239555307/007410481AA1016ECAA50351FE71AEC926A8CC5E/"
    },
    "10241682": {
      "name": "NS Club",
      "logo": "https://cdn.steamusercontent.com/ugc/14495280194177138791/20F509D6BB772F8613D0836D6456E75B016C3B41/"
    },
    "10241688": {
      "name": "YBN Club",
      "logo": "https://cdn.steamusercontent.com/ugc/13247806896278348326/4EFD2261FD65B94E10CCF722B906DE4B9EB49BB0/"
    },
    "10241694": {
      "name": "Stray Club",
      "logo": "https://cdn.steamusercontent.com/ugc/15988314095870492355/4D1D35ED846FA4CB396B442A921E095636CD4254/"
    },
    "10241728": {
      "name": "VooDooSh Club",
      "logo": "https://cdn.steamusercontent.com/ugc/10002479797676202919/23282391FE65E79F992B35BB331812065754B6CA/"
    },
    "10241769": {
      "name": "Daxak Club",
      "logo": "https://cdn.steamusercontent.com/ugc/12032584383209767854/509CC6A9B2DD90940431A9FAD5094B7CD007AF50/"
    },
    "10241776": {
      "name": "Recrent Club",
      "logo": "https://cdn.steamusercontent.com/ugc/14600983343195536527/555A99A787F4022A9B46043B53EEE7EB315DDBF0/"
    },
    "10241804": {
      "name": "Cooman Club",
      "logo": "https://cdn.steamusercontent.com/ugc/14416228886044945821/448B8448EF03CEF03D1FC942CF96C5A503BE4529/"
    }
  },
  "byName": {
    "123": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2512249.png"
    },
    "496": {
      "logo": "https://cdn.steamusercontent.com/ugc/947347005705942313/366DDC9ACA9760D099E84685DE88D72E9BA65F3E/"
    },
    "complexitygaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3.png"
    },
    "complexity": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3.png"
    },
    "ehome": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/4.png"
    },
    "invictusgaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5.png"
    },
    "invictus": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5.png"
    },
    "dk": {
      "logo": "https://cdn.steamusercontent.com/ugc/782994610325576235/08CF233C343B8550B71199B07A86FCB3E7D01F89/"
    },
    "lgdgaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/15.png"
    },
    "lgd": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/15.png"
    },
    "newbeemgb": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/20.png"
    },
    "natusvincere": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/36.png"
    },
    "shopifyrebellion": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/39.png"
    },
    "4friendschrillee": {
      "logo": "https://cdn.steamusercontent.com/ugc/706274505311787193/24FA17D5019799AF118AEB4469DDB76D69A66F63/"
    },
    "teamempire": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/46.png"
    },
    "powerrangers": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/55.png"
    },
    "paingaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/67.png"
    },
    "pain": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/67.png"
    },
    "scenario": {
      "logo": "https://cdn.steamusercontent.com/ugc/1832407370390600391/4B8EDF6460D5D3210412F6CFC2CBE3764DE863C1/"
    },
    "teamliquid": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2163.png"
    },
    "alliance": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/111474.png"
    },
    "iccupteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/576743332782064613/4D8326823462288234562F8D1B8B1C0C4265BA6C/"
    },
    "iccup": {
      "logo": "https://cdn.steamusercontent.com/ugc/576743332782064613/4D8326823462288234562F8D1B8B1C0C4265BA6C/"
    },
    "mouz": {
      "logo": "https://cdn.steamusercontent.com/ugc/14936784213521439739/3EA33A8516BDE538B7963F044CD1B7AB4B0BB60D/"
    },
    "radicalonlinextremists": {
      "logo": "https://cdn.steamusercontent.com/ugc/921253447668725714/13C7456AA325AD7AC03DC7D117483E8DBDAD5486/"
    },
    "globalchallengers": {
      "logo": "https://cdn.steamusercontent.com/ugc/576773266863066111/775914064EA60990D8479A6DCAA87B45FD4EEDD4/"
    },
    "ascentesports": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/350190.png"
    },
    "ascent": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/350190.png"
    },
    "revenge": {
      "logo": "https://cdn.steamusercontent.com/ugc/667955139964290556/60E1A70BA46FA523F5217A48F5A0C9588606137E/"
    },
    "orangeneolutionesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/612760050488516720/DF0EE7F44746239DBA83B8F4537758ECBB51655E/"
    },
    "orangeneolution": {
      "logo": "https://cdn.steamusercontent.com/ugc/612760050488516720/DF0EE7F44746239DBA83B8F4537758ECBB51655E/"
    },
    "ec": {
      "logo": "https://cdn.steamusercontent.com/ugc/882977285055841873/5029916D0E6C0E527029054143275A02693375F3/"
    },
    "hypergloryteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/3281181583551777655/6AE767838540BC3CE1624B4D87E0E257DD1927AC/"
    },
    "hyperglory": {
      "logo": "https://cdn.steamusercontent.com/ugc/3281181583551777655/6AE767838540BC3CE1624B4D87E0E257DD1927AC/"
    },
    "life": {
      "logo": "https://cdn.steamusercontent.com/ugc/903254994325386629/98F3E4A7B2DECCF94FE06DE33EA12049295BBCC5/"
    },
    "fxopenesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/595873628477068295/F40490019313A0FC878D6555EAFCC068F975169F/"
    },
    "fxopen": {
      "logo": "https://cdn.steamusercontent.com/ugc/595873628477068295/F40490019313A0FC878D6555EAFCC068F975169F/"
    },
    "newguys": {
      "logo": "https://cdn.steamusercontent.com/ugc/527291846450105057/CF0F2BAC9CC10F3F4E4F77990F36EF7877F74C88/"
    },
    "mineski": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/543897.png"
    },
    "quanticgaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/1117170899589104466/11989B210556A85FCA671890780B2D0C8BC467A4/"
    },
    "quantic": {
      "logo": "https://cdn.steamusercontent.com/ugc/1117170899589104466/11989B210556A85FCA671890780B2D0C8BC467A4/"
    },
    "theprimesiapa": {
      "logo": "https://cdn.steamusercontent.com/ugc/450671039877684086/E98078DB3227F4E176CC558F846C59F00FB0834B/"
    },
    "vicigaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/726228.png"
    },
    "vici": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/726228.png"
    },
    "dotagodslayers": {
      "logo": "https://cdn.steamusercontent.com/ugc/594755788951591763/CAE83CF5B82E3EE966C4F77DA3B21A5A3C3CF571/"
    },
    "fatalragenotpro": {
      "logo": "https://cdn.steamusercontent.com/ugc/536264712569251126/5CB2DDCD322E71F1EA83F7151B410937A1DFAE58/"
    },
    "stayfree": {
      "logo": "https://cdn.steamusercontent.com/ugc/577877533500375019/29F54460D6D8FB68424000E23A7C92D7D2F2BA9C/"
    },
    "superstrongdinosaurs": {
      "logo": "https://cdn.steamusercontent.com/ugc/884119748687027366/4E5F67CD1B80D2886939D737E906451741305ABD/"
    },
    "titan": {
      "logo": "https://cdn.steamusercontent.com/ugc/612798094497099775/B31FD08745284986F02B3FE04021574F964D9FA1/"
    },
    "vivokeydstars": {
      "logo": "https://cdn.steamusercontent.com/ugc/5095292505104094637/268CD3E0F09AF23BB67C536D74056E8D8C1488E9/"
    },
    "sigmaint": {
      "logo": "https://cdn.steamusercontent.com/ugc/1047377791103893273/2F86EB8DE06754907CD316B5DD5D4BE9FC8B1F8A/"
    },
    "oslikigaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/594766568879356896/536D5835599DC8A99ABF3D224D6D2B894905E9EB/"
    },
    "osliki": {
      "logo": "https://cdn.steamusercontent.com/ugc/594766568879356896/536D5835599DC8A99ABF3D224D6D2B894905E9EB/"
    },
    "mvpphoenix": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1148284.png"
    },
    "dwaynethejohnrockson": {
      "logo": "https://cdn.steamusercontent.com/ugc/685968273337811268/E090D4C9B497CA496D7E32D4F59BA36DD4C846D1/"
    },
    "felmyst": {
      "logo": "https://cdn.steamusercontent.com/ugc/847088009729950752/DF0CEFAD8DC30804594D5925A8DA9BC73F182CD3/"
    },
    "xpcinternational": {
      "logo": "https://cdn.steamusercontent.com/ugc/50986085993332472/2733A94CBA92F8D2B87DA608536E2E86ECE91D30/"
    },
    "zerolatitude": {
      "logo": "https://cdn.steamusercontent.com/ugc/430448599226110019/41D8B7F02B76DD15E16D40E9C1CC8736D4867E06/"
    },
    "scythesg": {
      "logo": "https://cdn.steamusercontent.com/ugc/469812062884140883/C9EDFEDE46BCAC0F1C16A5A3196D6947654FE664/"
    },
    "raven": {
      "logo": "https://cdn.steamusercontent.com/ugc/563268090328234257/8D1D3A5938BFA5D146DC1D26BD2C631C4C23979A/"
    },
    "xpcgg": {
      "logo": "https://cdn.steamusercontent.com/ugc/81379587710631266/2733A94CBA92F8D2B87DA608536E2E86ECE91D30/"
    },
    "rave": {
      "logo": "https://cdn.steamusercontent.com/ugc/357274177493063612/C6646260536702EC11BE924D3CB2D8C696280BC4/"
    },
    "blacksheep": {
      "logo": "https://cdn.steamusercontent.com/ugc/781877465259101475/2A74AC75A9249433C8329D9C8BD869678853E7C2/"
    },
    "doggyteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/3280049265377219538/69DDD415F33497854C4EA35A2A96E817E88C0F74/"
    },
    "doggy": {
      "logo": "https://cdn.steamusercontent.com/ugc/3280049265377219538/69DDD415F33497854C4EA35A2A96E817E88C0F74/"
    },
    "awaregaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/794063002581119172/C1F4467BD1C24C7E8B72343394F92394C88CFC2A/"
    },
    "aware": {
      "logo": "https://cdn.steamusercontent.com/ugc/794063002581119172/C1F4467BD1C24C7E8B72343394F92394C88CFC2A/"
    },
    "newbee": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/6214538.png"
    },
    "teamcoast": {
      "logo": "https://cdn.steamusercontent.com/ugc/777181466527196630/3206CD32FB9D14B0106F4742AAC23FA7B3C699B3/"
    },
    "sneakynyxassassins": {
      "logo": "https://cdn.steamusercontent.com/ugc/3281180234046031347/2975FFC5B5EB653F5165D7D4E8698C30CEE8AF07/"
    },
    "asperaesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/35247586654199397/AA75FD3C7D0AD1399A0F03CAE53CD33AC7CE7C45/"
    },
    "aspera": {
      "logo": "https://cdn.steamusercontent.com/ugc/35247586654199397/AA75FD3C7D0AD1399A0F03CAE53CD33AC7CE7C45/"
    },
    "northamericanrejects": {
      "logo": "https://cdn.steamusercontent.com/ugc/598160756144927455/E850C4122F42BB762134853C301E4085A1580B19/"
    },
    "spnvinspirereturn": {
      "logo": "https://cdn.steamusercontent.com/ugc/3281181583533490678/16F77ED8634829BA95FC93A20EBABC8BF1D45E8E/"
    },
    "aftershockgamingint": {
      "logo": "https://cdn.steamusercontent.com/ugc/776056112971508921/DF725FB62C1B052CE52381747AE7C296A65A4051/"
    },
    "balkanbearscorleone": {
      "logo": "https://cdn.steamusercontent.com/ugc/469811338474849833/18C0455ADE4BFF5B9BF55482E74FF6835CB59137/"
    },
    "flipsid3tacticsna": {
      "logo": "https://cdn.steamusercontent.com/ugc/3280058230258270260/4590F3188910F526B331212FC1EB687AC7795DBF/"
    },
    "natusvincereus": {
      "logo": "https://cdn.steamusercontent.com/ugc/487827175124862465/3ABE239EE4A96C9FEB2EFC2AB79E3E74C622049B/"
    },
    "imbagamingvietnam": {
      "logo": "https://cdn.steamusercontent.com/ugc/3318339547271934415/E66AF3E340F2A43E62A7A3F0FE7F7F8FA64E7729/"
    },
    "rootgamingcom": {
      "logo": "https://cdn.steamusercontent.com/ugc/45376357722113646/9F0CCE296749E194BC9DA17079FADD18D3DE8B54/"
    },
    "tamptaxon": {
      "logo": "https://cdn.steamusercontent.com/ugc/81379587682633657/52635B11E4D4D8B054EA9E3CDEE99060B7815ADC/"
    },
    "elysium": {
      "logo": "https://cdn.steamusercontent.com/ugc/36344320175287789/DDFB6E1470DA93C229692159BB47E733333FD8F4/"
    },
    "duzagaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/40848547394192181/FD528DB506FECBE5732923D697D7139C8EE4EF0F/"
    },
    "duza": {
      "logo": "https://cdn.steamusercontent.com/ugc/40848547394192181/FD528DB506FECBE5732923D697D7139C8EE4EF0F/"
    },
    "battlezone": {
      "logo": "https://cdn.steamusercontent.com/ugc/528385406419881229/5C6A83090C1C1EFD3818475F1A834DB28D1669FD/"
    },
    "namvezetmiigraem": {
      "logo": "https://cdn.steamusercontent.com/ugc/575652270942579148/9B38BEC3BEDEE0E300138929E3C802FA9F5ACDCB/"
    },
    "sandblut": {
      "logo": "https://cdn.steamusercontent.com/ugc/415811900445613110/E015598EAAFDA00873521A80E6C803ED41413D4F/"
    },
    "thewingsgaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1836806.png"
    },
    "thewings": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1836806.png"
    },
    "teamsecret": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1838315.png"
    },
    "hellraisers": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1846548.png"
    },
    "laigaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/28466819225810269/A0495348313DA709ACE717D1D4BDFA10FF0F715B/"
    },
    "lai": {
      "logo": "https://cdn.steamusercontent.com/ugc/28466819225810269/A0495348313DA709ACE717D1D4BDFA10FF0F715B/"
    },
    "tot": {
      "logo": "https://cdn.steamusercontent.com/ugc/44230686471780820/581805D8E5EE6AE00B9E0928F2C77CA3352A5309/"
    },
    "virtuspro": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/1883502.png"
    },
    "wegotlategame": {
      "logo": "https://cdn.steamusercontent.com/ugc/711906452532416050/7520B76E54F550FB1662EE3772C9D020E00D6D40/"
    },
    "lajons": {
      "logo": "https://cdn.steamusercontent.com/ugc/541884168947857532/A265E0462753D3981E33961066F897E7C1E6AFDC/"
    },
    "vegasquadron": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2006913.png"
    },
    "flipsid3tactics": {
      "logo": "https://cdn.steamusercontent.com/ugc/541894212124519280/8F137BA3271FF11A49371D890C2EE6C32C7EF478/"
    },
    "glorypushmid": {
      "logo": "https://cdn.steamusercontent.com/ugc/619592022572057702/B59B8ED89608D77F1EB9BC7DF776C096271B69B7/"
    },
    "biggooooood": {
      "logo": "https://cdn.steamusercontent.com/ugc/53249782181410639/A754634D7F2CA2B33322789ED2EBB953DADEEDA5/"
    },
    "ladottasstacks": {
      "logo": "https://cdn.steamusercontent.com/ugc/546393011940036650/5069EEDFD9C2D36183875F9561FB3EBFF3419372/"
    },
    "tncpredator": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2108395.png"
    },
    "ebolaesportsunited": {
      "logo": "https://cdn.steamusercontent.com/ugc/541889954015774548/A4F3945E6E9923DCF69CF5DFBAF3048137998217/"
    },
    "theshinigamis": {
      "logo": "https://cdn.steamusercontent.com/ugc/1930373852687939015/A74BC19ABB1EC83C095E1DFF3429285D6B0B48AE/"
    },
    "burdenunited": {
      "logo": "https://cdn.steamusercontent.com/ugc/710779919460996890/3B9ECD7E13630C51701750EC47D1495542E76BD0/"
    },
    "gguardesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/708527825009376675/5069EEDFD9C2D36183875F9561FB3EBFF3419372/"
    },
    "gguard": {
      "logo": "https://cdn.steamusercontent.com/ugc/708527825009376675/5069EEDFD9C2D36183875F9561FB3EBFF3419372/"
    },
    "teamarchon": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2244697.png"
    },
    "lincenciados": {
      "logo": "https://cdn.steamusercontent.com/ugc/706277591696898479/1DC20898B5DFB8F33CE410C47D93E5C245EC0BFF/"
    },
    "legiovictrix": {
      "logo": "https://cdn.steamusercontent.com/ugc/543026540283900928/5F8FF9047351094BF1B55A0BC52AB1C9A21B8CB0/"
    },
    "todoporelpod": {
      "logo": "https://cdn.steamusercontent.com/ugc/27366089383599831/DC075E25714DB82AF324FE4732B46790EA459663/"
    },
    "teamovp": {
      "logo": "https://cdn.steamusercontent.com/ugc/439450841570226042/44C52CC76E72908CE95D250488E4CDF934943EB5/"
    },
    "kanaya": {
      "logo": "https://cdn.steamusercontent.com/ugc/532895345481654582/6B0AF87CC0A6D793BD6C81080F14AC5801078549/"
    },
    "artykdota": {
      "logo": "https://cdn.steamusercontent.com/ugc/428193628077963983/E79C23C12B93B7A4E0755E88C75B58CC190B805D/"
    },
    "artyk": {
      "logo": "https://cdn.steamusercontent.com/ugc/428193628077963983/E79C23C12B93B7A4E0755E88C75B58CC190B805D/"
    },
    "teamsatuduatiga": {
      "logo": "https://cdn.steamusercontent.com/ugc/525015750980111983/A97F313C0F62B158F0B5A4969EA1E1E15E5A8608/"
    },
    "monkeybusiness": {
      "logo": "https://cdn.steamusercontent.com/ugc/383162071968605685/B670804CDB13F184D122ACBB8F75E2DB2C959CAF/"
    },
    "5jungz": {
      "logo": "https://cdn.steamusercontent.com/ugc/620723145147160586/09F1EF05604FC45B22E2B5986715441FB8FCA786/"
    },
    "elementsprogaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2537636.png"
    },
    "elementspro": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2537636.png"
    },
    "ftdcluba": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2552118.png"
    },
    "prodotagaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2552670.png"
    },
    "prodota": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2552670.png"
    },
    "yellowsubmarine": {
      "logo": "https://cdn.steamusercontent.com/ugc/2506900380361558769/01D7A1FC1156B0550B4EF9EA2A3A2AF84D9BF884/"
    },
    "execration": {
      "logo": "https://cdn.steamusercontent.com/ugc/2490004871924581269/9132E5E0903B2A368A00780415D69766292F5893/"
    },
    "eeriness": {
      "logo": "https://cdn.steamusercontent.com/ugc/404556234640411761/4758656C1505E4B00FFACA5DF3C027F0D7D2AD5B/"
    },
    "og": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2586976.png"
    },
    "teamspirit": {
      "logo": "https://cdn.steamusercontent.com/ugc/1839179120711951766/CD7E0885CB527334205CC7885E9C101B7BC17702/"
    },
    "keengaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2626685.png"
    },
    "keen": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2626685.png"
    },
    "cdecy": {
      "logo": "https://cdn.steamusercontent.com/ugc/266100190168033440/3164343438ECC6AB8E76D0B59349F00CC4034296/"
    },
    "teamadfinem": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2642171.png"
    },
    "wgunity": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2659468.png"
    },
    "nopingesports": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2672298.png"
    },
    "noping": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2672298.png"
    },
    "aggressive5": {
      "logo": "https://cdn.steamusercontent.com/ugc/395581850125148530/0A70A5AE02043F47BBF2DF70FDD698F3602D39B8/"
    },
    "gstar": {
      "logo": "https://cdn.steamusercontent.com/ugc/455236803146988180/37D5285DC80FFBEDF84FD0347ADE2E89A4E29731/"
    },
    "eaglesgigabyte": {
      "logo": "https://cdn.steamusercontent.com/ugc/293105300895055647/333101B42C1C0139ED4B1ABB61B8EB46375F30E9/"
    },
    "escapegaming": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2783913.png"
    },
    "escape": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/2783913.png"
    },
    "corgiinateam": {
      "logo": "https://cdn.steamusercontent.com/ugc/263835861937179495/E6621DE29134BF92F72B44B595805C2CF6638514/"
    },
    "corgiina": {
      "logo": "https://cdn.steamusercontent.com/ugc/263835861937179495/E6621DE29134BF92F72B44B595805C2CF6638514/"
    },
    "polaritydota2": {
      "logo": "https://cdn.steamusercontent.com/ugc/290853501095454898/DEF7A669784898DFDAC5B3C92816FEC8D1DA4785/"
    },
    "kanayagaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/503650574692020062/A51B7CDF5125D08A16C8DE146AE719DED7DB2B56/"
    },
    "kingarthur4knights": {
      "logo": "https://cdn.steamusercontent.com/ugc/495771811048481437/6125C45CE89495253E3C9754BEDA759E905E811C/"
    },
    "teamftda": {
      "logo": "https://cdn.steamusercontent.com/ugc/486768327515596173/7FDAF1D8570042B99D93B16A4901E3719B995B9B/"
    },
    "losmagikarps": {
      "logo": "https://cdn.steamusercontent.com/ugc/14788690063483691968/4E01289F653136381D26DD438919DE90E1D3CF13/"
    },
    "hippomaniacs": {
      "logo": "https://cdn.steamusercontent.com/ugc/258219525689344926/9A31EAD78B68629E8971934753D4B67D8998B0F3/"
    },
    "teamnp": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3214108.png"
    },
    "emitlortnocboss": {
      "logo": "https://cdn.steamusercontent.com/ugc/12869046455244693361/EFBB218980A0A6E6A2F818D3E10C5883CFE2FB6C/"
    },
    "teamhighground": {
      "logo": "https://cdn.steamusercontent.com/ugc/860608186751615683/A98EFE34990C8B66694B0F23FC22E3A6E0F60A70/"
    },
    "teamevos": {
      "logo": "https://cdn.steamusercontent.com/ugc/2422250350099907755/E3DD3ED79F8C0BE88B7C8D1F5703D6CEF472CF64/"
    },
    "theprime": {
      "logo": "https://cdn.steamusercontent.com/ugc/102856003013929772/A99712F64C2CFD260935B08F37882617C9B00A3D/"
    },
    "levelup": {
      "logo": "https://cdn.steamusercontent.com/ugc/11124972020884745329/AB3238A17EE9950F7532A26B1EAAFCF2086FB37A/"
    },
    "natural9": {
      "logo": "https://cdn.steamusercontent.com/ugc/437235714274666198/2EEED3186A9F34FE3798107001498618882EC97B/"
    },
    "teamvgj": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3326126.png"
    },
    "horde": {
      "logo": "https://cdn.steamusercontent.com/ugc/253716559970590297/28D42322E370E42F0A371025990F4633C4909FDD/"
    },
    "faceless": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3326875.png"
    },
    "ravedota": {
      "logo": "https://cdn.steamusercontent.com/ugc/263847302287787775/C6646260536702EC11BE924D3CB2D8C696280BC4/"
    },
    "lgdforeveryoung": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3331948.png"
    },
    "sgesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/954096064657238608/8350343478E4CCB078B7314E8BF26CAE53A718CB/"
    },
    "sg": {
      "logo": "https://cdn.steamusercontent.com/ugc/954096064657238608/8350343478E4CCB078B7314E8BF26CAE53A718CB/"
    },
    "geekfam": {
      "logo": "https://cdn.steamusercontent.com/ugc/2011450519782421256/C72214A86E6C450DA8CF1A18AE9539B5CAEE7D45/"
    },
    "sgesportsteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/936063882399484485/4DD8B4901982E1821341B595BCF90FCC721F0291/"
    },
    "mvprevolution": {
      "logo": "https://cdn.steamusercontent.com/ugc/102854064380052763/02FF74433AAD5CA57A7EE134380640F7B0614C09/"
    },
    "bears": {
      "logo": "https://cdn.steamusercontent.com/ugc/101728066962847284/B07F6E7D1D4ECCDA3AEB4985A222F839C42E1CBE/"
    },
    "teamonyx": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/3722973.png"
    },
    "happyfeet": {
      "logo": "https://cdn.steamusercontent.com/ugc/936057564715719132/D928A9DBA926069E387444C29127C90767A14E0F/"
    },
    "notricks": {
      "logo": "https://cdn.steamusercontent.com/ugc/97226460691182956/FE3596BFFDF73974EB8A0ED234EBB6BDD37BACEA/"
    },
    "boomid": {
      "logo": "https://cdn.steamusercontent.com/ugc/763846429146901501/E85EF58254E8BA84ED8A085512ECA0A6499499FE/"
    },
    "nologicgaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/170412021737626541/FBC216786BB78D03C74E3576F8AB672CC65128E7/"
    },
    "nologic": {
      "logo": "https://cdn.steamusercontent.com/ugc/170412021737626541/FBC216786BB78D03C74E3576F8AB672CC65128E7/"
    },
    "thunderawaken": {
      "logo": "https://cdn.steamusercontent.com/ugc/2295213908349975977/C88F0F701B1B451F4275464AEC073DF0C4288FBA/"
    },
    "parientegaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/88223956350603792/FCC2C8AE4B3696CC949AD5E71C887C06B6411AAE/"
    },
    "pariente": {
      "logo": "https://cdn.steamusercontent.com/ugc/88223956350603792/FCC2C8AE4B3696CC949AD5E71C887C06B6411AAE/"
    },
    "15aitoz": {
      "logo": "https://cdn.steamusercontent.com/ugc/170415821555291716/81F6FD809ED0ED5D2383F0F8AFCBFE21ED58654B/"
    },
    "teamsingularity": {
      "logo": "https://cdn.steamusercontent.com/ugc/809929916643509535/322F82A5A63214DE068DF2FCBC2A5ADC1FDDF6C7/"
    },
    "w33haearthspirit": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/4251435.png"
    },
    "veteran": {
      "logo": "https://cdn.steamusercontent.com/ugc/859487850036661871/E651E7B7C63BFD1E1561EF68137B35ADCAEDB52E/"
    },
    "rockyoung": {
      "logo": "https://cdn.steamusercontent.com/ugc/924796104665763830/965117DF684B6E3801028E33DF02B8528A18E752/"
    },
    "teamfreedom": {
      "logo": "https://cdn.steamusercontent.com/ugc/788539568429905171/E19817F8B3BFA2F8CDB6F6694F9E024391E82CA0/"
    },
    "xxx": {
      "logo": "https://cdn.steamusercontent.com/ugc/842585341023837640/349CE23F40FBA351CE9A5BC4A4388CFFF6B0D30B/"
    },
    "496gaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/947347005705942313/366DDC9ACA9760D099E84685DE88D72E9BA65F3E/"
    },
    "dametusmoneditas": {
      "logo": "https://cdn.steamusercontent.com/ugc/866233156519569288/ED7AE93582035B4C0858E4801699170A4EA695A5/"
    },
    "greedygoblins": {
      "logo": "https://cdn.steamusercontent.com/ugc/880874231533664522/D67219502B11783CB04FD68567D5661D3B6C4BDE/"
    },
    "coloss": {
      "logo": "https://cdn.steamusercontent.com/ugc/823439759927075414/3E1D37F1E241AC90B3631DDBCD015531E76CD290/"
    },
    "nemigagaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/1761446291384253796/DDD9E9CE3AC50467578944F685C4BD84ED0285B7/"
    },
    "nemiga": {
      "logo": "https://cdn.steamusercontent.com/ugc/1761446291384253796/DDD9E9CE3AC50467578944F685C4BD84ED0285B7/"
    },
    "teamresilience": {
      "logo": "https://cdn.steamusercontent.com/ugc/14326265454983833183/734A1D8A0938380A48221CDAE1AACB0C5C0AB585/"
    },
    "vgjthunder": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5027210.png"
    },
    "sacred": {
      "logo": "https://cdn.steamusercontent.com/ugc/861740565655434597/B36208DF4685C3B87FFC3834F572B2AD5251300C/"
    },
    "vgjstorm": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5028104.png"
    },
    "2bedota2": {
      "logo": "https://cdn.steamusercontent.com/ugc/806619761216522702/A5258FF4D3BD72F19FE436B158B3867B067A7675/"
    },
    "immortals": {
      "logo": "https://cdn.steamusercontent.com/ugc/872993216721628296/3840921B905A5B28840C85C6449D1447073A16E5/"
    },
    "gorillazpride": {
      "logo": "https://cdn.steamusercontent.com/ugc/934927864604413601/D9FF391286B256016F320077FC6B4BEC594FF774/"
    },
    "thefinaltribe": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5059375.png"
    },
    "infamous": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5065748.png"
    },
    "teamserenity": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5066616.png"
    },
    "rogtitans": {
      "logo": "https://cdn.steamusercontent.com/ugc/868494063065916993/C67CC3764B12B5007D87434BC78A0AFB8DEEDB6E/"
    },
    "newbeginning": {
      "logo": "https://cdn.steamusercontent.com/ugc/876372572835722155/862770450D4DFF3DBA4A58F2E16B8D15187E1DB3/"
    },
    "signify": {
      "logo": "https://cdn.steamusercontent.com/ugc/832512818113241705/529626C109FCA595D47A5F04C85A76106DA43E6A/"
    },
    "hidenpool": {
      "logo": "https://cdn.steamusercontent.com/ugc/884259198341578366/8C4CC9EDB4D83BD1BA75C279976E493D2923C6ED/"
    },
    "boths": {
      "logo": "https://cdn.steamusercontent.com/ugc/18181422250618603138/E2EDBD5B7AADCE7CE6581989EBE1526F6F203B55/"
    },
    "teamever": {
      "logo": "https://cdn.steamusercontent.com/ugc/933809026564423087/AB49AACE4D8BCA695854C0B446280EB37F688939/"
    },
    "winstrike": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/5229127.png"
    },
    "rexregumqeon": {
      "logo": "https://cdn.steamusercontent.com/ugc/950713289644008496/3B620C9D2CAD1E0FB7EAC4E3D6ACB4C56EC3DAC7/"
    },
    "teamrussia": {
      "logo": "https://cdn.steamusercontent.com/ugc/938311266632528679/C8EF88E55A960C565ED9D0DC24B404B8E43BC1B8/"
    },
    "thunderpredator": {
      "logo": "https://cdn.steamusercontent.com/ugc/2435761146288261002/649A68D573638596F9BE0C50160489B351E10CEC/"
    },
    "tnctigers": {
      "logo": "https://cdn.steamusercontent.com/ugc/923681543827846572/0F5B3F843B4BFFCE3540CEF8268FC47871AE22DA/"
    },
    "yoshimotodetonator": {
      "logo": "https://cdn.steamusercontent.com/ugc/921424381009057600/F846ED54123BCE31A1DF03A33879A51CA83E3FF6/"
    },
    "espada": {
      "logo": "https://cdn.steamusercontent.com/ugc/934940542897416439/991754B3053FC38BC803E67A33A663F0F765D9B1/"
    },
    "windandrain": {
      "logo": "https://cdn.steamusercontent.com/ugc/920302854103492567/67C768AB9721910BE9F29ACF0C8DC6B648B07BC3/"
    },
    "teamxolotl": {
      "logo": "https://cdn.steamusercontent.com/ugc/1002520539781239647/4F9428FED9E4850EAF98DC274EC8FC576C9C9595/"
    },
    "ksy": {
      "logo": "https://cdn.steamusercontent.com/ugc/946212227068317138/91018AD5A7CBEDE3965DE6EAD434B0BF894D1D9B/"
    },
    "teamorca": {
      "logo": "https://cdn.steamusercontent.com/ugc/947336408508413358/0FB718DDF99BC7ACA9704C76792C76A31FD5A1E8/"
    },
    "godlikeesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/947336408508392662/23A2C40943D44B5BE28E278CD55EE0D6D8CD7287/"
    },
    "godlike": {
      "logo": "https://cdn.steamusercontent.com/ugc/947336408508392662/23A2C40943D44B5BE28E278CD55EE0D6D8CD7287/"
    },
    "wpgaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/957467920323855773/9D6D4E0727AAD415F3C177533D983E63C7B64E05/"
    },
    "wp": {
      "logo": "https://cdn.steamusercontent.com/ugc/957467920323855773/9D6D4E0727AAD415F3C177533D983E63C7B64E05/"
    },
    "tigers": {
      "logo": "https://cdn.steamusercontent.com/ugc/941705216659818425/A42295D9071E4E02286FE98A7946C111EB34E32A/"
    },
    "plae8neon": {
      "logo": "https://cdn.steamusercontent.com/ugc/1840291882364164364/B33D494DF247FC383DB1E0847BB81BE0DA6DB9C3/"
    },
    "mangobay": {
      "logo": "https://cdn.steamusercontent.com/ugc/945083790097943557/273A8215CCA4F9173D44934EA972073D3938E6B8/"
    },
    "dium": {
      "logo": "https://cdn.steamusercontent.com/ugc/946209690011725620/D26B8ABFB3C35F4CC7379B0881DD85F3ABBC80D4/"
    },
    "lotac": {
      "logo": "https://cdn.steamusercontent.com/ugc/772866954991861623/B62AB6B6CC124B730DC30D1D8A551490E1EBF48A/"
    },
    "teamteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/941705094013048629/255CE8E5D541EE17F1851A13802EA56B7E8E0124/"
    },
    "team": {
      "logo": "https://cdn.steamusercontent.com/ugc/941705094013048629/255CE8E5D541EE17F1851A13802EA56B7E8E0124/"
    },
    "antarcticpenguins": {
      "logo": "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/team_logos/6209804.png"
    },
    "astini777": {
      "logo": "https://cdn.steamusercontent.com/ugc/943957141155545715/33B8F5C24BF116CC156216D45F6EB3DA851A042F/"
    },
    "madjoratendari": {
      "logo": "https://cdn.steamusercontent.com/ugc/966475254548861527/D8E88E3056540983989C90CAF90560C5DCBEB3B1/"
    },
    "teamlithium": {
      "logo": "https://cdn.steamusercontent.com/ugc/942832810026469014/77A3FF768E7211A13D12777970885D0E72D3E547/"
    },
    "painx": {
      "logo": "https://cdn.steamusercontent.com/ugc/945085490139513947/1EA8B514789EF8FA0D0C803F52270F782F2A3563/"
    },
    "ninjasinpyjamas": {
      "logo": "https://cdn.steamusercontent.com/ugc/939457282117079692/28F558E0F2E7BD190435810894A08D2E331CE0EF/"
    },
    "zugzwang": {
      "logo": "https://cdn.steamusercontent.com/ugc/960847208267343764/2240B6A8BD6D7DB4803FF46C252D572DD800E179/"
    },
    "jstorm": {
      "logo": "https://cdn.steamusercontent.com/ugc/957487078841260737/26B134F665A617D841BECA9E0884883E74B98DFA/"
    },
    "16anosmelhoridade": {
      "logo": "https://cdn.steamusercontent.com/ugc/947336857389428462/09186E8483157C96CCD1AB9ED46A11D26DB1D96A/"
    },
    "warriorsgamingunity": {
      "logo": "https://cdn.steamusercontent.com/ugc/947338758893687723/9ED51D18B93C3E1CBA9C58706D45CF42D6F2551C/"
    },
    "teamenemy": {
      "logo": "https://cdn.steamusercontent.com/ugc/759346451803187923/77FC51B601286C248062881956E9D50E4C221BD7/"
    },
    "malawarrior": {
      "logo": "https://cdn.steamusercontent.com/ugc/961974825774130210/8B8443D039374C666BC933E4821FFCBEDC321FC6/"
    },
    "devileyes": {
      "logo": "https://cdn.steamusercontent.com/ugc/771733253722221121/74FC9DE6D77B7EBD9964FDBC3D43F2D443A1E48B/"
    },
    "royal": {
      "logo": "https://cdn.steamusercontent.com/ugc/937206137839516292/51F476E62579AA097D2035B9BECC8ADB827660CF/"
    },
    "nikcastrum": {
      "logo": "https://cdn.steamusercontent.com/ugc/939459996286755063/A2D3963FFC59F2E31D2E3CA9F67D08482E6437A9/"
    },
    "reckoningesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/942812211562949712/1A92BF358F2687A4D74D79C4F9C02A4FAE9738EF/"
    },
    "reckoning": {
      "logo": "https://cdn.steamusercontent.com/ugc/942812211562949712/1A92BF358F2687A4D74D79C4F9C02A4FAE9738EF/"
    },
    "teamempirehope": {
      "logo": "https://cdn.steamusercontent.com/ugc/788624714192129581/94E7F21983B7BB2007C0273EB9A447386433DB36/"
    },
    "forthedream": {
      "logo": "https://cdn.steamusercontent.com/ugc/963103354433927743/0C67ADA24075FF59172BD96DA67D2A6CEEB32963/"
    },
    "playmakers": {
      "logo": "https://cdn.steamusercontent.com/ugc/960853363623870632/935E6FA2E39DB9A9D37B73342F19CFBE460E1D12/"
    },
    "flyingpenguins": {
      "logo": "https://cdn.steamusercontent.com/ugc/995764507566907229/CB60599857CFB9D6710D508F7FC88A3E8D09FE95/"
    },
    "room310": {
      "logo": "https://cdn.steamusercontent.com/ugc/948470338978740210/987A4860BE260F2A4707310760B6B46543BE17B1/"
    },
    "willowgaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/803241677502503644/0CC85973DD07A6E4D0C4201298FB085725FBF1EA/"
    },
    "willow": {
      "logo": "https://cdn.steamusercontent.com/ugc/803241677502503644/0CC85973DD07A6E4D0C4201298FB085725FBF1EA/"
    },
    "chaosesportsclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/967615741400119713/CE2F84E2109A30E7726191C7A574756407478ECE/"
    },
    "chaosesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/967615741400119713/CE2F84E2109A30E7726191C7A574756407478ECE/"
    },
    "vikingg": {
      "logo": "https://cdn.steamusercontent.com/ugc/1628571207900914834/9A093A05B2DDED488984470F0FADEFDE1F5EDE9F/"
    },
    "oldbutgold": {
      "logo": "https://cdn.steamusercontent.com/ugc/1001393825054966112/D0C717D7C301782DC2A98CEA5C7235B4E1F3D697/"
    },
    "fourzerozone": {
      "logo": "https://cdn.steamusercontent.com/ugc/1004771069909482752/0C5151599DECC6AEFD28F8B114C107BC4B840B20/"
    },
    "belialgaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/1678121042186214860/39EDE135A62C1DCCC237B13EEA78A19C940DD1B1/"
    },
    "belial": {
      "logo": "https://cdn.steamusercontent.com/ugc/1678121042186214860/39EDE135A62C1DCCC237B13EEA78A19C940DD1B1/"
    },
    "pacificesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/927086512536623410/25993B497FC97BCCC824C943D6E4F383F25E2DEF/"
    },
    "pacific": {
      "logo": "https://cdn.steamusercontent.com/ugc/927086512536623410/25993B497FC97BCCC824C943D6E4F383F25E2DEF/"
    },
    "megagaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/1458555594796362184/AB542C336682A319783E2EF6AB24F9ACE0779F0D/"
    },
    "mega": {
      "logo": "https://cdn.steamusercontent.com/ugc/1458555594796362184/AB542C336682A319783E2EF6AB24F9ACE0779F0D/"
    },
    "demolitionboys": {
      "logo": "https://cdn.steamusercontent.com/ugc/920331113103898352/09E8B9E6F0BFFFFAD0A97CD61DB6B6C1C20EFAC3/"
    },
    "hansprogaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/781853033311013173/34F2620CE5151465690DE7C106B6EF69F02A4757/"
    },
    "hanspro": {
      "logo": "https://cdn.steamusercontent.com/ugc/781853033311013173/34F2620CE5151465690DE7C106B6EF69F02A4757/"
    },
    "darksided": {
      "logo": "https://cdn.steamusercontent.com/ugc/985632674115788384/65B294890EA47B692492FF21FCB428BE38BA6D0D/"
    },
    "reelsroyce": {
      "logo": "https://cdn.steamusercontent.com/ugc/15690071434125760728/FBE769832327573EE0D40DD6F1DFC281BED2EE99/"
    },
    "mtgaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/1001395272802177218/93730993D4048D696A6B2ED57373AA454939A168/"
    },
    "mt": {
      "logo": "https://cdn.steamusercontent.com/ugc/1001395272802177218/93730993D4048D696A6B2ED57373AA454939A168/"
    },
    "uvajeniehope": {
      "logo": "https://cdn.steamusercontent.com/ugc/772852808919660116/0F10A749FBB55C9284AC6D8294D2A955DCE90C0B/"
    },
    "pejuangdotabadung": {
      "logo": "https://cdn.steamusercontent.com/ugc/990136273741176420/D0459811843F8E55E73732623C3564812AB5C226/"
    },
    "sexyasfuck": {
      "logo": "https://cdn.steamusercontent.com/ugc/974376024287984103/58FD46A4C433631107F3020A0B3CC3DB9738D8BD/"
    },
    "cignalultrawarriors": {
      "logo": "https://cdn.steamusercontent.com/ugc/1649964989855561528/65E8E2799787201DB9BB4DE498EFC7888E31F2C8/"
    },
    "goblinlegs": {
      "logo": "https://cdn.steamusercontent.com/ugc/911323913848297754/7862FCDB3AC14C164F06684635DF61C75F5A23D2/"
    },
    "butterflyeffec": {
      "logo": "https://cdn.steamusercontent.com/ugc/996892020312353198/93338DD0C5CA0C1D24C2EA89464FD239EFAD3AEC/"
    },
    "ggngg": {
      "logo": "https://cdn.steamusercontent.com/ugc/974375368219777269/8DE61AD6337AF273A5A4F8FD09E945C816E7408C/"
    },
    "vegaacademy": {
      "logo": "https://cdn.steamusercontent.com/ugc/911323913847931930/059F6C3A08E88545DEB78C2E16C1E9B41D7FB034/"
    },
    "flytomoon": {
      "logo": "https://cdn.steamusercontent.com/ugc/916953413384701477/58A15D27D05A5051190589BBED3CDD362AFC3C86/"
    },
    "beastcoast": {
      "logo": "https://cdn.steamusercontent.com/ugc/2008072595679478968/A080A63C70A5DEA039FBC1AE798EE2570E194606/"
    },
    "adroit": {
      "logo": "https://cdn.steamusercontent.com/ugc/1477695389025464429/C8DDE707B2CC970B42699AC1856B96D03AABED7C/"
    },
    "winstriketeam": {
      "logo": "https://cdn.steamusercontent.com/ugc/789748832053588401/447AE24D04DB1E105B26197B8716D702A740F310/"
    },
    "teamanvorgesa": {
      "logo": "https://cdn.steamusercontent.com/ugc/806620216003364773/6F8B820F2FE0B29327C1B9851B987512A8332AB7/"
    },
    "sacredmonarchcult": {
      "logo": "https://cdn.steamusercontent.com/ugc/780732839127611014/4C01B834836542CA2D6122E130363EF917D77F66/"
    },
    "chaosec": {
      "logo": "https://cdn.steamusercontent.com/ugc/785254538964288557/60C71B6F83A686A41F3AC5455A70D930B92C41F0/"
    },
    "kzteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/2050878574197691966/63BD4F33584531DD81146CD1BBFF4F7C4BAB6312/"
    },
    "kz": {
      "logo": "https://cdn.steamusercontent.com/ugc/2050878574197691966/63BD4F33584531DD81146CD1BBFF4F7C4BAB6312/"
    },
    "teamdrinking": {
      "logo": "https://cdn.steamusercontent.com/ugc/772849641574165975/5D991135320889D5A5B0D5B543E1C5AEA7B718BF/"
    },
    "0900": {
      "logo": "https://cdn.steamusercontent.com/ugc/1704034601417286784/36BCC7B8CD0F264624D0D51541B0A17EE75185C8/"
    },
    "lowkey": {
      "logo": "https://cdn.steamusercontent.com/ugc/780750599790860449/55E39216A68ADCFC25930DE5D27AA8C542C0AB2F/"
    },
    "theoversight": {
      "logo": "https://cdn.steamusercontent.com/ugc/2054242960854114119/CB44D64E16DFD662E5862394A07CE83047AE24AC/"
    },
    "realityrift": {
      "logo": "https://cdn.steamusercontent.com/ugc/1022822776634092251/D6D106057358BC1992E78DEC8421AEC34C472C4E/"
    },
    "9pandas": {
      "logo": "https://cdn.steamusercontent.com/ugc/2485502666697365913/234C3E0EDA6A8E315DC78A5EC2C6C1FBB1DD6657/"
    },
    "t1": {
      "logo": "https://cdn.steamusercontent.com/ugc/773981969136635863/BE28F059BD864F4820323DE5DDD864D4C353CA87/"
    },
    "blackknight": {
      "logo": "https://cdn.steamusercontent.com/ugc/770604271209269505/E2BE9219BD93B22A9A29ECDBC4C68251E1616920/"
    },
    "asteraries": {
      "logo": "https://cdn.steamusercontent.com/ugc/1021697620249691876/0C6C8F47D723EF0B110292609BFDB64EB7B9553C/"
    },
    "demonesport": {
      "logo": "https://cdn.steamusercontent.com/ugc/767226571494366995/65605597C4930F4078EF26D56BBF9CBFBE0F4A49/"
    },
    "demon": {
      "logo": "https://cdn.steamusercontent.com/ugc/767226571494366995/65605597C4930F4078EF26D56BBF9CBFBE0F4A49/"
    },
    "fightingpandas": {
      "logo": "https://cdn.steamusercontent.com/ugc/778498799978614883/0203F5435560EFC32DDBB0B7D170ECF50CCD3BE6/"
    },
    "teamoracleyouth": {
      "logo": "https://cdn.steamusercontent.com/ugc/761599357008552749/AD4B630E7D98A59F3923A78A2E55FCB3EDD79789/"
    },
    "galkynysh": {
      "logo": "https://cdn.steamusercontent.com/ugc/1839180033860671079/ADC9EC54D3B6A50F54E372E97C36809E008BD11B/"
    },
    "chickenfighters": {
      "logo": "https://cdn.steamusercontent.com/ugc/769486732001897391/E5A91F8FB5ACFE3BC4DF89158B318C4D34960F80/"
    },
    "nigmagalaxy": {
      "logo": "https://cdn.steamusercontent.com/ugc/1827894588975105240/421C0D8318D71D5DD31FD08A7933AB622AE26590/"
    },
    "ogseed": {
      "logo": "https://cdn.steamusercontent.com/ugc/1004809121655041802/D9C893AC4F6CF2DA59CB22CF7FE1885133389F9A/"
    },
    "avengers": {
      "logo": "https://cdn.steamusercontent.com/ugc/779619985829101396/7AD3F16DB80CC0EB3D429F0B66A85F05D68DF6A7/"
    },
    "aggressivemode": {
      "logo": "https://cdn.steamusercontent.com/ugc/793133917198581287/2372880E304EFDBEFE73D101E54C0A34D9AA8612/"
    },
    "yangongalacticos": {
      "logo": "https://cdn.steamusercontent.com/ugc/2473119197018002013/9F54FB2ED4476EA67C55994F5FB7CDAC3B882809/"
    },
    "cyberlegacy": {
      "logo": "https://cdn.steamusercontent.com/ugc/1634201755650370035/913F61C7C49EC6330168C986C5F1B0D5D2873361/"
    },
    "businessassociates": {
      "logo": "https://cdn.steamusercontent.com/ugc/789755010916561479/354F9DF6125FE48FC70FF8588985EF77E8CDDAAE/"
    },
    "iodota2": {
      "logo": "https://cdn.steamusercontent.com/ugc/772866954992254276/4C6C13691C48BD79E1B9AF3FBC735738520C6F51/"
    },
    "clcombatteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/771742768467331494/0472A95C77A0E26D08922566045C5039078C6D78/"
    },
    "clcombat": {
      "logo": "https://cdn.steamusercontent.com/ugc/771742768467331494/0472A95C77A0E26D08922566045C5039078C6D78/"
    },
    "neetsuprising": {
      "logo": "https://cdn.steamusercontent.com/ugc/793134540759885368/BA2CD08B658CE3F2B3571FAAF20E6242555FC1D5/"
    },
    "boomesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/2916748038054832/52C6F6228C73CDB6855C04B64FF21D061D2C15A9/"
    },
    "boom": {
      "logo": "https://cdn.steamusercontent.com/ugc/2916748038054832/52C6F6228C73CDB6855C04B64FF21D061D2C15A9/"
    },
    "cr4zy": {
      "logo": "https://cdn.steamusercontent.com/ugc/777372824325330501/0203F5435560EFC32DDBB0B7D170ECF50CCD3BE6/"
    },
    "oshihiteogaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/14050897008803262158/1FD5BAE3F059692AEFC7340136D3FB7D0E756F6D/"
    },
    "oshihiteo": {
      "logo": "https://cdn.steamusercontent.com/ugc/14050897008803262158/1FD5BAE3F059692AEFC7340136D3FB7D0E756F6D/"
    },
    "paladin": {
      "logo": "https://cdn.steamusercontent.com/ugc/1186083602257343509/F263A4DBCB8B480B6D75EF6660CC11B0A191089E/"
    },
    "vpprodigy": {
      "logo": "https://cdn.steamusercontent.com/ugc/1009310639742423917/9175453DE6C700E0CC6D547F437B4819F1144A1A/"
    },
    "yoloknight": {
      "logo": "https://cdn.steamusercontent.com/ugc/1019444160331853455/D570A703968576DFB06323900AFCA61FD1519BA5/"
    },
    "teamsideral": {
      "logo": "https://cdn.steamusercontent.com/ugc/1753562761757863552/04DB6105E2437AA7B7C9A21E618522A1853AB8B1/"
    },
    "midasclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/17938584415227532642/443B12E7F60402DC99D04CD2359992E5B3511949/"
    },
    "midas": {
      "logo": "https://cdn.steamusercontent.com/ugc/17938584415227532642/443B12E7F60402DC99D04CD2359992E5B3511949/"
    },
    "familyteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/1021698582220690828/25303B125189AD8D01A52AF6E5B1C7AA4411869E/"
    },
    "family": {
      "logo": "https://cdn.steamusercontent.com/ugc/1021698582220690828/25303B125189AD8D01A52AF6E5B1C7AA4411869E/"
    },
    "destroyitems": {
      "logo": "https://cdn.steamusercontent.com/ugc/1026202486988728855/110EDF7E5BDD7D305792871B1FC584B52A5794A8/"
    },
    "newesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/1048723493300485230/77C98B21711C5D6981D6964A17F024EEC8674743/"
    },
    "new": {
      "logo": "https://cdn.steamusercontent.com/ugc/1048723493300485230/77C98B21711C5D6981D6964A17F024EEC8674743/"
    },
    "egoboys": {
      "logo": "https://cdn.steamusercontent.com/ugc/1282912715388467447/4049258DD58AFA5FB7608E7DC8AC6B08BA920F15/"
    },
    "galaxyraceresports": {
      "logo": "https://cdn.steamusercontent.com/ugc/1768194395980957182/F98E05970A8BB8574785B80B004EF148D6F589B7/"
    },
    "galaxyracer": {
      "logo": "https://cdn.steamusercontent.com/ugc/1768194395980957182/F98E05970A8BB8574785B80B004EF148D6F589B7/"
    },
    "adichula": {
      "logo": "https://cdn.steamusercontent.com/ugc/1466435869869827636/4B0CA2C8DFDEC29008BE78F3EB3F73E2A555D1BF/"
    },
    "omegalil": {
      "logo": "https://cdn.steamusercontent.com/ugc/1483327361881225989/BED39500E5C02E2A74BFA84F7504884C3D208824/"
    },
    "panda5": {
      "logo": "https://cdn.steamusercontent.com/ugc/1465311368136101760/319912C6631CABB60AC43B7AC14B16C8CA741EAC/"
    },
    "cuteanimegirls": {
      "logo": "https://cdn.steamusercontent.com/ugc/1486703883910276246/1CFB9D3E73FEF9E4820E6B2B17735FFDA9E3D00C/"
    },
    "teambrasil": {
      "logo": "https://cdn.steamusercontent.com/ugc/1494586360945844832/05E4DDCA25CA313396FFDF01C0D8E65141911E91/"
    },
    "escapevelocity": {
      "logo": "https://cdn.steamusercontent.com/ugc/1482200421119183052/E2A77696D5B5F77238212747B0940810A9751858/"
    },
    "ezkatka": {
      "logo": "https://cdn.steamusercontent.com/ugc/1487830656542207062/86C263EBC729678F33CD308921B2274CE3028F41/"
    },
    "brame": {
      "logo": "https://cdn.steamusercontent.com/ugc/1535122449444925400/4FF8F5867A8D86DF5700A8BDAD237A457B52E97B/"
    },
    "mudgolems": {
      "logo": "https://cdn.steamusercontent.com/ugc/1635325934676609507/8E073AB63209CE73BD08E056B1C6CCE1014B3890/"
    },
    "4am": {
      "logo": "https://cdn.steamusercontent.com/ugc/1634200726535406834/8226A44B6C690601A9DEF8CBDA98EF857E9CF658/"
    },
    "ukumari": {
      "logo": "https://cdn.steamusercontent.com/ugc/2005821149636251119/8AA0FD65758980E29B762EF7124456B95650118D/"
    },
    "01esports": {
      "logo": "https://cdn.steamusercontent.com/ugc/1539625527765315928/563F5BCDBD36AC91DB60BB2A5C017CFB0020B042/"
    },
    "01": {
      "logo": "https://cdn.steamusercontent.com/ugc/1539625527765315928/563F5BCDBD36AC91DB60BB2A5C017CFB0020B042/"
    },
    "amongus": {
      "logo": "https://cdn.steamusercontent.com/ugc/1660098812171826030/93B496CC8B327FEB2573D6DDD7C340CB9D09A9AB/"
    },
    "draingang": {
      "logo": "https://cdn.steamusercontent.com/ugc/1657852538982079794/672FC5225508AD2454DF5748EBAA86C169C57B2E/"
    },
    "4fun": {
      "logo": "https://cdn.steamusercontent.com/ugc/1683743254297527294/E931D830AC1CDEB7D249E39F652F9C3ED8175625/"
    },
    "livetowin": {
      "logo": "https://cdn.steamusercontent.com/ugc/1684869309280763059/CE8EAFDDA8854D0B380EC63B819149778ACEEE0B/"
    },
    "forest": {
      "logo": "https://cdn.steamusercontent.com/ugc/1678114018011000727/D4221B7FF3778B415752910C1B95147BD299A32D/"
    },
    "ftdcclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/1675862404285979604/82B845AD9EBA8C7A59DDCD5AE71975CD8E78B5F7/"
    },
    "ftdc": {
      "logo": "https://cdn.steamusercontent.com/ugc/1675862404285979604/82B845AD9EBA8C7A59DDCD5AE71975CD8E78B5F7/"
    },
    "comedown": {
      "logo": "https://cdn.steamusercontent.com/ugc/1836910666882174916/13C0F9ECE0232A65FDBAECDD2A44DAE63A17FE73/"
    },
    "bleed": {
      "logo": "https://cdn.steamusercontent.com/ugc/2295213538402514054/0B50AC73180D7322D099C37682AFF28BE4C4875E/"
    },
    "teamsmg": {
      "logo": "https://cdn.steamusercontent.com/ugc/1856049226625971775/C8540DF2478E5EE8890CD4128DE07176F9FE5FA2/"
    },
    "binusuniversity": {
      "logo": "https://cdn.steamusercontent.com/ugc/1663483160481733023/362363116FD98B41F54EE099D64203BA6A1A573A/"
    },
    "evilgeniuses": {
      "logo": "https://cdn.steamusercontent.com/ugc/1983302387907692940/BAA861E234E1BA39D75DF4CB814A5B76D020BED7/"
    },
    "betboomteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/9995426432403529725/51E13136D4CCC8C7D8062861541A1D13B8ED87E0/"
    },
    "betboom": {
      "logo": "https://cdn.steamusercontent.com/ugc/9995426432403529725/51E13136D4CCC8C7D8062861541A1D13B8ED87E0/"
    },
    "tsm": {
      "logo": "https://cdn.steamusercontent.com/ugc/1996813186806561034/BC39F0DC131EDC7D7D8A9DCE4933B4A8B0966004/"
    },
    "creepwave": {
      "logo": "https://cdn.steamusercontent.com/ugc/1681517831574098379/EDF37F1B1A2A8684DC959A8D0880B70FA6F8C5D2/"
    },
    "xtremegaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/2402194226059610590/E3CF4B6C4B2CFB974A9B415141E4A37317AD4D80/"
    },
    "xtreme": {
      "logo": "https://cdn.steamusercontent.com/ugc/2402194226059610590/E3CF4B6C4B2CFB974A9B415141E4A37317AD4D80/"
    },
    "armygeniusesmansion": {
      "logo": "https://cdn.steamusercontent.com/ugc/2036229291620856332/487BA4B704ADCA08C99B4F67E0DF5EF3D2F4DFD1/"
    },
    "vgaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/1699530468133422483/88FB30CF0880687F9BB0429E3C7B59CF673DC700/"
    },
    "v": {
      "logo": "https://cdn.steamusercontent.com/ugc/1699530468133422483/88FB30CF0880687F9BB0429E3C7B59CF673DC700/"
    },
    "hellbearsmashers": {
      "logo": "https://cdn.steamusercontent.com/ugc/1745679796967643438/92B0E956ED01D24C679FECED3D23D01EAB1C3048/"
    },
    "felt": {
      "logo": "https://cdn.steamusercontent.com/ugc/1755809001572876579/859F0227D4B586D6065C5980CFBBBA0ABAAE184C/"
    },
    "tundraesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/2031716132171967904/07B168B8063D9B22CDAD53AB421ECAF3D4B2E07E/"
    },
    "tundra": {
      "logo": "https://cdn.steamusercontent.com/ugc/2031716132171967904/07B168B8063D9B22CDAD53AB421ECAF3D4B2E07E/"
    },
    "sadboys2": {
      "logo": "https://cdn.steamusercontent.com/ugc/1767069358937750377/8EB82A2377D028F043009005D43F6D667BF1832E/"
    },
    "wayfarers": {
      "logo": "https://cdn.steamusercontent.com/ugc/1844811606349277848/9115EF5523F852C1EDA27BF1194658188AA197FA/"
    },
    "randomsesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/2416817187172584251/5E7AA2C4896A6EB1212B673B731DD9838ECCFB27/"
    },
    "randoms": {
      "logo": "https://cdn.steamusercontent.com/ugc/2416817187172584251/5E7AA2C4896A6EB1212B673B731DD9838ECCFB27/"
    },
    "friascomex": {
      "logo": "https://cdn.steamusercontent.com/ugc/1758065850922672770/D397D32D9F6271921174EAE74DA98760E1A07BFA/"
    },
    "neonesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/1905612771137210708/67688ED3000B1B2140DCDD96275E114F3F9F3BC7/"
    },
    "neon": {
      "logo": "https://cdn.steamusercontent.com/ugc/1905612771137210708/67688ED3000B1B2140DCDD96275E114F3F9F3BC7/"
    },
    "infinity": {
      "logo": "https://cdn.steamusercontent.com/ugc/2270441745021468359/0B29AFE6D9B224CB4EDB33A07AAC0D3FD19A00A6/"
    },
    "motivatevipergaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/1697276876114058177/C93540F44666B466DD577679B40A6C689BE874F8/"
    },
    "motivateviper": {
      "logo": "https://cdn.steamusercontent.com/ugc/1697276876114058177/C93540F44666B466DD577679B40A6C689BE874F8/"
    },
    "onemove": {
      "logo": "https://cdn.steamusercontent.com/ugc/2429222166861438379/2016A60B73B29A620CFA81A830603361CBB388AD/"
    },
    "intothebreach": {
      "logo": "https://cdn.steamusercontent.com/ugc/1795223008077512746/B283A962A0FFF8636A3DC829C3F93BA4C9FEE214/"
    },
    "kastudon": {
      "logo": "https://cdn.steamusercontent.com/ugc/1815491317552191607/F961671C1BE095A579C9C917BECCFD53EFD497DC/"
    },
    "grinesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/2001317420616485713/858FEE24286C9D1CDC77AF3D5F3BDAADEB89D2F9/"
    },
    "grin": {
      "logo": "https://cdn.steamusercontent.com/ugc/2001317420616485713/858FEE24286C9D1CDC77AF3D5F3BDAADEB89D2F9/"
    },
    "sinister5": {
      "logo": "https://cdn.steamusercontent.com/ugc/1758072603532456160/1F5DEE24522DB96F9CCA4F5D9BFCAFF5F47BB658/"
    },
    "meowmeow": {
      "logo": "https://cdn.steamusercontent.com/ugc/1767080909754778108/F20BAA83EA92A2A6F4B5AD62CDFF00E0CE38200B/"
    },
    "ragdoll": {
      "logo": "https://cdn.steamusercontent.com/ugc/1697280262050066254/F18A176DAA613BB8B016AE90F4E8D17BE02AAA63/"
    },
    "furiajovem": {
      "logo": "https://cdn.steamusercontent.com/ugc/1695028324681823345/3E19FB91AF9863F91DABF16601A7E1EB262E5C9B/"
    },
    "infamousuesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/1691652603942290191/76D5156E3CF7847989185216EEBF36157381CAF9/"
    },
    "infamousu": {
      "logo": "https://cdn.steamusercontent.com/ugc/1691652603942290191/76D5156E3CF7847989185216EEBF36157381CAF9/"
    },
    "oshtekkwarriors": {
      "logo": "https://cdn.steamusercontent.com/ugc/1702905980605432446/292ED6C94389F1281CB5BE93678E3CC28E7BD794/"
    },
    "azureray": {
      "logo": "https://cdn.steamusercontent.com/ugc/2298587339939886506/26FF6DD1070476EAF1C69DD30B259FBB197F0256/"
    },
    "lavabestpc": {
      "logo": "https://cdn.steamusercontent.com/ugc/1827892670576860117/693ADB9ACBDBD27BD1EDE14A72D02E8F3870B661/"
    },
    "hydra": {
      "logo": "https://cdn.steamusercontent.com/ugc/2511403980000601665/A9227AFA6C2DD7F9A1A8E0F5C4278579DB10833F/"
    },
    "teamwanka": {
      "logo": "https://cdn.steamusercontent.com/ugc/1926996054456055976/4EBBE607134216E7F16DC7E111D16095AD1B5548/"
    },
    "madqueensesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/1821138407262581214/2473111D6CED1B3429F7565EEC44D7A5E16ED628/"
    },
    "madqueens": {
      "logo": "https://cdn.steamusercontent.com/ugc/1821138407262581214/2473111D6CED1B3429F7565EEC44D7A5E16ED628/"
    },
    "lunagalaxy": {
      "logo": "https://cdn.steamusercontent.com/ugc/2038491084577608095/CA67ADB750E3B98E8544FB0CC1D2FF1C9EC27A77/"
    },
    "teletubbies": {
      "logo": "https://cdn.steamusercontent.com/ugc/1787361110837767265/4FBB5C3616E4B936E58C6C8956635109028528A8/"
    },
    "talon": {
      "logo": "https://cdn.steamusercontent.com/ugc/2028347991408203552/8DC9872DA88071D728A914CE17279959423FA340/"
    },
    "moneymakers": {
      "logo": "https://cdn.steamusercontent.com/ugc/2021594397761808667/0D4392B2C152DE0424EBCB6B6DC3A4DBDDCCD12F/"
    },
    "gaimingladiators": {
      "logo": "https://cdn.steamusercontent.com/ugc/1850419664501191993/5DAAB68FB5604D29E1792A0F35E74B3FE3F3A026/"
    },
    "cloud9": {
      "logo": "https://cdn.steamusercontent.com/ugc/2399941883261718982/81DE19B3FD9737B5F16C725D3FB7E72251BE2A81/"
    },
    "wildcard": {
      "logo": "https://cdn.steamusercontent.com/ugc/14173210407158797/EAFCC9BE14FBFC9DC1EA3D03D62772D38F7DF15F/"
    },
    "barsa": {
      "logo": "https://cdn.steamusercontent.com/ugc/10796235327127884/AA68A8E1303A3AD70C0E5833A04117BEEC546C83/"
    },
    "444squad": {
      "logo": "https://cdn.steamusercontent.com/ugc/2483261555751237752/8444746CA8F12036A07FB6A2237C3F0A45A14D42/"
    },
    "blackpukers": {
      "logo": "https://cdn.steamusercontent.com/ugc/1887597844446270477/6E387B14978698302B904FEB2FC24F45D8CE99B1/"
    },
    "easygaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/1833543457070431639/775F05FC8F1C0E14E1E6DBAB2CBF192165A413E2/"
    },
    "easy": {
      "logo": "https://cdn.steamusercontent.com/ugc/1833543457070431639/775F05FC8F1C0E14E1E6DBAB2CBF192165A413E2/"
    },
    "blacklistrivalry": {
      "logo": "https://cdn.steamusercontent.com/ugc/2050860821377863997/BAE16F709F0AE46642FAD3366C78FD92FD2FD741/"
    },
    "nomercy": {
      "logo": "https://cdn.steamusercontent.com/ugc/2072263299220300385/701C7260941442D8CA1765012CBEE385EC2E23A7/"
    },
    "darkside": {
      "logo": "https://cdn.steamusercontent.com/ugc/1845922937363804366/B718AFD0F76379ACDDE28F7512FC91B76C478985/"
    },
    "shelbywalk": {
      "logo": "https://cdn.steamusercontent.com/ugc/15500294396428948218/B3D9E39B396F247D9961EF5905313F9290380F96/"
    },
    "ooredoothunders": {
      "logo": "https://cdn.steamusercontent.com/ugc/1883094124816874766/6F395B569068034041A162578E78E83902E46E83/"
    },
    "nouns": {
      "logo": "https://cdn.steamusercontent.com/ugc/1861686187975269057/6E221E0B04CCB4AEF93A3FDA4DC7873A1BBAFAE2/"
    },
    "pangoliersjavelinom": {
      "logo": "https://cdn.steamusercontent.com/ugc/1852678988747798218/13734C5F707C49CF2880386C3B044D8754667C91/"
    },
    "lavaesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/2020458443820677798/6DBE7E16C897F641DC4BA91F1F04D784905F72B5/"
    },
    "lava": {
      "logo": "https://cdn.steamusercontent.com/ugc/2020458443820677798/6DBE7E16C897F641DC4BA91F1F04D784905F72B5/"
    },
    "atomicesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/1854933517826836824/47F54E3D687725343A8B56CB6785A0156E3F1423/"
    },
    "atomic": {
      "logo": "https://cdn.steamusercontent.com/ugc/1854933517826836824/47F54E3D687725343A8B56CB6785A0156E3F1423/"
    },
    "equisdesomoschavos": {
      "logo": "https://cdn.steamusercontent.com/ugc/1827910574771249710/7D8F9013F3C25ADD92CD6ABFAEFA44319DC73089/"
    },
    "virtuspro2": {
      "logo": "https://cdn.steamusercontent.com/ugc/1872947708319301759/087EF97925087F92561983C34475ACBB68A60AE4/"
    },
    "teamsphinx": {
      "logo": "https://cdn.steamusercontent.com/ugc/2048607934858898157/B904083AF403DC27F8DC18EA96E2406AEB64BFDA/"
    },
    "tamsme": {
      "logo": "https://cdn.steamusercontent.com/ugc/1830165414580693025/0490CB1A1C9A39BE4735653CDA9DF8270BE26CB8/"
    },
    "havu": {
      "logo": "https://cdn.steamusercontent.com/ugc/1833543457080341173/97E231A7DB51D0CA99DD8D8668835FBA8FE7B09C/"
    },
    "vezzra": {
      "logo": "https://cdn.steamusercontent.com/ugc/2042986495990339051/AD05C5372484A344F81EF3351636B3841D46B38E/"
    },
    "animeenjoyers": {
      "logo": "https://cdn.steamusercontent.com/ugc/1779504675340866269/9B84E5C6529F42243451665477F33B96C1F475F5/"
    },
    "nomatthew": {
      "logo": "https://cdn.steamusercontent.com/ugc/2438208701509068489/350B89E8E9FB98BF8027B3FCDE4637AA2A15064D/"
    },
    "teamsangre": {
      "logo": "https://cdn.steamusercontent.com/ugc/14219176089841400535/F1E15FF4CC95FFB792428F07BE7F48B1843A3821/"
    },
    "matreshka": {
      "logo": "https://cdn.steamusercontent.com/ugc/2289581108031278201/DE2ED21F4DEEB8C3E302C5A0AF9CAF8CC84E8BA8/"
    },
    "balrogsacademy": {
      "logo": "https://cdn.steamusercontent.com/ugc/2020475078797052490/F6FEC85DF2E0E90E8E82CEA182D078E0B7C97554/"
    },
    "ancienttribe2": {
      "logo": "https://cdn.steamusercontent.com/ugc/1990057992897734075/07A293B6565085107C7A440115D66892AA2006FC/"
    },
    "unitygaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/1903359885429306314/1A31E4B8947848865DDF8656458180572F6DB941/"
    },
    "unity": {
      "logo": "https://cdn.steamusercontent.com/ugc/1903359885429306314/1A31E4B8947848865DDF8656458180572F6DB941/"
    },
    "studio21": {
      "logo": "https://cdn.steamusercontent.com/ugc/1912368892091918094/3CF192AF17F69AF5EB695B785E8077A799322CEF/"
    },
    "psgquest": {
      "logo": "https://cdn.steamusercontent.com/ugc/2481004682513190539/324F8847AD21944686DED20FB3E2C0DEA4154AE7/"
    },
    "mantaesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/2478749260055361941/F4D1D80AB29862CA0C957DFAD1456CBE98483F27/"
    },
    "manta": {
      "logo": "https://cdn.steamusercontent.com/ugc/2478749260055361941/F4D1D80AB29862CA0C957DFAD1456CBE98483F27/"
    },
    "tatladderclan": {
      "logo": "https://cdn.steamusercontent.com/ugc/2457349000339157388/C4F54B5F7603A9B99B4637B981E187FDA1541E32/"
    },
    "ynotfanclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/1978798064098818022/F251312057A2ADE7AA3655A08917372BC5537544/"
    },
    "ynotfan": {
      "logo": "https://cdn.steamusercontent.com/ugc/1978798064098818022/F251312057A2ADE7AA3655A08917372BC5537544/"
    },
    "outsidersfromcn": {
      "logo": "https://cdn.steamusercontent.com/ugc/2028342277680788691/B504CC3B01CFEB0201FF7B7CE96F50F61196CE29/"
    },
    "indonesia": {
      "logo": "https://cdn.steamusercontent.com/ugc/1997939086698116350/3396FD82A230192B8DF91D21C93837E95D1AC23B/"
    },
    "mythavenuegaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/2077887587643978863/6C1ACCEC01EB0BE4C9C75D82421118973C757DCF/"
    },
    "mythavenue": {
      "logo": "https://cdn.steamusercontent.com/ugc/2077887587643978863/6C1ACCEC01EB0BE4C9C75D82421118973C757DCF/"
    },
    "storm": {
      "logo": "https://cdn.steamusercontent.com/ugc/2028354481551397489/BA39B32EA6335F75295CDB5E36DCB31D3FC93F77/"
    },
    "firebeavers": {
      "logo": "https://cdn.steamusercontent.com/ugc/1979926046523390782/D449E850DC2A83DDA3984B3788DA054AE404E28E/"
    },
    "starfoxes": {
      "logo": "https://cdn.steamusercontent.com/ugc/2046362392217398188/E6B179AA7B1FAAD9674EE563C044BFDA13502383/"
    },
    "mindtakers": {
      "logo": "https://cdn.steamusercontent.com/ugc/2001317618118649176/D5F933113354B4991C5D61FB3C6FCEB074507571/"
    },
    "teamsexy": {
      "logo": "https://cdn.steamusercontent.com/ugc/2032861231216761354/13C0C97E4F1B758EDAF89B19C45226E68DFEEA52/"
    },
    "blockroaresports": {
      "logo": "https://cdn.steamusercontent.com/ugc/2001323196957602976/EF30A8E48B45F4299DEDCCDB2BCF9B30ECC49CA7/"
    },
    "blockroar": {
      "logo": "https://cdn.steamusercontent.com/ugc/2001323196957602976/EF30A8E48B45F4299DEDCCDB2BCF9B30ECC49CA7/"
    },
    "teamtough": {
      "logo": "https://cdn.steamusercontent.com/ugc/2298586614153129772/34892DA3BE31B7E7E9E4BED828EB54B3A055388A/"
    },
    "tpabomah": {
      "logo": "https://cdn.steamusercontent.com/ugc/40063924290200515/BD0C76D0F4029CAA32E2F43A04BF6A5F68135820/"
    },
    "ihc": {
      "logo": "https://cdn.steamusercontent.com/ugc/2514771532510530932/AA92D7C7649DD3366A31E0E1F772356805B73442/"
    },
    "navijunior": {
      "logo": "https://cdn.steamusercontent.com/ugc/2909225722380320/5C6EFC9004093ED29E9B48242DE79418BDDBFE30/"
    },
    "teambright": {
      "logo": "https://cdn.steamusercontent.com/ugc/2008081064641074125/98465178D23A5C307E6AA8CE298B17CEBB16B979/"
    },
    "holygrail": {
      "logo": "https://cdn.steamusercontent.com/ugc/2036233631759545038/183C2584681DBC309834BCE5561EA04CDDFFC736/"
    },
    "thecovenant": {
      "logo": "https://cdn.steamusercontent.com/ugc/2187121345783071266/E1E6B530D0C644B81A08CE51ED03A9BB5698D1C0/"
    },
    "wingripper": {
      "logo": "https://cdn.steamusercontent.com/ugc/2200631506770437455/E5C9DBEA9D2EECC4F3F98DE49AC1D6D8EE533B88/"
    },
    "fortnite": {
      "logo": "https://cdn.steamusercontent.com/ugc/16326258531762154557/88D6A1CB366D006460F6FF183FA8230F26E5C456/"
    },
    "thelastdark": {
      "logo": "https://cdn.steamusercontent.com/ugc/2037359531667015102/14D1DA388EDDCD83477977801CA13A77A40373BE/"
    },
    "infamousastra": {
      "logo": "https://cdn.steamusercontent.com/ugc/2032858469296116678/EDF6030FFA1952797EE94712BB781280D5034932/"
    },
    "bbteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/9393895253468454856/41CF4EBEB359259E56E03AECEF6A7606CF0A076F/"
    },
    "bb": {
      "logo": "https://cdn.steamusercontent.com/ugc/9393895253468454856/41CF4EBEB359259E56E03AECEF6A7606CF0A076F/"
    },
    "businessclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/2031737253379162247/A9D128309B9FC2C328AE048CB69E4D07C67BD26C/"
    },
    "business": {
      "logo": "https://cdn.steamusercontent.com/ugc/2031737253379162247/A9D128309B9FC2C328AE048CB69E4D07C67BD26C/"
    },
    "acatsuki": {
      "logo": "https://cdn.steamusercontent.com/ugc/2053131008994362284/5E9C97210030F1BE6E890A2B813DD18411C1A12A/"
    },
    "generationofmiracles": {
      "logo": "https://cdn.steamusercontent.com/ugc/2018230014077150128/2A5B42C481DCF8BC3A8AF59BB40F2587E10541C8/"
    },
    "teamarava": {
      "logo": "https://cdn.steamusercontent.com/ugc/2057636696173009399/4BEC52A21EB8A6E14EC365656FAC33A1C84231BF/"
    },
    "magid": {
      "logo": "https://cdn.steamusercontent.com/ugc/2213016405732835572/D7955018FA3AC7FBB78621C5C6D5AD33B9EF673B/"
    },
    "ror": {
      "logo": "https://cdn.steamusercontent.com/ugc/2076779599437195979/F472FC7B699006A25B505F6AAC6B12CBF1B73DCF/"
    },
    "asakura": {
      "logo": "https://cdn.steamusercontent.com/ugc/2370671116173459609/9854CD03A6A44348475DC298295552B5CEA70794/"
    },
    "lionlover": {
      "logo": "https://cdn.steamusercontent.com/ugc/2125194398903885481/3295CDB3D4CB4328A2FA7BD70AB4B18FA724AD1E/"
    },
    "demigods": {
      "logo": "https://cdn.steamusercontent.com/ugc/2109432346272393261/5D02E4493B1E9373C84054C315FA87BCB54A0C66/"
    },
    "yodibrodinexusfuture": {
      "logo": "https://cdn.steamusercontent.com/ugc/2217520643255336308/6E456F96913CB97E109B7676E931994A786BDDFD/"
    },
    "teamfalcons": {
      "logo": "https://cdn.steamusercontent.com/ugc/2314350571781870059/2B5C9FE9BA0A2DC303A13261444532AA08352843/"
    },
    "passionua": {
      "logo": "https://cdn.steamusercontent.com/ugc/18319865695983129908/E7302CFFC29E4716B28F5BAB4812020B2C61E389/"
    },
    "teamwaska": {
      "logo": "https://cdn.steamusercontent.com/ugc/2376297984889887726/F2376446D05157B080B5D506473EE2F1D43097BF/"
    },
    "enjoy": {
      "logo": "https://cdn.steamusercontent.com/ugc/14410915104676115574/85F6E2C9BBB26A11B37E55AF05BE507E94B06863/"
    },
    "estarbacks": {
      "logo": "https://cdn.steamusercontent.com/ugc/2247920665251197227/5D236EEB62190F9B0FC6F25BDA98DDB3EB6A5F0A/"
    },
    "aurora1xbet": {
      "logo": "https://cdn.steamusercontent.com/ugc/2362769341411270166/E13C592A0E744E1C386E09DE650BE36B85AE8137/"
    },
    "bammysoy": {
      "logo": "https://cdn.steamusercontent.com/ugc/2298591238452720970/D1327CB4F1C336091246D8A42CEDCCEBB02F56FC/"
    },
    "wawitassagazes": {
      "logo": "https://cdn.steamusercontent.com/ugc/2295210273364324956/528675A3C5A05E302E1BCD5FB2409479B0A2F632/"
    },
    "levelupesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/11124972020884745329/AB3238A17EE9950F7532A26B1EAAFCF2086FB37A/"
    },
    "thedudleyboys": {
      "logo": "https://cdn.steamusercontent.com/ugc/2240039780382774383/E60E1732900AE3CE26C1BEA0BBE7B85CCB872B8E/"
    },
    "invaders": {
      "logo": "https://cdn.steamusercontent.com/ugc/2297462073171121106/5EF06B2A21F8BDFA6E3A99CE45C896E47B05A926/"
    },
    "ninjapenguins": {
      "logo": "https://cdn.steamusercontent.com/ugc/2321110410943510446/9E5FCD7F361FE09E5F98520D435ECF6642680AEC/"
    },
    "l1gateam": {
      "logo": "https://cdn.steamusercontent.com/ugc/40063200209690390/20B527165E8E637C83F27A62FFE1AE957CB43018/"
    },
    "l1ga": {
      "logo": "https://cdn.steamusercontent.com/ugc/40063200209690390/20B527165E8E637C83F27A62FFE1AE957CB43018/"
    },
    "heroic": {
      "logo": "https://cdn.steamusercontent.com/ugc/2471984170520125054/B066431AF4D322D300DD5180CEC8F6BA0E85A7F5/"
    },
    "drune": {
      "logo": "https://cdn.steamusercontent.com/ugc/2280576552131881929/F0B866F1CF06C9581B6EC01530F3A54A26E6FF40/"
    },
    "skyblades": {
      "logo": "https://cdn.steamusercontent.com/ugc/2424697006978293524/F5906F73364F065897D36A2CD1B5AFBB8DE40DCD/"
    },
    "5pivas": {
      "logo": "https://cdn.steamusercontent.com/ugc/2477628251801454155/8FB93CDB48A5AD9FD8B48C577ED07B9A6D5DE0A2/"
    },
    "v1dargaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/2294088813186214814/919F642EEBB4E986EF6F29780B9728CC996E0DAE/"
    },
    "v1dar": {
      "logo": "https://cdn.steamusercontent.com/ugc/2294088813186214814/919F642EEBB4E986EF6F29780B9728CC996E0DAE/"
    },
    "sporkfacekillazdiv2": {
      "logo": "https://cdn.steamusercontent.com/ugc/2276074414692701591/5E311B3953236794EB3E8DF05FE439AF0329B01A/"
    },
    "leviatan": {
      "logo": "https://cdn.steamusercontent.com/ugc/2476496009610060553/805B58DE6A151FD0946F26A8181F711AB38FDD9F/"
    },
    "teamkobolds": {
      "logo": "https://cdn.steamusercontent.com/ugc/2462977603804344116/289965BA1A48CC692D9E133DAC9EF95DC590FC64/"
    },
    "yakultbrothers": {
      "logo": "https://cdn.steamusercontent.com/ugc/18179376480673513766/A3EDE6125A651D94E1DAAF0F3361ACEB9FB858C4/"
    },
    "pigmonsters": {
      "logo": "https://cdn.steamusercontent.com/ugc/5936377725255412591/EC5CFAD80CD15F84F4E2BFD89366AA57FAE4D09C/"
    },
    "salvationgaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/5970154800985346024/DC78EF1BA500CF4791BDDE81A03538E2F5D990EA/"
    },
    "salvation": {
      "logo": "https://cdn.steamusercontent.com/ugc/5970154800985346024/DC78EF1BA500CF4791BDDE81A03538E2F5D990EA/"
    },
    "dandelions": {
      "logo": "https://cdn.steamusercontent.com/ugc/15715194248994242624/F95A1A1356998D2390CC2D8A57E56041A25BF9F7/"
    },
    "householdwarriors": {
      "logo": "https://cdn.steamusercontent.com/ugc/2432577673800461225/E7AF4C273DF7AF34DD173E80005AD53BA8E4E674/"
    },
    "kev": {
      "logo": "https://cdn.steamusercontent.com/ugc/2470858903185171081/B86EC502336507A8BC8CEDC1E571D9E273B7EAD6/"
    },
    "upstars": {
      "logo": "https://cdn.steamusercontent.com/ugc/2475370109679095856/F4A379BD3CB8025AEEFBF095E93849C569032E70/"
    },
    "flux": {
      "logo": "https://cdn.steamusercontent.com/ugc/41189100113460376/096249E777121953D6AC624E04AA3C9637A268C9/"
    },
    "twistedminds": {
      "logo": "https://cdn.steamusercontent.com/ugc/2441593112493017648/2CF737A11985595217CF576C9DCB365CEB5A74DE/"
    },
    "nightpulse": {
      "logo": "https://cdn.steamusercontent.com/ugc/2479883856029444185/44A2207BF5B75CADD5B02860CC3D78333E4E1E76/"
    },
    "tuceht": {
      "logo": "https://cdn.steamusercontent.com/ugc/2451718604764286989/DBCD8161274D6944742FFBA79DBB65ECC47CDED6/"
    },
    "teamdarleng": {
      "logo": "https://cdn.steamusercontent.com/ugc/2442711405517313633/01FD0FD39B4AE9F4775E28C82210E7EF4AFC6898/"
    },
    "uzumaki": {
      "logo": "https://cdn.steamusercontent.com/ugc/2466356199630889718/46DF71E78D3B769867F51200FB60F6C692EFFF28/"
    },
    "apexgenesis": {
      "logo": "https://cdn.steamusercontent.com/ugc/2441586999439290451/0F48C94C7A1F1E5FCB4A339E23F52CBEE97D8024/"
    },
    "4amigos": {
      "logo": "https://cdn.steamusercontent.com/ugc/2476496009594397006/08A8957CE77F45BB6A7A43F135C7AD90F4F22EFA/"
    },
    "teamkev": {
      "logo": "https://cdn.steamusercontent.com/ugc/2527155798055904204/2AEEDAB9C8203A2C066B01850585C6E37589FF9F/"
    },
    "notoriousthugs": {
      "logo": "https://cdn.steamusercontent.com/ugc/5819288008771164199/E44A4357CB7AA7B6F556E307375C95DF1CFE22AD/"
    },
    "dragonesportsclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/2467493249717162257/D34CF87168F0C0C6D8BC4580AE02C84E732AEE3A/"
    },
    "dragonesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/2467493249717162257/D34CF87168F0C0C6D8BC4580AE02C84E732AEE3A/"
    },
    "ritashidog": {
      "logo": "https://cdn.steamusercontent.com/ugc/60342078793660354/C2CE1274A269EE773EEBD884D449F29F732A8888/"
    },
    "spikygaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/2497884302563869757/495402769E3CA0B57209C58A2A52EF5E38D8513D/"
    },
    "spiky": {
      "logo": "https://cdn.steamusercontent.com/ugc/2497884302563869757/495402769E3CA0B57209C58A2A52EF5E38D8513D/"
    },
    "teamlotus": {
      "logo": "https://cdn.steamusercontent.com/ugc/2467488176507453485/AA8BEE3964987A6664C810F80DB21CF25600B6C1/"
    },
    "shishuliv": {
      "logo": "https://cdn.steamusercontent.com/ugc/2512521001371768591/C9797250D3ACED7BA22F96F595CB1E39D5429362/"
    },
    "teamrandom": {
      "logo": "https://cdn.steamusercontent.com/ugc/2494507313164208609/E51D7AF0DD51BCE6EBA1DE8BE33212EE6594D1CB/"
    },
    "neutron": {
      "logo": "https://cdn.steamusercontent.com/ugc/2477620729413646945/4A45B3162ADC2D9FC9B920D594685BD2102E495B/"
    },
    "shadowreapers": {
      "logo": "https://cdn.steamusercontent.com/ugc/2479873167159435718/56CD0109F030FD9C3414E93C567D974CEA3CCCBF/"
    },
    "winnersgaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/2492270927935943978/7F17A8AA7C2C2A18A5C0D496CF17BD7F780AE703/"
    },
    "winners": {
      "logo": "https://cdn.steamusercontent.com/ugc/2492270927935943978/7F17A8AA7C2C2A18A5C0D496CF17BD7F780AE703/"
    },
    "cuyesesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/2499012826582236771/CFDA1E083BBE8D65AF615F5E73A4E193BA38B0C0/"
    },
    "cuyes": {
      "logo": "https://cdn.steamusercontent.com/ugc/2499012826582236771/CFDA1E083BBE8D65AF615F5E73A4E193BA38B0C0/"
    },
    "elevategaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/2450600311727141987/D39D9A417D974630BFA31A161C4221DDB2C72223/"
    },
    "elevate": {
      "logo": "https://cdn.steamusercontent.com/ugc/2450600311727141987/D39D9A417D974630BFA31A161C4221DDB2C72223/"
    },
    "freestack": {
      "logo": "https://cdn.steamusercontent.com/ugc/2446096078273768662/E8939FA0F492A90C42B1018C5974EF9AE2599A9F/"
    },
    "stellargaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/2456229811293389870/3F6E0B7F87D2585F2B7007A1717544141755F76A/"
    },
    "stellar": {
      "logo": "https://cdn.steamusercontent.com/ugc/2456229811293389870/3F6E0B7F87D2585F2B7007A1717544141755F76A/"
    },
    "v3talgandjuba5": {
      "logo": "https://cdn.steamusercontent.com/ugc/2467488268118942117/31B215C8107653CB7AC395B8FBDD249E2B9D14C6/"
    },
    "pomo1ka": {
      "logo": "https://cdn.steamusercontent.com/ugc/2458481611077470497/97DDA30B5A0216A46DD938174BFC72E6BDCCE463/"
    },
    "1stplaceenj": {
      "logo": "https://cdn.steamusercontent.com/ugc/2442719012381761159/D8A6AF84DE249B180A6CD53451EAF563F0980E78/"
    },
    "rereametag": {
      "logo": "https://cdn.steamusercontent.com/ugc/2497888107818139952/36119E06F607B944EF38672538E3FEF299296757/"
    },
    "couragecompany": {
      "logo": "https://cdn.steamusercontent.com/ugc/2451726211633407444/CCA6B294EEB44D863076A686BE79B477DB7690BF/"
    },
    "ofisprezidenta": {
      "logo": "https://cdn.steamusercontent.com/ugc/15213337614985874187/C08EBE2A158ECDEDCE9CCC74D4FA128356CB31CC/"
    },
    "amanita": {
      "logo": "https://cdn.steamusercontent.com/ugc/2466362910424630018/0F077DE393426906AB0B593F9693D6A9CC042B26/"
    },
    "sosroko": {
      "logo": "https://cdn.steamusercontent.com/ugc/2442719012382396222/75ADDA8BB2CCD9B535DB2C6761CD39E4DBDC33DA/"
    },
    "teamchicks": {
      "logo": "https://cdn.steamusercontent.com/ugc/2448348511915761126/9C9D289E409F0E02D08EFF2C73FE9D0F9A43F589/"
    },
    "westernwolves": {
      "logo": "https://cdn.steamusercontent.com/ugc/2446096712105180450/BA9CE23C1F0F48D31A6C168C58A3E958272C0D66/"
    },
    "bastardmunchen": {
      "logo": "https://cdn.steamusercontent.com/ugc/2485503208848871134/1A54EF518AC5753D5AE8119C046A00B105AFE194/"
    },
    "teamturtle": {
      "logo": "https://cdn.steamusercontent.com/ugc/2465238196943871680/E2D76C1FAB3A8F86D56B811D15971CD91969B40A/"
    },
    "orrai4": {
      "logo": "https://cdn.steamusercontent.com/ugc/2485503208863898605/4C481558A378A4F503284512CD64F3A620C716B9/"
    },
    "fusionesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/20931146537158351/0940BE82E218C71369C672C95943445AA450EF45/"
    },
    "fusion": {
      "logo": "https://cdn.steamusercontent.com/ugc/20931146537158351/0940BE82E218C71369C672C95943445AA450EF45/"
    },
    "valentiny": {
      "logo": "https://cdn.steamusercontent.com/ugc/2473119977658518607/386E349C3238B03F4B4404FA1F775BD2285B8B6E/"
    },
    "teamtea": {
      "logo": "https://cdn.steamusercontent.com/ugc/2547430415563820852/14C528D0CE511F1534CABBB97EBAECCF0CC22DD0/"
    },
    "dominion": {
      "logo": "https://cdn.steamusercontent.com/ugc/2511401442963320919/257CB3B69D75A5BE2033B35AB3DC1EAABFE0B207/"
    },
    "auroragaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/12718684494192239317/812E31EF22D232EFE1F1F147940F3D3BEE55D40D/"
    },
    "aurora": {
      "logo": "https://cdn.steamusercontent.com/ugc/12718684494192239317/812E31EF22D232EFE1F1F147940F3D3BEE55D40D/"
    },
    "blacklistinternational": {
      "logo": "https://cdn.steamusercontent.com/ugc/2541800915846514860/CF1883DC6BFE37EA765A0920324ACE06A410DF63/"
    },
    "eyegaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/2548556315446212479/F4D0AD6C0EFC58DCF8DED009E4D51F25BE2DA05F/"
    },
    "eye": {
      "logo": "https://cdn.steamusercontent.com/ugc/2548556315446212479/F4D0AD6C0EFC58DCF8DED009E4D51F25BE2DA05F/"
    },
    "52turbo": {
      "logo": "https://cdn.steamusercontent.com/ugc/13902376277869123176/4222027B4B1F834C27DBDC6D87228726444B182A/"
    },
    "avulus": {
      "logo": "https://cdn.steamusercontent.com/ugc/2484388089175887648/AD2555E0F8E1783B66E6A3F88D0D3481E11BDE2A/"
    },
    "legacy": {
      "logo": "https://cdn.steamusercontent.com/ugc/2483257751331641617/0F960E60CEB27A6732146E98A194B9E3F8E29BE4/"
    },
    "bruv123": {
      "logo": "https://cdn.steamusercontent.com/ugc/2464121890863035592/69CB2CDE8B7290C49DB92F16EE84811F3D6F7278/"
    },
    "rakuzan": {
      "logo": "https://cdn.steamusercontent.com/ugc/14172984088870282/5F013D18FA3BF8B3AEAB8B9EE8785CAD9CAB80AB/"
    },
    "teamkukuys": {
      "logo": "https://cdn.steamusercontent.com/ugc/2495646454751623231/64BE465662BBDCBF2128F93AC1BFCB0B8C6E15AF/"
    },
    "waska": {
      "logo": "https://cdn.steamusercontent.com/ugc/2492268755024477919/F2376446D05157B080B5D506473EE2F1D43097BF/"
    },
    "kukuys20": {
      "logo": "https://cdn.steamusercontent.com/ugc/2453988791679025351/801DDD227A2677A72F286FCE8D249B818C76D43B/"
    },
    "playforfun": {
      "logo": "https://cdn.steamusercontent.com/ugc/2503529021823838530/28113541EE2ACBA2A2A253067487EB0ED0A29323/"
    },
    "teamvision": {
      "logo": "https://cdn.steamusercontent.com/ugc/10380389074903512947/5D074799695A862D17D4205285315FE20399B28D/"
    },
    "kibaarms": {
      "logo": "https://cdn.steamusercontent.com/ugc/2452865428987917753/782E74D6A8E46FC8D2B0F96490344A50BEF647B9/"
    },
    "nethercore": {
      "logo": "https://cdn.steamusercontent.com/ugc/2442732965763263237/79D0D159903371DC20501B6507AA311EF6FAFE86/"
    },
    "gaozu": {
      "logo": "https://cdn.steamusercontent.com/ugc/23175424386899819/25AC5B927B5B194D204BE406F53B3ADB1F2B6E4B/"
    },
    "puckchamp": {
      "logo": "https://cdn.steamusercontent.com/ugc/11915702531314439/4DA6A4535A1B02E092638D7BBF581E9C89508832/"
    },
    "zerotenacity": {
      "logo": "https://cdn.steamusercontent.com/ugc/23174701605135839/B5A052B86AE5F123031508603154EAD51013C412/"
    },
    "win": {
      "logo": "https://cdn.steamusercontent.com/ugc/17865131697726500115/975506E7B0B7880653EAD90BAA8067AA8329BA9D/"
    },
    "teiko": {
      "logo": "https://cdn.steamusercontent.com/ugc/53576717528430814/3FF228A7F7409318EEC092C18C14AF690A009B35/"
    },
    "others": {
      "logo": "https://cdn.steamusercontent.com/ugc/61458643626607155/38A49192383ECC5564818F1B0F16CFF2DB32C8AE/"
    },
    "chimeraesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/25429846520505742/8CC6F7D4209315AEB9CC55B5224FE95C6E757D91/"
    },
    "chimera": {
      "logo": "https://cdn.steamusercontent.com/ugc/25429846520505742/8CC6F7D4209315AEB9CC55B5224FE95C6E757D91/"
    },
    "m80": {
      "logo": "https://cdn.steamusercontent.com/ugc/38941270872180974/66B383DCF84EB57927FCAC7F5CE0B6A70D0EDF23/"
    },
    "teamtidebound": {
      "logo": "https://cdn.steamusercontent.com/ugc/12094940740270677482/9AD05F0A80A562EE4A833375BF1783B52B3D4C30/"
    },
    "jigglin": {
      "logo": "https://cdn.steamusercontent.com/ugc/10795057523687683/EE9A7F08EEEDE9615FB062476EF11BA3F1ECAFDD/"
    },
    "lookingfororg": {
      "logo": "https://cdn.steamusercontent.com/ugc/51327907334606511/D1DE8289313290A02D1289BCC3B9FC69BB2ED23A/"
    },
    "gazovatorbl": {
      "logo": "https://cdn.steamusercontent.com/ugc/8544435822675099/0B0CCE2F22F4721912B21D9805F015116E57583C/"
    },
    "itbshuffle": {
      "logo": "https://cdn.steamusercontent.com/ugc/10796235338716618/FD2C48006B2AC387BA7EE670FB12C3DAB5B5D134/"
    },
    "moodengwarriors": {
      "logo": "https://cdn.steamusercontent.com/ugc/32190145604852109/E7EE05A8819599AA60D6901AAED6F99225A0C06B/"
    },
    "teamnemesis": {
      "logo": "https://cdn.steamusercontent.com/ugc/16578975333650734744/040492179D9E0E83DA0559848D88CFC17A1EFCAC/"
    },
    "tearlaments": {
      "logo": "https://cdn.steamusercontent.com/ugc/13054916969328839/7663A2A47B72EF63B9ACE9860B377CF97B35D98C/"
    },
    "techfreegaming": {
      "logo": "https://cdn.steamusercontent.com/ugc/37822898901000735/CFE84A5E0E4C4D7ECA12AD6D542B0994E7C52949/"
    },
    "techfree": {
      "logo": "https://cdn.steamusercontent.com/ugc/37822898901000735/CFE84A5E0E4C4D7ECA12AD6D542B0994E7C52949/"
    },
    "trailerparkboys": {
      "logo": "https://cdn.steamusercontent.com/ugc/38949980569189726/53F2180D4DB13B6E96577D16F952B03E879EC514/"
    },
    "bloodyrose": {
      "logo": "https://cdn.steamusercontent.com/ugc/13054458466396118/2A7A8AF97F83D018A54851B82EEEDAB1B10FCA52/"
    },
    "edge": {
      "logo": "https://cdn.steamusercontent.com/ugc/17884533737171142983/4906E376E7E8A4CCE82DD5F8899CD80F1742C0EF/"
    },
    "teamden": {
      "logo": "https://cdn.steamusercontent.com/ugc/53588581603583302/D6A337DDB250A20844C6B491666FC23AB7BCF178/"
    },
    "somosnsajustia": {
      "logo": "https://cdn.steamusercontent.com/ugc/38951882813950031/E0BC702CE1C18CCE5FB7A0BA7C2B006B21C04444/"
    },
    "runateam": {
      "logo": "https://cdn.steamusercontent.com/ugc/23189918875091243/4CEBD73D73236BCAC62F16D2D432532CC2A5D1F2/"
    },
    "runa": {
      "logo": "https://cdn.steamusercontent.com/ugc/23189918875091243/4CEBD73D73236BCAC62F16D2D432532CC2A5D1F2/"
    },
    "flipstertalon": {
      "logo": "https://cdn.steamusercontent.com/ugc/16993496185238442896/AEC83EE01F7ABD5F64CE99CCECC2AD4D9B311221/"
    },
    "oglatam": {
      "logo": "https://cdn.steamusercontent.com/ugc/12741081049248012101/CA83F279CEB5DC52AE9FEC1176AC1E55908EEEFA/"
    },
    "teamnextlevel": {
      "logo": "https://cdn.steamusercontent.com/ugc/16515489788422095080/B5EA1DD5E2BABC4BC77BD2CF53746A6AC9E8E7C4/"
    },
    "ramzesteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/11465459637037115132/1B20766D3AEA45D574BEC36CA59141615D6AA738/"
    },
    "ramzes": {
      "logo": "https://cdn.steamusercontent.com/ugc/11465459637037115132/1B20766D3AEA45D574BEC36CA59141615D6AA738/"
    },
    "cybergoose": {
      "logo": "https://cdn.steamusercontent.com/ugc/10211157587642124035/8782DBD433A137EAC11039A8B5F60DB1304A971C/"
    },
    "espoiled": {
      "logo": "https://cdn.steamusercontent.com/ugc/12151579140932746225/A9E4132B12671244A194F68779793550B1C8C2E8/"
    },
    "teamyandex": {
      "logo": "https://cdn.steamusercontent.com/ugc/17599312477106395083/DEE09659361BE8BDB1438FCFE6BF03C8B62A45F9/"
    },
    "teamyakuza": {
      "logo": "https://cdn.steamusercontent.com/ugc/13743177005895078824/A6C4ED6057E5BADC96FE7BE720EC260084C534D0/"
    },
    "buldozer": {
      "logo": "https://cdn.steamusercontent.com/ugc/15211449477990013289/3A113B8FD31E7ADE39168DC04BD745FCBF6413C8/"
    },
    "parivision": {
      "logo": "https://cdn.steamusercontent.com/ugc/11751543457229798134/1569CC553CB72963C8EC4C3F807EE50DA925BDC2/"
    },
    "rekonix": {
      "logo": "https://cdn.steamusercontent.com/ugc/16170413258693955016/5ABDC787F5CF4BBDD603F15933D9F5B0F8EB0D8A/"
    },
    "100mmr": {
      "logo": "https://cdn.steamusercontent.com/ugc/16830255701840613626/E0D867F3B960F835DD41F2A6F9649A206211BC1F/"
    },
    "chefbrandteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/15428373715270271338/72DACEC44B750A318B12563DA1895F0E5E3AD3C3/"
    },
    "chefbrand": {
      "logo": "https://cdn.steamusercontent.com/ugc/15428373715270271338/72DACEC44B750A318B12563DA1895F0E5E3AD3C3/"
    },
    "kalmychata": {
      "logo": "https://cdn.steamusercontent.com/ugc/14523818912257802998/398546457D88FDA3C9584EDA3587A5DD0FA1C53C/"
    },
    "teammopsi": {
      "logo": "https://cdn.steamusercontent.com/ugc/18002348753105163763/7E0C0CDD8F360FF23F3AB61FEFBB9075DEB5BD1A/"
    },
    "pipsqueak4": {
      "logo": "https://cdn.steamusercontent.com/ugc/17452646076455003343/946D2A15CF8DA1FE5108BF2765BB13E245EDE12B/"
    },
    "perrejects": {
      "logo": "https://cdn.steamusercontent.com/ugc/10976329918721107017/77707BDD58E2B2C3C34D66940EF3E3EF1249F0E2/"
    },
    "teamaureus": {
      "logo": "https://cdn.steamusercontent.com/ugc/11321842346504571852/C7BE0E4CB4BE1E57E10805C7BFBA48D04410C7DF/"
    },
    "kukuys": {
      "logo": "https://cdn.steamusercontent.com/ugc/17855972744792417589/0E04B6D0CD7F52E89E7DBAB4F548EB2B81174E27/"
    },
    "runeeaters": {
      "logo": "https://cdn.steamusercontent.com/ugc/11845515088670662060/69AF28B666A859915784A1FF3C77F23E29057C3F/"
    },
    "teamlynx": {
      "logo": "https://cdn.steamusercontent.com/ugc/14941196846611701531/643518619FD1EC99DB98FC12C5D8970751E16A2E/"
    },
    "mostwanted": {
      "logo": "https://cdn.steamusercontent.com/ugc/13403954137763331956/26CFEAF977C2C23834C050817E1C0BACBF252076/"
    },
    "teamspiritacademy": {
      "logo": "https://cdn.steamusercontent.com/ugc/16328404359541313451/267BF3359F3B03492C44331ACB4B9C03BD51C728/"
    },
    "loodowolfs": {
      "logo": "https://cdn.steamusercontent.com/ugc/11925720862554961540/A5FA1F052E6FF631D6D5736B4BD7AB10E3310446/"
    },
    "teampublic": {
      "logo": "https://cdn.steamusercontent.com/ugc/15961912086983627080/7DB901E4CB0D8137F5B4EAD820C0E35D695936B1/"
    },
    "stariybog": {
      "logo": "https://cdn.steamusercontent.com/ugc/12225242090717606500/99D63DC54E826122839B99733219BF814F6090A3/"
    },
    "gamerlegion": {
      "logo": "https://cdn.steamusercontent.com/ugc/13245379764580870318/1048428BEFAC87EC1C64E15706A4758A173B5BFB/"
    },
    "owningprosdaily": {
      "logo": "https://cdn.steamusercontent.com/ugc/16257640542192296943/F4402A77656703C67B654F0723DF75B035CAC3F2/"
    },
    "rottweilas": {
      "logo": "https://cdn.steamusercontent.com/ugc/17677031272276990522/8FC6527F73D0BD86A4F4939428E5ABD50C35DA9F/"
    },
    "nohoodwink": {
      "logo": "https://cdn.steamusercontent.com/ugc/17682418430515637520/6BB6DAD54DB6E42F3B063164BCF2805177626F6E/"
    },
    "innercirclexinsanity": {
      "logo": "https://cdn.steamusercontent.com/ugc/9964979241844276783/64DDB27F8A50FEA6869CFD8392ED29CE674E26C1/"
    },
    "playtime": {
      "logo": "https://cdn.steamusercontent.com/ugc/17426031919353601412/893C6B533277C656AE6AB52400741210FE02BE2B/"
    },
    "greyhoundteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/15110032754519552478/16D13F16B97F4F39FD213A979FF40763AE1CD33F/"
    },
    "greyhound": {
      "logo": "https://cdn.steamusercontent.com/ugc/15110032754519552478/16D13F16B97F4F39FD213A979FF40763AE1CD33F/"
    },
    "ilbirsesports": {
      "logo": "https://cdn.steamusercontent.com/ugc/11722874411743504358/FBD50A7D9F04E42BD59A5108C2D6DD346C2947F8/"
    },
    "ilbirs": {
      "logo": "https://cdn.steamusercontent.com/ugc/11722874411743504358/FBD50A7D9F04E42BD59A5108C2D6DD346C2947F8/"
    },
    "glyph": {
      "logo": "https://cdn.steamusercontent.com/ugc/9768354035558377058/44D326A1CD73CFB7F7C5F1BC4CAB1F46696B5E4F/"
    },
    "stariybogteam": {
      "logo": "https://cdn.steamusercontent.com/ugc/12953774144384431651/DCF3BE8C5C50491F1D6158D156C040D30EF4C5FE/"
    },
    "satan666": {
      "logo": "https://cdn.steamusercontent.com/ugc/18003854356446470324/60058F0E4C503ADDB1EFDD7F8EE0C57A90E323C7/"
    },
    "breekicheeki": {
      "logo": "https://cdn.steamusercontent.com/ugc/13046866918722230078/08D74D8C858301E567BA96F1BF5BE1BEE7EEE452/"
    },
    "teamgrind": {
      "logo": "https://cdn.steamusercontent.com/ugc/18313019652320109896/09DE0090D6F99C3AF44DA97360CCDAEA1CA7D214/"
    },
    "twomove": {
      "logo": "https://cdn.steamusercontent.com/ugc/14832539996629907250/104CC9C96E6BE157DA1A8E63FB26084539394C70/"
    },
    "ironwing": {
      "logo": "https://cdn.steamusercontent.com/ugc/16903873521422862552/02513782FE03E7A567B8B8955A0DEF415EF2B624/"
    },
    "1win": {
      "logo": "https://cdn.steamusercontent.com/ugc/10678669599334676082/E48827F4A163D4D02F817EA3C32166D5F1D5FC98/"
    },
    "teamnyx": {
      "logo": "https://cdn.steamusercontent.com/ugc/15162489985342115020/CD78CAE3D3734D759D3B31CD532BC4E785CB8A86/"
    },
    "lgdpinghu": {
      "logo": "https://cdn.steamusercontent.com/ugc/10786613720313814438/F6F1383DC3789553E04AFBA9F97FFDAAAF782CA9/"
    },
    "teamsynapse": {
      "logo": "https://cdn.steamusercontent.com/ugc/14176785811446421230/E9FC96999431CDA69AD21FB9FF85FC022E8338BB/"
    },
    "dynasty": {
      "logo": "https://cdn.steamusercontent.com/ugc/15807281118408886740/E8A2A2FE91ACA2C26C900CBE2B5EA874773E1E33/"
    },
    "summerbear": {
      "logo": "https://cdn.steamusercontent.com/ugc/12505334792145161652/9D91802F4FFF1ED1E787558E090E76B7A1B2A596/"
    },
    "klimsani4": {
      "logo": "https://cdn.steamusercontent.com/ugc/17154379317387244703/A3F526268CFCE8F90DC4AC49D48D69ACE33ACEB5/"
    },
    "icecreammen": {
      "logo": "https://cdn.steamusercontent.com/ugc/11814691842312543047/356DFAC899B1D0DD640CBD8E19E60FF41758917E/"
    },
    "teamkinetix": {
      "logo": "https://cdn.steamusercontent.com/ugc/16524648740909764969/8BCDBC95ABC19C5062633F0B5521FFD02BA7B0B2/"
    },
    "team6seven": {
      "logo": "https://cdn.steamusercontent.com/ugc/18154642787197887986/C3A5811E13969747C54423D726254730C3B4BD6D/"
    },
    "4ikibamboni": {
      "logo": "https://cdn.steamusercontent.com/ugc/16243749796277544889/8E5F0BD0899BF5814D1539AFF11AEBC8A6C7A2FE/"
    },
    "rostikfacekidclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/9993881737239555307/007410481AA1016ECAA50351FE71AEC926A8CC5E/"
    },
    "rostikfacekid": {
      "logo": "https://cdn.steamusercontent.com/ugc/9993881737239555307/007410481AA1016ECAA50351FE71AEC926A8CC5E/"
    },
    "nsclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/14495280194177138791/20F509D6BB772F8613D0836D6456E75B016C3B41/"
    },
    "ns": {
      "logo": "https://cdn.steamusercontent.com/ugc/14495280194177138791/20F509D6BB772F8613D0836D6456E75B016C3B41/"
    },
    "ybnclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/13247806896278348326/4EFD2261FD65B94E10CCF722B906DE4B9EB49BB0/"
    },
    "ybn": {
      "logo": "https://cdn.steamusercontent.com/ugc/13247806896278348326/4EFD2261FD65B94E10CCF722B906DE4B9EB49BB0/"
    },
    "strayclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/15988314095870492355/4D1D35ED846FA4CB396B442A921E095636CD4254/"
    },
    "stray": {
      "logo": "https://cdn.steamusercontent.com/ugc/15988314095870492355/4D1D35ED846FA4CB396B442A921E095636CD4254/"
    },
    "voodooshclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/10002479797676202919/23282391FE65E79F992B35BB331812065754B6CA/"
    },
    "voodoosh": {
      "logo": "https://cdn.steamusercontent.com/ugc/10002479797676202919/23282391FE65E79F992B35BB331812065754B6CA/"
    },
    "daxakclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/12032584383209767854/509CC6A9B2DD90940431A9FAD5094B7CD007AF50/"
    },
    "daxak": {
      "logo": "https://cdn.steamusercontent.com/ugc/12032584383209767854/509CC6A9B2DD90940431A9FAD5094B7CD007AF50/"
    },
    "recrentclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/14600983343195536527/555A99A787F4022A9B46043B53EEE7EB315DDBF0/"
    },
    "recrent": {
      "logo": "https://cdn.steamusercontent.com/ugc/14600983343195536527/555A99A787F4022A9B46043B53EEE7EB315DDBF0/"
    },
    "coomanclub": {
      "logo": "https://cdn.steamusercontent.com/ugc/14416228886044945821/448B8448EF03CEF03D1FC942CF96C5A503BE4529/"
    },
    "cooman": {
      "logo": "https://cdn.steamusercontent.com/ugc/14416228886044945821/448B8448EF03CEF03D1FC942CF96C5A503BE4529/"
    }
  }
};
