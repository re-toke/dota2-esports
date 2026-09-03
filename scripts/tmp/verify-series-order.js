const https=require('https'),zlib=require('zlib'),fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
const PAGE_DIR=path.join(ROOT,'subpackages/detail/league-detail');
const get=(url)=>new Promise((res,rej)=>{
  const req=https.get(url,{headers:{'Accept-Encoding':'gzip','User-Agent':'Mozilla/5.0'}},r=>{
    const chunks=[]; const stream=r.headers['content-encoding']==='gzip'?r.pipe(zlib.createGunzip()):r;
    stream.on('data',c=>chunks.push(c)); stream.on('end',()=>{try{res(JSON.parse(Buffer.concat(chunks).toString()))}catch(e){rej(e)}});
  }); req.on('error',rej); req.setTimeout(20000,()=>req.destroy(new Error('timeout')));
});
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
  global.wx={cloud:{},request(){},getStorageSync(){return null},setStorageSync(){},getSystemInfoSync(){return{}},canIUse(){return false}};
  m._compile(fs.readFileSync(path.join(PAGE_DIR,'league-detail.js'),'utf8'),m.filename);
  const pageDef=global.__pageDef;
  const sources=require(path.join(ROOT,'utils/sources.js'));
  const win={from:1786579200,to:1789171200};
  const filtered=sources.filterMatchesByWindow(raw,win);
  const snap=require(path.join(ROOT,'utils/team-logo-local-data.js'));
  const nameById={}; Object.keys(snap.byId||{}).forEach(id=>{nameById[id]=snap.byId[id].name||id;});
  const fakeThis={...pageDef,data:{...((pageDef.data)||{}),name:'EPL Masters II',leagueId:19944,metadata:{},pageSize:30,participantsList:[]},_teamIdNameMap:nameById,_logoQueryCache:{byId:{},byNormName:{}},_logoSnapChecked:true,setData(){}};
  const built=pageDef.buildSeriesFromSources.call(fakeThis,filtered,lpMatches,null);
  console.log('allSeries 总数:', built.allSeries.length, '| pageSize=30');
  console.log('live:', built.liveList.length, '| upcoming:', built.upcomingList.length, '| recent:', built.recentList.length);
  console.log('\n=== allSeries 前 30 条（this.data.series 的内容）===');
  built.allSeries.slice(0,30).forEach((s,i)=>{
    console.log('  ['+i+']', (s.phase||'?').padEnd(8), (s.radiantName||'').padEnd(20)+' vs '+(s.direName||'').padEnd(20), '| logo:', (s.radiantLogo?'✓':'✗')+'/'+(s.direLogo?'✓':'✗'), '| st:'+(s.lastTime?new Date(s.lastTime*1000).toISOString().slice(5,10):'-'));
  });
  console.log('\n=== allSeries 30 之后的条（如果 upcoming 在这里 → 不会被渲染）===');
  built.allSeries.slice(30,45).forEach((s,i)=>{
    console.log('  ['+(30+i)+']', (s.phase||'?').padEnd(8), (s.radiantName||'').padEnd(20)+' vs '+(s.direName||'').padEnd(20));
  });
})();
