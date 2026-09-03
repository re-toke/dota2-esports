// 在 _doEnrichTeamLogos 里注入打印 nameTeams/teamNameToId/snapResults
const https=require('https'),zlib=require('zlib'),fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
const PAGE_DIR=path.join(ROOT,'subpackages/detail/league-detail');
const get=(url)=>new Promise((res,rej)=>{const req=https.get(url,{headers:{'Accept-Encoding':'gzip','User-Agent':'Mozilla/5.0'}},r=>{const chunks=[];const stream=r.headers['content-encoding']==='gzip'?r.pipe(zlib.createGunzip()):r;stream.on('data',c=>chunks.push(c));stream.on('end',()=>{try{res(JSON.parse(Buffer.concat(chunks).toString()))}catch(e){rej(e)}});});req.on('error',rej);req.setTimeout(20000,()=>req.destroy(new Error('timeout')));});
(async()=>{
  const [raw,j]=await Promise.all([
    get('https://api.opendota.com/api/leagues/19944/matches').catch(()=>[]),
    get('https://liquipedia.net/dota2/api.php?action=parse&page=EPL/Masters/2&prop=wikitext&format=json&formatversion=2').catch(()=>null)
  ]);
  const LP=require(path.join(ROOT,'utils/liquipedia-parse.js'));
  const lpMatches=LP.parseScheduledMatches(j?j.parse.wikitext:'');
  const Module=require('module');
  const m=new Module(path.join(PAGE_DIR,'league-detail.js'),module);
  m.filename=path.join(PAGE_DIR,'league-detail.js'); m.paths=Module._nodeModulePaths(PAGE_DIR);
  global.Page=(d)=>{global.__pageDef=d;};
  const https2=require('https');
  global.wx={cloud:{callFunction(){return Promise.reject(new Error('no cloud'));}},request(o){return new Promise((resolve)=>{https2.get(o.url,{headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'},timeout:8000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve({statusCode:res.statusCode,data:JSON.parse(d)})}catch(e){resolve({statusCode:500,data:null})}});}).on('error',()=>resolve({statusCode:500,data:null}));}).then(res=>{o.success&&o.success(res);return{abort(){}};});},getStorageSync(){return null},setStorageSync(){},getSystemInfoSync(){return{}},canIUse(){return false}};
  // 读取源代码并在关键位置插入 console
  let src=fs.readFileSync(path.join(PAGE_DIR,'league-detail.js'),'utf8');
  // 在 nameTeams 收集完成后打印
  src=src.replace(/const nameTeams = \{\};/, 'const nameTeams = {};\n    console.log("[DBG] teamIds:", Object.keys(teamIds).length, "teamNameToId:", Object.keys(teamNameToId).length, JSON.stringify(Object.keys(teamNameToId).slice(0,5)));');
  // 在收集完 nameTeams 后打印
  src=src.replace(/\/\/ 过滤出需要查询的 team_id/, 'console.log("[DBG] nameTeams 收集完:", Object.keys(nameTeams).length, "其中 skip=true:", Object.values(nameTeams).filter(v=>v.skip).length); Object.entries(nameTeams).slice(0,5).forEach(([k,v])=>console.log("  ",k,"→ skip="+v.skip+(v.skip?"":" (查询)"))); \n    // 过滤出需要查询的 team_id');
  // 在 snapResults 处理完后打印
  src=src.replace(/if \(snapResults\.length\) \{/, 'console.log("[DBG] snapResults:", snapResults.length, "needQueryIds 后:", needQueryIds.length, "needQueryNames 后:", needQueryNames.length); if (snapResults.length) {');
  require('fs').writeFileSync(path.join(ROOT,'scripts/tmp/patched.js'),src);
  const m2=new Module(path.join(ROOT,'scripts/tmp/patched.js'),module);
  m2.filename=path.join(ROOT,'scripts/tmp/patched.js');m2.paths=Module._nodeModulePaths(PAGE_DIR);
  m2._compile(src,m2.filename);
  const pageDef=global.__pageDef;
  const sources=require(path.join(ROOT,'utils/sources.js'));
  const win={from:1786579200,to:1789171200};
  const filtered=sources.filterMatchesByWindow(raw,win);
  const snap=require(path.join(ROOT,'utils/team-logo-local-data.js'));
  const nameById={};Object.keys(snap.byId||{}).forEach(id=>{nameById[id]=snap.byId[id].name||id;});
  const fakeData={name:'EPL Masters II',leagueId:19944,metadata:{},pageSize:30,participantsList:[],series:[]};
  const fakeThis={...pageDef,data:fakeData,_teamIdNameMap:nameById,_logoQueryCache:{byId:{},byNormName:{}},_logoSnapChecked:false,allSeries:[],setData(o){Object.keys(o||{}).forEach(k=>{if(k==='series'){fakeData.series=o[k];return;}const mm=k.match(/^series\[(\d+)\]\.(.+)$/);if(mm){const idx=parseInt(mm[1]);fakeData.series[idx]=fakeData.series[idx]||{};fakeData.series[idx][mm[2]]=o[k];return;}fakeData[k]=o[k];});}};
  const built=pageDef.buildSeriesFromSources.call(fakeThis,filtered,lpMatches,null);
  fakeThis.allSeries=built.allSeries;
  fakeData.series=built.allSeries.slice(0,30);
  await pageDef.enrichTeamLogos.call(fakeThis);
  await new Promise(r=>setTimeout(r,5000));
})();
